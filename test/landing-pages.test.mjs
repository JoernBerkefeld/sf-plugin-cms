import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Config } from '@oclif/core';
import Delete from '../lib/commands/cms/delete.js';
import Deploy from '../lib/commands/cms/deploy.js';
import Publish from '../lib/commands/cms/publish.js';
import Unpublish from '../lib/commands/cms/unpublish.js';
import { landingPageTemplateHandler } from '../lib/content/handlers/landing-page-template.js';
import { landingPageHandler } from '../lib/content/handlers/landing-page.js';
import { preferencePageHandler } from '../lib/content/handlers/preference-page.js';
import { resolveReferences } from '../lib/content/json-source.js';
import { handlerOf } from '../lib/content/registry.js';
import { readSourceFiles, writeSourceFiles } from '../lib/content/source-files.js';
import { fakeConnection } from './support/fake-connection.mjs';
import { fakeOrg, salesforceError, workspace } from './support/fake-org.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const golden = path.join(here, 'fixtures', 'golden');
const WS = workspace.apiName;
const scratch = () => mkdtemp(path.join(os.tmpdir(), 'sf-plugin-cms-v1-landing-pages-'));
const nativeOf = async (type) =>
  JSON.parse(await readFile(path.join(here, 'fixtures', 'native', `${type}.variant.json`), 'utf8'));
const goldenOf = (type, apiName) => readSourceFiles(golden, WS, type, apiName);

/** Native keys of the samples and the golden names they stand for. */
const FRAGMENT_KEY = 'MCGOLDENXZEROADAAAAAAAAAAAAA';
const TEMPLATE_KEY = 'MCGOLDENXZEROAHAAAAAAAAAAAAA';
const IMAGE_LETTERS = 'QRSTUVWXY';
const imageKey = (letter) => `MCGOLDENXZEROA${letter}AAAAAAAAAAAAA`;
const NAMES = new Map([
  [FRAGMENT_KEY, { type: 'web-fragment', apiName: 'Golden_Web_Fragment' }],
  [TEMPLATE_KEY, { type: 'landing-page-template', apiName: 'Golden_Landing_Page_Template' }],
  ...[...IMAGE_LETTERS].map((l) => [
    imageKey(l),
    { type: 'image', apiName: `Golden_LP_Image_${l}` },
  ]),
]);
const keyOf = (reference) =>
  [...NAMES].find(
    ([, name]) => name.type === reference.type && name.apiName === reference.apiName,
  )?.[0];

/**
 * The native body without the derived media `url` next to a `source.ref` (retrieve drops it).
 * @param {unknown} value Native value.
 * @returns {unknown} The value without derived URLs.
 */
function withoutDerivedUrls(value) {
  if (Array.isArray(value)) return value.map((item) => withoutDerivedUrls(item));
  if (value === null || typeof value !== 'object') return value;
  const result = {};
  for (const [key, child] of Object.entries(value))
    if (!(key === 'url' && value.source?.ref)) result[key] = withoutDerivedUrls(child);
  return result;
}

let config;
before(async () => {
  config = await Config.load(root);
});

async function run(Command, argv, org, directory) {
  const connection = fakeConnection(org.answer);
  const lines = [];
  class Fake extends Command {
    resolveOrg = async () => ({
      connection,
      orgId: '00D000000000001AAA',
      username: 'u@example.com',
    });
    writeOptions = { allowCallerConnection: true };
    log = (message = '') => {
      lines.push(message);
    };
  }
  const cwd = process.cwd();
  process.chdir(directory);
  process.exitCode = undefined;
  try {
    const result = await Fake.run([...argv, '--workspace', WS, '--json'], config);
    const writes = connection.calls.filter((call) => call.input.method !== 'GET');
    return { result, writes, lines };
  } finally {
    process.exitCode = undefined;
    process.chdir(cwd);
  }
}

const outcomes = (result) => result.result.items.map((item) => [item.apiName, item.outcome]);

