import assert from 'node:assert/strict';
import { mkdirSync, unlinkSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Config } from '@oclif/core';
import Delete from '../lib/commands/cms/delete.js';
import Publish from '../lib/commands/cms/publish.js';
import Unpublish from '../lib/commands/cms/unpublish.js';
import { parseExactSelection, runLifecycle } from '../lib/services/lifecycle.js';
import { PUBLIC_URL_NOTE } from '../lib/content/handlers/landing-page-template.js';
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
 * primary, published, key?, body? }. Hooks may replace the answer of DELETE, publish and unpublish.
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
            ManagedContentKey: v.key ?? `MC${v.mc}`,
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
        contentBody: row.body ?? {},
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

test('publish waits 120 s for each write by default; --timeout sets the seconds', async () => {
  const directory = await projectWith([]);
  for (const [argv, timeout] of [
    [[], 120_000],
    [['--timeout', '7'], 7000],
  ]) {
    const { result, writes } = await run(
      'publish',
      ['-m', 'email:One', ...argv],
      fakeOrg([email('One', 1)]),
      directory,
    );
    assert.equal(result.status, 'success');
    assert.equal(writes.length, 1);
    assert.equal(writes[0].options.timeout, timeout);
  }
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

test('a workspace folder that is no safe file name is refused in preview and run alike', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sf-plugin-cms-v1-lifecycle-'));
  const folder = path.join(directory, 'cms', 'My Workspace.v2', 'email');
  await mkdir(folder, { recursive: true });
  const file = path.join(folder, 'Foo.email.json');
  await writeFile(file, '{}\n');
  const before = await snapshot(directory);
  const org = fakeOrg([email('Foo', 1)]);
  for (const extra of [['--preview'], []]) {
    const { result, writes, exitCode } = await run(
      'delete',
      ['-d', file, ...extra],
      org,
      directory,
    );
    assert.equal(result.status, 'failed');
    assert.equal(exitCode, 1);
    assert.deepEqual(codes(result.diagnostics.errors), [[undefined, 'INVALID_FILE_NAME']]);
    assert.equal(writes.length, 0);
  }
  assert.equal(org.rows.length, 1);
  assert.deepEqual(await snapshot(directory), before);
});

test('local files that cannot be listed block the delete before any write', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sf-plugin-cms-v1-lifecycle-'));
  await mkdir(path.join(directory, 'cms', WS), { recursive: true });
  // A file where the type folder belongs: listing it fails with ENOTDIR.
  await writeFile(path.join(directory, 'cms', WS, 'email'), 'not a folder\n');
  const org = fakeOrg([email('One', 1)]);
  for (const extra of [['--preview'], []]) {
    const { result, writes } = await run('delete', ['-m', 'email:One', ...extra], org, directory);
    assert.equal(result.status, 'failed');
    assert.deepEqual(outcomes(result), [['One', 'blocked']]);
    assert.equal(writes.length, 0);
  }
  assert.equal(org.rows.length, 1);
});

test('a local removal failure after a confirmed delete keeps it deleted; later items still run', async () => {
  const directory = await projectWith([
    ['email', 'One'],
    ['email', 'Two'],
  ]);
  const twoJson = path.join(directory, 'cms', WS, 'email', 'Two.email.json');
  const org = fakeOrg([email('One', 1), email('Two', 2)]);
  const answer = org.answer;
  org.answer = (input) => {
    // While Two is deleted in the org, its JSON file turns into a folder (unsafe to remove).
    if (input.method === 'DELETE' && input.url.endsWith('9Ps000000000002AAA')) {
      unlinkSync(twoJson);
      mkdirSync(twoJson);
    }
    return answer(input);
  };
  const { result, writes, exitCode } = await run(
    'delete',
    ['-m', 'email:One', '-m', 'email:Two'],
    org,
    directory,
  );
  assert.equal(exitCode, 1);
  assert.deepEqual(outcomes(result), [
    ['Two', 'deleted'],
    ['One', 'deleted'],
  ]);
  assert.equal(writes.length, 2);
  assert.deepEqual(codes(result.diagnostics.errors), [['email:Two', 'LOCAL_FILE_REMOVAL_FAILED']]);
  assert.deepEqual(
    result.result.items[0].removedLocalFiles.map((file) => [
      path.basename(file.path),
      file.outcome,
    ]),
    [
      ['Two.email.html', 'removed'],
      ['Two.email.json', 'failed'],
    ],
  );
  assert.deepEqual(await readdir(path.join(directory, 'cms', WS, 'email')), ['Two.email.json']);
});

