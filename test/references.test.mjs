import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  projectJsonVariant,
  recordIdsOf,
  referencedContentKeys,
} from '../lib/content/json-projection.js';
import {
  jsonPayloadFromSource,
  logicalReferences,
  resolveReferences,
} from '../lib/content/json-source.js';
import { readSourceFiles, writeSourceFiles } from '../lib/content/source-files.js';
import { dataGraphReferences } from '../lib/services/data-graph-check.js';
import { deployComponents } from '../lib/services/deploy.js';
import { formHandler } from '../lib/content/handlers/form.js';
import { recordResolver } from '../lib/services/record-references.js';
import { fakeConnection } from './support/fake-connection.mjs';
import { fakeOrg, workspace } from './support/fake-org.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const WS = workspace.apiName;
const TEMPLATE_KEY = 'MCGOLDENXZEROAHAAAAAAAAAAAAA';
const BLOCK_KEY = 'MCGOLDENXZEROADAAAAAAAAAAAAA';
const CAMPAIGN_ID = '701000000000101AAA';
const scratch = () => mkdtemp(path.join(os.tmpdir(), 'sf-plugin-cms-v1-references-'));
const native = async (name) =>
  JSON.parse(await readFile(path.join(here, 'fixtures', 'native', `${name}.variant.json`), 'utf8'));

/**
 * A JSON handler as a type workstream would write it, with optional declarations.
 * @param {string} type CLI type.
 * @param {string} apiName Salesforce content type.
 * @param {object} [declarations] referenceDeclarations.
 * @returns {object} Handler.
 */
function jsonHandler(type, apiName, declarations) {
  return {
    type,
    apiName,
    transport: 'json',
    ...(declarations ? { referenceDeclarations: declarations } : {}),
    toSource: (variant, context) => projectJsonVariant(type, variant, context, {}, declarations),
    fromSource: (files) => jsonPayloadFromSource(files, {}),
    references: (payload) => logicalReferences(payload.contentBody),
  };
}

const trackedLink = jsonHandler('tracked-link', 'sfdc_cms__trackedLink', {
  records: [{ path: ['campaign'], sobject: 'Campaign' }],
});
const expression = jsonHandler('expression', 'sfdc_cms__expression');
const landingPage = jsonHandler('landing-page', 'sfdc_cms__landingPage');

const retrieveContext = (overrides = {}) => ({
  workspace,
  folderPath: [],
  referenceOf: () => {},
  warn: (warning) => assert.fail(`unexpected warning ${warning.code}`),
  ...overrides,
});

/**
 * Deploy source files through the pipeline against a fake org.
 * @param {object} org fakeOrg.
 * @param {Array<[object, object]>} components Handler and files.
 * @param {boolean} [preview] Preview only.
 * @returns {Promise<object>} Items, writes and diagnostics.
 */
async function deployTo(org, components, preview = false) {
  const connection = fakeConnection(org.answer);
  const diagnostics = { warnings: [], errors: [] };
  const items = await deployComponents(
    connection,
    workspace,
    components.map(([handler, files]) => ({
      handler,
      workspaceFolder: WS,
      apiName: files.document.apiName,
      path: `${files.document.apiName}.${handler.type}.json`,
      files,
    })),
    { preview, diagnostics, writeOptions: { allowCallerConnection: true } },
  );
  const writes = connection.calls.filter((call) => call.input.method !== 'GET');
  return { items, writes, diagnostics };
}

