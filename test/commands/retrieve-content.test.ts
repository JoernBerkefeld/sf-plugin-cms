import path from 'node:path';
import { Parser } from '@oclif/core';
import { expect } from 'chai';
import sinon from 'sinon';
import RetrieveContent from '../../src/commands/cms/retrieve/content.js';
import type { AcquiredEditableEmailSource } from '../../src/services/retrieve-item-source.js';

const flags = {
  'target-org': 'source',
  'api-version': '67.0',
  'workspace-id': 'space',
  'content-type': ['sfdc_cms__email'],
  'api-name': ['Welcome'],
  'default-language': true,
  'output-dir': './project',
  overwrite: false,
};
const source = {
  directory: 'cms/Marketing/email',
  projection: { definition: { language: 'en_US' } },
  evidence: { variantId: 'variant', contentId: 'parent' },
} as AcquiredEditableEmailSource;
const receipt = {
  definitionPath: path.resolve('project/cms/Marketing/email/Welcome.cms-email.json'),
  created: [path.resolve('project/cms/Marketing/email/Welcome.cms-email.json')],
  updated: [],
  unchanged: [],
  removed: [],
};
function command(extra: Record<string, unknown> = {}) {
  const instance = Object.create(RetrieveContent.prototype) as RetrieveContent;
  const connection = { request: sinon.stub().rejects(new Error('Unexpected transport')) };
  const getOrgContext = sinon.stub().resolves({ connection, orgId: '00DSource' });
  const resolveSourceWorkspace = sinon.stub().resolves({ id: 'resolved-space', workspace: {} });
  const acquireSource = sinon.stub().resolves(source);
  const writeSource = sinon.stub().resolves(structuredClone(receipt));
  const log = sinon.stub();
  Object.assign(instance, {
    parse: sinon.stub().resolves({ flags: { ...flags, ...extra } }),
    getOrgContext,
    resolveSourceWorkspace,
    acquireSource,
    writeSource,
    jsonEnabled: sinon.stub().returns(true),
    log,
  });
  return {
    instance,
    connection,
    getOrgContext,
    resolveSourceWorkspace,
    acquireSource,
    writeSource,
    log,
  };
}
const arguments_ = [
  '-o',
  'source',
  '-w',
  'space',
  '-t',
  'sfdc_cms__email',
  '-n',
  'Welcome',
  '-L',
  '-d',
  './project',
];

