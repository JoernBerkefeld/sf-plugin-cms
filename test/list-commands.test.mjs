import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Config } from '@oclif/core';
import ListWorkspace from '../lib/commands/cms/list/workspace.js';
import ListChannel from '../lib/commands/cms/list/channel.js';
import { fakeConnection } from './support/fake-connection.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workspaces = [
  {
    apiName: 'Cloud_Kicks',
    id: '0Zuaj000008fDntCAE',
    isEnhancedSpace: true,
    name: 'Cloud Kicks',
    defaultLanguage: 'en_US',
    rootFolderId: '9Puaj000008y3jBCAQ',
    spaceType: { apiName: 'marketing' },
  },
  {
    apiName: null,
    id: '0Zuaj000007BKPjCAO',
    isEnhancedSpace: false,
    name: 'Product Listing Content',
    spaceType: { apiName: 'content' },
  },
];

let config;
let cwd;
before(async () => {
  config = await Config.load(root);
  cwd = process.cwd();
  // The invocation log goes to <cwd>/logs/cms: keep it out of the repository.
  process.chdir(await mkdtemp(path.join(os.tmpdir(), 'sf-plugin-cms-v1-commands-')));
});
after(() => process.chdir(cwd));

/**
 * Run a command against a fake org connection.
 * @param {typeof ListWorkspace} Command Command class.
 * @param {string[]} argv Arguments.
 * @param {(input: { url: string }) => unknown} answer Fake answers.
 * @returns {Promise<{ result: any; calls: any[]; exitCode: unknown }>} Outcome.
 */
async function run(Command, argv, answer) {
  const connection = fakeConnection(answer);
  const requested = [];
  class Fake extends Command {
    resolveOrg = async (targetOrg, apiVersion) => {
      requested.push({ targetOrg, apiVersion });
      return { connection, orgId: '00Daj000010xkZNEAY', username: 'user@example.com' };
    };
  }
  process.exitCode = undefined;
  const result = await Fake.run(argv, config);
  const exitCode = process.exitCode;
  process.exitCode = undefined;
  return { result, calls: connection.calls, requested, exitCode };
}

test('list workspace reads all pages and reports each workspace', async () => {
  const { result, calls, requested, exitCode } = await run(
    ListWorkspace,
    ['-o', 'my-org', '--json'],
    (input) => (input.url.includes('page=0') ? { spaces: workspaces } : { spaces: [] }),
  );
  assert.equal(exitCode, undefined);
  assert.deepEqual(requested, [{ targetOrg: 'my-org', apiVersion: '68.0' }]);
  assert.deepEqual(
    calls.map((call) => call.input.url),
    ['/connect/cms/spaces?page=0', '/connect/cms/spaces?page=1'],
  );
  assert.equal(result.status, 'success');
  assert.equal(result.metadata.orgId, '00Daj000010xkZNEAY');
  assert.deepEqual(result.result.workspaces[0], {
    id: '0Zuaj000008fDntCAE',
    apiName: 'Cloud_Kicks',
    name: 'Cloud Kicks',
    type: 'marketing',
    enhanced: true,
    defaultLanguage: 'en_US',
    rootFolderId: '9Puaj000008y3jBCAQ',
  });
  assert.equal(result.result.workspaces[1].apiName, null);
});

test('list channel resolves the workspace by API name and stops at nextPageUrl null', async () => {
  const { result, calls } = await run(
    ListChannel,
    ['--workspace', 'Cloud_Kicks', '--json'],
    (input) =>
      input.url.startsWith('/connect/cms/spaces?')
        ? { spaces: input.url.includes('page=0') ? workspaces : [] }
        : {
            nextPageUrl: null,
            spaceChannels: [
              {
                channelSummary: { id: '0ap1', name: 'Marketing Messages', type: 'UserPermission' },
              },
            ],
          },
  );
  assert.equal(result.status, 'success');
  assert.deepEqual(result.result, {
    workspace: { id: '0Zuaj000008fDntCAE', apiName: 'Cloud_Kicks' },
    channels: [{ id: '0ap1', name: 'Marketing Messages', type: 'UserPermission' }],
  });
  assert.equal(calls.at(-1).input.url, '/connect/cms/spaces/0Zuaj000008fDntCAE/channels?page=0');
});

test('an unknown workspace and a Salesforce error become diagnostics with exit code 1', async () => {
  const missing = await run(ListChannel, ['--workspace', 'Nope', '--json'], () => ({ spaces: [] }));
  assert.equal(missing.exitCode, 1);
  assert.equal(missing.result.status, 'failed');
  assert.equal(missing.result.diagnostics.errors[0].code, 'WORKSPACE_NOT_FOUND');
  assert.equal(missing.calls.length, 1);

  const denied = await run(ListWorkspace, ['--json'], () => {
    throw Object.assign(new Error('Insufficient access'), {
      statusCode: 403,
      data: [{ errorCode: 'INSUFFICIENT_ACCESS', message: 'Insufficient access' }],
    });
  });
  assert.equal(denied.exitCode, 1);
  assert.deepEqual(
    { ...denied.result.diagnostics.errors[0], hint: undefined },
    {
      code: 'REQUEST_FAILED',
      message: 'workspace.list: HTTP 403: INSUFFICIENT_ACCESS: Insufficient access',
      status: 403,
      salesforceErrorCode: 'INSUFFICIENT_ACCESS',
      hint: undefined,
    },
  );
});

test('a non-numeric --api-version is refused before the org is opened', async () => {
  const { result, requested, exitCode } = await run(
    ListWorkspace,
    ['--api-version', 'latest', '--json'],
    () => ({}),
  );
  assert.equal(exitCode, 1);
  assert.equal(result.diagnostics.errors[0].code, 'INVALID_API_VERSION');
  assert.deepEqual(requested, []);
});
