import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Config } from '@oclif/core';
import Retrieve from '../lib/commands/cms/retrieve.js';
import { HANDLERS } from '../lib/content/registry.js';
import { folderPathOf } from '../lib/services/folders.js';
import { groupInventory, queryVariants, soqlString } from '../lib/services/inventory.js';
import { parseSelection } from '../lib/services/retrieve.js';
import { fakeConnection } from './support/fake-connection.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const workspace = {
  apiName: 'Default_Content_Workspace',
  id: '0Zu000000000001AAA',
  isEnhancedSpace: true,
  name: 'Workspace',
  defaultLanguage: 'en_US',
  rootFolderId: '9Pu000000000001AAA',
  spaceType: { apiName: 'marketing' },
};
const nativeOf = async (name) =>
  JSON.parse(await readFile(path.join(here, 'fixtures', 'native', `${name}.variant.json`), 'utf8'));

function row(id, apiName, extra = {}) {
  return {
    Id: id,
    ManagedContentId: `20Y${apiName}`,
    Language: 'en_US',
    IsPrimary: true,
    Name: apiName,
    ManagedContentKey: null,
    ContentTypeFullyQualifiedName: 'sfdc_cms__email',
    ManagedContent: { ApiName: apiName, AuthoredManagedContentSpaceId: workspace.id },
    ...extra,
  };
}

let config;
let cwd;
before(async () => {
  config = await Config.load(root);
  cwd = process.cwd();
  process.chdir(await mkdtemp(path.join(os.tmpdir(), 'sf-plugin-cms-v1-retrieve-')));
});
after(() => process.chdir(cwd));

async function run(argv, answer) {
  const connection = fakeConnection(answer);
  class Fake extends Retrieve {
    resolveOrg = async () => ({
      connection,
      orgId: '00D000000000001AAA',
      username: 'u@example.com',
    });
  }
  const output = await mkdtemp(path.join(os.tmpdir(), 'sf-plugin-cms-v1-retrieve-out-'));
  process.exitCode = undefined;
  const result = await Fake.run([...argv, '--output-dir', output, '--json'], config);
  const exitCode = process.exitCode;
  process.exitCode = undefined;
  return { result, calls: connection.calls, exitCode, output };
}

/**
 * Answers for one workspace: SOQL rows by type, variant bodies by ID.
 * @param {{ rows?: object; variants?: object }} answers SOQL rows by content type
 *   (`references` for the content-key lookup) and variant bodies or errors by ID.
 * @returns {(input: { url: string }) => unknown} Fake answer function.
 */
function org(answers) {
  const { rows = {}, variants = {} } = answers;
  return (input) => {
    const url = decodeURIComponent(input.url.replaceAll('+', ' '));
    if (url.startsWith('/connect/cms/spaces?'))
      return { spaces: url.includes('page=0') ? [workspace] : [] };
    if (url.startsWith('/query?')) {
      const type = /ContentTypeFullyQualifiedName = '(\w+)'/u.exec(url)?.[1];
      if (url.includes('ManagedContentKey IN')) return { records: rows.references ?? [] };
      let records = rows[type] ?? [];
      const names = /ApiName IN \(([^)]*)\)/u.exec(url)?.[1];
      if (names) records = records.filter((r) => names.includes(`'${r.ManagedContent.ApiName}'`));
      return { records };
    }
    const variant = /\/connect\/cms\/contents\/variants\/(\w+)$/u.exec(url)?.[1];
    if (variant && variants[variant]) {
      const value = variants[variant];
      if (value instanceof Error) throw value;
      return value;
    }
    throw Object.assign(new Error('not found'), { errorCode: 'NOT_FOUND' });
  };
}

test('selection: bare type means all, names collect per type, unknown types are refused', () => {
  assert.deepEqual(
    parseSelection(['email:B', 'email:A', 'email-template', 'email-template:X']).map((s) => [
      s.handler.type,
      s.apiNames,
    ]),
    [
      ['email-template', 'all'],
      ['email', ['A', 'B']],
    ],
  );
  assert.equal(parseSelection().length, HANDLERS.length);
  assert.throws(() => parseSelection(['no-such-type']), { code: 'UNKNOWN_TYPE' });
  assert.throws(() => parseSelection(['email:']), { code: 'INVALID_SELECTOR' });
});

