import { execFile, spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { expect } from 'chai';

const execFileAsync = promisify(execFile);
const harness = pathToFileURL(
  path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    'support',
    'contract-subprocess-harness.mjs',
  ),
).href;
const sfExecutable = path.resolve('node_modules', '@salesforce', 'cli', 'bin', 'run.js');
const sfPrefix = [sfExecutable];
const executable = process.execPath;
const npmCli = process.env.npm_execpath;
let isolatedDataDirectory: string;
let installedPackageVersion: string;
let installedPluginRoot: string;
const envelopeKeys = [
  'contract',
  'contractVersion',
  'status',
  'metadata',
  'diagnostics',
  'provenance',
  'result',
].toSorted();

type ProcessResult = {
  exitCode: number;
  stderr: string;
  stdout: string;
};

async function runSf(arguments_: string[], contractCase?: string): Promise<ProcessResult> {
  try {
    const { stderr, stdout } = await execFileAsync(executable, [...sfPrefix, ...arguments_], {
      cwd: isolatedDataDirectory,
      encoding: 'utf8',
      env: {
        ...process.env,
        NO_COLOR: '1',
        SF_DATA_DIR: isolatedDataDirectory,
        ...(contractCase === undefined
          ? {}
          : {
              NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${harness}`.trim(),
              SF_PLUGIN_CMS_CONTRACT_CASE: contractCase,
              SF_PLUGIN_CMS_INSTALLED_ROOT: installedPluginRoot,
              SF_PLUGIN_CMS_INSTALLED_VERSION: installedPackageVersion,
            }),
      },
      windowsHide: true,
    });
    return { exitCode: 0, stderr, stdout };
  } catch (error) {
    const result = error as Error & { code?: number; stderr?: string; stdout?: string };
    if (typeof result.code !== 'number') throw error;
    return {
      exitCode: result.code,
      stderr: result.stderr ?? '',
      stdout: result.stdout ?? '',
    };
  }
}

function expectPluginVersion(envelope: Record<string, unknown>, version: string): void {
  const metadata = envelope.metadata as { plugin: { version: string } };
  const provenance = envelope.provenance as { pluginVersion: string };
  expect(metadata.plugin.version).to.equal(version);
  expect(provenance.pluginVersion).to.equal(version);

  if (envelope.contract === 'sf-cms-info') {
    const info = envelope.result as { plugin: { version: string } } | null;
    if (info !== null) expect(info.plugin.version).to.equal(version);
  }
}

async function expectInstalledManifestVersion(
  envelope: Record<string, unknown>,
  version: string,
): Promise<void> {
  expect(envelope.contract).to.equal('sf-cms-workspace-export-set');
  const result = envelope.result as {
    workspaces: Array<{ artifact: { manifestPath: string } | null }>;
  };
  const manifestPath = result.workspaces[0].artifact?.manifestPath;
  expect(manifestPath).to.be.a('string');
  const manifest = JSON.parse(
    await readFile(path.resolve(isolatedDataDirectory, manifestPath!), 'utf8'),
  ) as {
    provenance: { pluginVersion: string };
  };
  expect(manifest.provenance.pluginVersion).to.equal(version);
}

function parseEnvelope(result: ProcessResult): Record<string, unknown> {
  expect(result.stdout.trim()).not.to.equal('');
  let envelope: Record<string, unknown>;
  try {
    envelope = JSON.parse(result.stdout) as Record<string, unknown>;
  } catch (error) {
    throw new Error(
      `invalid JSON stdout: ${JSON.stringify(result.stdout)}; stderr: ${result.stderr}`,
      {
        cause: error,
      },
    );
  }
  expect(Object.keys(envelope).toSorted()).to.deep.equal(envelopeKeys);
  expect(envelope.status).to.be.a('string');
  expect(envelope).not.to.have.keys('warnings');
  if (envelope.result !== null) {
    expect(envelope.result).not.to.have.all.keys(envelopeKeys);
  }
  return envelope;
}

async function installPackedPlugin(dataDirectory: string): Promise<string> {
  const temporaryPackDirectory = await mkdtemp(path.join(tmpdir(), 'sf-plugin-cms-pack-'));
  try {
    if (npmCli === undefined) throw new Error('npm executable path is unavailable');
    const { stdout } = await execFileAsync(executable, [
      npmCli,
      'pack',
      '--json',
      '--pack-destination',
      temporaryPackDirectory,
    ]);
    const [{ filename }] = JSON.parse(stdout) as Array<{ filename: string }>;
    const packageName = JSON.parse(await readFile('package.json', 'utf8')).name as string;
    const specification = `${packageName}@file:${path.join(temporaryPackDirectory, filename).replaceAll('\\', '/')}`;
    await runInstall(specification, dataDirectory);
    return path.join(dataDirectory, 'node_modules', packageName);
  } finally {
    await rm(temporaryPackDirectory, { force: true, recursive: true });
  }
}

async function runInstall(specification: string, dataDirectory: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable, [...sfPrefix, 'plugins', 'install', specification], {
      cwd: process.cwd(),
      env: { ...process.env, NO_COLOR: '1', SF_DATA_DIR: dataDirectory },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stderr = '';
    let stdout = '';
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
    child.stdin.end('y\n');
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`packed plugin install failed (${code}): ${stdout}${stderr}`));
    });
  });
}

describe('authoritative Salesforce CLI subprocess envelopes', function () {
  this.timeout(120_000);

  before(async () => {
    isolatedDataDirectory = await mkdtemp(path.join(tmpdir(), 'sf-plugin-cms-cli-data-'));
    installedPluginRoot = await installPackedPlugin(isolatedDataDirectory);
    installedPackageVersion = (
      JSON.parse(await readFile(path.join(installedPluginRoot, 'package.json'), 'utf8')) as {
        version: string;
      }
    ).version;
  });

  after(async () => {
    await rm(isolatedDataDirectory, { force: true, recursive: true });
  });

  for (const [title, command, contractCase, expectedStatus, expectedExit] of [
    ['success', ['cms', 'info', '--json'], undefined, 'success', 0],
    [
      'aggregate export success',
      ['cms', 'export', 'workspace', '--target-org', 'unused', '--all', '--json'],
      'export-success',
      'success',
      0,
    ],
    [
      'aggregate export partial',
      ['cms', 'export', 'workspace', '--target-org', 'unused', '--all', '--json'],
      'partial',
      'partial',
      2,
    ],
    [
      'command-owned failure',
      [
        'cms',
        'import',
        'workspace',
        '--target-org',
        'unused',
        '--source-dir',
        '.',
        '--workspace-id',
        'unused',
        '--json',
      ],
      'failed',
      'failed',
      1,
    ],
  ] as const) {
    it(`emits one exact seven-key envelope for ${title} and exits ${expectedExit}`, async () => {
      const result = await runSf([...command], contractCase);
      const envelope = parseEnvelope(result);

      expect(result.exitCode).to.equal(expectedExit);
      expect(envelope.status).to.equal(expectedStatus);
      expectPluginVersion(envelope, installedPackageVersion);
      if (contractCase === 'export-success') {
        await expectInstalledManifestVersion(envelope, installedPackageVersion);
      }
      expect(result.stdout).to.equal(`${JSON.stringify(envelope, null, 2)}\n`);
    });
  }

  it('emits the exact blocked info envelope and exits 1', async () => {
    const result = await runSf(['cms', 'info', '--contract-version', '2', '--json']);
    const envelope = parseEnvelope(result);

    expect(result.exitCode).to.equal(1);
    expect(envelope).to.deep.include({ contract: 'sf-cms-info', status: 'blocked', result: null });
  });

  it('emits the exact blocked export envelope and exits 1 before org access', async () => {
    const result = await runSf([
      'cms',
      'export',
      'workspace',
      '--target-org',
      'unused',
      '--all',
      '--contract-version',
      '2',
      '--json',
    ]);
    const envelope = parseEnvelope(result);

    expect(result.exitCode).to.equal(1);
    expect(envelope).to.deep.include({
      contract: 'sf-cms-workspace-export-set',
      status: 'blocked',
      result: null,
    });
  });

  it('emits the exact blocked import envelope and exits 1 before org access', async () => {
    const result = await runSf([
      'cms',
      'import',
      'workspace',
      '--target-org',
      'unused',
      '--source-dir',
      '.',
      '--workspace-id',
      'unused',
      '--contract-version',
      '2',
      '--json',
    ]);
    const envelope = parseEnvelope(result);

    expect(result.exitCode).to.equal(1);
    expect(envelope).to.deep.include({
      contract: 'sf-cms-workspace-import',
      status: 'blocked',
      result: null,
    });
  });
});
