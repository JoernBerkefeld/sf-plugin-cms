import { expect } from 'chai';
import type { Connection } from '@salesforce/core';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import sinon from 'sinon';
import { executeDeployDocumentCreate } from '../../src/services/deploy-document-create-executor.js';
import { executeDeployBatchDocumentItem } from '../../src/services/deploy-batch-executor.js';
import { preflightDeployBatch } from '../../src/services/deploy-batch-preflight.js';
import { buildDocumentCreateMultipart } from '../../src/transport/multipart-image-create.js';
import {
  rewriteAtomic,
  type WorkspaceImportRunReport,
} from '../../src/services/import-workspace.js';

const workspaceId = '0Zu000000000001AAA';
const contentId = '20Y000000000001AAA';
const variantId = '9Ps000000000001AAA';
type Row = Record<string, unknown>;
async function fixture(opaque = false, rejected = false) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'cms-document-executor-'));
  const mimeType = opaque ? 'application/pdf' : 'text/plain';
  const fileName = opaque ? 'Guide.cms-document.media.pdf' : 'Guide.cms-document.media.txt';
  const companion = path.join(directory, fileName);
  const bytes = opaque
    ? Buffer.alloc(10 * 1024 * 1024 + 1, 255)
    : Buffer.from('Grüße 世界\r\nDocument\n');
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
    folderPath: [],
    title: 'Guide document',
    urlName: 'guide-document',
    media: {
      representation: 'binary',
      mimeType,
      companion: { role: 'media', path: fileName },
    },
  };
  const input = {
    definitionFile: path.join(directory, 'Guide.cms-document.json'),
    workspaceId,
    language: 'en_US',
    destinationOrgId: '00D000000000001AAA',
    reportFile: path.join(directory, 'run.json'),
  };
  await writeFile(input.definitionFile, JSON.stringify(definition));
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
    source: { type: 'file', size: bytes.length, mimeType },
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
  const response: Row = {
    managedContentId: contentId,
    managedContentVariantId: variantId,
    contentKey: 'MCGENERATED',
  };
  let posts = 0;
  let collision = false;
  let lost = false;
  const journal = async () =>
    JSON.parse(await readFile(input.reportFile, 'utf8')) as WorkspaceImportRunReport;
  const connection = {
    _refreshDelegate: () => {
      throw new Error('Replay forbidden');
    },
    getApiVersion: () => '67.0',
    request(
      this: { _refreshDelegate?: unknown },
      request: { method: string; url: string; body?: Buffer },
      options: { retry?: { maxRetries: number } },
    ) {
      const result = (async () => {
        const url = new URL(request.url, 'https://example.invalid');
        if (request.method === 'POST') {
          posts += 1;
          expect(this._refreshDelegate).to.equal(undefined);
          expect(options.retry?.maxRetries).to.equal(0);
          const intent = await journal();
          const operation = intent.operations[0];
          expect(operation.state).to.equal('pending');
          expect(operation.requestSha256).to.equal(
            createHash('sha256').update(operation.requestIdentity).digest('hex'),
          );
          const payload = JSON.parse(operation.requestIdentity.split('\u0000')[3]);
          expect(payload.contentBody.binary.mediaSha256).to.equal(
            createHash('sha256').update(bytes).digest('hex'),
          );
          expect(payload.contentBody.binary.sourceSha256).to.equal(intent.sourceManifestSha256);
          const boundary = request.body!.toString('ascii').split('\r\n')[0].slice(2);
          const expected = buildDocumentCreateMultipart(
            {
              apiName: payload.apiName,
              title: payload.title,
              urlName: payload.urlName,
              contentSpaceOrFolderId: payload.contentSpaceOrFolderId,
            },
            fileName,
            bytes,
            { boundaryFactory: () => boundary, mimeType },
          );
          expect(request.body!.equals(expected.body)).to.equal(true);
          expect(request.body!.includes(Buffer.from(`Content-Type: ${mimeType}\r\n`))).to.equal(
            true,
          );
          if (rejected)
            throw Object.assign(new Error('Native Document format rejected'), { statusCode: 415 });
          if (lost) throw new Error('Lost response');
          return structuredClone(response);
        }
        expect(request.method).to.equal('GET');
        if (url.pathname.includes('/spaces/')) return structuredClone(workspace);
        if (url.pathname.endsWith('/query')) {
          const q = url.searchParams.get('q')!;
          const rows = posts || collision ? [row] : [];
          let records: Row[] = q.includes('Id >') ? [] : rows;
          if (q.includes('COUNT(Id)'))
            records = rows.map(() => ({ ManagedContentId: contentId, siblingCount: 1 }));
          return { records: structuredClone(records), totalSize: records.length, done: true };
        }
        const durable = await journal();
        expect(durable.operations[0].result?.contentId).to.equal(contentId);
        return structuredClone(detail);
      })();
      return Object.assign(result, { stream: () => new PassThrough() });
    },
  } as unknown as Pick<Connection, 'request' | 'getApiVersion'> &
    Partial<Pick<Connection, 'accessToken' | 'instanceUrl'>>;
  Object.defineProperties(connection, {
    accessToken: { get: () => (posts ? 'test-token' : undefined) },
    instanceUrl: { get: () => (posts ? 'https://example.invalid' : undefined) },
  });
  return {
    connection,
    input,
    bytes,
    companion,
    definition,
    workspace,
    row,
    detail,
    media,
    response,
    journal,
    posts: () => posts,
    collide: () => {
      collision = true;
    },
    lose: () => {
      lost = true;
    },
    run: (
      rewrite: (file: string, report: WorkspaceImportRunReport) => Promise<void> = rewriteAtomic,
      before?: () => Promise<void>,
      options = {},
    ) => executeDeployDocumentCreate(connection, input, options, { rewrite }, before),
  };
}
async function failure(promise: Promise<unknown>, pattern: RegExp) {
  try {
    await promise;
  } catch (error) {
    expect((error as Error).message).to.match(pattern);
    return;
  }
  throw new Error('Expected rejection');
}

