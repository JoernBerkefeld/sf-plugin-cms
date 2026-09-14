import { execFile as execFileCallback } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { validateRuntimeDependencyTree } from './runtime-dependency-validation.mjs';

const execFile = promisify(execFileCallback);
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error('npm executable path is unavailable');
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const expectedFiles = ['lib', 'messages', 'LICENSE', 'README.md'];
const expectedRuntimeDependencies = {
  '@jsforce/jsforce-node': '3.10.16',
  '@salesforce/core': '8.31.3',
  '@salesforce/sf-plugins-core': '12.2.0',
};

if (packageJson.type !== 'module') throw new Error('package must use ESM');
if (packageJson.engines?.node !== '>=20 <25') throw new Error('unexpected Node engine');
for (const [name, version] of Object.entries(expectedRuntimeDependencies)) {
  if (packageJson.dependencies?.[name] !== version) {
    throw new Error(`unexpected ${name} runtime dependency`);
  }
}
if (packageJson.overrides !== undefined) {
  throw new Error('published package must not depend on repository-root overrides');
}
if (JSON.stringify(packageJson.files) !== JSON.stringify(expectedFiles)) {
  throw new Error('unexpected package files allowlist');
}
if (packageJson.oclif?.commands !== './lib/commands')
  throw new Error('missing oclif commands root');

const shippedRuntimeFiles = await listFiles(path.join(packageRoot, 'lib'));
for (const file of shippedRuntimeFiles) {
  const source = await readFile(file, 'utf8');
  if (source.includes('SF_PLUGIN_CMS_TEST_MODE') || source.includes('SF_PLUGIN_CMS_TEST_FIXTURE')) {
    throw new Error(`shipped runtime contains fixture environment bypass: ${file}`);
  }
}

await validatePackedConsumer();
console.log('package metadata and packed consumer valid');

async function validatePackedConsumer() {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'sf-plugin-cms-consumer-'));
  const packDirectory = path.join(temporaryRoot, 'pack');
  const consumerDirectory = path.join(temporaryRoot, 'consumer');

  try {
    await mkdir(packDirectory);
    await execFile(process.execPath, [npmCli, 'run', 'build'], { cwd: packageRoot });
    await execFile(
      process.execPath,
      [npmCli, 'pack', '--json', '--pack-destination', packDirectory],
      { cwd: packageRoot },
    );

    const packedFiles = await readdir(packDirectory);
    const tarballs = packedFiles.filter((file) => file.endsWith('.tgz'));
    if (tarballs.length !== 1) throw new Error('expected exactly one packed package tarball');

    await mkdir(consumerDirectory);
    await writeFile(
      path.join(consumerDirectory, 'package.json'),
      `${JSON.stringify({ name: 'sf-plugin-cms-consumer', private: true, version: '1.0.0' }, null, 2)}\n`,
    );

    const tarballPath = path.join(packDirectory, tarballs[0]);
    await execFile(
      process.execPath,
      [npmCli, 'install', '--ignore-scripts', '--no-audit', '--no-fund', tarballPath],
      { cwd: consumerDirectory },
    );
    const tree = await readNpmRuntimeTree(consumerDirectory);
    const result = await validateRuntimeDependencyTree(tree);
    console.log(
      `validated ${result.nodeCount} installed runtime dependency nodes (${result.uniquePackageVersions} unique package versions)`,
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

async function readNpmRuntimeTree(consumerDirectory) {
  try {
    const { stdout } = await execFile(
      process.execPath,
      [npmCli, 'ls', '--omit=dev', '--all', '--json', '--long'],
      { cwd: consumerDirectory, maxBuffer: 50 * 1024 * 1024 },
    );
    return JSON.parse(stdout);
  } catch (error) {
    const stdout =
      error && typeof error === 'object' && 'stdout' in error ? error.stdout : undefined;
    if (typeof stdout !== 'string' || stdout.trim() === '') throw error;
    return JSON.parse(stdout);
  }
}

async function listFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await listFiles(entryPath)));
    else if (entry.isFile()) files.push(entryPath);
  }
  return files;
}
