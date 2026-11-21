import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Config } from '@oclif/core';
import Delete from '../lib/commands/cms/delete.js';
import Publish from '../lib/commands/cms/publish.js';
import Unpublish from '../lib/commands/cms/unpublish.js';
import { fakeConnection } from './support/fake-connection.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
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
const commands = { delete: Delete, publish: Publish, unpublish: Unpublish };

let config;
before(async () => {
  config = await Config.load(root);
});

const salesforceError = (statusCode, errorCode, message = errorCode) =>
  Object.assign(new Error(message), { statusCode, data: [{ errorCode, message }] });

/**
 * An in-memory workspace of variants. `variants` rows: { id, mc, apiName, type, language,
 * primary, published }. Hooks may replace the answer of DELETE, publish and unpublish.
 * @param {object[]} rows Stored variants.
 * @param {{ onDelete?: Function; onPublish?: Function; keepAfterDelete?: boolean }} [hooks]
 *   Answer overrides.
 * @returns {{ answer: Function; rows: object[] }} Answer function and the store.
 */
function fakeOrg(rows, hooks = {}) {
  const store = rows.map((row) => ({ primary: true, published: false, language: 'en_US', ...row }));
  const answer = (input) => {
    const url = decodeURIComponent(input.url.replaceAll('+', ' '));
    if (url.startsWith('/connect/cms/spaces?'))
      return { spaces: url.includes('page=0') ? [workspace] : [] };
    if (url.startsWith('/query?')) {
      const type = /ContentTypeFullyQualifiedName = '(\w+)'/u.exec(url)?.[1];
      const names = /ApiName IN \(([^)]*)\)/u.exec(url)?.[1] ?? '';
      return {
        records: store
          .filter((v) => v.type === type && names.includes(`'${v.apiName}'`))
          .map((v) => ({
            Id: v.id,
            ManagedContentId: v.mc,
            Language: v.language,
            IsPrimary: v.primary,
            Name: v.apiName,
            ManagedContentKey: `MC${v.mc}`,
            ContentTypeFullyQualifiedName: v.type,
            ManagedContent: { ApiName: v.apiName, AuthoredManagedContentSpaceId: workspace.id },
          })),
      };
    }
    const variant = /^\/connect\/cms\/contents\/variants\/(\w+)$/u.exec(url)?.[1];
    if (variant) {
      const index = store.findIndex((v) => v.id === variant);
      if (input.method === 'DELETE') {
        if (index !== -1 && !hooks.keepAfterDelete) store.splice(index, 1);
        if (hooks.onDelete) return hooks.onDelete();
        if (index === -1) throw salesforceError(404, 'VARIANT_NOT_FOUND');
        return;
      }
      if (index === -1) throw salesforceError(404, 'VARIANT_NOT_FOUND');
      const row = store[index];
      return {
        managedContentVariantId: row.id,
        managedContentId: row.mc,
        apiName: row.apiName,
        language: row.language,
        isPublished: row.published,
      };
    }
    const action = /^\/connect\/cms\/contents\/(publish|unpublish)$/u.exec(url)?.[1];
    if (action) {
      const body = JSON.parse(input.body);
      if (hooks.onPublish) return hooks.onPublish(body);
      for (const row of store)
        if (body.variantIds.includes(row.id)) row.published = action === 'publish';
      return { deploymentId: '0jk000000000001AAA', description: '#DEPLOYED' };
    }
    throw salesforceError(404, 'NOT_FOUND');
  };
  return { answer, rows: store };
}

const email = (apiName, n, extra = {}) => ({
  id: `9Ps00000000000${n}AAA`,
  mc: `20Y00000000000${n}AAA`,
  apiName,
  type: 'sfdc_cms__email',
  ...extra,
});

/**
 * A project directory with local files for the given components (`[type, apiName]`).
 * @param {string[][]} components Components.
 * @returns {Promise<string>} Project directory.
 */
async function projectWith(components) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sf-plugin-cms-v1-lifecycle-'));
  for (const [type, apiName] of components) {
    const folder = path.join(directory, 'cms', WS, type);
    await mkdir(folder, { recursive: true });
    await writeFile(path.join(folder, `${apiName}.${type}.json`), '{}\n');
    await writeFile(path.join(folder, `${apiName}.${type}.html`), '<p></p>\n');
  }
  return directory;
}

