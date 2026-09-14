import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
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
let isolatedDataDirectory: string;
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
      cwd: process.cwd(),
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

function parseEnvelope(result: ProcessResult): Record<string, unknown> {
  expect(result.stdout.trim()).not.to.equal('');
  const envelope = JSON.parse(result.stdout) as Record<string, unknown>;
  expect(Object.keys(envelope).toSorted()).to.deep.equal(envelopeKeys);
  expect(envelope).not.to.have.keys('warnings');
  return envelope;
}

describe('authoritative Salesforce CLI subprocess envelopes', function () {
  this.timeout(120_000);

  before(async () => {
    isolatedDataDirectory = await mkdtemp(path.join(tmpdir(), 'sf-plugin-cms-cli-data-'));
    await execFileAsync(executable, [...sfPrefix, 'plugins', 'link', '.', '--no-install'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: { ...process.env, NO_COLOR: '1', SF_DATA_DIR: isolatedDataDirectory },
      windowsHide: true,
    });
  });

  after(async () => {
    await rm(isolatedDataDirectory, { force: true, recursive: true });
  });

  for (const [title, command, contractCase, expectedStatus, expectedExit] of [
    ['success', ['cms', 'info', '--json'], undefined, 'success', 0],
    [
      'usable partial',
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
