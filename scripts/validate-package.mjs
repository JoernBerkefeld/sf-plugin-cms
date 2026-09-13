import { readFile } from 'node:fs/promises';

const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const expectedFiles = ['lib', 'messages', 'LICENSE', 'README.md'];

if (packageJson.type !== 'module') throw new Error('package must use ESM');
if (packageJson.engines?.node !== '>=20 <25') throw new Error('unexpected Node engine');
if (JSON.stringify(packageJson.files) !== JSON.stringify(expectedFiles)) {
  throw new Error('unexpected package files allowlist');
}
if (packageJson.oclif?.commands !== './lib/commands') throw new Error('missing oclif commands root');

console.log('package metadata valid');
