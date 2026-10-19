import { expect } from 'chai';
import type { Connection } from '@salesforce/core';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import sinon from 'sinon';
import { preflightDeployDocumentUpdate } from '../../src/services/deploy-document-update-preflight.js';
import { admitDeployDocumentUnchanged } from '../../src/services/deploy-document-unchanged.js';

type Row = Record<string, unknown>;
const workspaceId = '0Zu000000000001AAA';
const contentId = '20Y000000000001AAA';
const variantId = '9Ps000000000001AAA';
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'cms-document-update-preflight-'));
  const definitionFile = path.join(directory, 'Guide.cms-document.json');
  const fileName = 'Guide.cms-document.media.txt';
  const companion = path.join(directory, fileName);
  const current = Buffer.from('Owned Document UPDATE probe — café.\r\nSecond harmless line.\n');
  const bytes = Buffer.from('Selected replacement — 世界.\r\nPreserve mixed endings.\n');
  const definition = {
    contract: 'sf-cms-media-source',
    contractVersion: '1.0.0',
    identity: {
      family: 'cms',
      type: 'Document',
      apiName: 'Guide',
      context: { workspaceApiName: 'Source' },
    },
    contentType: 'sfdc_cms__document',
    language: 'en_US',
    folderPath: [] as string[],
    title: 'Guide document',
    urlName: 'guide-document',
    media: {
      representation: 'binary',
      mimeType: 'text/plain',
      companion: { role: 'media', path: fileName },
    },
  };
  const save = () => writeFile(definitionFile, JSON.stringify(definition));
  await save();
  await writeFile(companion, bytes);
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
    ContentTypeFullyQualifiedName: 'sfdc_cms__document',
    Language: 'en_US',
    IsPublished: false,
    ManagedContentVariantStatus: 'Draft',
    IsPrimary: true,
    Name: definition.title,
    UrlName: definition.urlName,
    ManagedContentKey: 'MCGENERATED',
    ManagedContent: { AuthoredManagedContentSpaceId: workspaceId, ApiName: 'Guide' },
  };
  const media = {
    source: { type: 'file', size: current.length, mimeType: 'text/plain' },
    url: `/cms/media/MCGENERATED?version=1&fileHash=${createHash('md5').update(current).digest('hex')}&fileName=${fileName}`,
  };
  const detail: Row = {
    managedContentId: contentId,
    managedContentVariantId: variantId,
    contentKey: 'MCGENERATED',
    apiName: 'Guide',
    title: definition.title,
    urlName: definition.urlName,
    contentType: { fullyQualifiedName: 'sfdc_cms__document' },
    contentSpace: { id: workspaceId },
    language: 'en_US',
    folder: { id: 'root' },
    isPublished: false,
    status: { status: 'Draft' },
    contentBody: { 'sfdc_cms:media': media },
  };
  const rows = [row];
  let siblingCount = 1;
  let onDownload: (() => void | Promise<void>) | undefined;
  let parentOverride: Row | undefined;
  const methods: string[] = [];
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
          const parent = /ManagedContentId = '([^']+)'/u.exec(q)?.[1];
          const selectedRows = parent
            ? rows.filter((item) => item.ManagedContentId === parent)
            : rows;
          let records: Row[] = q.includes('Id >') ? [] : selectedRows;
          if (q.includes('COUNT(Id)'))
            records = [...new Set(selectedRows.map((item) => item.ManagedContentId))].map((id) => ({
              ManagedContentId: id,
              siblingCount:
                id === row.ManagedContentId
                  ? siblingCount
                  : selectedRows.filter((item) => item.ManagedContentId === id).length,
            }));
          return { records: structuredClone(records), totalSize: records.length, done: true };
        }
        return structuredClone(
          url.pathname.includes('/variants/') ? detail : (parentOverride ?? detail),
        );
      })();
      return Object.assign(result, { stream: () => new PassThrough() });
    },
  } as unknown as Pick<Connection, 'request' | 'getApiVersion'> &
    Partial<Pick<Connection, 'accessToken' | 'instanceUrl'>>;
  const fetcher = sinon.stub(globalThis, 'fetch').callsFake(async () => {
    await onDownload?.();
    return new Response(current, { headers: { 'content-type': 'text/plain' } });
  });
  const input = { definitionFile, workspaceId, language: 'en_US', expectedRootFolderId: 'root' };
  return {
    directory,
    definition,
    save,
    companion,
    bytes,
    current,
    workspace,
    row,
    rows,
    detail,
    media,
    methods,
    fetcher,
    count(value: number) {
      siblingCount = value;
    },
    parent(value: Row) {
      parentOverride = value;
    },
    duringDownload(action: typeof onDownload) {
      onDownload = action;
    },
    run: () => preflightDeployDocumentUpdate(connection, input),
    unchanged: () => admitDeployDocumentUnchanged(connection, input),
  };
}
async function rejects(
  operation: Promise<unknown>,
  pattern = /Document|document|Native|native|Media|media|Unsupported|disagreement|mismatch|inventory|UTF-8|encoded data/u,
) {
  try {
    await operation;
  } catch (error) {
    expect((error as Error).message).to.match(pattern);
    return;
  }
  throw new Error('Expected rejection');
}

