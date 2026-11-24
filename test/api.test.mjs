import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import * as publicApi from 'sf-plugin-cms/api';
import { createApi } from '../lib/api/impl.js';
import { fakeConnection } from './support/fake-connection.mjs';
import { fakeOrg, workspace } from './support/fake-org.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const golden = path.join(here, 'fixtures', 'golden', 'cms', 'Default_Content_Workspace', 'email');
const WS = workspace.apiName;
const EMAIL = 'Golden_Email_Code';

/**
 * A project directory with `cms/Source_WS/email/Golden_Email_Code.*` (JSON, HTML and text).
 * @returns {Promise<string>} Project directory.
 */
async function project() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'cms-api-'));
  const target = path.join(directory, 'cms', 'Source_WS', 'email');
  await mkdir(target, { recursive: true });
  for (const suffix of ['json', 'html', 'txt'])
    await copyFile(
      path.join(golden, `${EMAIL}.email.${suffix}`),
      path.join(target, `${EMAIL}.email.${suffix}`),
    );
  return directory;
}

/**
 * A fake org connection as a library caller passes it.
 * @param {Function} answer Fake org answer function.
 * @returns {object} Connection double with version and org ID.
 */
function connectionOf(answer) {
  return Object.assign(fakeConnection(answer), {
    version: '68.0',
    getAuthInfoFields: () => ({ orgId: '00D000000000001AAA' }),
  });
}

const writes = (connection) =>
  connection.calls.filter(({ input }) => input.method !== 'GET').map(({ input }) => input.url);

test('api: the package entry exports the functions and helpers', () => {
  for (const name of [
    'deploy',
    'publish',
    'unpublish',
    'remove',
    'retrieve',
    'getItems',
    'flowContentReference',
    'parseFlowContentReference',
    'exitCodeOf',
  ])
    assert.equal(typeof publicApi[name], 'function', name);
});

test('api: flow content reference round trip', () => {
  const reference = publicApi.flowContentReference(WS, 'email', 'Spring_Sale');
  assert.equal(reference, 'marketing--Default_Content_Workspace.sfdc_cms__email--Spring_Sale');
  assert.deepEqual(publicApi.parseFlowContentReference(reference), {
    workspaceApiName: WS,
    type: 'email',
    contentType: 'sfdc_cms__email',
    apiName: 'Spring_Sale',
  });
  assert.deepEqual(
    publicApi.parseFlowContentReference('marketing--otherMarketing.sfdc_cms__webFragment--Hero'),
    {
      workspaceApiName: 'otherMarketing',
      type: 'web-fragment',
      contentType: 'sfdc_cms__webFragment',
      apiName: 'Hero',
    },
  );
});

test('api: flow content reference refuses unknown types and malformed input', () => {
  assert.throws(() => publicApi.flowContentReference(WS, 'nope', 'X'), { code: 'UNKNOWN_TYPE' });
  assert.throws(() => publicApi.flowContentReference(WS, 'email', 'a.b'), {
    code: 'INVALID_SELECTOR',
  });
  assert.throws(() => publicApi.parseFlowContentReference('Default_Content_Workspace.email--X'), {
    code: 'INVALID_SELECTOR',
  });
  assert.throws(
    () => publicApi.parseFlowContentReference('marketing--WS.sfdc_cms__unknownThing--X'),
    { code: 'UNKNOWN_TYPE' },
  );
});

test('api: deploy preview resolves a relative companion path against projectDirectory', async () => {
  const directory = await project();
  const connection = connectionOf(fakeOrg().answer);
  const result = await publicApi.deploy(connection, {
    workspace: WS,
    sourceDirs: [path.join('cms', 'Source_WS', 'email', `${EMAIL}.email.html`)],
    projectDirectory: directory,
    preview: true,
  });
  assert.equal(result.status, 'success', JSON.stringify(result.diagnostics));
  assert.deepEqual(result.metadata.orgId, '00D000000000001AAA');
  assert.equal(result.metadata.apiVersion, '68.0');
  assert.equal(result.metadata.command, 'sf cms deploy');
  assert.deepEqual(
    result.result.items.map((item) => [item.type, item.apiName, item.outcome]),
    [['email', EMAIL, 'create']],
  );
  assert.deepEqual(writes(connection), []);
});

