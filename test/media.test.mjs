import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Config } from '@oclif/core';
import Delete from '../lib/commands/cms/delete.js';
import Deploy from '../lib/commands/cms/deploy.js';
import Retrieve from '../lib/commands/cms/retrieve.js';
import { audioHandler, documentHandler, imageHandler } from '../lib/content/handlers/media.js';
import { HANDLERS } from '../lib/content/registry.js';
import { readSourceFiles, writeSourceFiles } from '../lib/content/source-files.js';
import { mediaOf } from '../lib/services/media.js';
import { fakeConnection } from './support/fake-connection.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const golden = path.join(here, 'fixtures', 'golden');
const WS = 'Default_Content_Workspace';
const INSTANCE = 'https://example.my.salesforce.com';
const workspace = {
  apiName: WS,
  id: '0Zu000000000001AAA',
  isEnhancedSpace: true,
  name: 'Workspace',
  defaultLanguage: 'en_US',
  rootFolderId: '9Pu000000000001AAA',
  spaceType: { apiName: 'marketing' },
};
const CASES = [
  ['image', imageHandler, 'Golden_Image', 'golden-image.png'],
  ['document', documentHandler, 'Golden_Document', 'golden-notes.txt'],
  ['audio', audioHandler, 'Golden_Audio', 'golden-tone.wav'],
];
const md5 = (bytes) => createHash('md5').update(bytes).digest('hex');
const nativeOf = async (name) =>
  JSON.parse(await readFile(path.join(here, 'fixtures', 'native', `${name}.variant.json`), 'utf8'));
const goldenBytes = (type, apiName, fileName) =>
  readFile(path.join(golden, 'cms', WS, type, `${apiName}.${type}.${fileName}`));
const scratch = () => mkdtemp(path.join(os.tmpdir(), 'sf-plugin-cms-v1-media-'));
const context = (media) => ({
  workspace,
  folderPath: [],
  referenceOf: () => {},
  warn: (warning) => assert.fail(`unexpected warning ${warning.code}`),
  ...(media ? { media } : {}),
});

let config;
before(async () => {
  config = await Config.load(root);
});

test('media types are registered after brand, before the email types', () => {
  const order = [
    'brand',
    'image',
    'document',
    'audio',
    'email-fragment',
    'email-template',
    'email',
  ];
  // Types added later may sit anywhere; only the relative order of these seven is fixed here.
  assert.deepEqual(
    HANDLERS.map((handler) => handler.type).filter((type) => order.includes(type)),
    order,
  );
  for (const [, handler] of CASES) assert.equal(handler.transport, 'multipart');
});

for (const [type, handler, apiName, fileName] of CASES) {
  test(`golden: ${type} native -> JSON metadata + the file under its native name`, async () => {
    const bytes = await goldenBytes(type, apiName, fileName);
    const files = handler.toSource(await nativeOf(type), context({ fileName, bytes }));
    const directory = await scratch();
    const written = await writeSourceFiles(directory, WS, files);
    assert.equal(
      await readFile(written.path, 'utf8'),
      await readFile(path.join(golden, 'cms', WS, type, `${apiName}.${type}.json`), 'utf8'),
    );
    assert.deepEqual(
      written.companionPaths.map((file) => path.basename(file)),
      [`${apiName}.${type}.${fileName}`],
    );
    assert.deepEqual(await readFile(written.companionPaths[0]), bytes);
  });

  test(`golden fromSource: ${type} files give the metadata, the file and its MIME type`, async () => {
    const native = await nativeOf(type);
    const files = await readSourceFiles(golden, WS, type, apiName);
    const payload = handler.fromSource(files, { workspace });
    assert.equal(payload.title, native.title);
    assert.equal(payload.urlName, native.urlName);
    const media = native.contentBody['sfdc_cms:media'];
    assert.deepEqual(payload.file, {
      fileName,
      bytes: new Uint8Array(await goldenBytes(type, apiName, fileName)),
      mimeType: media.source.mimeType,
    });
    assert.equal(
      md5(payload.file.bytes),
      new URL(media.url, INSTANCE).searchParams.get('fileHash'),
    );
    assert.deepEqual(payload.contentBody['sfdc_cms:media'], {
      source: { mimeType: media.source.mimeType, type: 'file' },
    });
    assert.deepEqual(handler.references(payload), []);
  });
}

