import { expect } from 'chai';
import type { Connection } from '@salesforce/core';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import sinon from 'sinon';
import { preflightDeployImageUpdate } from '../../src/services/deploy-image-update-preflight.js';

type Row = Record<string, unknown>;
const workspaceId = '0Zu000000000001AAA';
const contentId = '20Y000000000001AAA';
const variantId = '9Ps000000000001AAA';
const noDownloadAction = () => {};
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'cms-image-update-preflight-'));
  const definitionFile = path.join(directory, 'Hero.cms-image.json');
  const fileName = 'Hero.cms-image.media.png';
  const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1]);
  const desiredBytes = Buffer.concat([bytes.subarray(0, 8), Buffer.from([2, 3])]);
  const companion = path.join(directory, fileName);
  const definition = {
    contract: 'sf-cms-media-source',
    contractVersion: '1.0.0',
    identity: {
      family: 'cms',
      type: 'Image',
      apiName: 'Hero',
      context: { workspaceApiName: 'Source' },
    },
    contentType: 'sfdc_cms__image',
    language: 'en_US',
    folderPath: [] as string[],
    title: 'Hero image',
    urlName: 'hero-image',
    media: {
      representation: 'binary',
      mimeType: 'image/png',
      companion: { role: 'media', path: fileName },
    },
  };
  const save = async () => writeFile(definitionFile, JSON.stringify(definition));
  await save();
  await writeFile(companion, desiredBytes);
  const workspace: Row = {
    id: workspaceId,
    apiName: 'Destination',
    defaultLanguage: 'en_US',
    rootFolderId: 'root',
    spaceType: { apiName: 'Marketing' },
  };
  const row: Row = {
    Id: variantId,
    ManagedContentId: contentId,
    ContentTypeFullyQualifiedName: 'sfdc_cms__image',
    Language: 'en_US',
    IsPublished: false,
    ManagedContentVariantStatus: 'Draft',
    IsPrimary: true,
    Name: 'Hero image',
    UrlName: 'hero-image',
    ManagedContentKey: 'MCGENERATED',
    ManagedContent: { AuthoredManagedContentSpaceId: workspaceId, ApiName: 'Hero' },
  };
  const detail: Row = {
    managedContentId: contentId,
    managedContentVariantId: variantId,
    contentKey: 'MCGENERATED',
    apiName: 'Hero',
    title: 'Hero image',
    urlName: 'hero-image',
    contentType: { fullyQualifiedName: 'sfdc_cms__image' },
    contentSpace: { id: workspaceId },
    language: 'en_US',
    folder: { id: 'root' },
    isPublished: false,
    status: { status: 'Draft' },
    contentBody: {
      'sfdc_cms:media': {
        source: { type: 'file', size: bytes.length, mimeType: 'image/png' },
        url: `/cms/media/MCGENERATED?version=1&fileHash=${createHash('md5').update(bytes).digest('hex')}&fileName=${fileName}`,
      },
    },
  };
  const rows = [row];
  const methods: string[] = [];
  let downloadAction: () => void | Promise<void> = noDownloadAction;
  const fetcher = sinon.stub(globalThis, 'fetch').callsFake(async () => {
    await downloadAction();
    return new Response(bytes, { headers: { 'content-type': 'image/png' } });
  });
  const connection = {
    accessToken: 'test-token',
    instanceUrl: 'https://example.invalid',
    getApiVersion: () => '67.0',
    request(input: { method: string; url: string }) {
      const result = (async () => {
        methods.push(input.method);
        expect(input.method).to.equal('GET');
        const url = new URL(input.url, 'https://example.invalid');
        if (url.pathname.includes('/spaces/')) return structuredClone(workspace);
        if (url.pathname.endsWith('/query')) {
          const q = url.searchParams.get('q')!;
          let records: Row[] = q.includes('Id >') ? [] : rows;
          if (q.includes('COUNT(Id)'))
            records =
              rows.length > 0 ? [{ ManagedContentId: contentId, siblingCount: rows.length }] : [];
          return { records: structuredClone(records), totalSize: records.length, done: true };
        }
        return structuredClone(detail);
      })();
      return Object.assign(result, { stream: () => new PassThrough() });
    },
  } as unknown as Pick<Connection, 'request' | 'getApiVersion'> &
    Partial<Pick<Connection, 'accessToken' | 'instanceUrl'>>;
  const input = { definitionFile, workspaceId, language: 'en_US' };
  return {
    directory,
    definition,
    save,
    companion,
    bytes,
    desiredBytes,
    workspace,
    row,
    rows,
    detail,
    methods,
    fetcher,
    input,
    onDownload: (action: typeof downloadAction) => {
      downloadAction = action;
    },
    run: (options = {}) => preflightDeployImageUpdate(connection, input, options),
  };
}
async function failure(operation: Promise<unknown>) {
  try {
    await operation;
  } catch (error) {
    expect(error).to.be.instanceOf(Error);
    return;
  }
  throw new Error('Expected rejection');
}

