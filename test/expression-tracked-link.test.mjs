import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Config } from '@oclif/core';
import Deploy from '../lib/commands/cms/deploy.js';
import { expressionHandler } from '../lib/content/handlers/expression.js';
import { trackedLinkHandler } from '../lib/content/handlers/tracked-link.js';
import { resolveRecordReferences } from '../lib/content/json-source.js';
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
const EXPRESSION = 'MCGOLDENXZEROAOAAAAAAAAAAAAA';
const SOURCE_CAMPAIGN = '701000000000101AAA';
const TARGET_CAMPAIGN = '701000000000999AAA';
const native = async (name) =>
  JSON.parse(await readFile(path.join(here, 'fixtures', 'native', `${name}.variant.json`), 'utf8'));
const scratch = () => mkdtemp(path.join(os.tmpdir(), 'sf-plugin-cms-v1-x4-'));
const goldenText = (type, apiName) =>
  readFile(path.join(golden, 'cms', WS, type, `${apiName}.${type}.json`), 'utf8');
const context = {
  workspace,
  folderPath: [],
  referenceOf: () => {},
  recordOf: (sobject, fields, id) =>
    sobject === 'Campaign' && id === SOURCE_CAMPAIGN ? { Name: 'Golden Campaign' } : undefined,
  warn: (warning) => assert.fail(`unexpected warning ${warning.code}`),
};

let config;
before(async () => {
  config = await Config.load(root);
});

test('expression and tracked-link are registered JSON handlers', () => {
  assert.equal(handlerOf('expression'), expressionHandler);
  assert.equal(expressionHandler.apiName, 'sfdc_cms__expression');
  assert.equal(handlerOf('tracked-link'), trackedLinkHandler);
  assert.equal(trackedLinkHandler.apiName, 'sfdc_cms__trackedLink');
  assert.deepEqual([expressionHandler.transport, trackedLinkHandler.transport], ['json', 'json']);
  assert.deepEqual(trackedLinkHandler.referenceDeclarations, {
    records: [{ path: ['campaign'], sobject: 'Campaign' }],
  });
});

test('golden: expression native -> JSON file -> native body, graph checked in default', async () => {
  const variant = await native('expression');
  const written = await writeSourceFiles(
    await scratch(),
    WS,
    expressionHandler.toSource(variant, context),
  );
  assert.equal(await readFile(written.path, 'utf8'), await goldenText('expression', EXPRESSION));
  const payload = expressionHandler.fromSource(
    await readSourceFiles(golden, WS, 'expression', EXPRESSION),
    { workspace },
  );
  assert.deepEqual(payload.contentBody, variant.contentBody);
  assert.deepEqual(envelopeOf(payload, payload.contentBody), {
    apiName: variant.apiName,
    title: variant.title,
    urlName: variant.urlName,
  });
  assert.deepEqual(expressionHandler.references(payload), []);
  assert.deepEqual(dataGraphReferences(payload.contentBody), [
    { dataGraphApiName: 'Marketing', dataspace: 'default' },
  ]);
});

test('golden: tracked link keeps the Campaign by name', async () => {
  const variant = await native('tracked-link');
  const written = await writeSourceFiles(
    await scratch(),
    WS,
    trackedLinkHandler.toSource(variant, context),
  );
  assert.equal(
    await readFile(written.path, 'utf8'),
    await goldenText('tracked-link', 'Golden_Tracked_Link'),
  );
  const payload = trackedLinkHandler.fromSource(
    await readSourceFiles(golden, WS, 'tracked-link', 'Golden_Tracked_Link'),
    { workspace },
  );
  assert.deepEqual(payload.contentBody.campaign, { name: 'Golden Campaign', sobject: 'Campaign' });
  assert.deepEqual(trackedLinkHandler.references(payload), []);
  assert.deepEqual(
    resolveRecordReferences(
      payload.contentBody,
      trackedLinkHandler.referenceDeclarations.records,
      () => SOURCE_CAMPAIGN,
    ),
    variant.contentBody,
  );
});

test('tracked link: the short link fields Salesforce adds on publish are not kept', async () => {
  const variant = await native('tracked-link');
  variant.isPublished = true;
  Object.assign(variant.contentBody, {
    expiryTime: { dateTime: '2031-01-01T00:00:00.000Z', timeZone: 'GMT' },
    rewrittenUrl: 'https://short.example.com/abc',
    sequenceId: 'abc',
  });
  const files = trackedLinkHandler.toSource(variant, context);
  assert.deepEqual(Object.keys(files.document.contentBody).toSorted(), [
    'campaign',
    'destinationUrl',
    'utmSource',
  ]);
});

async function deploy(argv, org, directory) {
  const connection = fakeConnection(org.answer);
  class Fake extends Deploy {
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
    return { result, writes: connection.calls.filter((call) => call.input.method !== 'GET') };
  } finally {
    process.exitCode = undefined;
    process.chdir(cwd);
  }
}
const outcomes = (result) => result.result.items.map((item) => [item.apiName, item.outcome]);

test('deploy both types: create (destination Campaign ID), unchanged with zero writes, update', async () => {
  const directory = await scratch();
  const link = await readSourceFiles(golden, WS, 'tracked-link', 'Golden_Tracked_Link');
  await writeSourceFiles(directory, WS, link);
  await writeSourceFiles(
    directory,
    WS,
    await readSourceFiles(golden, WS, 'expression', EXPRESSION),
  );
  const org = fakeOrg({ campaigns: [{ Id: TARGET_CAMPAIGN, Name: 'Golden Campaign' }] });
  const all = ['-d', path.join(directory, 'cms')];

  const first = await deploy(all, org, directory);
  assert.equal(first.result.status, 'success');
  assert.deepEqual(outcomes(first.result), [
    [EXPRESSION, 'created'],
    ['Golden_Tracked_Link', 'created'],
  ]);
  const [expressionCreate, linkCreate] = first.writes.map((call) => JSON.parse(call.input.body));
  assert.equal(expressionCreate.contentType, 'sfdc_cms__expression');
  const expressionVariant = await native('expression');
  assert.deepEqual(expressionCreate.contentBody, expressionVariant.contentBody);
  assert.equal(linkCreate.contentType, 'sfdc_cms__trackedLink');
  assert.equal(linkCreate.contentBody.campaign, TARGET_CAMPAIGN);

  const second = await deploy(all, org, directory);
  assert.deepEqual(outcomes(second.result), [
    [EXPRESSION, 'unchanged'],
    ['Golden_Tracked_Link', 'unchanged'],
  ]);
  assert.equal(second.writes.length, 0);

  const edited = structuredClone(link);
  edited.document.contentBody.utmSource = 'edited';
  await writeSourceFiles(directory, WS, edited);
  const third = await deploy(['-m', 'tracked-link:Golden_Tracked_Link'], org, directory);
  assert.deepEqual(outcomes(third.result), [['Golden_Tracked_Link', 'updated']]);
  assert.deepEqual(third.result.result.items[0].changes, ['contentBody.utmSource']);
  assert.equal(third.writes.length, 1);
  assert.deepEqual(JSON.parse(third.writes[0].input.body).contentBody, {
    campaign: TARGET_CAMPAIGN,
    destinationUrl: 'https://example.com',
    utmSource: 'edited',
  });
});
