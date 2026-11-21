import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Config } from '@oclif/core';
import Deploy from '../lib/commands/cms/deploy.js';
import { referencedContentKeys } from '../lib/content/json-projection.js';
import { resolveReferences } from '../lib/content/json-source.js';
import { handlerOf } from '../lib/content/registry.js';
import { readSourceFiles, writeSourceFiles } from '../lib/content/source-files.js';
import { sourceDifferences } from '../lib/services/deploy.js';
import { selectSources } from '../lib/services/deploy-selection.js';
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
const nativeOf = async (name) =>
  JSON.parse(await readFile(path.join(here, 'fixtures', 'native', `${name}.variant.json`), 'utf8'));
const goldenFiles = (type, apiName) => readSourceFiles(golden, WS, type, apiName);
const BLOCK_EMAIL = 'MCGOLDENAAAAAAAAAAAAAAAAAAAA';

let config;
before(async () => {
  config = await Config.load(root);
});

/**
 * Native body with the derived image `url` next to a `source.ref` left out.
 * @param {unknown} value Native value.
 * @returns {unknown} Copy without derived URLs.
 */
function withoutDerivedUrls(value) {
  if (Array.isArray(value)) return value.map((item) => withoutDerivedUrls(item));
  if (value === null || typeof value !== 'object') return value;
  const result = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === 'url' && value.source?.ref) continue;
    result[key] = withoutDerivedUrls(child);
  }
  return result;
}

test('golden fromSource: files give back the native envelope and body', async () => {
  for (const [type, apiName, nativeName] of [
    ['email', 'Golden_Email_Code', 'email-code'],
    ['email', BLOCK_EMAIL, 'email-blocks'],
    ['email-template', 'Golden_Email_Template', 'email-template'],
  ]) {
    const native = await nativeOf(nativeName);
    const handler = handlerOf(type);
    const payload = handler.fromSource(await goldenFiles(type, apiName), { workspace });
    assert.equal(payload.apiName, native.apiName);
    assert.equal(payload.title, native.title);
    assert.equal(payload.urlName, native.urlName);
    assert.deepEqual(payload.folderPath, []);
    assert.deepEqual(payload.createOnly, {});
    const keys = referencedContentKeys(native.contentBody);
    const byName = new Map(handler.references(payload).map((r, index) => [r.apiName, keys[index]]));
    assert.deepEqual(
      resolveReferences(payload.contentBody, (reference) => byName.get(reference.apiName)),
      withoutDerivedUrls(native.contentBody),
      `${type}:${apiName}`,
    );
  }
  const blocks = handlerOf('email').fromSource(await goldenFiles('email', BLOCK_EMAIL), {
    workspace,
  });
  assert.deepEqual(handlerOf('email').references(blocks), [
    { type: 'image', apiName: 'Golden_Logo' },
    { type: 'image', apiName: 'Golden_Header' },
  ]);
});

test('fromSource is strict on settings the type does not have', async () => {
  const handler = handlerOf('email');
  const files = await goldenFiles('email', 'Golden_Email_Code');
  const variants = [
    { ...files, document: { ...files.document, colour: 'red' } },
    { ...files, companions: { ...files.companions, '.css': 'p{}' } },
    {
      ...files,
      document: { ...files.document, contentBody: { ...files.document.contentBody, rawHtml: 'x' } },
    },
  ];
  for (const candidate of variants)
    assert.throws(() => handler.fromSource(candidate, { workspace }), { code: 'UNKNOWN_SETTING' });
  const external = handler.fromSource(
    { ...files, document: { ...files.document, externalId: 'E1' } },
    { workspace },
  );
  assert.deepEqual(external.createOnly, { externalId: 'E1' });
});