test('landing page: @cms/ block and template key -> logical references -> files -> destination keys in the same format', async () => {
  const page = await native('landing-page');
  const keys = referencedContentKeys(page.contentBody);
  assert.ok(keys.includes(TEMPLATE_KEY) && keys.includes(BLOCK_KEY), 'both forms are found');
  const logical = new Map([
    [TEMPLATE_KEY, { type: 'landing-page-template', apiName: 'Golden_LP_Template' }],
    [BLOCK_KEY, { type: 'web-fragment', apiName: 'Golden_Web_Fragment' }],
  ]);
  const unresolved = [];
  const files = landingPage.toSource(
    page,
    retrieveContext({
      referenceOf: (key) => logical.get(key) ?? { type: 'image', apiName: `Image_${key}` },
      warn: (warning) => unresolved.push(warning),
    }),
  );
  assert.deepEqual(unresolved, []);
  const body = files.document.contentBody;
  assert.deepEqual(body['sfdc_cms:template'], {
    definition: {
      type: 'landing-page-template',
      apiName: 'Golden_LP_Template',
      format: '<contentKey>',
    },
  });
  assert.ok(
    JSON.stringify(body).includes(
      JSON.stringify({
        type: 'web-fragment',
        apiName: 'Golden_Web_Fragment',
        format: '@cms/<contentKey>',
      }),
    ),
    'the @cms/ block is a logical reference with its format',
  );
  // Through the files on disk and back.
  const directory = await scratch();
  await writeSourceFiles(directory, WS, files);
  const payload = landingPage.fromSource(
    await readSourceFiles(directory, WS, 'landing-page', files.document.apiName),
  );
  const references = landingPage.references(payload);
  for (const reference of logical.values())
    assert.ok(references.some((r) => r.apiName === reference.apiName));
  const destination = {
    'landing-page-template:Golden_LP_Template': 'MCDESTTEMPLATEAAAAAAAAAAAAAA',
    'web-fragment:Golden_Web_Fragment': 'MCDESTBLOCKAAAAAAAAAAAAAAAAA',
  };
  const resolved = resolveReferences(
    payload.contentBody,
    (reference) =>
      destination[`${reference.type}:${reference.apiName}`] ?? reference.apiName.slice(6),
  );
  assert.deepEqual(resolved['sfdc_cms:template'], { definition: 'MCDESTTEMPLATEAAAAAAAAAAAAAA' });
  const text = JSON.stringify(resolved);
  assert.ok(text.includes('"@cms/MCDESTBLOCKAAAAAAAAAAAAAAAAA"'));
  assert.ok(!text.includes(BLOCK_KEY) && !text.includes(TEMPLATE_KEY), 'no source key remains');
});

test('reference forms apply only where declared; unknown keys stay and warn', () => {
  const body = {
    other: { definition: 'MCGOLDENXZEROAHAAAAAAAAAAAAA' },
    block: { definition: '@cms/MCGOLDENXZEROADAAAAAAAAAAAAA' },
    lightning: { definition: 'lightning/image' },
  };
  assert.deepEqual(referencedContentKeys(body), [BLOCK_KEY]);
  const warnings = [];
  const files = landingPage.toSource(
    { apiName: 'X', contentBody: body },
    retrieveContext({ warn: (warning) => warnings.push(warning.code) }),
  );
  assert.deepEqual(files.document.contentBody, body, 'kept as is');
  assert.deepEqual(warnings, ['REFERENCE_UNRESOLVED']);
  // A format the property does not take is not a reference.
  const wrong = { block: { definition: { type: 't', apiName: 'A', format: '<contentKey>' } } };
  assert.deepEqual(logicalReferences(wrong), []);
});

/**
 * A fragment whose block embeds other fragments by `@cms/`.
 * @param {string} apiName API name.
 * @param {string[]} embeds Embedded fragment API names.
 * @returns {object} Source files.
 */
function fragmentEmbedding(apiName, embeds = []) {
  return {
    type: 'email-fragment',
    document: {
      apiName,
      folderPath: [],
      contentBody: {
        'sfdc_cms:title': apiName,
        'sfdc_cms:block': {
          type: 'block',
          definition: 'lightning/section',
          children: embeds.map((name) => ({
            type: 'block',
            definition: 'sfdc_cms/reusableContentBlock',
            attributes: {
              content: {
                type: 'block',
                attributes: {},
                definition: { type: 'email-fragment', apiName: name, format: '@cms/<contentKey>' },
              },
            },
          })),
        },
      },
    },
    companions: {},
  };
}

