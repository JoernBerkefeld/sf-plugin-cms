import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Config } from '@oclif/core';
import Deploy from '../lib/commands/cms/deploy.js';
import { brandHandler } from '../lib/content/handlers/brand.js';
import { HANDLERS, handlerOf } from '../lib/content/registry.js';
import { readSourceFiles, writeSourceFiles } from '../lib/content/source-files.js';
import { envelopeOf } from '../lib/services/deploy.js';
import { fakeConnection } from './support/fake-connection.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const golden = path.join(here, 'fixtures', 'golden');
const WS = 'Default_Content_Workspace';
const workspace = {
  apiName: WS,
  id: '0Zu000000000001AAA',
  isEnhancedSpace: true,
  name: 'Workspace',
  defaultLanguage: 'en_US',
  rootFolderId: '9Pu000000000001AAA',
  spaceType: { apiName: 'marketing' },
};
const nativeBrand = async () =>
  JSON.parse(await readFile(path.join(here, 'fixtures', 'native', 'brand.variant.json'), 'utf8'));
const goldenBrand = () => readSourceFiles(golden, WS, 'brand', 'Golden_Brand');
const scratch = () => mkdtemp(path.join(os.tmpdir(), 'sf-plugin-cms-v1-brand-'));

let config;
before(async () => {
  config = await Config.load(root);
});

test('brand is registered and deploys before every other type', () => {
  assert.equal(handlerOf('brand'), brandHandler);
  assert.equal(HANDLERS[0], brandHandler);
  assert.equal(brandHandler.apiName, 'sfdc_cms__brand');
  assert.equal(brandHandler.transport, 'json');
});

test('golden: brand native -> files (whole body in the JSON, no companions)', async () => {
  const warnings = [];
  const files = brandHandler.toSource(await nativeBrand(), {
    workspace: { id: workspace.id, apiName: WS },
    folderPath: [],
    referenceOf: () => {},
    warn: (warning) => warnings.push(warning),
  });
  assert.deepEqual(files.companions, {});
  const directory = await scratch();
  const written = await writeSourceFiles(directory, WS, files);
  assert.equal(
    await readFile(written.path, 'utf8'),
    await readFile(path.join(golden, 'cms', WS, 'brand', 'Golden_Brand.brand.json'), 'utf8'),
  );
  assert.deepEqual(warnings, []);
});

test('golden fromSource: brand files give back the native envelope and body', async () => {
  const native = await nativeBrand();
  const payload = brandHandler.fromSource(await goldenBrand(), { workspace });
  assert.equal(payload.apiName, native.apiName);
  assert.equal(payload.title, undefined);
  assert.deepEqual(envelopeOf(payload, payload.contentBody), {
    apiName: native.apiName,
    title: native.title,
    urlName: native.urlName,
  });
  assert.deepEqual(payload.folderPath, []);
  assert.deepEqual(payload.createOnly, {});
  assert.deepEqual(payload.contentBody, native.contentBody);
  assert.deepEqual(brandHandler.references(payload), []);
});

test('brand fromSource refuses companion files and unknown envelope fields', async () => {
  const files = await goldenBrand();
  for (const candidate of [
    { ...files, companions: { '.html': '<p></p>' } },
    { ...files, document: { ...files.document, isDefault: true } },
  ])
    assert.throws(() => brandHandler.fromSource(candidate, { workspace }), {
      code: 'UNKNOWN_SETTING',
    });
});

/**
 * An in-memory workspace for brands: SOQL rows, variant GET/PUT and create.
 * @param {{ variants?: object[]; fail?: Function }} [state] Stored variants and a write hook.
 * @returns {{ answer: Function; variants: Map }} Answer function and the store.
 */