describe('journaled portable Document CREATE executor', () => {
  afterEach(() => sinon.restore());
  for (const rejected of [false, true])
    it(`preserves >10 MiB opaque PDF through fresh CREATE preflight and transport (rejected=${rejected})`, async () => {
      const f = await fixture(true, rejected);
      sinon.stub(globalThis, 'fetch').resolves(
        new Response(f.bytes, {
          headers: { 'content-type': 'application/pdf' },
        }),
      );
      const planned = await preflightDeployBatch(f.connection, {
        sources: { 'source-dir': [f.input.definitionFile] },
        workspaceId,
        language: 'en_US',
      });
      expect(planned.items[0].proposed).to.equal('create');
      const invoke = () =>
        executeDeployBatchDocumentItem(f.connection, f.input, 'create', async () => {});
      if (rejected) {
        const error = await invoke().catch((error_: unknown) => error_);
        expect(error).to.have.property('message', 'Native Document format rejected');
        expect(error).to.have.property('status', 415);
        expect(await f.journal().then((report) => report.state)).to.equal('ownership-uncertain');
      } else {
        expect(await invoke().then((result) => result.outcome)).to.equal('created');
        expect(await f.journal().then((report) => report.state)).to.equal('completed');
      }
      expect(f.posts()).to.equal(1);
      await failure(invoke(), /collision|exist/u);
      expect(f.posts()).to.equal(1);
    });
  it('routes private batch CREATE through fresh callbacks and the existing exclusive journal', async () => {
    const f = await fixture();
    sinon
      .stub(globalThis, 'fetch')
      .resolves(new Response(f.bytes, { headers: { 'content-type': 'text/plain' } }));
    let callbacks = 0;
    const result = await executeDeployBatchDocumentItem(
      f.connection,
      f.input,
      'create',
      async () => {
        callbacks += 1;
        expect(f.posts()).to.equal(0);
        if (callbacks === 2) {
          const journal = await f.journal();
          expect(journal.operations[0].state).to.equal('pending');
        }
      },
    );
    expect(callbacks).to.equal(2);
    expect(result).to.deep.equal({ target: { contentId, variantId }, outcome: 'created' });
    expect(f.posts()).to.equal(1);
    const journal = await f.journal();
    expect(journal.state).to.equal('completed');
  });
  for (const operation of ['blocked'] as const)
    it(`rejects private batch ${operation} without callbacks, journals or Image fallback`, async () => {
      const f = await fixture();
      const boundary = sinon.stub().resolves();
      await failure(
        executeDeployBatchDocumentItem(f.connection, f.input, operation, boundary),
        /Blocked Document operation/u,
      );
      expect(boundary.called).to.equal(false);
      expect(f.posts()).to.equal(0);
      await failure(f.journal(), /ENOENT/u);
    });
  for (const callback of [1, 2])
    it(`stops private batch CREATE when callback ${callback} rejects`, async () => {
      const f = await fixture();
      let calls = 0;
      await failure(
        executeDeployBatchDocumentItem(f.connection, f.input, 'create', async () => {
          calls += 1;
          if (calls === callback) throw new Error('Boundary rejected');
        }),
        /Boundary rejected/u,
      );
      expect(f.posts()).to.equal(0);
      if (callback === 1) await failure(f.journal(), /ENOENT/u);
      else {
        const journal = await f.journal();
        expect(journal.state).to.equal('failed');
      }
    });
  it('retains independently verified ownership without returning success after batch completion persistence fails', async () => {
    const f = await fixture();
    sinon
      .stub(globalThis, 'fetch')
      .resolves(new Response(f.bytes, { headers: { 'content-type': 'text/plain' } }));
    await failure(
      executeDeployBatchDocumentItem(
        f.connection,
        f.input,
        'create',
        async () => {},
        {},
        {
          rewrite: async (file, report) => {
            if (report.state === 'completed') throw new Error('Completion disk failed');
            await rewriteAtomic(file, report);
          },
        },
      ),
      /Completion disk failed/u,
    );
    const journal = await f.journal();
    expect(journal.state).to.equal('ownership-uncertain');
    expect(journal.operations[0].state).to.equal('pending');
    expect(journal.createdParents[0].contentId).to.equal(contentId);
    expect(f.posts()).to.equal(1);
  });
  it('never overwrites or resumes an existing journal', async () => {
    const f = await fixture();
    await writeFile(f.input.reportFile, 'existing');
    await failure(f.run(), /EEXIST/u);
    expect(f.posts()).to.equal(0);
    expect(await readFile(f.input.reportFile, 'utf8')).to.equal('existing');
  });
  it('does not mutate if durable intent persistence fails', async () => {
    const f = await fixture();
    await failure(
      f.run(async () => {
        throw new Error('Disk failed');
      }),
      /Disk failed/u,
    );
    expect(f.posts()).to.equal(0);
    const journal = await f.journal();
    expect(journal.state).to.equal('applying');
  });
  for (const change of ['bytes', 'root', 'collision', 'journal', 'reject', 'cancel'])
    it(`blocks ${change} at the awaited callback boundary`, async () => {
      const f = await fixture();
      const controller = new AbortController();
      await failure(
        f.run(
          rewriteAtomic,
          async () => {
            expect(f.posts()).to.equal(0);
            const intent = await f.journal();
            expect(intent.operations[0].state).to.equal('pending');
            if (change === 'bytes') await writeFile(f.companion, 'Changed');
            if (change === 'root') f.workspace.rootFolderId = 'other';
            if (change === 'collision') f.collide();
            if (change === 'journal') await writeFile(f.input.reportFile, '{}');
            if (change === 'reject') throw new Error('Boundary rejected');
            if (change === 'cancel') controller.abort();
          },
          { signal: controller.signal },
        ),
        /drifted|collision|intent changed|Boundary rejected|cancelled|abort/iu,
      );
      expect(f.posts()).to.equal(0);
    });
  it('completes only after exact multipart intent and independent native UTF-8 byte ownership', async () => {
    const f = await fixture();
    const download = sinon
      .stub(globalThis, 'fetch')
      .callsFake(async () => new Response(f.bytes, { headers: { 'content-type': 'text/plain' } }));
    const result = await f.run();
    expect(result.qualification).to.equal('unqualified');
    expect(result.report.state).to.equal('completed');
    expect(result.report.operations[0].state).to.equal('succeeded');
    expect(await f.journal()).to.deep.equal(result.report);
    expect(f.posts()).to.equal(1);
    expect(download.calledOnce).to.equal(true);
    expect(await readFile(f.companion)).to.deep.equal(f.bytes);
    await failure(f.run(), /collision|EEXIST/u);
    expect(f.posts()).to.equal(1);
  });
  for (const kind of [
    'lost',
    'invalid',
    'inventory',
    'metadata',
    'filename',
    'mime',
    'bytes',
    'result-persistence',
    'completion-persistence',
  ])
    it(`retains conservative uncertainty without replay after ${kind}`, async () => {
      const f = await fixture();
      sinon.stub(globalThis, 'fetch').callsFake(
        async () =>
          new Response(kind === 'bytes' ? Buffer.from('Changed') : f.bytes, {
            headers: { 'content-type': 'text/plain' },
          }),
      );
      if (kind === 'lost') f.lose();
      if (kind === 'invalid') f.response.managedContentId = 'invalid';
      if (kind === 'inventory') f.row.IsPublished = true;
      if (kind === 'metadata') f.detail.title = 'Wrong';
      if (kind === 'filename')
        f.media.url = f.media.url.replace('Guide.cms-document.media.txt', 'other.txt');
      if (kind === 'mime') f.media.source.mimeType = 'application/pdf';
      await failure(
        f.run(async (file, report) => {
          if (kind === 'result-persistence' && report.operations[0].result)
            throw new Error('Result persistence unavailable');
          if (kind === 'completion-persistence' && report.state === 'completed')
            throw new Error('Completion persistence unavailable');
          await rewriteAtomic(file, report);
        }),
        /Lost response|invalid native|mismatch|disagreement|MIME|hash|size|length|byte|persist|Unsupported/iu,
      );
      expect(f.posts()).to.equal(1);
      const journal = await f.journal();
      expect(journal.state).to.equal(
        kind === 'result-persistence' ? 'applying' : 'ownership-uncertain',
      );
      expect(journal.operations[0].state).to.equal('pending');
      expect(journal.createdParents).to.have.length(kind === 'completion-persistence' ? 1 : 0);
      if (kind === 'completion-persistence') {
        expect(journal.createdParents[0].contentId).to.equal(contentId);
        expect(journal.createdParents[0].primaryVariantId).to.equal(variantId);
      }
      if (!['lost', 'result-persistence'].includes(kind))
        expect(journal.operations[0].result?.contentKey).to.equal('MCGENERATED');
      await failure(f.run(), /collision|EEXIST/u);
      expect(f.posts()).to.equal(1);
    });
  it('reacquires local bytes after the durable-intent persistence boundary', async () => {
    const f = await fixture();
    let changed = false;
    await failure(
      f.run(async (file, report) => {
        await rewriteAtomic(file, report);
        if (!changed) {
          changed = true;
          await writeFile(f.companion, 'Edited after intent');
        }
      }),
      /drifted/u,
    );
    expect(f.posts()).to.equal(0);
  });
  it('fails closed on a post-write download failure and retains captured identity', async () => {
    const f = await fixture();
    sinon.stub(globalThis, 'fetch').rejects(new Error('Read unavailable'));
    await failure(f.run(), /Read unavailable|download/iu);
    expect(f.posts()).to.equal(1);
    const journal = await f.journal();
    expect(journal.state).to.equal('ownership-uncertain');
    expect(journal.operations[0].result?.contentId).to.equal(contentId);
  });
  it('captures partial raw identity durably before malformed response validation', async () => {
    const f = await fixture();
    delete f.response.managedContentVariantId;
    await failure(f.run(), /Malformed/u);
    expect(f.posts()).to.equal(1);
    const journal = await f.journal();
    expect(journal.state).to.equal('ownership-uncertain');
    expect(journal.operations[0].result).to.deep.equal({ contentId, contentKey: 'MCGENERATED' });
    await failure(f.run(), /collision|EEXIST/u);
    expect(f.posts()).to.equal(1);
  });
});