test('deploy order follows an @cms/ reference; the destination key is written as @cms/<key>', async () => {
  const fragment = jsonHandler('email-fragment', 'sfdc_cms__emailFragment');
  const org = fakeOrg();
  const components = [
    [fragment, fragmentEmbedding('A_Page', ['B_Block'])],
    [fragment, fragmentEmbedding('B_Block')],
  ];
  const preview = await deployTo(org, components, true);
  assert.deepEqual(
    preview.items.map((item) => [item.apiName, item.outcome, item.dependencies]),
    [
      ['B_Block', 'create', undefined],
      ['A_Page', 'planned-dependencies', ['email-fragment:B_Block']],
    ],
  );
  const { items, writes, diagnostics } = await deployTo(org, components);
  assert.deepEqual(diagnostics.errors, []);
  assert.deepEqual(
    items.map((item) => [item.apiName, item.outcome]),
    [
      ['B_Block', 'created'],
      ['A_Page', 'created'],
    ],
  );
  const page = JSON.parse(writes.at(-1).input.body).contentBody;
  assert.equal(
    page['sfdc_cms:block'].children[0].attributes.content.definition,
    `@cms/${items[0].contentKey}`,
  );
  // Redeploy: the destination projects back to the same file.
  const again = await deployTo(org, components);
  assert.deepEqual(
    again.items.map((item) => item.outcome),
    ['unchanged', 'unchanged'],
  );
});

test('an @cms/ reference the destination does not have blocks before any write', async () => {
  const fragment = jsonHandler('email-fragment', 'sfdc_cms__emailFragment');
  const { items, writes, diagnostics } = await deployTo(fakeOrg(), [
    [fragment, fragmentEmbedding('A_Page', ['Missing_Block'])],
  ]);
  assert.deepEqual(
    items.map((item) => [item.outcome, item.reason]),
    [['blocked', 'REFERENCE_NOT_IN_DESTINATION']],
  );
  assert.equal(writes.length, 0);
  assert.match(diagnostics.errors[0].message, /email-fragment:Missing_Block/u);
});

test('tracked link retrieve: the Campaign ID becomes { sobject, name }; an unknown ID stays and warns', async () => {
  const link = await native('tracked-link');
  const resolver = recordResolver(
    fakeConnection(fakeOrg({ campaigns: [{ Id: CAMPAIGN_ID, Name: 'Golden Campaign' }] }).answer),
  );
  await resolver.load([{ sobject: 'Campaign', fields: ['Name'], id: CAMPAIGN_ID }]);
  const files = trackedLink.toSource(link, retrieveContext({ recordOf: resolver.recordOf }));
  assert.deepEqual(files.document.contentBody, {
    campaign: { name: 'Golden Campaign', sobject: 'Campaign' },
    destinationUrl: 'https://example.com',
    utmSource: 'golden',
  });
  const warnings = [];
  const kept = trackedLink.toSource(
    link,
    retrieveContext({ recordOf: () => {}, warn: (warning) => warnings.push(warning) }),
  );
  assert.equal(kept.document.contentBody.campaign, CAMPAIGN_ID);
  assert.deepEqual(
    warnings.map((warning) => warning.code),
    ['RECORD_REFERENCE_UNRESOLVED'],
  );
});

const linkFiles = (campaign) => ({
  type: 'tracked-link',
  document: {
    apiName: 'Golden_Tracked_Link',
    title: 'Golden_Tracked_Link',
    folderPath: [],
    contentBody: {
      campaign,
      destinationUrl: 'https://example.com',
      utmSource: 'golden',
    },
  },
  companions: {},
});