test('differences: canonical JSON per field, companions by bytes, folder ignored', async () => {
  const files = await goldenFiles('email', 'Golden_Email_Code');
  const reordered = {
    ...files,
    document: {
      ...files.document,
      folderPath: ['Elsewhere'],
      contentBody: Object.fromEntries(Object.entries(files.document.contentBody).toReversed()),
    },
  };
  assert.deepEqual(sourceDifferences(files, reordered), []);
  const edited = {
    ...files,
    document: {
      ...files.document,
      title: 'New',
      contentBody: { ...files.document.contentBody, subjectLine: 'S' },
    },
    companions: { ...files.companions, '.html': 'x' },
  };
  assert.deepEqual(sourceDifferences(files, edited), ['.html', 'contentBody.subjectLine', 'title']);
});

/**
 * An in-memory workspace: SOQL rows from the stored variants, folders, creates and updates.
 * @param {{ variants?: object[]; folders?: object; fail?: Function }} [state] Stored variants,
 *   child folders by parent ID, and a hook that may throw for a write.
 * @returns {{ answer: Function; variants: Map }} Answer function and the store.
 */
function fakeOrg(state = {}) {
  const variants = new Map();
  let counter = 0;
  const key = () => `MC${'Z'.repeat(25)}${String.fromCodePoint(65 + counter)}`;
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
      const keys = /ManagedContentKey IN \(([^)]*)\)/u.exec(url)?.[1];
      const records = [...variants.values()]
        .filter((v) =>
          keys
            ? keys.includes(`'${v.contentKey}'`) && v.isPrimary !== false
            : v.contentType.fullyQualifiedName === type && names.includes(`'${v.apiName}'`),
        )
        .map((v) => ({
          Id: v.managedContentVariantId,
          ManagedContentId: v.managedContentId,
          Language: v.language,
          IsPrimary: v.isPrimary !== false,
          Name: v.title,
          ManagedContentKey: v.contentKey,
          ContentTypeFullyQualifiedName: v.contentType.fullyQualifiedName,
          ManagedContent: { ApiName: v.apiName, AuthoredManagedContentSpaceId: workspace.id },
        }));
      return { records };
    }
    const items = /^\/connect\/cms\/folders\/(\w+)\/folder-items\?.*page=(\d+)/u.exec(url);
    if (items)
      return {
        folderItems:
          items[2] === '0'
            ? (state.folders?.[items[1]] ?? []).map((f) => ({
                isFolder: true,
                managedContentOrFolderId: f.id,
                title: f.name,
                folderSummary: { folderType: 'Standard' },
              }))
            : [],
      };
    const folder = /^\/connect\/cms\/folders\/(\w+)\?/u.exec(url)?.[1];
    if (folder) {
      for (const [parent, children] of Object.entries(state.folders ?? {}))
        for (const child of children)
          if (child.id === folder)
            return {
              name: child.name,
              folderType: 'Standard',
              folderHierarchy: parent === workspace.rootFolderId ? [] : [{ name: 'A' }],
            };
      throw Object.assign(new Error('not found'), { errorCode: 'NOT_FOUND' });
    }
    if (url === '/connect/cms/contents' && input.method === 'POST') {
      counter += 1;
      return store({
        apiName: body.apiName,
        title: body.title,
        urlName: body.urlName,
        contentBody: body.contentBody,
        contentKey: key(),
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

/**
 * Native variant of a golden component as it would be stored in the destination.
 * @param {string} nativeName Fixture name.
 * @param {object} [overrides] Envelope fields and body fields to replace.
 * @returns {Promise<object>} Native variant in the root folder.
 */
async function destinationOf(nativeName, overrides = {}) {
  const native = await nativeOf(nativeName);
  return {
    ...native,
    folder: { id: workspace.rootFolderId },
    ...overrides,
    contentBody: { ...native.contentBody, ...overrides.contentBody },
  };
}

/**
 * A project directory holding the given components (golden files, optionally edited).
 * @param {object[]} components Source files per component.
 * @returns {Promise<string>} Project directory.
 */
async function projectWith(components) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sf-plugin-cms-v1-deploy-'));
  for (const files of components) await writeSourceFiles(directory, WS, files);
  return directory;
}

async function snapshot(directory) {
  const entries = [];
  const walk = async (current) => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      // The invocation log (logs/cms/) is written by every command; component files are not.
      if (entry.isDirectory() && entry.name !== 'logs') await walk(full);
      else if (entry.isDirectory()) continue;
      else entries.push([full, await readFile(full, 'utf8')]);
    }
  };
  await walk(directory);
  return entries.toSorted();
}

