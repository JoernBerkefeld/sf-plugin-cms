import { lstat, mkdir, readFile, rmdir, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
const { dirname, join, parse } = path;
import { expect } from 'chai';
import {
  createRunOwnedDirectory,
  createRunOwnedTemp,
  removeRunOwnedPath,
} from '../../src/filesystem/runOwnedTemp.js';

async function rejected(action: Promise<unknown>): Promise<void> {
  let failure: unknown;
  try {
    await action;
  } catch (error) {
    failure = error;
  }
  expect(failure).to.be.instanceOf(Error);
}

describe('run-owned OS-temp cleanup', () => {
  it('creates separate marked roots and deletes only created registered descendants', async () => {
    const run = await createRunOwnedTemp('cms-cleanup-test');
    const other = await createRunOwnedTemp('cms-cleanup-test');
    expect(run.root).not.to.equal(other.root);
    expect(run.root.toLowerCase()).to.include(tmpdir().toLowerCase());
    const marker = await readFile(join(run.root, '.sf-cms-run-owner'), 'utf8');
    expect(marker).to.match(/^[\da-f-]{36}$/u);
    expect(marker).not.to.equal(await readFile(join(other.root, '.sf-cms-run-owner'), 'utf8'));
    const target = await createRunOwnedDirectory(run, 'fixture');
    await mkdir(join(target, 'nested'));
    await writeFile(join(target, 'nested', 'evidence'), 'owned');
    await removeRunOwnedPath(run, target);
    await rejected(lstat(target));
    const rootMetadata = await lstat(run.root);
    expect(rootMetadata.isDirectory()).to.equal(true);
    await rejected(removeRunOwnedPath(run, target));
  });

  it('rejects unsafe names, roots, ancestors, escapes, wildcards and foreign ownership', async () => {
    const run = await createRunOwnedTemp('cms-cleanup-test');
    const other = await createRunOwnedTemp('cms-cleanup-test');
    const target = await createRunOwnedDirectory(run, 'fixture');
    const foreign = await createRunOwnedDirectory(other, 'fixture');
    for (const name of ['', '.', '..', '../escape', 'nested/path', 'wild*']) {
      await rejected(createRunOwnedDirectory(run, name));
    }
    for (const invalid of [
      '',
      run.root,
      dirname(run.root),
      parse(run.root).root,
      foreign,
      'fixture',
      join(target, '*'),
      `${target}/../fixture`,
    ]) {
      await rejected(removeRunOwnedPath(run, invalid));
    }
    await rejected(removeRunOwnedPath({ root: run.root }, target));
    const unregistered = join(run.root, 'unregistered');
    await mkdir(unregistered);
    await rejected(removeRunOwnedPath(run, unregistered));
    await rmdir(unregistered);
    await removeRunOwnedPath(run, target);
    await removeRunOwnedPath(other, foreign);
  });

  it('rejects a replaced ownership marker without deleting the fixture', async () => {
    const run = await createRunOwnedTemp('cms-cleanup-test');
    const target = await createRunOwnedDirectory(run, 'fixture');
    const marker = join(run.root, '.sf-cms-run-owner');
    const original = await readFile(marker, 'utf8');
    await writeFile(marker, 'wrong-owner');
    await rejected(removeRunOwnedPath(run, target));
    const targetMetadata = await lstat(target);
    expect(targetMetadata.isDirectory()).to.equal(true);
    await writeFile(marker, original);
    await removeRunOwnedPath(run, target);
  });

  it('rejects nested links or Windows junctions before deleting anything', async () => {
    const run = await createRunOwnedTemp('cms-cleanup-test');
    const target = await createRunOwnedDirectory(run, 'fixture');
    const outside = await createRunOwnedDirectory(run, 'outside');
    const evidence = join(outside, 'evidence');
    await writeFile(evidence, 'preserved');
    const link = join(target, 'linked');
    await symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    try {
      await rejected(removeRunOwnedPath(run, target));
      expect(await readFile(evidence, 'utf8')).to.equal('preserved');
      const targetMetadata = await lstat(target);
      expect(targetMetadata.isDirectory()).to.equal(true);
    } finally {
      await unlink(link);
    }
    await removeRunOwnedPath(run, target);
    await removeRunOwnedPath(run, outside);
  });

  it('rejects a registered target replaced with a link', async () => {
    const run = await createRunOwnedTemp('cms-cleanup-test');
    const target = await createRunOwnedDirectory(run, 'fixture');
    const outside = await createRunOwnedDirectory(run, 'outside');
    await rmdir(target);
    await symlink(outside, target, process.platform === 'win32' ? 'junction' : 'dir');
    await rejected(removeRunOwnedPath(run, target));
    await unlink(target);
    await mkdir(target);
    await removeRunOwnedPath(run, target);
    await removeRunOwnedPath(run, outside);
  });
});
