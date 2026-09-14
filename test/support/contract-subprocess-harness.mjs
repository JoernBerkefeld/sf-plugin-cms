import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const contractCase = process.env.SF_PLUGIN_CMS_CONTRACT_CASE;

if (contractCase !== undefined) {
  const testRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const pluginRoot = process.env.SF_PLUGIN_CMS_INSTALLED_ROOT;
  const pluginVersion = process.env.SF_PLUGIN_CMS_INSTALLED_VERSION;
  if (pluginRoot === undefined) throw new Error('Installed plugin root is unavailable');
  if (pluginVersion === undefined) throw new Error('Installed plugin version is unavailable');
  const cases = {
    'export-success': {
      command: 'lib/commands/cms/export/workspace.js',
      fixture: 'contracts/fixtures/partial-export.json',
      transform: exportSuccess,
      validator: 'lib/contracts/workspace-export.js',
      validatorName: 'assertWorkspaceExportSetResult',
    },
    partial: {
      command: 'lib/commands/cms/export/workspace.js',
      fixture: 'contracts/fixtures/partial-export.json',
      validator: 'lib/contracts/workspace-export.js',
      validatorName: 'assertWorkspaceExportSetResult',
    },
    failed: {
      command: 'lib/commands/cms/import/workspace.js',
      fixture: 'contracts/fixtures/failed-import.json',
      validator: 'lib/contracts/workspace-import.js',
      validatorName: 'assertWorkspaceImportResult',
    },
  };
  const selected = cases[contractCase];
  if (selected === undefined) throw new Error(`Unknown contract subprocess case: ${contractCase}`);

  const [{ default: Command }, validators, fixtureBytes] = await Promise.all([
    import(new URL(selected.command, pathToFileURL(`${pluginRoot}${path.sep}`))),
    import(new URL(selected.validator, pathToFileURL(`${pluginRoot}${path.sep}`))),
    readFile(path.resolve(testRoot, selected.fixture), 'utf8'),
  ]);
  const fixture = JSON.parse(fixtureBytes);
  Command.prototype.run = async function () {
    const envelope =
      selected.transform === undefined
        ? structuredClone(fixture)
        : selected.transform(structuredClone(fixture));
    envelope.metadata.plugin.version = pluginVersion;
    envelope.provenance.pluginVersion = pluginVersion;
    if (contractCase === 'export-success') {
      const manifestPath = path.resolve(envelope.result.workspaces[0].artifact.manifestPath);
      const manifestDirectory = path.dirname(manifestPath);
      await mkdir(manifestDirectory, { recursive: true });
      await writeFile(
        manifestPath,
        `${JSON.stringify({ provenance: { pluginVersion } }, null, 2)}\n`,
        'utf8',
      );
    }
    return this.finishEnvelope(envelope, validators[selected.validatorName]);
  };
}

function exportSuccess(envelope) {
  envelope.status = 'success';
  envelope.diagnostics.warnings = [];
  envelope.result.summary = { failedCount: 0, partialCount: 0, succeededCount: 1 };
  envelope.result.workspaces[0].status = 'success';
  envelope.result.workspaces[0].diagnostics = { errors: [], warnings: [] };
  return envelope;
}