test('a throw during the writes keeps the outcomes already reported', async () => {
  const directory = await projectWith([]);
  const org = fakeOrg([email('One', 1), email('Three', 3), email('Two', 2)]);
  const answer = org.answer;
  org.answer = (input) => {
    if (input.method === 'DELETE' && input.url.endsWith('9Ps000000000003AAA')) {
      answer(input);
      throw salesforceError(404, 'VARIANT_NOT_FOUND');
    }
    return answer(input);
  };
  const connection = fakeConnection(org.answer);
  const targets = await parseExactSelection(
    ['email:One', 'email:Two', 'email:Three'],
    [],
    'delete',
  );
  // Recording the DELETE_ANSWER_IGNORED warning of Three throws.
  const warnings = [];
  warnings.push = () => {
    throw new Error('unexpected');
  };
  let reported = [];
  await assert.rejects(
    runLifecycle(
      connection,
      { ...workspace, enhanced: true, type: 'marketing' },
      'delete',
      targets,
      {
        preview: false,
        diagnostics: { warnings, errors: [] },
        keepLocalFiles: true,
        projectDirectory: directory,
        writeOptions: { allowCallerConnection: true },
        onPlanned: (items) => {
          reported = items;
        },
      },
    ),
    /unexpected/u,
  );
  assert.deepEqual(
    reported.map((item) => [item.apiName, item.outcome, item.reason]),
    [
      ['Two', 'deleted', undefined],
      ['Three', 'deleted', undefined],
      ['One', 'not-attempted', 'NOT_ATTEMPTED'],
    ],
  );
});

test('a delete readback that answers neither the variant nor 404 is unknown and stops', async () => {
  const directory = await projectWith([
    ['email', 'One'],
    ['email', 'Two'],
  ]);
  const org = fakeOrg([email('One', 1), email('Two', 2)]);
  const answer = org.answer;
  let deleted = false;
  org.answer = (input) => {
    if (input.method === 'DELETE') deleted = true;
    else if (deleted && input.url.startsWith('/connect/cms/contents/variants/'))
      throw salesforceError(500, 'UNKNOWN_EXCEPTION');
    return answer(input);
  };
  const before = await snapshot(directory);
  const { result, writes, exitCode } = await run(
    'delete',
    ['-m', 'email:One', '-m', 'email:Two'],
    org,
    directory,
  );
  assert.equal(exitCode, 1);
  assert.deepEqual(outcomes(result), [
    ['Two', 'unknown'],
    ['One', 'not-attempted'],
  ]);
  assert.equal(writes.length, 1);
  assert.deepEqual(codes(result.diagnostics.errors), [['email:Two', 'UNKNOWN_OUTCOME']]);
  assert.deepEqual(await snapshot(directory), before);
});

test('a throw during the command run still reports every item through the command', async () => {
  const directory = await projectWith([
    ['email', 'One'],
    ['email', 'Three'],
    ['email', 'Two'],
  ]);
  const org = fakeOrg([email('One', 1), email('Three', 3), email('Two', 2)], {
    onDelete: () => {
      throw salesforceError(404, 'VARIANT_NOT_FOUND');
    },
  });
  // Recording the first DELETE_ANSWER_IGNORED warning throws inside the run.
  const sabotaged = class extends Delete {
    async withOrg(command, flags, empty, body, beforeOrg) {
      return super.withOrg(
        command,
        flags,
        empty,
        (orgContext, envelope) => {
          envelope.diagnostics.warnings.push = () => {
            throw new Error('unexpected');
          };
          return body(orgContext, envelope);
        },
        beforeOrg,
      );
    }
  };
  const saved = commands.delete;
  commands.delete = sabotaged;
  let outcome;
  try {
    outcome = await run(
      'delete',
      ['-m', 'email:One', '-m', 'email:Two', '-m', 'email:Three'],
      org,
      directory,
    );
  } finally {
    commands.delete = saved;
  }
  const { result, writes, exitCode } = outcome;
  assert.equal(exitCode, 1);
  assert.equal(writes.length, 1);
  assert.deepEqual(
    result.result.items.map((item) => [item.apiName, item.outcome, item.reason]),
    [
      ['Two', 'deleted', undefined],
      ['Three', 'not-attempted', 'NOT_ATTEMPTED'],
      ['One', 'not-attempted', 'NOT_ATTEMPTED'],
    ],
  );
  assert.deepEqual(codes(result.diagnostics.errors), [[undefined, 'REQUEST_FAILED']]);
});

