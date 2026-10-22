import { Parser } from '@oclif/core';
import { Org } from '@salesforce/core';
import { expect } from 'chai';
import sinon from 'sinon';
import { mkdtemp, writeFile, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import UploadImages from '../../src/commands/cms/upload.js';
import { assertImageUploadCommandResult } from '../../src/contracts/image-upload.js';

const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);
const workspace = { id: 'space', rootFolderId: 'root', isEnhancedSpace: true };

function command(files: string[], extra: Record<string, unknown> = {}) {
  const instance = Object.create(UploadImages.prototype) as UploadImages;
  const events: Array<Record<string, unknown>> = [];
  const request = sinon.stub().callsFake(async (input: Record<string, unknown>) => {
    events.push(input);
    const url = String(input.url);
    if (url.includes('/items/search')) return { items: [], count: 0 };
    if (url === '/connect/cms/spaces/space') return workspace;
    throw new Error('unsafe response Bearer SECRET');
  });
  const getOrgContext = sinon.stub().resolves({ orgId: '00DControlled', connection: { request } });
  const log = sinon.stub();
  Object.assign(instance, {
    parse: sinon.stub().resolves({
      flags: {
        'target-org': { getUsername: () => 'unused' },
        'api-version': '67.0',
        'contract-version': 1,
        'workspace-id': 'space',
        file: files,
        preview: false,
        report: false,
        ...extra,
      },
    }),
    getOrgContext,
    jsonEnabled: sinon.stub().returns(true),
    log,
  });
  return { instance, events, request, getOrgContext, log };
}

