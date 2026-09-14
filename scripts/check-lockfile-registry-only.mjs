import { readFile } from 'node:fs/promises';

const raw = await readFile(new URL('../package-lock.json', import.meta.url), 'utf8');
const lockfile = JSON.parse(raw);
const problems = [];

for (const [packagePath, metadata] of Object.entries(lockfile.packages ?? {})) {
  if (metadata.link === true) problems.push(`${packagePath}: link=true`);
  if (metadata.resolved && !/^(?:https:|git\+https:|git\+ssh:)/u.test(metadata.resolved)) {
    problems.push(`${packagePath}: resolved=${metadata.resolved}`);
  }
}
if (/"(?:file|link|workspace):/u.test(raw)) problems.push('local dependency protocol found');
if (problems.length > 0) throw new Error(`lockfile is not registry-only:\n${problems.join('\n')}`);

console.log('registry-only lockfile valid');
