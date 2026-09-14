import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const expectedFiles = ['lib', 'messages', 'LICENSE', 'README.md'];

if (packageJson.type !== 'module') throw new Error('package must use ESM');
if (packageJson.engines?.node !== '>=20 <25') throw new Error('unexpected Node engine');
if (JSON.stringify(packageJson.files) !== JSON.stringify(expectedFiles)) {
  throw new Error('unexpected package files allowlist');
}
if (packageJson.oclif?.commands !== './lib/commands') throw new Error('missing oclif commands root');

const shippedRuntimeFiles = await listFiles(path.join(packageRoot, 'lib'));
for (const file of shippedRuntimeFiles) {
  const source = await readFile(file, 'utf8');
  if (source.includes('SF_PLUGIN_CMS_TEST_MODE') || source.includes('SF_PLUGIN_CMS_TEST_FIXTURE')) {
    throw new Error(`shipped runtime contains fixture environment bypass: ${file}`);
  }
}

console.log('package metadata valid');

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
