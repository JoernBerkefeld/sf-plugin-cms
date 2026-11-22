import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { HANDLERS } from '../lib/content/registry.js';
import {
  checkDataGraphReferences,
  dataGraphAttributePaths,
  dataGraphUsages,
} from '../lib/services/data-graph-check.js';
import { deployComponents } from '../lib/services/deploy.js';
import { fakeConnection } from './support/fake-connection.mjs';
import { MARKETING_GRAPH_ROOT, fakeOrg, salesforceError, workspace } from './support/fake-org.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const native = async (name) =>
  JSON.parse(await readFile(path.join(here, 'fixtures', 'native', `${name}.variant.json`), 'utf8'));

// The merge fields of the Y0 Email Builder email (API notes section 23).
const BIRTH_DATE = '{{fallback (get (get @root "$dataGraph") "ssot__BirthDate__c") ""}}';
const PARTY =
  '{{fallback (get (map (sort (get (get @root "$dataGraph") "UnifiedssotContactPointAddressMkt__dlm") "ssot__Id__c" "desc" "string") "ssot__PartyId__c") 0) ""}}';
const SALUTATION = '{{fallback (get (get @root "$dataGraph") "ssot__Salutation__c") ""}}';

const expression = (name, value) => ({
  attributes: { value },
  default: '',
  definition: 'sfdc_cms__handlebarExpression',
  label: name,
  sfdcExpressionKey: name,
});
const provider = (dataGraphApiName, dataspace = 'default') => ({
  attributes: { dataGraphApiName, dataspace },
  definition: 'sfdc_cms__dataGraphDataProvider',
  sfdcExpressionKey: '$dataGraph',
});
const emailBody = (graph, expressions, dataspace) => ({
  'lightning:dataProviders': [provider(graph, dataspace)],
  'lightning:expressions': expressions,
  text: 'Hello {{$individual.firstName}}{!$Expression.Birth_Date} {!$brand.name}',
});

test('attribute paths: the Y0 email merge fields, related objects, sort arguments and indexes skipped', () => {
  const body = emailBody('Marketing', [
    expression('Birth_Date', BIRTH_DATE),
    expression('Party', PARTY),
  ]);
  assert.deepEqual(dataGraphAttributePaths(body), [
    ['ssot__BirthDate__c'],
    ['UnifiedssotContactPointAddressMkt__dlm', 'ssot__PartyId__c'],
  ]);
  assert.deepEqual(dataGraphUsages(body), [
    {
      dataGraphApiName: 'Marketing',
      dataspace: 'default',
      paths: [
        ['ssot__BirthDate__c'],
        ['UnifiedssotContactPointAddressMkt__dlm', 'ssot__PartyId__c'],
      ],
    },
  ]);
});

test('attribute paths: ds2_ names, bridge objects, {!$dataGraph.…}, built-in tokens and duplicates', () => {
  const ds2 =
    '{{{fallback (get (map (sort (get (get (get @root \'$dataGraph\') "ds2_CMSM_Link__dlm") "ds2_CMSM_Order__dlm") "Date__c" "asc" "date") "Amount__c") 1) "-"}}}';
  const body = {
    expression: { expressionGroups: [{ resource: '{!$dataGraph.ds2_CMSM_Order__dlm.Status__c}' }] },
    html: `<p>${BIRTH_DATE} {{$individual.firstName}} {!$organization.name} {!$link.x}</p>`,
    'lightning:expressions': [expression('Order', ds2), expression('Again', BIRTH_DATE)],
    other: '{{fallback (get (get @root "$unifiedIndividual") "ssot__FirstName__c") ""}}',
  };
  assert.deepEqual(dataGraphAttributePaths(body), [
    ['ds2_CMSM_Order__dlm', 'Status__c'],
    ['ssot__BirthDate__c'],
    ['ds2_CMSM_Link__dlm', 'ds2_CMSM_Order__dlm', 'Amount__c'],
  ]);
  assert.deepEqual(dataGraphAttributePaths({ text: 'no merge fields {{$individual.id}}' }), []);
});

test('attribute paths: the native expression item and a provider without merge fields', async () => {
  const { contentBody } = await native('expression');
  assert.deepEqual(dataGraphUsages(contentBody), [
    { dataGraphApiName: 'Marketing', dataspace: 'default', paths: [['ssot__CreatedDate__c']] },
  ]);
  const { contentBody: sms } = await native('sms');
  assert.deepEqual(
    dataGraphUsages(sms).map((usage) => usage.paths),
    [[]],
  );
});

const TYPES_WITH_PROVIDER = {
  email: 'email-blocks',
  'email-fragment': 'email-fragment',
  'landing-page': 'landing-page',
  'landing-page-template': 'landing-page-template',
  'web-fragment': 'web-fragment',
  sms: 'sms',
  'push-notification': 'push-notification',
  'in-app': 'in-app',
  rcs: 'rcs',
  'whatsapp-session': 'whatsapp-session',
  expression: 'expression',
};

