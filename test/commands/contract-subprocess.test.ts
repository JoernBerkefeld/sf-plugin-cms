import { execFile, spawn } from 'node:child_process';
import { lstat, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { brandDetail } from '../fixtures/brand.js';
import { createHash } from 'node:crypto';
import {
  createRunOwnedDirectory,
  createRunOwnedTemp,
  removeRunOwnedPath,
  removeRunOwnedNodeModules,
  type RunOwnedTemp,
} from '../../src/filesystem/runOwnedTemp.js';
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
let fixtureRun: RunOwnedTemp;
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

const file = (relative: string) => path.join(isolatedDataDirectory, relative);

type ProcessResult = {
  exitCode: number;
  stderr: string;
  stdout: string;
};

async function runSf(
  arguments_: string[],
  contractCase?: string,
  environment: NodeJS.ProcessEnv = {},
): Promise<ProcessResult> {
  try {
    const pending = execFileAsync(executable, [...sfPrefix, ...arguments_], {
      cwd: isolatedDataDirectory,
      encoding: 'utf8',
      env: {
        ...process.env,
        NO_COLOR: '1',
        ...environment,
        SF_DATA_DIR: isolatedDataDirectory,
        SF_CONFIG_DIR: isolatedDataDirectory,
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
    const { stderr, stdout } = await pending;
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

type LogRecord = { message: string; details?: Record<string, unknown> };

async function invocationRecords(result: ProcessResult, argv: string[]): Promise<LogRecord[]> {
  const notices = [...result.stderr.matchAll(/^CMS log: (.+)\r?$/gmu)];
  expect(notices, result.stderr).to.have.length(1);
  const logPath = notices[0][1].trim();
  expect(path.dirname(logPath)).to.equal(file('logs/cms'));
  expect(path.basename(logPath)).to.match(/^\d{4}-\d\d-\d\dT\d\d\.\d\d\.\d\d\.\d{3}Z\.log$/u);
  const bytes = await readFile(logPath, 'utf8');
  const records = bytes
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as LogRecord);
  expect(records[0].message).to.equal(`sf-plugin-cms ${installedPackageVersion}`);
  expect(records[1].message).to.equal('invocation');
  expect(records[1].details).to.deep.include({ argv, cwd: isolatedDataDirectory });
  for (const channel of ['stdout', 'stderr']) {
    const transcript = records
      .filter(({ message, details }) => message === 'terminal' && details?.channel === channel)
      .map(({ details }) => details!.text)
      .join('');
    // Host notices before the CMS-owned boundary are deliberately outside this transcript.
    if (channel === 'stdout') expect(transcript).to.equal(result.stdout);
    else expect(result.stderr).to.include(transcript);
  }
  expect(
    records.some(
      ({ message, details }) => message === 'terminal' && details?.text === `CMS log: ${logPath}\n`,
    ),
  ).to.equal(true);
  return records;
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

const sourceAcceptanceHash = (bytes: string | Buffer) =>
  createHash('sha256').update(bytes).digest('hex');

function compare(left: string, right: string): number {
  const a = left.split('.').map(Number),
    b = right.split('.').map(Number);
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

async function installPackedPlugin(dataDirectory: string): Promise<string> {
  const packRun = await createRunOwnedTemp('sf-plugin-cms-pack');
  const temporaryPackDirectory = await createRunOwnedDirectory(packRun, 'fixture');
  try {
    if (npmCli === undefined) throw new Error('npm executable path is unavailable');
    const pending = execFileAsync(
      executable,
      [npmCli, 'pack', '--json', '--pack-destination', temporaryPackDirectory],
      {
        env: { ...process.env, npm_config_cache: path.join(dataDirectory, 'npm-cache') },
      },
    );
    const { stdout } = await pending;
    const [{ filename }] = JSON.parse(stdout) as Array<{ filename: string }>;
    const packageName = JSON.parse(await readFile('package.json', 'utf8')).name as string;
    const specification = `${packageName}@file:${path.join(temporaryPackDirectory, filename).replaceAll('\\', '/')}`;
    await runInstall(specification, dataDirectory);
    return path.join(dataDirectory, 'node_modules', packageName);
  } finally {
    await removeRunOwnedPath(packRun, temporaryPackDirectory);
    const retainedRoot = await lstat(packRun.root);
    expect(retainedRoot.isDirectory()).to.equal(true);
  }
}

async function runInstall(specification: string, dataDirectory: string): Promise<void> {
  // Approved narrow exception: CLI 2.140.0 checks this exact run-owned tarball spec
  // as a repository URL. Trust only it and the required package in fresh isolated state.
  const allowlist = ['sf-plugin-cms', specification];
  const allowlistPath = path.join(dataDirectory, 'unsignedPluginAllowList.json');
  await writeFile(allowlistPath, JSON.stringify(allowlist), 'utf8');
  expect(JSON.parse(await readFile(allowlistPath, 'utf8'))).to.deep.equal([
    'sf-plugin-cms',
    specification,
  ]);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable, [...sfPrefix, 'plugins', 'install', specification], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        NO_COLOR: '1',
        SF_DATA_DIR: dataDirectory,
        SF_CONFIG_DIR: dataDirectory,
        npm_config_cache: path.join(dataDirectory, 'npm-cache'),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stderr = '';
    let stdout = '';
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
    child.stdin.end();
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`packed plugin install failed (${code}): ${stdout}${stderr}`));
    });
  });
}

describe('authoritative Salesforce CLI subprocess envelopes', function () {
  this.timeout(240_000);

  before(async () => {
    fixtureRun = await createRunOwnedTemp('sf-plugin-cms-cli-data');
    isolatedDataDirectory = await createRunOwnedDirectory(fixtureRun, 'fixture');
    await writeFile(
      file('package.json'),
      JSON.stringify({
        name: 'sf-plugin-cms-cli-fixture',
        private: true,
        oclif: { plugins: [], schema: 1 },
      }),
    );
    installedPluginRoot = await installPackedPlugin(isolatedDataDirectory);
    installedPackageVersion = (
      JSON.parse(await readFile(path.join(installedPluginRoot, 'package.json'), 'utf8')) as {
        version: string;
      }
    ).version;
  });

  after(async () => {
    if (isolatedDataDirectory === undefined) return;
    await removeRunOwnedNodeModules(fixtureRun, isolatedDataDirectory, 'sf-plugin-cms-cli-fixture');
    await removeRunOwnedPath(fixtureRun, isolatedDataDirectory);
    await lstat(isolatedDataDirectory).then(
      () => expect.fail('registered CLI fixture should have been removed'),
      (error: NodeJS.ErrnoException) => expect(error.code).to.equal('ENOENT'),
    );
    const retainedRoot = await lstat(fixtureRun.root);
    expect(retainedRoot.isDirectory()).to.equal(true);
  });

  for (const [title, command, contractCase, expectedStatus, expectedExit] of [
    ['success', ['cms', 'info', '--json'], undefined, 'success', 0],
  ] as const) {
    it(`emits one exact seven-key envelope for ${title} and exits ${expectedExit}`, async () => {
      const result = await runSf([...command], contractCase);
      const envelope = parseEnvelope(result);

      expect(result.exitCode).to.equal(expectedExit);
      expect(envelope.status).to.equal(expectedStatus);
      expectPluginVersion(envelope, installedPackageVersion);
      expect(result.stdout).to.equal(`${JSON.stringify(envelope, null, 2)}\n`);
    });
  }

  for (const [alias, canonical, evidence] of [
    ['retrieve', 'retrieve content', '--metadata'],
    ['deploy', 'deploy content', '--source-dir'],
    ['delete', 'delete content', '--ownership-report'],
    ['publish', 'publish content', '--acknowledge-no-send'],
    ['unpublish', 'unpublish content', '--acknowledge-active-use-stops'],
    ['list workspace', 'list workspace', '--name-fragment'],
    ['list channel', 'list channel', '--workspace-id'],
    ['upload images', 'upload images', '--file'],
    ['info', 'info', '--contract-version'],
  ]) {
    it(`resolves packed content ${alias} help to the canonical command`, async () => {
      for (const route of [
        ['cms', ...canonical.split(' ')],
        ['content', ...alias.split(' ')],
      ]) {
        const argv = [...route, '--help'];
        const help = await runSf(argv);
        expect(help.exitCode, help.stdout + help.stderr).to.equal(0);
        const normalizedHelp = help.stdout.replaceAll(/\s+/gu, ' ');
        expect(normalizedHelp).to.include(`sf cms ${canonical}`);
        expect(normalizedHelp).to.include(evidence);
        expect(normalizedHelp).to.include('--json');
        expect(normalizedHelp).to.include('--api');
        expect(normalizedHelp).to.include('log');
        // The host renders --help before constructing the CMS command.
        // Help/invalid enum parsing needs no auth fixture or transport replacement.
        const invalidArgv = [...route, '--api', 'cli', '--json'];
        const invalid = await runSf(invalidArgv);
        expect(invalid.exitCode, invalid.stdout + invalid.stderr).to.equal(1);
        expect(JSON.parse(invalid.stdout).message).to.match(/--api.*(?:log|cli)/su);
        const records = await invocationRecords(invalid, invalidArgv);
        expect(records.some(({ message }) => message === 'command failure')).to.equal(true);
      }
    });
  }

  it('keeps packed content info success and blocked envelopes equivalent to cms info', async () => {
    for (const unsupported of [false, true]) {
      const suffix = unsupported
        ? ['--contract-version', '3', '--api', 'log', '--json']
        : ['--json'];
      const canonical = await runSf(['cms', 'info', ...suffix]);
      const alias = await runSf(['content', 'info', ...suffix]);
      expect(alias.exitCode, alias.stdout + alias.stderr).to.equal(unsupported ? 1 : 0);
      expect(alias.exitCode).to.equal(canonical.exitCode);
      const canonicalEnvelope = parseEnvelope(canonical);
      const aliasEnvelope = parseEnvelope(alias);
      expect(aliasEnvelope).to.deep.include({
        contract: 'sf-cms-info',
        contractVersion: '1.0.0',
        status: unsupported ? 'blocked' : 'success',
      });
      expectPluginVersion(aliasEnvelope, installedPackageVersion);
      expect(aliasEnvelope.provenance).to.include({ command: 'sf cms info' });
      expect(alias.stdout).to.equal(`${JSON.stringify(aliasEnvelope, null, 2)}\n`);
      for (const [response, route] of [
        [canonical, 'cms'],
        [alias, 'content'],
      ] as const) {
        const records = await invocationRecords(response, [route, 'info', ...suffix]);
        const diagnostics = records.find(({ message }) => message === 'command diagnostics')!;
        expect(diagnostics.details?.orgContext).to.equal(
          'not entered; no CMS org HTTP or mutation dispatched',
        );
        expect(diagnostics.details?.status).to.equal(unsupported ? 'blocked' : 'success');
        if (unsupported)
          expect(JSON.stringify(diagnostics)).to.include('UNSUPPORTED_CONTRACT_VERSION');
      }
      if (unsupported) {
        expect(aliasEnvelope.result).to.equal(null);
        expect(aliasEnvelope.diagnostics).to.deep.include({
          errors: [
            {
              code: 'UNSUPPORTED_CONTRACT_VERSION',
              message: 'Contract major 3 is unsupported; supported major is 1.',
              retryable: false,
            },
          ],
        });
      }
      // Each invocation owns its timestamp; every other public field stays identical.
      for (const envelope of [canonicalEnvelope, aliasEnvelope]) {
        delete (envelope.provenance as Record<string, unknown>).generatedAt;
      }
      expect(aliasEnvelope).to.deep.equal(canonicalEnvelope);
    }
  });

  it('records packed all-command local guards and plain list results with valid API opt-in', async () => {
    await writeFile(file('logging-ownership.json'), '{}');
    const common = ['--target-org', 'unused', '--api-version', '67.0'];
    const lifecycle = [
      '--workspace-id',
      'space',
      '--api-name',
      'Welcome',
      '--contract-version',
      '99',
    ];
    const cases: Array<[string[], string[], string]> = [
      [['retrieve', 'content'], [], 'RETRIEVE_'],
      [['deploy', 'content'], [], 'DEPLOY_'],
      [
        ['upload', 'images'],
        ['--workspace-id', 'space', '--file', 'missing-logging.png'],
        'IMAGE_',
      ],
      [['publish', 'content'], lifecycle, 'UNSUPPORTED_CONTRACT_VERSION'],
      [['unpublish', 'content'], lifecycle, 'UNSUPPORTED_CONTRACT_VERSION'],
      [
        ['delete', 'content'],
        [...lifecycle, '--ownership-report', 'logging-ownership.json'],
        'UNSUPPORTED_CONTRACT_VERSION',
      ],
    ];
    for (const [route, args, code] of cases) {
      for (const prefix of [
        ['cms', ...route],
        ['content', ...route.filter((token) => token !== 'content')],
      ]) {
        const argv = [...prefix, ...common, ...args, '--api', 'log', '--json'];
        const result = await runSf(argv, 'logging-guards');
        expect(result.exitCode, result.stdout + result.stderr).to.equal(1);
        expect(parseEnvelope(result).status).to.equal('blocked');
        const records = await invocationRecords(result, argv);
        const diagnostics = records.find(({ message }) => message === 'command diagnostics');
        expect(JSON.stringify(diagnostics)).to.include(code);
        expect(diagnostics?.details?.orgContext).to.equal(
          'not entered; no CMS org HTTP or mutation dispatched',
        );
        expect(result.stdout + result.stderr).not.to.include(
          'Unexpected logging fixture org access',
        );
      }
    }
    for (const route of [
      ['list', 'workspace'],
      ['list', 'channel'],
    ]) {
      const argv = [
        'content',
        ...route,
        ...common,
        ...(route[1] === 'channel' ? ['--workspace-id', 'space'] : []),
        '--api',
        'log',
        '--json',
      ];
      const result = await runSf(argv, 'logging-table');
      expect(result.exitCode, result.stdout + result.stderr).to.equal(0);
      expect(JSON.parse(result.stdout).items[0].name).to.equal('Transcript fixture');
      await invocationRecords(result, argv);
    }
  });

  it('mirrors packed human tables/errors and preserves JSON success after sink close failure', async () => {
    for (const environment of [{}, { CI: 'true' }, { OCLIF_TABLE_LIMIT: '1' }]) {
      const argv = [
        'content',
        'list',
        'workspace',
        '--target-org',
        'unused',
        '--api-version',
        '67.0',
      ];
      const result = await runSf(argv, 'logging-table', environment);
      expect(result.exitCode, result.stdout + result.stderr).to.equal(0);
      expect(result.stdout).to.include('Transcript fixture');
      await invocationRecords(result, argv);
    }
    const argv = ['cms', 'list', 'workspace', '--target-org', 'unused'];
    const failed = await runSf(argv, 'logging-error');
    expect(failed.exitCode).to.equal(1);
    expect(failed.stderr).to.include('list failure sentinel');
    // Visible secrets are intentionally masked on disk, not byte-identical there.
    const notice = /^CMS log: (.+)$/mu.exec(failed.stderr)!;
    const bytes = await readFile(notice[1].trim(), 'utf8');
    expect(bytes).to.include('list failure sentinel');
    expect(bytes).not.to.include('disk-secret');
    expect(bytes).to.include('command failure');
    const successArgv = ['content', 'info', '--api', 'log', '--json'];
    const success = await runSf(successArgv, 'logging-close-fault');
    expect(success.exitCode).to.equal(0);
    expect(parseEnvelope(success).status).to.equal('success');
    expect(success.stderr).to.include('CMS logging incomplete at');
    expect(success.stderr).to.include('packed flush failure sentinel');
    await invocationRecords(success, successArgv);
  });

  it('loads packed image upload help, ordered repeated files, and offline invalid arguments', async function () {
    this.timeout(300_000);
    const help = await runSf(['cms', 'upload', 'images', '--help']);
    expect(help.exitCode, help.stderr).to.equal(0);
    expect(help.stdout.replaceAll(/\s+/gu, ' ')).to.include('Dry-run is the default');
    expect(help.stdout).to.include('--file');
    const names = ['Banner with spaces.PNG', 'Logo.png'];
    for (const name of names)
      await writeFile(file(name), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]));
    const common = ['cms', 'upload', 'images', '--target-org', 'unused', '--workspace-id', 'space'];
    const preview = await runSf(
      [...common, ...names.flatMap((name) => ['--file', name]), '--json'],
      'image-upload-preview',
    );
    expect(preview.exitCode, preview.stdout + preview.stderr).to.equal(0);
    const envelope = parseEnvelope(preview);
    expect(envelope).to.deep.include({
      contract: 'sf-cms-images-upload',
      contractVersion: '1.0.0',
      status: 'success',
    });
    expectPluginVersion(envelope, installedPackageVersion);
    const result = envelope.result as {
      mode: string;
      intents: Array<{ filename: string }>;
      target: { rootFolderId: string };
      reportFile: unknown;
    };
    expect(result.mode).to.equal('dry-run');
    expect(result.intents.map(({ filename }) => filename)).to.deep.equal(names);
    expect(result.target.rootFolderId).to.equal('root');
    expect(result.reportFile).to.equal(null);
    expect(JSON.stringify(envelope)).not.to.include('bytes');
    const events = JSON.parse(
      await readFile(file('image-upload-preview-transport.json'), 'utf8'),
    ) as Array<{ method?: string }>;
    expect(events.slice(1).every(({ method }) => method === 'GET')).to.equal(true);
    const human = await runSf([...common, '--file', names[0]], 'image-upload-preview');
    expect(human.exitCode, human.stdout + human.stderr).to.equal(0);
    expect(human.stdout).to.include('Destination root folder: root');
    expect(human.stdout).to.include('Banner with spaces.PNG: 9 bytes');
    for (const args of [
      ['--file', names[0], '--apply'],
      ['--file', 'missing.png'],
      ['--file', names[0], '--contract-version', '2'],
    ]) {
      const blocked = await runSf([...common, ...args, '--json'], 'image-upload-local');
      expect(blocked.exitCode, blocked.stdout + blocked.stderr).to.equal(1);
      expect(parseEnvelope(blocked).status).to.equal('blocked');
      expect(blocked.stdout + blocked.stderr).not.to.include('Unexpected org access');
    }
  });

  it('reports current installed public support separately from internal registry provenance', async () => {
    const response = await runSf(['cms', 'info', '--json']);
    expect(response.exitCode).to.equal(0);
    const envelope = parseEnvelope(response);
    expectPluginVersion(envelope, installedPackageVersion);
    expect(envelope.contractVersion).to.equal('1.0.0');
    const result = envelope.result as {
      commands: string[];
      capabilities: Array<{ id: string; state: string }>;
      internalRegistry: {
        scope: string;
        version: string;
        declarations: Array<{ providerContract: { minVersion: string; maxVersion: string } }>;
      };
    };
    expect(result.commands).to.deep.equal([
      'cms info',
      'cms list workspace',
      'cms list channel',
      'cms retrieve content',
      'cms deploy content',
      'cms upload images',
      'cms delete content',
      'cms publish content',
      'cms unpublish content',
    ]);
    expect(
      result.capabilities.some(({ id }) =>
        /workspace\.(?:export|import)|content\.update\./u.test(id),
      ),
    ).to.equal(false);
    expect(
      result.capabilities
        .filter(({ id }) => id.startsWith('content.deploy.'))
        .every(({ state }) => state === 'unqualified'),
    ).to.equal(true);
    expect(
      result.capabilities.filter(({ id }) => id.startsWith('content.deploy.image.')),
    ).to.deep.equal(
      ['create', 'update', 'unchanged'].map((operation) => ({
        id: `content.deploy.image.${operation}`,
        state: 'unqualified',
        transport: 'cli-json',
        contract: 'sf-cms-content-deploy@1',
      })),
    );
    expect(result.capabilities.filter(({ id }) => id.includes('.document'))).to.deep.equal([
      {
        id: 'content.retrieve.document',
        state: 'unqualified',
        transport: 'cli-json',
        contract: 'sf-cms-content-retrieve@1',
      },
      ...['create', 'update', 'unchanged'].map((operation) => ({
        id: `content.deploy.document.${operation}`,
        state: 'unqualified',
        transport: 'cli-json',
        contract: 'sf-cms-content-deploy@1',
      })),
    ]);
    expect(result.capabilities.filter(({ id }) => id.includes('.audio'))).to.deep.equal([
      {
        id: 'content.retrieve.audio',
        state: 'unqualified',
        transport: 'cli-json',
        contract: 'sf-cms-content-retrieve@1',
      },
      ...['create', 'update', 'unchanged'].map((operation) => ({
        id: `content.deploy.audio.${operation}`,
        state: 'unqualified',
        transport: 'cli-json',
        contract: 'sf-cms-content-deploy@1',
      })),
    ]);
    const deployHelp = await runSf(['cms', 'deploy', 'content', '--help']);
    expect(deployHelp.exitCode, deployHelp.stderr).to.equal(0);
    const helpText = deployHelp.stdout.replaceAll(/\s+/gu, ' ');
    expect(helpText).to.include('Documents support CREATE, bytes-only UPDATE and exact unchanged');
    expect(helpText).to.include('unchanged metadata, native filename, MIME, language and type');
    expect(helpText).to.include(
      'bounded two-org development-artifact acceptance covers the tested text/plain profile',
    );
    expect(helpText).not.to.include('pending current immutable-artifact');
    expect(helpText).not.to.include('Document UPDATE is unsupported');
    expect(result.internalRegistry.scope).to.equal('internal-engine-only');
    expect(result.internalRegistry.version).to.equal('1.0.0');
    for (const declaration of result.internalRegistry.declarations) {
      expect(
        compare(installedPackageVersion, declaration.providerContract.minVersion),
      ).to.be.at.least(0);
      expect(
        compare(installedPackageVersion, declaration.providerContract.maxVersion),
      ).to.be.at.most(0);
    }
    const obsolete = await runSf(['cms', 'info', '--contract-version', '2', '--json']);
    expect(obsolete.exitCode).to.equal(1);
    expect(parseEnvelope(obsolete)).to.deep.include({ status: 'blocked', result: null });
  });

  it('routes packed Audio selectors through real CREATE planning with default-org or explicit override', async () => {
    const sourceDirectory = file('audio-deploy-source');
    await mkdir(sourceDirectory);
    const definition = path.join(sourceDirectory, 'Chime.cms-audio.json');
    const companion = path.join(sourceDirectory, 'Chime.cms-audio.media.bin');
    const bytes = Buffer.from([0, 255, 128, 13, 10]);
    await writeFile(
      definition,
      JSON.stringify({
        contract: 'sf-cms-media-source',
        contractVersion: '1.0.0',
        identity: {
          family: 'cms',
          type: 'Audio',
          apiName: 'Chime',
          context: { workspaceApiName: 'Source' },
        },
        contentType: 'sfdc_cms__audio',
        language: 'en_US',
        title: 'Chime',
        folderPath: [],
        media: {
          representation: 'binary',
          mimeType: 'application/x-future-audio',
          companion: { role: 'media', path: path.basename(companion) },
        },
      }),
    );
    await writeFile(companion, bytes);
    for (const [selector, override] of [
      [['-t', 'audio'], false],
      [['-m', 'sfdc_cms__audio:Chime'], true],
    ] as const) {
      const output = await runSf(
        [
          'cms',
          'deploy',
          'content',
          '-d',
          sourceDirectory,
          ...selector,
          '--workspace-id',
          '0Zu000000000001AAA',
          '-L',
          '--api-version',
          '67.0',
          '--json',
          ...(override ? ['-o', 'explicit@example.test'] : []),
        ],
        'audio-deploy-preview',
      );
      expect(output.exitCode, output.stdout + output.stderr).to.equal(0);
      const envelope = parseEnvelope(output);
      expectPluginVersion(envelope, installedPackageVersion);
      expect(envelope.status).to.equal('success');
      expect(envelope.contract).to.equal('sf-cms-content-deploy');
      const result = envelope.result as {
        mode: string;
        mutationEnabled: boolean;
        qualification: string;
        scope: { targetOrg: string; language: string };
        selection: {
          items: Array<{ targetIdentity: { contentType: string }; mediaSha256: string }>;
        };
        summary: { plannedCreate: number; completed: number };
        items: Array<{ proposed: string; outcome: string }>;
      };
      expect(result.mode).to.equal('dry-run');
      expect(result.mutationEnabled).to.equal(false);
      expect(result.qualification).to.equal('unqualified');
      expect(result.scope.targetOrg).to.equal(
        override ? 'explicit@example.test' : 'controlled-default@example.test',
      );
      expect(result.scope.language).to.equal('en_US');
      expect(result.summary.plannedCreate).to.equal(1);
      expect(result.summary.completed).to.equal(0);
      expect(result.items[0]).to.include({ proposed: 'create', outcome: 'planned' });
      expect(result.selection.items).to.have.length(1);
      expect(result.selection.items[0].targetIdentity.contentType).to.equal('sfdc_cms__audio');
      expect(result.selection.items[0].mediaSha256).to.equal(sourceAcceptanceHash(bytes));
      const events = JSON.parse(
        await readFile(file('audio-deploy-preview-transport.json'), 'utf8'),
      ) as Array<{ phase?: string; username?: string; method?: string; url?: string }>;
      expect(events[0]).to.deep.equal({ phase: 'org', username: result.scope.targetOrg });
      expect(events.slice(1).length).to.be.greaterThan(0);
      expect(events.slice(1).every(({ method }) => method === 'GET')).to.equal(true);
      expect(await readFile(companion)).to.deep.equal(bytes);
    }
  });

  for (const [topic, resource] of [
    ['export', 'workspace'],
    ['import', 'workspace'],
    ['update', 'content'],
  ]) {
    it(`does not install a public ${topic} ${resource} route or alias`, async () => {
      const help = await runSf(['cms', '--help']);
      expect(help.exitCode, help.stderr).to.equal(0);
      expect(help.stdout).not.to.match(new RegExp(String.raw`cms[ :]+${topic}\b`, 'u'));
      const removed = await runSf(['cms', topic, resource, '--help']);
      expect(removed.exitCode).not.to.equal(0);
      expect(removed.stdout + removed.stderr).to.match(
        /not (?:a .*command|found)|not recognized/iu,
      );
    });
  }

  it('previews one installed packed Email publish with exact selectors', async function () {
    this.timeout(300_000);
    const help = await runSf(['cms', 'publish', 'content', '--help']);
    expect(help.exitCode, help.stderr).to.equal(0);
    const normalizedHelp = help.stdout.replaceAll(/\s+/gu, ' ');
    expect(normalizedHelp).to.include('sf cms publish content');
    expect(normalizedHelp).to.include('--workspace-id');
    expect(normalizedHelp).to.include('--api-name');
    expect(normalizedHelp).to.include('--language');
    expect(normalizedHelp).to.include('--acknowledge-no-send');
    expect(normalizedHelp).to.include('Dry-run is the default');

    const preview = await runSf(
      [
        'cms',
        'publish',
        'content',
        '--target-org',
        'unused',
        '--workspace-id',
        'space',
        '--api-name',
        'pilot_email',
        '--language',
        'en_US',
        '--json',
      ],
      'email-publish-preview',
    );
    expect(preview.exitCode, preview.stdout + preview.stderr).to.equal(0);
    const envelope = parseEnvelope(preview);
    expect(envelope).to.deep.include({
      contract: 'sf-cms-content-publish',
      contractVersion: '1.0.0',
      status: 'success',
    });
    expectPluginVersion(envelope, installedPackageVersion);
    expect((envelope.provenance as { command: string }).command).to.equal('sf cms publish content');
    expect(envelope.result).to.deep.include({
      mode: 'dry-run',
      outcome: 'ready',
      target: {
        workspaceId: 'space',
        apiName: 'pilot_email',
        language: 'en_US',
        contentId: 'parent-email',
        variantId: 'variant-en',
      },
      blockers: [],
    });
    expect((envelope.result as { evidence: Record<string, unknown> }).evidence).to.deep.include({
      selectorScope: 'variant',
      includeContentReferences: false,
      noSendAcknowledgementRequired: true,
    });
    const events = JSON.parse(
      await readFile(file('email-publish-preview-transport.json'), 'utf8'),
    ) as Array<{ method?: string }>;
    expect(events.some((event) => event.method !== undefined && event.method !== 'GET')).to.equal(
      false,
    );
  });

  it('applies one installed packed Email publish after durable pending intent', async function () {
    this.timeout(300_000);
    const result = await runSf(
      [
        'cms',
        'publish',
        'content',
        '--target-org',
        'unused',
        '--workspace-id',
        'space',
        '--api-name',
        'pilot_email',
        '--language',
        'en_US',
        '--apply',
        '--acknowledge-no-send',
        '--report-dir',
        'email-publish-apply-report',
        '--json',
      ],
      'email-publish-apply',
    );
    expect(result.exitCode, result.stdout + result.stderr).to.equal(0);
    const envelope = parseEnvelope(result);
    expect(envelope).to.deep.include({ contract: 'sf-cms-content-publish', status: 'success' });
    expect(envelope.result).to.deep.include({ mode: 'apply', outcome: 'completed' });
    const events = JSON.parse(
      await readFile(file('email-publish-apply-transport.json'), 'utf8'),
    ) as Array<{ method?: string; body?: string }>;
    const posts = events.filter((event) => event.method === 'POST');
    expect(posts).to.have.length(1);
    expect(JSON.parse(posts[0].body!)).to.deep.equal({
      variantIds: ['variant-en'],
      contextContentSpaceId: 'space',
      includeContentReferences: false,
    });
  });

  it('previews and applies one installed packed Email unpublish', async function () {
    this.timeout(300_000);
    const help = await runSf(['cms', 'unpublish', 'content', '--help']);
    expect(help.exitCode, help.stderr).to.equal(0);
    const normalizedHelp = help.stdout.replaceAll(/\s+/gu, ' ');
    expect(normalizedHelp).to.include('sf cms unpublish content');
    expect(normalizedHelp).to.include('--acknowledge-active-use-stops');
    expect(normalizedHelp).to.include('--report-dir');
    expect(normalizedHelp).to.include('Dry-run is the default');
    const preview = await runSf(
      [
        'cms',
        'unpublish',
        'content',
        '--target-org',
        'unused',
        '--workspace-id',
        'space',
        '--api-name',
        'pilot_email',
        '--language',
        'en_US',
        '--json',
      ],
      'email-unpublish-preview',
    );
    expect(preview.exitCode, preview.stdout + preview.stderr).to.equal(0);
    const envelope = parseEnvelope(preview);
    expect(envelope).to.deep.include({
      contract: 'sf-cms-content-unpublish',
      contractVersion: '1.0.0',
      status: 'success',
    });
    expect((envelope.provenance as { command: string }).command).to.equal(
      'sf cms unpublish content',
    );
    expect(envelope.result).to.deep.include({
      mode: 'dry-run',
      outcome: 'ready',
      target: {
        workspaceId: 'space',
        apiName: 'pilot_email',
        language: 'en_US',
        contentId: 'parent-email',
        variantId: 'variant-en',
      },
      blockers: [],
    });
    expect((envelope.result as { evidence: Record<string, unknown> }).evidence).to.deep.include({
      selectorScope: 'parent',
      includeContentReferencesOmitted: true,
      activeUseStopsAcknowledgementRequired: true,
    });
    const applied = await runSf(
      [
        'cms',
        'unpublish',
        'content',
        '--target-org',
        'unused',
        '--workspace-id',
        'space',
        '--api-name',
        'pilot_email',
        '--language',
        'en_US',
        '--apply',
        '--acknowledge-active-use-stops',
        '--report-dir',
        'email-unpublish-apply-report',
        '--json',
      ],
      'email-unpublish-apply',
    );
    expect(applied.exitCode, applied.stdout + applied.stderr).to.equal(0);
    const appliedEnvelope = parseEnvelope(applied);
    expect(appliedEnvelope).to.deep.include({
      contract: 'sf-cms-content-unpublish',
      status: 'success',
    });
    expect(appliedEnvelope.result).to.deep.include({ mode: 'apply', outcome: 'completed' });
    const events = JSON.parse(
      await readFile(file('email-unpublish-apply-transport.json'), 'utf8'),
    ) as Array<{ method?: string; body?: string }>;
    const posts = events.filter((event) => event.method === 'POST');
    expect(posts).to.have.length(1);
    expect(JSON.parse(posts[0].body!)).to.deep.equal({
      contentIds: ['parent-email'],
    });
  });

  it('renders installed retrieve defaults and operation-scoped friendly examples without auth', async () => {
    const retrieve = await runSf(['cms', 'retrieve', 'content', '--help']);
    expect(retrieve.exitCode, retrieve.stderr).to.equal(0);
    const retrieveHelp = retrieve.stdout.replaceAll(/\s+/gu, ' ');
    expect(retrieveHelp).to.include('Content Workspace for Marketing Cloud');
    expect(retrieveHelp).to.include('configured default org');
    expect(retrieveHelp).to.include('current directory');
    expect(retrieveHelp).to.include('emailTemplate');
    expect(retrieveHelp).to.include('sfdc_cms__ names');
    const deploy = await runSf(['cms', 'deploy', 'content', '--help']);
    expect(deploy.exitCode, deploy.stderr).to.equal(0);
    const deployHelp = deploy.stdout.replaceAll(/\s+/gu, ' ');
    expect(deployHelp).to.include('-m email:Welcome');
    expect(deployHelp).to.include('-m audio:Intro');
    expect(deployHelp).to.include(
      'Audio supports unqualified CREATE, bytes-only UPDATE and exact unchanged',
    );
    expect(deployHelp).to.include(
      'Bounded two-org development-artifact acceptance covers the tested 844-byte WAV profile',
    );
    expect(retrieveHelp).not.to.include('Audio deployment is not enabled');
    const deletion = await runSf(['cms', 'delete', 'content', '--help']);
    expect(deletion.exitCode, deletion.stderr).to.equal(0);
    expect(deletion.stdout.replaceAll(/\s+/gu, ' ')).to.include('--content-type emailTemplate');
    expect(deletion.stdout).not.to.include('sfdc_cms__audio');
  });

  it('previews one installed packed bounded Email Template delete v2', async function () {
    this.timeout(300_000);
    await writeFile(file('email-template-delete-journal.json'), '{}');
    const preview = await runSf(
      [
        'cms',
        'delete',
        'content',
        '--target-org',
        'unused',
        '--contract-version',
        '2',
        '--content-type',
        'emailTemplate',
        '--workspace-id',
        'space',
        '--api-name',
        'pilot_template',
        '--language',
        'en_US',
        '--ownership-report',
        'email-template-delete-journal.json',
        '--json',
      ],
      'email-template-delete-preview',
    );
    expect(preview.exitCode, preview.stdout + preview.stderr).to.equal(0);
    const envelope = parseEnvelope(preview);
    expect(envelope).to.deep.include({
      contract: 'sf-cms-content-delete',
      contractVersion: '2.0.0',
      status: 'success',
    });
    expect((envelope.result as { evidence: Record<string, unknown> }).evidence).to.include({
      contentType: 'sfdc_cms__emailTemplate',
    });
  });

  it('applies one installed packed bounded Email Template delete v2', async function () {
    this.timeout(300_000);
    await writeFile(file('email-template-delete-journal.json'), '{}');
    const applied = await runSf(
      [
        'cms',
        'delete',
        'content',
        '--target-org',
        'unused',
        '--contract-version',
        '2',
        '--content-type',
        'emailTemplate',
        '--workspace-id',
        'space',
        '--api-name',
        'pilot_template',
        '--language',
        'en_US',
        '--ownership-report',
        'email-template-delete-journal.json',
        '--apply',
        '--acknowledge-permanent-delete',
        '--report-dir',
        'email-template-delete-apply-report',
        '--json',
      ],
      'email-template-delete-apply',
    );
    expect(applied.exitCode, applied.stdout + applied.stderr).to.equal(0);
    const envelope = parseEnvelope(applied);
    expect(envelope).to.deep.include({
      contract: 'sf-cms-content-delete',
      contractVersion: '2.0.0',
      status: 'success',
    });
    expect(envelope.result).to.deep.include({ mode: 'apply', outcome: 'completed' });
    const evidence = (envelope.result as { evidence: Record<string, unknown> }).evidence;
    expect(evidence).to.include({
      contentType: 'sfdc_cms__emailTemplate',
      exactVariantAbsent: true,
      parentBehavior: 'not-found',
      remainingFamilyVariantCount: 0,
    });
    expect(evidence).not.to.have.property('remainingEmailVariantCount');
    const events = JSON.parse(
      await readFile(file('email-template-delete-apply-transport.json'), 'utf8'),
    ) as Array<{ method?: string }>;
    expect(events.filter((event) => event.method === 'DELETE')).to.have.length(1);
  });

  it('previews and applies one installed packed bounded Email delete', async function () {
    this.timeout(300_000);
    const help = await runSf(['cms', 'delete', 'content', '--help']);
    expect(help.exitCode, help.stderr).to.equal(0);
    const normalizedHelp = help.stdout.replaceAll(/\s+/gu, ' ');
    expect(normalizedHelp).to.include('sf cms delete content');
    expect(normalizedHelp).to.include('--ownership-report');
    expect(normalizedHelp).to.include('--acknowledge-permanent-delete');
    expect(normalizedHelp).to.include('Dry-run is the default');

    await writeFile(file('email-delete-ownership.json'), '{}');
    const common = [
      'cms',
      'delete',
      'content',
      '--target-org',
      'unused',
      '--workspace-id',
      'space',
      '--api-name',
      'pilot_email',
      '--language',
      'en_US',
      '--ownership-report',
      'email-delete-ownership.json',
    ];
    const preview = await runSf(
      [...common, '--content-type', 'email', '--json'],
      'email-delete-preview',
    );
    expect(preview.exitCode, preview.stdout + preview.stderr).to.equal(0);
    const previewEnvelope = parseEnvelope(preview);
    expect(previewEnvelope).to.deep.include({
      contract: 'sf-cms-content-delete',
      contractVersion: '1.0.0',
      status: 'success',
    });
    expect((previewEnvelope.provenance as { command: string }).command).to.equal(
      'sf cms delete content',
    );
    expect(previewEnvelope.result).to.deep.include({
      mode: 'dry-run',
      outcome: 'ready',
      target: {
        workspaceId: 'space',
        apiName: 'pilot_email',
        language: 'en_US',
        contentId: 'parent-email',
        variantId: 'variant-en',
      },
    });
    const previewEvents = JSON.parse(
      await readFile(file('email-delete-preview-transport.json'), 'utf8'),
    ) as Array<{ method?: string }>;
    expect(previewEvents.some(({ method }) => method === 'DELETE')).to.equal(false);

    const applied = await runSf(
      [
        ...common,
        '--apply',
        '--acknowledge-permanent-delete',
        '--report-dir',
        'email-delete-apply-report',
        '--json',
      ],
      'email-delete-apply',
    );
    const deleteReport = await readFile(
      file('email-delete-apply-report/content-delete-run.json'),
      'utf8',
    );
    const deleteTransport = await readFile(file('email-delete-apply-transport.json'), 'utf8');
    expect(
      applied.exitCode,
      `${applied.stdout}${applied.stderr}\n${deleteReport}\n${deleteTransport}`,
    ).to.equal(0);
    const appliedEnvelope = parseEnvelope(applied);
    expect(appliedEnvelope).to.deep.include({
      contract: 'sf-cms-content-delete',
      status: 'success',
    });
    expect(appliedEnvelope.result).to.deep.include({ mode: 'apply', outcome: 'completed' });
    const completedReport = JSON.parse(deleteReport) as Record<string, unknown>;
    expect(completedReport.state).to.equal('completed');
    expect(completedReport).not.to.have.property('mutationError');
    expect(
      (appliedEnvelope.result as { evidence: Record<string, unknown> }).evidence,
    ).to.deep.include({
      exactVariantAbsent: true,
      selectedInventoryMatches: 0,
      parentBehavior: 'not-found',
      remainingEmailVariantCount: 1,
    });
    const events = JSON.parse(
      await readFile(file('email-delete-apply-transport.json'), 'utf8'),
    ) as Array<{ method?: string; url?: string }>;
    const deletes = events.filter(({ method }) => method === 'DELETE');
    expect(deletes).to.deep.equal([
      { method: 'DELETE', url: '/services/data/v67.0/connect/cms/contents/variants/variant-en' },
    ]);
    expect(
      events.filter(
        ({ method, url }) =>
          method === 'GET' && url === '/connect/cms/contents/variants/variant-en',
      ),
    ).to.have.length(3);
  });

  it('previews one installed packed Email HTML update from its strict export baseline', async function () {
    this.timeout(300_000);
    const runUpdate = async (apply = false, reportDirectory?: string) => {
      const output = await execFileAsync(executable, [fileURLToPath(harness)], {
        cwd: isolatedDataDirectory,
        encoding: 'utf8',
        env: {
          ...process.env,
          SF_PLUGIN_CMS_CONTRACT_CASE: 'email-update-preview',
          SF_PLUGIN_CMS_INSTALLED_ROOT: installedPluginRoot,
          SF_PLUGIN_CMS_INSTALLED_VERSION: installedPackageVersion,
          SF_PLUGIN_CMS_EMAIL_UPDATE_OPTIONS: JSON.stringify({ apply, reportDirectory }),
        },
        windowsHide: true,
      });
      return JSON.parse(output.stdout) as {
        status: string;
        message?: string;
        evidence: { baselineHash: string; changedFields: string[]; payloadHash: string };
        blockers: Array<{ code: string; message: string }>;
      };
    };

    const exported = await execFileAsync(executable, [fileURLToPath(harness)], {
      cwd: isolatedDataDirectory,
      encoding: 'utf8',
      env: {
        ...process.env,
        SF_PLUGIN_CMS_CONTRACT_CASE: 'email-update-fixture',
        SF_PLUGIN_CMS_INSTALLED_ROOT: installedPluginRoot,
        SF_PLUGIN_CMS_INSTALLED_VERSION: installedPackageVersion,
      },
      windowsHide: true,
    });
    const exportOutput = JSON.parse(exported.stdout) as {
      manifest: { completeness: string; provenance: { pluginVersion: string } };
    };
    expect(exportOutput.manifest.completeness).to.equal('complete');
    expect(exportOutput.manifest.provenance.pluginVersion).to.equal(installedPackageVersion);
    const fixtureEvents = JSON.parse(
      await readFile(file('email-update-fixture-transport.json'), 'utf8'),
    ) as Array<{ method: string; url: string }>;
    expect(fixtureEvents.length).to.be.greaterThan(0);
    expect(fixtureEvents.every(({ method }) => method === 'GET')).to.equal(true);
    expect(fixtureEvents.filter(({ url }) => url.includes('/contents/variants/'))).to.deep.equal([
      { method: 'GET', url: '/connect/cms/contents/variants/variant-en' },
    ]);
    expect(await readdir(file('email-update-baseline'))).to.deep.equal(['items', 'manifest.json']);
    expect(await readdir(file('email-update-editable'))).to.deep.equal(['editable.json', 'items']);
    expect(await readFile(file('email-update-editable/items/variant-en.html'), 'utf8')).to.equal(
      '<p>Original</p>',
    );
    await writeFile(
      file('email-update-editable/items/variant-en.html'),
      '<p>Installed preview edit</p>',
    );

    const result = await runUpdate();
    expect(result.status).to.equal('ready');
    expect(result.blockers).to.deep.equal([]);
    expect(result.evidence).to.deep.include({
      workspaceId: 'space',
      apiName: 'pilot_email',
      language: 'en_US',
      contentId: 'parent-email',
      variantId: 'variant-en',
    });
    expect(result.evidence.changedFields).to.deep.equal(['contentBody.rawHtml']);
    expect(result.evidence.baselineHash).to.match(/^[a-f\d]{64}$/u);
    expect(result.evidence.payloadHash).to.match(/^[a-f\d]{64}$/u);
    expect(result.evidence.payloadHash).not.to.equal(result.evidence.baselineHash);
    const events = JSON.parse(
      await readFile(file('email-update-preview-transport.json'), 'utf8'),
    ) as Array<{ method?: string }>;
    expect(events[0]).to.deep.equal({ phase: 'org' });
    expect(events.slice(1).length).to.be.greaterThan(0);
    expect(events.slice(1).every(({ method }) => method === 'GET')).to.equal(true);
    expect(events.some(({ method }) => method === 'PUT')).to.equal(false);
    expect(await readFile(file('email-update-editable/items/variant-en.html'), 'utf8')).to.equal(
      '<p>Installed preview edit</p>',
    );

    await writeFile(file('email-update-editable/editable.json'), '{ malformed');
    for (const mode of ['dry-run', 'apply'] as const) {
      const reportDirectory = 'malformed-email-update-report';
      const blocked = await runUpdate(mode === 'apply', reportDirectory);
      expect(blocked.status).to.equal('blocked');
      if (mode === 'apply') {
        expect(blocked.message).to.equal('Editable descriptor must contain valid JSON');
      } else {
        expect(blocked.blockers).to.deep.equal([
          {
            code: 'EMAIL_UPDATE_PREFLIGHT_BLOCKED',
            message: 'Editable descriptor must contain valid JSON',
          },
        ]);
      }
      const blockedEvents = JSON.parse(
        await readFile(file('email-update-preview-transport.json'), 'utf8'),
      ) as Array<{ method?: string }>;
      expect(blockedEvents.some(({ method }) => method === 'PUT')).to.equal(false);
      expect(await readdir(isolatedDataDirectory)).not.to.include(reportDirectory);
    }
  });

  it('previews and applies one installed packed bounded Email Template update v2', async function () {
    this.timeout(300_000);
    // Harness exports create these destinations; leave them nonexistent.
    const runUpdate = async (contractCase: string) => {
      const output = await execFileAsync(executable, [fileURLToPath(harness)], {
        cwd: isolatedDataDirectory,
        encoding: 'utf8',
        env: {
          ...process.env,
          SF_PLUGIN_CMS_CONTRACT_CASE: contractCase,
          SF_PLUGIN_CMS_INSTALLED_ROOT: installedPluginRoot,
          SF_PLUGIN_CMS_INSTALLED_VERSION: installedPackageVersion,
        },
        windowsHide: true,
      });
      return JSON.parse(output.stdout);
    };
    const preview = await runUpdate('email-template-update-preview');
    expect(preview.status).to.equal('ready');
    expect(preview.blockers).to.deep.equal([]);
    expect(preview.evidence).to.deep.include({
      contentType: 'sfdc_cms__emailTemplate',
      workspaceId: 'space',
      apiName: 'pilot_template',
      language: 'en_US',
      contentId: 'parent-template',
      variantId: 'template-en',
    });
    expect(preview.evidence.changedFields).to.deep.equal(['contentBody.rawHtml']);
    expect(preview.evidence.baselineHash).to.match(/^[a-f\d]{64}$/u);
    expect(preview.evidence.payloadHash).to.match(/^[a-f\d]{64}$/u);
    expect(preview.evidence.payloadHash).not.to.equal(preview.evidence.baselineHash);
    const previewEvents = JSON.parse(
      await readFile(file('email-template-update-preview-transport.json'), 'utf8'),
    );
    expect(previewEvents.some(({ method }: { method?: string }) => method === 'PUT')).to.equal(
      false,
    );

    expect(previewEvents[0]).to.deep.equal({ phase: 'org' });
    expect(
      previewEvents.slice(1).every(({ method }: { method?: string }) => method === 'GET'),
    ).to.equal(true);
    expect(await readdir(isolatedDataDirectory)).not.to.include(
      'email-template-update-preview-report',
    );
    const applied = await runUpdate('email-template-update-apply');
    expect(applied).to.deep.include({
      status: 'ownership-uncertain',
      contentId: 'parent-template',
      variantId: 'template-en',
    });
    expect(applied.payloadHash).to.equal(preview.evidence.payloadHash);
    const applyEvents = JSON.parse(
      await readFile(file('email-template-update-apply-transport.json'), 'utf8'),
    );
    const variantRequests = applyEvents.filter(({ url }: { url?: string }) =>
      url?.endsWith('/connect/cms/contents/variants/template-en'),
    );
    expect(variantRequests).to.have.length(2);
    expect(
      variantRequests.filter(({ method }: { method?: string }) => method === 'GET'),
    ).to.have.length(2);
    expect(applyEvents.some(({ method }: { method?: string }) => method === 'PUT')).to.equal(false);
    const report = JSON.parse(
      await readFile(file('email-template-update-apply-report/content-update-run.json'), 'utf8'),
    );
    expect(report).to.deep.include({
      contract: 'sf-cms-email-template-update-run',
      state: 'ownership-uncertain',
    });
  });

  it('runs installed editable export, literal edits, native CREATE and encoded readback for both types', async function () {
    // The baseline and import both execute internal services from the installed tarball.
    this.timeout(600_000);
    const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
    const exported = await execFileAsync(executable, [fileURLToPath(harness)], {
      cwd: isolatedDataDirectory,
      encoding: 'utf8',
      env: {
        ...process.env,
        SF_PLUGIN_CMS_CONTRACT_CASE: 'editable-export-fixture',
        SF_PLUGIN_CMS_INSTALLED_ROOT: installedPluginRoot,
        SF_PLUGIN_CMS_INSTALLED_VERSION: installedPackageVersion,
      },
      windowsHide: true,
    });
    const output = JSON.parse(exported.stdout);
    expect(Object.keys(output).toSorted()).to.deep.equal([
      'destination',
      'manifest',
      'manifestSha256',
    ]);
    expect(output.manifest.completeness).to.equal('complete');
    expect(output.manifest.provenance.pluginVersion).to.equal(installedPackageVersion);
    const fixtureEvents = JSON.parse(
      await readFile(file('editable-export-fixture-transport.json'), 'utf8'),
    ) as Array<{ method: string; url: string }>;
    expect(fixtureEvents.length).to.be.greaterThan(0);
    expect(fixtureEvents.every(({ method }) => method === 'GET')).to.equal(true);
    expect(fixtureEvents.filter(({ url }) => url.includes('/contents/variants/'))).to.deep.equal([
      { method: 'GET', url: '/connect/cms/contents/variants/email' },
      { method: 'GET', url: '/connect/cms/contents/variants/template' },
    ]);
    expect(await readdir(file('editable-baseline'))).to.deep.equal(['items', 'manifest.json']);
    const preserved = new Map<string, Buffer>();
    for (const name of [
      'editable-baseline/manifest.json',
      'editable-source/editable.json',
      ...['email', 'template'].flatMap((id) => [
        `editable-baseline/items/${id}.json`,
        `editable-source/items/${id}.json`,
      ]),
    ]) {
      preserved.set(name, await readFile(file(name)));
    }
    expect(hash(preserved.get('editable-baseline/manifest.json')!)).to.equal(output.manifestSha256);
    const edits = {
      email: '<p>Edited Grüße</p>\r\n',
      template: '&lt;p&gt;literal text&lt;/p&gt;',
    };
    for (const [id, html] of Object.entries(edits)) {
      expect(await readFile(file(`editable-source/items/${id}.html`), 'utf8')).to.equal(
        '<p>Original Café</p>',
      );
      await writeFile(file(`editable-source/items/${id}.html`), html);
    }
    await writeFile(
      file('editable-copies.json'),
      JSON.stringify(
        ['email', 'template'].map((id) => ({
          sourceContentKey: `source-${id}`,
          language: 'en',
          apiName: `fresh_${id}`,
          urlName: `fresh-${id}`,
        })),
      ),
    );
    const runImport = async (apply: boolean, local = false): Promise<ProcessResult> => {
      try {
        const result = await execFileAsync(executable, [fileURLToPath(harness)], {
          cwd: isolatedDataDirectory,
          encoding: 'utf8',
          env: {
            ...process.env,
            SF_PLUGIN_CMS_CONTRACT_CASE: local ? 'editable-local' : 'editable-import',
            SF_PLUGIN_CMS_INSTALLED_ROOT: installedPluginRoot,
            SF_PLUGIN_CMS_INSTALLED_VERSION: installedPackageVersion,
            SF_PLUGIN_CMS_EDITABLE_IMPORT_OPTIONS: JSON.stringify({ apply }),
          },
          windowsHide: true,
        });
        return { exitCode: 0, stderr: result.stderr, stdout: result.stdout };
      } catch (error) {
        const failed = error as Error & { code: number; stderr: string; stdout: string };
        return { exitCode: failed.code, stderr: failed.stderr, stdout: failed.stdout };
      }
    };
    const dryRun = await runImport(false);
    expect(dryRun.exitCode, dryRun.stdout + dryRun.stderr).to.equal(0);
    const dryResult = JSON.parse(dryRun.stdout);
    expect(dryResult.dryRun).to.equal(true);
    expect(JSON.stringify(dryResult.diagnostics)).to.include(
      '2 selected HTML modification(s) planned',
    );
    const dryEvents = JSON.parse(await readFile(file('editable-import-transport.json'), 'utf8'));
    expect(dryEvents.map((event: { method?: string }) => event.method)).to.deep.equal([
      undefined,
      'GET',
    ]);
    const applied = await runImport(true);
    expect(applied.exitCode, applied.stdout + applied.stderr).to.equal(0);
    const execution = JSON.parse(applied.stdout);
    expect(execution.dryRun).to.equal(false);
    expect(execution.report.state).to.equal('completed');
    expect(JSON.stringify(execution.diagnostics)).to.include(
      '2 selected HTML modification(s) applied',
    );
    const events = JSON.parse(await readFile(file('editable-import-transport.json'), 'utf8'));
    expect(events.map((event: { method?: string }) => event.method)).to.deep.equal([
      undefined,
      'GET',
      'POST',
      'GET',
      'POST',
      'GET',
    ]);
    for (const [index, id] of ['email', 'template'].entries()) {
      const post = events[2 + index * 2];
      expect(post.body).not.to.have.any.keys('contentKey', 'id', 'externalId', 'externalSource');
      expect(post.body).to.include({
        apiName: `fresh_${id}`,
        urlName: `fresh-${id}`,
        contentType: id === 'email' ? 'sfdc_cms__email' : 'sfdc_cms__emailTemplate',
      });
      expect(post.body.contentBody).to.deep.equal({
        'sfdc_cms:title': `${id} body title`,
        subjectLine: 'Keep subject',
        messagePurpose: 'promotional',
        rawHtml: edits[id as keyof typeof edits],
        textContent: 'Keep text',
        ...(id === 'email' ? { 'sfdc_cms:urlName': `fresh-${id}` } : {}),
      });
      const report = post.initialReport;
      expect(report.sourceManifestSha256).to.equal(output.manifestSha256);
      expect(report.editableSource.entries).to.have.length(2);
      const evidence = report.editableSource.entries[index];
      expect(evidence).to.include({
        variantId: id,
        changed: true,
        originalHtmlSha256: hash('<p>Original Café</p>'),
        currentHtmlSha256: hash(edits[id as keyof typeof edits]),
      });
      const operation = report.operations[index];
      expect(operation.state).to.equal('pending');
      expect(operation.requestSha256).to.equal(
        hash(`create-parent\u0000source-${id}\u0000en\u0000${JSON.stringify(post.body)}`),
      );
      expect(events[3 + index * 2].readback.contentKey).to.equal(`created-${index + 1}`);
    }
    const report = JSON.parse(
      await readFile(file('editable-report/workspace-import-run.json'), 'utf8'),
    );
    expect(report.state).to.equal('completed');
    for (const [name, bytes] of preserved) expect(await readFile(file(name))).to.deep.equal(bytes);

    // Installed local failures must never reach even org acquisition, much less transport.
    // Missing CLI profile flags belong to the command-only suite, not this engine seam.
    const localCases: Array<{ file: string; bytes: string; message: RegExp }> = [
      { file: 'editable-source/items/email.json', bytes: '{}', message: /metadata/iu },
      { file: 'editable-source/editable.json', bytes: '{}', message: /descriptor/iu },
      {
        file: 'editable-baseline/items/template.json',
        bytes: '{}',
        message: /hash|integrity|SHA-256/iu,
      },
    ];
    for (const scenario of localCases) {
      const before = scenario.file === undefined ? undefined : await readFile(file(scenario.file));
      try {
        if (scenario.file !== undefined) await writeFile(file(scenario.file), scenario.bytes!);
        const failed = await runImport(false, true);
        expect(failed.exitCode, failed.stdout + failed.stderr).to.equal(1);
        expect(failed.stdout + failed.stderr).to.match(scenario.message);
        expect(await readdir(isolatedDataDirectory)).not.to.include(
          'editable-local-transport.json',
        );
      } finally {
        if (scenario.file !== undefined) await writeFile(file(scenario.file), before!);
      }
    }
  });

  it('runs the installed flat definition export engine with canonical admission evidence', async function () {
    this.timeout(300_000);
    const exported = await execFileAsync(executable, [fileURLToPath(harness)], {
      cwd: isolatedDataDirectory,
      encoding: 'utf8',
      env: {
        ...process.env,
        SF_PLUGIN_CMS_CONTRACT_CASE: 'definition-export-fixture',
        SF_PLUGIN_CMS_INSTALLED_ROOT: installedPluginRoot,
        SF_PLUGIN_CMS_INSTALLED_VERSION: installedPackageVersion,
      },
      windowsHide: true,
    });
    const output = JSON.parse(exported.stdout);
    expect(output.manifest.provenance.pluginVersion).to.equal(installedPackageVersion);
    expect(output).to.have.all.keys('destination', 'manifest', 'manifestSha256');
    expect(output.manifest.completeness).to.equal('complete');
    const evidencePath = 'evidence/source-admission.v1.json';
    const evidenceBytes = await readFile(file(`definition-base/${evidencePath}`));
    expect(
      output.manifest.items.find((item: { path: string }) => item.path === evidencePath),
    ).to.deep.equal({
      path: evidencePath,
      kind: 'cms.source-admission',
      sha256: createHash('sha256').update(evidenceBytes).digest('hex'),
    });
    const evidence = JSON.parse(evidenceBytes.toString('utf8'));
    expect(evidence.inventory.contentType).to.equal('sfdc_cms__email');
    expect(evidence.inventory.pages).to.have.length(1);
    expect(evidence.inventory.variants).to.have.length(1);
    expect(evidence.selections[0].rawItemPath).to.equal(output.manifest.entries[0].file);
    const family = file('definition-source/cms/Controlled/email');
    expect(await readdir(family)).to.deep.equal([
      'Welcome.cms-email.html',
      'Welcome.cms-email.json',
    ]);
    expect(await readFile(path.join(family, 'Welcome.cms-email.html'), 'utf8')).to.equal(
      '<p>Hello</p>',
    );
  });

  it('runs packed source B Email/Template JSON and HTML edits, dry-plan and journal-bound root CREATE', async function () {
    this.timeout(900_000);
    const hash = sourceAcceptanceHash;
    for (const family of ['email', 'emailTemplate']) {
      const prefix = `source-a-${family}`;
      const raw = {
        managedContentVariantId: 'email',
        managedContentId: 'parent',
        contentKey: 'key',
        apiName: 'Welcome',
        contentType: { fullyQualifiedName: `sfdc_cms__${family}` },
        contentSpace: { id: 'space' },
        language: 'en_US',
        folder: null,
        title: 'Welcome',
        urlName: 'welcome',
        contentBody: {
          'sfdc_cms:title': 'Welcome',
          ...(family === 'email' ? { 'sfdc_cms:urlName': 'welcome' } : {}),
          textContent: 'Original text',
          subjectLine: 'Hello',
          messagePurpose: 'Transactional',
          rawHtml: '&lt;p&gt;Original &amp;amp; café&lt;/p&gt;',
          'lightning:expressions': [],
          'sfdc_cms:variants': [],
        },
      };
      await writeFile(file('source-a-fixture.json'), JSON.stringify(raw));
      const exported = await execFileAsync(executable, [fileURLToPath(harness)], {
        cwd: isolatedDataDirectory,
        encoding: 'utf8',
        env: {
          ...process.env,
          SF_PLUGIN_CMS_CONTRACT_CASE: 'source-b-export-fixture',
          SF_PLUGIN_CMS_INSTALLED_ROOT: installedPluginRoot,
          SF_PLUGIN_CMS_INSTALLED_VERSION: installedPackageVersion,
        },
        windowsHide: true,
      });
      const output = JSON.parse(exported.stdout);
      expect(Object.keys(output).toSorted()).to.deep.equal([
        'destination',
        'manifest',
        'manifestSha256',
      ]);
      const fixtureEvents = JSON.parse(
        await readFile(file(`${prefix}-fixture-transport.json`), 'utf8'),
      ) as Array<{ method: string; url: string }>;
      expect(fixtureEvents.length).to.be.greaterThan(0);
      expect(fixtureEvents.every(({ method }) => method === 'GET')).to.equal(true);
      // Definition admission re-reads the variant to bind its source proof.
      expect(fixtureEvents.filter(({ url }) => url.includes('/contents/variants/'))).to.deep.equal([
        { method: 'GET', url: '/connect/cms/contents/variants/email' },
        { method: 'GET', url: '/connect/cms/contents/variants/email' },
      ]);
      expect(output.manifest.completeness).to.equal('complete');
      expect(output.manifest.provenance.pluginVersion).to.equal(installedPackageVersion);
      const token = family === 'email' ? 'email' : 'email-template';
      const definitionPath = `cms/Controlled/${family}/Welcome.cms-${token}.json`;
      const htmlPath = definitionPath.replace(/\.json$/u, '.html');
      const baselineFiles = [
        'manifest.json',
        ...output.manifest.items.map((item: { path: string }) => item.path),
      ];
      const preserved = new Map<string, Buffer>();
      for (const relative of baselineFiles)
        preserved.set(
          `${prefix}-base/${relative}`,
          await readFile(file(`${prefix}-base/${relative}`)),
        );
      const candidateFile = `${prefix}-definitions/${definitionPath}`;
      const originalDefinition = await readFile(file(candidateFile));
      const candidate = JSON.parse(originalDefinition.toString('utf8'));
      candidate.title = 'Edited Welcome';
      candidate.urlName = 'fresh';
      candidate.contentBody['sfdc_cms:title'] = 'Edited Welcome';
      candidate.contentBody.textContent = 'Edited text 世界';
      if (family === 'email') {
        candidate.contentBody.subjectLine = 'Edited subject';
        candidate.contentBody['sfdc_cms:urlName'] = 'fresh';
      }
      const candidateBytes = `${JSON.stringify(candidate, null, 2)}\n`;
      await writeFile(file(candidateFile), candidateBytes);
      expect(hash(preserved.get(`${prefix}-base/manifest.json`)!)).to.equal(output.manifestSha256);
      expect(await readFile(file(`${prefix}-definitions/${htmlPath}`), 'utf8')).to.equal(
        '<p>Original &amp; café</p>',
      );
      const literal = '<p>Edited &lt;literal&gt; 世界</p>\r\n';
      await writeFile(file(`${prefix}-definitions/${htmlPath}`), literal);
      await writeFile(
        file('source-a-copies.json'),
        JSON.stringify([
          { sourceContentKey: 'key', language: 'en_US', apiName: 'Fresh', urlName: 'fresh' },
        ]),
      );
      // eslint-disable-next-line unicorn/consistent-function-scoping -- Keep installed import execution with this per-family fixture and its mappings.
      async function runImport(
        scenario = 'source-a-import',
        reportDirectory?: string,
      ): Promise<ProcessResult> {
        try {
          const result = await execFileAsync(executable, [fileURLToPath(harness)], {
            cwd: isolatedDataDirectory,
            encoding: 'utf8',
            env: {
              ...process.env,
              SF_PLUGIN_CMS_CONTRACT_CASE: scenario,
              SF_PLUGIN_CMS_INSTALLED_ROOT: installedPluginRoot,
              SF_PLUGIN_CMS_INSTALLED_VERSION: installedPackageVersion,
              SF_PLUGIN_CMS_SOURCE_IMPORT_OPTIONS: JSON.stringify({
                prefix,
                apply: reportDirectory !== undefined,
                reportDirectory,
              }),
            },
            windowsHide: true,
          });
          return { exitCode: 0, stderr: result.stderr, stdout: result.stdout };
        } catch (error) {
          const failed = error as Error & { code: number; stderr: string; stdout: string };
          return { exitCode: failed.code, stderr: failed.stderr, stdout: failed.stdout };
        }
      }
      const dry = await runImport();
      expect(dry.exitCode, dry.stdout + dry.stderr).to.equal(0);
      expect(JSON.parse(dry.stdout).dryRun).to.equal(true);
      const dryEvents = JSON.parse(await readFile(file('source-a-import-transport.json'), 'utf8'));
      expect(
        dryEvents
          .filter((event: { method?: string }) => event.method !== undefined)
          .every((event: { method: string }) => event.method === 'GET'),
      ).to.equal(true);
      const applied = await runImport('source-a-import', 'source-a-report');
      expect(applied.exitCode, applied.stdout + applied.stderr).to.equal(0);
      const execution = JSON.parse(applied.stdout);
      expect(execution.dryRun).to.equal(false);
      expect(execution.report.state).to.equal('completed');
      const events = JSON.parse(await readFile(file('source-a-import-transport.json'), 'utf8'));
      const posts = events.filter((event: { method?: string }) => event.method === 'POST');
      expect(posts).to.have.length(1);
      const post = posts[0];
      expect(post.body).to.include({
        contentSpaceOrFolderId: 'distinct-root',
        contentType: `sfdc_cms__${family}`,
        apiName: 'Fresh',
        urlName: 'fresh',
      });
      expect(post.body).not.to.have.any.keys('contentKey', 'id', 'externalId', 'externalSource');
      expect(post.body.title).to.equal(candidate.title);
      expect(post.body.contentBody).to.deep.equal({ ...candidate.contentBody, rawHtml: literal });
      expect(post.initialReport.operations).to.have.length(1);
      expect(post.initialReport.operations[0].state).to.equal('pending');
      expect(post.initialReport.operations[0].requestSha256).to.equal(
        hash(`create-parent\u0000key\u0000en_US\u0000${JSON.stringify(post.body)}`),
      );
      expect(post.initialReport.sourceManifestSha256).to.equal(output.manifestSha256);
      expect(post.initialReport.sourceDestination.rootFolderId).to.equal('distinct-root');
      expect(post.initialReport.sourceDefinitions.originals[0].raw).to.deep.equal(raw);
      expect(post.initialReport.sourceDefinitions.edits.entries[0]).to.include({
        changed: true,
        literalHtml: literal,
        originalDefinitionSha256: hash(originalDefinition),
        currentDefinitionSha256: hash(candidateBytes),
        originalHtmlSha256: hash('<p>Original &amp; café</p>'),
        currentHtmlSha256: hash(literal),
      });
      expect(
        events.filter((event: { url?: string }) => event.url === '/connect/cms/spaces/space'),
      ).to.have.length(2);
      expect(events.at(-1).readback.contentBody.rawHtml).to.include('&amp;lt;literal&amp;gt;');
      const report = JSON.parse(
        await readFile(file('source-a-report/workspace-import-run.json'), 'utf8'),
      );
      expect(report.state).to.equal('completed');
      expect(report.sourceDefinitions).to.deep.equal(post.initialReport.sourceDefinitions);
      expect(report.operations[0].requestSha256).to.equal(
        post.initialReport.operations[0].requestSha256,
      );
      expect(
        post.initialReport.sourceDefinitions.edits.entries[0].candidateDefinition,
      ).to.deep.equal(candidate);
      expect(await readFile(file(candidateFile), 'utf8')).to.equal(candidateBytes);
      for (const [relative, bytes] of preserved)
        expect(await readFile(file(relative))).to.deep.equal(bytes);
      // Keep successful journals rather than overwrite them between family runs.
      await rename(file('source-a-report'), file(`${prefix}-report`));
      if (family !== 'email') continue;
      const editsPath = `${prefix}-definitions/${htmlPath}`;
      const invalid = [
        {
          relative: candidateFile,
          bytes: '{}',
          message: /reprojection/iu,
        },
        {
          relative: candidateFile,
          bytes: JSON.stringify({
            ...candidate,
            identity: { ...candidate.identity, apiName: 'Hijacked' },
          }),
          message: /reprojection/iu,
        },
        {
          relative: candidateFile,
          bytes: JSON.stringify({
            ...candidate,
            contentBody: { ...candidate.contentBody, 'lightning:expressions': [{}] },
          }),
          message: /reprojection|Unsupported/iu,
        },
        {
          relative: candidateFile,
          bytes: JSON.stringify({
            ...candidate,
            urlName: 'conflict',
            contentBody: { ...candidate.contentBody, 'sfdc_cms:urlName': 'conflict' },
          }),
          message: /explicit native-copy target URL/iu,
        },
        { relative: editsPath, bytes: '<p>{{user}}</p>', message: /Unsupported/iu },
        {
          relative: `${prefix}-base/evidence/source-admission.v1.json`,
          bytes: '{}',
          message: /SHA-256/iu,
        },
      ];
      for (const scenario of invalid) {
        const before = await readFile(file(scenario.relative));
        try {
          await writeFile(file(scenario.relative), scenario.bytes);
          const blocked = await runImport('source-a-import', 'source-a-invalid-report');
          expect(blocked.exitCode, blocked.stdout + blocked.stderr).to.equal(1);
          expect(blocked.stdout + blocked.stderr).to.match(scenario.message);
          const rejectedEvents = JSON.parse(
            await readFile(file('source-a-import-transport.json'), 'utf8'),
          );
          expect(
            rejectedEvents.some((event: { method?: string }) => event.method === 'POST'),
          ).to.equal(false);
          expect(await readdir(isolatedDataDirectory)).not.to.include('source-a-invalid-report');
        } finally {
          await writeFile(file(scenario.relative), before);
        }
      }
      for (const scenario of ['title-collision', 'url-collision', 'json-drift']) {
        const reportDirectory = `source-a-${scenario}-report`;
        try {
          const blocked = await runImport(`source-a-${scenario}`, reportDirectory);
          expect(blocked.exitCode, blocked.stdout + blocked.stderr).to.equal(1);
          expect(blocked.stdout + blocked.stderr, blocked.stdout + blocked.stderr).to.match(
            scenario === 'json-drift' ? /changed after planning/iu : /collision/iu,
          );
          const events = JSON.parse(
            await readFile(file(`source-a-${scenario}-transport.json`), 'utf8'),
          );
          expect(events.some((event: { method?: string }) => event.method === 'POST')).to.equal(
            false,
          );
          if (scenario === 'json-drift') {
            const journal = JSON.parse(
              await readFile(file(`${reportDirectory}/workspace-import-run.json`), 'utf8'),
            );
            expect(journal.state).to.equal('failed');
            expect(journal.createdParents).to.have.length(0);
            expect(journal.sourceDefinitions.edits.entries[0].currentDefinitionSha256).to.equal(
              hash(candidateBytes),
            );
          }
        } finally {
          await writeFile(file(candidateFile), candidateBytes);
        }
      }
      const manifestPath = `${prefix}-base/manifest.json`;
      const manifestBytes = await readFile(file(manifestPath));
      const evidencePath = `${prefix}-base/evidence/source-admission.v1.json`;
      try {
        await writeFile(
          file(manifestPath),
          JSON.stringify({
            ...output.manifest,
            items: output.manifest.items.filter(
              (item: { kind: string }) => item.kind !== 'cms.source-admission',
            ),
          }),
        );
        await rename(file(evidencePath), file('source-a-saved-evidence.json'));
        const old = await runImport();
        expect(old.exitCode, old.stdout + old.stderr).to.equal(1);
        expect(old.stdout + old.stderr).to.match(/re-export.*--definition-dir/iu);
        expect(
          JSON.parse(await readFile(file('source-a-import-transport.json'), 'utf8')).some(
            (event: { method?: string }) => event.method === 'POST',
          ),
        ).to.equal(false);
      } finally {
        await writeFile(file(manifestPath), manifestBytes);
        await rename(file('source-a-saved-evidence.json'), file(evidencePath));
      }
      const drift = await runImport('source-a-drift', 'source-a-drift-report');
      expect(drift.exitCode, drift.stdout + drift.stderr).to.equal(1);
      expect(drift.stdout + drift.stderr, drift.stdout + drift.stderr).to.match(
        /changed after planning/iu,
      );
      expect(
        JSON.parse(await readFile(file('source-a-drift-transport.json'), 'utf8')).some(
          (event: { method?: string }) => event.method === 'POST',
        ),
      ).to.equal(false);
      const driftReport = JSON.parse(
        await readFile(file('source-a-drift-report/workspace-import-run.json'), 'utf8'),
      );
      expect(driftReport.state).to.equal('failed');
      expect(driftReport.createdParents).to.have.length(0);
      await writeFile(file(editsPath), literal);
    }
  });

  it('runs installed packed typed Brand SOURCE proof, independent authentication and final CREATE gate', async function () {
    this.timeout(900_000);
    const raw = {
      ...brandDetail('9Psaj00000IF7YHCA1', 'Phase_5_Discovery_Brand', '0Zuaj000007dgL8CAI'),
      managedContentId: '20Yaj00000EpKvtEAF',
      apiName: 'Phase_5_Discovery_Brand',
      contentSpace: {
        id: '0Zuaj000007dgL8CAI',
        resourceUrl: '/connect/cms/spaces/0Zuaj000007dgL8CAI',
      },
      contentBody: brandDetail().contentBody as Record<string, unknown>,
      folder: null,
    };
    await writeFile(file('brand-source-fixture.json'), JSON.stringify(raw));
    await writeFile(
      file('brand-source-copy-map.json'),
      JSON.stringify([
        {
          source: { family: 'cms', type: 'brand', apiName: raw.apiName },
          target: { apiName: 'Fresh_Brand', title: 'Fresh Brand', urlName: 'fresh-brand' },
        },
      ]),
    );
    const exported = await execFileAsync(executable, [fileURLToPath(harness)], {
      cwd: isolatedDataDirectory,
      encoding: 'utf8',
      env: {
        ...process.env,
        SF_PLUGIN_CMS_CONTRACT_CASE: 'brand-source-fixture',
        SF_PLUGIN_CMS_INSTALLED_ROOT: installedPluginRoot,
        SF_PLUGIN_CMS_INSTALLED_VERSION: installedPackageVersion,
      },
      windowsHide: true,
    });
    const output = JSON.parse(exported.stdout);
    expect(Object.keys(output).toSorted()).to.deep.equal([
      'destination',
      'manifest',
      'manifestSha256',
      'phase5Report',
    ]);
    const fixtureEvents = JSON.parse(
      await readFile(file('brand-source-fixture-transport.json'), 'utf8'),
    ) as Array<{ method?: string; alias: string }>;
    expect(fixtureEvents.length).to.be.greaterThan(1);
    expect(fixtureEvents.every(({ alias }) => alias === 'brand-source-alias')).to.equal(true);
    expect(
      fixtureEvents
        .filter(({ method }) => method !== undefined)
        .every(({ method }) => method === 'GET'),
    ).to.equal(true);
    expect(output.manifest.completeness).to.equal('complete');
    expect(output.manifest.warnings.map(({ code }: { code: string }) => code)).to.deep.equal([
      'UNSUPPORTED_WILDCARD',
    ]);
    expect(output.manifest.provenance).to.include({
      sourceOrgId: '00Daj00000bRQabEAG',
      pluginVersion: installedPackageVersion,
    });
    const proofItem = output.manifest.items.find(
      ({ kind }: { kind: string }) => kind === 'cms.brand-source-inventory',
    );
    const proofBytes = await readFile(file(`brand-source-base/${proofItem.path}`));
    const proof = JSON.parse(proofBytes.toString('utf8'));
    expect(sourceAcceptanceHash(proofBytes)).to.equal(proofItem.sha256);
    expect(proof.source).to.include({ orgId: '00Daj00000bRQabEAG', apiVersion: '67.0' });
    expect(proof.workspace).to.include({
      name: 'Content Workspace for Marketing Cloud',
      apiName: 'Default_Content_Workspace',
    });
    expect(
      proof.selections[0].inventory.pages.map(
        ({ response }: { response: { records: unknown[] } }) => response.records.length,
      ),
    ).to.deep.equal([1, 0]);
    expect(proof.selections[0].inventory.recheck.pages).to.deep.equal(
      proof.selections[0].inventory.pages,
    );
    const definitionFile =
      'brand-source-definitions/cms/Default_Content_Workspace/brand/Phase_5_Discovery_Brand.cms-brand.json';
    const definitionBytes = await readFile(file(definitionFile));
    expect(JSON.parse(definitionBytes.toString('utf8')).contentBody).to.deep.equal(raw.contentBody);
    const preserved = new Map<string, Buffer>();
    for (const relative of [
      'manifest.json',
      ...output.manifest.items.map(({ path: itemPath }: { path: string }) => itemPath),
    ])
      preserved.set(relative, await readFile(file(`brand-source-base/${relative}`)));
    const eventsFor = async (scenario: string) =>
      JSON.parse(await readFile(file(`${scenario}-transport.json`), 'utf8'));

    async function runBrandImport(
      scenario: string,
      reportDirectory?: string,
      generic = false,
    ): Promise<ProcessResult> {
      try {
        const result = await execFileAsync(executable, [fileURLToPath(harness)], {
          cwd: isolatedDataDirectory,
          encoding: 'utf8',
          env: {
            ...process.env,
            SF_PLUGIN_CMS_CONTRACT_CASE: scenario,
            SF_PLUGIN_CMS_INSTALLED_ROOT: installedPluginRoot,
            SF_PLUGIN_CMS_INSTALLED_VERSION: installedPackageVersion,
            SF_PLUGIN_CMS_BRAND_IMPORT_OPTIONS: JSON.stringify({
              apply: reportDirectory !== undefined,
              reportDirectory,
              generic,
            }),
          },
          windowsHide: true,
        });
        return { exitCode: 0, stderr: result.stderr, stdout: result.stdout };
      } catch (error) {
        const failed = error as Error & { code: number; stderr: string; stdout: string };
        return { exitCode: failed.code, stderr: failed.stderr, stdout: failed.stdout };
      }
    }
    const dry = await runBrandImport('brand-source-preview');
    expect(dry.exitCode, dry.stdout + dry.stderr).to.equal(0);
    expect(JSON.parse(dry.stdout).dryRun).to.equal(true);
    const previewEvents = await eventsFor('brand-source-preview');
    expect(
      previewEvents
        .filter(({ phase }: { phase?: string }) => phase === 'org')
        .map(({ alias }: { alias: string }) => alias),
    ).to.deep.equal(['brand-target-alias', 'brand-source-alias']);
    expect(
      previewEvents
        .filter(({ method }: { method?: string }) => method !== undefined)
        .every(({ method }: { method: string }) => method === 'GET'),
    ).to.equal(true);
    const applied = await runBrandImport('brand-source-apply', 'brand-source-apply-report');
    expect(applied.exitCode, applied.stdout + applied.stderr).to.equal(0);
    const execution = JSON.parse(applied.stdout);
    expect(execution.dryRun).to.equal(false);
    expect(execution.report.state).to.equal('completed');
    const events = await eventsFor('brand-source-apply');
    const posts = events.filter(({ method }: { method?: string }) => method === 'POST');
    expect(posts).to.have.length(1);
    const post = posts[0];
    expect(post.alias).to.equal('brand-target-alias');
    expect(post.body).to.deep.equal({
      apiName: 'Fresh_Brand',
      title: 'Fresh Brand',
      urlName: 'fresh-brand',
      contentSpaceOrFolderId: '9Pufj000006rx4wCAA',
      contentType: 'sfdc_cms__brand',
      contentBody: { ...raw.contentBody, 'sfdc_cms:title': 'Fresh Brand' },
    });
    expect(post.initialReport.operations[0].state).to.equal('pending');
    expect(post.initialReport.operations[0].requestSha256).to.equal(
      sourceAcceptanceHash(
        `create-parent\u0000content-key\u0000en_US\u0000${JSON.stringify(post.body)}`,
      ),
    );
    expect(post.initialReport.sourceManifestSha256).to.equal(output.manifestSha256);
    expect(post.initialReport.destinationOrgId).to.equal('00Dfj00000bRQabEAG');
    expect(post.initialReport.sourceDestination.rootFolderId).to.equal('9Pufj000006rx4wCAA');
    expect(post.initialReport.sourceDefinitions.edits.entries[0]).to.include({
      changed: false,
      originalDefinitionSha256: sourceAcceptanceHash(definitionBytes),
      currentDefinitionSha256: sourceAcceptanceHash(definitionBytes),
    });
    expect(post.initialReport.brandSource).to.include({
      sourceOrgId: '00Daj00000bRQabEAG',
      sourceWorkspaceId: raw.contentSpace.id,
      sourceApiVersion: '67.0',
      historicalArtifactSha256: proofItem.sha256,
      sourceManifestSha256: output.manifestSha256,
    });
    const refreshedProof = structuredClone(proof);
    refreshedProof.source.acquiredAt = post.initialReport.brandSource.acquiredAt;
    const canonicalProof = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map((item) => canonicalProof(item));
      if (value === null || typeof value !== 'object') return value;
      const record = value as Record<string, unknown>;
      return Object.fromEntries(
        Object.keys(record)
          .toSorted()
          .map((key) => [key, canonicalProof(record[key])]),
      );
    };
    expect(post.initialReport.brandSource.refreshedArtifactSha256).to.equal(
      sourceAcceptanceHash(`${JSON.stringify(canonicalProof(refreshedProof), null, 2)}\n`),
    );
    const sourceQueries = events.filter(({ query }: { query?: string }) => query !== undefined);
    expect(sourceQueries).to.have.length(12);
    expect(
      sourceQueries.every(
        ({ alias, options }: { alias: string; options: { retry: { maxRetries: number } } }) =>
          alias === 'brand-source-alias' && options.retry.maxRetries === 0,
      ),
    ).to.equal(true);
    expect(
      events.slice(events.indexOf(post) + 1).map(({ url }: { url: string }) => url),
    ).to.deep.equal([
      '/connect/cms/contents/fresh-brand-key',
      '/connect/cms/contents/variants/fresh-brand-variant',
    ]);
    for (const event of events.filter(
      ({ readback }: { readback?: unknown }) => readback !== undefined,
    )) {
      expect(event.readback.folder.id).to.equal(post.body.contentSpaceOrFolderId);
      expect(event.readback.contentBody).to.deep.equal(post.body.contentBody);
    }
    const report = JSON.parse(
      await readFile(file('brand-source-apply-report/workspace-import-run.json'), 'utf8'),
    );
    expect(report.state).to.equal('completed');
    expect(report.brandSource).to.deep.equal(post.initialReport.brandSource);
    expect(report.operations[0].requestSha256).to.equal(
      post.initialReport.operations[0].requestSha256,
    );
    for (const scenario of [
      'wrong-org',
      'body-drift',
      'sibling-drift',
      'file-drift',
      'journal-drift',
    ]) {
      try {
        const name = `brand-source-${scenario}`;
        const blocked = await runBrandImport(name, `${name}-report`);
        expect(blocked.exitCode, blocked.stdout + blocked.stderr).to.equal(1);
        expect(blocked.stderr).not.to.equal('');
        const blockedEvents = await eventsFor(name);
        expect(blockedEvents.some(({ method }: { method?: string }) => method === 'POST')).to.equal(
          false,
        );
      } finally {
        await writeFile(file(definitionFile), definitionBytes);
      }
    }
    try {
      const edited = JSON.parse(definitionBytes.toString('utf8'));
      edited.contentBody.baseFontFamily = 'Not immutable';
      await writeFile(file(definitionFile), JSON.stringify(edited));
      const immutable = await runBrandImport('brand-source-immutable');
      expect(immutable.exitCode, immutable.stdout + immutable.stderr).to.equal(1);
      expect(immutable.stdout + immutable.stderr).to.match(/Brand|reprojection/iu);
      const immutableEvents = await eventsFor('brand-source-immutable');
      expect(immutableEvents.some(({ method }: { method?: string }) => method === 'POST')).to.equal(
        false,
      );
    } finally {
      await writeFile(file(definitionFile), definitionBytes);
    }
    const manifestFile = file('brand-source-base/manifest.json');
    try {
      await writeFile(
        manifestFile,
        JSON.stringify({
          ...output.manifest,
          items: output.manifest.items.filter(
            ({ kind }: { kind: string }) => kind !== 'cms.brand-source-inventory',
          ),
        }),
      );
      await rename(
        file(`brand-source-base/${proofItem.path}`),
        file('brand-source-saved-proof.json'),
      );
      const missing = await runBrandImport('brand-source-missing-proof');
      expect(missing.exitCode, missing.stdout + missing.stderr).to.equal(1);
      expect(missing.stdout + missing.stderr).to.match(
        /inventory evidence unavailable.*re-export/iu,
      );
      expect(await readdir(isolatedDataDirectory)).not.to.include(
        'brand-source-missing-proof-transport.json',
      );
    } finally {
      await writeFile(manifestFile, preserved.get('manifest.json')!);
      await rename(
        file('brand-source-saved-proof.json'),
        file(`brand-source-base/${proofItem.path}`),
      );
    }
    // The generic Brand profile still rejects warning-bearing exports; SOURCE is not a global waiver.
    const generic = await runBrandImport('brand-source-local', undefined, true);
    expect(generic.exitCode, generic.stdout + generic.stderr).to.equal(1);
    expect(generic.stdout + generic.stderr).to.match(/no warnings/iu);
    expect(await readdir(isolatedDataDirectory)).not.to.include(
      'brand-source-local-transport.json',
    );
    expect(await readFile(file(definitionFile))).to.deep.equal(definitionBytes);
    for (const [relative, bytes] of preserved)
      expect(await readFile(file(`brand-source-base/${relative}`))).to.deep.equal(bytes);
  });

  it('keeps packed internal Brand export provenance and definition layout honest', async function () {
    this.timeout(300_000);
    const brand = {
      ...brandDetail('email', 'Welcome', 'space'),
      managedContentId: 'parent',
      folder: null,
    };
    await writeFile(file('source-a-fixture.json'), JSON.stringify(brand));
    const exported = await execFileAsync(executable, [fileURLToPath(harness)], {
      cwd: isolatedDataDirectory,
      encoding: 'utf8',
      env: {
        ...process.env,
        SF_PLUGIN_CMS_CONTRACT_CASE: 'brand-export-fixture',
        SF_PLUGIN_CMS_INSTALLED_ROOT: installedPluginRoot,
        SF_PLUGIN_CMS_INSTALLED_VERSION: installedPackageVersion,
      },
      windowsHide: true,
    });
    const output = JSON.parse(exported.stdout);
    expect(Object.keys(output).toSorted()).to.deep.equal([
      'destination',
      'manifest',
      'manifestSha256',
    ]);
    expect(output.manifest.completeness).to.equal('complete');
    expect(output.manifest.provenance).to.include({
      sourceOrgId: '00DControlledSource',
      pluginVersion: installedPackageVersion,
    });
    const fixtureEvents = JSON.parse(
      await readFile(file('source-a-brand-fixture-transport.json'), 'utf8'),
    ) as Array<{ method: string; url: string }>;
    expect(fixtureEvents.length).to.be.greaterThan(0);
    expect(fixtureEvents.every(({ method }) => method === 'GET')).to.equal(true);
    expect(
      fixtureEvents.some(({ url }) => url === '/connect/cms/contents/variants/email'),
    ).to.equal(true);
    expect(await readdir(file('source-a-brand-definitions/cms/Controlled/brand'))).to.deep.equal([
      'Welcome.cms-brand.json',
    ]);
  });

  it('emits the exact blocked info envelope and exits 1', async () => {
    const result = await runSf(['cms', 'info', '--contract-version', '3', '--json']);
    const envelope = parseEnvelope(result);

    expect(result.exitCode).to.equal(1);
    expect(envelope).to.deep.include({ contract: 'sf-cms-info', status: 'blocked', result: null });
  });
});
