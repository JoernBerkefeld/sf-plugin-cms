import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Config } from '@oclif/core';
import Delete from '../lib/commands/cms/delete.js';
import Deploy from '../lib/commands/cms/deploy.js';
import Publish from '../lib/commands/cms/publish.js';
import Unpublish from '../lib/commands/cms/unpublish.js';
import { emailFragmentHandler } from '../lib/content/handlers/email-fragment.js';
import { resolveReferences } from '../lib/content/json-source.js';
import { HANDLERS, handlerOf } from '../lib/content/registry.js';
import { readSourceFiles, writeSourceFiles } from '../lib/content/source-files.js';
import { checkDataGraphReferences, dataGraphReferences } from '../lib/services/data-graph-check.js';
import { envelopeOf } from '../lib/services/deploy.js';
import { fakeConnection } from './support/fake-connection.mjs';
import { fakeOrg, salesforceError, workspace } from './support/fake-org.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const golden = path.join(here, 'fixtures', 'golden');
const WS = 'Default_Content_Workspace';
const IMAGE_KEY = 'MCGOLDENIAAAAAAAAAAAAAAAAAAA';
const nativeFragment = async () =>
  JSON.parse(
    await readFile(path.join(here, 'fixtures', 'native', 'email-fragment.variant.json'), 'utf8'),
  );
const goldenFragment = () => readSourceFiles(golden, WS, 'email-fragment', 'Golden_Fragment');
const scratch = () => mkdtemp(path.join(os.tmpdir(), 'sf-plugin-cms-v1-fragment-'));

/**
 * Every block ID of a body in document order.
 * @param {unknown} value Body.
 * @returns {string[]} IDs.
 */
function blockIds(value) {
  if (Array.isArray(value)) return value.flatMap((item) => blockIds(item));
  if (value === null || typeof value !== 'object') return [];
  return [
    ...(value.type === 'block' ? [value.id] : []),
    ...Object.values(value).flatMap((child) => blockIds(child)),
  ];
}

let config;
before(async () => {
  config = await Config.load(root);
});

test('email-fragment is registered after media, before the email types', () => {
  assert.equal(handlerOf('email-fragment'), emailFragmentHandler);
  assert.equal(emailFragmentHandler.apiName, 'sfdc_cms__emailFragment');
  assert.equal(emailFragmentHandler.transport, 'json');
  const types = HANDLERS.map((handler) => handler.type);
  assert.ok(types.indexOf('email-fragment') > types.indexOf('audio'));
  assert.equal(types.indexOf('email-template'), types.indexOf('email-fragment') + 1);
});

test('golden: fragment native -> one JSON file with folders, references and block order', async () => {
  const native = await nativeFragment();
  const files = emailFragmentHandler.toSource(native, {
    workspace,
    folderPath: ['Golden_Folder', 'Golden_Subfolder'],
    referenceOf: (key) =>
      key === IMAGE_KEY ? { type: 'image', apiName: 'Golden_Image' } : undefined,
    warn: (warning) => assert.fail(`unexpected warning ${warning.code}`),
  });
  assert.deepEqual(files.companions, {});
  const written = await writeSourceFiles(await scratch(), WS, files);
  assert.equal(
    await readFile(written.path, 'utf8'),
    await readFile(
      path.join(golden, 'cms', WS, 'email-fragment', 'Golden_Fragment.email-fragment.json'),
      'utf8',
    ),
  );
  assert.deepEqual(
    blockIds(files.document.contentBody),
    blockIds(native.contentBody),
    'block IDs in native order',
  );
});

test('golden fromSource: files give back the native body; image and data graph references', async () => {
  const native = await nativeFragment();
  const payload = emailFragmentHandler.fromSource(await goldenFragment(), { workspace });
  assert.deepEqual(payload.folderPath, ['Golden_Folder', 'Golden_Subfolder']);
  assert.deepEqual(envelopeOf(payload, payload.contentBody), {
    apiName: native.apiName,
    title: native.title,
    urlName: native.urlName,
  });
  assert.deepEqual(emailFragmentHandler.references(payload), [
    { type: 'image', apiName: 'Golden_Image' },
  ]);
  assert.deepEqual(dataGraphReferences(payload.contentBody), [
    { dataGraphApiName: 'Marketing', dataspace: 'default' },
  ]);
  const body = resolveReferences(payload.contentBody, () => IMAGE_KEY);
  const withoutUrl = structuredClone(native.contentBody);
  // The derived media URL next to an image reference is not kept in the file.
  delete withoutUrl['sfdc_cms:block'].children[0].children[0].children[0].attributes.imageInfo.url;
  assert.deepEqual(body, withoutUrl);
});

