import { readFileSync } from 'node:fs';

// Both src/ and the installed lib/ sit directly beneath this plugin's package root.
const packageJson = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { name: string; version: string };

/** Plugin identity reported in command results: name and version only. */
export const plugin = { name: packageJson.name, version: packageJson.version };
