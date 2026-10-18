import { expect } from 'chai';
import { Connection as JsforceConnection } from '@jsforce/jsforce-node';
import type { Connection } from '@salesforce/core';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import sinon from 'sinon';
import { executeDeployAudioUpdate } from '../../src/services/deploy-audio-update-executor.js';
import {
  rewriteAtomic,
  type WorkspaceImportRunReport,
} from '../../src/services/import-workspace.js';
import { buildAudioUpdateMultipart } from '../../src/transport/multipart-audio-update.js';
import type { JsonRequestOptions } from '../../src/transport/json-request.js';

const workspaceId = '0Zu000000000001AAA';
const contentId = '20Y000000000001AAA';
const variantId = '9Ps000000000001AAA';
const mimeType = 'application/x-future-audio';
type Row = Record<string, unknown>;
const hash = (bytes: Buffer, algorithm = 'sha256') =>
  createHash(algorithm).update(bytes).digest('hex');

async function fixture(urlName?: string, large = false) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'cms-audio-update-executor-'));
  const fileName = 'Sound.cms-audio.media.bin';
  const bytes = large
    ? Buffer.alloc(10 * 1024 * 1024 + 1, 163)
    : Buffer.from([0, 255, 128, 13, 10, 1]);
  const current = Buffer.from([255, 0, 129, 1]);
  const companion = path.join(directory, fileName);
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
    title: 'Opaque sound',
    ...(urlName === undefined ? {} : { urlName }),
    media: { representation: 'binary', mimeType, companion: { role: 'media', path: fileName } },
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
    Name: definition.title,
    UrlName: urlName ?? null,
    ManagedContentKey: 'MCGENERATED',
    ManagedContent: { AuthoredManagedContentSpaceId: workspaceId, ApiName: 'Sound' },
  };
  const media = {
    source: { type: 'file', size: current.length, mimeType },
    url: `/cms/media/MCGENERATED?version=1&fileHash=${hash(current, 'md5')}&fileName=${fileName}`,
  };
  const detail: Row = {
    managedContentId: contentId,
    managedContentVariantId: variantId,
    contentKey: 'MCGENERATED',
    apiName: 'Sound',
    title: definition.title,
    ...(urlName === undefined ? {} : { urlName }),
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
    language: 'en_US',
    isPublished: false,
    contentBody: {},
  };
  let puts = 0;
  let transportError: Error | undefined;
  let afterPut: (() => void) | undefined;
  let downloadCount = 0;
  let apiVersion = '67.0';
  let getCount = 0;
  let beforeGet: ((url: URL) => Promise<void> | void) | undefined;
  let download: (() => Response) | undefined;
  let rawResponse: unknown;
  let replaceResponse = false;
  const siblings: Row[] = [];
  let siblingCount = 1;
  let dispatchError: Error | undefined;
  const journal = async () =>
    JSON.parse(await readFile(input.reportFile, 'utf8')) as WorkspaceImportRunReport;
  const connection = {
    _refreshDelegate: () => {
      throw new Error('Replay forbidden');
    },
    version: '67.0',
    getApiVersion: () => apiVersion,
    request(
      this: { _refreshDelegate?: unknown },
      request: { method: string; url: string; body?: Buffer },
      options: { retry?: { maxRetries: number } },
    ) {
      if (request.method === 'PUT' && dispatchError) {
        puts += 1;
        throw dispatchError;
      }
      const result = (async () => {
        const url = new URL(request.url, 'https://example.invalid');
        if (request.method === 'PUT') {
          puts += 1;
          expect(url.pathname).to.equal(
            `/services/data/v67.0/connect/cms/contents/variants/${variantId}`,
          );
          expect(this._refreshDelegate).to.equal(undefined);
          expect(options.retry?.maxRetries).to.equal(0);
          const intent = await journal();
          expect(intent.createdParents).to.deep.equal([]);
          const operation = intent.operations[0];
          expect(operation.operationKind).to.equal('update-variant');
          expect(operation.state).to.equal('pending');
          expect(operation.requestSha256).to.equal(hash(Buffer.from(operation.requestIdentity)));
          const binding = JSON.parse(operation.requestIdentity.split('\u0000')[3]).contentBody;
          expect(binding.desired.definition).to.deep.equal(definition);
          expect(binding.desired.bytesBase64).to.equal(bytes.toString('base64'));
          expect(binding.desired.fileName).to.equal(fileName);
          expect(binding.desired.mimeType).to.equal(mimeType);
          expect(binding.sourceSha256).to.equal(intent.sourceManifestSha256);
          expect(binding.mediaSha256).to.equal(hash(bytes));
          expect(binding.destination.mediaSha256).to.equal(hash(current));
          expect(binding.destination.companions[0].bytesBase64).to.equal(
            current.toString('base64'),
          );
          expect(binding.destination.inventory).to.include({
            complete: true,
            workspaceId,
            apiVersion: '67.0',
          });
          expect(binding.destination.inventory.records).to.deep.equal([row]);
          expect(binding.destination.workspace).to.deep.equal(workspace);
          expect(binding).to.include({
            contentId,
            variantId,
            contentKey: 'MCGENERATED',
            rootFolderId: 'root',
            language: 'en_US',
            apiVersion: '67.0',
          });
          const boundary = request.body!.toString('ascii').split('\r\n')[0].slice(2);
          const expected = buildAudioUpdateMultipart(
            { title: definition.title, ...(urlName === undefined ? {} : { urlName }) },
            fileName,
            bytes,
            { mimeType, boundaryFactory: () => boundary },
          );
          expect(request.body!.equals(expected.body)).to.equal(true);
          expect(expected.input).not.to.have.property('apiName');
          media.source.size = bytes.length;
          media.url = `/cms/media/MCGENERATED?version=2&fileHash=${hash(bytes, 'md5')}&fileName=${fileName}`;
          afterPut?.();
          if (transportError) throw transportError;
          return structuredClone(replaceResponse ? rawResponse : response);
        }
        expect(request.method).to.equal('GET');
        getCount += 1;
        await beforeGet?.(url);
        if (url.pathname.includes('/spaces/')) return structuredClone(workspace);
        if (url.pathname.endsWith('/query')) {
          const q = url.searchParams.get('q')!;
          let records: Row[] = q.includes('Id >') ? [] : [row, ...siblings];
          if (q.includes('COUNT(Id)')) records = [{ ManagedContentId: contentId, siblingCount }];
          return { records: structuredClone(records), totalSize: records.length, done: true };
        }
        if (puts) {
          const durable = await journal();
          expect(durable.operations[0].result?.variantId).to.equal(variantId);
        }
        return structuredClone(detail);
      })();
      const stream = new PassThrough();
      stream.on('error', () => {});
      return Object.assign(result, { stream: () => stream });
    },
  } as unknown as Pick<Connection, 'request' | 'getApiVersion'> &
    Partial<Pick<Connection, 'accessToken' | 'instanceUrl' | 'version'>>;
  Object.defineProperties(connection, {
    accessToken: { value: 'test-token' },
    instanceUrl: { value: 'https://example.invalid' },
  });
  sinon.stub(JsforceConnection.prototype, 'request').callsFake(function (
    this: JsforceConnection,
    request,
    options,
  ) {
    return connection.request.call(this, request, options as Parameters<Connection['request']>[1]);
  });
  sinon.stub(globalThis, 'fetch').callsFake(async () => {
    downloadCount += 1;
    return (
      download?.() ??
      new Response(puts ? bytes : current, { headers: { 'content-type': mimeType } })
    );
  });
  return {
    input,
    companion,
    bytes,
    current,
    connection,
    response,
    journal,
    definition,
    detail,
    media,
    row,
    workspace,
    getCount: () => getCount,
    addSibling: (row: Row) => {
      siblings.push(row);
    },
    setSiblingCount: (value: number) => {
      siblingCount = value;
    },
    failDispatch: (error: Error) => {
      dispatchError = error;
    },
    setApiVersion: (value: string) => {
      apiVersion = value;
    },
    beforeGet: (action: (url: URL) => Promise<void> | void) => {
      beforeGet = action;
    },
    download: (action: () => Response) => {
      download = action;
    },
    rawResponse: (value: unknown) => {
      rawResponse = value;
      replaceResponse = true;
    },
    puts: () => puts,
    downloads: () => downloadCount,
    failTransport: (error: Error) => {
      transportError = error;
    },
    afterPut: (action: () => void) => {
      afterPut = action;
    },
    run: (
      rewrite: (file: string, report: WorkspaceImportRunReport) => Promise<void> = rewriteAtomic,
      before?: () => Promise<void>,
      options: JsonRequestOptions = {},
    ) => executeDeployAudioUpdate(connection, input, options, { rewrite }, before),
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

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function assertUncertain(f: Fixture) {
  expect(f.puts()).to.equal(1);
  const report = await f.journal();
  expect(report.state).to.equal('ownership-uncertain');
  expect(report.operations[0].state).to.equal('pending');
  expect(report.createdParents).to.deep.equal([]);
  await failure(f.run());
  expect(f.puts()).to.equal(1);
  return report;
}

describe('private journaled Audio UPDATE executor adversarial matrix', () => {
  afterEach(() => sinon.restore());
  it('accepts mock-only opaque non-WAV bytes above the revoked local cap', async () => {
    const f = await fixture(undefined, true);
    const result = await f.run();
    expect(result.qualification).to.equal('unqualified');
    expect(result.report.state).to.equal('completed');
    expect(f.puts()).to.equal(1);
  });
  for (const kind of ['org', 'aborted'])
    it(`rejects initial ${kind} before journal and requests`, async () => {
      const f = await fixture();
      const controller = new AbortController();
      if (kind === 'org') f.input.destinationOrgId = 'invalid';
      else controller.abort();
      await failure(f.run(rewriteAtomic, undefined, { signal: controller.signal }));
      expect(f.getCount()).to.equal(0);
      expect(f.puts()).to.equal(0);
      await failure(f.journal(), /ENOENT/u);
    });

  const prewrite: Record<string, (f: Fixture) => Promise<void> | void> = {
    title: async (f) => {
      f.definition.title = 'Substituted';
      await writeFile(f.input.definitionFile, JSON.stringify(f.definition));
    },
    url: async (f) => {
      Object.assign(f.definition, { urlName: 'substituted' });
      await writeFile(f.input.definitionFile, JSON.stringify(f.definition));
    },
    language: async (f) => {
      f.definition.language = 'de_DE';
      await writeFile(f.input.definitionFile, JSON.stringify(f.definition));
    },
    root: async (f) => {
      f.definition.folderPath = ['Nested'] as never[];
      await writeFile(f.input.definitionFile, JSON.stringify(f.definition));
    },
    apiName: async (f) => {
      f.definition.identity.apiName = 'Other';
      await writeFile(f.input.definitionFile, JSON.stringify(f.definition));
    },
    mime: async (f) => {
      f.definition.media.mimeType = 'audio/other';
      await writeFile(f.input.definitionFile, JSON.stringify(f.definition));
    },
    filename: async (f) => {
      f.definition.media.companion.path = 'Other.bin';
      await writeFile(f.input.definitionFile, JSON.stringify(f.definition));
    },
    workspace: (f) => {
      f.workspace.apiName = 'Other';
    },
    'workspace root': (f) => {
      f.workspace.rootFolderId = 'other';
    },
    'workspace language': (f) => {
      f.workspace.defaultLanguage = 'de_DE';
    },
    inventory: (f) => {
      f.row.IsPublished = true;
    },
    'current bytes': (f) => {
      f.current[0] ^= 1;
    },
    'effective API': (f) => {
      f.setApiVersion('66.0');
    },
    'journal substitution': async (f) => {
      await writeFile(f.input.reportFile, JSON.stringify({ state: 'completed' }));
    },
  };
  for (const [kind, mutate] of Object.entries(prewrite))
    it(`rejects prewrite ${kind} substitution with zero PUT`, async () => {
      const f = await fixture();
      await failure(
        f.run(rewriteAtomic, async () => {
          await mutate(f);
        }),
      );
      expect(f.puts()).to.equal(0);
      const report = await f.journal();
      expect(report.state).to.equal('failed');
      expect(report.operations[0].state).to.equal('failed');
      expect(report.createdParents).to.deep.equal([]);
    });

  for (const kind of ['reject', 'cancel'])
    it(`awaits callback ${kind} without dispatch`, async () => {
      const f = await fixture();
      const controller = new AbortController();
      await failure(
        f.run(
          rewriteAtomic,
          async () => {
            await Promise.resolve();
            if (kind === 'reject') throw new Error('Callback rejected');
            controller.abort();
          },
          { signal: controller.signal },
        ),
      );
      expect(f.puts()).to.equal(0);
      const durable = await f.journal();
      expect(durable.state).to.equal('failed');
    });

  for (const kind of ['synchronous dispatch', 'timeout', 'lost response'])
    it(`keeps conservative uncertainty without replay for ${kind}`, async () => {
      const f = await fixture();
      const error = Object.assign(new Error(kind), {
        code: kind === 'timeout' ? 'ETIMEDOUT' : 'ECONNRESET',
      });
      if (kind === 'synchronous dispatch') f.failDispatch(error);
      else f.failTransport(error);
      await failure(f.run());
      await assertUncertain(f);
    });

  for (const status of [401, 429])
    it(`never refreshes or replays transport ${status}`, async () => {
      const f = await fixture();
      f.failTransport(Object.assign(new Error(`HTTP ${status}`), { statusCode: status }));
      await failure(f.run(), new RegExp(String(status), 'u'));
      await assertUncertain(f);
    });
  it('retains uncertainty for in-flight cancellation', async () => {
    const f = await fixture();
    const controller = new AbortController();
    f.afterPut(() => controller.abort());
    await failure(f.run(rewriteAtomic, undefined, { signal: controller.signal }), /cancel/u);
    await assertUncertain(f);
  });

  for (const [kind, value] of Object.entries({
    null: null,
    array: [],
    partial: { managedContentId: contentId },
    'wrong parent': { managedContentId: '20Y000000000002AAA' },
    'wrong variant': { managedContentVariantId: '9Ps000000000002AAA' },
    'wrong key': { contentKey: 'OTHER' },
    'wrong language': { language: 'de_DE' },
    published: { isPublished: true },
    'missing body': { contentBody: undefined },
  }))
    it(`persists available raw IDs for ${kind} without completion`, async () => {
      const f = await fixture();
      const raw =
        kind === 'partial' || value === null || Array.isArray(value)
          ? value
          : { ...f.response, ...value };
      f.rawResponse(raw);
      await failure(f.run());
      const report = await assertUncertain(f);
      const expected: Record<string, unknown> = {};
      if (raw && !Array.isArray(raw)) {
        const row = raw as Row;
        for (const [native, portable] of [
          ['managedContentId', 'contentId'],
          ['managedContentVariantId', 'variantId'],
          ['contentKey', 'contentKey'],
        ])
          if (typeof row[native] === 'string') expected[portable] = row[native];
      }
      expect(report.operations[0].result).to.deep.equal(expected);
    });

  it('accepts absent optional response key without inventing it', async () => {
    const f = await fixture();
    delete f.response.contentKey;
    const result = await f.run();
    expect(result.report.state).to.equal('completed');
    expect(result.report.operations[0].result).not.to.have.property('contentKey');
  });

  const readback: Record<string, (f: Fixture) => void> = {
    parent: (f) => {
      f.detail.managedContentId = '20Y000000000002AAA';
    },
    variant: (f) => {
      f.detail.managedContentVariantId = '9Ps000000000002AAA';
    },
    key: (f) => {
      f.detail.contentKey = 'OTHER';
    },
    type: (f) => {
      f.detail.contentType = { fullyQualifiedName: 'sfdc_cms__image' };
    },
    apiName: (f) => {
      f.detail.apiName = 'Other';
    },
    workspace: (f) => {
      f.detail.contentSpace = { id: '0Zu000000000002AAA' };
    },
    root: (f) => {
      f.detail.folder = { id: 'other' };
    },
    language: (f) => {
      f.detail.language = 'de_DE';
    },
    title: (f) => {
      f.detail.title = 'Other';
    },
    urlName: (f) => {
      f.detail.urlName = 'other';
    },
    status: (f) => {
      f.detail.status = { status: 'Published' };
    },
    publication: (f) => {
      f.detail.isPublished = true;
    },
    'sibling publication': (f) => {
      f.addSibling({
        ...f.row,
        Id: '9Ps000000000002AAA',
        Language: 'de_DE',
        IsPrimary: false,
        IsPublished: true,
      });
      f.setSiblingCount(2);
    },
    'sibling count': (f) => {
      f.setSiblingCount(2);
    },
    'inventory collision': (f) => {
      f.addSibling({ ...f.row, Id: '9Ps000000000002AAA', ManagedContentId: '20Y000000000002AAA' });
    },
    'inventory publication': (f) => {
      f.row.IsPublished = true;
    },
    'inventory primary': (f) => {
      f.row.IsPrimary = false;
    },
    'inventory language': (f) => {
      f.row.Language = 'de_DE';
    },
    'inventory unknown API': (f) => {
      f.row.ManagedContent = { AuthoredManagedContentSpaceId: workspaceId };
    },
    external: (f) => {
      f.media.url = 'https://outside.invalid/sound';
    },
    'URL-only': (f) => {
      Object.assign(f.media.source, { type: 'url' });
    },
    filename: (f) => {
      f.media.url = f.media.url.replace('Sound.cms-audio.media.bin', 'other.bin');
    },
    mime: (f) => {
      f.media.source.mimeType = 'audio/other';
    },
    size: (f) => {
      f.media.source.size += 1;
    },
    md5: (f) => {
      f.media.url = f.media.url.replace(hash(f.bytes, 'md5'), '0'.repeat(32));
    },
    bytes: (f) => {
      f.download(
        () => new Response(Buffer.from([7, 8, 9]), { headers: { 'content-type': mimeType } }),
      );
    },
    'download failure': (f) => {
      f.download(() => {
        throw new Error('Download lost');
      });
    },
    'effective API': (f) => {
      f.setApiVersion('66.0');
    },
  };
  for (const [kind, mutate] of Object.entries(readback))
    it(`never completes after independent readback ${kind} mismatch`, async () => {
      const f = await fixture();
      f.afterPut(() => mutate(f));
      await failure(f.run());
      const report = await assertUncertain(f);
      expect(report.operations[0].result).to.include({
        contentId,
        variantId,
        contentKey: 'MCGENERATED',
      });
    });

  for (const kind of ['raw-save', 'all-postwrite-save'])
    it(`rejects ${kind} while preserving truthful durable pending evidence`, async () => {
      const f = await fixture();
      let rejected = false;
      await failure(
        f.run(async (file, report) => {
          if (f.puts() && (!rejected || kind === 'all-postwrite-save')) {
            rejected = true;
            throw new Error('Result persistence failed');
          }
          await rewriteAtomic(file, report);
        }),
        /CMS mutation may have succeeded/u,
      );
      expect(f.puts()).to.equal(1);
      const durable = await f.journal();
      expect(durable.state).to.equal(kind === 'raw-save' ? 'ownership-uncertain' : 'applying');
      expect(durable.operations[0].state).to.equal('pending');
      expect(durable.createdParents).to.deep.equal([]);
      expect(durable.operations[0].result).to.deep.equal(
        kind === 'raw-save' ? { contentId, variantId, contentKey: 'MCGENERATED' } : undefined,
      );
    });

  it('detaches caller input and option values before the awaited callback', async () => {
    const f = await fixture();
    const options = { timeoutMs: 1000 };
    const result = await f.run(
      rewriteAtomic,
      async () => {
        f.input.workspaceId = 'invalid';
        f.input.language = 'de_DE';
        f.input.definitionFile = 'missing';
        options.timeoutMs = -1;
      },
      options,
    );
    expect(result.report.state).to.equal('completed');
    expect(f.puts()).to.equal(1);
  });

  for (const timeoutMs of [0, -1, Number.NaN])
    it(`rejects invalid timeout ${String(timeoutMs)} without dispatch`, async () => {
      const f = await fixture();
      await failure(f.run(rewriteAtomic, undefined, { timeoutMs }));
      expect(f.puts()).to.equal(0);
    });

  for (const kind of [
    'final workspace',
    'final inventory',
    'final source',
    'final API',
    'variant bracket',
    'late cancellation',
  ])
    it(`rejects ${kind} drift at the later independent boundary`, async () => {
      const f = await fixture();
      const controller = new AbortController();
      let detailReads = 0;
      let workspaceReads = 0;
      let postQueries = 0;
      f.beforeGet(async (url) => {
        if (!f.puts()) return;
        if (url.pathname.includes('/spaces/')) {
          workspaceReads += 1;
          // Guarded acquisition obtains its own workspace first; executor obtains the final one.
          if (workspaceReads === 2) {
            if (kind === 'final workspace') f.workspace.apiName = 'Changed';
            if (kind === 'final API') f.setApiVersion('66.0');
            if (kind === 'final source') await writeFile(f.companion, Buffer.from([4, 3, 2]));
          }
        } else if (url.pathname.endsWith('/query')) {
          postQueries += 1;
          if (kind === 'final inventory' && workspaceReads >= 2) f.row.IsPrimary = false;
          if (kind === 'late cancellation' && workspaceReads >= 2) controller.abort();
        } else {
          detailReads += 1;
          if (kind === 'variant bracket' && detailReads === 2) f.detail.extra = 'changed';
        }
      });
      await failure(f.run(rewriteAtomic, undefined, { signal: controller.signal }));
      await assertUncertain(f);
      expect(postQueries).to.be.greaterThan(0);
    });

  it('awaits raw-result persistence before any independent readback', async () => {
    const f = await fixture();
    let release!: () => void;
    let reached!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      reached = resolve;
    });
    let first = true;
    const running = f.run(async (file, report) => {
      if (f.puts() && first) {
        first = false;
        reached();
        await gate;
      }
      await rewriteAtomic(file, report);
    });
    await started;
    const count = f.getCount();
    const durable = await f.journal();
    expect(durable.operations[0].result).to.equal(undefined);
    await Promise.resolve();
    expect(f.getCount()).to.equal(count);
    release();
    const completed = await running;
    expect(completed.report.state).to.equal('completed');
  });
});

