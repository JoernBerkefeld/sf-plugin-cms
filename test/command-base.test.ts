import fs from 'node:fs';
import path from 'node:path';
import { Config, Parser } from '@oclif/core';
import { ConfigAggregator, Org, SfProject } from '@salesforce/core';
import { SfCommand, Ux } from '@salesforce/sf-plugins-core';
import { ux } from '@oclif/core';
import Info from '../src/commands/cms/info.js';
import UploadImages from '../src/commands/cms/upload/images.js';
import {
  createRunOwnedDirectory,
  createRunOwnedTemp,
  removeRunOwnedPath,
  type RunOwnedTemp,
} from '../src/filesystem/runOwnedTemp.js';
import { expect } from 'chai';
import sinon from 'sinon';
import { CmsCommand, apiVersionFlag } from '../src/command-base.js';
import { getCmsApiSelection } from '../src/api-policy.js';

import { requestJson, getSelectedOperation } from '../src/transport/json-request.js';

class Command extends CmsCommand<void> {
  public async run(): Promise<void> {}
  public context(version: string) {
    return this.getOrgContext('target', version);
  }
}

class LifecycleCommand extends CmsCommand<{ ok: boolean }> {
  public static id = 'cms:fixture';
  public static aliases = ['content:fixture'];
  public stage = 'success';
  public async init(): Promise<void> {
    if (this.stage === 'init') throw new Error('init sentinel');
  }
  public async run(): Promise<{ ok: boolean }> {
    if (this.stage === 'parse') await this.parse({ flags: {} }, ['--unknown']);
    if (this.stage === 'run') throw new Error('run sentinel');
    if (this.stage === 'api') {
      await this.parse(LifecycleCommand);
      await requestJson(
        { request: sinon.stub().resolves({ body: 'API fixture customer body' }) },
        getSelectedOperation('workspace.list'),
      );
    }
    if (this.stage === 'table') this.table({ data: [{ id: 'workspace', name: 'Fixture' }] });
    if (this.stage === 'styled') this.styledJSON({ name: 'Fixture', password: 'disk-secret' });
    this.log('hello %s', 'world');
    this.warn('final warning');
    return { ok: true };
  }
}

const command = (json: boolean): LifecycleCommand =>
  new LifecycleCommand(json ? ['--json'] : [], {
    getPluginsList: () => [],
    scopedEnvVar: () => {},
    scopedEnvVarKey: (key: string) => `CMS_TEST_${key}`,
  } as unknown as Config);

