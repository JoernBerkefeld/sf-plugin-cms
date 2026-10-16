import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
const { dirname, isAbsolute, join, relative, resolve, sep } = path;
import { promisify } from 'node:util';

const execute = promisify(execFile);
const markerName = '.sf-cms-run-owner';
export type RunOwnedTemp = Readonly<{ root: string }>;
const owners = new WeakMap<RunOwnedTemp, { marker: string; registered: Set<string> }>();

export async function createRunOwnedTemp(prefix: string): Promise<RunOwnedTemp> {
  if (!/^(?:cms|sf-plugin-cms)-[A-Za-z0-9-]+$/u.test(prefix))
    throw new Error('Invalid temporary prefix');
  const root = await realpath(await mkdtemp(join(await realpath(tmpdir()), `${prefix}-`)));
  const marker = randomUUID();
  await writeFile(join(root, markerName), marker, { flag: 'wx' });
  const run = Object.freeze({ root });
  owners.set(run, { marker, registered: new Set<string>() });
  return run;
}

// Creation, not a public registration API, establishes ownership of a cleanup target.
export async function createRunOwnedDirectory(run: RunOwnedTemp, name: string): Promise<string> {
  if (!/^[A-Za-z0-9_-]+$/u.test(name)) throw new Error('Invalid run-owned directory name');
  const owner = await validateRoot(run);
  const target = join(run.root, name);
  await mkdir(target);
  owner.registered.add(target);
  return target;
}

export async function removeRunOwnedPath(run: RunOwnedTemp, target: string): Promise<void> {
  const owner = await validateRoot(run);
  if (!target || /[*?[\]{}]/u.test(target) || target.split(/[\\/]/u).includes('..')) {
    throw new Error('Invalid cleanup target');
  }
  const absolute = resolve(target);
  if (!isAbsolute(target) || !isDescendant(run.root, absolute)) {
    throw new Error('Cleanup target must be a strict run-root descendant');
  }
  if (!owner.registered.has(absolute)) throw new Error('Cleanup target is not registered');
  await rejectLinks(run.root, absolute);
  if ((await realpath(absolute)) !== absolute) throw new Error('Cleanup target changed location');
  await rm(absolute, { recursive: true, force: false });
  owner.registered.delete(absolute);
}