test(
  'a read-only local file after a confirmed delete keeps it deleted and reports the removal',
  {
    skip:
      process.platform === 'win32'
        ? 'Node removes read-only files on Windows'
        : process.getuid?.() === 0 && 'root can remove files from a read-only folder',
  },
  async () => {
    const directory = await projectWith([['email', 'One']]);
    // Files in a read-only folder cannot be unlinked.
    const folder = path.join(directory, 'cms', WS, 'email');
    await chmod(folder, 0o555);
    try {
      const { result, writes, exitCode } = await run(
        'delete',
        ['-m', 'email:One'],
        org1(),
        directory,
      );
      assert.equal(exitCode, 1);
      assert.equal(writes.length, 1);
      assert.deepEqual(outcomes(result), [['One', 'deleted']]);
      const removals = result.result.items[0].removedLocalFiles;
      assert.ok(
        removals.some((file) => file.outcome === 'failed' && /^E[A-Z]+$/u.test(file.code)),
        JSON.stringify(removals),
      );
      assert.deepEqual(
        [
          ...new Set(
            codes(result.diagnostics.errors).map(([component, code]) => `${component} ${code}`),
          ),
        ],
        ['email:One LOCAL_FILE_REMOVAL_FAILED'],
      );
    } finally {
      await chmod(folder, 0o755);
    }
  },
);

function org1() {
  return fakeOrg([email('One', 1)]);
}

const web = (type, apiName, n, extra = {}) => ({
  id: `9Ps00000000000${n}AAA`,
  mc: `20Y00000000000${n}AAA`,
  apiName,
  type,
  ...extra,
});
const pageAndFragment = (published) =>
  fakeOrg([
    web('sfdc_cms__webFragment', 'Frag', 1, { published }),
    web('sfdc_cms__landingPage', 'Page', 2, { published }),
  ]);
const pageAndFragmentArguments = ['-m', 'web-fragment:Frag', '-m', 'landing-page:Page'];

test('unpublish handles dependants first: the page before its web fragment; publish the reverse', async () => {
  const directory = await projectWith([]);
  const unpublished = await run(
    'unpublish',
    pageAndFragmentArguments,
    pageAndFragment(true),
    directory,
  );
  assert.deepEqual(outcomes(unpublished.result), [
    ['Page', 'unpublished'],
    ['Frag', 'unpublished'],
  ]);
  assert.deepEqual(
    unpublished.writes.map((write) => JSON.parse(write.input.body).variantIds[0]),
    ['9Ps000000000002AAA', '9Ps000000000001AAA'],
  );
  const published = await run(
    'publish',
    pageAndFragmentArguments,
    pageAndFragment(false),
    directory,
  );
  assert.deepEqual(outcomes(published.result), [
    ['Frag', 'published'],
    ['Page', 'published'],
  ]);
});

test('publish of a landing page notes the public URL, in preview, run and human output', async () => {
  const directory = await projectWith([]);
  const preview = await run(
    'publish',
    [...pageAndFragmentArguments, '--preview'],
    pageAndFragment(false),
    directory,
  );
  assert.equal(preview.writes.length, 0);
  assert.deepEqual(
    preview.result.result.items.map((item) => [item.apiName, item.note]),
    [
      ['Frag', undefined],
      ['Page', PUBLIC_URL_NOTE],
    ],
  );
  const unpublish = await run(
    'unpublish',
    pageAndFragmentArguments,
    pageAndFragment(true),
    directory,
  );
  assert.ok(unpublish.result.result.items.every((item) => item.note === undefined));

  const lines = [];
  class Human extends Publish {
    resolveOrg = async () => ({
      connection: fakeConnection(pageAndFragment(false).answer),
      orgId: '00D000000000001AAA',
      username: 'u@example.com',
    });
    writeOptions = { allowCallerConnection: true };
    log(message) {
      lines.push(message);
    }
  }
  const cwd = process.cwd();
  process.chdir(directory);
  try {
    await Human.run([...pageAndFragmentArguments, '--workspace', WS], config);
  } finally {
    process.exitCode = undefined;
    process.chdir(cwd);
  }
  assert.deepEqual(lines.slice(0, 3), [
    'published web-fragment:Frag',
    'published landing-page:Page',
    `  note: ${PUBLIC_URL_NOTE}`,
  ]);
});

