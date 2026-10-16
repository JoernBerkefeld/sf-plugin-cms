import {
  lstat,
  mkdir,
  readFile,
  realpath,
  rmdir,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
const { dirname, join, parse } = path;
import { expect } from 'chai';
import {
  createRunOwnedDirectory,
  createRunOwnedTemp,
  removeRunOwnedPath,
  removeRunOwnedNodeModules,
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
  it('rejects unscoped and path-like prefixes before creating a run root', async () => {
    for (const prefix of ['', 'relative', 'sf-cms-test', 'cms-', '../cms-test', 'cms-test/path']) {
      await rejected(createRunOwnedTemp(prefix));
    }
    for (const prefix of ['cms-prefix-test', 'sf-plugin-cms-prefix-test']) {
      const run = await createRunOwnedTemp(prefix);
      expect(dirname(run.root)).to.equal(await realpath(tmpdir()));
      expect(path.basename(run.root)).to.match(new RegExp(`^${prefix}-[A-Za-z0-9]+$`, 'u'));
    }
  });
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

  it('bounds dependency cleanup to a verified direct node_modules child', async () => {
    const run = await createRunOwnedTemp('cms-cleanup-test');
    const project = await createRunOwnedDirectory(run, 'project');
    const modules = join(project, 'node_modules');
    await writeFile(join(project, 'package.json'), JSON.stringify({ name: 'fixture' }));
    await mkdir(modules);
    await writeFile(join(modules, 'evidence'), 'installed');
    await rejected(removeRunOwnedNodeModules(run, project, 'wrong-name'));
    await rejected(removeRunOwnedNodeModules({ root: run.root }, project, 'fixture'));
    await rejected(removeRunOwnedNodeModules(run, run.root, 'fixture'));
    await rejected(removeRunOwnedNodeModules(run, `${project}/../project`, 'fixture'));
    const unregistered = join(run.root, 'unregistered');
    await mkdir(unregistered);
    await writeFile(join(unregistered, 'package.json'), JSON.stringify({ name: 'fixture' }));
    await rejected(removeRunOwnedNodeModules(run, unregistered, 'fixture'));
    await unlink(join(unregistered, 'package.json'));
    await rmdir(unregistered);
    expect(await readFile(join(modules, 'evidence'), 'utf8')).to.equal('installed');
    await removeRunOwnedNodeModules(run, project, 'fixture');
    await rejected(lstat(modules));
    expect(JSON.parse(await readFile(join(project, 'package.json'), 'utf8'))).to.deep.equal({
      name: 'fixture',
    });
    await removeRunOwnedPath(run, project);
  });

  it('never follows dependency links and keeps ordinary cleanup strict', async () => {
    const run = await createRunOwnedTemp('cms-cleanup-test');
    const project = await createRunOwnedDirectory(run, 'project');
    const outside = await createRunOwnedDirectory(run, 'outside');
    await writeFile(join(project, 'package.json'), JSON.stringify({ name: 'fixture' }));
    await writeFile(join(outside, 'sentinel'), 'outside');
    const modules = join(project, 'node_modules');
    await mkdir(modules);
    const link = join(modules, 'external');
    await symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    await rejected(removeRunOwnedPath(run, project));
    if (process.platform === 'win32') {
      await rejected(removeRunOwnedNodeModules(run, project, 'fixture'));
      await unlink(link);
    } else {
      await symlink(join(outside, 'missing'), join(modules, 'dangling'));
    }
    await removeRunOwnedNodeModules(run, project, 'fixture');
    expect(await readFile(join(outside, 'sentinel'), 'utf8')).to.equal('outside');
    await symlink(outside, modules, process.platform === 'win32' ? 'junction' : 'dir');
    await rejected(removeRunOwnedNodeModules(run, project, 'fixture'));
    await unlink(modules);
    await removeRunOwnedPath(run, project);
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