// Only the verified project's literal direct dependency directory gets the link exception.
export async function removeRunOwnedNodeModules(
  run: RunOwnedTemp,
  projectRoot: string,
  expectedPackageName: string,
): Promise<void> {
  const owner = await validateRoot(run);
  if (
    !projectRoot ||
    !isAbsolute(projectRoot) ||
    /[*?[\]{}]/u.test(projectRoot) ||
    projectRoot.split(/[\\/]/u).includes('..') ||
    !isDescendant(run.root, resolve(projectRoot)) ||
    !expectedPackageName
  ) {
    throw new Error('Invalid dependency project root');
  }
  const project = resolve(projectRoot);
  if (
    ![...owner.registered].some((target) => target === project || isDescendant(target, project))
  ) {
    throw new Error('Dependency project is not in a registered run-owned directory');
  }
  await rejectLinks(run.root, project, false);
  const projectMetadata = await lstat(project);
  if ((await realpath(project)) !== project || !projectMetadata.isDirectory()) {
    throw new Error('Dependency project changed location');
  }
  const manifest = join(project, 'package.json');
  const manifestMetadata = await lstat(manifest);
  if (!manifestMetadata.isFile() || manifestMetadata.isSymbolicLink()) {
    throw new Error('Invalid dependency project manifest');
  }
  const identity = JSON.parse(await readFile(manifest, 'utf8')) as { name?: unknown };
  if (identity.name !== expectedPackageName)
    throw new Error('Dependency project identity mismatch');
  const target = join(project, 'node_modules');
  try {
    await lstat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  await rejectLinks(run.root, target, process.platform === 'win32');
  const targetMetadata = await lstat(target);
  if ((await realpath(target)) !== target || !targetMetadata.isDirectory()) {
    throw new Error('Dependency directory changed location');
  }
  // POSIX unlink removes the link entry itself, including dangling and external links.
  // Windows stays fail-closed for every reparse type, as in ordinary cleanup.
  if (process.platform !== 'win32') await unlinkDependencyLinks(target);
  await rejectLinks(run.root, target);
  await rm(target, { recursive: true, force: false });
}

async function unlinkDependencyLinks(target: string): Promise<void> {
  const metadata = await lstat(target);
  if (metadata.isSymbolicLink()) {
    await unlink(target);
    return;
  }
  if (!metadata.isDirectory()) return;
  const entries = await readdir(target);
  await Promise.all(entries.map((entry) => unlinkDependencyLinks(join(target, entry))));
}

function isDescendant(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

async function validateRoot(
  run: RunOwnedTemp,
): Promise<{ marker: string; registered: Set<string> }> {
  const owner = owners.get(run);
  if (!owner) throw new Error('Unknown run ownership');
  if (
    !isDescendant(await realpath(tmpdir()), run.root) ||
    (await realpath(run.root)) !== run.root
  ) {
    throw new Error('Run root is not an owned OS-temp directory');
  }
  const metadata = await lstat(run.root);
  const markerPath = join(run.root, markerName);
  const markerMetadata = await lstat(markerPath);
  if (
    metadata.isSymbolicLink() ||
    !metadata.isDirectory() ||
    !markerMetadata.isFile() ||
    markerMetadata.isSymbolicLink()
  ) {
    throw new Error('Run ownership contains a link or invalid marker');
  }
  if ((await readFile(markerPath, 'utf8')) !== owner.marker)
    throw new Error('Run ownership marker mismatch');
  return owner;
}

async function rejectLinks(root: string, target: string, inspectSubtree = true): Promise<void> {
  // Windows exposes additional reparse types beyond the links reported by Node's lstat.
  if (process.platform === 'win32') {
    await execute(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `
      $ErrorActionPreference = 'Stop'
      $root = $env:SF_CMS_CLEANUP_ROOT
      $target = $env:SF_CMS_CLEANUP_TARGET
      $current = $target
      while ($true) {
        $item = Get-Item -LiteralPath $current -Force
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Cleanup reparse point rejected' }
        if ($current -eq $root) { break }
        $current = [IO.Path]::GetDirectoryName($current)
      }
      if ($env:SF_CMS_CLEANUP_INSPECT_SUBTREE -eq '1') {
      $pending = New-Object 'Collections.Generic.Stack[string]'
      $pending.Push($target)
      while ($pending.Count -gt 0) {
        $item = Get-Item -LiteralPath $pending.Pop() -Force
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Cleanup reparse point rejected' }
        if ($item.PSIsContainer) {
          foreach ($child in Get-ChildItem -LiteralPath $item.FullName -Force) { $pending.Push($child.FullName) }
        }
      }
      }
    `,
      ],
      {
        env: {
          ...process.env,
          SF_CMS_CLEANUP_ROOT: root,
          SF_CMS_CLEANUP_TARGET: target,
          SF_CMS_CLEANUP_INSPECT_SUBTREE: inspectSubtree ? '1' : '0',
        },
        windowsHide: true,
      },
    );
  }
  let current = target;
  while (true) {
    const metadata = await lstat(current);
    if (metadata.isSymbolicLink()) throw new Error('Cleanup ancestor link rejected');
    if (current === root) break;
    current = dirname(current);
  }
  if (inspectSubtree) await inspectTree(target);
}

async function inspectTree(target: string): Promise<void> {
  const metadata = await lstat(target);
  if (metadata.isSymbolicLink()) throw new Error('Cleanup subtree link rejected');
  if (!metadata.isDirectory()) return;
  const entries = await readdir(target);
  await Promise.all(entries.map((entry) => inspectTree(join(target, entry))));
}