test('every type with a data graph provider carries the merge-field paths into the deploy payload', async () => {
  for (const [type, fixture] of Object.entries(TYPES_WITH_PROVIDER)) {
    const handler = HANDLERS.find((candidate) => candidate.type === type);
    const variant = await native(fixture);
    const body = variant.contentBody;
    // The golden block email uses the unified individual provider; Y0's UI email used a graph.
    if (type === 'email') body['lightning:dataProviders'] = [provider('Marketing')];
    if (type === 'expression')
      body.expression.expressionGroups.push({ resource: '{!$dataGraph.ssot__Salutation__c}' });
    else body['lightning:expressions'] = [expression('Salutation', SALUTATION)];
    const files = handler.toSource(variant, {
      workspace,
      folderPath: [],
      referenceOf: (key) => ({ type: 'image', apiName: `Ref_${key}` }),
      warn: () => {},
      recordOf: () => ({ Name: 'Record' }),
    });
    const payload = handler.fromSource(files, { workspace });
    const [usage] = dataGraphUsages(payload.contentBody);
    assert.ok(usage, `${type} has a data graph provider`);
    assert.ok(
      usage.paths.some((p) => p.join('.') === 'ssot__Salutation__c'),
      `${type} keeps the merge field`,
    );
  }
});

test('check: present paths pass, a missing attribute or graph is refused with names', async () => {
  const org = fakeOrg({
    dataSpaces: ['default', 'dataspace2'],
    graphs: {
      Marketing: 'default',
      ds2_CMSM_Graph: {
        dataspace: 'dataspace2',
        sourceObject: {
          name: 'ds2_CMSM_Person__dlm',
          fields: [{ sourceFieldName: 'Name__c' }],
          relatedObjects: [
            { name: 'ds2_CMSM_Order__dlm', fields: [{ sourceFieldName: 'Amount__c' }] },
          ],
        },
      },
    },
  });
  const connection = fakeConnection(org.answer);
  assert.deepEqual(
    await checkDataGraphReferences(connection, [
      {
        dataGraphApiName: 'Marketing',
        dataspace: 'default',
        paths: [
          ['ssot__BirthDate__c'],
          ['UnifiedssotContactPointAddressMkt__dlm', 'ssot__PartyId__c'],
          ['UnifiedssotContactPointAddressMkt__dlm'],
        ],
      },
      {
        dataGraphApiName: 'ds2_CMSM_Graph',
        dataspace: 'dataspace2',
        paths: [['ds2_CMSM_Order__dlm', 'Amount__c']],
      },
    ]),
    [],
  );
  assert.deepEqual(
    await checkDataGraphReferences(connection, [
      {
        dataGraphApiName: 'Marketing',
        dataspace: 'default',
        paths: [
          ['ssot__Salutation__c'],
          ['ssot__BirthDate__c'],
          ['UnifiedssotContactPointAddressMkt__dlm', 'ssot__City__c'],
          ['ssot__BirthDate__c', 'x'],
        ],
      },
      { dataGraphApiName: 'ds2_CMSM_Graph', dataspace: 'dataspace2', paths: [['Amount__c']] },
      { dataGraphApiName: 'ds2_Missing', dataspace: 'dataspace2', paths: [['Name__c']] },
    ]),
    [
      {
        code: 'DATA_GRAPH_ATTRIBUTE_MISSING',
        message:
          'Data graph Marketing in data space default of the destination org lacks ssot__Salutation__c, UnifiedssotContactPointAddressMkt__dlm.ssot__City__c, ssot__BirthDate__c.x. Add them, e.g.: sf data360 deploy -m data-graph:Marketing --dataspace default --allow-processing',
      },
      {
        code: 'DATA_GRAPH_ATTRIBUTE_MISSING',
        message:
          'Data graph ds2_CMSM_Graph in data space dataspace2 of the destination org lacks Amount__c. Add them, e.g.: sf data360 deploy -m data-graph:ds2_CMSM_Graph --dataspace dataspace2 --allow-processing',
      },
      {
        code: 'DATA_GRAPH_NOT_IN_DESTINATION',
        message:
          'Data graph ds2_Missing does not exist in data space dataspace2 of the destination org',
      },
    ],
  );
  const noRoot = fakeConnection(
    fakeOrg({ graphs: { Marketing: { dataspace: 'default' } } }).answer,
  );
  await assert.rejects(
    checkDataGraphReferences(noRoot, [
      { dataGraphApiName: 'Marketing', dataspace: 'default', paths: [['a']] },
    ]),
    { code: 'UNEXPECTED_RESPONSE' },
  );
  assert.deepEqual(
    await checkDataGraphReferences(noRoot, [
      { dataGraphApiName: 'Marketing', dataspace: 'default', paths: [] },
    ]),
    [],
  );
});

