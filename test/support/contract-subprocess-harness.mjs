import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const contractCase = process.env.SF_PLUGIN_CMS_CONTRACT_CASE;

if (contractCase !== undefined) {
  const testRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const cases = {
    partial: {
      command: '../../lib/commands/cms/export/workspace.js',
      fixture: 'contracts/fixtures/partial-export.json',
      exitCode: 2,
    },
    failed: {
      command: '../../lib/commands/cms/import/workspace.js',
      fixture: 'contracts/fixtures/failed-import.json',
      exitCode: 1,
    },
  };
  const selected = cases[contractCase];
  if (selected === undefined) throw new Error(`Unknown contract subprocess case: ${contractCase}`);

  const [{ default: Command }, fixtureBytes] = await Promise.all([
    import(new URL(selected.command, import.meta.url)),
    readFile(path.resolve(testRoot, selected.fixture), 'utf8'),
  ]);
  const fixture = JSON.parse(fixtureBytes);
  Command.prototype.run = async function () {
    process.exitCode = selected.exitCode;
    return fixture;
  };
}
