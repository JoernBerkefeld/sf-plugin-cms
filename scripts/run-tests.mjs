import './check-temporary.mjs';
import { execFileSync, spawnSync } from 'node:child_process';

// Git's githooks guidance requires clearing repository-local state for foreign repos.
// Isolate only the test child: the commit hook must retain its own temporary index.
const localNames = new Set(
  execFileSync('git', ['rev-parse', '--local-env-vars'], { encoding: 'utf8', windowsHide: true })
    .trim()
    .split(/\s+/u)
    .map((name) => name.toUpperCase()),
);
const environment = Object.fromEntries(
  Object.entries(process.env).filter(([name]) => !localNames.has(name.toUpperCase())),
);

const result = spawnSync(
  process.execPath,
  ['--test', ...(process.argv.slice(2).length > 0 ? process.argv.slice(2) : ['test/*.test.mjs'])],
  { env: environment, stdio: 'inherit', windowsHide: true },
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