describe('private read-only Document UPDATE admission', () => {
  afterEach(() => sinon.restore());
  it('binds changed exact bytes and detached fresh observations without mutation or journals', async () => {
    const f = await fixture();
    const proof = await f.run();
    expect(proof).to.include({
      qualification: 'unqualified',
      operation: 'update',
      contentId,
      variantId,
      contentKey: 'MCGENERATED',
      workspaceId,
      rootFolderId: 'root',
      language: 'en_US',
      apiVersion: '67.0',
    });
    expect(f.current.length).to.equal(62);
    expect(proof.destination.mediaSha256).to.equal(
      '4f893cf249319507d755a3904f6d451f530f4953661f30a2d9d7d27605287b62',
    );
    expect(proof.mediaSha256).to.equal(digest(f.bytes));
    expect(proof.sourceSha256).to.equal(
      createHash('sha256').update(JSON.stringify(f.definition)).update(f.bytes).digest('hex'),
    );
    expect(proof.payload).to.deep.equal({
      apiName: 'Guide',
      title: f.definition.title,
      urlName: f.definition.urlName,
      contentBody: { 'sfdc_cms:media': { source: { type: 'file' } } },
    });
    expect(proof.source.source.representation).to.equal('binary');
    expect(proof.destination.acquisition.projection.companions[0].bytes.equals(f.current)).to.equal(
      true,
    );
    f.row.Name = 'Changed after return';
    f.workspace.rootFolderId = 'other';
    f.detail.title = 'Other';
    expect(proof.destination.inventory.records[0].Name).to.equal('Guide document');
    expect(proof.destination.workspace.rootFolderId).to.equal('root');
    expect(proof.destination.variant.title).to.equal('Guide document');
    expect(f.fetcher.calledOnce).to.equal(true);
    expect(f.methods.every((method) => method === 'GET')).to.equal(true);
    expect(await readdir(f.directory)).to.have.length(2);
  });
  it('keeps equal current bytes distinct as unchanged, not UPDATE', async () => {
    const f = await fixture();
    await writeFile(f.companion, f.current);
    await rejects(f.run(), /use unchanged admission/u);
    expect(await f.unchanged()).to.have.property('operation', 'unchanged');
  });
  for (const kind of [
    'absent',
    'ambiguous',
    'hidden-sibling',
    'foreign',
    'nonprimary',
    'published',
    'status',
    'unknown-api',
    'type',
    'language',
    'title',
    'url',
  ] as const)
    it(`rejects ${kind} native inventory`, async () => {
      const f = await fixture();
      if (kind === 'absent') f.rows.length = 0;
      if (kind === 'ambiguous')
        f.rows.push({ ...structuredClone(f.row), Id: '9Ps000000000002AAA' });
      if (kind === 'hidden-sibling') f.count(2);
      if (kind === 'foreign')
        (f.row.ManagedContent as Row).AuthoredManagedContentSpaceId = '0Zu000000000002AAA';
      if (kind === 'unknown-api') (f.row.ManagedContent as Row).ApiName = null;
      const fields = {
        nonprimary: 'IsPrimary',
        published: 'IsPublished',
        status: 'ManagedContentVariantStatus',
        type: 'ContentTypeFullyQualifiedName',
        language: 'Language',
        title: 'Name',
        url: 'UrlName',
      };
      if (kind in fields) f.row[fields[kind as keyof typeof fields]] = 'Other';
      if (kind === 'nonprimary') f.row.IsPrimary = false;
      if (kind === 'published') f.row.IsPublished = true;
      await rejects(f.run());
      expect(f.fetcher.called).to.equal(false);
    });
  for (const kind of ['filename', 'mime', 'identity', 'parent', 'root', 'body', 'hash'] as const)
    it(`rejects inconsistent native ${kind}`, async () => {
      const f = await fixture();
      if (kind === 'filename')
        f.media.url = f.media.url.replace('Guide.cms-document.media.txt', 'other.txt');
      if (kind === 'mime') f.media.source.mimeType = 'application/pdf';
      if (kind === 'identity') f.detail.managedContentId = '20Y000000000002AAA';
      if (kind === 'parent') f.parent({ ...f.detail, title: 'Other' });
      if (kind === 'root') f.detail.folder = { id: 'other' };
      if (kind === 'body') (f.detail.contentBody as Row).unknown = 'unsupported';
      if (kind === 'hash')
        f.media.url = f.media.url.replace(/fileHash=[^&]+/u, `fileHash=${'0'.repeat(32)}`);
      await rejects(f.run());
    });
  it('preserves independently observed invalid UTF-8 and opaque selected bytes', async () => {
    const f = await fixture();
    const current = Buffer.from([195, 40]);
    await writeFile(f.companion, Buffer.from([255, 0, 195, 40]));
    f.media.source.size = current.length;
    f.media.url = f.media.url.replace(
      /fileHash=[^&]+/u,
      `fileHash=${createHash('md5').update(current).digest('hex')}`,
    );
    f.fetcher.callsFake(
      async () => new Response(current, { headers: { 'content-type': 'text/plain' } }),
    );
    await f.run();
    expect(f.fetcher.called).to.equal(true);
  });
  for (const kind of ['empty', 'response-mime'] as const)
    it(`rejects current binary ${kind} independently of valid selected bytes`, async () => {
      const f = await fixture();
      const current = kind === 'empty' ? Buffer.alloc(0) : Buffer.from([195, 40]);
      f.media.source.size = current.length;
      f.media.url = f.media.url.replace(
        /fileHash=[^&]+/u,
        `fileHash=${createHash('md5').update(current).digest('hex')}`,
      );
      f.fetcher.callsFake(
        async () =>
          new Response(current, {
            headers: {
              'content-type': kind === 'response-mime' ? 'application/pdf' : 'text/plain',
            },
          }),
      );
      await rejects(f.run(), /Document|document|media|Media|UTF-8|encoded data/u);
    });
  for (const kind of ['metadata', 'language', 'root', 'mime', 'filename', 'url'] as const)
    it(`rejects unsupported local ${kind}`, async () => {
      const f = await fixture();
      if (kind === 'metadata') f.definition.title = 'Other';
      if (kind === 'language') f.definition.language = 'de';
      if (kind === 'root') f.definition.folderPath = ['nested'];
      if (kind === 'mime') f.definition.media.mimeType = 'application/pdf';
      if (kind === 'filename') {
        f.definition.media.companion.path = 'Guide.cms-document.media.pdf';
        await writeFile(path.join(f.directory, f.definition.media.companion.path), f.bytes);
      }
      if (kind === 'url') f.definition.urlName = '';
      await f.save();
      await rejects(f.run());
      // Safe suffixes reach native filename identity comparison; metadata differences stay local.
      if (kind !== 'filename') expect(f.fetcher.called).to.equal(false);
    });
  for (const kind of [
    'source-bytes',
    'source-definition',
    'native',
    'root',
    'language',
    'inventory',
    'unrelated-row',
  ] as const)
    it(`rejects ${kind} drift during acquisition`, async () => {
      const f = await fixture();
      f.duringDownload(async () => {
        if (kind === 'source-bytes') await writeFile(f.companion, 'Changed');
        if (kind === 'source-definition') {
          f.definition.title = 'Changed';
          await f.save();
        }
        if (kind === 'native') f.detail.title = 'Changed';
        if (kind === 'root') f.workspace.rootFolderId = 'other';
        if (kind === 'language') f.workspace.defaultLanguage = 'de';
        if (kind === 'inventory') f.row.Name = 'Changed';
        if (kind === 'unrelated-row')
          f.rows.push({
            ...structuredClone(f.row),
            Id: '9Ps000000000002AAA',
            ManagedContentId: '20Y000000000002AAA',
            ManagedContentKey: 'MCOTHER',
            Name: 'Other',
            UrlName: 'other',
            ManagedContent: { AuthoredManagedContentSpaceId: workspaceId, ApiName: 'Other' },
          });
      });
      await rejects(f.run());
      expect(f.methods.every((method) => method === 'GET')).to.equal(true);
      expect(await readdir(f.directory)).to.have.length(2);
    });
});