describe('cms upload command', () => {
  let directory: string;
  beforeEach(async () => {
    sinon.stub(Org, 'create').resolves({ getUsername: () => 'unused' } as Org);
    directory = await mkdtemp(path.join(tmpdir(), 'cms-upload-command-'));
    process.exitCode = undefined;
  });
  afterEach(() => {
    sinon.restore();
    process.exitCode = undefined;
  });
  async function image(name = 'Banner with spaces.PNG'): Promise<string> {
    const file = path.join(directory, name);
    await writeFile(file, png);
    return file;
  }

  for (const count of [1, 2, 5, 10, 13]) {
    it(`parses ${count} repeatable file flags in order without greedy positional input`, async () => {
      const files = Array.from({ length: count }, (_, index) => `./Image ${index}.png`);
      const parsed = await Parser.parse(
        [
          '--target-org',
          'unused',
          '--workspace-id',
          'space',
          ...files.flatMap((file) => ['--file', file]),
        ],
        { flags: UploadImages.flags },
      );
      expect(parsed.flags.file).to.deep.equal(files);
      expect(parsed.flags.preview).to.equal(false);
      expect(parsed.flags.report).to.equal(false);
      expect(parsed.flags).not.to.have.property('execute');
    });
  }

  it('previews ordered names and sizes with zero mutations, no bytes, and distinct root', async () => {
    const files = [await image(), await image('Logo.jpg')];
    await writeFile(files[1], Buffer.from([255, 216, 255, 0]));
    const subject = command(files, { preview: true });
    (subject.instance as unknown as { jsonEnabled: sinon.SinonStub }).jsonEnabled.returns(false);
    const result = await subject.instance.run();
    expect(result.status).to.equal('success');
    expect(result.contractVersion).to.equal('1.0.0');
    expect(result.result).to.deep.include({
      mode: 'preview',
      outcome: 'ready',
      target: { workspaceId: 'space', rootFolderId: 'root', isEnhancedSpace: true },
    });
    expect(result.result!.intents.map(({ filename }) => filename)).to.deep.equal([
      'Banner with spaces.PNG',
      'Logo.jpg',
    ]);
    expect(result.result!.intents[0]).to.include({
      title: 'Banner with spaces.PNG',
      apiName: 'banner_with_spaces_png',
      urlName: 'banner-with-spaces-png',
      size: 9,
    });
    expect(JSON.stringify(result)).not.to.include('bytes');
    expect(Object.isFrozen(result.result!.intents)).to.equal(true);
    expect(Object.isFrozen(result.result!.intents[0])).to.equal(true);
    expect(subject.events.every(({ method }) => method === 'GET')).to.equal(true);
    expect(subject.log.args.flat().join('\n')).to.include('ready to create');
    expect(subject.log.args.flat().join('\n')).not.to.include('Destination root folder:');
    assertImageUploadCommandResult(result.result);
  });

  for (const scenario of [
    'preview-report',
    'preview-report-dir',
    'missing-file',
    'no-selector',
    'both-selectors',
  ]) {
    it(`blocks ${scenario} before org acquisition`, async () => {
      const files = [
        scenario === 'missing-file' ? path.join(directory, 'missing.png') : await image(),
      ];
      const extras: Record<string, Record<string, unknown>> = {
        'preview-report': { preview: true, report: true },
        'preview-report-dir': { preview: true, 'report-dir': path.join(directory, 'forbidden') },
        'no-selector': { 'workspace-id': undefined },
        'both-selectors': { 'workspace-name': 'other' },
      };
      const extra = extras[scenario] ?? {};
      const subject = command(files, extra);
      const result = await subject.instance.run();
      expect(result.status).to.equal('blocked');
      expect(subject.getOrgContext.notCalled).to.equal(true);
      expect(subject.events).to.have.length(0);
    });
  }

  it('retains the ownership-uncertain durable report after exactly one failed multipart POST', async () => {
    const subject = command([await image()], {
      'report-dir': path.join(directory, 'report'),
    });
    const result = await subject.instance.run();
    expect(result.status).to.equal('failed');
    expect(result.result!.outcome).to.equal('ownership-uncertain');
    expect(result.diagnostics.errors[0].retryable).to.equal(false);
    expect(JSON.stringify(result)).not.to.include('SECRET');
    expect(subject.events.filter(({ method }) => method === 'POST')).to.have.length(1);
    const report = JSON.parse(await readFile(result.result!.reportFile!, 'utf8'));
    expect(report.state).to.equal('ownership-uncertain');
    expect(report.operations[0].state).to.equal('pending');
    expect(report.operations[0].input.contentSpaceOrFolderId).to.equal('root');
    expect(report.operations[0].file).not.to.have.property('bytes');
  });

  it('returns completed no-report evidence after independent parent and variant readbacks', async () => {
    const subject = command([await image('Logo.png')]);
    const binding = {
      managedContentId: 'parent',
      managedContentVariantId: 'variant',
      contentKey: 'key',
    };
    const detail = {
      ...binding,
      contentSpace: { id: 'space' },
      folder: { id: 'root' },
      contentType: { fullyQualifiedName: 'sfdc_cms__image' },
      status: { status: 'Draft' },
      isPublished: false,
      title: 'Logo.png',
      apiName: 'logo_png',
      urlName: 'logo-png',
    };
    subject.request.callsFake(async (input: Record<string, unknown>) => {
      subject.events.push(input);
      if (input.method === 'POST') return binding;
      const url = String(input.url);
      if (url.includes('/items/search')) return { items: [], count: 0 };
      if (url === '/connect/cms/spaces/space') return workspace;
      if (url.endsWith('/parent') || url.endsWith('/variant')) return detail;
      throw new Error(`Unexpected read ${url}`);
    });
    const envelope = await subject.instance.run();
    expect(envelope.status).to.equal('success');
    expect(envelope.result!.outcome).to.equal('completed');
    expect(envelope.result!.reportFile).to.equal(null);
    expect(envelope.result!.report!.operations[0].binding).to.deep.equal(binding);
    expect(envelope.result!.report!.operations[0].state).to.equal('succeeded');
    expect(subject.events.filter(({ method }) => method === 'POST')).to.have.length(1);
    expect(
      subject.events.filter(
        ({ url }) => String(url).endsWith('/parent') || String(url).endsWith('/variant'),
      ),
    ).to.have.length(2);
    expect(await readdir(directory)).to.deep.equal(['Logo.png']);
  });

  it('keeps known response identities in JSON and technical logs, not human failures', async () => {
    const subject = command([await image()]);
    const technical = sinon.spy();
    Object.assign(subject.instance, { invocationLogger: { log: technical } });
    (subject.instance as unknown as { jsonEnabled: sinon.SinonStub }).jsonEnabled.returns(false);
    subject.request.callsFake(async (input: Record<string, unknown>) => {
      subject.events.push(input);
      if (input.method === 'POST') return { managedContentId: 'known-parent' };
      if (String(input.url).includes('/items/search')) return { items: [], count: 0 };
      return workspace;
    });
    const envelope = await subject.instance.run();
    expect(envelope.result!.outcome).to.equal('ownership-uncertain');
    expect(envelope.result!.report!.operations[0].binding).to.deep.equal({
      managedContentId: 'known-parent',
    });
    expect(subject.log.args.flat().join('\n')).not.to.include('known-parent');
    expect(subject.log.args.flat().join('\n')).to.include('ownership-uncertain');
    const outcome = technical.args.find((args) => args[1] === 'mutation item outcome')!;
    expect(outcome[2].target.contentId).to.equal('known-parent');
    expect(envelope.result!.reportFile).to.equal(null);
  });

  for (const json of [false, true])
    it(`logs live upload outcomes without technical terminal dumps JSON=${String(json)}`, async () => {
      const subject = command([await image(), await image('Second.png')]);
      (subject.instance as unknown as { jsonEnabled: sinon.SinonStub }).jsonEnabled.returns(json);
      const technical = sinon.spy();
      Object.assign(subject.instance, { invocationLogger: { log: technical } });
      const envelope = await subject.instance.run();
      const outcomes = technical.args
        .filter((args) => args[1] === 'mutation item outcome')
        .map((args) => args[2]);
      expect(outcomes.map(({ state }) => state)).to.deep.equal([
        'ownership-uncertain',
        'unattempted',
      ]);
      expect(envelope.result!.report!.operations.map(({ state }) => state)).to.deep.equal([
        'pending',
        'planned',
      ]);
      expect(JSON.stringify(outcomes)).not.to.include('SECRET');
      if (json) expect(subject.log.notCalled).to.equal(true);
      else {
        expect(subject.log.args.flat().join('\n')).to.include('upload: Second.png — unattempted');
        expect(subject.log.args.flat().join('\n')).not.to.match(
          /identities=|Destination root folder|SECRET/,
        );
      }
    });

  it('executes without report allocation by default and retains uncertain operation evidence', async () => {
    const subject = command([await image(), await image('Second.png')]);
    const result = await subject.instance.run();
    expect(result.result!.mode).to.equal('execute');
    expect(result.result!.outcome).to.equal('ownership-uncertain');
    expect(result.result!.reportFile).to.equal(null);
    expect(result.result!.report!.operations.map(({ state }) => state)).to.deep.equal([
      'pending',
      'planned',
    ]);
    expect(subject.events.filter(({ method }) => method === 'POST')).to.have.length(1);
    expect(await readdir(directory)).to.have.members(['Banner with spaces.PNG', 'Second.png']);
    expect(JSON.stringify(result)).not.to.include('SECRET');
    expect(JSON.stringify(result)).not.to.include('bytes');
  });

  for (const options of [{ report: true }, { report: true, custom: true }, { custom: true }]) {
    it(`allocates enabled reports using deploy conventions ${JSON.stringify(options)}`, async () => {
      const cwd = sinon.stub(process, 'cwd').returns(directory);
      try {
        const custom = path.join(directory, 'custom');
        const subject = command([await image()], {
          report: options.report ?? false,
          ...(options.custom ? { 'report-dir': custom } : {}),
        });
        const envelope = await subject.instance.run();
        const reportFile = envelope.result!.reportFile!;
        expect(path.dirname(reportFile)).to.match(
          options.custom ? /custom$/u : /logs[\\/]cms[\\/]reports[\\/].+$/u,
        );
        expect(JSON.parse(await readFile(reportFile, 'utf8')).state).to.equal(
          'ownership-uncertain',
        );
        expect(subject.events.filter(({ method }) => method === 'POST')).to.have.length(1);
      } finally {
        cwd.restore();
      }
    });
  }

  it('returns a structured failed result for auth failures without unsafe error text', async () => {
    const subject = command([await image()]);
    subject.getOrgContext.rejects(new Error('arbitrary unsafe response SECRET'));
    const result = await subject.instance.run();
    expect(result.status).to.equal('failed');
    expect(result.result!.outcome).to.equal('failed');
    expect(result.result!.reportFile).to.equal(null);
    expect(JSON.stringify(result)).not.to.include('SECRET');
  });

  it('rejects unknown flags, JSON input maps, missing files, and both selectors at the parser boundary', async () => {
    for (const args of [
      ['--unknown'],
      ['--file', 'one.png', '--apply'],
      ['--file', 'one.png', '--contract-version', '1'],
      ['--image-map', 'input.json'],
      ['--file', 'one.png', '--workspace-name', 'Other'],
      [],
      ['--file', 'one.png', 'two.png'],
    ]) {
      let error: unknown;
      try {
        await Parser.parse(['--target-org', 'unused', '--workspace-id', 'space', ...args], {
          flags: UploadImages.flags,
        });
      } catch (error_) {
        error = error_;
      }
      expect(error).to.be.instanceOf(Error);
    }
  });

  it('blocks an existing apply report directory before org access', async () => {
    const subject = command([await image()], { 'report-dir': directory });
    const result = await subject.instance.run();
    expect(result.diagnostics.errors[0].code).to.equal('IMAGE_UPLOAD_LOCAL_VALIDATION_FAILED');
    expect(subject.getOrgContext.notCalled).to.equal(true);
  });

  it('rejects array and object enum values without coercion or report-invariant bypasses', () => {
    const valid = {
      mode: 'execute',
      outcome: 'completed',
      target: { workspaceId: 'space', rootFolderId: 'root', isEnhancedSpace: true },
      intents: [
        {
          action: 'create',
          filename: 'banner.png',
          title: 'banner.png',
          apiName: 'banner_png',
          urlName: 'banner-png',
          mediaType: 'image/png',
          size: png.length,
          sha256: 'a'.repeat(64),
        },
      ],
      byteProof: 'unavailable',
      reportFile: 'run.json',
      report: { runId: 'run', root: {}, operations: [], state: 'completed' },
    };
    expect(() => assertImageUploadCommandResult(valid)).not.to.throw();
    for (const mode of ['preview', 'execute']) {
      const base =
        mode === 'preview' ? { ...valid, outcome: 'ready', reportFile: null, report: null } : valid;
      expect(() => assertImageUploadCommandResult({ ...base, mode })).not.to.throw();
      for (const invalid of [[mode], { toString: () => mode }]) {
        expect(() => assertImageUploadCommandResult({ ...base, mode: invalid })).to.throw(
          TypeError,
        );
      }
    }
    for (const outcome of ['ready', 'completed', 'blocked', 'failed', 'ownership-uncertain']) {
      expect(() =>
        assertImageUploadCommandResult({
          ...valid,
          outcome,
          report: {
            ...valid.report,
            state: outcome === 'ownership-uncertain' ? outcome : 'completed',
          },
        }),
      ).not.to.throw();
      for (const invalid of [[outcome], { toString: () => outcome }]) {
        expect(() => assertImageUploadCommandResult({ ...valid, outcome: invalid })).to.throw(
          TypeError,
        );
        if (outcome === 'completed' || outcome === 'ownership-uncertain') {
          expect(() =>
            assertImageUploadCommandResult({ ...valid, outcome: invalid, reportFile: null }),
          ).to.throw(TypeError);
        }
      }
      if (outcome === 'completed' || outcome === 'ownership-uncertain') {
        expect(() =>
          assertImageUploadCommandResult({
            ...valid,
            outcome,
            reportFile: null,
            report: { ...valid.report, state: outcome },
          }),
        ).not.to.throw();
      }
    }
  });

  it('strictly rejects bytes and mismatched preview/apply result contracts', () => {
    const valid = {
      mode: 'preview',
      outcome: 'blocked',
      target: null,
      intents: [],
      byteProof: 'unavailable',
      reportFile: null,
      report: null,
    };
    expect(() => assertImageUploadCommandResult(valid)).not.to.throw();
    expect(() => assertImageUploadCommandResult({ ...valid, bytes: [] })).to.throw();
    expect(() => assertImageUploadCommandResult({ ...valid, outcome: 'completed' })).to.throw();
    expect(() => assertImageUploadCommandResult({ ...valid, reportFile: 'run.json' })).to.throw();
  });
});