/** The Golden_Image the fragment references, stored in the destination root. */
const destinationImage = {
  apiName: 'Golden_Image',
  title: 'Golden Image',
  contentBody: {},
  contentKey: 'MCDESTINATIONIMAGEAAAAAAAAAA',
  contentType: { fullyQualifiedName: 'sfdc_cms__image' },
  folder: { id: workspace.rootFolderId },
  managedContentId: '20Y000000000090AAA',
  managedContentVariantId: '9Ps000000000090AAA',
};

async function projectWith(components) {
  const directory = await scratch();
  for (const files of components) await writeSourceFiles(directory, WS, files);
  return directory;
}

async function snapshot(directory) {
  const entries = [];
  const walk = async (current) => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory() && entry.name !== 'logs') await walk(full);
      else if (!entry.isDirectory()) entries.push([full, await readFile(full, 'utf8')]);
    }
  };
  await walk(directory);
  return entries.toSorted();
}

async function run(Command, argv, org, directory) {
  const connection = fakeConnection(org.answer);
  class Fake extends Command {
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
    const writes = connection.calls.filter((call) => call.input.method !== 'GET');
    return { result, writes, calls: connection.calls, exitCode: process.exitCode };
  } finally {
    process.exitCode = undefined;
    process.chdir(cwd);
  }
}

const outcomes = (result) => result.result.items.map((item) => [item.apiName, item.outcome]);
const deploy = (argv, org, directory) => run(Deploy, argv, org, directory);
const FRAGMENT = ['-m', 'email-fragment:Golden_Fragment'];

test('fragment deploy: nested folders created (preview lists them), then unchanged, then update', async () => {
  const files = await goldenFragment();
  const directory = await projectWith([files]);
  const org = fakeOrg({
    variants: [destinationImage],
    folders: { [workspace.rootFolderId]: [{ id: '9Pu000000000050AAA', name: 'Golden_Folder' }] },
  });
  const before = await snapshot(directory);
  const preview = await deploy([...FRAGMENT, '--preview'], org, directory);
  assert.deepEqual(outcomes(preview.result), [['Golden_Fragment', 'create']]);
  assert.deepEqual(preview.result.result.items[0].folders, [
    { path: '/Golden_Folder/Golden_Subfolder', outcome: 'create' },
  ]);
  assert.equal(preview.writes.length, 0);
  assert.deepEqual(await snapshot(directory), before);

  const first = await deploy(FRAGMENT, org, directory);
  assert.equal(first.result.status, 'success');
  assert.deepEqual(outcomes(first.result), [['Golden_Fragment', 'created']]);
  assert.deepEqual(
    first.writes.map((call) => call.input.url),
    ['/connect/cms/folders', '/connect/cms/contents'],
  );
  assert.deepEqual(JSON.parse(first.writes[0].input.body), {
    name: 'Golden_Subfolder',
    parentFolderId: '9Pu000000000050AAA',
  });
  const [created] = first.result.result.items[0].folders;
  assert.deepEqual(created, {
    path: '/Golden_Folder/Golden_Subfolder',
    id: created.id,
    outcome: 'created',
  });
  const create = JSON.parse(first.writes[1].input.body);
  assert.equal(create.contentType, 'sfdc_cms__emailFragment');
  assert.equal(create.contentSpaceOrFolderId, created.id);
  const native = await nativeFragment();
  assert.deepEqual(blockIds(create.contentBody), blockIds(native.contentBody));
  const image = create.contentBody['sfdc_cms:block'].children[0].children[0].children[0];
  assert.equal(image.attributes.imageInfo.source.ref.contentKey, destinationImage.contentKey);
  assert.deepEqual(first.result.diagnostics.warnings, []);

  const second = await deploy(FRAGMENT, org, directory);
  assert.deepEqual(outcomes(second.result), [['Golden_Fragment', 'unchanged']]);
  assert.equal(second.writes.length, 0);
  assert.deepEqual(second.result.diagnostics.warnings, []);

  // Edit: reorder the two blocks of the column and change the text.
  const edited = structuredClone(files);
  const column = edited.document.contentBody['sfdc_cms:block'].children[0].children[0];
  column.children.reverse();
  column.children[0].attributes.text = 'Edited paragraph';
  const editedDirectory = await projectWith([edited]);
  const third = await deploy(FRAGMENT, org, editedDirectory);
  assert.deepEqual(outcomes(third.result), [['Golden_Fragment', 'updated']]);
  assert.deepEqual(third.result.result.items[0].changes, ['contentBody.sfdc_cms:block']);
  assert.equal(third.writes.length, 1);
  assert.equal(third.writes[0].input.method, 'PUT');
  assert.deepEqual(
    blockIds(JSON.parse(third.writes[0].input.body).contentBody),
    blockIds(edited.document.contentBody),
  );
  assert.deepEqual(third.result.diagnostics.warnings, []);
});