const lifeKey = (n) => `MCLIFE${'A'.repeat(21)}${String.fromCodePoint(65 + n)}`;
/**
 * A component whose default variant references the components numbered `uses`.
 * @param {string} type Content type.
 * @param {string} apiName API name.
 * @param {number} n Number (IDs and content key).
 * @param {number[]} [uses] Numbers of the referenced components.
 * @returns {object} Row.
 */
const linked = (type, apiName, n, uses = []) => ({
  id: `9Ps00000000000${n}AAA`,
  mc: `20Y00000000000${n}AAA`,
  key: lifeKey(n),
  apiName,
  type,
  body: { blocks: uses.map((used) => ({ contentKey: lifeKey(used) })) },
});

/**
 * The order each action handles the components in.
 * @param {object[]} rows Stored variants (see linked).
 * @param {string[]} selectors `-m` values.
 * @returns {Promise<object>} API names per action, in handled order.
 */
async function orderPerAction(rows, selectors) {
  const directory = await projectWith([]);
  const argv = selectors.flatMap((selector) => ['-m', selector]);
  const orders = {};
  for (const action of ['publish', 'unpublish', 'delete']) {
    const org = fakeOrg(rows.map((row) => ({ ...row, published: action === 'unpublish' })));
    const { result, writes } = await run(action, argv, org, directory);
    assert.deepEqual(result.diagnostics.errors, [], action);
    orders[action] = result.result.items.map((item) => item.apiName);
    // The writes went out in that order too.
    assert.deepEqual(
      writes.map((write) =>
        write.input.method === 'DELETE'
          ? /variants\/(\w+)$/u.exec(write.input.url)[1]
          : JSON.parse(write.input.body).variantIds[0],
      ),
      orders[action].map((name) => rows.find((row) => row.apiName === name).id),
      action,
    );
  }
  return orders;
}

test('lifecycle order follows references across types: an email and the tracked link it uses', async () => {
  const emailUsesLink = await orderPerAction(
    [linked('sfdc_cms__email', 'Mail', 1, [2]), linked('sfdc_cms__trackedLink', 'Link', 2)],
    ['email:Mail', 'tracked-link:Link'],
  );
  assert.deepEqual(emailUsesLink, {
    publish: ['Link', 'Mail'],
    unpublish: ['Mail', 'Link'],
    delete: ['Mail', 'Link'],
  });
  // References win over the registry order (tracked-link before email).
  const linkUsesEmail = await orderPerAction(
    [linked('sfdc_cms__email', 'Mail', 1), linked('sfdc_cms__trackedLink', 'Link', 2, [1])],
    ['email:Mail', 'tracked-link:Link'],
  );
  assert.deepEqual(linkUsesEmail, {
    publish: ['Mail', 'Link'],
    unpublish: ['Link', 'Mail'],
    delete: ['Link', 'Mail'],
  });
});

test('lifecycle order follows references within one type: a web fragment in another', async () => {
  const orders = await orderPerAction(
    [
      linked('sfdc_cms__webFragment', 'A_Outer', 1, [2]),
      linked('sfdc_cms__webFragment', 'B_Inner', 2),
      linked('sfdc_cms__webFragment', 'C_Alone', 3),
    ],
    ['web-fragment:A_Outer', 'web-fragment:B_Inner', 'web-fragment:C_Alone'],
  );
  assert.deepEqual(orders, {
    publish: ['B_Inner', 'A_Outer', 'C_Alone'],
    unpublish: ['C_Alone', 'A_Outer', 'B_Inner'],
    delete: ['C_Alone', 'A_Outer', 'B_Inner'],
  });
});

test('a reference cycle between lifecycle targets is refused before any write', async () => {
  const directory = await projectWith([]);
  for (const action of ['publish', 'unpublish', 'delete']) {
    const org = fakeOrg([
      linked('sfdc_cms__webFragment', 'A_Frag', 1, [2]),
      linked('sfdc_cms__webFragment', 'B_Frag', 2, [1]),
    ]);
    const { result, writes, exitCode } = await run(
      action,
      ['-m', 'web-fragment:A_Frag', '-m', 'web-fragment:B_Frag'],
      org,
      directory,
    );
    assert.equal(exitCode, 1, action);
    assert.equal(writes.length, 0, action);
    assert.deepEqual(
      result.diagnostics.errors.map((error) => error.code),
      ['DEPENDENCY_CYCLE'],
      action,
    );
  }
});