test('tracked link deploy: the Campaign is found by name and its destination ID is written', async () => {
  const org = fakeOrg({ campaigns: [{ Id: '701000000000999AAA', Name: 'Golden Campaign' }] });
  const files = linkFiles({ sobject: 'Campaign', name: 'Golden Campaign' });
  const { items, writes, diagnostics } = await deployTo(org, [[trackedLink, files]]);
  assert.deepEqual(diagnostics, { warnings: [], errors: [] });
  assert.deepEqual(
    items.map((item) => item.outcome),
    ['created'],
  );
  assert.equal(JSON.parse(writes.at(-1).input.body).contentBody.campaign, '701000000000999AAA');
  const again = await deployTo(org, [[trackedLink, files]]);
  assert.deepEqual(
    again.items.map((item) => item.outcome),
    ['unchanged'],
  );
});

test('tracked link deploy: a missing or ambiguous Campaign blocks before any write', async () => {
  const files = linkFiles({ sobject: 'Campaign', name: 'Golden Campaign' });
  const missing = await deployTo(fakeOrg(), [[trackedLink, files]]);
  assert.deepEqual(
    missing.items.map((item) => [item.outcome, item.reason]),
    [['blocked', 'RECORD_REFERENCE_NOT_FOUND']],
  );
  assert.equal(missing.writes.length, 0);
  assert.match(missing.diagnostics.errors[0].message, /Campaign "Golden Campaign"/u);
  const twice = [
    { Id: '701000000000998AAA', Name: 'Golden Campaign' },
    { Id: '701000000000999AAA', Name: 'Golden Campaign' },
  ];
  const ambiguous = await deployTo(fakeOrg({ campaigns: twice }), [[trackedLink, files]]);
  assert.deepEqual(
    ambiguous.items.map((item) => [item.outcome, item.reason]),
    [['blocked', 'RECORD_REFERENCE_AMBIGUOUS']],
  );
  assert.equal(ambiguous.writes.length, 0);
  const wrongShape = await deployTo(fakeOrg(), [
    [trackedLink, linkFiles({ sobject: 'Account', name: 'Golden Campaign' })],
  ]);
  assert.equal(wrongShape.items[0].reason, 'UNKNOWN_SETTING');
});

test('expression: a data graph provider without data space is checked in default', async () => {
  const { contentBody: body } = await native('expression');
  assert.deepEqual(dataGraphReferences(body), [
    { dataGraphApiName: 'Marketing', dataspace: 'default' },
  ]);
  const files = {
    type: 'expression',
    document: {
      apiName: 'Golden_Expression',
      title: 'Golden_Expression',
      folderPath: [],
      contentBody: body,
    },
    companions: {},
  };
  const blocked = await deployTo(fakeOrg({ graphs: {} }), [[expression, files]]);
  assert.deepEqual(
    blocked.items.map((item) => [item.outcome, item.reason]),
    [['blocked', 'DATA_GRAPH_NOT_IN_DESTINATION']],
  );
  assert.equal(blocked.writes.length, 0);
  const allowed = await deployTo(fakeOrg(), [[expression, files]], true);
  assert.deepEqual(
    allowed.items.map((item) => item.outcome),
    ['create'],
  );
});

const SOURCE_RECORD_TYPE = '012000000000101AAA';
const TARGET_RECORD_TYPE = '012000000000999AAA';
const leadRecordType = (Id) => ({ Id, SobjectType: 'Lead', DeveloperName: 'Lead_Default' });
const RECORD_TYPE_FILE = {
  developerName: 'Lead_Default',
  sobject: 'RecordType',
  sobjectType: 'Lead',
};

/**
 * The golden form with a "Salesforce Record" data source after its data graph provider.
 * @returns {Promise<object>} Native variant.
 */
async function formWithRecordSource() {
  const form = await native('form');
  form.contentBody['lightning:dataProviders'].push({
    attributes: { objectApiName: 'Lead', recordTypeId: SOURCE_RECORD_TYPE },
    definition: 'sfdc_cms__recordDataProvider',
    sfdcExpressionKey: 'Lead_Source',
  });
  return form;
}