describe('cms retrieve content command', () => {
  beforeEach(() => {
    process.exitCode = undefined;
  });
  afterEach(() => {
    sinon.restore();
    process.exitCode = undefined;
  });

  it('parses all specified aliases and requires explicit org, type, API name and output', async () => {
    const parsed = await Parser.parse([...arguments_, '-x'], { flags: RetrieveContent.flags });
    expect(parsed.flags).to.include({
      'target-org': 'source',
      'workspace-id': 'space',
      'default-language': true,
      overwrite: true,
    });
    expect(parsed.flags['content-type']).to.deep.equal(['sfdc_cms__email']);
    expect(parsed.flags['api-name']).to.deep.equal(['Welcome']);
    const alternative = await Parser.parse(
      [
        '-o',
        'source',
        '-W',
        'Marketing',
        '-t',
        'sfdc_cms__email',
        '-n',
        'Welcome',
        '-l',
        'fr',
        '-d',
        '.',
      ],
      { flags: RetrieveContent.flags },
    );
    expect(alternative.flags).to.include({ 'workspace-name': 'Marketing', language: 'fr' });
    for (const name of ['-o', '-t', '-n', '-d']) {
      const missing = [...arguments_];
      missing.splice(missing.indexOf(name), 2);
      let failure: unknown;
      try {
        await Parser.parse(missing, { flags: RetrieveContent.flags });
      } catch (error) {
        failure = error;
      }
      expect(failure, name).to.be.instanceOf(Error);
    }
  });

  it('wires exact workspace/default language to acquisition and the untouched projection to writer', async () => {
    const subject = command();
    const result = await subject.instance.run();
    expect(result.status).to.equal('success');
    expect(process.exitCode).to.equal(0);
    expect(subject.getOrgContext.firstCall.args).to.deep.equal(['source', '67.0']);
    expect(subject.resolveSourceWorkspace.firstCall.args).to.deep.equal([
      subject.connection,
      { workspaceId: 'space', workspaceName: undefined },
    ]);
    expect(subject.acquireSource.firstCall.args).to.deep.equal([
      subject.connection,
      { workspaceId: 'resolved-space', apiName: 'Welcome', useDefaultLanguage: true },
    ]);
    expect(subject.writeSource.firstCall.args).to.deep.equal([
      './project',
      source.directory,
      source.projection,
      false,
    ]);
    expect(result.result!.scope).to.deep.equal({
      targetOrg: 'source',
      workspaceId: 'resolved-space',
      workspaceName: null,
      language: 'en_US',
      defaultLanguage: true,
      outputDir: path.resolve('project'),
    });
    expect(result.result!.items).to.deep.equal([
      {
        identity: { contentType: 'sfdc_cms__email', apiName: 'Welcome', language: 'en_US' },
        operation: 'retrieve',
        outcome: 'retrieved',
        paths: receipt,
        evidence: source.evidence,
        diagnostics: [],
      },
    ]);
    expect(result.result!.summary).to.deep.equal({
      selected: 1,
      retrieved: 1,
      unchanged: 0,
      blocked: 0,
      unattempted: 0,
    });
    expect(result.result!.unattempted).to.deep.equal([]);
    expect(subject.connection.request.notCalled).to.equal(true);
    expect(subject.log.notCalled).to.equal(true);
  });

  it('preserves explicit language/name selectors and overwrite, and reports stable unchanged output', async () => {
    const subject = command({
      'workspace-id': undefined,
      'workspace-name': 'Marketing',
      language: 'fr',
      'default-language': false,
      overwrite: true,
    });
    subject.writeSource.resolves({ ...receipt, created: [], unchanged: receipt.created });
    Object.assign(subject.instance, { jsonEnabled: sinon.stub().returns(false) });
    const first = await subject.instance.run();
    const second = await subject.instance.run();
    expect(first.result).to.deep.equal(second.result);
    expect(first.result!.items[0].outcome).to.equal('unchanged');
    expect(first.result!.summary.unchanged).to.equal(1);
    expect(subject.acquireSource.firstCall.args[1]).to.deep.equal({
      workspaceId: 'resolved-space',
      apiName: 'Welcome',
      language: 'fr',
    });
    expect(subject.writeSource.firstCall.args[3]).to.equal(true);
    expect(subject.resolveSourceWorkspace.firstCall.args[1]).to.deep.equal({
      workspaceId: undefined,
      workspaceName: 'Marketing',
    });
    expect(subject.log.args.flat().join('\n')).to.include(receipt.definitionPath);
  });

  for (const extra of [
    { 'workspace-id': undefined },
    { 'workspace-name': 'other' },
    { 'default-language': false },
    { language: 'fr' },
    { language: '', 'default-language': false },
    { 'target-org': '' },
    { 'output-dir': '' },
    { 'api-name': [' '] },
    { 'content-type': ['sfdc_cms__emailTemplate'] },
    { 'content-type': ['sfdc_cms__image'] },
    { 'content-type': ['sfdc_cms__email', 'sfdc_cms__email'] },
    { 'api-name': ['Welcome', 'Welcome'] },
    { metadata: ['sfdc_cms__email:Welcome'] },
    { all: true },
    { 'content-key-or-id': ['id'] },
  ]) {
    it(`blocks unsupported/invalid selection before auth: ${JSON.stringify(extra)}`, async () => {
      const subject = command(extra);
      const result = await subject.instance.run();
      expect(result.status).to.equal('blocked');
      expect(process.exitCode).to.equal(1);
      expect(subject.getOrgContext.notCalled).to.equal(true);
      expect(subject.writeSource.notCalled).to.equal(true);
      expect(result.result!.items).to.deep.equal([]);
    });
  }

  it('rejects repeated selectors and deferred modes through the actual parser without silently narrowing', async () => {
    for (const extra of [
      ['-n', 'Second'],
      ['-t', 'sfdc_cms__email'],
      ['-m', 'sfdc_cms__email:Welcome'],
      ['-a'],
      ['-i', 'id'],
    ]) {
      const parsed = await Parser.parse([...arguments_, ...extra], {
        flags: RetrieveContent.flags,
      });
      const subject = command(parsed.flags);
      const result = await subject.instance.run();
      expect(result.status).to.equal('blocked');
      expect(subject.getOrgContext.notCalled).to.equal(true);
    }
    expect(RetrieveContent.flags.metadata.hidden).to.equal(true);
    expect(RetrieveContent.flags.all.hidden).to.equal(true);
    expect(RetrieveContent.flags['content-key-or-id'].hidden).to.equal(true);
  });

  for (const stage of ['auth', 'workspace', 'source', 'write'] as const) {
    it(`returns blocked exit 1 with sanitized diagnostics on ${stage} failure`, async () => {
      const subject = command();
      ({
        auth: subject.getOrgContext,
        workspace: subject.resolveSourceWorkspace,
        source: subject.acquireSource,
        write: subject.writeSource,
      })[stage].rejects(new Error('Bearer SECRET unsafe server body'));
      const result = await subject.instance.run();
      expect(result.status).to.equal('blocked');
      expect(process.exitCode).to.equal(1);
      expect(JSON.stringify(result)).not.to.include('SECRET');
      expect(result.result!.summary.unattempted).to.equal(
        ['auth', 'workspace'].includes(stage) ? 1 : 0,
      );
      expect(result.result!.summary.blocked).to.equal(['source', 'write'].includes(stage) ? 1 : 0);
      if (stage !== 'write') expect(subject.writeSource.notCalled).to.equal(true);
      if (stage === 'write') {
        expect(result.result!.items[0].paths).to.equal(null);
        expect(result.diagnostics.errors[0].message).to.include('partial local progress');
      }
    });
  }
});
