import { Connection as JsforceConnection } from '@jsforce/jsforce-node';
import { expect } from 'chai';
import sinon from 'sinon';
import { PassThrough } from 'node:stream';
import { Interface } from 'node:readline/promises';
import path from 'node:path';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createRunOwnedTemp } from '../../src/filesystem/runOwnedTemp.js';
import { Parser } from '@oclif/core';
import { Org } from '@salesforce/core';
import DeleteContent from '../../src/commands/cms/delete/content.js';
import { assertContentDeleteResult } from '../../src/contracts/content-delete.js';

const workspaceId = '0Zuaj000007dgL8CAI';
const parentId = '20Yaj00000FaO1aEAF';
const response = (value?: unknown) =>
  Object.assign(Promise.resolve(value), { stream: () => new PassThrough() });
function fixture(languages = ['en_US'], type = 'audio', workspace?: unknown) {
  const rows = languages.map((language, index) => ({
    Id: `9Psaj00000J5ox${String.fromCodePoint(74 + index)}CAR`,
    ManagedContentId: parentId,
    ContentTypeFullyQualifiedName: `sfdc_cms__${type}`,
    Language: language,
    VariantType: index === 0 ? 'Content' : 'Translation',
    IsPublished: true,
    ManagedContentVariantStatus: 'Published',
    IsPrimary: index === 0,
    Name: 'Existing',
    UrlName: null,
    ManagedContentKey: 'EXISTING',
    ManagedContent: { AuthoredManagedContentSpaceId: workspaceId, ApiName: 'Existing' },
  }));
  let page = 0;
  const requests: string[] = [];
  const connection = {
    version: '67.0',
    accessToken: 'token',
    instanceUrl: 'https://controlled.example',
    getApiVersion: () => '67.0',
    request: ({ url }: { url: string }) => {
      requests.push(url);
      if (url.endsWith(`/spaces/${workspaceId}`))
        return response(workspace ?? { id: workspaceId, apiName: 'Marketing' });
      if (url.includes('/query?')) {
        const query = decodeURIComponent(url);
        let records: unknown[];
        if (query.includes('COUNT(Id)'))
          records =
            rows.length > 0 ? [{ ManagedContentId: parentId, siblingCount: rows.length }] : [];
        else records = page++ % 2 === 0 ? rows : [];
        return response({
          done: true,
          totalSize: records.length,
          records: structuredClone(records),
        });
      }
      if (url.endsWith(`/${parentId}`))
        return response({
          managedContentId: parentId,
          contentSpace: { id: workspaceId },
          contentType: { fullyQualifiedName: `sfdc_cms__${type}` },
        });
      const row = rows.find(({ Id }) => url.endsWith(`/${Id}`));
      if (!row)
        return Promise.reject(
          Object.assign(new Error('Variant absent'), {
            response: { status: 404 },
            data: [{ errorCode: 'VARIANT_NOT_FOUND', message: 'Absent' }],
          }),
        );
      return response({
        managedContentId: parentId,
        managedContentVariantId: row.Id,
        contentType: { fullyQualifiedName: row.ContentTypeFullyQualifiedName },
        contentSpace: { id: workspaceId },
        language: row.Language,
        apiName: 'Existing',
        isPublished: row.IsPublished,
        status: { status: row.ManagedContentVariantStatus },
      });
    },
  };
  const deletes = sinon.stub(JsforceConnection.prototype, 'request').callsFake(((request: {
    url: string;
  }) => {
    const index = rows.findIndex(({ Id }) => request.url.endsWith(`/${Id}`));
    rows.splice(index, 1);
    return response();
  }) as never);
  return { connection, requests, deletes };
}
function subject(overrides: Record<string, unknown> = {}, connection?: unknown) {
  const command = Object.create(DeleteContent.prototype) as DeleteContent;
  const getOrgContext = sinon.stub().resolves({ connection, orgId: '00DControlled' });
  Object.assign(command, {
    parse: sinon.stub().resolves({
      flags: {
        'target-org': { getUsername: () => 'org' },
        'api-version': '67.0',
        'workspace-id': workspaceId,
        metadata: ['audio:Existing'],
        preview: false,
        report: false,
        ...overrides,
      },
    }),
    getOrgContext,
    jsonEnabled: () => true,
    log: sinon.stub(),
  });
  return { command, getOrgContext };
}

