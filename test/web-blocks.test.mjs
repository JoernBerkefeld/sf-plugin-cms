import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Config } from '@oclif/core';
import Delete from '../lib/commands/cms/delete.js';
import Deploy from '../lib/commands/cms/deploy.js';
import Publish from '../lib/commands/cms/publish.js';
import Unpublish from '../lib/commands/cms/unpublish.js';
import { consentBannerHandler } from '../lib/content/handlers/consent-banner.js';
import { formHandlerHandler } from '../lib/content/handlers/form-handler.js';
import { formHandler } from '../lib/content/handlers/form.js';
import { webFragmentHandler } from '../lib/content/handlers/web-fragment.js';
import { resolveReferences } from '../lib/content/json-source.js';
import { handlerOf } from '../lib/content/registry.js';
import { readSourceFiles, writeSourceFiles } from '../lib/content/source-files.js';
import { dataGraphReferences } from '../lib/services/data-graph-check.js';
import { envelopeOf } from '../lib/services/deploy.js';
import { fakeConnection } from './support/fake-connection.mjs';
import { fakeOrg, workspace } from './support/fake-org.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const golden = path.join(here, 'fixtures', 'golden');
const WS = workspace.apiName;
const IMAGE_KEY = 'MCGOLDENIAAAAAAAAAAAAAAAAAAA';
const scratch = () => mkdtemp(path.join(os.tmpdir(), 'sf-plugin-cms-v1-web-blocks-'));

/** The four content block types of X2a with their golden API names. */
const TYPES = [
  [webFragmentHandler, 'sfdc_cms__webFragment', 'web-fragment', 'Golden_Web_Fragment'],
  [consentBannerHandler, 'sfdc_cms__consentBanner', 'consent-banner', 'Golden_Consent_Banner'],
  [formHandlerHandler, 'sfdc_cms__formHandler', 'form-handler', 'Golden_Form_Handler'],
  [formHandler, 'sfdc_cms__form', 'form', 'Golden_Form'],
];

const nativeOf = async (type) =>
  JSON.parse(await readFile(path.join(here, 'fixtures', 'native', `${type}.variant.json`), 'utf8'));
const goldenOf = (type, apiName) => readSourceFiles(golden, WS, type, apiName);
const retrieveContext = (overrides = {}) => ({
  workspace,
  folderPath: [],
  referenceOf: () => {},
  warn: (warning) => assert.fail(`unexpected warning ${warning.code}`),
  ...overrides,
});

let config;
before(async () => {
  config = await Config.load(root);
});

async function run(Command, argv, org, directory) {
  const connection = fakeConnection(org.answer);
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

async function sourceFilesIn(directory) {
  const entries = [];
  const walk = async (current) => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory() && entry.name !== 'logs') await walk(full);
      else if (!entry.isDirectory()) entries.push(full);
    }
  };
  await walk(directory);
  return entries;
}

const outcomes = (result) => result.result.items.map((item) => [item.apiName, item.outcome]);

