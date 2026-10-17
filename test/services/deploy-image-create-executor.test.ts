import { expect } from 'chai';
import type { Connection } from '@salesforce/core';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import sinon from 'sinon';
import { executeDeployImageCreate } from '../../src/services/deploy-image-create-executor.js';
import { executeDeployImage } from '../../src/services/deploy-image-executor.js';
import { executeDeployBatch } from '../../src/services/deploy-batch-executor.js';
const TEST_IMAGE_SCOPE = {
  orgId: '00D000000000071AAA',
  workspaceId: '0Zu000000000071AAA',
  rootFolderId: '9Pu000000000071AAA',
  apiNames: ['Test_Image_A', 'Test_Image_B'],
};
import {
  rewriteAtomic,
  type WorkspaceImportRunReport,
} from '../../src/services/import-workspace.js';

const workspaceId = '0Zu000000000001AAA';
const contentId = '20Y000000000001AAA';
const variantId = '9Ps000000000001AAA';
type Row = Record<string, unknown>;
async function fixture(apiName = 'Hero') {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'cms-image-executor-'));
  const definitionFile = path.join(directory, `${apiName}.cms-image.json`);
  const reportFile = path.join(directory, 'run.json');
  const fileName = `${apiName}.cms-image.media.png`;
  const companion = path.join(directory, fileName);
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
    folderPath: [],
    title: 'Hero image',
    urlName: 'hero-image',
    media: {
      representation: 'binary',
      mimeType: 'image/png',
      companion: { role: 'media', path: fileName },
    },
  };
  await writeFile(definitionFile, JSON.stringify(definition));
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
  const response: Row = {
    managedContentId: contentId,
    managedContentVariantId: variantId,
    contentKey: 'MCGENERATED',
  };
  let posts = 0;
  let driftRootAfterAdmission = false;
  let collision = false;
  let lost = false;
  let extra = false;
  let readError = false;
  const journal = async () =>
    JSON.parse(await readFile(input.reportFile, 'utf8')) as WorkspaceImportRunReport;
  const connection = {
    _refreshDelegate: () => {
      throw new Error('Replay forbidden');
    },
    getApiVersion: () => '67.0',
    request(
      this: { _refreshDelegate?: unknown },
      input: { method: string; url: string; body?: Buffer },
      options: { retry?: { maxRetries: number } },
    ) {
      const result = (async () => {
        const url = new URL(input.url, 'https://example.invalid');
        if (input.method === 'POST') {
          expect(this._refreshDelegate).to.equal(undefined);
          expect(options.retry?.maxRetries).to.equal(0);
          posts += 1;
          const intent = await journal();
          expect(intent.operations[0].state).to.equal('pending');
          expect(intent.operations[0].requestIdentity)
            .to.include(fileName)
            .and.include(intent.sourceManifestSha256);
          expect(input.body!.includes(bytes)).to.equal(true);
          if (lost) throw new Error('Lost response');
          return structuredClone(response);
        }
        expect(input.method).to.equal('GET');
        if (url.pathname.includes('/spaces/')) {
          const observed = structuredClone(workspace);
          if (driftRootAfterAdmission) workspace.rootFolderId = '9Pu000000000002AAA';
          return observed;
        }
        if (posts && readError) throw new Error('Read failed');
        if (url.pathname.endsWith('/query')) {
          const q = url.searchParams.get('q')!;
          const rows =
            posts || collision
              ? [row, ...(extra ? [{ ...row, Id: '9Ps000000000002AAA' }] : [])]
              : [];
          let records: Row[] = q.includes('Id >') ? [] : rows;
          if (q.includes('COUNT(Id)'))
            records =
              rows.length > 0 ? [{ ManagedContentId: contentId, siblingCount: rows.length }] : [];
          return { records: structuredClone(records), totalSize: records.length, done: true };
        }
        const recorded = await journal();
        expect(recorded.operations[0].result?.contentId).to.equal(contentId);
        return structuredClone(detail);
      })();
      return Object.assign(result, { stream: () => new PassThrough() });
    },
  } as unknown as Pick<Connection, 'request' | 'getApiVersion'> &
    Partial<Pick<Connection, 'accessToken' | 'instanceUrl'>>;
  // Keep transport on its injected request, supplying download authentication only after POST.
  Object.defineProperties(connection, {
    accessToken: { get: () => (posts ? 'test-token' : undefined) },
    instanceUrl: { get: () => (posts ? 'https://example.invalid' : undefined) },
  });
  const input = {
    definitionFile,
    workspaceId,
    language: 'en_US',
    destinationOrgId: '00D000000000001AAA',
    reportFile,
  };
  return {
    connection,
    input,
    bytes,
    companion,
    row,
    detail,
    response,
    workspace,
    journal,
    posts: () => posts,
    driftRootAfterAdmission: () => {
      driftRootAfterAdmission = true;
    },
    collide: () => {
      collision = true;
    },
    lose: () => {
      lost = true;
    },
    duplicate: () => {
      extra = true;
    },
    failRead: () => {
      readError = true;
    },
    run: (
      rewrite: (file: string, report: WorkspaceImportRunReport) => Promise<void> = rewriteAtomic,
      options = {},
    ) => executeDeployImageCreate(connection, input, options, { rewrite }),
  };
}
async function failure(operation: Promise<unknown>, pattern: RegExp) {
  try {
    await operation;
  } catch (error) {
    expect((error as Error).message).to.match(pattern);
    return;
  }
  throw new Error('Expected rejection');
}
async function downloaded(f: Awaited<ReturnType<typeof fixture>>, bytes = f.bytes) {
  return sinon
    .stub(globalThis, 'fetch')
    .callsFake(async () => new Response(bytes, { headers: { 'content-type': 'image/png' } }));
}
describe('journaled portable binary Image CREATE executor', () => {
  afterEach(() => sinon.restore());
  for (const drift of ['none', 'bytes', 'root-between-baseline-execution', 'root-after-admission'])
    it(`routes ordinary batch CREATE with boundary drift=${drift}`, async () => {
      const f = await fixture(TEST_IMAGE_SCOPE.apiNames[0]);
      await downloaded(f);
      const definition = JSON.parse(await readFile(f.input.definitionFile, 'utf8'));
      definition.identity.apiName = TEST_IMAGE_SCOPE.apiNames[0];
      await writeFile(f.input.definitionFile, JSON.stringify(definition));
      f.input.workspaceId = TEST_IMAGE_SCOPE.workspaceId;
      f.input.destinationOrgId = TEST_IMAGE_SCOPE.orgId;
      f.workspace.id = TEST_IMAGE_SCOPE.workspaceId;
      f.workspace.rootFolderId = TEST_IMAGE_SCOPE.rootFolderId;
      f.row.ManagedContent = {
        AuthoredManagedContentSpaceId: TEST_IMAGE_SCOPE.workspaceId,
        ApiName: TEST_IMAGE_SCOPE.apiNames[0],
      };
      f.detail.apiName = TEST_IMAGE_SCOPE.apiNames[0];
      f.detail.contentSpace = { id: TEST_IMAGE_SCOPE.workspaceId };
      f.detail.folder = { id: TEST_IMAGE_SCOPE.rootFolderId };
      if (drift === 'root-after-admission') f.driftRootAfterAdmission();
      // The fixture transport inspects its item journal at this exact path.
      const result = await executeDeployBatch(
        f.connection,
        {
          ...f.input,
          reportFile: path.join(path.dirname(f.input.reportFile), 'batch.json'),
          sources: { 'definition-file': [f.input.definitionFile] },
        },
        {},
        {
          rewrite: async (file, report) => {
            await rewriteAtomic(file, report);
            if (drift === 'root-between-baseline-execution' && report.state === 'applying') {
              f.workspace.rootFolderId = '9Pu000000000072AAA';
              f.detail.folder = { id: f.workspace.rootFolderId };
            }
          },
          item: {
            rewrite: async (file, report) => {
              f.input.reportFile = file;
              await rewriteAtomic(file, report);
              if (drift === 'bytes' && report.state === 'applying')
                await writeFile(f.companion, Buffer.concat([f.bytes, Buffer.from([9])]));
            },
          },
        },
      );
      expect(f.posts()).to.equal(drift === 'none' ? 1 : 0);
      expect(result.report.summary.created).to.equal(drift === 'none' ? 1 : 0);
      expect(result.report.summary.completed).to.equal(drift === 'none' ? 1 : 0);
      expect(result.report.state).to.equal(drift === 'none' ? 'completed' : 'blocked');
      if (drift.startsWith('root-'))
        expect(result.report.blockedReasons.join(';')).to.match(/workspace.*root/u);
    });
  it('routes explicit private CREATE through the journaled engine', async () => {
    const f = await fixture();
    await downloaded(f);
    const rewrite = sinon.spy(rewriteAtomic);
    const result = await executeDeployImage(
      f.connection,
      { ...f.input, operation: 'create' },
      {},
      { rewrite },
    );
    if (!('report' in result)) throw new Error('Expected CREATE journal result');
    expect(result.qualification).to.equal('unqualified');
    expect(result.report.state).to.equal('completed');
    expect(f.posts()).to.equal(1);
    expect(rewrite.called).to.equal(true);
    expect(await f.journal()).to.deep.equal(result.report);
  });
  it('awaits the dispatched batch boundary after durable intent and before POST', async () => {
    const f = await fixture();
    await downloaded(f);
    const boundary = sinon.spy(async () => {
      expect(f.posts()).to.equal(0);
      const intent = await f.journal();
      expect(intent.operations[0].state).to.equal('pending');
      await Promise.resolve();
    });
    await executeDeployImage(
      f.connection,
      { ...f.input, operation: 'create' },
      {},
      undefined,
      boundary,
    );
    expect(boundary.calledOnce).to.equal(true);
    expect(f.posts()).to.equal(1);
  });
  for (const change of ['reject', 'bytes', 'journal', 'cancel'])
    it(`blocks CREATE transport when the dispatched boundary causes ${change}`, async () => {
      const f = await fixture();
      const controller = new AbortController();
      await failure(
        executeDeployImage(
          f.connection,
          { ...f.input, operation: 'create' },
          { signal: controller.signal },
          undefined,
          async () => {
            expect(f.posts()).to.equal(0);
            const intent = await f.journal();
            expect(intent.operations[0].state).to.equal('pending');
            if (change === 'reject') throw new Error('Batch selection drift');
            if (change === 'bytes')
              await writeFile(f.companion, Buffer.concat([f.bytes, Buffer.from([3])]));
            if (change === 'journal') await writeFile(f.input.reportFile, '{}');
            if (change === 'cancel') controller.abort();
          },
        ),
        /Batch selection drift|drifted|intent changed|cancelled|abort/iu,
      );
      expect(f.posts()).to.equal(0);
      const report = await f.journal();
      expect(report.state).to.equal('failed');
    });
  it('journals once, creates once and independently verifies returned identities and real downloaded bytes', async () => {
    const f = await fixture();
    const fetcher = await downloaded(f);
    const result = await f.run();
    expect(result.qualification).to.equal('unqualified');
    expect(result.report.state).to.equal('completed');
    expect(result.report.operations[0].state).to.equal('succeeded');
    expect(result.report.createdParents[0]).to.deep.equal({
      contentId,
      contentKey: 'MCGENERATED',
      primaryVariantId: variantId,
      childVariantIds: [],
    });
    expect(await f.journal()).to.deep.equal(result.report);
    expect(f.posts()).to.equal(1);
    expect(fetcher.calledOnce).to.equal(true);
    await failure(f.run(), /collision/u);
    expect(f.posts()).to.equal(1);
  });
  it('never overwrites an existing journal', async () => {
    const f = await fixture();
    await writeFile(f.input.reportFile, 'existing');
    await failure(f.run(), /EEXIST/u);
    expect(f.posts()).to.equal(0);
    expect(await readFile(f.input.reportFile, 'utf8')).to.equal('existing');
  });
  it('never mutates after journal persistence failure', async () => {
    const f = await fixture();
    await failure(
      f.run(async () => {
        throw new Error('Disk failed');
      }),
      /Disk failed/u,
    );
    expect(f.posts()).to.equal(0);
    expect(await f.journal().then((report) => report.state)).to.equal('applying');
  });
  for (const change of ['collision', 'bytes', 'root', 'journal', 'cancel'])
    it(`rejects ${change} after durable intent without POST`, async () => {
      const f = await fixture();
      const controller = new AbortController();
      let changed = false;
      await failure(
        f.run(
          async (file, report) => {
            await rewriteAtomic(file, report);
            if (changed) return;
            changed = true;
            if (change === 'collision') f.collide();
            if (change === 'bytes')
              await writeFile(f.companion, Buffer.concat([f.bytes, Buffer.from([2])]));
            if (change === 'root') f.workspace.rootFolderId = 'other';
            if (change === 'journal') await writeFile(file, '{}');
            if (change === 'cancel') controller.abort();
          },
          { signal: controller.signal },
        ),
        /collision|drifted|intent changed|cancelled/u,
      );
      expect(f.posts()).to.equal(0);
      expect(await f.journal().then((report) => report.state)).to.equal('failed');
    });
  for (const kind of [
    'lost',
    'partial-one',
    'partial-two',
    'invalid',
    'inventory',
    'duplicate',
    'read',
    'metadata',
    'filename',
    'mime',
    'bytes',
  ])
    it(`retains honest uncertain intent after ${kind} without retry`, async () => {
      const f = await fixture();
      await downloaded(f, kind === 'bytes' ? Buffer.concat([f.bytes, Buffer.from([2])]) : f.bytes);
      if (kind === 'lost') f.lose();
      if (kind === 'partial-one') {
        delete f.response.contentKey;
        delete f.response.managedContentVariantId;
      }
      if (kind === 'partial-two') delete f.response.managedContentVariantId;
      if (kind === 'invalid') f.response.managedContentVariantId = 'invalid';
      if (kind === 'inventory') f.row.IsPublished = true;
      if (kind === 'duplicate') f.duplicate();
      if (kind === 'read') f.failRead();
      if (kind === 'metadata') f.detail.title = 'Wrong';
      const media = (f.detail.contentBody as Record<string, { url: string; source: Row }>)[
        'sfdc_cms:media'
      ];
      if (kind === 'filename')
        media.url = media.url.replace('Hero.cms-image.media.png', 'other.png');
      if (kind === 'mime') media.source.mimeType = 'image/jpeg';
      await failure(
        f.run(),
        /Lost response|Malformed|invalid native|mismatch|Incomplete|single|Read failed|disagreement|Unsupported|size|MIME|length|hash|signature|byte cap|byte count/u,
      );
      expect(f.posts()).to.equal(1);
      const journal = await f.journal();
      expect(journal.state).to.equal('ownership-uncertain');
      expect(journal.operations[0].state).to.equal('pending');
      expect(journal.createdParents).to.have.length(0);
      if (['lost', 'partial-one', 'partial-two'].includes(kind)) {
        expect(journal.operations[0].result).to.equal(undefined);
      } else {
        expect(journal.operations[0].result?.contentId).to.equal(contentId);
      }
    });
  it('retains parsed identities when result persistence fails', async () => {
    const f = await fixture();
    await failure(
      f.run(async (file, report) => {
        if (report.operations[0].result) throw new Error('Result unavailable');
        await rewriteAtomic(file, report);
      }),
      /could not be persisted/u,
    );
    expect(f.posts()).to.equal(1);
    expect(await f.journal().then((report) => report.operations[0].state)).to.equal('pending');
  });
  it('does not report success if completion persistence fails', async () => {
    const f = await fixture();
    await downloaded(f);
    await failure(
      f.run(async (file, report) => {
        if (report.state === 'completed') throw new Error('Completion unavailable');
        await rewriteAtomic(file, report);
      }),
      /Completion unavailable/u,
    );
    expect(f.posts()).to.equal(1);
    expect(await f.journal().then((report) => report.state)).to.equal('ownership-uncertain');
    expect(await f.journal().then((report) => report.operations[0].result?.contentId)).to.equal(
      contentId,
    );
  });
});