describe('cms delete exact-item CLI', () => {
  afterEach(() => {
    sinon.restore();
    process.exitCode = undefined;
  });
  for (const metadata of [
    undefined,
    [],
    ['audio'],
    ['audio:*'],
    ['audio:A?'],
    ['audio:[A]'],
    ['audio:'],
    ['video:Existing'],
  ]) {
    for (const preview of [true, false])
      it(`rejects ${JSON.stringify(metadata)} before org access preview=${preview}`, async () => {
        const f = subject({ metadata, preview });
        const result = await f.command.run();
        expect(result.status).to.equal('blocked');
        expect(f.getOrgContext.notCalled).to.equal(true);
      });
  }
  for (const override of [{ report: true }, { 'report-dir': 'anything' }])
    it('rejects reporting in preview before org access', async () => {
      const f = subject({ preview: true, ...override });
      const output = await f.command.run();
      expect(output.status).to.equal('blocked');
      expect(f.getOrgContext.notCalled).to.equal(true);
    });
  for (const type of ['email', 'emailTemplate', 'image', 'document', 'audio'])
    it(`previews existing Published ${type} with sole automatic locale`, async () => {
      const f = fixture(['en_US'], type);
      const s = subject({ preview: true, metadata: [`${type}:Existing`] }, f.connection);
      const output = await s.command.run();
      expect(output.status, JSON.stringify(output)).to.equal('success');
      expect(output.result?.outcome).to.equal('ready');
      expect(output.result?.targets[0]).to.include({ language: 'en_US', isPublished: true });
      expect(f.deletes.notCalled).to.equal(true);
    });
  for (const explicitRoot of [false, true])
    for (const preview of [false, true])
      it(`handles malformed local source honestly explicitRoot=${explicitRoot} preview=${preview}`, async () => {
        const run = await createRunOwnedTemp('cms-delete-cli-local-');
        const directory = path.join(run.root, 'cms', 'Marketing', 'audio');
        await mkdir(directory, { recursive: true });
        const definition = path.join(directory, 'Existing.cms-audio.json');
        await writeFile(definition, '{}');
        const f = fixture();
        const originalCwd = process.cwd();
        if (!explicitRoot) process.chdir(run.root);
        try {
          const output = await subject(
            { preview, ...(explicitRoot ? { 'output-dir': run.root } : {}) },
            f.connection,
          ).command.run();
          expect(output.status, JSON.stringify(output)).to.equal(preview ? 'success' : 'partial');
          expect(await readFile(definition, 'utf8')).to.equal('{}');
          expect(f.deletes.callCount).to.equal(preview ? 0 : 1);
          if (!preview) {
            expect(process.exitCode).to.equal(2);
            expect(output.result?.outcome).to.equal('partial');
            const execution = output.result!.execution!;
            expect(execution.report.state).to.equal('completed');
            expect(execution.report.operations[0]).to.include({
              state: 'completed',
              exactVariantAbsent: true,
            });
            expect(execution.report.operations[0].localSource?.outcome).to.equal('blocked');
            expect(() =>
              assertContentDeleteResult(output.result, undefined, 'partial'),
            ).not.to.throw();
            expect(() => assertContentDeleteResult(output.result, undefined, 'success')).to.throw();
            expect(() =>
              assertContentDeleteResult(
                { ...output.result, outcome: 'completed' },
                undefined,
                'success',
              ),
            ).to.throw();
          }
        } finally {
          process.chdir(originalCwd);
        }
      });
  for (const workspace of [
    { id: 'wrong', apiName: 'Marketing' },
    { id: workspaceId },
    { id: workspaceId, apiName: '../escape' },
  ])
    it(`blocks unproven local workspace identity ${JSON.stringify(workspace)} before DELETE`, async () => {
      const f = fixture(['en_US'], 'audio', workspace);
      const output = await subject({}, f.connection).command.run();
      expect(output.status).to.equal('blocked');
      expect(f.deletes.notCalled).to.equal(true);
    });
  it('validates every defined local outcome and rejects inconsistent public status', async () => {
    const f = fixture();
    const output = await subject({}, f.connection).command.run();
    for (const localSource of [
      { outcome: 'noop', removed: [], remaining: [] },
      { outcome: 'deleted', removed: ['definition'], remaining: [] },
      { outcome: 'blocked', removed: [], remaining: ['definition'], message: 'Blocked' },
      { outcome: 'partial', removed: ['companion'], remaining: ['definition'], message: 'Stopped' },
    ]) {
      const result = structuredClone(output.result!);
      result.execution!.report.operations[0].localSource = localSource as never;
      const failed = ['blocked', 'partial'].includes(localSource.outcome);
      result.outcome = failed ? 'partial' : 'completed';
      expect(() =>
        assertContentDeleteResult(result, undefined, failed ? 'partial' : 'success'),
      ).not.to.throw();
      expect(() =>
        assertContentDeleteResult(result, undefined, failed ? 'success' : 'partial'),
      ).to.throw();
    }
  });
  it('keeps an absent explicit local root absent and records noop', async () => {
    const run = await createRunOwnedTemp('cms-delete-cli-absent-');
    const f = fixture();
    const output = await subject(
      { 'output-dir': path.join(run.root, 'absent') },
      f.connection,
    ).command.run();
    expect(output.status).to.equal('success');
    expect(output.result?.execution?.report.operations[0].localSource).to.deep.equal({
      outcome: 'noop',
      removed: [],
      remaining: [],
    });
    expect(await readdir(run.root)).to.deep.equal(['.sf-cms-run-owner']);
  });
  it('executes by default without reporting, ownership or Draft restriction', async () => {
    const f = fixture(['en_US', 'de']);
    const s = subject({ language: ['de'] }, f.connection);
    const output = await s.command.run();
    expect(output.status, JSON.stringify(output)).to.equal('success');
    expect(output.result?.execution?.reportFile).to.equal(null);
    expect(f.deletes.calledOnce).to.equal(true);
    expect(output.result?.execution?.report.operations[0]).to.include({
      state: 'completed',
      exactVariantAbsent: true,
    });
  });
  for (const defaultReport of [false, true])
    it(`persists opt-in reports via allocator default=${defaultReport}`, async () => {
      const f = fixture();
      const run = await createRunOwnedTemp('cms-delete-cli-report-');
      const originalCwd = process.cwd();
      process.chdir(run.root);
      try {
        const output = await subject(
          defaultReport ? { report: true } : { 'report-dir': path.join(run.root, 'report') },
          f.connection,
        ).command.run();
        expect(output.status, JSON.stringify(output)).to.equal('success');
        const execution = output.result!.execution!;
        expect(JSON.parse(await readFile(execution.reportFile!, 'utf8'))).to.deep.equal(
          execution.report,
        );
        if (defaultReport)
          expect(path.dirname(path.dirname(execution.reportFile!))).to.equal(
            path.join(run.root, 'logs', 'cms', 'reports'),
          );
        expect(f.deletes.calledOnce).to.equal(true);
      } finally {
        process.chdir(originalCwd);
      }
    });
  it('allocates no reports for no-report execution', async () => {
    const f = fixture();
    const run = await createRunOwnedTemp('cms-delete-cli-no-report-');
    const before = await readdir(run.root);
    const originalCwd = process.cwd();
    process.chdir(run.root);
    try {
      const output = await subject({}, f.connection).command.run();
      expect(output.status).to.equal('success');
      expect(output.result?.execution?.reportFile).to.equal(null);
      expect(await readdir(run.root)).to.deep.equal(before);
    } finally {
      process.chdir(originalCwd);
    }
  });
  it('rejects ambiguous JSON languages clearly without mutation', async () => {
    const f = fixture(['en_US', 'de']);
    const s = subject({}, f.connection);
    const output = await s.command.run();
    expect(output.status).to.equal('blocked');
    expect(output.diagnostics.errors[0].message).to.include('--language');
    expect(f.deletes.notCalled).to.equal(true);
  });
  it('selects all actual languages explicitly in preview', async () => {
    const f = fixture(['en_US', 'de']);
    const s = subject({ preview: true, language: ['*'] }, f.connection);
    const output = await s.command.run();
    expect(output.status).to.equal('success');
    expect(output.result?.targets.map(({ language }) => language)).to.deep.equal(['en_US', 'de']);
    expect(f.deletes.notCalled).to.equal(true);
  });
  for (const input of [
    { metadata: undefined, 'api-name': 'Existing', 'content-type': 'audio' },
    { metadata: undefined, 'content-key-or-id': [parentId], 'content-type': 'audio' },
  ])
    it('preserves an exact alternative selector route', async () => {
      const f = fixture();
      const s = subject({ ...input, preview: true }, f.connection);
      const output = await s.command.run();
      expect(output.status).to.equal('success');
    });
  it('preserves rejected execution evidence without replay', async () => {
    const f = fixture();
    f.deletes.callsFake((() =>
      Object.assign(
        Promise.reject(
          Object.assign(new Error('Rejected'), {
            response: { status: 403 },
            data: [{ errorCode: 'FORBIDDEN', message: 'Rejected' }],
          }),
        ),
        { stream: () => new PassThrough() },
      )) as never);
    const output = await subject({}, f.connection).command.run();
    expect(output.status).to.equal('failed');
    expect(output.result?.outcome).to.equal('rejected');
    expect(output.result?.execution?.reportFile).to.equal(null);
    expect(f.deletes.calledOnce).to.equal(true);
  });
  for (const selection of [[], ['en_US'], ['en_US', 'de']])
    it(`interactive selection ${JSON.stringify(selection)} resolves before dispatch`, async () => {
      const f = fixture(['en_US', 'de']);
      const s = subject({ preview: selection.length > 0 }, f.connection);
      Object.assign(s.command, {
        jsonEnabled: () => false,
        selectLanguages: sinon.stub().resolves(selection),
      });
      const stdinTTY = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
      const stdoutTTY = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
      Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });
      Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });
      const priorCI = process.env.CI;
      delete process.env.CI;
      try {
        const output = await s.command.run();
        expect(output.status).to.equal('success');
        expect(output.result?.outcome).to.equal(selection.length > 0 ? 'ready' : 'cancelled');
        expect(output.result?.targets.map(({ language }) => language)).to.deep.equal(selection);
        expect(f.deletes.notCalled).to.equal(true);
      } finally {
        if (priorCI === undefined) delete process.env.CI;
        else process.env.CI = priorCI;
        if (stdinTTY) Object.defineProperty(process.stdin, 'isTTY', stdinTTY);
        else delete (process.stdin as { isTTY?: boolean }).isTTY;
        if (stdoutTTY) Object.defineProperty(process.stdout, 'isTTY', stdoutTTY);
        else delete (process.stdout as { isTTY?: boolean }).isTTY;
      }
    });
  for (const json of [false, true])
    it(`keeps delete outcomes live, readable and JSON human-silent json=${json}`, async () => {
      const f = fixture(['en_US', 'de', 'fr']);
      const s = subject({ language: ['*'] }, f.connection);
      const log = sinon.stub();
      Object.assign(s.command, { jsonEnabled: () => json, log });
      const output = await s.command.run();
      expect(output.status).to.equal('success');
      expect(f.deletes.callCount).to.equal(3);
      const text = log.args.flat().join('\n');
      if (json) expect(text).to.equal('');
      else {
        expect(text).to.include('delete: Existing (en_US) — deleted');
        expect(text).to.include('delete: Existing (de) — deleted');
        expect(text).not.to.include(parentId);
        expect(text).not.to.include('9Psaj');
      }
    });
  it('keeps real language prompt readable while preserving All-first scope', async () => {
    const s = subject();
    const log = sinon.stub();
    Object.assign(s.command, { log });
    sinon.stub(Interface.prototype, 'question').resolves('0');
    const target = { apiName: `Existing ${parentId}`, language: 'en_US' };
    const languages = await (
      s.command as unknown as {
        selectLanguages: (item: unknown, ordinal: number) => Promise<string[]>;
      }
    ).selectLanguages(
      { contentId: parentId, available: [target, { ...target, language: 'de' }] },
      2,
    );
    expect(languages).to.deep.equal(['en_US', 'de']);
    const text = log.args.flat().join('\n');
    expect(text).to.include('delete: Existing — select languages\n0: All\n1: en_US\n2: de');
    expect(text).not.to.include(parentId);
  });
  it('keeps human failures free of raw diagnostics while retaining JSON evidence', async () => {
    const f = fixture();
    f.deletes.callsFake((() =>
      Promise.reject(new Error(`Lost response ${parentId} password=private-secret`))) as never);
    const s = subject({}, f.connection);
    const log = sinon.stub();
    Object.assign(s.command, { jsonEnabled: () => false, log });
    const output = await s.command.run();
    expect(output.result?.outcome).to.equal('uncertain');
    const text = log.args.flat().join('\n');
    expect(text).to.include('delete: Existing (en_US) — uncertain');
    expect(text).not.to.match(/20Yaj|Lost response|private-secret/u);
    expect(output.result?.execution?.report.operations[0].error).to.include('Lost response');
    expect(JSON.stringify(output)).not.to.include('private-secret');
  });
  it('advertises only new flags and equivalent alias', async () => {
    expect(DeleteContent.aliases).to.deep.equal(['content:delete']);
    for (const flag of [
      'apply',
      'contract-version',
      'ownership-report',
      'acknowledge-permanent-delete',
      'default-language',
    ])
      expect(DeleteContent.flags).not.to.have.property(flag);
    sinon.stub(Org, 'create').resolves({ getUsername: () => 'org' } as Org);
    const parsed = await Parser.parse(
      ['--workspace-id', workspaceId, '-m', 'audio:Existing', '--language', '*'],
      { flags: DeleteContent.flags },
    );
    expect(parsed.flags.metadata).to.deep.equal(['audio:Existing']);
    expect(parsed.flags.preview).to.equal(false);
  });
  it('validates command status and rejects legacy result shapes', () => {
    const result = {
      mode: 'execute',
      outcome: 'blocked',
      workspaceId,
      targets: [],
      execution: null,
    };
    expect(() => assertContentDeleteResult(result, undefined, 'blocked')).not.to.throw();
    expect(() => assertContentDeleteResult(result, undefined, 'success')).to.throw();
    expect(() => assertContentDeleteResult({ ...result, ownershipReport: 'old' })).to.throw();
  });
});
