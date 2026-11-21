import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { emailHandler } from '../lib/content/handlers/email.js';
import { emailTemplateHandler } from '../lib/content/handlers/email-template.js';
import { referencedContentKeys } from '../lib/content/json-projection.js';
import { cliTypeName, handlerOf, HANDLERS } from '../lib/content/registry.js';
import {
  listSourceComponents,
  readSourceFiles,
  writeSourceFiles,
} from '../lib/content/source-files.js';

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const golden = path.join(fixtures, 'golden');
const workspace = {
  id: '0Zu000000000001AAA',
  apiName: 'Default_Content_Workspace',
  name: 'Workspace',
  type: 'marketing',
  enhanced: true,
  defaultLanguage: 'en_US',
  rootFolderId: '9Pu000000000001AAA',
};
const references = {
  MCGOLDENBAAAAAAAAAAAAAAAAAAA: { type: 'image', apiName: 'Golden_Logo' },
  MCGOLDENCAAAAAAAAAAAAAAAAAAA: { type: 'image', apiName: 'Golden_Header' },
};

async function native(name) {
  return JSON.parse(await readFile(path.join(fixtures, 'native', `${name}.variant.json`), 'utf8'));
}

function context(overrides = {}) {
  const warnings = [];
  return {
    warnings,
    context: {
      workspace,
      folderPath: [],
      referenceOf: (key) => references[key],
      warn: (warning) => warnings.push(warning),
      ...overrides,
    },
  };
}

const scratch = () => mkdtemp(path.join(os.tmpdir(), 'sf-plugin-cms-v1-source-'));

/**
 * Every file under a directory, relative, with its text.
 * @param {string} root Directory.
 * @returns {Promise<Record<string, string>>} Files.
 */
async function tree(root) {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  const files = {};
  for (const entry of entries.filter((item) => item.isFile())) {
    const full = path.join(entry.parentPath, entry.name);
    files[path.relative(root, full).replaceAll('\\', '/')] = await readFile(full, 'utf8');
  }
  return files;
}

for (const [fixture, handler] of [
  ['email-blocks', emailHandler],
  ['email-code', emailHandler],
  ['email-template', emailTemplateHandler],
]) {
  test(`golden: ${fixture} native -> files`, async () => {
    const { context: context_, warnings } = context();
    const root = await scratch();
    await writeSourceFiles(
      root,
      'Default_Content_Workspace',
      handler.toSource(await native(fixture), context_),
    );
    const written = await tree(root);
    const expected = await tree(golden);
    for (const [file, content] of Object.entries(written))
      assert.equal(content, expected[file], file);
    assert.ok(Object.keys(written).length > 0);
    assert.deepEqual(warnings, []);
  });
}

test('golden: no IDs, keys, status or generated media URLs in the JSON', async () => {
  const files = await tree(golden);
  for (const [file, text] of Object.entries(files)) {
    // A component created in the UI has its content key as API name: that one stays.
    const content = text.replace(/^ {2}"apiName": "[^"]*",$/mu, '');
    assert.doesNotMatch(content, /\b(?:20Y|9Ps|9Pu|0Zu|005|5OU)[A-Za-z0-9]{12}/u, file);
    assert.doesNotMatch(content, /"MC[A-Z2-7]{26}"|\/cms\/media\/|"status"|isPublished/u, file);
  }
});

test('code email: rawHtml and textContent become companions, the JSON keeps the rest', async () => {
  const files = emailHandler.toSource(await native('email-code'), context().context);
  assert.deepEqual(Object.keys(files.companions), ['.html', '.txt']);
  assert.equal(
    files.companions['.html'],
    '<!doctype html><html><body><p>Golden fixture body.</p></body></html>\n',
  );
  assert.equal('rawHtml' in files.document.contentBody, false);
  assert.equal(files.document.contentBody.subjectLine, 'Golden fixture subject');
});

test('unknown native fields are kept; runtime fields and null externalId are dropped', async () => {
  const variant = {
    ...(await native('email-code')),
    futureField: { b: 1, a: 2 },
    externalId: null,
  };
  variant.contentBody = { ...variant.contentBody, futureBodyKey: 'x' };
  const { document } = emailHandler.toSource(variant, context().context);
  assert.deepEqual(document.futureField, { a: 2, b: 1 });
  assert.equal(document.contentBody.futureBodyKey, 'x');
  for (const key of [
    'managedContentId',
    'contentKey',
    'status',
    'folder',
    'language',
    'externalId',
  ])
    assert.equal(key in document, false, key);
  // title and urlName live in the body (sfdc_cms:title / sfdc_cms:urlName), once.
  assert.deepEqual(Object.keys(document).slice(0, 3), ['apiName', 'folderPath', 'futureField']);
  assert.equal(document.contentBody['sfdc_cms:title'], variant.title);
  const template = { ...variant, contentBody: { 'sfdc_cms:title': 'T' } };
  assert.deepEqual(Object.keys(emailHandler.toSource(template, context().context).document), [
    'apiName',
    'urlName',
    'folderPath',
    'futureField',
    'contentBody',
  ]);
  const withId = emailHandler.toSource({ ...variant, externalId: 'ext-1' }, context().context);
  assert.equal(withId.document.externalId, 'ext-1');
});

