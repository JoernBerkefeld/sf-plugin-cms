import { expect } from 'chai';
import type { Connection } from '@salesforce/core';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import sinon from 'sinon';
import { admitDeployDocumentUnchanged } from '../../src/services/deploy-document-unchanged.js';
import { prepareDeployDestination } from '../../src/services/deploy-destination-preparation.js';
import { preflightDeployBatch } from '../../src/services/deploy-batch-preflight.js';
import { selectDeploySources } from '../../src/services/deploy-source-selection.js';
import {
  executeDeployBatchDocumentItem,
  revalidateDeployBatchDocumentBoundary,
} from '../../src/services/deploy-batch-executor.js';
import type { DeployBatchPreflight } from '../../src/services/deploy-batch-preflight.js';
import type { NativeInventoryRow } from '../../src/services/retrieve-native-inventory.js';

type Row = Record<string, unknown>;
const workspaceId = '0Zu000000000001AAA';
const contentId = '20Y000000000001AAA';
const variantId = '9Ps000000000001AAA';
async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'cms-document-unchanged-'));
  const definitionFile = path.join(directory, 'Guide.cms-document.json');
  const fileName = 'Guide.cms-document.media.txt';
  const companion = path.join(directory, fileName);
  const bytes = Buffer.from('Grüße 世界\r\nDocument\n');
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
    Name: 'Guide document',
    UrlName: 'guide-document',
    ManagedContentKey: 'MCGENERATED',
    ManagedContent: { AuthoredManagedContentSpaceId: workspaceId, ApiName: 'Guide' },
  };
  const media = {
    source: { type: 'file', size: bytes.length, mimeType: 'text/plain' },
    url: `/cms/media/MCGENERATED?version=1&fileHash=${createHash('md5').update(bytes).digest('hex')}&fileName=${fileName}`,
  };
  const detail: Row = {
    managedContentId: contentId,
    managedContentVariantId: variantId,
    contentKey: 'MCGENERATED',
    apiName: 'Guide',
    title: 'Guide document',
    urlName: 'guide-document',
    contentType: { fullyQualifiedName: 'sfdc_cms__document' },
    contentSpace: { id: workspaceId },
    language: 'en_US',
    folder: { id: 'root' },
    isPublished: false,
    status: { status: 'Draft' },
    contentBody: { 'sfdc_cms:media': media },
  };
  const rows = [row];
  const methods: string[] = [];
  let hook: ((url: URL) => void | Promise<void>) | undefined;
  let siblingCount = 1;
  let variantReads = 0;
  const connection = {
    accessToken: 'test-token',
    instanceUrl: 'https://example.invalid',
    getApiVersion: () => '67.0',
    request(input: { method: string; url: string }) {
      const result = (async () => {
        methods.push(input.method);
        expect(input.method).to.equal('GET');
        const url = new URL(input.url, 'https://example.invalid');
        await hook?.(url);
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
        if (url.pathname.includes('/variants/')) variantReads += 1;
        return structuredClone(detail);
      })();
      return Object.assign(result, { stream: () => new PassThrough() });
    },
  } as unknown as Pick<Connection, 'request' | 'getApiVersion'> &
    Partial<Pick<Connection, 'accessToken' | 'instanceUrl'>>;
  const input = { definitionFile, workspaceId, language: 'en_US', expectedRootFolderId: 'root' };
  return {
    directory,
    definition,
    save,
    companion,
    bytes,
    workspace,
    row,
    rows,
    detail,
    media,
    methods,
    input,
    hook(value: typeof hook) {
      hook = value;
    },
    count(value: number) {
      siblingCount = value;
    },
    reads: () => variantReads,
    run: () => admitDeployDocumentUnchanged(connection, input),
    plan: async () =>
      prepareDeployDestination(connection, {
        selection: await selectDeploySources({ 'source-dir': [definitionFile] }),
        workspaceId,
        language: 'en_US',
      }),
    batch: () =>
      preflightDeployBatch(connection, {
        sources: { 'source-dir': [directory] },
        workspaceId,
        language: 'en_US',
      }),
    route: (boundary: () => Promise<void>) =>
      executeDeployBatchDocumentItem(
        connection,
        {
          ...input,
          destinationOrgId: '00D000000000001AAA',
          reportFile: path.join(directory, 'item.json'),
        },
        'unchanged',
        boundary,
      ),
    boundary: (baseline: DeployBatchPreflight, registered: readonly NativeInventoryRow[] = []) =>
      revalidateDeployBatchDocumentBoundary(
        connection,
        {
          sources: { 'source-dir': [directory] },
          workspaceId,
          language: 'en_US',
        },
        baseline,
        0,
        registered,
      ),
  };
}
async function failure(operation: Promise<unknown>) {
  try {
    await operation;
  } catch (error) {
    expect((error as Error).message).to.match(
      /Document|document|Native|native|Media|media|Incomplete|Unsupported|disagreement|mismatch|same-stem|encoded data|Unsafe|Marketing|inventory/u,
    );
    return;
  }
  throw new Error('Expected rejection');
}
function downloaded(
  f: Awaited<ReturnType<typeof fixture>>,
  bytes = f.bytes,
  action: () => void | Promise<void> = () => {},
  mime = 'text/plain',
) {
  return sinon.stub(globalThis, 'fetch').callsFake(async () => {
    await action();
    return new Response(bytes, { headers: { 'content-type': mime } });
  });
}