async function snapshot(directory) {
  const entries = [];
  const walk = async (current) => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      // The invocation log (logs/cms/) is written by every command.
      if (entry.isDirectory() && entry.name !== 'logs') await walk(full);
      else if (!entry.isDirectory()) entries.push([full, await readFile(full, 'utf8')]);
    }
  };
  await walk(directory);
  return entries.toSorted();
}

async function run(action, argv, org, directory) {
  const connection = fakeConnection(org.answer);
  let orgResolved = false;
  class Fake extends commands[action] {
    resolveOrg = async () => {
      orgResolved = true;
      return { connection, orgId: '00D000000000001AAA', username: 'u@example.com' };
    };
    writeOptions = { allowCallerConnection: true };
  }
  const cwd = process.cwd();
  process.chdir(directory);
  process.exitCode = undefined;
  try {
    const result = await Fake.run([...argv, '--workspace', WS, '--json'], config);
    const writes = connection.calls.filter((call) => call.input.method !== 'GET');
    return { result, writes, calls: connection.calls, orgResolved, exitCode: process.exitCode };
  } finally {
    process.exitCode = undefined;
    process.chdir(cwd);
  }
}

const outcomes = (result) => result.result.items.map((item) => [item.apiName, item.outcome]);
const codes = (list) => list.map((d) => [d.component, d.code]);

test('type-only, wildcard, folder and empty selections are refused before any org access', async () => {
  const directory = await projectWith([['email', 'One']]);
  const org = fakeOrg([email('One', 1)]);
  for (const action of ['delete', 'publish', 'unpublish'])
    for (const argv of [
      ['-m', 'email'],
      ['-m', 'email:*'],
      ['-m', 'email:One*'],
      ['-d', path.join(directory, 'cms', WS, 'email')],
      ['-d', path.join(directory, 'cms')],
      [],
    ]) {
      const { result, calls, orgResolved, exitCode } = await run(action, argv, org, directory);
      assert.equal(result.status, 'failed', `${action} ${argv.join(' ')}`);
      assert.deepEqual(codes(result.diagnostics.errors), [[undefined, 'EXACT_SELECTOR_REQUIRED']]);
      assert.equal(orgResolved, false);
      assert.equal(calls.length, 0);
      assert.equal(exitCode, 1);
    }
});

test('delete confirms by readback: a 404 answer with the component gone is deleted', async () => {
  const directory = await projectWith([['email', 'One']]);
  const org = fakeOrg([email('One', 1)], {
    onDelete: () => {
      throw salesforceError(404, 'VARIANT_NOT_FOUND', 'No ManagedContentVariant found');
    },
  });
  const { result, writes, calls } = await run('delete', ['-m', 'email:One'], org, directory);
  assert.equal(result.status, 'success');
  assert.deepEqual(outcomes(result), [['One', 'deleted']]);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].input.url, '/connect/cms/contents/variants/9Ps000000000001AAA');
  assert.equal(calls.at(-1).input.method, 'GET');
  assert.deepEqual(codes(result.diagnostics.warnings), [['email:One', 'DELETE_ANSWER_IGNORED']]);
  assert.deepEqual(
    result.result.items[0].removedLocalFiles.map((file) => [
      path.basename(file.path),
      file.outcome,
    ]),
    [
      ['One.email.html', 'removed'],
      ['One.email.json', 'removed'],
    ],
  );
  assert.deepEqual(await readdir(path.join(directory, 'cms', WS, 'email')), []);
});

test('delete that reads back as still there fails, keeps the files and stops', async () => {
  const directory = await projectWith([
    ['email', 'One'],
    ['email', 'Two'],
  ]);
  const before = await snapshot(directory);
  const org = fakeOrg([email('One', 1), email('Two', 2)], { keepAfterDelete: true });
  const { result, writes, exitCode } = await run(
    'delete',
    ['-m', 'email:One', '-m', 'email:Two'],
    org,
    directory,
  );
  assert.equal(exitCode, 1);
  // Reverse registry order, then API name reversed: Two is handled first.
  assert.deepEqual(outcomes(result), [
    ['Two', 'failed'],
    ['One', 'not-attempted'],
  ]);
  assert.equal(writes.length, 1);
  assert.deepEqual(codes(result.diagnostics.errors), [['email:Two', 'DELETE_NOT_CONFIRMED']]);
  assert.deepEqual(await snapshot(directory), before);
});

