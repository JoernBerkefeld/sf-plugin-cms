import { execFile } from 'node:child_process';
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { expect } from 'chai';
import {
  createRunOwnedDirectory,
  createRunOwnedTemp,
  removeRunOwnedPath,
} from '../../src/filesystem/runOwnedTemp.js';

const execute = promisify(execFile);
const packageRoot = fileURLToPath(new URL('../../', import.meta.url));
const harness = path.join(packageRoot, 'test/support/contract-subprocess-harness.mjs');

const syntheticExport = `
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
export async function exportWorkspace(connection, workspace, source, options) {
  await mkdir(source);
  await writeFile(path.join(source, 'manifest.json'), '{}');
  await mkdir(options.editableDirectory);
  await mkdir(path.join(options.editableDirectory, 'items'));
  await writeFile(path.join(options.editableDirectory, 'items/template-en.html'), 'original');
}
`;

describe('contract subprocess fixture safety without installs', () => {
  for (const { existing, worker } of [
    { existing: false, worker: false },
    { existing: true, worker: false },
    { existing: false, worker: true },
  ]) {
    it(`runs the actual harness with ${existing ? 'a preserved existing' : 'a nonexistent'} export destination${worker ? ' and an inherited-preload worker' : ''}`, async () => {
      const run = await createRunOwnedTemp('cms-contract-safety');
      const fixture = await createRunOwnedDirectory(run, 'fixture');
      const plugin = path.join(fixture, 'plugin');
      const source = path.join(fixture, 'email-template-update-preview-source');
      try {
        for (const directory of ['lib/transport', 'lib/services'])
          await mkdir(path.join(plugin, directory), { recursive: true });
        await writeFile(path.join(plugin, 'package.json'), '{"type":"module"}');
        await writeFile(
          path.join(plugin, 'lib/services/email-update.js'),
          `export class EmailUpdateOutcomeUnknownError extends Error {}
export class EmailUpdatePreflightBlockedError extends Error {}
export async function previewDraftEmailUpdateFromEditableHtml() { return { status: 'ready' }; }
export async function applyDraftEmailUpdateWithReport() { throw new Error('Unexpected apply'); }`,
        );
        await writeFile(path.join(plugin, 'lib/transport/json-request.js'), 'export {};');
        await writeFile(path.join(plugin, 'lib/services/export-workspace.js'), syntheticExport);
        if (existing) {
          await mkdir(source);
          await writeFile(path.join(source, 'sentinel'), 'preserved');
        }
        if (worker)
          await writeFile(
            path.join(fixture, 'worker.mjs'),
            `import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { isMainThread } from 'node:worker_threads';
import * as update from './plugin/lib/services/email-update.js';
assert.equal(isMainThread, false);
assert.equal(update.previewDraftEmailUpdateFromEditableHtml.getOrgContext, undefined);
assert.equal(update.getOrgContext, undefined);
assert.equal(await readFile('email-template-update-preview-source/sentinel', 'utf8'), 'worker-preserved');
assert.equal(await readFile('email-template-update-preview-editable/items/template-en.html', 'utf8'), '<p>Installed Template edit</p>');
`,
          );
        const runner = path.join(fixture, 'runner.mjs');
        await writeFile(
          runner,
          `import { stat, writeFile } from 'node:fs/promises';
import { Worker } from 'node:worker_threads';
import * as update from './plugin/lib/services/email-update.js';
for (const input of ['email-template-update-preview-source', 'email-template-update-preview-editable']) {
  if (!(await stat(input)).isDirectory()) throw new Error('Directory input missing before service execution');
}
if (update.getOrgContext !== undefined) throw new Error('Service namespace was mutated');
${
  worker
    ? `await writeFile('email-template-update-preview-source/sentinel', 'worker-preserved');
await new Promise((resolve, reject) => {
  const worker = new Worker(new URL('./worker.mjs', import.meta.url));
  worker.once('error', reject);
  worker.once('exit', (code) => code === 0 ? resolve() : reject(new Error('Worker exit ' + code)));
});`
    : ''
}
`,
        );
        let failure: unknown;
        try {
          await execute(process.execPath, ['--import', pathToFileURL(harness).href, runner], {
            cwd: fixture,
            env: {
              ...process.env,
              NODE_OPTIONS: worker ? `--import=${pathToFileURL(harness).href}` : '',
              SF_PLUGIN_CMS_CONTRACT_CASE: 'email-template-update-preview',
              SF_PLUGIN_CMS_INSTALLED_ROOT: plugin,
              SF_PLUGIN_CMS_INSTALLED_VERSION: '0.9.0',
              SF_DATA_DIR: fixture,
              SF_CONFIG_DIR: fixture,
            },
            windowsHide: true,
          });
        } catch (error) {
          failure = error;
        }
        if (existing) {
          expect(failure).to.be.instanceOf(Error);
          expect(String(failure)).to.include('EEXIST');
          expect(await readFile(path.join(source, 'sentinel'), 'utf8')).to.equal('preserved');
        } else {
          expect(failure, String(failure)).to.equal(undefined);
          expect(await readFile(path.join(source, 'manifest.json'), 'utf8')).to.equal('{}');
          if (worker)
            expect(await readFile(path.join(source, 'sentinel'), 'utf8')).to.equal(
              'worker-preserved',
            );
          expect(
            await readFile(
              path.join(fixture, 'email-template-update-preview-editable/items/template-en.html'),
              'utf8',
            ),
          ).to.equal('<p>Installed Template edit</p>');
        }
      } finally {
        await removeRunOwnedPath(run, fixture);
        await lstat(fixture).then(
          () => expect.fail('registered fixture should have been removed'),
          (error: NodeJS.ErrnoException) => expect(error.code).to.equal('ENOENT'),
        );
        const retainedRoot = await lstat(run.root);
        expect(retainedRoot.isDirectory()).to.equal(true);
      }
    });
  }
});