test('two components in one new folder: the folder is created once', async () => {
  const files = await goldenFragment();
  const twin = { ...files, document: { ...files.document, apiName: 'Golden_Twin' } };
  const directory = await projectWith([files, twin]);
  const org = fakeOrg({ variants: [destinationImage] });
  const { result, writes } = await deploy(['-d', path.join(directory, 'cms')], org, directory);
  assert.equal(result.status, 'success');
  assert.deepEqual(
    writes.map((call) => call.input.url),
    [
      '/connect/cms/folders',
      '/connect/cms/folders',
      '/connect/cms/contents',
      '/connect/cms/contents',
    ],
  );
  assert.equal(result.result.items[0].folders.length, 2);
  assert.equal(result.result.items[1].folders, undefined);
  assert.equal(
    JSON.parse(writes[2].input.body).contentSpaceOrFolderId,
    JSON.parse(writes[3].input.body).contentSpaceOrFolderId,
  );
});

test('a reference to a component the same deploy creates is planned, written first and rewritten', async () => {
  const fragment = await goldenFragment();
  fragment.document.contentBody['lightning:brandSource'] = {
    contentKey: { type: 'brand', apiName: 'Golden_Brand' },
  };
  const brand = await readSourceFiles(golden, WS, 'brand', 'Golden_Brand');
  const directory = await projectWith([fragment, brand]);
  const folders = {
    [workspace.rootFolderId]: [{ id: '9Pu000000000050AAA', name: 'Golden_Folder' }],
    '9Pu000000000050AAA': [{ id: '9Pu000000000051AAA', name: 'Golden_Subfolder' }],
  };
  const preview = await deploy(
    ['-d', path.join(directory, 'cms'), '--preview'],
    fakeOrg({ variants: [destinationImage], folders }),
    directory,
  );
  assert.deepEqual(outcomes(preview.result), [
    ['Golden_Brand', 'create'],
    ['Golden_Fragment', 'planned-dependencies'],
  ]);
  assert.deepEqual(preview.result.result.items[1].dependencies, ['brand:Golden_Brand']);
  const { result, writes } = await deploy(
    ['-d', path.join(directory, 'cms')],
    fakeOrg({ variants: [destinationImage], folders }),
    directory,
  );
  assert.deepEqual(outcomes(result), [
    ['Golden_Brand', 'created'],
    ['Golden_Fragment', 'created'],
  ]);
  const body = JSON.parse(writes[1].input.body).contentBody;
  assert.equal(body['lightning:brandSource'].contentKey, result.result.items[0].contentKey);
});

test('a data graph or data space missing in the destination blocks before any write', async () => {
  const directory = await projectWith([await goldenFragment()]);
  const graphMissing = await deploy(
    FRAGMENT,
    fakeOrg({ variants: [destinationImage], graphs: {} }),
    directory,
  );
  assert.deepEqual(outcomes(graphMissing.result), [['Golden_Fragment', 'blocked']]);
  assert.equal(graphMissing.writes.length, 0);
  assert.equal(graphMissing.exitCode, 1);
  assert.deepEqual(
    graphMissing.result.diagnostics.errors.map((error) => [error.code, error.message]),
    [
      [
        'DATA_GRAPH_NOT_IN_DESTINATION',
        'Data graph Marketing does not exist in data space default of the destination org',
      ],
    ],
  );
  const spaceMissing = await deploy(
    FRAGMENT,
    fakeOrg({ variants: [destinationImage], dataSpaces: ['other', 'more'] }),
    directory,
  );
  assert.equal(spaceMissing.writes.length, 0);
  assert.equal(spaceMissing.result.diagnostics.errors[0].code, 'DATA_SPACE_NOT_IN_DESTINATION');
  assert.match(spaceMissing.result.diagnostics.errors[0].message, /Data space default/u);
});