describe('private journaled Audio UPDATE executor core', () => {
  afterEach(() => sinon.restore());
  for (const urlName of ['opaque-sound', undefined])
    it(`verifies exact opaque wire, old/new journal and independent readback (URL ${String(urlName)})`, async () => {
      const f = await fixture(urlName);
      const result = await f.run();
      expect(result.qualification).to.equal('unqualified');
      expect(result.report.state).to.equal('completed');
      expect(result.report.operations[0].state).to.equal('succeeded');
      expect(result.report.createdParents).to.deep.equal([]);
      expect(await f.journal()).to.deep.equal(result.report);
      expect(f.puts()).to.equal(1);
      expect(f.downloads()).to.equal(3);
      await failure(f.run(), /unchanged/u);
      expect(f.puts()).to.equal(1);
    });
  it('never overwrites an existing journal or dispatches', async () => {
    const f = await fixture();
    await writeFile(f.input.reportFile, 'existing');
    await failure(f.run(), /EEXIST/u);
    expect(await readFile(f.input.reportFile, 'utf8')).to.equal('existing');
    expect(f.puts()).to.equal(0);
  });
  it('rejects intent persistence failure before PUT', async () => {
    const f = await fixture();
    await failure(
      f.run(async () => {
        throw new Error('Disk unavailable');
      }),
      /Disk unavailable/u,
    );
    expect(f.puts()).to.equal(0);
    const durable = await f.journal();
    expect(durable.state).to.equal('applying');
  });
  it('awaits the intent promise before callback and dispatch', async () => {
    const f = await fixture();
    let release!: () => void;
    let reached!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      reached = resolve;
    });
    let first = true;
    const callback = sinon.stub().rejects(new Error('Boundary stopped'));
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
    expect(f.puts()).to.equal(0);
    release();
    await failure(running, /Boundary stopped/u);
    expect(callback.calledOnce).to.equal(true);
  });
  it('rejects desired-byte drift after the awaited boundary with zero PUT', async () => {
    const f = await fixture();
    await failure(
      f.run(rewriteAtomic, async () => {
        await writeFile(f.companion, Buffer.from([7, 6, 5]));
      }),
      /drifted/u,
    );
    expect(f.puts()).to.equal(0);
    const durable = await f.journal();
    expect(durable.state).to.equal('failed');
  });
  it('does not resolve completion until its persistence promise resolves', async () => {
    const f = await fixture();
    let release!: () => void;
    let reached!: () => void;
    let resolved = false;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
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
    await started;
    expect(resolved).to.equal(false);
    const pending = await f.journal();
    expect(pending.state).to.equal('ownership-uncertain');
    release();
    const result = await running;
    expect(await f.journal()).to.deep.equal(result.report);
  });
  for (const kind of ['socket', 'partial', 'completion-save'])
    it(`retains conservative pending intent without replay after ${kind}`, async () => {
      const f = await fixture();
      if (kind === 'socket') f.failTransport(new Error('Socket lost'));
      if (kind === 'partial') {
        delete f.response.language;
        delete f.response.managedContentId;
      }
      await failure(
        f.run(async (file, report) => {
          if (kind === 'completion-save' && report.state === 'completed')
            throw new Error('Completion save failed');
          await rewriteAtomic(file, report);
        }),
      );
      expect(f.puts()).to.equal(1);
      const pending = await f.journal();
      expect(pending.state).to.equal('ownership-uncertain');
      expect(pending.operations[0].state).to.equal('pending');
      expect(pending.createdParents).to.deep.equal([]);
      if (kind === 'partial')
        expect(pending.operations[0].result).to.deep.equal({
          variantId,
          contentKey: 'MCGENERATED',
        });
      await failure(f.run());
      expect(f.puts()).to.equal(1);
    });
});