async function deploy(argv, orgState, directory) {
  const connection = fakeConnection(orgState.answer);
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
    return { result, calls: connection.calls, writes, exitCode };
  } finally {
    process.exitCode = undefined;
    process.chdir(cwd);
  }
}

const outcomes = (result) => result.result.items.map((item) => [item.apiName, item.outcome]);

test('deploy creates into the root, reads back once, then reports unchanged with no write', async () => {
  const files = await goldenFiles('email', 'Golden_Email_Code');
  const directory = await projectWith([files]);
  const org = fakeOrg();
  const first = await deploy(['-m', 'email:Golden_Email_Code'], org, directory);
  assert.equal(first.result.status, 'success');
  assert.deepEqual(outcomes(first.result), [['Golden_Email_Code', 'created']]);
  assert.equal(first.writes.length, 1);
  const create = JSON.parse(first.writes[0].input.body);
  assert.equal(first.writes[0].input.url, '/connect/cms/contents');
  assert.equal(first.writes[0].input.headers['X-Chatter-Entity-Encoding'], 'false');
  assert.equal(create.contentType, 'sfdc_cms__email');
  assert.equal(create.contentSpaceOrFolderId, workspace.rootFolderId);
  assert.equal(create.apiName, 'Golden_Email_Code');
  assert.equal(create.contentBody.rawHtml, files.companions['.html']);
  assert.equal(create.contentBody.textContent, files.companions['.txt']);
  assert.equal('folderPath' in create, false);
  const after = first.calls.slice(first.calls.indexOf(first.writes[0]) + 1);
  assert.equal(after.filter((call) => call.input.url.includes('/variants/')).length, 1);
  assert.deepEqual(first.result.diagnostics.warnings, []);
  assert.match(first.result.result.items[0].contentKey, /^MC/u);

  const second = await deploy(['-m', 'email:Golden_Email_Code'], org, directory);
  assert.deepEqual(outcomes(second.result), [['Golden_Email_Code', 'unchanged']]);
  assert.equal(second.writes.length, 0);
});

test('deploy updates the default variant only and warns about the others', async () => {
  const files = await goldenFiles('email', 'Golden_Email_Code');
  const directory = await projectWith([files]);
  const primary = await destinationOf('email-code', {
    managedContentVariantId: '9Ps000000000009AAA',
    contentBody: { subjectLine: 'Old subject' },
  });
  const german = {
    ...primary,
    managedContentVariantId: '9Ps000000000010AAA',
    language: 'de',
    isPrimary: false,
  };
  const org = fakeOrg({ variants: [primary, german] });
  const { result, writes } = await deploy(['-m', 'email:Golden_Email_Code'], org, directory);
  assert.equal(result.status, 'success');
  assert.deepEqual(outcomes(result), [['Golden_Email_Code', 'updated']]);
  assert.deepEqual(result.result.items[0].changes, ['contentBody.subjectLine']);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].input.method, 'PUT');
  assert.match(writes[0].input.url, /\/variants\/9Ps000000000009AAA$/u);
  assert.deepEqual(Object.keys(JSON.parse(writes[0].input.body)), [
    'apiName',
    'title',
    'urlName',
    'contentBody',
  ]);
  assert.equal(org.variants.get('9Ps000000000010AAA').contentBody.subjectLine, 'Old subject');
  assert.deepEqual(
    result.diagnostics.warnings.map((w) => [w.code, w.component]),
    [['OTHER_VARIANTS_SKIPPED', 'email:Golden_Email_Code']],
  );
  assert.match(result.diagnostics.warnings[0].message, /left as they are: de$/u);
});