test('media fromSource: one file exactly; an external URL image needs none', async () => {
  const files = await readSourceFiles(golden, WS, 'image', 'Golden_Image');
  assert.throws(
    () =>
      imageHandler.fromSource(
        { ...files, companions: { ...files.companions, '.second.png': new Uint8Array([1]) } },
        { workspace },
      ),
    { code: 'UNKNOWN_SETTING' },
  );
  assert.throws(() => imageHandler.fromSource({ ...files, companions: {} }, { workspace }), {
    code: 'MEDIA_FILE_MISSING',
  });
  const external = imageHandler.toSource(await nativeOf('image-url'), context());
  assert.deepEqual(external.companions, {});
  assert.deepEqual(external.document.contentBody['sfdc_cms:media'], {
    source: { mimeType: null, type: 'url', url: 'https://example.com/golden.png' },
  });
  assert.equal(imageHandler.fromSource(external, { workspace }).file, undefined);
});

/**
 * Serve stored media like `/cms/media/…` (301 to file.force.com, then the bytes).
 * @param {Map<string, { bytes: Buffer; mimeType: string }>} media Stored files by content key.
 */
function serveMedia(media) {
  globalThis.fetch = async (url) => {
    const target = new URL(url);
    if (target.hostname === 'example.my.salesforce.com')
      return new Response(undefined, {
        status: 301,
        headers: { location: `https://c.file.force.com${target.pathname}${target.search}` },
      });
    const stored = media.get(target.pathname.split('/').at(-1));
    return new Response(stored.bytes, {
      status: 200,
      headers: {
        'content-type': stored.mimeType,
        'content-length': String(stored.bytes.length),
      },
    });
  };
}

/**
 * Parts of a multipart body: the JSON part and the file part.
 * @param {{ body: Buffer; headers: Record<string, string> }} input Request.
 * @returns {{ json: object; fileName: string; mimeType: string; bytes: Buffer }} Parts.
 */
function parseMultipart(input) {
  const boundary = /boundary=(.+)$/u.exec(input.headers['content-type'])[1];
  const parts = [];
  let start = input.body.indexOf(`--${boundary}`) + boundary.length + 4;
  for (;;) {
    const end = input.body.indexOf(`\r\n--${boundary}`, start);
    if (end === -1) break;
    const headerEnd = input.body.indexOf('\r\n\r\n', start);
    parts.push({
      head: input.body.subarray(start, headerEnd).toString('ascii'),
      bytes: input.body.subarray(headerEnd + 4, end),
    });
    start = end + boundary.length + 6;
  }
  const [jsonPart, filePart] = parts;
  return {
    jsonName: /name="([^"]+)"/u.exec(jsonPart.head)[1],
    json: JSON.parse(jsonPart.bytes.toString('utf8')),
    fileName: /filename="([^"]+)"/u.exec(filePart.head)[1],
    mimeType: /Content-Type: (.+)$/mu.exec(filePart.head)[1],
    bytes: Buffer.from(filePart.bytes),
  };
}

/**
 * An in-memory media workspace: SOQL rows, variant GET, multipart create/update, delete, and
 * the media files behind `fetch`.
 * @returns {{ answer: Function; variants: Map; media: Map }} Answer function and stores.
 */
