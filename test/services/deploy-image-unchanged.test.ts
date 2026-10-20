import { expect } from 'chai';
import type { Connection } from '@salesforce/core';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import sinon from 'sinon';
import { admitDeployImageUnchanged } from '../../src/services/deploy-image-unchanged.js';
import { executeDeployImage } from '../../src/services/deploy-image-executor.js';
import { selectDeploySources } from '../../src/services/deploy-source-selection.js';
import { preflightDeployBatch } from '../../src/services/deploy-batch-preflight.js';
const TEST_IMAGE_SCOPE = {
  orgId: '00D000000000071AAA',
  workspaceId: '0Zu000000000071AAA',
  rootFolderId: '9Pu000000000071AAA',
  apiNames: ['Test_Image_A', 'Test_Image_B'],
};
import { executeDeployBatch } from '../../src/services/deploy-batch-executor.js';
import { rewriteAtomic } from '../../src/services/import-workspace.js';

type Row = Record<string, unknown>;
const workspaceId = '0Zu000000000001AAA';
const contentId = '20Y000000000001AAA';
const variantId = '9Ps000000000001AAA';
async function fixture(apiName = 'Hero') {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'cms-image-unchanged-'));
  const definitionFile = path.join(directory, `${apiName}.cms-image.json`);
  const fileName = `${apiName}.cms-image.media.png`;
  const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1]);
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
  const companion = path.join(directory, fileName);
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
  let variantReads = 0;
  let parentReads = 0;
  let workspaceInventories = 0;
  let hook: ((url: URL) => void | Promise<void>) | undefined;
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
          if (
            !q.includes(' IN (') &&
            !q.includes("ManagedContentId = '") &&
            !q.includes('COUNT(Id)') &&
            !q.includes('Id >')
          )
            workspaceInventories += 1;
          let records: Row[] = q.includes('Id >') ? [] : rows;
          if (q.includes('COUNT(Id)'))
            records =
              rows.length > 0
                ? [{ ManagedContentId: rows[0].ManagedContentId, siblingCount: rows.length }]
                : [];
          return { records: structuredClone(records), totalSize: records.length, done: true };
        }
        if (url.pathname.includes('/variants/')) variantReads += 1;
        else parentReads += 1;
        return structuredClone(detail);
      })();
      return Object.assign(result, { stream: () => new PassThrough() });
    },
  } as unknown as Pick<Connection, 'request' | 'getApiVersion'> &
    Partial<Pick<Connection, 'accessToken' | 'instanceUrl'>>;
  const input = { definitionFile, workspaceId, language: 'en_US' };
  return {
    directory,
    connection,
    definition,
    save,
    companion,
    bytes,
    row,
    rows,
    detail,
    workspace,
    input,
    methods,
    counts: () => ({ variantReads, parentReads, workspaceInventories }),
    hook: (value: typeof hook) => {
      hook = value;
    },
    run: (options = {}) => admitDeployImageUnchanged(connection, input, options),
  };
}
async function failure(
  operation: Promise<unknown>,
  pattern = /Image unchanged|Native|native|Media|media|Incomplete|Unsupported/u,
) {
  try {
    await operation;
  } catch (error) {
    expect((error as Error).message).to.match(pattern);
    return;
  }
  throw new Error('Expected rejection');
}
function downloaded(
  f: Awaited<ReturnType<typeof fixture>>,
  bytes = f.bytes,
  action: () => void | Promise<void> = () => {},
) {
  return sinon.stub(globalThis, 'fetch').callsFake(async () => {
    await action();
    return new Response(bytes, { headers: { 'content-type': 'image/png' } });
  });
}
describe('private portable binary Image unchanged admission', () => {
  afterEach(() => sinon.restore());
  it('routes explicit unchanged intent without journal persistence or mutation authority', async () => {
    const f = await fixture();
    downloaded(f);
    const rewrite = sinon.stub().rejects(new Error('Unchanged must not journal'));
    const beforeMutation = sinon.stub().rejects(new Error('Unchanged must not mutate'));
    const result = await executeDeployImage(
      f.connection,
      { ...f.input, operation: 'unchanged', destinationOrgId: '', reportFile: '' },
      {},
      { rewrite },
      beforeMutation,
    );
    expect(beforeMutation.called).to.equal(false);
    expect(result).to.include({ qualification: 'unqualified', operation: 'unchanged' });
    expect(rewrite.called).to.equal(false);
    expect(f.methods.every((method) => method === 'GET')).to.equal(true);
  });
  it('rejects unknown routing intent before any destination read or journal', async () => {
    const f = await fixture();
    const rewrite = sinon.stub().rejects(new Error('Must not journal'));
    await failure(
      executeDeployImage(
        f.connection,
        {
          ...f.input,
          operation: 'delete' as 'create',
          destinationOrgId: '',
          reportFile: '',
        },
        {},
        { rewrite },
      ),
      /Unsupported Image deploy operation/u,
    );
    expect(rewrite.called).to.equal(false);
    expect(f.methods).to.deep.equal([]);
  });
  it('admits ordinary Image selection and binds its binary snapshot', async () => {
    const f = await fixture();
    const flags = { 'source-dir': [f.input.definitionFile] };
    const selected = await selectDeploySources(flags);
    expect(selected.items[0].mediaSha256).to.equal(
      createHash('sha256').update(f.bytes).digest('hex'),
    );
    const directorySelection = await selectDeploySources({
      'source-dir': [f.directory],
      'content-type': ['sfdc_cms__image'],
    });
    expect(directorySelection.items).to.deep.equal(selected.items);
    expect(f.methods).to.deep.equal([]);
  });
  it('rejects URL-only Image before destination reads', async () => {
    const f = await fixture();
    f.definition.media = {
      representation: 'url-only',
      address: 'https://example.invalid/image.png',
    } as unknown as typeof f.definition.media;
    await f.save();
    await failure(selectDeploySources({ 'source-dir': [f.input.definitionFile] }), /binary Image/u);
    expect(f.methods).to.deep.equal([]);
  });
  for (const [mimeType, extension, bytes] of [
    ['image/jpeg', 'jpg', Buffer.from([255, 216, 255, 1])],
    ['image/gif', 'gif', Buffer.from('GIF89a')],
    ['image/webp', 'webp', Buffer.from('RIFF0000WEBP')],
  ] as const)
    it(`admits ordinary ${mimeType} selection before destination reads`, async () => {
      const f = await fixture();
      const companionName = `Hero.cms-image.media.${extension}`;
      f.definition.media.mimeType = mimeType;
      f.definition.media.companion.path = companionName;
      await writeFile(path.join(f.directory, companionName), bytes);
      await f.save();
      for (const flags of [
        { 'source-dir': [f.input.definitionFile] },
        { 'source-dir': [f.directory], 'content-type': ['sfdc_cms__image'] },
      ]) {
        const selected = await selectDeploySources(flags);
        expect(selected.items[0].mediaSha256).to.equal(
          createHash('sha256').update(bytes).digest('hex'),
        );
        expect(selected.items[0].definition).to.deep.equal(f.definition);
      }
      expect(f.methods).to.deep.equal([]);
    });
  it('blocks changed selected binary snapshots without accepting a new plan', async () => {
    const f = await fixture();
    f.rows.length = 0;
    const sources = { 'source-dir': [f.input.definitionFile] };
    const expectedSelection = await selectDeploySources(sources);
    await writeFile(f.companion, Buffer.concat([f.bytes, Buffer.from([2])]));
    await failure(
      preflightDeployBatch(f.connection, {
        ...f.input,
        sources,
        expectedSelection,
      }),
      /selection changed/u,
    );
    expect(f.methods).to.deep.equal([]);
  });
  for (const operation of ['create', 'unchanged', 'update', 'different', 'identity', 'ambiguous'])
    it(`admits ordinary Image ${operation} only with supported destination evidence`, async () => {
      const f = await fixture();
      downloaded(f);
      if (operation === 'create') f.rows.length = 0;
      if (operation === 'different') f.detail.title = 'Changed';
      if (operation === 'identity') f.detail.managedContentId = '20Y000000000002AAA';
      if (operation === 'update')
        await writeFile(f.companion, Buffer.concat([f.bytes.subarray(0, 8), Buffer.from([2])]));
      if (operation === 'ambiguous')
        f.rows.push({ ...structuredClone(f.row), Id: '9Ps000000000002AAA' });
      const input = {
        ...f.input,
        sources: { 'source-dir': [f.input.definitionFile] },
      };
      const result = await preflightDeployBatch(f.connection, input);
      const supported = ['create', 'unchanged', 'update'].includes(operation);
      expect(result.eligible).to.equal(supported);
      expect(result.rootFolderId).to.equal(f.workspace.rootFolderId);
      expect(result.items[0].proposed).to.equal(supported ? operation : 'blocked');
      expect(result.items[0].blockedReasons.length > 0).to.equal(!supported);
      if (supported) {
        const proofs = {
          create: result.items[0].imageCreate,
          update: result.items[0].imageUpdate,
          unchanged: result.items[0].imageUnchanged,
        };
        const proof = proofs[operation as keyof typeof proofs];
        expect(proof).not.to.equal(undefined);
      }
      if (operation === 'update') {
        expect(result.preparation.items[0].changedFields).to.deep.equal(['media']);
        expect(result.preparation.items[0].existing).to.include({ variantId, contentId });
        expect(result.items[0].update).to.equal(undefined);
      }
      expect(f.methods.every((method) => method === 'GET')).to.equal(true);
      const files = await readdir(f.directory);
      expect(files.length).to.equal(2);
    });
  for (const operation of ['create', 'update', 'unchanged'])
    it(`acquires ordinary Image ${operation} proof in a fictional scope`, async () => {
      const f = await fixture(TEST_IMAGE_SCOPE.apiNames[0]);
      downloaded(f);
      f.input.workspaceId = TEST_IMAGE_SCOPE.workspaceId;
      f.workspace.id = TEST_IMAGE_SCOPE.workspaceId;
      f.workspace.rootFolderId = TEST_IMAGE_SCOPE.rootFolderId;
      f.definition.identity.apiName = TEST_IMAGE_SCOPE.apiNames[0];
      f.row.ManagedContent = {
        AuthoredManagedContentSpaceId: TEST_IMAGE_SCOPE.workspaceId,
        ApiName: TEST_IMAGE_SCOPE.apiNames[0],
      };
      f.detail.apiName = TEST_IMAGE_SCOPE.apiNames[0];
      f.detail.contentSpace = { id: TEST_IMAGE_SCOPE.workspaceId };
      f.detail.folder = { id: TEST_IMAGE_SCOPE.rootFolderId };
      await f.save();
      if (operation === 'create') f.rows.length = 0;
      if (operation === 'update')
        await writeFile(f.companion, Buffer.concat([f.bytes, Buffer.from([3])]));
      const input = {
        ...f.input,
        sources: { 'source-dir': [f.input.definitionFile] },
      };
      const result = await preflightDeployBatch(f.connection, input);
      expect(result.eligible, JSON.stringify(result)).to.equal(true);
      expect(result.items[0].proposed).to.equal(operation);
      expect(result.items[0].create).to.equal(undefined);
      expect(result.items[0].update).to.equal(undefined);
      if (operation === 'unchanged') {
        const execution = await executeDeployBatch(f.connection, {
          ...input,
          destinationOrgId: TEST_IMAGE_SCOPE.orgId,
          reportFile: path.join(f.directory, 'controlled.json'),
        });
        expect(execution.report.state).to.equal('completed');
        expect(execution.report.summary.unchanged).to.equal(1);
      }
      expect(f.methods.every((method) => method === 'GET')).to.equal(true);
    });
  for (const operation of ['create', 'update', 'unchanged'])
    it(`blocks root changes between preparation and Image ${operation} admission`, async () => {
      const f = await fixture();
      downloaded(f);
      if (operation === 'create') f.rows.length = 0;
      if (operation === 'update')
        await writeFile(f.companion, Buffer.concat([f.bytes, Buffer.from([3])]));
      let workspaceReads = 0;
      f.hook((url) => {
        // Root capture and preparation agree; every later acquisition consistently sees the new root.
        const operationRead = { create: 5, update: 8, unchanged: 6 }[operation];
        if (url.pathname.includes('/spaces/') && ++workspaceReads === operationRead) {
          f.workspace.rootFolderId = '9Pu000000000072AAA';
          f.detail.folder = { id: f.workspace.rootFolderId };
        }
      });
      const result = await preflightDeployBatch(f.connection, {
        ...f.input,
        sources: { 'source-dir': [f.input.definitionFile] },
      });
      expect(result.eligible).to.equal(false);
      expect(result.rootFolderId).to.equal('root');
      expect(result.preparation.items[0].proposed).to.equal(operation);
      expect(result.items[0].blockedReasons.join(';')).to.match(/workspace root/u);
      expect(f.methods.every((method) => method === 'GET')).to.equal(true);
    });
  it('blocks a root change between unchanged baseline and execution', async () => {
    const f = await fixture();
    downloaded(f);
    const result = await executeDeployBatch(
      f.connection,
      {
        ...f.input,
        sources: { 'source-dir': [f.input.definitionFile] },
        destinationOrgId: TEST_IMAGE_SCOPE.orgId,
        reportFile: path.join(f.directory, 'root-drift.json'),
      },
      {},
      {
        rewrite: async (file, report) => {
          await rewriteAtomic(file, report);
          if (report.state === 'applying') {
            f.workspace.rootFolderId = '9Pu000000000072AAA';
            f.detail.folder = { id: f.workspace.rootFolderId };
          }
        },
      },
    );
    expect(result.report.state).to.equal('blocked');
    expect(result.report.summary.completed).to.equal(0);
    expect(result.report.summary.unchanged).to.equal(0);
    expect(result.report.items[0].outcome).to.equal('unattempted');
    expect(result.report.blockedReasons.join(';')).to.match(/workspace root/u);
    expect(f.methods.every((method) => method === 'GET')).to.equal(true);
  });
  it('blocks the whole mixed Email/Image selection before any Email CREATE', async () => {
    const f = await fixture();
    downloaded(f);
    // A title edit is genuinely outside the bytes-only Image UPDATE contract.
    f.definition.title = 'Unsupported changed title';
    await f.save();
    const emailFile = path.join(f.directory, 'Alpha.cms-email.json');
    await writeFile(
      emailFile,
      JSON.stringify({
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
        title: 'Alpha',
        folderPath: [],
        contentBody: {
          'sfdc_cms:title': 'Alpha',
          messagePurpose: 'Transactional',
          subjectLine: 'Hi',
        },
        companions: { rawHtml: 'Alpha.cms-email.html' },
      }),
    );
    await writeFile(path.join(f.directory, 'Alpha.cms-email.html'), '<p>Desired</p>');
    const execution = await executeDeployBatch(f.connection, {
      ...f.input,
      sources: { 'source-dir': [emailFile, f.input.definitionFile] },
      destinationOrgId: '00D000000000001AAA',
      reportFile: path.join(f.directory, 'mixed-blocked.json'),
    });
    expect(execution.report.state).to.equal('blocked');
    expect(execution.report.items.map((item) => item.proposed)).to.deep.equal([
      'create',
      'blocked',
    ]);
    expect(execution.report.blockedReasons.join(';')).to.match(/Unsupported|metadata/u);
    expect(execution.report.items.every((item) => item.outcome === 'unattempted')).to.equal(true);
    expect(execution.report.summary).to.include({
      completed: 0,
      created: 0,
      updated: 0,
      unattempted: 2,
    });
    expect(f.methods.every((method) => method === 'GET')).to.equal(true);
  });
  it('rejects a replacement identity observed between initial planning and UPDATE admission', async () => {
    const f = await fixture();
    await writeFile(f.companion, Buffer.concat([f.bytes.subarray(0, 8), Buffer.from([2])]));
    let replaced = false;
    downloaded(f, f.bytes, () => {
      if (replaced) return;
      replaced = true;
      f.row.ManagedContentId = '20Y000000000002AAA';
      f.detail.managedContentId = '20Y000000000002AAA';
    });
    const result = await preflightDeployBatch(f.connection, {
      ...f.input,
      sources: { 'source-dir': [f.input.definitionFile] },
    });
    expect(result.eligible).to.equal(false);
    expect(result.items[0].proposed).to.equal('blocked');
    expect(result.items[0].blockedReasons.join(',')).to.include('snapshot disagreement');
    expect(f.methods.every((method) => method === 'GET')).to.equal(true);
  });
  it('independently binds native identities and downloaded bytes without org, journal or source writes', async () => {
    const f = await fixture();
    const fetcher = downloaded(f);
    expect(await f.run()).to.deep.equal({
      qualification: 'unqualified',
      operation: 'unchanged',
      contentId,
      variantId,
      contentKey: 'MCGENERATED',
    });
    expect(f.methods.every((method) => method === 'GET')).to.equal(true);
    expect(fetcher.calledOnce).to.equal(true);
    expect(f.counts().parentReads).to.equal(1);
    expect(f.counts().variantReads).to.equal(4);
    const files = await readdir(f.directory);
    expect(files.toSorted()).to.deep.equal(['Hero.cms-image.json', 'Hero.cms-image.media.png']);
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
    it(`rejects inventory ${key} disagreement before downloading`, async () => {
      const f = await fixture();
      f.row[key] = typeof f.row[key] === 'boolean' ? !f.row[key] : 'Other';
      const fetcher = downloaded(f);
      await failure(f.run());
      expect(fetcher.called).to.equal(false);
    });
  for (const kind of ['absent', 'duplicate', 'title-collision', 'url-collision', 'unknown-api'])
    it(`rejects ${kind} workspace evidence without mutation`, async () => {
      const f = await fixture();
      if (kind === 'absent') f.rows.length = 0;
      else if (kind === 'unknown-api') (f.row.ManagedContent as Row).ApiName = null;
      else
        f.rows.push({
          ...f.row,
          Id: '9Ps000000000002AAA',
          ...(kind === 'duplicate'
            ? {}
            : {
                ManagedContent: { AuthoredManagedContentSpaceId: workspaceId, ApiName: 'Other' },
                Name: kind === 'title-collision' ? 'Hero image' : 'Other',
                UrlName: kind === 'url-collision' ? 'hero-image' : 'other',
              }),
        });
      await failure(f.run());
      expect(f.methods.every((method) => method === 'GET')).to.equal(true);
    });
  for (const key of [
    'managedContentId',
    'managedContentVariantId',
    'contentKey',
    'apiName',
    'title',
    'language',
    'folder',
  ])
    it(`rejects independent detail ${key} disagreement`, async () => {
      const f = await fixture();
      f.detail[key] = key === 'folder' ? { id: 'elsewhere' } : 'Other';
      await failure(f.run());
    });
  for (const kind of [
    'filename',
    'mime',
    'download-bytes',
    'desired-bytes',
    'external-url',
    'unknown-body',
  ])
    it(`rejects ${kind} instead of trusting normalized paths or hashes`, async () => {
      const f = await fixture();
      const media = (f.detail.contentBody as Record<string, { url: string; source: Row }>)[
        'sfdc_cms:media'
      ];
      if (kind === 'filename')
        media.url = media.url.replace('Hero.cms-image.media.png', 'other.png');
      if (kind === 'mime') media.source.mimeType = 'image/jpeg';
      if (kind === 'external-url') media.url = 'https://outside.invalid/hero.png';
      if (kind === 'unknown-body') (f.detail.contentBody as Row).other = 'unsupported';
      if (kind === 'desired-bytes')
        await writeFile(f.companion, Buffer.concat([f.bytes.subarray(0, 8), Buffer.from([2])]));
      downloaded(
        f,
        kind === 'download-bytes'
          ? Buffer.concat([f.bytes.subarray(0, 8), Buffer.from([2])])
          : f.bytes,
      );
      await failure(f.run(), /mismatch|MIME|signature|hash|MD5|Unsupported/u);
    });
  for (const kind of [
    'root',
    'language',
    'workspace-type',
    'url-only',
    'folder',
    'title',
    'workspace-id',
    'cancel',
  ])
    it(`rejects unsupported ${kind} admission`, async () => {
      const f = await fixture();
      if (kind === 'root') f.workspace.rootFolderId = '';
      if (kind === 'language') f.workspace.defaultLanguage = 'de_DE';
      if (kind === 'workspace-type') f.workspace.spaceType = { apiName: 'Content' };
      if (kind === 'url-only')
        Object.assign(f.definition, {
          media: { representation: 'url-only', address: 'https://outside.invalid/hero.png' },
        });
      if (kind === 'folder') f.definition.folderPath = ['Other'];
      if (kind === 'title') f.definition.title = ' ';
      if (kind === 'workspace-id') f.input.workspaceId = 'wrong';
      await f.save();
      const controller = new AbortController();
      if (kind === 'cancel') controller.abort();
      await failure(
        f.run({ signal: controller.signal }),
        /Image unchanged|Marketing|marketing|abort|cancell/u,
      );
    });
  for (const kind of ['local-bytes', 'local-metadata', 'workspace', 'inventory', 'detail'])
    it(`rejects observed ${kind} drift after independent acquisition`, async () => {
      const f = await fixture();
      downloaded(f, f.bytes, async () => {
        if (kind === 'local-bytes')
          await writeFile(f.companion, Buffer.concat([f.bytes, Buffer.from([2])]));
        if (kind === 'local-metadata') {
          f.definition.title = 'Changed';
          await f.save();
        }
        if (kind === 'workspace') f.workspace.rootFolderId = 'changed';
        if (kind === 'inventory') f.row.Name = 'Changed';
        if (kind === 'detail') f.detail.title = 'Changed';
      });
      await failure(f.run(), /drifted|mismatch/u);
    });
  it('rejects replacement acquisition identity even with equal bytes', async () => {
    const f = await fixture();
    let changed = false;
    f.hook((url) => {
      if (!changed && f.counts().variantReads === 1 && url.pathname.endsWith('/query')) {
        changed = true;
        f.row.ManagedContentId = '20Y000000000002AAA';
        f.detail.managedContentId = '20Y000000000002AAA';
      }
    });
    downloaded(f);
    await failure(f.run(), /mismatch|Incomplete|disagreement/u);
  });
});