describe('private read-only Image UPDATE preflight', () => {
  afterEach(() => sinon.restore());
  it('binds differing desired bytes independently from native metadata and downloaded media', async () => {
    const f = await fixture();
    const result = await f.run();
    expect(result).to.include({
      qualification: 'unqualified',
      operation: 'update',
      contentId,
      variantId,
      contentKey: 'MCGENERATED',
      workspaceId,
      rootFolderId: 'root',
    });
    expect(result.payload).to.deep.equal({ title: 'Hero image' });
    expect(result.payload.title).not.to.equal(result.source.definition.identity.apiName);
    expect(result.mediaSha256).to.equal(hash(f.desiredBytes));
    expect(result.destination.mediaSha256).to.equal(hash(f.bytes));
    expect(result.sourceSha256).to.equal(
      createHash('sha256')
        .update(JSON.stringify(result.source.definition))
        .update(f.desiredBytes)
        .digest('hex'),
    );
    expect(result.destination.variant).to.deep.equal(f.detail);
    expect(result.destination.inventory.records).to.have.length(1);
    expect(result.destination.acquisition.projection.companions[0].bytes.equals(f.bytes)).to.equal(
      true,
    );
    expect(result.source.source.representation).to.equal('binary');
    if (result.source.source.representation === 'binary')
      expect(result.source.source.binary.bytes.equals(f.desiredBytes)).to.equal(true);
    expect(f.fetcher.calledOnce).to.equal(true);
    expect(f.methods.every((method) => method === 'GET')).to.equal(true);
    const files = await readdir(f.directory);
    expect(files.toSorted()).to.deep.equal(['Hero.cms-image.json', 'Hero.cms-image.media.png']);
    f.detail.title = 'later';
    expect(result.destination.variant.title).to.equal('Hero image');
  });
  it('defers equal bytes to unchanged admission', async () => {
    const f = await fixture();
    await writeFile(f.companion, f.bytes);
    await failure(f.run());
  });
  for (const key of [
    'Name',
    'UrlName',
    'ContentTypeFullyQualifiedName',
    'Language',
    'IsPrimary',
    'IsPublished',
    'ManagedContentVariantStatus',
  ])
    it(`rejects inventory ${key} edits`, async () => {
      const f = await fixture();
      f.row[key] = typeof f.row[key] === 'boolean' ? !f.row[key] : 'Other';
      await failure(f.run());
      expect(f.fetcher.called).to.equal(false);
    });
  for (const kind of ['absent', 'sibling', 'collision', 'unknown-api'])
    it(`rejects ${kind} inventory`, async () => {
      const f = await fixture();
      if (kind === 'absent') f.rows.length = 0;
      if (kind === 'unknown-api') (f.row.ManagedContent as Row).ApiName = null;
      if (kind === 'sibling' || kind === 'collision')
        f.rows.push({
          ...structuredClone(f.row),
          Id: '9Ps000000000002AAA',
          Name: 'Other',
          UrlName: 'other',
          Language: 'de_DE',
          ...(kind === 'collision'
            ? {
                ManagedContent: { AuthoredManagedContentSpaceId: workspaceId, ApiName: 'Other' },
                Name: 'Hero image',
              }
            : {}),
        });
      await failure(f.run());
    });
  for (const key of [
    'managedContentId',
    'managedContentVariantId',
    'contentKey',
    'apiName',
    'title',
    'urlName',
    'language',
    'folder',
    'isPublished',
  ])
    it(`rejects independent native ${key} disagreement`, async () => {
      const f = await fixture();
      f.detail[key] = 'Other';
      if (key === 'folder') f.detail[key] = { id: 'elsewhere' };
      if (key === 'isPublished') f.detail[key] = true;
      await failure(f.run());
    });
  for (const kind of ['filename', 'mime', 'external-url', 'unknown-body', 'download-hash'])
    it(`rejects ${kind} evidence`, async () => {
      const f = await fixture();
      const media = (f.detail.contentBody as Record<string, { url: string; source: Row }>)[
        'sfdc_cms:media'
      ];
      if (kind === 'filename')
        media.url = media.url.replace('Hero.cms-image.media.png', 'Original.png');
      if (kind === 'mime') media.source.mimeType = 'image/jpeg';
      if (kind === 'external-url') media.url = 'https://outside.invalid/hero.png';
      if (kind === 'unknown-body') (f.detail.contentBody as Row).other = 'unsupported';
      if (kind === 'download-hash')
        media.url = media.url.replace(
          /fileHash=[^&]+/u,
          'fileHash=00000000000000000000000000000000',
        );
      await failure(f.run());
    });
  for (const kind of [
    'workspace-root',
    'default-language',
    'workspace-type',
    'local-folder',
    'local-language',
    'local-title',
    'url-only',
    'workspace-id',
    'cancel',
  ])
    it(`rejects unsupported ${kind}`, async () => {
      const f = await fixture();
      if (kind === 'workspace-root') f.workspace.rootFolderId = '';
      if (kind === 'default-language') f.workspace.defaultLanguage = 'de_DE';
      if (kind === 'workspace-type') f.workspace.spaceType = { apiName: 'Content' };
      if (kind === 'local-folder') f.definition.folderPath = ['Other'];
      if (kind === 'local-language') f.definition.language = 'de_DE';
      if (kind === 'local-title') f.definition.title = ' ';
      if (kind === 'url-only')
        Object.assign(f.definition, {
          media: { representation: 'url-only', address: 'https://outside.invalid/hero.png' },
        });
      if (kind === 'workspace-id') f.input.workspaceId = 'wrong';
      await f.save();
      const controller = new AbortController();
      if (kind === 'cancel') controller.abort();
      await failure(f.run({ signal: controller.signal }));
    });
  for (const kind of ['local-bytes', 'local-metadata', 'workspace', 'inventory', 'detail'])
    it(`rejects observed ${kind} drift`, async () => {
      const f = await fixture();
      f.onDownload(async () => {
        if (kind === 'local-bytes') await writeFile(f.companion, f.bytes);
        if (kind === 'local-metadata') {
          f.definition.title = 'Changed';
          await f.save();
        }
        if (kind === 'workspace') f.workspace.rootFolderId = 'changed';
        if (kind === 'inventory') f.row.Name = 'Changed';
        if (kind === 'detail') f.detail.title = 'Changed';
      });
      await failure(f.run());
    });
});