test('api: deploy, getItems, publish and remove over one connection', async () => {
  const directory = await project();
  const exitCode = process.exitCode;
  const api = createApi({ allowCallerConnection: true });
  const connection = connectionOf(fakeOrg().answer);
  const reference = [{ type: 'email', apiName: EMAIL }];

  const before = await api.getItems(connection, { workspace: WS, refs: reference });
  assert.equal(before.status, 'success', JSON.stringify(before.diagnostics));
  assert.deepEqual(before.result.items, [{ type: 'email', apiName: EMAIL, exists: false }]);

  const deployed = await api.deploy(connection, {
    workspace: WS,
    metadata: [`email:${EMAIL}`],
    projectDirectory: directory,
  });
  assert.equal(deployed.status, 'success', JSON.stringify(deployed.diagnostics));
  const [created] = deployed.result.items;
  assert.equal(created.outcome, 'created');

  const draft = await api.getItems(connection, { workspace: WS, refs: reference });
  assert.deepEqual(draft.result.items, [
    {
      type: 'email',
      apiName: EMAIL,
      exists: true,
      contentKey: created.contentKey,
      managedContentId: created.managedContentId,
      variantId: created.variantId,
      isPublished: false,
      status: 'Draft',
    },
  ]);

  const published = await api.publish(connection, {
    workspace: WS,
    metadata: [`email:${EMAIL}`],
    projectDirectory: directory,
  });
  assert.equal(published.status, 'success', JSON.stringify(published.diagnostics));
  assert.equal(published.result.items[0].outcome, 'published');
  assert.equal(published.result.items[0].isPublished, true);
  const live = await api.getItems(connection, { workspace: WS, refs: reference });
  assert.equal(live.result.items[0].isPublished, true);
  assert.equal(live.result.items[0].status, 'Published');

  await api.unpublish(connection, {
    workspace: WS,
    metadata: [`email:${EMAIL}`],
    projectDirectory: directory,
  });
  // Git already removed the files: remove by selector and keep (absent) local files.
  for (const suffix of ['json', 'html', 'txt'])
    await unlink(path.join(directory, 'cms', 'Source_WS', 'email', `${EMAIL}.email.${suffix}`));
  const removed = await api.remove(connection, {
    workspace: WS,
    metadata: [`email:${EMAIL}`],
    projectDirectory: directory,
    keepLocalFiles: true,
  });
  assert.equal(removed.status, 'success', JSON.stringify(removed.diagnostics));
  assert.equal(removed.result.items[0].outcome, 'deleted');
  const after = await api.getItems(connection, { workspace: WS, refs: reference });
  assert.equal(after.result.items[0].exists, false);
  assert.equal(process.exitCode, exitCode);
});

test('api: failures come back in the envelope, without exit code or throw', async () => {
  const exitCode = process.exitCode;
  const connection = connectionOf(fakeOrg().answer);
  const missing = await publicApi.getItems(connection, {
    workspace: 'No_Such_Workspace',
    refs: [{ type: 'email', apiName: 'X' }],
  });
  assert.equal(missing.status, 'failed');
  assert.equal(missing.diagnostics.errors[0].code, 'WORKSPACE_NOT_FOUND');

  const badType = await publicApi.getItems(connection, {
    workspace: WS,
    refs: [{ type: 'nope', apiName: 'X' }],
  });
  assert.equal(badType.diagnostics.errors[0].code, 'UNKNOWN_TYPE');

  const noVersion = await publicApi.publish(
    Object.assign(fakeConnection(fakeOrg().answer), { version: undefined }),
    { workspace: WS, metadata: ['email:X'], projectDirectory: os.tmpdir() },
  );
  assert.equal(noVersion.status, 'failed');
  assert.equal(noVersion.diagnostics.errors[0].code, 'INVALID_API_VERSION');
  assert.equal(process.exitCode, exitCode);
});

test('api: missing options or connection give a failed envelope, not a throw', async () => {
  const connection = connectionOf(fakeOrg().answer);
  for (const call of [
    () => publicApi.deploy(connection),
    () => publicApi.publish(connection),
    () => publicApi.remove(connection),
    () => publicApi.retrieve(connection),
    () => publicApi.getItems(connection),
    () => publicApi.getItems(undefined, { workspace: WS, refs: [] }),
  ]) {
    const result = await call();
    assert.equal(result.status, 'failed');
    assert.ok(result.diagnostics.errors.length > 0);
  }
});

test('api: getItems finds a component whatever the case of the asked API name', async () => {
  const org = fakeOrg({
    variants: [
      {
        apiName: 'Spring_Sale',
        title: 'Spring',
        contentKey: 'MC00000000000000000000000001',
        contentType: { fullyQualifiedName: 'sfdc_cms__email' },
        managedContentId: '20Y000000000001AAA',
        managedContentVariantId: '9Ps000000000001AAA',
        isPublished: true,
      },
    ],
  });
  const result = await publicApi.getItems(connectionOf(org.answer), {
    workspace: WS,
    refs: [{ type: 'email', apiName: 'spring_sale' }],
  });
  assert.equal(result.result.items[0].exists, true);
  assert.equal(result.result.items[0].apiName, 'Spring_Sale');
  assert.equal(result.result.items[0].status, 'Published');
});