test('inventory: keyset paging until a short page, SOQL literals escaped', async () => {
  const pages = [
    Array.from({ length: 2000 }, (_, index) =>
      row(`9Ps${String(index).padStart(5, '0')}`, `N${index}`),
    ),
    [row('9Psz', 'Last')],
  ];
  const connection = fakeConnection(() => ({ records: pages.shift() }));
  const rows = await queryVariants(connection, 'X = 1');
  assert.equal(rows.length, 2001);
  const second = decodeURIComponent(connection.calls[1].input.url.replaceAll('+', ' '));
  assert.match(second, /WHERE X = 1 AND Id > '9Ps01999' ORDER BY Id LIMIT 2000$/u);
  assert.equal(soqlString(String.raw`it's \ ok`), String.raw`'it\'s \\ ok'`);
});

test('inventory: the default variant is the primary one, else the default language', async () => {
  const rows = [
    row('9Ps1', 'A', { IsPrimary: false, Language: 'de' }),
    row('9Ps2', 'A'),
    row('9Ps3', 'B', { IsPrimary: false, Language: 'de' }),
    row('9Ps4', 'B', { IsPrimary: false, Language: 'en_US' }),
    row('9Ps5', 'C', { IsPrimary: false, Language: 'fr' }),
  ];
  const variants = await queryVariants(
    fakeConnection(() => ({ records: rows })),
    'X = 1',
  );
  const [a, b, c] = groupInventory(variants, 'en_US');
  assert.equal(a.defaultVariant.id, '9Ps2');
  assert.deepEqual(
    a.otherVariants.map((v) => v.language),
    ['de'],
  );
  assert.equal(b.defaultVariant.id, '9Ps4');
  assert.equal(c.defaultVariant, undefined);
});

test('folder path: root is [], nested folders list the names below the root', async () => {
  const ws = { id: workspace.id, rootFolderId: '9Pu000000000001', apiName: 'W' };
  const connection = fakeConnection(() => ({
    name: 'Child',
    folderType: 'Standard',
    folderHierarchy: [
      { folderType: 'System', name: 'Root', id: '9Pu000000000001AAA' },
      { folderType: 'Standard', name: 'Parent', id: '9Pu000000000002AAA' },
    ],
  }));
  assert.deepEqual(await folderPathOf(connection, ws, '9Pu000000000001AAA'), []);
  assert.equal(connection.calls.length, 0);
  assert.deepEqual(await folderPathOf(connection, ws, '9Pu000000000003AAA'), ['Parent', 'Child']);
  assert.match(connection.calls[0].input.url, /contextContentSpaceId=0Zu000000000001AAA/u);
});

test('retrieve -m email writes every email, raw text requested, references resolved', async () => {
  const blocks = await nativeOf('email-blocks');
  const code = await nativeOf('email-code');
  const { result, calls, exitCode, output } = await run(
    ['-m', 'email', '--workspace', 'Default_Content_Workspace'],
    org({
      rows: {
        sfdc_cms__email: [row('9PsA', blocks.apiName), row('9PsB', 'Golden_Email_Code')],
        references: [
          row('9PsR1', 'Golden_Logo', {
            ManagedContentKey: 'MCGOLDENBAAAAAAAAAAAAAAAAAAA',
            ContentTypeFullyQualifiedName: 'sfdc_cms__image',
          }),
          row('9PsR2', 'Golden_Header', {
            ManagedContentKey: 'MCGOLDENCAAAAAAAAAAAAAAAAAAA',
            ContentTypeFullyQualifiedName: 'sfdc_cms__image',
          }),
        ],
      },
      variants: { '9PsA': blocks, '9PsB': code },
    }),
  );
  assert.equal(exitCode, undefined);
  assert.equal(result.status, 'success');
  assert.deepEqual(
    result.result.items.map((item) => [item.type, item.apiName, item.outcome]),
    [
      ['email', 'Golden_Email_Code', 'retrieved'],
      ['email', blocks.apiName, 'retrieved'],
    ],
  );
  assert.deepEqual(result.diagnostics.warnings, []);
  for (const call of calls)
    assert.deepEqual(call.input.headers, { 'X-Chatter-Entity-Encoding': 'false' });
  const written = await readFile(result.result.items[1].path, 'utf8');
  const expected = await readFile(
    path.join(
      here,
      'fixtures',
      'golden',
      'cms',
      'Default_Content_Workspace',
      'email',
      `${blocks.apiName}.email.json`,
    ),
    'utf8',
  );
  assert.equal(written, expected);
  assert.deepEqual(await readdir(path.join(output, 'cms', 'Default_Content_Workspace', 'email')), [
    'Golden_Email_Code.email.html',
    'Golden_Email_Code.email.json',
    'Golden_Email_Code.email.txt',
    `${blocks.apiName}.email.json`,
  ]);
});

