import { Parser } from '@oclif/core';
import { Org } from '@salesforce/core';
import { expect } from 'chai';
import sinon from 'sinon';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import UploadImages from '../../src/commands/cms/upload/images.js';
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
        apply: false,
        ...extra,
      },
    }),
    getOrgContext,
    jsonEnabled: sinon.stub().returns(true),
    log,
  });
  return { instance, events, request, getOrgContext, log };
}

describe('cms upload images command', () => {
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
      expect(parsed.flags.apply).to.equal(false);
      expect(parsed.flags['contract-version']).to.equal(1);
    });
  }

  it('previews ordered names and sizes with zero mutations, no bytes, and distinct root', async () => {
    const files = [await image(), await image('Logo.jpg')];
    await writeFile(files[1], Buffer.from([255, 216, 255, 0]));
    const subject = command(files);
    (subject.instance as unknown as { jsonEnabled: sinon.SinonStub }).jsonEnabled.returns(false);
    const result = await subject.instance.run();
    expect(result.status).to.equal('success');
    expect(result.contractVersion).to.equal('1.0.0');
    expect(result.result).to.deep.include({
      mode: 'dry-run',
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
    expect(subject.log.args.flat().join('\n')).to.include('Destination root folder: root');
    assertImageUploadCommandResult(result.result);
  });

  for (const scenario of [
    'missing-report',
    'missing-file',
    'no-selector',
    'both-selectors',
    'unsupported-version',
  ]) {
    it(`blocks ${scenario} before org acquisition`, async () => {
      const files = [
        scenario === 'missing-file' ? path.join(directory, 'missing.png') : await image(),
      ];
      const extras: Record<string, Record<string, unknown>> = {
        'missing-report': { apply: true },
        'no-selector': { 'workspace-id': undefined },
        'both-selectors': { 'workspace-name': 'other' },
        'unsupported-version': { 'contract-version': 2 },
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
      apply: true,
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
    const subject = command([await image()], { apply: true, 'report-dir': directory });
    const result = await subject.instance.run();
    expect(result.diagnostics.errors[0].code).to.equal('REPORT_DIRECTORY_EXISTS');
    expect(subject.getOrgContext.notCalled).to.equal(true);
  });

  it('rejects array and object enum values without coercion or report-invariant bypasses', () => {
    const valid = {
      mode: 'apply',
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
    };
    expect(() => assertImageUploadCommandResult(valid)).not.to.throw();
    for (const mode of ['dry-run', 'apply']) {
      const base = mode === 'dry-run' ? { ...valid, outcome: 'ready', reportFile: null } : valid;
      expect(() => assertImageUploadCommandResult({ ...base, mode })).not.to.throw();
      for (const invalid of [[mode], { toString: () => mode }]) {
        expect(() => assertImageUploadCommandResult({ ...base, mode: invalid })).to.throw(
          TypeError,
        );
      }
    }
    for (const outcome of ['ready', 'completed', 'blocked', 'failed', 'ownership-uncertain']) {
      expect(() => assertImageUploadCommandResult({ ...valid, outcome })).not.to.throw();
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
          assertImageUploadCommandResult({ ...valid, outcome, reportFile: null }),
        ).to.throw(TypeError);
      }
    }
  });

  it('strictly rejects bytes and mismatched preview/apply result contracts', () => {
    const valid = {
      mode: 'dry-run',
      outcome: 'blocked',
      target: null,
      intents: [],
      byteProof: 'unavailable',
      reportFile: null,
    };
    expect(() => assertImageUploadCommandResult(valid)).not.to.throw();
    expect(() => assertImageUploadCommandResult({ ...valid, bytes: [] })).to.throw();
    expect(() => assertImageUploadCommandResult({ ...valid, outcome: 'completed' })).to.throw();
    expect(() => assertImageUploadCommandResult({ ...valid, reportFile: 'run.json' })).to.throw();
  });
});
