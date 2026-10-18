import { expect } from 'chai';
import type { Connection } from '@salesforce/core';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import sinon from 'sinon';
import type { EditableMediaDefinition } from '../../src/services/editable-media-source.js';
import type { JsonRequestOptions } from '../../src/transport/json-request.js';
import { preflightDeployAudioUpdate } from '../../src/services/deploy-audio-update-preflight.js';

type Row = Record<string, unknown>;
const workspaceId = '0Zu000000000001AAA';
const contentId = '20Y000000000001AAA';
const variantId = '9Ps000000000001AAA';
const mimeType = 'application/x-future-audio';
const hash = (bytes: Buffer, algorithm = 'sha256') =>
  createHash(algorithm).update(bytes).digest('hex');
async function fixture(bytes = Buffer.from([0, 255, 128, 13, 10, 1])) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'cms-audio-update-preflight-'));
  const definitionFile = path.join(directory, 'Sound.cms-audio.json');
  const fileName = 'Sound.cms-audio.media.bin';
  const companion = path.join(directory, fileName);
  const current = Buffer.from([255, 0, 129, 1]);
  const definition: EditableMediaDefinition = {
    contract: 'sf-cms-media-source',
    contractVersion: '1.0.0',
    identity: {
      family: 'cms',
      type: 'Audio',
      apiName: 'Sound',
      context: { workspaceApiName: 'Different_Source' },
    },
    contentType: 'sfdc_cms__audio',
    language: 'en_US',
    folderPath: [],
    title: 'Opaque sound',
    urlName: 'opaque-sound',
    media: { representation: 'binary', mimeType, companion: { role: 'media', path: fileName } },
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
    ContentTypeFullyQualifiedName: 'sfdc_cms__audio',
    Language: 'en_US',
    IsPublished: false,
    ManagedContentVariantStatus: 'Draft',
    IsPrimary: true,
    Name: definition.title,
    UrlName: definition.urlName,
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
    urlName: definition.urlName,
    contentType: { fullyQualifiedName: 'sfdc_cms__audio' },
    contentSpace: { id: workspaceId },
    language: 'en_US',
    folder: { id: 'root' },
    isPublished: false,
    status: { status: 'Draft' },
    contentBody: { 'sfdc_cms:media': media },
  };
  const rows = [row];
  const calls: string[] = [];
  let hook: ((url: URL) => void | Promise<void>) | undefined;
  let responseHook: ((url: URL, response: Row) => void) | undefined;
  let version = '67.0';
  let apiHook: (() => void) | undefined;
  let variantReads = 0;
  let workspaceReads = 0;
  let inventoryReads = 0;
  const connection = {
    accessToken: 'test-token',
    instanceUrl: 'https://example.invalid',
    getApiVersion() {
      apiHook?.();
      return version;
    },
    request(input: { method: string; url: string }) {
      expect(input.method).to.equal('GET');
      calls.push(input.url);
      const result = (async () => {
        const url = new URL(input.url, 'https://example.invalid');
        await hook?.(url);
        let response: Row;
        if (url.pathname.includes('/spaces/')) {
          workspaceReads += 1;
          response = structuredClone(workspace);
        } else if (url.pathname.endsWith('/query')) {
          inventoryReads += 1;
          const q = url.searchParams.get('q')!;
          let records: Row[] = q.includes('Id >') ? [] : rows;
          if (q.includes('COUNT(Id)')) {
            const counts = new Map<string, number>();
            for (const entry of rows)
              counts.set(
                entry.ManagedContentId as string,
                (counts.get(entry.ManagedContentId as string) ?? 0) + 1,
              );
            records = [...counts].map(([ManagedContentId, siblingCount]) => ({
              ManagedContentId,
              siblingCount,
            }));
          }
          response = { records: structuredClone(records), totalSize: records.length, done: true };
        } else {
          if (url.pathname.includes('/variants/')) variantReads += 1;
          response = structuredClone(detail);
        }
        responseHook?.(url, response);
        return response;
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
    current,
    workspace,
    row,
    rows,
    detail,
    media,
    calls,
    connection,
    input,
    hook(value: typeof hook) {
      hook = value;
    },
    responseHook(value: typeof responseHook) {
      responseHook = value;
    },
    apiHook(value: typeof apiHook) {
      apiHook = value;
    },
    version(value: string) {
      version = value;
    },
    counts: () => ({ variantReads, workspaceReads, inventoryReads }),
    run: (options: JsonRequestOptions = {}) =>
      preflightDeployAudioUpdate(connection, input, options),
  };
}
async function failure(
  operation: Promise<unknown>,
  pattern = /Audio|audio|Native|native|Media|media|mismatch|Unsupported|same-stem|safe ASCII|nonempty|missing|cancel|Read failed/u,
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
  bytes = f.current,
  action: () => void | Promise<void> = () => {},
) {
  return sinon.stub(globalThis, 'fetch').callsFake(async () => {
    await action();
    return new Response(bytes, { headers: { 'content-type': mimeType } });
  });
}

describe('private readonly portable binary Audio UPDATE preflight', () => {
  afterEach(() => sinon.restore());
  it('returns detached unqualified candidate, old/new hashes and complete observations without writes', async () => {
    const f = await fixture();
    downloaded(f);
    const files = await readdir(f.directory);
    const result = await f.run();
    expect(result.qualification).to.equal('unqualified');
    expect(result.operation).to.equal('update');
    expect(result.definitionFile).to.equal(path.resolve(f.input.definitionFile));
    expect(result).to.include({
      workspaceId,
      contentId,
      variantId,
      contentKey: 'MCGENERATED',
      rootFolderId: 'root',
      language: 'en_US',
      apiVersion: '67.0',
    });
    expect(result.payload).to.deep.equal({
      title: 'Opaque sound',
      urlName: 'opaque-sound',
      contentBody: { 'sfdc_cms:media': { source: { type: 'file' } } },
    });
    expect(result.payload).not.to.have.property('apiName');
    expect(result.mediaSha256).to.equal(hash(f.bytes));
    expect(result.destination.mediaSha256).to.equal(hash(f.current));
    expect(result.sourceSha256).to.equal(
      createHash('sha256')
        .update(JSON.stringify(result.source.definition))
        .update(f.bytes)
        .digest('hex'),
    );
    expect(result.destination.inventory.complete).to.equal(true);
    expect(result.source.source).to.have.nested.property('binary.bytes').deep.equal(f.bytes);
    expect(result.destination.acquisition.projection.companions[0].bytes).to.deep.equal(f.current);
    expect(await readdir(f.directory)).to.deep.equal(files);
    const firstQuery = new URL(
      f.calls.find((url) => url.includes('/query'))!,
      'https://example.invalid',
    ).searchParams.get('q');
    expect(firstQuery).not.to.match(/ IN \(|Language =|Status =/u);
    const repeated = await f.run();
    f.workspace.rootFolderId = 'later';
    f.definition.title = 'later';
    repeated.destination.inventory.records[0].Name = 'later';
    repeated.destination.acquisition.projection.companions[0].bytes.fill(0);
    expect(result.destination.workspace.rootFolderId).to.equal('root');
    expect(result.destination.inventory.records[0].Name).to.equal('Opaque sound');
    expect(result.destination.acquisition.projection.companions[0].bytes).to.deep.equal(f.current);
  });
  it('supports omitted optional URL and opaque non-WAV bytes above the revoked cap (mock only)', async () => {
    const f = await fixture(Buffer.alloc(10 * 1024 * 1024 + 1, 255));
    delete f.definition.urlName;
    f.row.UrlName = null;
    delete f.detail.urlName;
    await f.save();
    downloaded(f);
    const result = await f.run();
    expect(result.payload).not.to.have.property('urlName');
    expect(result.mediaSha256).to.equal(hash(f.bytes));
  });
  it('detaches caller input and options before first await', async () => {
    const f = await fixture();
    downloaded(f);
    const options = { timeoutMs: 30_000 };
    const pending = f.run(options);
    f.input.workspaceId = 'wrong';
    f.input.language = 'de';
    options.timeoutMs = -1;
    const result = await pending;
    expect(result.contentId).to.equal(contentId);
  });
  const localChanges: Array<
    [string, (f: Awaited<ReturnType<typeof fixture>>) => void | Promise<void>]
  > = [
    [
      'family',
      (f) => {
        f.definition.identity.type = 'Image';
      },
    ],
    [
      'identity',
      (f) => {
        f.definition.identity.apiName = 'Other';
      },
    ],
    [
      'title',
      (f) => {
        f.definition.title = ' ';
      },
    ],
    [
      'URL',
      (f) => {
        f.definition.urlName = 'Bad Slug';
      },
    ],
    [
      'language',
      (f) => {
        f.definition.language = 'de';
      },
    ],
    [
      'folder',
      (f) => {
        f.definition.folderPath = ['nested'];
      },
    ],
    [
      'URL-only',
      (f) => {
        f.definition.media = { representation: 'url-only', address: '/audio' };
      },
    ],
    [
      'MIME',
      (f) => {
        if (f.definition.media.representation === 'binary')
          f.definition.media.mimeType = 'audio/wav\r\nX: yes';
      },
    ],
    [
      'filename',
      (f) => {
        if (f.definition.media.representation === 'binary')
          f.definition.media.companion.path = '../unsafe.bin';
      },
    ],
    [
      'empty bytes',
      async (f) => {
        await writeFile(f.companion, Buffer.alloc(0));
      },
    ],
    [
      'missing bytes',
      async (f) => {
        await unlink(f.companion);
      },
    ],
    [
      'workspace ID',
      (f) => {
        f.input.workspaceId = 'wrong';
      },
    ],
  ];
  for (const [name, change] of localChanges)
    it(`rejects local ${name} before zero GETs`, async () => {
      const f = await fixture();
      await change(f);
      await f.save();
      await failure(f.run());
      expect(f.calls).to.have.length(0);
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
    it(`rejects target ${key} mismatch`, async () => {
      const f = await fixture();
      f.row[key] = typeof f.row[key] === 'boolean' ? !f.row[key] : 'Other';
      const fetcher = downloaded(f);
      await failure(f.run());
      expect(fetcher.called).to.equal(false);
    });
  for (const kind of ['absent', 'duplicate', 'API', 'title', 'URL', 'unknown API'])
    it(`rejects ${kind} collision evidence`, async () => {
      const f = await fixture();
      if (kind === 'absent') f.rows.length = 0;
      else if (kind === 'unknown API') (f.row.ManagedContent as Row).ApiName = null;
      else
        f.rows.push({
          ...structuredClone(f.row),
          Id: '9Ps000000000002AAA',
          ContentTypeFullyQualifiedName: 'sfdc_cms__image',
          Language: 'de',
          ManagedContentVariantStatus: 'Published',
          ManagedContent: {
            AuthoredManagedContentSpaceId: workspaceId,
            ApiName: kind === 'API' || kind === 'duplicate' ? 'Sound' : 'Other',
          },
          Name: kind === 'title' || kind === 'duplicate' ? 'Opaque sound' : 'Other',
          UrlName: kind === 'URL' || kind === 'duplicate' ? 'opaque-sound' : 'other',
        });
      await failure(f.run());
    });
  for (const kind of ['count', 'incomplete', 'repeat', 'terminal'])
    it(`rejects ${kind} inventory`, async () => {
      const f = await fixture();
      f.responseHook((url, response) => {
        if (!url.pathname.endsWith('/query')) return;
        const q = url.searchParams.get('q')!;
        if (kind === 'count' && q.includes('COUNT(Id)'))
          (response.records as Row[])[0].siblingCount = 2;
        if (kind === 'incomplete') response.done = false;
        if (kind === 'repeat' && f.counts().inventoryReads === 4)
          (response.records as Row[])[0].Name = 'Changed';
        if (kind === 'terminal' && q.includes('Id >')) {
          response.records = [structuredClone(f.row)];
          response.totalSize = 1;
        }
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
    'contentSpace',
    'isPublished',
    'status',
    'source',
    'externalId',
  ])
    for (const scope of ['variant', 'parent'])
      it(`rejects independent ${scope} ${key} substitution`, async () => {
        const f = await fixture();
        downloaded(f);
        f.responseHook((url, response) => {
          if (url.pathname.endsWith('/query') || url.pathname.includes('/spaces/')) return;
          if (url.pathname.includes('/variants/') !== (scope === 'variant')) return;
          response[key] = ['folder', 'contentSpace'].includes(key) ? { id: 'elsewhere' } : 'Other';
        });
        await failure(f.run());
      });
  it('rejects independently introduced siblings', async () => {
    const f = await fixture();
    downloaded(f);
    f.hook((url) => {
      if (url.pathname.endsWith('/query') && f.counts().variantReads === 1 && f.rows.length === 1)
        f.rows.push({
          ...structuredClone(f.row),
          Id: '9Ps000000000002AAA',
          Language: 'de',
          IsPrimary: false,
        });
    });
    await failure(f.run());
  });
  for (const kind of [
    'filename',
    'MIME',
    'size',
    'MD5',
    'download bytes',
    'external URL',
    'URL-only',
    'equal desired bytes',
  ])
    it(`rejects ${kind} rather than normalized companion identity`, async () => {
      const f = await fixture();
      if (kind === 'filename')
        f.media.url = f.media.url.replace('Sound.cms-audio.media.bin', 'other.bin');
      if (kind === 'MIME') f.media.source.mimeType = 'audio/wav';
      if (kind === 'size') f.media.source.size += 1;
      if (kind === 'MD5')
        f.media.url = f.media.url.replace(/fileHash=[^&]+/u, `fileHash=${'0'.repeat(32)}`);
      if (kind === 'external URL') f.media.url = 'https://outside.invalid/audio';
      if (kind === 'URL-only')
        (f.detail.contentBody as Row)['sfdc_cms:media'] = { url: 'https://outside.invalid/audio' };
      if (kind === 'equal desired bytes') await writeFile(f.companion, f.current);
      downloaded(f, kind === 'download bytes' ? Buffer.from([1, 0, 129, 1]) : f.current);
      await failure(f.run(), /mismatch|MIME|size|hash|MD5|source|Audio|media|different bytes/u);
    });
  for (const patch of [
    { id: 'Other' },
    { defaultLanguage: 'de' },
    { rootFolderId: '' },
    { rootFolderId: 'Other' },
    { spaceType: { apiName: 'Content' } },
  ])
    it('rejects workspace/root/default-language substitution', async () => {
      const f = await fixture();
      Object.assign(f.workspace, patch);
      await failure(f.run(), /workspace|Marketing/u);
    });
  for (const kind of [
    'local bytes',
    'local metadata',
    'local missing',
    'workspace',
    'inventory',
    'variant',
    'effective API',
  ])
    it(`rejects ${kind} drift after download`, async () => {
      const f = await fixture();
      downloaded(f, f.current, async () => {
        if (kind === 'local bytes') await writeFile(f.companion, Buffer.from([1]));
        if (kind === 'local missing') await unlink(f.companion);
        if (kind === 'local metadata') {
          f.definition.title = 'Changed';
          await f.save();
        }
        if (kind === 'workspace') f.workspace.rootFolderId = 'changed';
        if (kind === 'inventory') f.row.Name = 'Changed';
        if (kind === 'variant') f.detail.title = 'Changed';
        if (kind === 'effective API') f.version('68.0');
      });
      await failure(f.run());
    });
  it('rejects effective API drift after final awaited local reload', async () => {
    const f = await fixture();
    downloaded(f);
    f.apiHook(() => {
      if (f.counts().workspaceReads === 4 && f.counts().variantReads === 6) f.version('68.0');
    });
    await failure(f.run(), /drifted/u);
  });
  it('honors cancellation before work, after acquisition and after final awaited reload', async () => {
    const early = await fixture();
    const first = new AbortController();
    first.abort();
    await failure(early.run({ signal: first.signal }), /cancel/u);
    expect(early.calls).to.have.length(0);
    const during = await fixture();
    const second = new AbortController();
    downloaded(during, during.current, () => second.abort());
    await failure(during.run({ signal: second.signal }), /cancel/u);
    sinon.restore();
    const late = await fixture();
    const third = new AbortController();
    downloaded(late);
    late.apiHook(() => {
      if (late.counts().workspaceReads === 4 && late.counts().variantReads === 6) third.abort();
    });
    await failure(late.run({ signal: third.signal }), /cancel/u);
  });
  it('propagates independent read failure without journal or mutations', async () => {
    const f = await fixture();
    f.hook(() => {
      throw new Error('Read failed');
    });
    await failure(f.run());
    expect(await readdir(f.directory)).to.have.length(2);
  });
});