function fakeOrg() {
  const variants = new Map();
  const media = new Map();
  const versions = new Map();
  let counter = 0;
  const withFile = (native, upload) => {
    const key = native.contentKey;
    media.set(key, { bytes: upload.bytes, mimeType: upload.mimeType });
    versions.set(key, (versions.get(key) ?? 0) + 1);
    const version = `1.${versions.get(key)}`;
    return {
      ...native,
      contentBody: {
        ...upload.json.contentBody,
        'sfdc_cms:media': {
          source: {
            fileSize: upload.bytes.length,
            mimeType: upload.mimeType,
            ref: `0sN00000000000${counter}AAA`,
            type: 'file',
            size: upload.bytes.length,
          },
          url: `/cms/media/${key}?version=${version}&fileHash=${md5(upload.bytes)}&fileName=${upload.fileName}`,
        },
      },
    };
  };
  const answer = (input) => {
    const url = decodeURIComponent(input.url.replaceAll('+', ' '));
    if (url.startsWith('/connect/cms/spaces?'))
      return { spaces: url.includes('page=0') ? [workspace] : [] };
    if (url.startsWith('/query?')) {
      const type = /ContentTypeFullyQualifiedName = '(\w+)'/u.exec(url)?.[1];
      const names = /ApiName IN \(([^)]*)\)/u.exec(url)?.[1] ?? '';
      return {
        records: [...variants.values()]
          .filter(
            (v) => v.contentType.fullyQualifiedName === type && names.includes(`'${v.apiName}'`),
          )
          .map((v) => ({
            Id: v.managedContentVariantId,
            ManagedContentId: v.managedContentId,
            Language: 'en_US',
            IsPrimary: true,
            Name: v.title,
            ManagedContentKey: v.contentKey,
            ContentTypeFullyQualifiedName: type,
            ManagedContent: { ApiName: v.apiName, AuthoredManagedContentSpaceId: workspace.id },
          })),
      };
    }
    if (url === '/connect/cms/contents' && input.method === 'POST') {
      const upload = parseMultipart(input);
      assert.equal(upload.jsonName, 'ManagedContentInputParam');
      counter += 1;
      const native = withFile(
        {
          apiName: upload.json.apiName,
          title: upload.json.title,
          urlName: upload.json.urlName,
          contentKey: `MC${'Y'.repeat(25)}${String.fromCodePoint(64 + counter)}`,
          contentType: { fullyQualifiedName: upload.json.contentType },
          folder: { id: upload.json.contentSpaceOrFolderId },
          language: 'en_US',
          managedContentId: `20Y00000000000${counter}AAA`,
          managedContentVariantId: `9Ps00000000000${counter}AAA`,
          isPublished: false,
        },
        upload,
      );
      variants.set(native.managedContentVariantId, native);
      return structuredClone(native);
    }
    const id = /^\/connect\/cms\/contents\/variants\/(\w+)$/u.exec(url)?.[1];
    if (id && variants.has(id)) {
      if (input.method === 'DELETE') {
        variants.delete(id);
        return;
      }
      if (input.method === 'PUT') {
        const upload = parseMultipart(input);
        assert.equal(upload.jsonName, 'ManagedContentVariantInputParam');
        const current = variants.get(id);
        counter += 1;
        variants.set(
          id,
          withFile({ ...current, title: upload.json.title, urlName: upload.json.urlName }, upload),
        );
      }
      return structuredClone(variants.get(id));
    }
    throw Object.assign(new Error('not found'), {
      errorCode: 'VARIANT_NOT_FOUND',
      statusCode: 404,
    });
  };
  serveMedia(media);
  return { answer, variants, media };
}

async function run(Command, argv, org, directory) {
  const connection = Object.assign(fakeConnection(org.answer), { instanceUrl: INSTANCE });
  class Fake extends Command {
    resolveOrg = async () => ({
      connection,
      orgId: '00D000000000001AAA',
      username: 'u@example.com',
    });
    writeOptions = { allowCallerConnection: true };
  }
  const cwd = process.cwd();
  process.chdir(directory);
  process.exitCode = undefined;
  try {
    const result = await Fake.run([...argv, '--workspace', WS, '--json'], config);
    const writes = connection.calls.filter((call) => call.input.method !== 'GET');
    return { result, writes, exitCode: process.exitCode };
  } finally {
    process.exitCode = undefined;
    process.chdir(cwd);
  }
}

const outcomes = (result) => result.result.items.map((item) => [item.apiName, item.outcome]);