/**
 * A destination image per golden image name, so the image references resolve.
 * @returns {Promise<object[]>} Native image variants.
 */
async function imagesInDestination() {
  const image = await nativeOf('image');
  return [...IMAGE_LETTERS].map((letter, index) => ({
    ...structuredClone(image),
    apiName: `Golden_LP_Image_${letter}`,
    contentKey: `MCDESTIMAGE${letter}${'A'.repeat(16)}`,
    managedContentId: `20Y00000000090${index}AAA`,
    managedContentVariantId: `9Ps00000000090${index}AAA`,
  }));
}

for (const [handler, contentType, type] of [
  [landingPageTemplateHandler, 'sfdc_cms__landingPageTemplate', 'landing-page-template'],
  [landingPageHandler, 'sfdc_cms__landingPage', 'landing-page'],
  [preferencePageHandler, 'sfdc_cms__preferencePage', 'preference-page'],
])
  test(`${type}: registered as a JSON handler for ${contentType}`, () => {
    assert.equal(handlerOf(type), handler);
    assert.equal(handler.apiName, contentType);
    assert.equal(handler.transport, 'json');
  });

for (const [handler, type, apiName, references] of [
  [landingPageTemplateHandler, 'landing-page-template', 'Golden_Landing_Page_Template', 10],
  [landingPageHandler, 'landing-page', 'Golden_Landing_Page', 11],
])
  test(`golden ${type}: native -> one JSON file with logical references -> native body back`, async () => {
    const native = await nativeOf(type);
    const files = handler.toSource(native, {
      workspace,
      folderPath: [],
      referenceOf: (key) => NAMES.get(key),
      warn: (warning) => assert.fail(`unexpected warning ${warning.code}`),
    });
    assert.deepEqual(files.companions, {});
    const written = await writeSourceFiles(await scratch(), WS, files);
    assert.equal(
      await readFile(written.path, 'utf8'),
      await readFile(path.join(golden, 'cms', WS, type, `${apiName}.${type}.json`), 'utf8'),
    );
    const text = JSON.stringify(files.document.contentBody);
    assert.ok(!/MCGOLDENXZERO/u.test(text), 'no native content key stays in the file');

    const payload = handler.fromSource(await goldenOf(type, apiName), { workspace });
    assert.equal(handler.references(payload).length, references);
    assert.deepEqual(
      resolveReferences(payload.contentBody, keyOf),
      withoutDerivedUrls(native.contentBody),
    );
  });