for (const [handler, contentType, type, apiName] of TYPES) {
  test(`${type}: registered as a JSON handler for ${contentType}`, () => {
    assert.equal(handlerOf(type), handler);
    assert.equal(handler.apiName, contentType);
    assert.equal(handler.transport, 'json');
  });

  test(`golden ${type}: native -> one JSON file -> native body back`, async () => {
    const native = await nativeOf(type);
    const files = handler.toSource(native, retrieveContext());
    assert.deepEqual(files.companions, {});
    const written = await writeSourceFiles(await scratch(), WS, files);
    assert.equal(
      await readFile(written.path, 'utf8'),
      await readFile(path.join(golden, 'cms', WS, type, `${apiName}.${type}.json`), 'utf8'),
    );
    const payload = handler.fromSource(await goldenOf(type, apiName), { workspace });
    assert.deepEqual(envelopeOf(payload, payload.contentBody), {
      apiName: native.apiName,
      title: native.title,
      urlName: native.urlName,
    });
    assert.deepEqual(payload.createOnly, {});
    assert.deepEqual(payload.contentBody, native.contentBody);
    assert.deepEqual(handler.references(payload), []);
  });

  test(`${type} round trip: create, unchanged with no write, update, publish, unpublish, delete`, async () => {
    const files = await goldenOf(type, apiName);
    const directory = await scratch();
    await writeSourceFiles(directory, WS, files);
    const org = fakeOrg();
    const selector = ['-m', `${type}:${apiName}`];

    const created = await run(Deploy, selector, org, directory);
    assert.equal(created.result.status, 'success');
    assert.deepEqual(outcomes(created.result), [[apiName, 'created']]);
    assert.equal(created.writes.length, 1);
    const create = JSON.parse(created.writes[0].input.body);
    assert.equal(create.contentType, contentType);
    assert.deepEqual(create.contentBody, files.document.contentBody);

    const unchanged = await run(Deploy, selector, org, directory);
    assert.deepEqual(outcomes(unchanged.result), [[apiName, 'unchanged']]);
    assert.equal(unchanged.writes.length, 0);

    const edited = structuredClone(files);
    edited.document.contentBody['sfdc_cms:title'] = `${apiName} edited`;
    await writeSourceFiles(directory, WS, edited);
    const updated = await run(Deploy, selector, org, directory);
    assert.deepEqual(outcomes(updated.result), [[apiName, 'updated']]);
    assert.equal(updated.writes.length, 1);
    assert.equal(updated.writes[0].input.method, 'PUT');

    const id = [...org.variants.values()][0].managedContentVariantId;
    const published = await run(Publish, selector, org, directory);
    assert.deepEqual(outcomes(published.result), [[apiName, 'published']]);
    assert.equal(org.variants.get(id).isPublished, true);
    const unpublished = await run(Unpublish, selector, org, directory);
    assert.deepEqual(outcomes(unpublished.result), [[apiName, 'unpublished']]);
    assert.equal(org.variants.get(id).isPublished, false);
    const deleted = await run(Delete, selector, org, directory);
    assert.deepEqual(outcomes(deleted.result), [[apiName, 'deleted']]);
    assert.equal(org.variants.has(id), false);
    assert.deepEqual(await sourceFilesIn(directory), []);
  });
}

test('form handler: the body is only the empty root block, nothing else to deploy', async () => {
  const payload = formHandlerHandler.fromSource(
    await goldenOf('form-handler', 'Golden_Form_Handler'),
    {
      workspace,
    },
  );
  assert.deepEqual(payload.contentBody['sfdc_cms:block'].children, []);
  assert.deepEqual(dataGraphReferences(payload.contentBody), []);
});

test('form: runtime placeholders stay as text; the data graph provider is checked', async () => {
  const payload = formHandler.fromSource(await goldenOf('form', 'Golden_Form'), { workspace });
  assert.equal(payload.contentBody.formsubmission.actions[0].attributes.formId, '{!$form.id}');
  assert.deepEqual(dataGraphReferences(payload.contentBody), [
    { dataGraphApiName: 'Marketing', dataspace: 'default' },
  ]);
});

test('web fragment: an image block becomes { type, apiName } and back to the destination key', async () => {
  const native = await nativeOf('web-fragment');
  const image = {
    attributes: {
      imageInfo: {
        altText: 'Golden',
        source: { type: 'imageReference', ref: { contentKey: IMAGE_KEY } },
        url: `/cms/media/${IMAGE_KEY}?version=1`,
      },
    },
    definition: 'lightning/image',
    id: '0f0e0d0c-0b0a-4909-8807-060504030201',
    type: 'block',
  };
  native.contentBody['sfdc_cms:block'].children[0].children[0].children.push(image);
  const files = webFragmentHandler.toSource(
    native,
    retrieveContext({
      referenceOf: (key) =>
        key === IMAGE_KEY ? { type: 'image', apiName: 'Golden_Image' } : undefined,
    }),
  );
  const stored = files.document.contentBody['sfdc_cms:block'].children[0].children[0].children[0];
  assert.deepEqual(stored.attributes.imageInfo, {
    altText: 'Golden',
    source: {
      type: 'imageReference',
      ref: { contentKey: { type: 'image', apiName: 'Golden_Image' } },
    },
  });
  const payload = webFragmentHandler.fromSource(files, { workspace });
  assert.deepEqual(webFragmentHandler.references(payload), [
    { type: 'image', apiName: 'Golden_Image' },
  ]);
  const body = resolveReferences(payload.contentBody, () => 'MCDESTINATIONIMAGEAAAAAAAAAA');
  assert.equal(
    body['sfdc_cms:block'].children[0].children[0].children[0].attributes.imageInfo.source.ref
      .contentKey,
    'MCDESTINATIONIMAGEAAAAAAAAAA',
  );
});