describe('CMS invocation lifecycle logging (bounded L2a)', () => {
  let run: RunOwnedTemp;
  let cwd: string;
  let previousExit: typeof process.exitCode;
  let previousArgv: string[];
  let stdout: sinon.SinonStub;
  let stderr: sinon.SinonStub;
  let signals: Map<string, NodeJS.SignalsListener[]>;
  beforeEach(async () => {
    run = await createRunOwnedTemp('cms-command-logging');
    cwd = await createRunOwnedDirectory(run, 'fixture');
    previousExit = process.exitCode;
    previousArgv = process.argv;
    signals = new Map(
      ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP'].map((signal) => [
        signal,
        process.listeners(signal) as NodeJS.SignalsListener[],
      ]),
    );
    sinon.stub(process, 'cwd').returns(cwd);
    stdout = sinon.stub(process.stdout, 'write').returns(true);
    stderr = sinon.stub(process.stderr, 'write').returns(true);
    sinon.stub(ConfigAggregator, 'create').resolves({} as ConfigAggregator);
  });
  afterEach(async () => {
    for (const [signal, existing] of signals) {
      for (const listener of process.listeners(signal)) {
        if (!existing.includes(listener as NodeJS.SignalsListener)) process.off(signal, listener);
      }
    }
    process.argv = previousArgv;
    process.exitCode = previousExit;
    sinon.restore();
    await removeRunOwnedPath(run, cwd);
  });
  const output = (stream: sinon.SinonStub): string =>
    stream
      .getCalls()
      .map((call) => String(call.args[0]))
      .join('');
  const records = (): Array<{
    message: string;
    details: {
      channel?: string;
      text?: string;
      argv?: string[];
      stack?: string;
      columns?: unknown;
      rows?: unknown;
    };
  }> => {
    const directory = path.join(cwd, 'logs', 'cms');
    return fs.readdirSync(directory).flatMap((file) =>
      fs
        .readFileSync(path.join(directory, file), 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line)),
    );
  };
  it('binds API verbosity from parsed flags only for that invocation', async () => {
    for (const enabled of [true, false]) {
      const config = command(false).config;
      config.runHook = sinon.stub().resolves({ successes: [], failures: [] });
      const instance = new LifecycleCommand(enabled ? ['--api', 'log'] : [], config);
      instance.stage = 'api';
      await instance._run();
    }
    const responses = records().filter((record) => record.message === 'CMS JSON response');
    expect(responses).to.have.length(2);
    expect(JSON.stringify(responses[0])).to.include('API fixture customer body');
    expect(JSON.stringify(responses[1])).not.to.include('API fixture customer body');
  });

  for (const json of [false, true]) {
    for (const stage of ['setup', 'project', 'init', 'parse', 'run', 'success']) {
      it(`flushes ${stage} in ${json ? 'JSON' : 'human'} mode exactly once`, async () => {
        const instance = command(json);
        instance.stage = stage;
        if (stage === 'setup') {
          (ConfigAggregator.create as sinon.SinonStub).rejects(new Error('setup sentinel'));
        }
        if (stage === 'project') {
          sinon.stub(LifecycleCommand, 'requiresProject').value(true);
          sinon.stub(SfProject, 'resolve').rejects(new Error('project sentinel'));
        }
        const catcher = sinon.spy(SfCommand.prototype as never, 'catch');
        const finalizer = sinon.spy(SfCommand.prototype as never, 'finally');
        let failure: unknown;
        try {
          await instance._run();
        } catch (error) {
          failure = error;
        }
        const entries = records();
        expect(entries[0].message).to.match(/^sf-plugin-cms /u);
        expect(entries[1].message).to.equal('invocation');
        expect(finalizer.callCount).to.equal(1);
        expect(catcher.callCount).to.equal(stage === 'success' ? 0 : 1);
        expect(output(stderr).match(/CMS log: /gu)).to.have.length(1);
        if (stage === 'success') {
          expect(failure).to.equal(undefined);
          if (json) expect(JSON.parse(output(stdout))).to.deep.equal({ ok: true });
          else expect(output(stdout)).to.equal('hello world\n');
          const terminals = entries.filter((entry) => entry.message === 'terminal');
          expect(
            terminals
              .filter((entry) => entry.details.channel === 'stdout')
              .map((entry) => entry.details.text)
              .join(''),
          ).to.equal(output(stdout));
        } else {
          expect(failure).to.have.property('skipOclifErrorHandling', true);
          expect(process.exitCode).to.be.greaterThan(0);
          expect(entries.filter((entry) => entry.message === 'command failure')).to.have.length(1);
          expect(
            entries.find((entry) => entry.message === 'command failure')?.details.stack,
          ).to.be.a('string');
          if (json) expect(JSON.parse(output(stdout))).to.have.property('status');
        }
      });
    }
  }

  for (const stage of ['table', 'styled']) {
    for (const json of [false, true]) {
      it(`mirrors ${stage} once without changing ${json ? 'JSON' : 'human'} bytes`, async () => {
        const instance = command(json);
        instance.stage = stage;
        const table = sinon.spy(Ux.prototype, 'table');
        const inkOnly = sinon.spy(Ux.prototype, 'makeTable');
        const styled = sinon.spy(ux, 'colorizeJson');
        await instance._run();
        expect(table.callCount).to.equal(!json && stage === 'table' ? 1 : 0);
        expect(inkOnly.called).to.equal(false);
        expect(styled.callCount).to.equal(json || stage === 'styled' ? 1 : 0);
        const entries = records();
        const terminal = (channel: string): string =>
          entries
            .filter((entry) => entry.message === 'terminal' && entry.details.channel === channel)
            .map((entry) => entry.details.text)
            .join('');
        expect(terminal('stderr')).to.equal(output(stderr));
        if (stage === 'styled' && !json) {
          expect(output(stdout)).to.include('disk-secret');
          expect(JSON.stringify(entries)).not.to.include('disk-secret');
          expect(terminal('stdout')).to.include('Fixture');
        } else if (stage !== 'table' || json) {
          expect(terminal('stdout')).to.equal(output(stdout));
        }
        if (json) expect(JSON.parse(output(stdout))).to.deep.equal({ ok: true });
        if (!json && stage === 'table') {
          expect(output(stdout)).to.include('Fixture').and.include('hello world');
          expect(terminal('stdout')).to.equal('hello world\n');
          expect(
            entries.find((entry) => entry.message === 'terminal table')?.details,
          ).to.deep.include({
            channel: 'stdout',
            columns: ['id', 'name'],
            rows: [{ id: 'workspace', name: 'Fixture' }],
          });
        }
      });
    }
  }

  for (const environment of [{ CI: 'true' }, { OCLIF_TABLE_LIMIT: '1' }]) {
    it(`preserves native table output and complete redacted rows with ${JSON.stringify(environment)}`, async () => {
      sinon.stub(process, 'env').value({ ...process.env, ...environment });
      const options = {
        title: 'Complete table',
        columns: [{ key: 'name', name: 'Full name' }, 'password'],
        data: [
          { name: 'a'.repeat(300), password: 'table-secret' },
          { name: 'Second row', password: 'second-secret' },
        ],
      };
      new Ux().table(options);
      const native = output(stdout);
      stdout.resetHistory();
      const instance = command(false);
      sinon.stub(instance, 'run').callsFake(async () => {
        instance.table(options);
        return { ok: true };
      });
      await instance._run();
      expect(output(stdout)).to.equal(native);
      const table = records().find((entry) => entry.message === 'terminal table');
      expect(table?.details).to.deep.include({
        title: options.title,
        columns: options.columns,
        rows: [
          { name: 'a'.repeat(300), password: '[REDACTED]' },
          { name: 'Second row', password: '[REDACTED]' },
        ],
      });
      expect(JSON.stringify(records()))
        .not.to.include('table-secret')
        .and.not.to.include('second-secret');
    });
  }

  it('keeps a confirmed success when the final durable flush fails', async () => {
    sinon.stub(fs, 'fsyncSync').throws(new Error('flush sentinel password=disk-secret'));
    const result = await command(true)._run();
    expect(result).to.deep.equal({ ok: true });
    expect(JSON.parse(output(stdout))).to.deep.equal({ ok: true });
    expect(output(stderr)).to.include('CMS logging incomplete').and.include('flush sentinel');
    expect(output(stderr)).not.to.include('disk-secret');
    expect(records().filter((entry) => entry.message === 'command outcome')).to.have.length(1);
  });

  it('captures deferred framework warnings before closing', async () => {
    const original = SfCommand.prototype as unknown as { finally: () => Promise<void> };
    sinon.stub(original, 'finally').callsFake(async function (this: LifecycleCommand) {
      this.warn('deferred warning');
      throw new Error('finalizer sentinel');
    });
    await command(false)._run();
    const entries = records();
    expect(output(stderr)).to.include('deferred warning').and.include('finalizer sentinel');
    expect(
      entries.findIndex((entry) => entry.message === 'warning finalization incomplete'),
    ).to.be.lessThan(entries.findIndex((entry) => entry.message === 'command completed'));
    expect(entries.at(-1)?.details.text).to.include('CMS log:');
  });

  it('records offline blocked normal-return reasons with no fabricated exception', async () => {
    const instance = new Info(
      ['--json', '--api', 'log', '--contract-version', '2'],
      command(true).config,
    );
    sinon.stub(instance, 'init').resolves();
    sinon
      .stub(instance as unknown as { pluginVersion: string }, 'pluginVersion')
      .get(() => '0.18.0');
    sinon
      .stub(instance as unknown as { pluginVersion: string }, 'pluginVersion')
      .get(() => '0.18.0');
    sinon
      .stub(instance, 'parse')
      .resolves({ flags: { 'contract-version': 2, api: 'log' } } as never);
    await instance._run();
    const entries = records();
    const diagnostic = entries.find((entry) => entry.message === 'command diagnostics');
    expect(diagnostic?.details).to.have.property(
      'orgContext',
      'not entered; no CMS org HTTP or mutation dispatched',
    );
    expect(JSON.stringify(diagnostic)).to.include('UNSUPPORTED_CONTRACT_VERSION');
    expect(entries.some((entry) => entry.message === 'command failure')).to.equal(false);
    expect(JSON.parse(output(stdout))).to.have.property('status', 'blocked');
  });

  it('logs the originating upload validation reason without extending the public result', async () => {
    const instance = new UploadImages(['--json'], command(true).config);
    sinon.stub(instance, 'init').resolves();
    sinon
      .stub(instance as unknown as { pluginVersion: string }, 'pluginVersion')
      .get(() => '0.18.0');
    sinon.stub(instance, 'parse').resolves({
      flags: {
        'target-org': { getUsername: () => 'target' },
        'contract-version': 1,
        'api-version': 'latest',
        'workspace-id': 'workspace',
        file: ['.unsafe.png'],
        apply: false,
      },
    } as never);
    // A filename with a leading dot is rejected before filesystem/org access.
    const context = sinon.stub(Org, 'create');
    const result = await instance._run();
    expect(result).to.have.property('status', 'blocked');
    const entries = records();
    const failure = entries.find(
      (entry) => entry.message === 'image upload local validation failed',
    );
    expect(failure?.details).to.have.property('message', 'Unsafe or unsupported image filename');
    expect(failure?.details.stack).to.be.a('string');
    expect(context.called).to.equal(false);
    const visible = output(stdout);
    expect(JSON.parse(visible)).to.deep.equal(result);
    expect(visible).not.to.include('Unsafe or unsupported image filename');
    expect(JSON.parse(visible).diagnostics.errors[0].code).to.equal(
      'IMAGE_UPLOAD_LOCAL_VALIDATION_FAILED',
    );
    expect(entries.some((entry) => entry.message === 'command failure')).to.equal(false);
  });

  it('retains the received alias tokens and isolates repeated instances', async () => {
    process.argv = ['node', 'sf', 'content', 'fixture', '--json'];
    await command(true)._run();
    await command(false)._run();
    const entries = records().filter((entry) => entry.message === 'invocation');
    expect(entries).to.have.length(2);
    expect(entries.map((entry) => entry.details.argv)).to.deep.include([
      'content',
      'fixture',
      '--json',
    ]);
    expect(entries.map((entry) => entry.details.argv)).to.deep.include([]);
  });

  it('does not rerender when the inherited JSON renderer fails', async () => {
    const instance = command(true);
    instance.stage = 'run';
    sinon.stub(instance, 'logJson').throws(new Error('renderer sentinel'));
    let failure: unknown;
    try {
      await instance._run();
    } catch (error) {
      failure = error;
    }
    expect(failure).to.have.property('message', 'run sentinel');
    expect(failure).to.have.property('skipOclifErrorHandling', true);
    expect(output(stderr)).to.include('error rendering incomplete');
    expect(output(stdout)).to.equal('');
  });
});