function fakeOrg(state = {}) {
  const variants = new Map();
  let counter = 0;
  const store = (native) => {
    variants.set(native.managedContentVariantId, structuredClone(native));
    return structuredClone(native);
  };
  for (const native of state.variants ?? []) store(native);
  const answer = (input) => {
    const url = decodeURIComponent(input.url.replaceAll('+', ' '));
    const body = input.body === undefined ? undefined : JSON.parse(input.body);
    if (input.method !== 'GET') state.fail?.(input, body);
    if (url.startsWith('/connect/cms/spaces?'))
      return { spaces: url.includes('page=0') ? [workspace] : [] };
    if (url.startsWith('/query?')) {
      const type = /ContentTypeFullyQualifiedName = '(\w+)'/u.exec(url)?.[1];
      const names = /ApiName IN \(([^)]*)\)/u.exec(url)?.[1] ?? '';
      const records = [...variants.values()]
        .filter(
          (v) => v.contentType.fullyQualifiedName === type && names.includes(`'${v.apiName}'`),
        )
        .map((v) => ({
          Id: v.managedContentVariantId,
          ManagedContentId: v.managedContentId,
          Language: v.language,
          IsPrimary: true,
          Name: v.title,
          ManagedContentKey: v.contentKey,
          ContentTypeFullyQualifiedName: v.contentType.fullyQualifiedName,
          ManagedContent: { ApiName: v.apiName, AuthoredManagedContentSpaceId: workspace.id },
        }));
      return { records };
    }
    if (url === '/connect/cms/contents' && input.method === 'POST') {
      counter += 1;
      return store({
        apiName: body.apiName,
        title: body.title,
        urlName: body.urlName,
        contentBody: body.contentBody,
        contentKey: `MC${'Y'.repeat(25)}${String.fromCodePoint(64 + counter)}`,
        contentType: { fullyQualifiedName: body.contentType },
        folder: { id: body.contentSpaceOrFolderId },
        language: 'en_US',
        managedContentId: `20Y00000000000${counter}AAA`,
        managedContentVariantId: `9Ps00000000000${counter}AAA`,
        status: { status: 'Draft' },
      });
    }
    const variant = /^\/connect\/cms\/contents\/variants\/(\w+)$/u.exec(url)?.[1];
    if (variant && variants.has(variant)) {
      if (input.method === 'PUT')
        return store({ ...variants.get(variant), ...body, contentBody: body.contentBody });
      return structuredClone(variants.get(variant));
    }
    throw Object.assign(new Error('not found'), { errorCode: 'NOT_FOUND' });
  };
  return { answer, variants };
}

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
    const exitCode = process.exitCode;
    const writes = connection.calls.filter((call) => call.input.method !== 'GET');
    return { result, writes, exitCode };
  } finally {
    process.exitCode = undefined;
    process.chdir(cwd);
  }
}

const outcomes = (result) => result.result.items.map((item) => [item.apiName, item.outcome]);

test('brand round trip: create, unchanged with no write, then update of a color', async () => {
  const files = await goldenBrand();
  const directory = await scratch();
  await writeSourceFiles(directory, WS, files);
  const org = fakeOrg();
  const selector = ['-m', 'brand:Golden_Brand'];

  const created = await deploy(selector, org, directory);
  assert.equal(created.result.status, 'success');
  assert.deepEqual(outcomes(created.result), [['Golden_Brand', 'created']]);
  assert.equal(created.writes.length, 1);
  const create = JSON.parse(created.writes[0].input.body);
  assert.equal(create.contentType, 'sfdc_cms__brand');
  assert.equal(create.contentSpaceOrFolderId, workspace.rootFolderId);
  assert.deepEqual(create.contentBody, files.document.contentBody);
  assert.deepEqual(created.result.diagnostics.warnings, []);

  const unchanged = await deploy(selector, org, directory);
  assert.deepEqual(outcomes(unchanged.result), [['Golden_Brand', 'unchanged']]);
  assert.equal(unchanged.writes.length, 0);

  const edited = structuredClone(files);
  edited.document.contentBody.colorScheme.primaryAccent = '#1A7F37';
  await writeSourceFiles(directory, WS, edited);
  const updated = await deploy(selector, org, directory);
  assert.deepEqual(outcomes(updated.result), [['Golden_Brand', 'updated']]);
  assert.deepEqual(updated.result.result.items[0].changes, ['contentBody.colorScheme']);
  assert.equal(updated.writes.length, 1);
  assert.equal(updated.writes[0].input.method, 'PUT');
  const stored = [...org.variants.values()][0];
  assert.equal(stored.contentBody.colorScheme.primaryAccent, '#1A7F37');
});

test('a brand update Salesforce refuses is reported with its error, no local refusal', async () => {
  const files = await goldenBrand();
  const directory = await scratch();
  await writeSourceFiles(directory, WS, files);
  const native = await nativeBrand();
  const org = fakeOrg({
    variants: [
      {
        ...native,
        folder: { id: workspace.rootFolderId },
        contentBody: { ...native.contentBody, baseFontFamily: 'x' },
      },
    ],
    fail: () => {
      throw Object.assign(new Error('refused'), {
        statusCode: 400,
        data: [{ errorCode: 'INVALID_API_INPUT', message: 'refused' }],
      });
    },
  });
  const { result, writes, exitCode } = await deploy(['-m', 'brand:Golden_Brand'], org, directory);
  assert.equal(exitCode, 1);
  assert.equal(writes.length, 1);
  assert.deepEqual(outcomes(result), [['Golden_Brand', 'failed']]);
  assert.deepEqual(
    result.diagnostics.errors.map((error) => [error.code, error.salesforceErrorCode]),
    [['REQUEST_FAILED', 'INVALID_API_INPUT']],
  );
});
