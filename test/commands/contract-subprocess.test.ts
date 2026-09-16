import { execFile, spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
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

const file = (relative: string) => path.join(isolatedDataDirectory, relative);

type ProcessResult = {
  exitCode: number;
  stderr: string;
  stdout: string;
};

async function runSf(arguments_: string[], contractCase?: string): Promise<ProcessResult> {
  try {
    const pending = execFileAsync(executable, [...sfPrefix, ...arguments_], {
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
    const pending = execFileAsync(executable, [
      npmCli,
      'pack',
      '--json',
      '--pack-destination',
      temporaryPackDirectory,
    ]);
    const { stdout } = await pending;
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
  this.timeout(240_000);

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
    for (const delay of [0, 25, 50, 100]) {
      try {
        await rm(isolatedDataDirectory, { force: true, recursive: true });
        return;
      } catch (error) {
        const code =
          typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
        if (process.platform !== 'win32' || code !== 'ENOTEMPTY' || delay === 100) throw error;
        await new Promise((resolve) => {
          setTimeout(resolve, delay);
        });
      }
    }
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

  for (const completeness of ['complete', 'partial'] as const) {
    it(`executes a real single-workspace ${completeness} export with actual provenance`, async () => {
      const result = await runSf(
        [
          'cms',
          'export',
          'workspace',
          '--target-org',
          'unused',
          '--workspace-id',
          'space',
          '--output-dir',
          `single-${completeness}`,
          '--json',
        ],
        `single-${completeness}`,
      );
      const output = JSON.parse(result.stdout) as {
        destination: string;
        manifest: {
          completeness: string;
          provenance: { sourceOrgId: string };
          warnings: unknown[];
        };
        manifestSha256: string;
      };
      expect(result.exitCode).to.equal(completeness === 'partial' ? 2 : 0);
      expect(output.manifest.completeness).to.equal(completeness);
      expect(output.manifest.provenance.sourceOrgId).to.equal('00DControlledSource');
      expect(output.manifest.warnings).to.have.length(completeness === 'partial' ? 3 : 1);
      expect(output.manifestSha256).to.match(/^[a-f\d]{64}$/u);
      expect(
        JSON.parse(
          await readFile(
            path.join(isolatedDataDirectory, output.destination, 'manifest.json'),
            'utf8',
          ),
        ),
      ).to.deep.equal(output.manifest);
    });
  }

  it('runs installed editable export, literal edits, native CREATE and encoded readback for both types', async function () {
    // Ten sequential CLI starts take over four minutes on this Windows host.
    this.timeout(600_000);
    const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
    for (const command of ['export', 'import']) {
      const help = await runSf(['cms', command, 'workspace', '--help']);
      expect(help.exitCode, help.stderr).to.equal(0);
      const normalizedHelp = help.stdout.replaceAll(/\s+/gu, ' ');
      expect(normalizedHelp).to.include('--editable-dir');
      expect(normalizedHelp).to.include(
        'not resolved, rewritten, sanitized, or scanned through Phase 7',
      );
      if (command === 'export') {
        expect(normalizedHelp).to.include(
          '--output-dir ./cms-baseline --editable-dir ./cms-editable',
        );
        expect(normalizedHelp).to.match(/baseline is (?:published first and )?retained/iu);
      } else {
        expect(normalizedHelp).to.include('--native-copy-map');
        expect(normalizedHelp).to.include('complete server conflict validation');
        expect(normalizedHelp).to.include(
          '--native-copy-map ./native-copy-map.json --editable-dir ./cms-editable',
        );
      }
    }
    const exported = await runSf(
      [
        'cms',
        'export',
        'workspace',
        '--target-org',
        'unused',
        '--workspace-id',
        'space',
        '--output-dir',
        'editable-baseline',
        '--editable-dir',
        'editable-source',
        '--json',
      ],
      'editable-export',
    );
    expect(exported.exitCode, exported.stdout + exported.stderr).to.equal(0);
    const output = JSON.parse(exported.stdout);
    expect(Object.keys(output).toSorted()).to.deep.equal([
      'destination',
      'manifest',
      'manifestSha256',
    ]);
    expect(output.manifest.completeness).to.equal('complete');
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
    const arguments_ = [
      'cms',
      'import',
      'workspace',
      '--target-org',
      'unused',
      '--workspace-id',
      'space',
      '--source-dir',
      'editable-baseline',
      '--editable-dir',
      'editable-source',
      '--native-copy-map',
      'editable-copies.json',
      '--json',
    ];
    const dryRun = await runSf(arguments_, 'editable-import');
    expect(dryRun.exitCode, dryRun.stdout + dryRun.stderr).to.equal(0);
    const dryEnvelope = parseEnvelope(dryRun);
    expect(JSON.stringify(dryEnvelope.diagnostics)).to.include(
      '2 selected HTML modification(s) planned',
    );
    const dryEvents = JSON.parse(await readFile(file('editable-import-transport.json'), 'utf8'));
    expect(dryEvents.map((event: { method?: string }) => event.method)).to.deep.equal([
      undefined,
      'GET',
    ]);
    const applied = await runSf(
      [...arguments_, '--apply', '--report-dir', 'editable-report'],
      'editable-import',
    );
    expect(applied.exitCode, applied.stdout + applied.stderr).to.equal(0);
    const envelope = parseEnvelope(applied);
    expect(envelope.status).to.equal('success');
    expectPluginVersion(envelope, installedPackageVersion);
    expect(JSON.stringify(envelope.diagnostics)).to.include(
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
    const localCases: Array<{ args?: string[]; file?: string; bytes?: string; message: RegExp }> = [
      {
        args: arguments_.filter(
          (value) => !['--native-copy-map', 'editable-copies.json'].includes(value),
        ),
        message: /native-copy-map/u,
      },
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
        const failed = await runSf(scenario.args ?? arguments_, 'editable-local');
        expect(failed.exitCode, failed.stdout + failed.stderr).to.equal(
          scenario.args === undefined ? 1 : 2,
        );
        expect(failed.stdout + failed.stderr).to.match(scenario.message);
        expect(await readdir(isolatedDataDirectory)).not.to.include(
          'editable-local-transport.json',
        );
      } finally {
        if (scenario.file !== undefined) await writeFile(file(scenario.file), before!);
      }
    }
  });

  it('rejects installed editable export flag and overlap boundaries before org access', async () => {
    for (const extra of [
      [],
      ['--all', '--output-dir', 'new-base'],
      ['--output-dir', 'new-edit/inside'],
      ['--output-dir', '.'],
      ['--output-dir', '../escape'],
    ]) {
      const result = await runSf(
        [
          'cms',
          'export',
          'workspace',
          '--target-org',
          'unused',
          '--workspace-id',
          'space',
          '--editable-dir',
          'new-edit',
          ...extra,
          '--json',
        ],
        'editable-local',
      );
      expect(result.exitCode, result.stdout + result.stderr).to.equal(
        extra.length === 0 || extra.includes('--all') ? 2 : 10,
      );
      expect(result.stdout + result.stderr).not.to.include('Unexpected org access');
      expect(await readdir(isolatedDataDirectory)).not.to.include('editable-local-transport.json');
      expect(await readdir(isolatedDataDirectory)).not.to.include('new-edit');
      expect(await readdir(isolatedDataDirectory)).not.to.include('new-base');
    }
  });

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