test('data graph check: paged data spaces, graph in another data space, cached reads', async () => {
  const org = fakeOrg({
    dataSpaces: ['default', 'dataspace2', 'third'],
    graphs: { ds2_Graph: 'dataspace2', Marketing: 'default' },
  });
  const connection = fakeConnection(org.answer);
  const references = [
    { dataGraphApiName: 'ds2_Graph', dataspace: 'dataspace2' },
    { dataGraphApiName: 'Marketing', dataspace: 'third' },
  ];
  assert.deepEqual(await checkDataGraphReferences(connection, references), [
    {
      code: 'DATA_GRAPH_NOT_IN_DESTINATION',
      message: 'Data graph Marketing is in data space default, not third, in the destination org',
    },
  ]);
  assert.deepEqual(await checkDataGraphReferences(connection, references.slice(0, 1)), []);
  const urls = connection.calls.map((call) => call.input.url);
  assert.equal(urls.filter((url) => url.startsWith('/ssot/data-spaces')).length, 3);
  assert.equal(urls.filter((url) => url === '/ssot/data-graphs/ds2_Graph').length, 1);
  const failing = fakeConnection(() => {
    throw salesforceError(500, 'UNKNOWN_EXCEPTION');
  });
  await assert.rejects(checkDataGraphReferences(failing, references), { status: 500 });
  assert.deepEqual(await checkDataGraphReferences(failing, []), []);
});

test('fragment lifecycle: publish, unpublish and delete through the W3 commands', async () => {
  const files = await goldenFragment();
  const directory = await projectWith([files]);
  const org = fakeOrg({ variants: [destinationImage] });
  await deploy(FRAGMENT, org, directory);
  const id = [...org.variants.values()].find(
    (v) => v.apiName === 'Golden_Fragment',
  ).managedContentVariantId;
  const published = await run(Publish, FRAGMENT, org, directory);
  assert.deepEqual(outcomes(published.result), [['Golden_Fragment', 'published']]);
  assert.equal(org.variants.get(id).isPublished, true);
  const unpublished = await run(Unpublish, FRAGMENT, org, directory);
  assert.deepEqual(outcomes(unpublished.result), [['Golden_Fragment', 'unpublished']]);
  assert.equal(org.variants.get(id).isPublished, false);
  const deleted = await run(Delete, FRAGMENT, org, directory);
  assert.deepEqual(outcomes(deleted.result), [['Golden_Fragment', 'deleted']]);
  assert.equal(org.variants.has(id), false);
  assert.deepEqual(await snapshot(directory), []);
});

const GOLDEN_FOLDERS = {
  [workspace.rootFolderId]: [{ id: '9Pu000000000050AAA', name: 'Golden_Folder' }],
  '9Pu000000000050AAA': [{ id: '9Pu000000000051AAA', name: 'Golden_Subfolder' }],
};

/**
 * The golden fragment under another API name, referencing the given fragments.
 * @param {string} apiName API name.
 * @param {string[]} references API names of referenced fragments.
 * @returns {Promise<object>} Source files.
 */
async function fragmentNamed(apiName, references = []) {
  const files = structuredClone(await goldenFragment());
  files.document.apiName = apiName;
  for (const [index, name] of references.entries())
    files.document.contentBody[`test:nested${index}`] = {
      contentKey: { type: 'email-fragment', apiName: name },
    };
  return files;
}

const createdNames = (writes) =>
  writes
    .filter((call) => call.input.url === '/connect/cms/contents')
    .map((call) => JSON.parse(call.input.body).apiName);