test('folder path comes from the context; an unresolved reference warns and keeps the key', async () => {
  const { context: context_, warnings } = context({
    folderPath: ['A', 'B'],
    referenceOf: () => {},
  });
  const variant = await native('email-blocks');
  assert.deepEqual(referencedContentKeys(variant.contentBody), [
    'MCGOLDENBAAAAAAAAAAAAAAAAAAA',
    'MCGOLDENCAAAAAAAAAAAAAAAAAAA',
  ]);
  const { document } = emailHandler.toSource(variant, context_);
  assert.deepEqual(document.folderPath, ['A', 'B']);
  assert.match(JSON.stringify(document), /"contentKey":"MCGOLDENBAAAAAAAAAAAAAAAAAAA"/u);
  assert.deepEqual(
    warnings.map((warning) => warning.code),
    ['REFERENCE_UNRESOLVED', 'REFERENCE_UNRESOLVED'],
  );
});

test('writer: unchanged on a second write, stale companions removed, reader returns the files', async () => {
  const root = await scratch();
  const files = emailHandler.toSource(await native('email-code'), context().context);
  const first = await writeSourceFiles(root, 'WS', files);
  const second = await writeSourceFiles(root, 'WS', files);
  assert.deepEqual([first.outcome, second.outcome], ['retrieved', 'unchanged']);
  const read = await readSourceFiles(root, 'WS', 'email', 'Golden_Email_Code');
  assert.deepEqual(read, files);
  assert.deepEqual(await listSourceComponents(root, 'WS', 'email'), ['Golden_Email_Code']);
  assert.deepEqual(await listSourceComponents(root, 'WS', 'image'), []);
  const withoutText = { ...files, companions: { '.html': files.companions['.html'] } };
  const written = await writeSourceFiles(root, 'WS', withoutText);
  assert.equal(written.outcome, 'retrieved');
  const names = await readdir(path.join(root, 'cms', 'WS', 'email'));
  assert.deepEqual(names.toSorted(), [
    'Golden_Email_Code.email.html',
    'Golden_Email_Code.email.json',
  ]);
});

test('writer and reader refuse unsafe names and invalid documents', async () => {
  const root = await scratch();
  const files = emailHandler.toSource(await native('email-code'), context().context);
  for (const apiName of ['../x', 'a.b', 'a/b', ''])
    await assert.rejects(
      writeSourceFiles(root, 'WS', { ...files, document: { ...files.document, apiName } }),
      { code: 'INVALID_FILE_NAME' },
    );
  await writeSourceFiles(root, 'WS', files);
  const file = path.join(root, 'cms', 'WS', 'email', 'Golden_Email_Code.email.json');
  await writeFile(file, '{"apiName":"Golden_Email_Code"}');
  await assert.rejects(readSourceFiles(root, 'WS', 'email', 'Golden_Email_Code'), {
    code: 'INVALID_SOURCE_FILE',
  });
});

test('registry: CLI names follow the content type; unknown types are refused', () => {
  assert.equal(cliTypeName('sfdc_cms__emailTemplate'), 'email-template');
  assert.equal(cliTypeName('sfdc_cms__image'), 'image');
  assert.equal(cliTypeName('custom__thing'), 'custom__thing');
  for (const handler of HANDLERS) assert.equal(cliTypeName(handler.apiName), handler.type);
  assert.throws(() => handlerOf('landing-page'), { code: 'UNKNOWN_TYPE' });
});

test('title and urlName live once: an envelope copy of the body value is refused', async () => {
  const files = await readSourceFiles(
    golden,
    'Default_Content_Workspace',
    'email',
    'Golden_Email_Code',
  );
  assert.equal('title' in files.document, false);
  assert.equal(emailHandler.fromSource(files, { workspace }).title, undefined);
  assert.throws(
    () =>
      emailHandler.fromSource(
        { ...files, document: { ...files.document, title: 'Other' } },
        { workspace },
      ),
    { code: 'UNKNOWN_SETTING', message: /title \(held in contentBody\.sfdc_cms:title\)/u },
  );
});