describe('CMS command API selection', () => {
  afterEach(() => sinon.restore());

  it('inherits the API opt-in and existing global flags across all nine command classes', async () => {
    const ids = [
      'info',
      'list/workspace',
      'list/channel',
      'retrieve/content',
      'deploy/content',
      'upload/images',
      'publish/content',
      'unpublish/content',
      'delete/content',
    ];
    for (const id of ids) {
      const { default: ctor } = (await import(`../src/commands/cms/${id}.js`)) as {
        default: typeof Info;
      };
      expect(ctor.baseFlags).to.equal(CmsCommand.baseFlags);
      expect(ctor.baseFlags).to.have.property('flags-dir');
      expect(ctor.aliases).to.have.length(1);
      const parsed = await Parser.parse(['--api', 'log'], { flags: ctor.baseFlags });
      expect(parsed.flags.api).to.equal('log');
      const absent = await Parser.parse([], { flags: ctor.baseFlags });
      expect(absent.flags.api).to.equal(undefined);
      let failure: unknown;
      try {
        await Parser.parse(['--api', 'cli'], { flags: ctor.baseFlags });
      } catch (error) {
        failure = error;
      }
      expect(failure).to.be.instanceOf(Error);
    }
  });

  it('accepts latest and explicit numeric API flags, but rejects malformed versions', async () => {
    for (const version of ['latest', '68.0']) {
      const parsed = await Parser.parse(['--api-version', version], {
        flags: { 'api-version': apiVersionFlag },
      });
      expect(parsed.flags['api-version']).to.equal(version);
    }
    let error: unknown;
    try {
      await Parser.parse(['--api-version', 'v68.0'], { flags: { 'api-version': apiVersionFlag } });
    } catch (error_) {
      error = error_;
    }
    expect(error).to.be.instanceOf(Error);
  });

  it('defaults to latest and bootstraps Core with a numeric version', async () => {
    expect(apiVersionFlag.default).to.equal('latest');
    const request = sinon.stub().resolves({});
    request.onFirstCall().resolves([{ version: '68.0' }]);
    const connection = {
      version: '67.0',
      getApiVersion() {
        return this.version;
      },
      setApiVersion(version: string) {
        this.version = version;
      },
      request,
    };
    const getConnection = sinon.stub().returns(connection);
    sinon.stub(Org, 'create').resolves({ getConnection, getOrgId: () => 'org' } as unknown as Org);
    const command = new Command([], {} as never);
    const context = await command.context('latest');
    expect(getConnection.calledOnceWithExactly('67.0')).to.equal(true);
    expect(context.orgId).to.equal('org');
    expect(getCmsApiSelection(context.connection).effectiveApiVersion).to.equal('68.0');
    expect(connection.version).to.equal('68.0');
  });
});
