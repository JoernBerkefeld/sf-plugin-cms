import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  downloadExperimentalCmsMedia,
  isApprovedSalesforceMediaUrl,
} from '../lib/transport/experimental-media.js';

const instanceUrl = 'https://example.my.salesforce.com';
const source = new URL(`${instanceUrl}/cms/media/abc?fileName=a.png`);
const bytes = Buffer.from([1, 2, 3, 4, 5]);
const md5 = createHash('md5').update(bytes).digest('hex');

async function scratch() {
  return mkdtemp(path.join(os.tmpdir(), 'sf-plugin-cms-v1-media-'));
}

/**
 * A fetch double answering from a list of responses, recording URL and authorization.
 * @param {Response[]} responses Answers in order.
 * @returns {{ fetch: Function; calls: Array<{ url: string; authorization?: string }> }} Double.
 */
function fakeFetch(responses) {
  const calls = [];
  return {
    calls,
    fetch: async (url, init) => {
      calls.push({ url: String(url), authorization: init.headers.authorization });
      return responses.shift();
    },
  };
}

const options = (directory, fetch) => ({
  accessToken: 'TOKEN',
  instanceUrl,
  expectedMd5: md5,
  expectedMimeType: 'image/png',
  expectedSize: bytes.length,
  outputFile: path.join(directory, 'a.png'),
  fetch,
});

test('only HTTPS subdomains of file.force.com are approved media hosts', () => {
  assert.equal(isApprovedSalesforceMediaUrl('https://org.file.force.com/x'), true);
  for (const url of [
    'http://org.file.force.com/x',
    'https://file.force.com/x',
    'https://org.file.force.com.evil.test/x',
    'https://user:pass@org.file.force.com/x',
    'https://org.file.force.com:8443/x',
    'https://evilfile.force.com/x',
  ])
    assert.equal(isApprovedSalesforceMediaUrl(url), false, url);
});

test('downloads through an approved redirect and checks size and MD5', async () => {
  const directory = await scratch();
  const double = fakeFetch([
    new Response(null, { status: 302, headers: { location: 'https://org.file.force.com/f' } }),
    new Response(bytes, { status: 200, headers: { 'content-type': 'image/png' } }),
  ]);
  const result = await downloadExperimentalCmsMedia(source, options(directory, double.fetch));
  assert.equal(result.bytes, 5);
  assert.deepEqual(await readFile(path.join(directory, 'a.png')), bytes);
  assert.deepEqual(
    double.calls.map((call) => call.url),
    [source.href, 'https://org.file.force.com/f'],
  );
});

test('the token never goes to a host outside the allowlist', async () => {
  const directory = await scratch();
  const double = fakeFetch([
    new Response(null, { status: 302, headers: { location: 'https://evil.test/steal' } }),
  ]);
  await assert.rejects(
    downloadExperimentalCmsMedia(source, options(directory, double.fetch)),
    /outside the approved Salesforce class/u,
  );
  assert.equal(double.calls.length, 1);
  await assert.rejects(
    downloadExperimentalCmsMedia(
      new URL('https://other.my.salesforce.com/cms/media/abc?fileName=a.png'),
      options(directory, double.fetch),
    ),
    /authenticated Salesforce instance/u,
  );
  await assert.rejects(
    downloadExperimentalCmsMedia(
      new URL(`${instanceUrl}/services/data?fileName=a.png`),
      options(directory, double.fetch),
    ),
    /path is unsupported/u,
  );
  assert.equal(double.calls.length, 1);
});

test('too many redirects, login HTML and an MD5 mismatch fail and leave no file', async () => {
  const directory = await scratch();
  const loop = () =>
    new Response(null, { status: 302, headers: { location: 'https://org.file.force.com/r' } });
  await assert.rejects(
    downloadExperimentalCmsMedia(
      source,
      options(directory, fakeFetch([loop(), loop(), loop(), loop()]).fetch),
    ),
    /redirect count exceeded/u,
  );
  await assert.rejects(
    downloadExperimentalCmsMedia(
      source,
      options(
        directory,
        fakeFetch([new Response('<html>', { headers: { 'content-type': 'text/html' } })]).fetch,
      ),
    ),
    /not binary image content/u,
  );
  await assert.rejects(
    downloadExperimentalCmsMedia(source, {
      ...options(
        directory,
        fakeFetch([new Response(bytes, { headers: { 'content-type': 'image/png' } })]).fetch,
      ),
      expectedMd5: '0'.repeat(32),
    }),
    /MD5 differs/u,
  );
  await assert.rejects(readFile(path.join(directory, 'a.png')), { code: 'ENOENT' });
});
