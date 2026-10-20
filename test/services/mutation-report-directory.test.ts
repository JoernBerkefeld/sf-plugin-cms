import { expect } from 'chai';
import { mkdir, mkdtemp, readdir, symlink, writeFile, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  allocateMutationReportDirectory,
  validateMutationReportDirectory,
} from '../../src/services/mutation-report-directory.js';

async function rejects(action: Promise<unknown>): Promise<void> {
  let failed = false;
  try {
    await action;
  } catch {
    failed = true;
  }
  expect(failed).to.equal(true);
}

describe('opt-in mutation report directories', () => {
  it('does no filesystem work without either option', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cms-report-none-'));
    expect(await allocateMutationReportDirectory(false, undefined, root)).to.equal(undefined);
    expect(await readdir(root)).to.deep.equal([]);
  });

  it('allocates unique exclusive default runs concurrently under invocation cwd', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cms-report-default-'));
    const directories = await Promise.all(
      Array.from({ length: 4 }, () => allocateMutationReportDirectory(true, undefined, root)),
    );
    expect(new Set(directories).size).to.equal(4);
    for (const directory of directories) {
      expect(path.dirname(directory!)).to.equal(path.join(root, 'logs', 'cms', 'reports'));
      expect(path.basename(directory!)).to.match(/^\d{4}-.*Z-[\da-f-]{36}$/u);
      expect(await readdir(directory!)).to.deep.equal([]);
    }
  });

  it('custom destination implies reporting and overrides default without clobbering', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cms-report-custom-'));
    for (const enabled of [false, true]) {
      const directory = path.join(root, String(enabled));
      await validateMutationReportDirectory(directory);
      expect(await readdir(root)).not.to.include(String(enabled));
      expect(await allocateMutationReportDirectory(enabled, directory, root)).to.equal(directory);
      await writeFile(path.join(directory, 'sentinel'), 'preserve');
      await rejects(allocateMutationReportDirectory(enabled, directory, root));
      expect(await readFile(path.join(directory, 'sentinel'), 'utf8')).to.equal('preserve');
    }
    expect(await readdir(root)).to.deep.equal(['false', 'true']);
  });

  it('allows only one concurrent allocation of an exact custom directory', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cms-report-race-'));
    const results = await Promise.allSettled(
      Array.from({ length: 3 }, () =>
        allocateMutationReportDirectory(false, path.join(root, 'exact'), root),
      ),
    );
    expect(results.filter((result) => result.status === 'fulfilled')).to.have.length(1);
    expect(results.filter((result) => result.status === 'rejected')).to.have.length(2);
  });

  it('rejects unsafe custom paths, missing parents and linked default ancestors', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cms-report-unsafe-'));
    for (const directory of ['', '../reports', path.join(root, 'missing', 'run')])
      await rejects(allocateMutationReportDirectory(false, directory, root));
    const target = path.join(root, 'target');
    await mkdir(target);
    await symlink(target, path.join(root, 'logs'), 'junction');
    await rejects(allocateMutationReportDirectory(true, undefined, root));
    expect(await readdir(target)).to.deep.equal([]);
  });

  it('propagates non-directory parent failures without allocating a run', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cms-report-parent-'));
    await writeFile(path.join(root, 'logs'), 'preserve');
    await rejects(allocateMutationReportDirectory(true, undefined, root));
    expect(await readFile(path.join(root, 'logs'), 'utf8')).to.equal('preserve');
  });
});