const emailHandler = HANDLERS.find((handler) => handler.type === 'email');

const emailFiles = (apiName, expressions) => ({
  type: 'email',
  document: {
    apiName,
    title: apiName,
    folderPath: [],
    contentBody: { ...emailBody('Marketing', expressions), subjectLine: 'Hi' },
  },
  companions: {},
});

/**
 * Deploy email files through the pipeline against a fake org.
 * @param {object} org fakeOrg.
 * @param {object[]} files Source files.
 * @param {boolean} preview Preview only.
 * @returns {Promise<object>} Items, writes, diagnostics and calls.
 */
async function deployEmails(org, files, preview) {
  const connection = fakeConnection(org.answer);
  const diagnostics = { warnings: [], errors: [] };
  const items = await deployComponents(
    connection,
    workspace,
    files.map((file) => ({
      handler: emailHandler,
      workspaceFolder: workspace.apiName,
      apiName: file.document.apiName,
      path: `${file.document.apiName}.email.json`,
      files: file,
    })),
    { preview, diagnostics, writeOptions: { allowCallerConnection: true } },
  );
  const writes = connection.calls.filter((call) => call.input.method !== 'GET');
  return { items, writes, diagnostics, calls: connection.calls };
}

test('deploy: a missing attribute blocks in preview and run before any write', async () => {
  const files = [emailFiles('CMSY2_Email', [expression('Salutation', SALUTATION)])];
  for (const preview of [true, false]) {
    const { items, writes, diagnostics } = await deployEmails(fakeOrg(), files, preview);
    assert.deepEqual(
      items.map((item) => [item.outcome, item.reason]),
      [['blocked', 'DATA_GRAPH_ATTRIBUTE_MISSING']],
    );
    assert.equal(writes.length, 0);
    assert.deepEqual(
      diagnostics.errors.map((error) => [error.code, error.message]),
      [
        [
          'DATA_GRAPH_ATTRIBUTE_MISSING',
          'Data graph Marketing in data space default of the destination org lacks ssot__Salutation__c. Add them, e.g.: sf data360 deploy -m data-graph:Marketing --dataspace default --allow-processing',
        ],
      ],
    );
    assert.match(
      diagnostics.errors[0].hint,
      /with sf-plugin-data, using the command in the message/u,
    );
    assert.doesNotMatch(diagnostics.errors[0].hint, /</u);
  }
});

test('check: a failed data space or graph read is not cached, the next check reads again', async () => {
  const org = fakeOrg();
  const failing = new Set(['/ssot/data-spaces', '/ssot/data-graphs/Marketing']);
  const connection = fakeConnection((input) => {
    const key = input.url.split('?')[0];
    if (failing.has(key)) {
      failing.delete(key);
      throw salesforceError(500, 'SERVER_ERROR');
    }
    return org.answer(input);
  });
  const reference = { dataGraphApiName: 'Marketing', dataspace: 'default', paths: [] };
  await assert.rejects(checkDataGraphReferences(connection, [reference]));
  await assert.rejects(checkDataGraphReferences(connection, [reference]));
  assert.deepEqual(await checkDataGraphReferences(connection, [reference]), []);
  assert.deepEqual(await checkDataGraphReferences(connection, [reference]), []);
  assert.equal(
    connection.calls.filter((call) => call.input.url.startsWith('/ssot/data-spaces')).length,
    2,
  );
  assert.equal(
    connection.calls.filter((call) => call.input.url === '/ssot/data-graphs/Marketing').length,
    2,
  );
});

test('deploy: several components on one graph read it once, and present paths go ahead', async () => {
  const files = ['A', 'B', 'C'].map((suffix) =>
    emailFiles(`CMSY2_Email_${suffix}`, [
      expression('Birth_Date', BIRTH_DATE),
      expression('Party', PARTY),
    ]),
  );
  const { items, writes, calls } = await deployEmails(fakeOrg(), files, true);
  assert.deepEqual(
    items.map((item) => item.outcome),
    ['create', 'create', 'create'],
  );
  assert.equal(writes.length, 0);
  assert.equal(calls.filter((call) => call.input.url === '/ssot/data-graphs/Marketing').length, 1);

  // Concurrent checks on one connection share the in-flight read.
  const connection = fakeConnection(fakeOrg().answer);
  const usage = { dataGraphApiName: 'Marketing', dataspace: 'default', paths: [['ssot__Id__c']] };
  const results = await Promise.all(
    [1, 2, 3, 4].map(() => checkDataGraphReferences(connection, [usage])),
  );
  assert.deepEqual(results, [[], [], [], []]);
  const urls = connection.calls.map((call) => call.input.url);
  assert.equal(urls.filter((url) => url === '/ssot/data-graphs/Marketing').length, 1);
  assert.equal(urls.filter((url) => url.startsWith('/ssot/data-spaces')).length, 1);
  assert.ok(MARKETING_GRAPH_ROOT.fields.length > 0);
});
