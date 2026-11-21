import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { vcfHandler } from '../lib/content/handlers/vcf.js';
import { readSourceFiles } from '../lib/content/source-files.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const golden = path.join(here, 'fixtures', 'golden');
const WS = 'Default_Content_Workspace';
const workspace = { apiName: WS, id: '0Zu000000000001AAA' };
const native = async () =>
  JSON.parse(await readFile(path.join(here, 'fixtures', 'native', 'vcf.variant.json'), 'utf8'));
const context = (bytes) => ({
  workspace,
  folderPath: [],
  referenceOf: () => {},
  warn: (warning) => assert.fail(`unexpected warning ${warning.code}`),
  media: { fileName: 'golden.vcf', bytes },
});
const OTHER = 'BEGIN:VCARD\nVERSION:3.0\nFN:Someone Else\nEND:VCARD';

test('vcf retrieve: vcfData equal to the file is left out of the JSON', async () => {
  const variant = await native();
  const files = vcfHandler.toSource(
    variant,
    context(new Uint8Array(Buffer.from(variant.contentBody.vcfData))),
  );
  assert.equal(files.document.contentBody.vcfData, undefined);
  assert.deepEqual(Object.keys(files.companions), ['.golden.vcf']);
});

test('vcf retrieve: vcfData that differs from the file stays in the JSON', async () => {
  const variant = await native();
  variant.contentBody.vcfData = OTHER;
  const bytes = await readFile(path.join(golden, 'cms', WS, 'vcf', 'Golden_Vcf.vcf.golden.vcf'));
  const files = vcfHandler.toSource(variant, context(new Uint8Array(bytes)));
  assert.equal(files.document.contentBody.vcfData, OTHER);
});

test('vcf deploy: vcfData is filled from the file, or sent as the JSON holds it', async () => {
  const files = await readSourceFiles(golden, WS, 'vcf', 'Golden_Vcf');
  const fileText = Buffer.from(files.companions['.golden.vcf']).toString('utf8');
  assert.equal(vcfHandler.fromSource(files, { workspace }).contentBody.vcfData, fileText);
  files.document.contentBody = { ...files.document.contentBody, vcfData: OTHER };
  assert.equal(vcfHandler.fromSource(files, { workspace }).contentBody.vcfData, OTHER);
  assert.equal(vcfHandler.type, 'vcf');
  assert.equal(vcfHandler.apiName, 'sfdc_cms__vcf');
  assert.equal(vcfHandler.transport, 'multipart');
});
