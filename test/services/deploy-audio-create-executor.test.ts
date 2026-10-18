import { expect } from 'chai';
import type { Connection } from '@salesforce/core';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import sinon from 'sinon';
import { executeDeployAudioCreate } from '../../src/services/deploy-audio-create-executor.js';
import { buildAudioCreateMultipart } from '../../src/transport/multipart-image-create.js';
import {
  rewriteAtomic,
  type WorkspaceImportRunReport,
} from '../../src/services/import-workspace.js';
import type { JsonRequestOptions } from '../../src/transport/json-request.js';

const workspaceId = '0Zu000000000001AAA';
const contentId = '20Y000000000001AAA';
const variantId = '9Ps000000000001AAA';
type Row = Record<string, unknown>;
async function fixture(large = false) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'cms-audio-executor-'));
  const fileName = 'Sound.cms-audio.media.mp3';
  const companion = path.join(directory, fileName);
  // Mock-only opaque non-WAV data, including above the revoked Document-local cap.
  const bytes = large ? Buffer.alloc(10 * 1024 * 1024 + 1, 163) : Buffer.from([0, 255, 3, 0x80, 4]);
  const definition = {
    contract: 'sf-cms-media-source',
    contractVersion: '1.0.0',
    identity: {
      family: 'cms',
      type: 'Audio',
      apiName: 'Sound',
      context: { workspaceApiName: 'Source' },
    },
    contentType: 'sfdc_cms__audio',
    language: 'en_US',
    folderPath: [],
    title: 'Sound audio',
    urlName: 'sound-audio',
    media: {
      representation: 'binary',
      mimeType: 'audio/mpeg',
      companion: { role: 'media', path: fileName },
    },
  };
  const input = {
    definitionFile: path.join(directory, 'Sound.cms-audio.json'),
    workspaceId,
    language: 'en_US',
    expectedRootFolderId: 'root',
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
    ContentTypeFullyQualifiedName: 'sfdc_cms__audio',
    Language: 'en_US',
    IsPublished: false,
    ManagedContentVariantStatus: 'Draft',
    IsPrimary: true,
    Name: 'Sound audio',
    UrlName: 'sound-audio',
    ManagedContentKey: 'MCGENERATED',
    ManagedContent: { AuthoredManagedContentSpaceId: workspaceId, ApiName: 'Sound' },
  };
  const media = {
    source: { type: 'file', size: bytes.length, mimeType: 'audio/mpeg' },
    url: `/cms/media/MCGENERATED?version=1&fileHash=${createHash('md5').update(bytes).digest('hex')}&fileName=${fileName}`,
  };
  const detail: Row = {
    managedContentId: contentId,
    managedContentVariantId: variantId,
    contentKey: 'MCGENERATED',
    apiName: 'Sound',
    title: 'Sound audio',
    urlName: 'sound-audio',
    contentType: { fullyQualifiedName: 'sfdc_cms__audio' },
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
  let version = '67.0';
  let collision = false;
  let transportError: Error | undefined;
  let afterPost: (() => void) | undefined;
  let onDetail: (() => void) | undefined;
  let extra: Row[] = [];
  const journal = async () =>
    JSON.parse(await readFile(input.reportFile, 'utf8')) as WorkspaceImportRunReport;
  const connection = {
    _refreshDelegate: () => {
      throw new Error('Replay forbidden');
    },
    getApiVersion: () => version,
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
          expect(payload.contentType).to.equal('sfdc_cms__audio');
          expect(payload.contentBody.binary.mediaSha256).to.equal(
            createHash('sha256').update(bytes).digest('hex'),
          );
          expect(payload.contentBody.binary.sourceSha256).to.equal(intent.sourceManifestSha256);
          expect(payload.contentBody.binding.definition).to.deep.equal(definition);
          expect(payload.contentBody.binding.apiVersion).to.equal('67.0');
          expect(payload.contentBody.binding.workspace).to.deep.equal(workspace);
          expect(payload.contentBody.binding.inventory).to.include({
            complete: true,
            workspaceId,
            apiVersion: '67.0',
          });
          expect(payload.contentBody.binding.inventory.records).to.deep.equal([]);
          const boundary = request.body!.toString('ascii').split('\r\n')[0].slice(2);
          const expected = buildAudioCreateMultipart(
            {
              apiName: payload.apiName,
              title: payload.title,
              urlName: payload.urlName,
              contentSpaceOrFolderId: payload.contentSpaceOrFolderId,
            },
            fileName,
            bytes,
            { mimeType: 'audio/mpeg', boundaryFactory: () => boundary },
          );
          expect(request.body!.equals(expected.body)).to.equal(true);
          afterPost?.();
          if (transportError) throw transportError;
          return structuredClone(response);
        }
        expect(request.method).to.equal('GET');
        if (url.pathname.includes('/spaces/')) return structuredClone(workspace);
        if (url.pathname.endsWith('/query')) {
          const q = url.searchParams.get('q')!;
          const rows = posts || collision ? [row, ...extra] : [];
          let records: Row[] = q.includes('Id >') ? [] : rows;
          if (q.includes('COUNT(Id)'))
            records = rows.map(() => ({ ManagedContentId: contentId, siblingCount: rows.length }));
          return { records: structuredClone(records), totalSize: records.length, done: true };
        }
        const durable = await journal();
        expect(durable.operations[0].result?.contentId).to.equal(contentId);
        onDetail?.();
        return structuredClone(detail);
      })();
      const stream = new PassThrough();
      stream.on('error', () => {});
      return Object.assign(result, { stream: () => stream });
    },
  } as unknown as Pick<Connection, 'request' | 'getApiVersion'> &
    Partial<Pick<Connection, 'accessToken' | 'instanceUrl' | 'version'>>;
  Object.defineProperties(connection, {
    accessToken: { get: () => (posts ? 'test-token' : undefined) },
    instanceUrl: { get: () => (posts ? 'https://example.invalid' : undefined) },
  });
  return {
    connection,
    input,
    definition,
    bytes,
    companion,
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
    setVersion: (value: string) => {
      version = value;
    },
    failTransport: (error: Error) => {
      transportError = error;
    },
    afterPost: (callback: () => void) => {
      afterPost = callback;
    },
    onDetail: (callback: () => void) => {
      onDetail = callback;
    },
    siblings: () => {
      extra = [{ ...row, Id: '9Ps000000000002AAA', Language: 'de_DE', IsPrimary: false }];
    },
    run: (
      rewrite: (file: string, report: WorkspaceImportRunReport) => Promise<void> = rewriteAtomic,
      before?: () => Promise<void>,
      options: JsonRequestOptions = {},
    ) => executeDeployAudioCreate(connection, input, options, { rewrite }, before),
  };
}
async function failure(promise: Promise<unknown>, pattern = /./u) {
  try {
    await promise;
  } catch (error) {
    expect((error as Error).message).to.match(pattern);
    return;
  }
  throw new Error('Expected rejection');
}