test('form RecordType: retrieve keeps it by SobjectType + DeveloperName, deploy writes the destination ID', async () => {
  const form = await formWithRecordSource();
  const source = fakeOrg({ recordTypes: [leadRecordType(SOURCE_RECORD_TYPE)] });
  const resolver = recordResolver(fakeConnection(source.answer));
  await resolver.load(recordIdsOf(form.contentBody, formHandler.referenceDeclarations.records));
  const files = formHandler.toSource(form, retrieveContext({ recordOf: resolver.recordOf }));
  const providers = files.document.contentBody['lightning:dataProviders'];
  assert.equal(providers[0].definition, 'sfdc_cms__dataGraphDataProvider');
  assert.deepEqual(providers[1].attributes, {
    objectApiName: 'Lead',
    recordTypeId: RECORD_TYPE_FILE,
  });

  // Cross-org: the same files in an org whose RecordType has another ID.
  const target = fakeOrg({ recordTypes: [leadRecordType(TARGET_RECORD_TYPE)] });
  const created = await deployTo(target, [[formHandler, files]]);
  assert.deepEqual(created.diagnostics, { warnings: [], errors: [] });
  assert.deepEqual(
    created.items.map((item) => item.outcome),
    ['created'],
  );
  const written = JSON.parse(created.writes.at(-1).input.body).contentBody;
  assert.equal(written['lightning:dataProviders'][1].attributes.recordTypeId, TARGET_RECORD_TYPE);
  // Round trip: the destination projects back to the same file.
  const again = await deployTo(target, [[formHandler, files]]);
  assert.deepEqual(
    again.items.map((item) => item.outcome),
    ['unchanged'],
  );
  assert.equal(again.writes.length, 0);
});

test('form RecordType: unknown ID warns on retrieve; missing, ambiguous or malformed blocks deploy', async () => {
  const form = await formWithRecordSource();
  const warnings = [];
  const kept = formHandler.toSource(
    form,
    retrieveContext({ recordOf: () => {}, warn: (warning) => warnings.push(warning) }),
  );
  assert.equal(
    kept.document.contentBody['lightning:dataProviders'][1].attributes.recordTypeId,
    SOURCE_RECORD_TYPE,
  );
  assert.deepEqual(
    warnings.map((warning) => warning.code),
    ['RECORD_REFERENCE_UNRESOLVED'],
  );
  assert.match(warnings[0].message, /lightning:dataProviders\.1\.attributes\.recordTypeId/u);

  const resolved = structuredClone(kept);
  resolved.document.contentBody['lightning:dataProviders'][1].attributes.recordTypeId =
    RECORD_TYPE_FILE;
  const missing = await deployTo(
    fakeOrg({ recordTypes: [{ ...leadRecordType(TARGET_RECORD_TYPE), SobjectType: 'Contact' }] }),
    [[formHandler, resolved]],
  );
  assert.deepEqual(
    missing.items.map((item) => [item.outcome, item.reason]),
    [['blocked', 'RECORD_REFERENCE_NOT_FOUND']],
  );
  assert.equal(missing.writes.length, 0);
  assert.match(missing.diagnostics.errors[0].message, /RecordType "Lead" \/ "Lead_Default"/u);
  const ambiguous = await deployTo(
    fakeOrg({
      recordTypes: [leadRecordType(TARGET_RECORD_TYPE), leadRecordType('012000000000998AAA')],
    }),
    [[formHandler, resolved]],
  );
  assert.deepEqual(
    ambiguous.items.map((item) => item.reason),
    ['RECORD_REFERENCE_AMBIGUOUS'],
  );
  const malformed = structuredClone(resolved);
  delete malformed.document.contentBody['lightning:dataProviders'][1].attributes.recordTypeId
    .developerName;
  const refused = await deployTo(fakeOrg(), [[formHandler, malformed]]);
  assert.deepEqual(
    refused.items.map((item) => item.reason),
    ['UNKNOWN_SETTING'],
  );
  assert.equal(refused.writes.length, 0);
});
