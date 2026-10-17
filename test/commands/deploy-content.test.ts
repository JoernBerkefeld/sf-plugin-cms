import { Parser } from '@oclif/core';
import { expect } from 'chai';
import sinon from 'sinon';
import { mkdtemp, readdir, readFile, writeFile, mkdir, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { DeployBatchReport } from '../../src/services/deploy-batch-executor.js';
import DeployContent from '../../src/commands/cms/deploy/content.js';
import type {
  DeployDestinationPreparation,
  DeployPreparedItem,
} from '../../src/services/deploy-destination-preparation.js';
import type { DeployLocalItem } from '../../src/services/deploy-source-selection.js';
import { selectDeploySources } from '../../src/services/deploy-source-selection.js';

const flags = {
  'target-org': 'destination',
  'api-version': '67.0',
  'workspace-id': 'destination-space',
  language: 'en_US',
  'default-language': false,
  'definition-file': ['local.json'],
  apply: false,
};
const source = {
  definitionPath: 'local.json',
  companionPaths: ['local.html'],
  definition: { identity: { context: { workspaceApiName: 'Portable_Source' } } },
  targetIdentity: { contentType: 'sfdc_cms__email', apiName: 'Welcome', language: 'en_US' },
  contentBody: { rawHtml: '<p>Desired</p>', textContent: 'Retained' },
} as unknown as DeployLocalItem;
function preparedItem(proposed: DeployPreparedItem['proposed'] = 'create'): DeployPreparedItem {
  return {
    source: structuredClone(source),
    proposed,
    qualification: 'unqualified',
    changedFields: proposed === 'update' ? ['contentBody.rawHtml'] : [],
    blockedReasons: [],
    desired: {
      contentBody: structuredClone(source.contentBody),
      title: 'Retained title',
      urlName: 'retained-url',
    },
    ...(proposed === 'create'
      ? {}
      : {
          existing: {
            variantId: 'variant',
            contentId: 'parent',
            contentBody: { rawHtml: 'Old', textContent: 'Retained' },
            title: 'Retained title',
            urlName: 'retained-url',
          },
        }),
  };
}
function command(extra: Record<string, unknown> = {}) {
  const instance = Object.create(DeployContent.prototype) as DeployContent;
  const connection = {
    request: sinon.stub().rejects(new Error('Unexpected transport')),
    version: '67.0',
  };
  const getOrgContext = sinon.stub().resolves({ connection, orgId: '00D000000000001EAA' });
  const executeBatch = sinon.stub();
  const resolveDestinationWorkspace = sinon
    .stub()
    .resolves({ id: 'resolved-destination', workspace: { defaultLanguage: 'en_US' } });
  const selectSources = sinon
    .stub()
    .resolves({ mode: 'definition-file', items: [structuredClone(source)] });
  const preparation: DeployDestinationPreparation = {
    workspaceId: 'resolved-destination',
    language: 'en_US',
    apiVersion: '67.0',
    items: [preparedItem()],
    blockedReasons: [],
    inventory: {
      complete: true,
      scope: 'principal-visible-nondeleted-workspace-all-types-languages-statuses',
      recordCount: 0,
      pagesRequested: 4,
    },
  };
  const preflightBatch = sinon.stub().callsFake(async () => ({
    preparation,
    eligible:
      preparation.blockedReasons.length === 0 &&
      preparation.items.every(
        (item) => item.proposed !== 'blocked' && item.blockedReasons.length === 0,
      ),
    blockedReasons: preparation.blockedReasons,
    items: preparation.items.map((item) => ({
      definitionFile: item.source.definitionPath,
      proposed: item.proposed,
      blockedReasons: item.blockedReasons,
    })),
  }));
  const log = sinon.stub();
  Object.assign(instance, {
    parse: sinon.stub().resolves({ flags: { ...flags, ...extra } }),
    getOrgContext,
    resolveDestinationWorkspace,
    selectSources,
    preflightBatch,
    executeBatch,
    jsonEnabled: sinon.stub().returns(true),
    log,
  });
  return {
    instance,
    connection,
    getOrgContext,
    resolveDestinationWorkspace,
    selectSources,
    preflightBatch,
    executeBatch,
    preparation,
    log,
  };
}

describe('cms deploy content command', () => {
  beforeEach(() => {
    process.exitCode = undefined;
  });
  afterEach(() => {
    sinon.restore();
    process.exitCode = undefined;
  });

  it('parses repeatable non-greedy local selectors and defaults to dry-run', async () => {
    for (const args of [
      ['--definition-file', 'a.json', '--definition-file', 'b.json'],
      ['-d', './a', '-d', './b', '-t', 'sfdc_cms__email', '-t', 'sfdc_cms__emailTemplate'],
      ['-d', './a', '-m', 'sfdc_cms__email:Welcome', '-m', 'sfdc_cms__emailTemplate'],
    ]) {
      const parsed = await Parser.parse(['-o', 'destination', '-W', 'Marketing', '-L', ...args], {
        flags: DeployContent.flags,
      });
      expect(parsed.flags.apply).to.equal(false);
      expect(parsed.flags['default-language']).to.equal(true);
      expect(parsed.flags['target-org']).to.equal('destination');
    }
    const parsed = await Parser.parse(
      ['-o', 'destination', '--definition-file', 'a', '--definition-file', 'b'],
      { flags: DeployContent.flags },
    );
    expect(parsed.flags['definition-file']).to.deep.equal(['a', 'b']);
    const apply = await Parser.parse(
      ['-o', 'destination', '-W', 'Marketing', '-L', '-f', 'a', '-a', '-r', './reports'],
      { flags: DeployContent.flags },
    );
    expect(apply.flags.apply).to.equal(true);
    expect(apply.flags['report-dir']).to.equal('./reports');
    expect(apply.flags['definition-file']).to.deep.equal(['a']);
  });

  it('has no private Image qualification flag', async () => {
    expect(DeployContent.flags).not.to.have.property('image-qualification');
    try {
      await Parser.parse(['-o', 'destination', '--image-qualification'], {
        flags: DeployContent.flags,
      });
      expect.fail('Removed flag must be rejected');
    } catch (error) {
      expect((error as Error).message).to.include('image-qualification');
    }
  });
  it('runs real local unfamiliar Image admission before command planning without mutation', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cms-image-command-'));
    const file = path.join(root, 'Hero.cms-image.json');
    await writeFile(
      file,
      JSON.stringify({
        contract: 'sf-cms-media-source',
        contractVersion: '1.0.0',
        identity: {
          family: 'cms',
          type: 'Image',
          apiName: 'Hero',
          context: { workspaceApiName: 'Source' },
        },
        contentType: 'sfdc_cms__image',
        language: 'en_US',
        folderPath: [],
        media: {
          representation: 'binary',
          mimeType: 'image/svg+xml',
          companion: { role: 'media', path: 'Hero.cms-image.media.svg' },
        },
      }),
    );
    await writeFile(
      path.join(root, 'Hero.cms-image.media.svg'),
      `<svg><!--${' '.repeat(10 * 1024 * 1024)}--></svg>`,
    );
    const s = command({ 'definition-file': [file] });
    const selected = await selectDeploySources({ 'definition-file': [file] });
    s.preparation.items[0].source = selected.items[0];
    Object.assign(s.instance, { selectSources: selectDeploySources });
    const result = await s.instance.run();
    expect(result.status).to.equal('success');
    expect(result.result!.selection!.items[0].mediaSha256).to.match(/^[a-f0-9]{64}$/u);
    expect(s.preflightBatch.calledOnce).to.equal(true);
    expect(s.executeBatch.notCalled && s.connection.request.notCalled).to.equal(true);
  });
  it('forwards ordinary Image selection without private admission options', async () => {
    const s = command();
    s.selectSources.resolves({
      mode: 'definition-file',
      items: [
        { ...source, targetIdentity: { ...source.targetIdentity, contentType: 'sfdc_cms__image' } },
      ],
    });
    await s.instance.run();
    expect(s.selectSources.firstCall.args).to.have.length(1);
    expect(s.preflightBatch.calledOnce).to.equal(true);
    expect(s.preflightBatch.firstCall.args[1]).not.to.have.property('imageQualificationOrgId');
    expect(s.preflightBatch.firstCall.args[1]).not.to.have.property('includeUnqualifiedImages');
  });
  it('blocks apply with missing or unsafe reports before local or org access', async () => {
    for (const extra of [
      { apply: true },
      { apply: true, 'report-dir': '' },
      { apply: true, 'report-dir': '../reports' },
    ]) {
      const s = command(extra);
      const envelope = await s.instance.run();
      expect(envelope.status).to.equal('blocked');
      expect(envelope.result!.mutationEnabled).to.equal(false);
      expect(envelope.result!.mode).to.equal('apply');
      expect(
        s.selectSources.notCalled && s.getOrgContext.notCalled && s.preflightBatch.notCalled,
      ).to.equal(true);
      expect(process.exitCode).to.equal(1);
    }
  });

  for (const state of ['completed', 'blocked', 'partial'] as const) {
    it(`retains the full ${state} apply report and truthful exit status`, async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'cms-deploy-command-'));
      const directory = path.join(root, 'reports');
      const s = command({ apply: true, 'report-dir': directory });
      const reportFile = path.join(directory, 'content-deploy-run.json');
      const report: DeployBatchReport = {
        qualification: 'unqualified',
        runId: 'test-run',
        destinationOrgId: '00D000000000001EAA',
        workspaceId: 'resolved-destination',
        language: 'en_US',
        selection: { mode: 'definition-file', items: [source] },
        state,
        blockedReasons: state === 'completed' ? [] : ['Bearer batch-secret'],
        items: [
          {
            source,
            proposed: 'update',
            reportFile: `${reportFile}.item.json`,
            outcome: (
              { completed: 'updated', partial: 'uncertain', blocked: 'unattempted' } as const
            )[state],
            ...(state === 'partial' ? { error: 'Bearer item-secret' } : {}),
            target: { contentId: 'parent', variantId: 'variant' },
          },
        ],
        summary: {
          selected: 1,
          created: 0,
          updated: state === 'completed' ? 1 : 0,
          unchanged: 0,
          completed: state === 'completed' ? 1 : 0,
          failed: 0,
          uncertain: state === 'partial' ? 1 : 0,
          unattempted: state === 'blocked' ? 1 : 0,
        },
      };
      s.executeBatch.callsFake(async (_connection: unknown, input: { reportFile: string }) => {
        expect(await readdir(directory)).to.deep.equal([]);
        await writeFile(input.reportFile, JSON.stringify(report), { flag: 'wx' });
        return { qualification: 'unqualified', reportFile, report };
      });
      Object.assign(s.instance, { jsonEnabled: () => false });
      const envelope = await s.instance.run();
      expect(envelope.status).to.equal(state === 'completed' ? 'success' : state);
      expect(process.exitCode).to.equal({ completed: 0, blocked: 1, partial: 2 }[state]);
      const result = envelope.result!;
      expect(result.qualification).to.equal('unqualified');
      expect(result.reportFile).to.equal(reportFile);
      expect(result.report!.summary).to.deep.equal(report.summary);
      expect(result.report!.items[0].target).to.deep.equal(report.items[0].target);
      expect(result.items).to.deep.equal(result.report!.items);
      expect(result.summary.uncertain).to.equal(report.summary.uncertain);
      expect(result.summary.completed).to.equal(report.summary.completed);
      expect(result.summary.unattempted).to.equal(report.summary.unattempted);
      expect(result.unattempted).to.deep.equal(state === 'blocked' ? [source] : []);
      expect(result.preparation).to.equal(null);
      expect(s.preflightBatch.notCalled).to.equal(true);
      expect(s.executeBatch.calledOnce).to.equal(true);
      expect(s.executeBatch.firstCall.args).to.deep.equal([
        s.connection,
        {
          sources: {
            'definition-file': ['local.json'],
            'source-dir': undefined,
            'content-type': undefined,
            metadata: undefined,
          },
          expectedSelection: result.selection,
          workspaceId: 'resolved-destination',
          language: 'en_US',
          destinationOrgId: '00D000000000001EAA',
          reportFile,
        },
      ]);
      expect(await readFile(reportFile, 'utf8')).to.equal(JSON.stringify(report));
      expect(JSON.stringify(envelope))
        .not.to.include('batch-secret')
        .and.not.to.include('item-secret');
      expect(s.log.args.flat().join('\n'))
        .to.include(reportFile)
        .and.to.include(`uncertain ${report.summary.uncertain}`);
      expect(s.log.args.flat().join('\n')).not.to.include('No writes');
    });
  }

  it('blocks existing, file and symlink report paths before authentication without writes', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cms-deploy-report-path-'));
    const directory = path.join(root, 'existing');
    const file = path.join(root, 'file');
    const link = path.join(root, 'link');
    await mkdir(directory);
    await writeFile(file, 'preserve');
    await symlink(directory, link, 'junction');
    for (const reportDirectory of [directory, file, path.join(link, 'new')]) {
      const s = command({ apply: true, 'report-dir': reportDirectory });
      const envelope = await s.instance.run();
      expect(envelope.status).to.equal('blocked');
      expect(s.getOrgContext.notCalled && s.executeBatch.notCalled).to.equal(true);
    }
    expect(await readFile(file, 'utf8')).to.equal('preserve');
    expect(await readdir(directory)).to.deep.equal([]);
  });

  it('rechecks exclusive report allocation after authentication and preserves the winner', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cms-deploy-report-race-'));
    const directory = path.join(root, 'reports');
    const s = command({ apply: true, 'report-dir': directory });
    s.resolveDestinationWorkspace.callsFake(async () => {
      await mkdir(directory);
      await writeFile(path.join(directory, 'winner'), 'preserve');
      return { id: 'resolved-destination', workspace: { defaultLanguage: 'en_US' } };
    });
    const envelope = await s.instance.run();
    expect(envelope.status).to.equal('blocked');
    expect(s.executeBatch.notCalled).to.equal(true);
    expect(await readFile(path.join(directory, 'winner'), 'utf8')).to.equal('preserve');
  });

  it('reports pre-journal executor exceptions as blocked without false completed writes', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cms-deploy-prejournal-'));
    const directory = path.join(root, 'reports');
    const s = command({
      apply: true,
      'report-dir': directory,
      'workspace-id': undefined,
      'workspace-name': 'Marketing',
      language: undefined,
      'default-language': true,
    });
    s.executeBatch.rejects(new Error('Bearer prejournal-secret'));
    const envelope = await s.instance.run();
    expect(envelope.status).to.equal('blocked');
    expect(process.exitCode).to.equal(1);
    expect(envelope.result!.reportFile).to.equal(path.join(directory, 'content-deploy-run.json'));
    expect(envelope.result!.report).to.equal(null);
    expect(s.executeBatch.firstCall.args[1].workspaceId).to.equal('resolved-destination');
    expect(s.executeBatch.firstCall.args[1].language).to.equal('en_US');
    expect(envelope.result!.summary.completed).to.equal(0);
    expect(envelope.result!.unattempted).to.deep.equal([source]);
    expect(JSON.stringify(envelope)).not.to.include('prejournal-secret');
    expect(await readdir(directory)).to.deep.equal([]);
  });

  it('rejects all local source and scope errors for apply before auth or report allocation', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cms-deploy-local-'));
    for (const extra of [
      { 'definition-file': undefined },
      { 'source-dir': ['./a'] },
      { 'content-type': ['sfdc_cms__email'] },
      { 'workspace-name': 'ambiguous' },
      { 'default-language': true },
      { language: '' },
      { 'target-org': ' ' },
    ]) {
      const s = command({ apply: true, 'report-dir': path.join(root, 'reports'), ...extra });
      Object.assign(s.instance, { selectSources: selectDeploySources });
      const envelope = await s.instance.run();
      expect(envelope.status).to.equal('blocked');
      expect(s.getOrgContext.notCalled && s.executeBatch.notCalled).to.equal(true);
      expect(await readdir(root)).to.deep.equal([]);
    }
  });

  it('rejects invalid source combinations through the real selector before authentication', async () => {
    for (const extra of [
      { 'definition-file': undefined },
      { 'source-dir': ['./a'] },
      { 'content-type': ['sfdc_cms__email'] },
      {
        'definition-file': undefined,
        'source-dir': ['./a'],
        'content-type': ['sfdc_cms__email'],
        metadata: ['sfdc_cms__email'],
      },
    ]) {
      const s = command(extra);
      Object.assign(s.instance, { selectSources: selectDeploySources });
      const result = await s.instance.run();
      expect(result.status).to.equal('blocked');
      expect(s.getOrgContext.notCalled).to.equal(true);
    }
  });

  it('rejects invalid explicit destination/language and dry-run reports before authentication', async () => {
    for (const extra of [
      { 'target-org': ' ' },
      { 'workspace-id': undefined },
      { 'workspace-name': 'Marketing' },
      { language: undefined },
      { 'default-language': true },
      { language: '' },
      { 'workspace-id': ' ' },
      { 'report-dir': './reports' },
    ]) {
      const s = command(extra);
      const envelope = await s.instance.run();
      expect(envelope.status).to.equal('blocked');
      expect(s.getOrgContext.notCalled).to.equal(true);
    }
  });

  for (const proposed of ['create', 'update', 'unchanged'] as const) {
    it(`reports ${proposed} as an unqualified plan, never a completed mutation`, async () => {
      const s = command();
      s.preparation.items = [preparedItem(proposed)];
      const envelope = await s.instance.run();
      const result = envelope.result!;
      expect(envelope.status).to.equal('success');
      expect(process.exitCode).to.equal(0);
      expect(envelope.metadata.operation).to.equal('content.deploy');
      expect(result.mode).to.equal('dry-run');
      expect(result.summary.completed).to.equal(0);
      expect(result.items[0]).to.deep.equal({
        ...s.preparation.items[0],
        outcome: 'planned',
        readback: null,
      });
      expect(result.preparation).to.deep.equal(s.preparation);
      expect(result.selection!.items[0].definition.identity.context.workspaceApiName).to.equal(
        'Portable_Source',
      );
      expect(s.preflightBatch.firstCall.args).to.deep.equal([
        s.connection,
        {
          sources: {
            'definition-file': ['local.json'],
            'source-dir': undefined,
            'content-type': undefined,
            metadata: undefined,
          },
          expectedSelection: result.selection,
          workspaceId: 'resolved-destination',
          language: 'en_US',
        },
      ]);
      expect(s.selectSources.calledBefore(s.getOrgContext)).to.equal(true);
      expect(s.connection.request.notCalled).to.equal(true);
      expect(result.unattempted).to.deep.equal([]);
    });
  }

  it('uses explicit destination workspace name/default-language without borrowing source context', async () => {
    const s = command({
      'workspace-id': undefined,
      'workspace-name': 'Marketing',
      language: undefined,
      'default-language': true,
    });
    const envelope = await s.instance.run();
    const result = envelope.result!;
    expect(s.resolveDestinationWorkspace.firstCall.args[1]).to.deep.equal({
      workspaceId: undefined,
      workspaceName: 'Marketing',
    });
    expect(result.scope.language).to.equal('en_US');
    expect(result.scope.workspaceId).to.equal('resolved-destination');
  });

  it('blocks global AND per-item reasons, retaining all changed fields and snapshots', async () => {
    const s = command();
    s.preparation.blockedReasons = ['Authorization: Bearer global-secret'];
    s.preparation.items = [preparedItem('update'), preparedItem('blocked')];
    s.preparation.items[1].blockedReasons = ['Bearer item-secret'];
    s.preparation.items[1].changedFields = ['title', 'contentBody.textContent'];
    const envelope = await s.instance.run();
    const result = envelope.result!;
    expect(envelope.status).to.equal('blocked');
    expect(result.items.every((item) => item.outcome === 'blocked')).to.equal(true);
    expect(result.summary.blocked).to.equal(2);
    expect(result.summary.plannedUpdate).to.equal(0);
    const blockedItem = result.items[1];
    expect('changedFields' in blockedItem ? blockedItem.changedFields : null).to.deep.equal([
      'title',
      'contentBody.textContent',
    ]);
    expect(JSON.stringify(envelope))
      .not.to.include('global-secret')
      .and.not.to.include('item-secret');
    expect(result.preparation!.items[1].desired.contentBody.textContent).to.equal('Retained');
  });

  it('never reports partial planning as completed success when one item blocks', async () => {
    const s = command();
    s.preparation.items.push({ ...preparedItem('blocked'), blockedReasons: ['Unsupported edit'] });
    const result = await s.instance.run();
    expect(result.status).to.equal('blocked');
    expect(result.result!.summary.completed).to.equal(0);
  });

  it('retains unattempted sources after global preparation failure', async () => {
    const s = command();
    s.preparation.items = [];
    s.preparation.blockedReasons = ['Inventory incomplete'];
    const envelope = await s.instance.run();
    const result = envelope.result!;
    expect(result.unattempted).to.deep.equal([source]);
    expect(result.summary.unattempted).to.equal(1);
    expect(result.summary.completed).to.equal(0);
  });

  it('redacts local and destination errors and preserves unattempted sources on scope failure', async () => {
    for (const stage of ['local', 'scope']) {
      const s = command();
      (stage === 'local' ? s.selectSources : s.resolveDestinationWorkspace).rejects(
        new Error('Bearer failure-secret'),
      );
      const result = await s.instance.run();
      expect(result.status).to.equal('blocked');
      expect(JSON.stringify(result)).not.to.include('failure-secret');
      expect(result.result!.summary.unattempted).to.equal(stage === 'local' ? 0 : 1);
    }
  });

  it('reports effective API and useful human summaries without claiming writes', async () => {
    const s = command({ 'api-version': 'latest' });
    Object.assign(s.instance, { jsonEnabled: () => false });
    const result = await s.instance.run();
    expect(result.metadata.apiVersion).to.equal('67.0');
    expect(s.log.firstCall.args[0]).to.include('No writes; all proposals unqualified');
  });
});