describe('private read-only Document unchanged admission', () => {
  afterEach(() => sinon.restore());
  it('routes private batch unchanged with fresh identity and both boundary callbacks, without a journal', async () => {
    const f = await fixture();
    downloaded(f);
    const baseline = await f.batch();
    let callbacks = 0;
    const result = await f.route(async () => {
      callbacks += 1;
      await f.boundary(baseline);
    });
    expect(result).to.deep.equal({ target: { contentId, variantId }, outcome: 'unchanged' });
    expect(callbacks).to.equal(2);
    expect(await readdir(f.directory)).to.have.length(2);
    expect(f.methods.every((method) => method === 'GET')).to.equal(true);
  });
  for (const drift of ['source', 'root', 'inventory'] as const)
    it(`withholds private batch unchanged result after final callback ${drift} drift`, async () => {
      const f = await fixture();
      downloaded(f);
      const baseline = await f.batch();
      let callbacks = 0;
      await failure(
        f.route(async () => {
          callbacks += 1;
          if (callbacks === 2) {
            if (drift === 'source') await writeFile(f.companion, 'changed');
            if (drift === 'root') f.workspace.rootFolderId = 'other';
            if (drift === 'inventory') f.row.Name = 'changed';
          }
          await f.boundary(baseline);
        }),
      );
      expect(callbacks).to.equal(2);
      expect(await readdir(f.directory)).to.have.length(2);
      expect(f.methods.every((method) => method === 'GET')).to.equal(true);
    });
  for (const operation of ['create', 'unchanged'] as const) {
    it(`revalidates ${operation} boundary with exact verified prefix and no execution`, async () => {
      const f = await fixture();
      if (operation === 'create') f.rows.length = 0;
      else downloaded(f);
      const baseline = await f.batch();
      const frozen = JSON.stringify(baseline);
      const prefix = {
        ...structuredClone(f.row),
        Id: '9Ps000000000002AAA',
        ManagedContentId: '20Y000000000002AAA',
        ManagedContentKey: 'MCPREFIX',
        Name: 'Earlier',
        UrlName: 'earlier',
        ManagedContent: { AuthoredManagedContentSpaceId: workspaceId, ApiName: 'Earlier' },
      };
      f.rows.push(prefix);
      await f.boundary(baseline, [prefix as NativeInventoryRow]);
      expect(JSON.stringify(baseline)).to.equal(frozen);
      expect(await readdir(f.directory)).to.have.length(2);
      expect(f.methods.every((method) => method === 'GET')).to.equal(true);
    });
    for (const drift of [
      'source',
      'root',
      'language',
      'unknown-inventory',
      'prefix-changed',
      'prefix-missing',
      'late-source',
      'late-inventory',
    ] as const)
      it(`blocks ${operation} boundary ${drift} drift`, async () => {
        const f = await fixture();
        if (operation === 'create') f.rows.length = 0;
        else downloaded(f);
        const baseline = await f.batch();
        const prefix = {
          ...structuredClone(f.row),
          Id: '9Ps000000000002AAA',
          ManagedContentId: '20Y000000000002AAA',
          ManagedContentKey: 'MCPREFIX',
          Name: 'Earlier',
          UrlName: 'earlier',
          ManagedContent: { AuthoredManagedContentSpaceId: workspaceId, ApiName: 'Earlier' },
        };
        const registered = structuredClone(prefix) as NativeInventoryRow;
        f.rows.push(prefix);
        if (drift === 'source') await writeFile(f.companion, 'Changed bytes');
        if (drift === 'root') f.workspace.rootFolderId = 'changed';
        if (drift === 'language') f.workspace.defaultLanguage = 'de';
        if (drift === 'unknown-inventory')
          f.rows.push({
            ...prefix,
            Id: '9Ps000000000003AAA',
            ManagedContentId: '20Y000000000003AAA',
            ManagedContent: { AuthoredManagedContentSpaceId: workspaceId, ApiName: null },
          });
        if (drift === 'prefix-changed') prefix.Name = 'Changed';
        if (drift === 'prefix-missing') f.rows.pop();
        let changed = false;
        f.hook(async (url) => {
          if (!changed && url.pathname.includes('/spaces/') && drift.startsWith('late-')) {
            changed = true;
            if (drift === 'late-source') await writeFile(f.companion, 'Changed during admission');
            else prefix.Name = 'Changed during admission';
          }
        });
        try {
          await f.boundary(baseline, [registered]);
          throw new Error('Expected boundary rejection');
        } catch (error) {
          expect((error as Error).message).to.not.equal('Expected boundary rejection');
          expect((error as Error).message).to.match(/Document|selection|inventory|CREATE/u);
        }
        expect(await readdir(f.directory)).to.have.length(2);
        expect(f.methods.every((method) => method === 'GET')).to.equal(true);
      });
  }
  it('plans absent CREATE without granting mutation authority or creating journals', async () => {
    const f = await fixture();
    f.rows.length = 0;
    const batch = await f.batch();
    expect(batch.eligible).to.equal(true);
    expect(batch.rootFolderId).to.equal('root');
    expect(batch.items[0].documentCreate?.observations.inventory.records).to.deep.equal([]);
    expect(batch.items[0].documentCreate?.mediaSha256).to.equal(
      createHash('sha256').update(f.bytes).digest('hex'),
    );
    expect(await readdir(f.directory)).to.have.length(2);
    expect(f.methods.every((method) => method === 'GET')).to.equal(true);
  });
  it('plans exact unchanged with identity-only unqualified observation', async () => {
    const f = await fixture();
    downloaded(f);
    const batch = await f.batch();
    expect(batch.eligible).to.equal(true);
    expect(batch.items[0].proposed).to.equal('unchanged');
    expect(batch.items[0].documentUnchanged).to.deep.equal({
      qualification: 'unqualified',
      operation: 'unchanged',
      contentId,
      variantId,
      contentKey: 'MCGENERATED',
    });
    expect(batch.items[0].update).to.equal(undefined);
    expect(await readdir(f.directory)).to.have.length(2);
  });
  for (const kind of ['bytes', 'metadata', 'root', 'language', 'inventory-drift'])
    it(`guards Document batch ${kind} without Image UPDATE fallback`, async () => {
      const f = await fixture();
      if (kind === 'bytes') await writeFile(f.companion, 'Different');
      if (kind === 'metadata') f.detail.title = 'Other';
      if (kind === 'root') f.detail.folder = { id: 'elsewhere' };
      if (kind === 'language') f.workspace.defaultLanguage = 'de';
      downloaded(f, f.bytes, () => {
        if (kind === 'inventory-drift') f.row.Name = 'Changed';
      });
      const plan = await f.plan();
      if (kind === 'bytes') {
        expect(plan.items[0].proposed).to.equal('update');
        expect(plan.items[0].documentUpdate?.operation).to.equal('update');
      } else
        expect(plan.blockedReasons.length > 0 || plan.items[0]?.proposed === 'blocked').to.equal(
          true,
        );
      if (kind === 'language') {
        try {
          await f.batch();
          throw new Error('Expected scope rejection');
        } catch (error) {
          expect((error as Error).message).to.include('default language');
        }
        return;
      }
      const batch = await f.batch();
      expect(batch.eligible).to.equal(kind === 'bytes');
      if (kind === 'bytes') expect(batch.items[0].documentUpdate?.operation).to.equal('update');
      expect(batch.items[0].imageUpdate).to.equal(undefined);
      expect(batch.items[0].update).to.equal(undefined);
      expect(f.methods.every((method) => method === 'GET')).to.equal(true);
    });
  it('shares CREATE title collision planning across Email and Document', async () => {
    const f = await fixture();
    f.rows.length = 0;
    const email = {
      contract: 'sf-cms-source-definition',
      contractVersion: '1.0.0',
      identity: {
        family: 'cms',
        type: 'Email',
        apiName: 'Alpha',
        context: { workspaceApiName: 'Source' },
      },
      contentType: 'sfdc_cms__email',
      language: 'en_US',
      title: f.definition.title,
      folderPath: [],
      contentBody: {
        'sfdc_cms:title': f.definition.title,
        messagePurpose: 'Transactional',
        subjectLine: 'Hi',
      },
      companions: { rawHtml: 'Alpha.cms-email.html' },
    };
    await writeFile(path.join(f.directory, 'Alpha.cms-email.json'), JSON.stringify(email));
    await writeFile(path.join(f.directory, 'Alpha.cms-email.html'), '<p>Desired</p>');
    const batch = await f.batch();
    expect(batch.eligible).to.equal(false);
    expect(
      batch.items.some((item) =>
        item.blockedReasons.some((reason) => reason.includes('title/URL collision')),
      ),
    ).to.equal(true);
    expect(await readdir(f.directory)).to.have.length(4);
    email.title = 'Unique email';
    email.contentBody['sfdc_cms:title'] = email.title;
    await writeFile(path.join(f.directory, 'Alpha.cms-email.json'), JSON.stringify(email));
    const mixed = await f.batch();
    expect(mixed.eligible).to.equal(true);
    expect(mixed.items.map((item) => item.proposed)).to.deep.equal(['create', 'create']);
    expect(mixed.items[0].create).not.to.equal(undefined);
    expect(mixed.items[1].documentCreate?.rootFolderId).to.equal('root');
    expect(await readdir(f.directory)).to.have.length(4);
    expect(f.methods.every((method) => method === 'GET')).to.equal(true);
  });
  it('binds exact Unicode/mixed-ending native bytes with no mutation, journal or UPDATE authority', async () => {
    const f = await fixture();
    const fetcher = downloaded(f);
    expect(await f.run()).to.deep.equal({
      qualification: 'unqualified',
      operation: 'unchanged',
      contentId,
      variantId,
      contentKey: 'MCGENERATED',
    });
    expect(fetcher.calledOnce).to.equal(true);
    expect(f.methods.every((method) => method === 'GET')).to.equal(true);
    const files = await readdir(f.directory);
    expect(files.toSorted()).to.deep.equal([
      'Guide.cms-document.json',
      'Guide.cms-document.media.txt',
    ]);
    expect(await f.run()).to.have.property('operation', 'unchanged');
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
    it(`blocks inventory ${key} disagreement`, async () => {
      const f = await fixture();
      f.row[key] = typeof f.row[key] === 'boolean' ? !f.row[key] : 'Other';
      const fetcher = downloaded(f);
      await failure(f.run());
      expect(fetcher.called).to.equal(false);
    });
  for (const kind of [
    'absent',
    'superseded',
    'hidden-sibling',
    'unknown-api',
    'title-collision',
    'url-collision',
  ])
    it(`blocks ${kind} inventory evidence`, async () => {
      const f = await fixture();
      switch (kind) {
        case 'absent': {
          f.rows.length = 0;
          break;
        }
        case 'hidden-sibling': {
          f.count(2);
          break;
        }
        case 'unknown-api': {
          (f.row.ManagedContent as Row).ApiName = null;
          break;
        }
        default: {
          f.rows.push({
            ...structuredClone(f.row),
            Id: '9Ps000000000002AAA',
            ...(kind === 'superseded'
              ? { ManagedContentVariantStatus: 'Superseded', IsPrimary: false }
              : {
                  ManagedContentId: '20Y000000000002AAA',
                  ManagedContent: { AuthoredManagedContentSpaceId: workspaceId, ApiName: 'Other' },
                  Name: kind === 'title-collision' ? 'Guide document' : 'Other',
                  UrlName: kind === 'url-collision' ? 'guide-document' : 'other',
                }),
          });
        }
      }
      downloaded(f);
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
    'contentSpace',
  ])
    it(`blocks independent detail ${key} substitution`, async () => {
      const f = await fixture();
      f.detail[key] = ['folder', 'contentSpace'].includes(key) ? { id: 'elsewhere' } : 'Other';
      downloaded(f);
      await failure(f.run());
    });
  for (const kind of [
    'filename',
    'native-mime',
    'response-mime',
    'hash',
    'download-bytes',
    'desired-bytes',
    'external-url',
    'unknown-body',
  ])
    it(`blocks ${kind} rather than authorizing UPDATE`, async () => {
      const f = await fixture();
      if (kind === 'filename')
        f.media.url = f.media.url.replace('Guide.cms-document.media.txt', 'other.txt');
      if (kind === 'native-mime') f.media.source.mimeType = 'application/pdf';
      if (kind === 'hash')
        f.media.url = f.media.url.replace(/fileHash=[^&]+/u, `fileHash=${'0'.repeat(32)}`);
      if (kind === 'external-url') f.media.url = 'https://outside.invalid/guide.txt';
      if (kind === 'unknown-body') (f.detail.contentBody as Row).unknown = 'unsupported';
      if (kind === 'desired-bytes')
        await writeFile(f.companion, Buffer.from('Different exact bytes!\n'));
      downloaded(
        f,
        kind === 'download-bytes' ? Buffer.alloc(f.bytes.length, 65) : f.bytes,
        undefined,
        kind === 'response-mime' ? 'application/pdf' : 'text/plain',
      );
      await failure(f.run());
    });
  for (const kind of [
    'local-identity',
    'local-type',
    'local-mime',
    'local-language',
    'local-root',
    'local-title',
    'local-url',
    'url-only',
    'invalid-utf8',
    'workspace-id',
    'workspace-language',
    'workspace-root',
    'workspace-type',
  ])
    it(`blocks unsupported ${kind}`, async () => {
      const f = await fixture();
      if (kind === 'local-identity') f.definition.identity.apiName = 'Other';
      if (kind === 'local-type') f.definition.identity.type = 'Image';
      if (kind === 'local-mime') f.definition.media.mimeType = 'application/pdf';
      if (kind === 'local-language') f.definition.language = 'de';
      if (kind === 'local-root') f.definition.folderPath = ['nested'];
      if (kind === 'local-title') f.definition.title = ' ';
      if (kind === 'local-url') f.definition.urlName = 'Bad Slug';
      if (kind === 'url-only')
        Object.assign(f.definition, {
          media: { representation: 'url-only', address: '/document' },
        });
      if (kind === 'invalid-utf8') await writeFile(f.companion, Buffer.from([255]));
      if (kind === 'workspace-id') f.workspace.id = '0Zu000000000002AAA';
      if (kind === 'workspace-language') f.workspace.defaultLanguage = 'de';
      if (kind === 'workspace-root') f.workspace.rootFolderId = 'different';
      if (kind === 'workspace-type') f.workspace.spaceType = { apiName: 'Content' };
      await f.save();
      downloaded(f);
      await failure(f.run());
    });
  for (const kind of [
    'local-bytes',
    'local-metadata',
    'workspace-root',
    'workspace-language',
    'inventory',
    'detail',
  ])
    it(`blocks ${kind} drift during download`, async () => {
      const f = await fixture();
      downloaded(f, f.bytes, async () => {
        if (kind === 'local-bytes') await writeFile(f.companion, 'Changed');
        if (kind === 'local-metadata') {
          f.definition.title = 'Changed';
          await f.save();
        }
        if (kind === 'workspace-root') f.workspace.rootFolderId = 'changed';
        if (kind === 'workspace-language') f.workspace.defaultLanguage = 'de';
        if (kind === 'inventory') f.row.Name = 'Changed';
        if (kind === 'detail') f.detail.title = 'Changed';
      });
      await failure(f.run());
    });
  it('blocks replacement acquisition identity even with equal bytes', async () => {
    const f = await fixture();
    let changed = false;
    f.hook((url) => {
      if (!changed && f.reads() === 1 && url.pathname.endsWith('/query')) {
        changed = true;
        f.row.ManagedContentId = '20Y000000000002AAA';
        f.detail.managedContentId = '20Y000000000002AAA';
      }
    });
    downloaded(f);
    await failure(f.run());
  });
});