test('retrieve warns OTHER_VARIANTS_SKIPPED and writes only the default variant', async () => {
  const code = await nativeOf('email-code');
  const { result, calls } = await run(
    ['-m', 'email:Golden_Email_Code', '--workspace', workspace.id],
    org({
      rows: {
        sfdc_cms__email: [
          row('9PsB', 'Golden_Email_Code'),
          row('9PsD', 'Golden_Email_Code', { IsPrimary: false, Language: 'de' }),
        ],
      },
      variants: { '9PsB': code },
    }),
  );
  assert.equal(result.status, 'success');
  assert.equal(result.result.items.length, 1);
  assert.equal(calls.filter((call) => call.input.url.includes('/variants/')).length, 1);
  assert.deepEqual(
    result.diagnostics.warnings.map((w) => [w.code, w.component]),
    [['OTHER_VARIANTS_SKIPPED', 'email:Golden_Email_Code']],
  );
  assert.match(result.diagnostics.warnings[0].message, /skipped: de$/u);
});

test('retrieve is lenient: a failing read and a missing name do not stop the others', async () => {
  const code = await nativeOf('email-code');
  const template = await nativeOf('email-template');
  const failure = Object.assign(new Error('boom'), {
    statusCode: 500,
    data: [{ errorCode: 'UNKNOWN_EXCEPTION', message: 'boom' }],
  });
  const { result, exitCode } = await run(
    [
      '-m',
      'email:Golden_Email_Code',
      '-m',
      'email:Broken',
      '-m',
      'email:Missing',
      '-m',
      'email-template',
      '--workspace',
      'Default_Content_Workspace',
    ],
    org({
      rows: {
        sfdc_cms__email: [row('9PsB', 'Golden_Email_Code'), row('9PsX', 'Broken')],
        sfdc_cms__emailTemplate: [row('9PsT', 'Golden_Email_Template')],
      },
      variants: { '9PsB': code, '9PsX': failure, '9PsT': template },
    }),
  );
  assert.equal(exitCode, 1);
  assert.equal(result.status, 'failed');
  assert.deepEqual(
    result.result.items.map((item) => `${item.type}:${item.apiName}`),
    ['email-template:Golden_Email_Template', 'email:Golden_Email_Code'],
  );
  assert.deepEqual(
    result.diagnostics.errors.map((error) => [error.component, error.code, error.status]),
    [
      ['email:Missing', 'COMPONENT_NOT_FOUND', undefined],
      ['email:Broken', 'REQUEST_FAILED', 500],
    ],
  );
});

test('retrieve refuses an unknown type before reading content', async () => {
  const { result, calls, exitCode } = await run(
    ['-m', 'no-such-type', '--workspace', 'Default_Content_Workspace'],
    org({}),
  );
  assert.equal(exitCode, 1);
  assert.equal(result.diagnostics.errors[0].code, 'UNKNOWN_TYPE');
  assert.equal(calls.length, 0);
});
