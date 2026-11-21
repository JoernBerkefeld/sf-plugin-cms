import { readFile } from 'node:fs/promises';

const lock = JSON.parse(await readFile(new URL('../package-lock.json', import.meta.url), 'utf8'));
for (const [name, entry] of Object.entries(lock.packages)) {
  if (entry.link || (entry.resolved && !entry.resolved.startsWith('https:'))) {
    throw new Error(`Non-registry package: ${name}`);
  }
  for (const group of ['dependencies', 'devDependencies', 'optionalDependencies']) {
    for (const value of Object.values(entry[group] ?? {})) {
      if (/^(?:file:|link:|workspace:)/u.test(value)) {
        throw new Error(`Local dependency in ${name}: ${value}`);
      }
    }
  }
}