test('deploy order follows references: an inner fragment named later is created first', async () => {
  const directory = await projectWith([
    await fragmentNamed('A_Main', ['B_Inner']),
    await fragmentNamed('B_Inner'),
  ]);
  const argv = ['-d', path.join(directory, 'cms')];
  const preview = await deploy(
    [...argv, '--preview'],
    fakeOrg({ variants: [destinationImage], folders: GOLDEN_FOLDERS }),
    directory,
  );
  assert.equal(preview.result.status, 'success');
  assert.deepEqual(outcomes(preview.result), [
    ['B_Inner', 'create'],
    ['A_Main', 'planned-dependencies'],
  ]);
  assert.deepEqual(preview.result.result.items[1].dependencies, ['email-fragment:B_Inner']);
  const { result, writes } = await deploy(
    argv,
    fakeOrg({ variants: [destinationImage], folders: GOLDEN_FOLDERS }),
    directory,
  );
  assert.equal(result.status, 'success');
  assert.deepEqual(outcomes(result), [
    ['B_Inner', 'created'],
    ['A_Main', 'created'],
  ]);
  assert.deepEqual(createdNames(writes), ['B_Inner', 'A_Main']);
  const main = JSON.parse(writes.at(-1).input.body).contentBody;
  assert.equal(main['test:nested0'].contentKey, result.result.items[0].contentKey);
});

test('deploy order follows references against registry order (brand referencing a fragment)', async () => {
  const brand = await readSourceFiles(golden, WS, 'brand', 'Golden_Brand');
  brand.document.contentBody['test:fragment'] = {
    contentKey: { type: 'email-fragment', apiName: 'Golden_Fragment' },
  };
  const directory = await projectWith([brand, await goldenFragment()]);
  const { result, writes } = await deploy(
    ['-d', path.join(directory, 'cms')],
    fakeOrg({ variants: [destinationImage], folders: GOLDEN_FOLDERS }),
    directory,
  );
  assert.equal(result.status, 'success');
  assert.deepEqual(outcomes(result), [
    ['Golden_Fragment', 'created'],
    ['Golden_Brand', 'created'],
  ]);
  assert.deepEqual(createdNames(writes), ['Golden_Fragment', 'Golden_Brand']);
  const body = JSON.parse(writes.at(-1).input.body).contentBody;
  assert.equal(body['test:fragment'].contentKey, result.result.items[0].contentKey);
});

test('a reference cycle is refused before any write, naming the components', async () => {
  const directory = await projectWith([
    await fragmentNamed('A_Main', ['B_Inner']),
    await fragmentNamed('B_Inner', ['A_Main']),
  ]);
  for (const extra of [['--preview'], []]) {
    const { result, writes, exitCode } = await deploy(
      ['-d', path.join(directory, 'cms'), ...extra],
      fakeOrg({ variants: [destinationImage], folders: GOLDEN_FOLDERS }),
      directory,
    );
    assert.equal(result.status, 'failed');
    assert.equal(exitCode, 1);
    assert.equal(writes.length, 0);
    assert.deepEqual(result.result.items, []);
    assert.deepEqual(
      result.diagnostics.errors.map((error) => [error.code, error.message]),
      [
        [
          'DEPENDENCY_CYCLE',
          'Components reference each other in a cycle: email-fragment:A_Main -> email-fragment:B_Inner -> email-fragment:A_Main',
        ],
      ],
    );
  }
});

test('a folder create without an answer leaves the component unknown and writes no content', async () => {
  const files = await goldenFragment();
  const directory = await projectWith([files]);
  const org = fakeOrg({ variants: [destinationImage] });
  const answer = org.answer;
  let folderPosts = 0;
  org.answer = (input) => {
    if (input.url === '/connect/cms/folders' && input.method === 'POST') {
      folderPosts += 1;
      if (folderPosts === 2) throw new Error('socket hang up');
    }
    return answer(input);
  };
  const { result, writes, exitCode } = await deploy(FRAGMENT, org, directory);
  assert.equal(exitCode, 1);
  assert.deepEqual(outcomes(result), [['Golden_Fragment', 'unknown']]);
  assert.equal(result.result.items[0].reason, 'UNKNOWN_OUTCOME');
  assert.deepEqual(
    result.result.items[0].folders.map((folder) => [folder.path, folder.outcome]),
    [['/Golden_Folder', 'created']],
  );
  assert.deepEqual(
    writes.map((call) => call.input.url),
    ['/connect/cms/folders', '/connect/cms/folders'],
  );
  assert.equal(result.diagnostics.errors[0].code, 'UNKNOWN_OUTCOME');
});