describe('private journaled Audio CREATE executor', () => {
  afterEach(() => sinon.restore());
  for (const large of [false, true])
    it(`completes exact journal-bound multipart and independent bytes (large mock ${large})`, async () => {
      const f = await fixture(large);
      const download = sinon
        .stub(globalThis, 'fetch')
        .callsFake(
          async () => new Response(f.bytes, { headers: { 'content-type': 'audio/mpeg' } }),
        );
      const result = await f.run();
      expect(result.qualification).to.equal('unqualified');
      expect(result.report.state).to.equal('completed');
      expect(result.report.operations[0].state).to.equal('succeeded');
      expect(result.report.createdParents).to.deep.equal([
        { contentId, contentKey: 'MCGENERATED', primaryVariantId: variantId, childVariantIds: [] },
      ]);
      expect(await f.journal()).to.deep.equal(result.report);
      expect(f.posts()).to.equal(1);
      expect(download.calledOnce).to.equal(true);
      await failure(f.run());
      expect(f.posts()).to.equal(1);
    });
  it('detaches caller input and options before awaiting the boundary', async () => {
    const f = await fixture();
    sinon
      .stub(globalThis, 'fetch')
      .callsFake(async () => new Response(f.bytes, { headers: { 'content-type': 'audio/mpeg' } }));
    const options: JsonRequestOptions = {};
    const result = await executeDeployAudioCreate(
      f.connection,
      f.input,
      options,
      undefined,
      async () => {
        f.input.workspaceId = '0Zu000000000002AAA';
        f.input.language = 'de_DE';
        f.input.destinationOrgId = 'bad';
        options.signal = AbortSignal.abort();
      },
    );
    expect(result.report.destinationWorkspaceId).to.equal(workspaceId);
    expect(result.report.destinationOrgId).to.equal('00D000000000001AAA');
    expect(result.report.state).to.equal('completed');
    expect(f.posts()).to.equal(1);
  });
  it('does not return completion before the final persistence promise resolves', async () => {
    const f = await fixture();
    sinon
      .stub(globalThis, 'fetch')
      .callsFake(async () => new Response(f.bytes, { headers: { 'content-type': 'audio/mpeg' } }));
    let release!: () => void;
    let reached!: () => void;
    let resolved = false;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reachedCompletion = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const running = f
      .run(async (file, report) => {
        if (report.state === 'completed') {
          reached();
          await gate;
        }
        await rewriteAtomic(file, report);
      })
      .then((result) => {
        resolved = true;
        return result;
      });
    await reachedCompletion;
    const pending = await f.journal();
    expect(pending.state).to.equal('ownership-uncertain');
    expect(resolved).to.equal(false);
    release();
    const result = await running;
    expect(result.report.state).to.equal('completed');
    expect(await f.journal()).to.deep.equal(result.report);
  });
  it('refuses invalid org provenance before any journal or POST', async () => {
    const f = await fixture();
    f.input.destinationOrgId = 'bad';
    await failure(f.run(), /org ID/u);
    expect(f.posts()).to.equal(0);
    await failure(f.journal(), /ENOENT/u);
  });
  it('never resumes or overwrites an existing journal', async () => {
    const f = await fixture();
    await writeFile(f.input.reportFile, 'existing');
    await failure(f.run(), /EEXIST/u);
    expect(await readFile(f.input.reportFile, 'utf8')).to.equal('existing');
    expect(f.posts()).to.equal(0);
  });
  it('does not POST if intent persistence rejects', async () => {
    const f = await fixture();
    await failure(
      f.run(async () => {
        throw new Error('Disk unavailable');
      }),
      /Disk unavailable/u,
    );
    expect(f.posts()).to.equal(0);
    const journal = await f.journal();
    expect(journal.state).to.equal('applying');
  });
  for (const change of [
    'definition',
    'bytes',
    'MIME',
    'filename',
    'workspace',
    'root',
    'language',
    'version',
    'inventory',
    'journal',
    'cancel',
    'callback',
  ])
    it(`rejects prewrite ${change} drift with zero POST`, async () => {
      const f = await fixture();
      const controller = new AbortController();
      await failure(
        f.run(
          rewriteAtomic,
          async () => {
            expect(f.posts()).to.equal(0);
            const journal = await f.journal();
            expect(journal.operations[0].state).to.equal('pending');
            if (change === 'definition') f.definition.title = 'Changed';
            if (change === 'bytes') await writeFile(f.companion, Buffer.from([4, 3, 2, 1, 0]));
            if (change === 'MIME') f.definition.media.mimeType = 'audio/ogg';
            if (change === 'filename') {
              f.definition.media.companion.path = 'other.mp3';
              await writeFile(path.join(path.dirname(f.companion), 'other.mp3'), f.bytes);
            }
            if (['definition', 'MIME', 'filename'].includes(change))
              await writeFile(f.input.definitionFile, JSON.stringify(f.definition));
            if (change === 'workspace') f.workspace.apiName = 'Other';
            if (change === 'root') f.workspace.rootFolderId = 'other';
            if (change === 'language') f.workspace.defaultLanguage = 'de_DE';
            if (change === 'version') f.setVersion('66.0');
            if (change === 'inventory') f.collide();
            if (change === 'journal') await writeFile(f.input.reportFile, '{}');
            if (change === 'cancel') controller.abort();
            if (change === 'callback') throw new Error('Boundary rejected');
          },
          { signal: controller.signal },
        ),
      );
      expect(f.posts()).to.equal(0);
    });
  it('awaits the resolved intent promise before the callback or POST', async () => {
    const f = await fixture();
    let first = true;
    let release!: () => void;
    let reached!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const callback = sinon.stub().rejects(new Error('Stop after durable boundary'));
    const running = f.run(async (file, report) => {
      await rewriteAtomic(file, report);
      if (first) {
        first = false;
        reached();
        await gate;
      }
    }, callback);
    await started;
    expect(callback.called).to.equal(false);
    expect(f.posts()).to.equal(0);
    release();
    await failure(running, /Stop after durable boundary/u);
    expect(callback.calledOnce).to.equal(true);
  });
  it('reacquires source after the persistence boundary', async () => {
    const f = await fixture();
    let first = true;
    await failure(
      f.run(async (file, report) => {
        await rewriteAtomic(file, report);
        if (first) {
          first = false;
          await writeFile(f.companion, 'Changed');
        }
      }),
      /drifted/u,
    );
    expect(f.posts()).to.equal(0);
  });
  for (const kind of [
    'socket',
    '401',
    '429',
    'cancel',
    'partial-parent',
    'partial-key',
    'partial-variant',
    'invalid-id',
    'siblings',
    'type',
    'metadata',
    'published',
    'status',
    'primary',
    'language',
    'root',
    'MIME',
    'filename',
    'hash',
    'size',
    'bytes',
    'download',
    'variant-drift',
    'workspace-drift',
    'version-drift',
    'result-persistence',
    'completion-persistence',
  ])
    it(`retains conservative evidence without replay after ${kind}`, async () => {
      const f = await fixture();
      const controller = new AbortController();
      sinon.stub(globalThis, 'fetch').callsFake(async () => {
        if (kind === 'download') throw new Error('Download failed');
        if (kind === 'workspace-drift') f.workspace.apiName = 'Other';
        if (kind === 'variant-drift') f.detail.title = 'Changed during download';
        if (kind === 'version-drift') f.setVersion('66.0');
        return new Response(kind === 'bytes' ? Buffer.from([1, 2, 3, 4, 5]) : f.bytes, {
          headers: { 'content-type': 'audio/mpeg' },
        });
      });
      if (['socket', '401', '429'].includes(kind))
        f.failTransport(Object.assign(new Error(kind), { statusCode: Number(kind) || undefined }));
      if (kind === 'cancel') f.afterPost(() => controller.abort());
      if (kind === 'partial-parent') {
        delete f.response.contentKey;
        delete f.response.managedContentVariantId;
      }
      if (kind === 'partial-key') {
        delete f.response.managedContentId;
        delete f.response.managedContentVariantId;
      }
      if (kind === 'partial-variant') {
        delete f.response.managedContentId;
        delete f.response.contentKey;
      }
      if (kind === 'invalid-id') f.response.managedContentId = 'invalid';
      // Apply destination mutations only after preflight and POST intent inspection.
      f.afterPost(() => {
        if (kind === 'cancel') controller.abort();
        if (kind === 'siblings') f.siblings();
        if (kind === 'type') f.row.ContentTypeFullyQualifiedName = 'sfdc_cms__image';
        if (kind === 'metadata') f.detail.title = 'Other';
        if (kind === 'published') f.row.IsPublished = true;
        if (kind === 'status') f.row.ManagedContentVariantStatus = 'Published';
        if (kind === 'primary') f.row.IsPrimary = false;
        if (kind === 'language') f.row.Language = 'de_DE';
        if (kind === 'root') f.detail.folder = { id: 'other' };
        if (kind === 'MIME') f.media.source.mimeType = 'audio/ogg';
        if (kind === 'filename')
          f.media.url = f.media.url.replace('Sound.cms-audio.media.mp3', 'other.mp3');
        if (kind === 'hash')
          f.media.url = f.media.url.replace(/fileHash=[^&]+/u, `fileHash=${'0'.repeat(32)}`);
        if (kind === 'size') f.media.source.size += 1;
      });
      await failure(
        f.run(
          async (file, report) => {
            if (kind === 'result-persistence' && report.operations[0].result)
              throw new Error('Result persistence failed');
            if (kind === 'completion-persistence' && report.state === 'completed')
              throw new Error('Completion persistence failed');
            await rewriteAtomic(file, report);
          },
          undefined,
          { signal: controller.signal },
        ),
      );
      expect(f.posts()).to.equal(1);
      const journal = await f.journal();
      expect(journal.state).to.equal(
        kind === 'result-persistence' ? 'applying' : 'ownership-uncertain',
      );
      expect(journal.operations[0].state).to.equal('pending');
      expect(journal.createdParents).to.have.length(kind === 'completion-persistence' ? 1 : 0);
      if (kind.startsWith('partial-')) {
        const expected: Row = {};
        if (kind === 'partial-parent') expected.contentId = contentId;
        if (kind === 'partial-key') expected.contentKey = 'MCGENERATED';
        if (kind === 'partial-variant') expected.primaryVariantId = variantId;
        expect(journal.operations[0].result).to.deep.equal(expected);
      }
      if (kind === 'completion-persistence')
        expect(journal.createdParents[0].primaryVariantId).to.equal(variantId);
      await failure(f.run());
      expect(f.posts()).to.equal(1);
    });
});