test('preview reports create/update with zero writes and no local file change', async () => {
  const code = await goldenFiles('email', 'Golden_Email_Code');
  const template = await goldenFiles('email-template', 'Golden_Email_Template');
  const directory = await projectWith([code, template]);
  const before = await snapshot(directory);
  const org = fakeOrg({
    variants: [await destinationOf('email-code', { contentBody: { subjectLine: 'Old' } })],
  });
  const { result, writes } = await deploy(
    ['-d', path.join(directory, 'cms'), '--preview'],
    org,
    directory,
  );
  assert.equal(result.status, 'success');
  assert.equal(result.result.preview, true);
  assert.deepEqual(outcomes(result), [
    ['Golden_Email_Template', 'create'],
    ['Golden_Email_Code', 'update'],
  ]);
  assert.equal(writes.length, 0);
  assert.deepEqual(await snapshot(directory), before);
});

test('a write Salesforce refuses stops the deploy; later components are not attempted', async () => {
  const one = await goldenFiles('email', 'Golden_Email_Code');
  const two = { ...one, document: { ...one.document, apiName: 'Second_Email' } };
  const directory = await projectWith([one, two]);
  const org = fakeOrg({
    fail: () => {
      throw Object.assign(new Error('bad'), {
        statusCode: 400,
        data: [{ errorCode: 'INVALID_API_INPUT', message: 'bad input' }],
      });
    },
  });
  const { result, writes, exitCode } = await deploy(
    ['-d', path.join(directory, 'cms')],
    org,
    directory,
  );
  assert.equal(exitCode, 1);
  assert.deepEqual(outcomes(result), [
    ['Golden_Email_Code', 'failed'],
    ['Second_Email', 'not-attempted'],
  ]);
  assert.equal(writes.length, 1);
  assert.deepEqual(
    result.diagnostics.errors.map((error) => [
      error.component,
      error.code,
      error.status,
      error.salesforceErrorCode,
    ]),
    [['email:Golden_Email_Code', 'REQUEST_FAILED', 400, 'INVALID_API_INPUT']],
  );
});

test('a write without an answer is unknown, sent once and never retried', async () => {
  const one = await goldenFiles('email', 'Golden_Email_Code');
  const two = { ...one, document: { ...one.document, apiName: 'Second_Email' } };
  const directory = await projectWith([one, two]);
  const org = fakeOrg({
    fail: () => {
      throw new Error('socket hang up');
    },
  });
  const { result, writes } = await deploy(['-d', path.join(directory, 'cms')], org, directory);
  assert.deepEqual(outcomes(result), [
    ['Golden_Email_Code', 'unknown'],
    ['Second_Email', 'not-attempted'],
  ]);
  assert.equal(result.result.items[0].reason, 'UNKNOWN_OUTCOME');
  assert.equal(writes.length, 1);
  assert.equal(result.diagnostics.errors[0].code, 'UNKNOWN_OUTCOME');
});

test('an unresolved reference blocks the whole deploy before any write', async () => {
  const blocks = await goldenFiles('email', BLOCK_EMAIL);
  const code = await goldenFiles('email', 'Golden_Email_Code');
  const directory = await projectWith([blocks, code]);
  const { result, writes } = await deploy(
    ['-d', path.join(directory, 'cms')],
    fakeOrg(),
    directory,
  );
  assert.equal(result.status, 'failed');
  assert.deepEqual(outcomes(result), [
    ['Golden_Email_Code', 'not-attempted'],
    [BLOCK_EMAIL, 'blocked'],
  ]);
  assert.equal(result.result.items[0].reason, 'DEPLOY_BLOCKED');
  assert.equal(writes.length, 0);
  assert.equal(result.diagnostics.errors[0].code, 'REFERENCE_NOT_IN_DESTINATION');
  assert.match(result.diagnostics.errors[0].message, /image:Golden_Logo, image:Golden_Header/u);
});