test('delete of a component the workspace does not have is unchanged and writes nothing', async () => {
  const directory = await projectWith([['email', 'Gone']]);
  const before = await snapshot(directory);
  const { result, writes } = await run('delete', ['-m', 'email:Gone'], fakeOrg([]), directory);
  assert.equal(result.status, 'success');
  assert.deepEqual(outcomes(result), [['Gone', 'unchanged']]);
  assert.equal(writes.length, 0);
  assert.deepEqual(await snapshot(directory), before);
});

test('delete refuses a component with other variants; nothing is sent for any component', async () => {
  const directory = await projectWith([['email', 'One']]);
  const org = fakeOrg([
    email('One', 1),
    email('One', 1, { id: '9Ps000000000009AAA', language: 'de', primary: false }),
    email('Two', 2),
  ]);
  const { result, writes } = await run(
    'delete',
    ['-m', 'email:One', '-m', 'email:Two'],
    org,
    directory,
  );
  assert.deepEqual(outcomes(result), [
    ['Two', 'not-attempted'],
    ['One', 'blocked'],
  ]);
  assert.equal(result.result.items[0].reason, 'LIFECYCLE_BLOCKED');
  assert.deepEqual(codes(result.diagnostics.errors), [['email:One', 'HAS_OTHER_VARIANTS']]);
  assert.match(result.diagnostics.errors[0].message, /: de$/u);
  assert.equal(writes.length, 0);
});

test('--keep-local-files keeps the files of a confirmed delete', async () => {
  const directory = await projectWith([['email', 'One']]);
  const before = await snapshot(directory);
  const { result } = await run(
    'delete',
    ['-m', 'email:One', '--keep-local-files'],
    fakeOrg([email('One', 1)]),
    directory,
  );
  assert.deepEqual(outcomes(result), [['One', 'deleted']]);
  assert.deepEqual(
    result.result.items[0].removedLocalFiles.map((file) => file.outcome),
    ['kept', 'kept'],
  );
  assert.deepEqual(await snapshot(directory), before);
});

test('delete -d removes the files where the given component file lives', async () => {
  const directory = await projectWith([['email-template', 'Tpl']]);
  const file = path.join(directory, 'cms', WS, 'email-template', 'Tpl.email-template.html');
  const org = fakeOrg([{ ...email('Tpl', 3), type: 'sfdc_cms__emailTemplate' }]);
  const elsewhere = await mkdtemp(path.join(os.tmpdir(), 'sf-plugin-cms-v1-lifecycle-cwd-'));
  const { result } = await run('delete', ['-d', file], org, elsewhere);
  assert.deepEqual(outcomes(result), [['Tpl', 'deleted']]);
  assert.deepEqual(await readdir(path.dirname(file)), []);
});

test('delete --preview lists the files it would remove and changes nothing', async () => {
  const directory = await projectWith([['email', 'One']]);
  const before = await snapshot(directory);
  const org = fakeOrg([email('One', 1), email('NoFiles', 4)]);
  const { result, writes } = await run(
    'delete',
    ['-m', 'email:One', '-m', 'email:NoFiles', '-m', 'email:Absent', '--preview'],
    org,
    directory,
  );
  assert.equal(result.status, 'success');
  assert.deepEqual(outcomes(result), [
    ['One', 'delete'],
    ['NoFiles', 'delete'],
    ['Absent', 'unchanged'],
  ]);
  assert.deepEqual(
    result.result.items[0].localFiles.map((file) => [path.basename(file.path), file.exists]),
    [
      ['One.email.html', true],
      ['One.email.json', true],
    ],
  );
  assert.deepEqual(
    result.result.items[1].localFiles.map((file) => [path.basename(file.path), file.exists]),
    [['NoFiles.email.json', false]],
  );
  assert.equal(writes.length, 0);
  assert.equal(org.rows.length, 2);
  assert.deepEqual(await snapshot(directory), before);
});

