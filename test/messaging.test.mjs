import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Config } from '@oclif/core';
import Delete from '../lib/commands/cms/delete.js';
import Deploy from '../lib/commands/cms/deploy.js';
import Publish from '../lib/commands/cms/publish.js';
import Unpublish from '../lib/commands/cms/unpublish.js';
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
const WS = 'Default_Content_Workspace';
const IMAGE_KEY = 'MCGOLDENXZEROARAAAAAAAAAAAAA';
const scratch = () => mkdtemp(path.join(os.tmpdir(), 'sf-plugin-cms-x3-messaging-'));

/** The messaging types of X3: CLI type, Salesforce type and the golden API name. */
const TYPES = [
  ['sms', 'sfdc_cms__sms', 'Golden_Sms'],
  ['push-notification', 'sfdc_cms__pushNotification', 'MCGOLDENXZEROAKAAAAAAAAAAAAA'],
  ['in-app', 'sfdc_cms__inApp', 'Golden_In_App'],
  ['rcs', 'sfdc_cms__rcs', 'Golden_Rcs'],
  ['whatsapp-session', 'sfdc_cms__whatsappSession', 'MCGOLDENXZEROANAAAAAAAAAAAAA'],
];

const nativeOf = async (type) =>
  JSON.parse(await readFile(path.join(here, 'fixtures', 'native', `${type}.variant.json`), 'utf8'));

/** The Golden_Image the in-app message references, stored in the destination root. */
const destinationImage = {
  apiName: 'Golden_Image',
  title: 'Golden Image',
  contentBody: {},
  contentKey: 'MCDESTINATIONIMAGEAAAAAAAAAA',
  contentType: { fullyQualifiedName: 'sfdc_cms__image' },
  folder: { id: workspace.rootFolderId },
  managedContentId: '20Y000000000090AAA',
  managedContentVariantId: '9Ps000000000090AAA',
};

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
    return { result, writes };
  } finally {
    process.exitCode = undefined;
    process.chdir(cwd);
  }
}

const outcomes = (result) => result.result.items.map((item) => [item.apiName, item.outcome]);

for (const [type, apiName, name] of TYPES) {
  const handler = handlerOf(type);
  const goldenFiles = () => readSourceFiles(golden, WS, type, name);

  test(`${type}: registered as JSON for ${apiName}`, () => {
    assert.equal(handler.type, type);
    assert.equal(handler.apiName, apiName);
    assert.equal(handler.transport, 'json');
  });

  test(`golden ${type}: native -> one JSON file, then back to the native body`, async () => {
    const native = await nativeOf(type);
    const files = handler.toSource(native, {
      workspace,
      folderPath: [],
      referenceOf: (key) =>
        key === IMAGE_KEY ? { type: 'image', apiName: 'Golden_Image' } : undefined,
      warn: (warning) => assert.fail(`unexpected warning ${warning.code}`),
    });
    assert.deepEqual(files.companions, {});
    const written = await writeSourceFiles(await scratch(), WS, files);
    assert.equal(
      await readFile(written.path, 'utf8'),
      await readFile(path.join(golden, 'cms', WS, type, `${name}.${type}.json`), 'utf8'),
    );

    const payload = handler.fromSource(await goldenFiles(), { workspace });
    assert.deepEqual(envelopeOf(payload, payload.contentBody), {
      apiName: native.apiName,
      title: native.title,
      urlName: native.urlName,
    });
    assert.deepEqual(payload.createOnly, {});
    assert.deepEqual(dataGraphReferences(payload.contentBody), [
      { dataGraphApiName: 'Marketing', dataspace: 'default' },
    ]);
    const expected = structuredClone(native.contentBody);
    if (type === 'in-app') {
      assert.deepEqual(handler.references(payload), [{ type: 'image', apiName: 'Golden_Image' }]);
      // The derived media URL next to the image reference is not kept in the file.
      delete expected.inAppBlock.attributes.media.attributes.content.attributes.link.url;
    } else assert.deepEqual(handler.references(payload), []);
    assert.deepEqual(
      resolveReferences(payload.contentBody, () => IMAGE_KEY),
      expected,
    );
  });

  test(`${type} fromSource refuses companion files and unknown envelope fields`, async () => {
    const files = await goldenFiles();
    for (const candidate of [
      { ...files, companions: { '.txt': 'x' } },
      { ...files, document: { ...files.document, isDefault: true } },
    ])
      assert.throws(() => handler.fromSource(candidate, { workspace }), {
        code: 'UNKNOWN_SETTING',
      });
  });

  test(`${type} deploy and lifecycle: create, unchanged, update, publish, unpublish, delete`, async () => {
    const directory = await scratch();
    await writeSourceFiles(directory, WS, await goldenFiles());
    const org = fakeOrg({ variants: [destinationImage] });
    const selector = ['-m', `${type}:${name}`];

    const created = await run(Deploy, selector, org, directory);
    assert.deepEqual(outcomes(created.result), [[name, 'created']]);
    const create = created.writes.find((call) => call.input.url === '/connect/cms/contents');
    const sent = JSON.parse(create.input.body);
    assert.equal(sent.contentType, apiName);
    if (type === 'in-app')
      assert.equal(
        sent.contentBody.inAppBlock.attributes.media.attributes.content.attributes.link.source.ref
          .contentKey,
        destinationImage.contentKey,
      );

    const unchanged = await run(Deploy, selector, org, directory);
    assert.deepEqual(outcomes(unchanged.result), [[name, 'unchanged']]);
    assert.deepEqual(unchanged.writes, []);

    const file = path.join(directory, 'cms', WS, type, `${name}.${type}.json`);
    const document = JSON.parse(await readFile(file, 'utf8'));
    document.contentBody['sfdc_cms:title'] = `${document.contentBody['sfdc_cms:title']} v2`;
    await writeFile(file, `${JSON.stringify(document, undefined, 2)}\n`);
    const updated = await run(Deploy, selector, org, directory);
    assert.deepEqual(outcomes(updated.result), [[name, 'updated']]);

    const id = [...org.variants.values()].find((v) => v.apiName === name).managedContentVariantId;
    const published = await run(Publish, selector, org, directory);
    assert.deepEqual(outcomes(published.result), [[name, 'published']]);
    assert.equal(org.variants.get(id).isPublished, true);
    const unpublished = await run(Unpublish, selector, org, directory);
    assert.deepEqual(outcomes(unpublished.result), [[name, 'unpublished']]);
    const deleted = await run(Delete, selector, org, directory);
    assert.deepEqual(outcomes(deleted.result), [[name, 'deleted']]);
    assert.equal(org.variants.has(id), false);
  });
}
