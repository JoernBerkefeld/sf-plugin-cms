import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildMediaCreateMultipart,
  createMediaContent,
} from '../lib/transport/multipart-image-create.js';
import {
  buildImageUpdateMultipart,
  sendVariantUpdateMultipart,
} from '../lib/transport/multipart-image-update.js';
import { buildDocumentUpdateMultipart } from '../lib/transport/multipart-document-update.js';
import { buildAudioUpdateMultipart } from '../lib/transport/multipart-audio-update.js';
import { fakeConnection } from './support/fake-connection.mjs';

const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 255]);
const input = { contentSpaceOrFolderId: '9Pu1', title: 'Logo', apiName: 'Logo' };

test('a create frames the JSON part, then the exact bytes, with the media node set to file', () => {
  const built = buildMediaCreateMultipart('sfdc_cms__image', input, 'logo.png', bytes, {
    boundaryFactory: () => 'b0',
    mimeType: 'image/png',
  });
  const json = JSON.stringify({
    ...input,
    contentType: 'sfdc_cms__image',
    contentBody: { 'sfdc_cms:media': { source: { type: 'file' } } },
  });
  const expected = Buffer.concat([
    Buffer.from(
      `--b0\r\nContent-Disposition: form-data; name="ManagedContentInputParam"\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${json}\r\n--b0\r\nContent-Disposition: form-data; name="contentData"; filename="logo.png"\r\nContent-Type: image/png\r\n\r\n`,
    ),
    Buffer.from(bytes),
    Buffer.from('\r\n--b0--\r\n'),
  ]);
  assert.deepEqual(built.body, expected);
  assert.deepEqual(built.file, { name: 'logo.png', mimeType: 'image/png', byteLength: 8 });
});

test('other fields and contentBody keys are sent as the caller gives them', () => {
  const built = buildImageUpdateMultipart(
    { title: 'T', anyField: 1, contentBody: { altText: 'A', 'sfdc_cms:media': { x: 1 } } },
    'a.png',
    bytes,
  );
  assert.deepEqual(built.input, {
    title: 'T',
    anyField: 1,
    contentBody: { altText: 'A', 'sfdc_cms:media': { x: 1, source: { type: 'file' } } },
  });
  assert.equal(built.file.mimeType, 'application/octet-stream; charset=ISO-8859-1');
  assert.equal(buildDocumentUpdateMultipart({}, 'a.txt', bytes).file.mimeType, 'text/plain');
  assert.equal(
    buildAudioUpdateMultipart({}, 'a.mp3', bytes, { mimeType: 'audio/mpeg' }).file.mimeType,
    'audio/mpeg',
  );
});

test('no size, format or field gates: large bytes and any MIME pass', () => {
  const large = new Uint8Array(11 * 1024 * 1024);
  const built = buildMediaCreateMultipart('sfdc_cms__document', input, 'a.bin', large, {
    mimeType: 'application/x-anything',
  });
  assert.equal(built.file.byteLength, large.byteLength);
});

test('header safety: unsafe file names, MIME values, empty bytes and boundaries are refused', () => {
  for (const name of ['', '..', 'a/b', String.raw`a\b`, 'a"b', 'a\nb', 'ä.png'])
    assert.throws(() => buildImageUpdateMultipart({}, name, bytes), /File name/u, name);
  assert.throws(
    () => buildImageUpdateMultipart({}, 'a.png', bytes, { mimeType: 'image/png\r\nX: y' }),
    /MIME/u,
  );
  assert.throws(() => buildImageUpdateMultipart({}, 'a.png', new Uint8Array()), /empty/u);
  assert.throws(
    () => buildImageUpdateMultipart({}, 'a.png', bytes, { boundaryFactory: () => 'bad boundary' }),
    /Invalid multipart boundary/u,
  );
  assert.throws(
    () => buildMediaCreateMultipart('sfdc_cms__audio', input, 'a.mp3', bytes),
    /MIME type is required/u,
  );
  assert.throws(
    () => buildMediaCreateMultipart('sfdc_cms__image', { title: 'x' }, 'a.png', bytes),
    /contentSpaceOrFolderId/u,
  );
});

test('a boundary that occurs in the content is replaced, with a bounded number of tries', () => {
  const content = Buffer.from('xxcollidexx');
  const candidates = ['collide', 'fresh'];
  const built = buildImageUpdateMultipart({}, 'a.png', content, {
    boundaryFactory: () => candidates.shift(),
  });
  assert.equal(built.boundary, 'fresh');
  assert.throws(
    () =>
      buildImageUpdateMultipart({}, 'a.png', content, {
        boundaryFactory: () => 'collide',
        maxBoundaryAttempts: 3,
      }),
    /collision-free/u,
  );
});

test('create and update send one request each and read the identities back', async () => {
  const connection = fakeConnection((request) =>
    request.method === 'POST'
      ? { contentKey: 'MC1', managedContentId: '20Y1', managedContentVariantId: '9Ps1' }
      : {
          contentBody: {},
          isPublished: false,
          language: 'en_US',
          managedContentId: '20Y1',
          managedContentVariantId: '9Ps1',
        },
  );
  const created = await createMediaContent(
    'sfdc_cms__image',
    connection,
    input,
    'logo.png',
    bytes,
    {
      mimeType: 'image/png',
    },
  );
  assert.deepEqual(created, {
    contentKey: 'MC1',
    managedContentId: '20Y1',
    managedContentVariantId: '9Ps1',
  });
  const updated = await sendVariantUpdateMultipart(
    connection,
    '9Ps1',
    buildImageUpdateMultipart({ title: 'T' }, 'logo.png', bytes),
  );
  assert.equal(updated.managedContentVariantId, '9Ps1');
  assert.equal(connection.calls.length, 2);
  assert.equal(connection.calls[0].input.url, '/connect/cms/contents');
  assert.equal(connection.calls[1].input.method, 'PUT');
  assert.equal(connection.calls[1].input.url, '/connect/cms/contents/variants/9Ps1');
  assert.match(
    connection.calls[0].input.headers['content-type'],
    /^multipart\/form-data; boundary=/u,
  );
  assert.deepEqual(connection.calls[0].options.retry, { maxRetries: 0 });
});

test('an unreadable answer after sending is reported as sent, outcome unknown', async () => {
  const connection = fakeConnection(() => ({ unexpected: true }));
  await assert.rejects(
    createMediaContent('sfdc_cms__audio', connection, input, 'a.mp3', bytes, {
      mimeType: 'audio/mpeg',
    }),
    (error) => error.requestSent === true && error.statusObserved === false,
  );
  await assert.rejects(
    sendVariantUpdateMultipart(connection, '', buildImageUpdateMultipart({}, 'a.png', bytes)),
    (error) => error.requestSent === false,
  );
  assert.equal(connection.calls.length, 1);
});