for (const [type, , apiName, fileName] of CASES) {
  test(`${type} pipeline: preview, create, unchanged, bytes-only and metadata-only update`, async () => {
    const directory = await scratch();
    const files = await readSourceFiles(golden, WS, type, apiName);
    await writeSourceFiles(directory, WS, files);
    const org = fakeOrg();
    const selector = ['-m', `${type}:${apiName}`];

    const preview = await run(Deploy, [...selector, '--preview'], org, directory);
    assert.deepEqual(outcomes(preview.result), [[apiName, 'create']]);
    assert.equal(preview.writes.length, 0);

    const created = await run(Deploy, selector, org, directory);
    assert.deepEqual(outcomes(created.result), [[apiName, 'created']]);
    assert.deepEqual(created.result.diagnostics, { warnings: [], errors: [] });
    assert.equal(created.writes.length, 1);
    const create = parseMultipart(created.writes[0].input);
    assert.equal(create.json.contentType, `sfdc_cms__${type}`);
    assert.equal(create.json.contentSpaceOrFolderId, workspace.rootFolderId);
    assert.equal(create.json.title, files.document.title);
    assert.deepEqual(create.json.contentBody['sfdc_cms:media'], { source: { type: 'file' } });
    assert.equal(create.fileName, fileName);
    assert.equal(create.mimeType, files.document.contentBody['sfdc_cms:media'].source.mimeType);
    assert.deepEqual(create.bytes, Buffer.from(files.companions[`.${fileName}`]));

    const unchanged = await run(Deploy, selector, org, directory);
    assert.deepEqual(outcomes(unchanged.result), [[apiName, 'unchanged']]);
    assert.equal(unchanged.writes.length, 0);

    const newBytes = Buffer.concat([
      Buffer.from(files.companions[`.${fileName}`]),
      Buffer.from([0]),
    ]);
    await writeFile(
      path.join(directory, 'cms', WS, type, `${apiName}.${type}.${fileName}`),
      newBytes,
    );
    const bytesUpdate = await run(Deploy, selector, org, directory);
    assert.deepEqual(outcomes(bytesUpdate.result), [[apiName, 'updated']]);
    assert.deepEqual(bytesUpdate.result.result.items[0].changes, [`.${fileName}`]);
    assert.deepEqual(bytesUpdate.result.diagnostics.warnings, []);
    assert.equal(bytesUpdate.writes[0].input.method, 'PUT');
    assert.deepEqual(parseMultipart(bytesUpdate.writes[0].input).bytes, newBytes);

    const edited = await readSourceFiles(directory, WS, type, apiName);
    edited.document.title = `${files.document.title} 2`;
    await writeSourceFiles(directory, WS, edited);
    const metadataUpdate = await run(Deploy, selector, org, directory);
    assert.deepEqual(outcomes(metadataUpdate.result), [[apiName, 'updated']]);
    assert.deepEqual(metadataUpdate.result.result.items[0].changes, ['title']);
    assert.deepEqual(metadataUpdate.result.diagnostics.warnings, []);
    const update = parseMultipart(metadataUpdate.writes[0].input);
    assert.equal(update.json.title, `${files.document.title} 2`);
    assert.deepEqual(update.bytes, newBytes);

    const output = await scratch();
    const connection = Object.assign(fakeConnection(org.answer), { instanceUrl: INSTANCE });
    class FakeRetrieve extends Retrieve {
      resolveOrg = async () => ({ connection, orgId: '00D000000000001AAA', username: 'u' });
    }
    process.exitCode = undefined;
    await FakeRetrieve.run(
      [...selector, '--workspace', WS, '--output-dir', output, '--json'],
      config,
    );
    const typeFolder = (base) => path.join(base, 'cms', WS, type);
    for (const name of await readdir(typeFolder(directory)))
      assert.deepEqual(
        await readFile(path.join(typeFolder(output), name)),
        await readFile(path.join(typeFolder(directory), name)),
        name,
      );
  });
}

test('delete of a media component removes its JSON and its file after the readback', async () => {
  const directory = await scratch();
  await writeSourceFiles(directory, WS, await readSourceFiles(golden, WS, 'image', 'Golden_Image'));
  const org = fakeOrg();
  const selector = ['-m', 'image:Golden_Image'];
  await run(Deploy, selector, org, directory);
  const preview = await run(Delete, [...selector, '--preview'], org, directory);
  assert.deepEqual(
    preview.result.result.items[0].localFiles.map((file) => path.basename(file.path)),
    ['Golden_Image.image.golden-image.png', 'Golden_Image.image.json'],
  );
  assert.equal(preview.writes.length, 0);
  const deleted = await run(Delete, selector, org, directory);
  assert.deepEqual(outcomes(deleted.result), [['Golden_Image', 'deleted']]);
  assert.deepEqual(await readdir(path.join(directory, 'cms', WS, 'image')), []);
});

test('a download that does not match the stated hash is MEDIA_DOWNLOAD_FAILED', async () => {
  const native = await nativeOf('image');
  serveMedia(
    new Map([
      ['MCGOLDENIMAGEAAAAAAAAAAAAAAA', { bytes: Buffer.alloc(73, 1), mimeType: 'image/png' }],
    ]),
  );
  await assert.rejects(
    mediaOf({ request: () => {}, instanceUrl: INSTANCE }, imageHandler, native),
    { code: 'MEDIA_DOWNLOAD_FAILED', message: /MD5/u },
  );
  assert.equal(
    await mediaOf({ request: () => {} }, imageHandler, await nativeOf('image-url')),
    undefined,
  );
});

test('a variant without a stated file size fails with a clear message', async () => {
  const native = structuredClone(await nativeOf('image'));
  const { source } = native.contentBody['sfdc_cms:media'];
  delete source.size;
  delete source.fileSize;
  await assert.rejects(
    mediaOf({ request: () => {}, instanceUrl: INSTANCE }, imageHandler, native),
    { code: 'MEDIA_DOWNLOAD_FAILED', message: /states no file size/u },
  );
});