test('web fragment -> template -> page in one deploy: dependency order, destination keys, unchanged, lifecycle', async () => {
  const directory = await scratch();
  for (const [type, apiName] of [
    ['web-fragment', 'Golden_Web_Fragment'],
    ['landing-page-template', 'Golden_Landing_Page_Template'],
    ['landing-page', 'Golden_Landing_Page'],
  ])
    await writeSourceFiles(directory, WS, await goldenOf(type, apiName));
  const org = fakeOrg({ variants: await imagesInDestination() });
  // Page first on the command line: the order comes from the references.
  const selector = [
    '-m',
    'landing-page:Golden_Landing_Page',
    '-m',
    'landing-page-template:Golden_Landing_Page_Template',
    '-m',
    'web-fragment:Golden_Web_Fragment',
  ];

  const preview = await run(Deploy, [...selector, '--preview'], org, directory);
  assert.deepEqual(outcomes(preview.result), [
    ['Golden_Web_Fragment', 'create'],
    ['Golden_Landing_Page_Template', 'planned-dependencies'],
    ['Golden_Landing_Page', 'planned-dependencies'],
  ]);
  assert.equal(preview.writes.length, 0);

  const created = await run(Deploy, selector, org, directory);
  assert.equal(created.result.status, 'success');
  assert.deepEqual(outcomes(created.result), [
    ['Golden_Web_Fragment', 'created'],
    ['Golden_Landing_Page_Template', 'created'],
    ['Golden_Landing_Page', 'created'],
  ]);
  const [fragmentKey, templateKey] = created.result.result.items.map((item) => item.contentKey);
  const template = JSON.parse(created.writes[1].input.body).contentBody;
  const page = JSON.parse(created.writes[2].input.body).contentBody;
  assert.equal(page['sfdc_cms:template'].definition, templateKey, 'bare destination template key');
  for (const body of [template, page]) {
    const text = JSON.stringify(body);
    assert.ok(text.includes(`"@cms/${fragmentKey}"`), 'destination fragment key as @cms/');
    assert.ok(text.includes('"MCDESTIMAGEQAAAAAAAAAAAAAAAA"'), 'destination image key');
    assert.ok(
      !/MCGOLDENXZERO|"type":"image","apiName"/u.test(text),
      'no source key or file value left',
    );
  }
  // A created item that waited on another one prints the dependency, not "undefined after".
  const pageLine = created.lines.find((line) => line.startsWith('created landing-page:'));
  assert.match(
    pageLine,
    /\(after: web-fragment:Golden_Web_Fragment, landing-page-template:Golden_Landing_Page_Template\)/u,
  );
  assert.ok(!created.lines.some((line) => line.includes('undefined')));
  assert.ok(
    preview.lines.some((line) => line.includes('(create after: web-fragment:Golden_Web_Fragment)')),
    'the preview still names the planned action',
  );

  const unchanged = await run(Deploy, selector, org, directory);
  assert.deepEqual(
    unchanged.result.result.items.map((item) => item.outcome),
    ['unchanged', 'unchanged', 'unchanged'],
  );
  assert.equal(unchanged.writes.length, 0);

  const pageOnly = ['-m', 'landing-page:Golden_Landing_Page'];
  const id = created.result.result.items[2].variantId;
  const publishd = await run(Publish, pageOnly, org, directory);
  assert.deepEqual(outcomes(publishd.result), [['Golden_Landing_Page', 'published']]);
  assert.equal(org.variants.get(id).isPublished, true);
  const unpublishd = await run(Unpublish, pageOnly, org, directory);
  assert.deepEqual(outcomes(unpublishd.result), [['Golden_Landing_Page', 'unpublished']]);
  const deleted = await run(Delete, selector, org, directory);
  assert.deepEqual(outcomes(deleted.result), [
    ['Golden_Landing_Page', 'deleted'],
    ['Golden_Landing_Page_Template', 'deleted'],
    ['Golden_Web_Fragment', 'deleted'],
  ]);
});

test('preference page: a create Salesforce refuses is reported with its error, nothing is faked', async () => {
  const directory = await scratch();
  const files = {
    type: 'preference-page',
    document: {
      apiName: 'Golden_Preference_Page',
      folderPath: [],
      contentBody: {
        'sfdc_cms:block': {
          children: [],
          definition: 'sfdc_cms/rootContentBlock',
          id: '0b7c2f3e-6a1d-4c55-9a7e-2f1e8c3b5d01',
          type: 'block',
        },
        'sfdc_cms:title': 'Golden_Preference_Page',
      },
    },
    companions: {},
  };
  await writeSourceFiles(directory, WS, files);
  const org = fakeOrg();
  const answer = org.answer;
  org.answer = (input) => {
    if (input.url === '/connect/cms/contents' && input.method === 'POST')
      throw salesforceError(
        400,
        'CONTENT_TYPE_DISABLED_FOR_API',
        "This operation isn't allowed on the sfdc_cms__preferencePage content type.",
      );
    return answer(input);
  };
  const { result } = await run(
    Deploy,
    ['-m', 'preference-page:Golden_Preference_Page'],
    org,
    directory,
  );
  assert.equal(result.status, 'failed');
  assert.deepEqual(outcomes(result), [['Golden_Preference_Page', 'failed']]);
  assert.match(result.diagnostics.errors[0].message, /CONTENT_TYPE_DISABLED_FOR_API/u);
  assert.equal(org.variants.size, 0);
});