test('references to a component the same deploy creates: planned first, then rewritten', async () => {
  const template = await goldenFiles('email-template', 'Golden_Email_Template');
  const code = await goldenFiles('email', 'Golden_Email_Code');
  const linked = {
    ...code,
    document: {
      ...code.document,
      contentBody: {
        ...code.document.contentBody,
        'lightning:link': {
          contentKey: { type: 'email-template', apiName: 'Golden_Email_Template' },
        },
      },
    },
  };
  const directory = await projectWith([template, linked]);
  const preview = await deploy(
    ['-d', path.join(directory, 'cms'), '--preview'],
    fakeOrg(),
    directory,
  );
  assert.deepEqual(outcomes(preview.result), [
    ['Golden_Email_Template', 'create'],
    ['Golden_Email_Code', 'planned-dependencies'],
  ]);
  assert.deepEqual(preview.result.result.items[1].dependencies, [
    'email-template:Golden_Email_Template',
  ]);
  const org = fakeOrg();
  const { result, writes } = await deploy(['-d', path.join(directory, 'cms')], org, directory);
  assert.equal(result.status, 'success');
  assert.deepEqual(outcomes(result), [
    ['Golden_Email_Template', 'created'],
    ['Golden_Email_Code', 'created'],
  ]);
  const templateKey = result.result.items[0].contentKey;
  assert.equal(
    JSON.parse(writes[1].input.body).contentBody['lightning:link'].contentKey,
    templateKey,
  );
  assert.deepEqual(result.diagnostics.warnings, []);
});

test('folderPath resolves by name below the root; a missing folder blocks', async () => {
  const code = await goldenFiles('email', 'Golden_Email_Code');
  const nested = { ...code, document: { ...code.document, folderPath: ['A', 'B'] } };
  const directory = await projectWith([nested]);
  const folders = {
    [workspace.rootFolderId]: [{ id: '9Pu00000000000AAAA', name: 'A' }],
    '9Pu00000000000AAAA': [{ id: '9Pu00000000000BAAA', name: 'B' }],
  };
  const { result, writes } = await deploy(
    ['-m', 'email:Golden_Email_Code'],
    fakeOrg({ folders }),
    directory,
  );
  assert.equal(result.status, 'success');
  assert.equal(JSON.parse(writes[0].input.body).contentSpaceOrFolderId, '9Pu00000000000BAAA');
  const missing = await deploy(
    ['-m', 'email:Golden_Email_Code'],
    fakeOrg({ folders: { [workspace.rootFolderId]: [] } }),
    directory,
  );
  assert.deepEqual(outcomes(missing.result), [['Golden_Email_Code', 'blocked']]);
  assert.equal(missing.result.diagnostics.errors[0].code, 'FOLDER_NOT_FOUND');
  assert.equal(missing.writes.length, 0);
});

test('selection: files, companions, folders; bare types and duplicates are refused', async () => {
  const code = await goldenFiles('email', 'Golden_Email_Code');
  const template = await goldenFiles('email-template', 'Golden_Email_Template');
  const directory = await projectWith([code, template]);
  const emailDirectory = path.join(directory, 'cms', WS, 'email');
  const names = async (...arguments_) => {
    const sources = await selectSources(...arguments_);
    return sources.map((s) => `${s.handler.type}:${s.apiName}`);
  };
  assert.deepEqual(
    await names(undefined, [path.join(emailDirectory, 'Golden_Email_Code.email.html')], directory),
    ['email:Golden_Email_Code'],
  );
  assert.deepEqual(await names(undefined, [directory], directory), [
    'email-template:Golden_Email_Template',
    'email:Golden_Email_Code',
  ]);
  assert.deepEqual(await names(['email:Golden_Email_Code'], [emailDirectory], directory), [
    'email:Golden_Email_Code',
  ]);
  await assert.rejects(selectSources(['email'], undefined, directory), {
    code: 'INVALID_SELECTOR',
  });
  await assert.rejects(selectSources(['email:Nope'], undefined, directory), {
    code: 'SOURCE_NOT_FOUND',
  });
  await writeSourceFiles(directory, 'Cloud_Kicks', code);
  await assert.rejects(selectSources(['email:Golden_Email_Code'], undefined, directory), {
    code: 'SOURCE_AMBIGUOUS',
  });
  await mkdir(path.join(directory, 'loose'), { recursive: true });
  await writeFile(path.join(directory, 'loose', 'x.email.json'), '{}');
  await assert.rejects(
    selectSources(undefined, [path.join(directory, 'loose', 'x.email.json')], directory),
    {
      code: 'INVALID_SOURCE_PATH',
    },
  );
});