test('publish sends the default variant in the workspace context and reads the state back', async () => {
  const directory = await projectWith([]);
  const org = fakeOrg([
    { ...email('Tpl', 3), type: 'sfdc_cms__emailTemplate' },
    email('One', 1),
    email('One', 1, { id: '9Ps000000000009AAA', language: 'de', primary: false }),
  ]);
  const { result, writes } = await run(
    'publish',
    ['-m', 'email:One', '-m', 'email-template:Tpl'],
    org,
    directory,
  );
  assert.equal(result.status, 'success');
  // Registry order: the template (referenced by emails) first.
  assert.deepEqual(outcomes(result), [
    ['Tpl', 'published'],
    ['One', 'published'],
  ]);
  assert.deepEqual(
    writes.map((call) => [call.input.url, JSON.parse(call.input.body)]),
    [
      [
        '/connect/cms/contents/publish',
        {
          variantIds: ['9Ps000000000003AAA'],
          contextContentSpaceId: workspace.id,
          includeContentReferences: false,
        },
      ],
      [
        '/connect/cms/contents/publish',
        {
          variantIds: ['9Ps000000000001AAA'],
          contextContentSpaceId: workspace.id,
          includeContentReferences: false,
        },
      ],
    ],
  );
  assert.equal(result.result.items[1].isPublished, true);
  assert.equal(result.result.items[1].answer.deploymentId, '0jk000000000001AAA');
  assert.deepEqual(codes(result.diagnostics.warnings), [['email:One', 'OTHER_VARIANTS_SKIPPED']]);
  assert.equal(org.rows.find((row) => row.language === 'de').published, false);
});

test('unpublish sends variantIds without includeContentReferences', async () => {
  const directory = await projectWith([]);
  const org = fakeOrg([email('One', 1, { published: true })]);
  const { result, writes } = await run('unpublish', ['-m', 'email:One'], org, directory);
  assert.deepEqual(outcomes(result), [['One', 'unpublished']]);
  assert.deepEqual(JSON.parse(writes[0].input.body), {
    variantIds: ['9Ps000000000001AAA'],
    contextContentSpaceId: workspace.id,
  });
  assert.equal(result.result.items[0].isPublished, false);
  assert.deepEqual(result.diagnostics.warnings, []);
});

test('publish shows Salesforce refusal, stops, and never repeats a request without an answer', async () => {
  const directory = await projectWith([]);
  const refused = fakeOrg([email('A', 1), email('B', 2)], {
    onPublish: () => {
      throw salesforceError(400, 'INVALID_API_INPUT', 'Your content was not published.');
    },
  });
  const first = await run('publish', ['-m', 'email:A', '-m', 'email:B'], refused, directory);
  assert.equal(first.exitCode, 1);
  assert.deepEqual(outcomes(first.result), [
    ['A', 'failed'],
    ['B', 'not-attempted'],
  ]);
  assert.equal(first.writes.length, 1);
  const [error] = first.result.diagnostics.errors;
  assert.deepEqual(
    [error.component, error.code, error.status, error.salesforceErrorCode],
    ['email:A', 'REQUEST_FAILED', 400, 'INVALID_API_INPUT'],
  );

  const silent = fakeOrg([email('A', 1)], {
    onPublish: () => {
      throw new Error('socket hang up');
    },
  });
  const second = await run('unpublish', ['-m', 'email:A'], silent, directory);
  assert.deepEqual(outcomes(second.result), [['A', 'unknown']]);
  assert.equal(second.writes.length, 1);
  assert.deepEqual(codes(second.result.diagnostics.errors), [['email:A', 'UNKNOWN_OUTCOME']]);
});

test('publish of a component the workspace does not have is blocked and sends nothing', async () => {
  const directory = await projectWith([]);
  const { result, writes } = await run(
    'publish',
    ['-m', 'email:Absent', '--preview'],
    fakeOrg([]),
    directory,
  );
  assert.deepEqual(outcomes(result), [['Absent', 'blocked']]);
  assert.deepEqual(codes(result.diagnostics.errors), [['email:Absent', 'COMPONENT_NOT_FOUND']]);
  assert.equal(writes.length, 0);
});
