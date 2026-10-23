import { Parser } from '@oclif/core';
import { brandBody } from '../fixtures/brand.js';
import { Org } from '@salesforce/core';
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
  'target-org': { getUsername: () => 'destination' },
  'api-version': '67.0',
  'workspace-id': 'destination-space',
  language: 'en_US',
  'default-language': false,
  'source-dir': ['local.json'],
  preview: true,
  report: false,
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
    .resolves({ mode: 'source-dir', items: [structuredClone(source)] });
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
    sinon.stub(Org, 'create').resolves({ getUsername: () => 'destination' } as Org);
    process.exitCode = undefined;
  });
  afterEach(() => {
    sinon.restore();
    process.exitCode = undefined;
  });

  it('parses repeatable non-greedy local selectors and defaults to execution without reports', async () => {
    for (const args of [
      ['--source-dir', 'a.json', '--source-dir', 'b.json'],
      ['-d', './a', '-d', './b', '-t', 'sfdc_cms__email', '-t', 'sfdc_cms__emailTemplate'],
      ['-m', 'sfdc_cms__email:Welcome', '-m', 'sfdc_cms__emailTemplate'],
      ['-m', 'email:Welcome', '-m', 'emailTemplate'],
      ['-d', './a', '-t', 'email', '-t', 'emailTemplate'],
      ['-d', './a', '-t', 'audio'],
      ['-d', './a', '-t', 'sfdc_cms__audio'],
      ['-m', 'brand:Brand'],
      ['-d', './a', '-t', 'sfdc_cms__brand'],
      ['-m', 'audio:Chime'],
      ['-m', 'sfdc_cms__audio:Chime'],
    ]) {
      const parsed = await Parser.parse(['-o', 'destination', '-W', 'Marketing', '-L', ...args], {
        flags: DeployContent.flags,
      });
      expect(parsed.flags.preview).to.equal(false);
      expect(parsed.flags.report).to.equal(false);
      expect(parsed.flags['default-language']).to.equal(true);
      expect(parsed.flags['target-org'].getUsername()).to.equal('destination');
    }
    const parsed = await Parser.parse(
      ['-o', 'destination', '--source-dir', 'a', '--source-dir', 'b'],
      { flags: DeployContent.flags },
    );
    expect(parsed.flags['source-dir']).to.deep.equal(['a', 'b']);
    const apply = await Parser.parse(
      ['-o', 'destination', '-W', 'Marketing', '-L', '-d', 'a', '--report', '-r', './reports'],
      { flags: DeployContent.flags },
    );
    expect(apply.flags.report).to.equal(true);
    expect(apply.flags.preview).to.equal(false);
    expect(apply.flags['report-dir']).to.equal('./reports');
    expect(apply.flags['source-dir']).to.deep.equal(['a']);
  });

  it('rejects removed definition-file and mixed source/metadata parser routes', async () => {
    for (const args of [
      ['--apply'],
      ['-a'],
      ['--definition-file', 'a.json'],
      ['-f', 'a.json'],
      ['-d', './cms', '-m', 'email'],
      ['-m', 'email', '-t', 'email'],
    ]) {
      let rejected = false;
      try {
        await Parser.parse(['-o', 'destination', ...args], { flags: DeployContent.flags });
      } catch {
        rejected = true;
      }
      expect(rejected).to.equal(true);
    }
  });

  it('binds metadata selection and subsequent preflight to the resolved API name and invocation cwd', async () => {
    const s = command({ 'source-dir': undefined, metadata: ['email:Welcome', 'emailTemplate'] });
    s.resolveDestinationWorkspace.resolves({
      id: 'resolved-destination',
      workspace: { apiName: 'Actual_API_Name', defaultLanguage: 'en_US' },
    });
    const result = await s.instance.run();
    expect(result.status).to.equal('success');
    expect(s.resolveDestinationWorkspace.calledBefore(s.selectSources)).to.equal(true);
    const expected = {
      'source-dir': undefined,
      'content-type': undefined,
      metadata: ['email:Welcome', 'emailTemplate'],
      workspaceApiName: 'Actual_API_Name',
      cwd: process.cwd(),
    };
    expect(s.selectSources.firstCall.args).to.deep.equal([expected]);
    expect(s.preflightBatch.firstCall.args[1].sources).to.deep.equal(expected);
    expect(s.executeBatch.notCalled).to.equal(true);
  });

  it('blocks metadata without a resolved workspace API name before planning or report allocation', async () => {
    const s = command({ 'source-dir': undefined, metadata: ['email:Welcome'] });
    Object.assign(s.instance, { selectSources: selectDeploySources });
    const result = await s.instance.run();
    expect(result.status).to.equal('blocked');
    expect(result.result!.blockedReasons.join(',')).to.include(
      'resolved destination workspace API name',
    );
    expect(s.preflightBatch.notCalled && s.executeBatch.notCalled).to.equal(true);
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
    const s = command({ 'source-dir': [file] });
    const selected = await selectDeploySources({ 'source-dir': [file] });
    s.preparation.items[0].source = selected.items[0];
    Object.assign(s.instance, { selectSources: selectDeploySources });
    const result = await s.instance.run();
    expect(result.status).to.equal('success');
    expect(result.result!.selection!.items[0].mediaSha256).to.match(/^[a-f0-9]{64}$/u);
    expect(s.preflightBatch.calledOnce).to.equal(true);
    expect(s.executeBatch.notCalled && s.connection.request.notCalled).to.equal(true);
  });
  for (const proposed of ['create', 'update', 'unchanged', 'blocked'] as const) {
    it(`routes real local Document selection to ${proposed} planning without qualification or mutation`, async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'cms-document-command-'));
      const file = path.join(root, 'Notes.cms-document.json');
      await writeFile(
        file,
        JSON.stringify({
          contract: 'sf-cms-media-source',
          contractVersion: '1.0.0',
          identity: {
            family: 'cms',
            type: 'Document',
            apiName: 'Notes',
            context: { workspaceApiName: 'Source' },
          },
          contentType: 'sfdc_cms__document',
          language: 'en_US',
          folderPath: [],
          title: 'Notes',
          media: {
            representation: 'binary',
            mimeType: 'text/plain',
            companion: { role: 'media', path: 'Notes.cms-document.media.txt' },
          },
        }),
      );
      const bytes = Buffer.from('Unicode café\r\nexact bytes\n');
      await writeFile(path.join(root, 'Notes.cms-document.media.txt'), bytes);
      const s = command({
        'source-dir': [root],
        'content-type': ['sfdc_cms__document'],
      });
      const selected = await selectDeploySources({
        'source-dir': [root],
        'content-type': ['sfdc_cms__document'],
      });
      const item = preparedItem(proposed);
      item.source = selected.items[0];
      item.changedFields = proposed === 'update' ? ['media'] : [];
      if (proposed === 'blocked') {
        item.blockedReasons = ['Document metadata changes are unsupported'];
        s.preparation.items = [preparedItem(), item];
        s.preparation.blockedReasons = [...item.blockedReasons];
      } else s.preparation.items = [item];
      Object.assign(s.instance, { selectSources: selectDeploySources });
      const envelope = await s.instance.run();
      expect(envelope.status).to.equal(proposed === 'blocked' ? 'blocked' : 'success');
      expect(envelope.result!.qualification).to.equal('unqualified');
      expect(envelope.result!.mutationEnabled).to.equal(false);
      expect(envelope.result!.summary.plannedUpdate).to.equal(proposed === 'update' ? 1 : 0);
      expect(envelope.result!.selection!.items[0]).to.deep.equal(selected.items[0]);
      expect(envelope.result!.selection!.items[0].mediaSha256).to.match(/^[a-f0-9]{64}$/u);
      expect(s.preflightBatch.firstCall.args[1].sources['content-type']).to.deep.equal([
        'sfdc_cms__document',
      ]);
      expect(s.executeBatch.notCalled && s.connection.request.notCalled).to.equal(true);
      if (proposed === 'blocked') {
        expect(envelope.result!.items.every((entry) => entry.outcome === 'blocked')).to.equal(true);
        expect(envelope.result!.summary.plannedCreate).to.equal(0);
      } else expect(envelope.result!.items[0].proposed).to.equal(proposed);
      expect(await readFile(path.join(root, 'Notes.cms-document.media.txt'))).to.deep.equal(bytes);
    });
  }

  for (const proposed of ['create', 'unchanged', 'update'] as const) {
    it(`routes local Audio ${proposed} through the public command without claiming native qualification`, async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'cms-audio-command-'));
      const file = path.join(root, 'Chime.cms-audio.json');
      const companion = path.join(root, 'Chime.cms-audio.media.bin');
      const bytes = Buffer.from([0, 255, 128, 13, 10]);
      await writeFile(
        file,
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
          folderPath: [],
          title: 'Chime',
          media: {
            representation: 'binary',
            mimeType: 'application/x-future-audio',
            companion: { role: 'media', path: path.basename(companion) },
          },
        }),
      );
      await writeFile(companion, bytes);
      for (const type of ['audio', 'sfdc_cms__audio']) {
        for (const selector of [{ 'content-type': [type] }]) {
          const s = command({ 'source-dir': [root], ...selector });
          const selected = await selectDeploySources({ 'source-dir': [root], ...selector });
          const item = preparedItem(proposed);
          item.source = selected.items[0];
          item.changedFields = proposed === 'update' ? ['media'] : [];
          s.preparation.items = [item];
          Object.assign(s.instance, { selectSources: selectDeploySources });
          const envelope = await s.instance.run();
          expect(envelope.status).to.equal('success');
          expect(envelope.result!.qualification).to.equal('unqualified');
          expect(envelope.result!.mutationEnabled).to.equal(false);
          expect(envelope.result!.summary.completed).to.equal(0);
          expect(envelope.result!.items[0]).to.deep.equal({
            ...item,
            outcome: 'planned',
            readback: null,
          });
          expect(envelope.result!.selection!.items[0].targetIdentity.contentType).to.equal(
            'sfdc_cms__audio',
          );
          expect(s.preflightBatch.firstCall.args[1].expectedSelection).to.deep.equal(selected);
          expect(s.executeBatch.notCalled && s.connection.request.notCalled).to.equal(true);
          expect(await readFile(companion)).to.deep.equal(bytes);
        }
      }
    });
  }

  for (const proposed of ['create', 'unchanged'] as const) {
    it(`routes strict ordinary Brand ${proposed} preview without mutation or qualification claims`, async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'cms-brand-command-'));
      const file = path.join(root, 'Brand.cms-brand.json');
      await writeFile(
        file,
        JSON.stringify({
          contract: 'sf-cms-source-definition',
          contractVersion: '1.0.0',
          identity: {
            family: 'cms',
            type: 'Brand',
            apiName: 'Brand',
            context: { workspaceApiName: 'Source' },
          },
          contentType: 'sfdc_cms__brand',
          language: 'en_US',
          folderPath: [],
          title: 'Brand',
          urlName: 'brand',
          contentBody: brandBody('Brand'),
          companions: {},
        }),
      );
      const s = command({ 'source-dir': [root], 'content-type': ['brand'] });
      const selected = await selectDeploySources({
        'source-dir': [root],
        'content-type': ['brand'],
      });
      const item = preparedItem(proposed);
      item.source = selected.items[0];
      s.preparation.items = [item];
      Object.assign(s.instance, { selectSources: selectDeploySources });
      const envelope = await s.instance.run();
      expect(envelope.status).to.equal('success');
      expect(envelope.result!.qualification).to.equal('unqualified');
      expect(envelope.result!.mutationEnabled).to.equal(false);
      expect(envelope.result!.items[0].proposed).to.equal(proposed);
      expect(s.preflightBatch.firstCall.args[1].expectedSelection).to.deep.equal(selected);
      expect(s.preflightBatch.firstCall.args[1]).not.to.have.property('includeUnqualifiedBrands');
      expect(s.executeBatch.notCalled && s.connection.request.notCalled).to.equal(true);
      expect(DeployContent.description).to.include(
        'Brand UPDATE, lifecycle operations, defaultBrand assignment and deletion remain unsupported',
      );
      expect(DeployContent.description).to.include(
        'does not qualify the final public CLI artifact or live mixed-family batches',
      );
    });
  }

  it('forwards ordinary Image selection without private admission options', async () => {
    const s = command();
    s.selectSources.resolves({
      mode: 'source-dir',
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
  it('blocks unsafe explicit reports before local or org access', async () => {
    for (const extra of [
      { preview: false, 'report-dir': '' },
      { preview: false, 'report-dir': '../reports' },
    ]) {
      const s = command(extra);
      const envelope = await s.instance.run();
      expect(envelope.status).to.equal('blocked');
      expect(envelope.result!.mutationEnabled).to.equal(false);
      expect(envelope.result!.mode).to.equal('execute');
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
      const s = command({ preview: false, 'report-dir': directory });
      const reportFile = path.join(directory, 'content-deploy-run.json');
      const report: DeployBatchReport = {
        qualification: 'unqualified',
        runId: 'test-run',
        destinationOrgId: '00D000000000001EAA',
        workspaceId: 'resolved-destination',
        language: 'en_US',
        selection: { mode: 'source-dir', items: [source] },
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
            'source-dir': ['local.json'],
            'content-type': undefined,
            metadata: undefined,
          },
          expectedSelection: result.selection,
          workspaceId: 'resolved-destination',
          language: 'en_US',
          destinationOrgId: '00D000000000001EAA',
          onOutcome: s.executeBatch.firstCall.args[1].onOutcome,
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

  for (const state of ['completed', 'blocked', 'partial'] as const) {
    it(`executes by default without report persistence and retains ${state} outcomes`, async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'cms-deploy-no-report-'));
      sinon.stub(process, 'cwd').returns(root);
      const s = command({ preview: false });
      const report = {
        state,
        selection: { mode: 'source-dir', items: [source] },
        blockedReasons: state === 'completed' ? [] : ['Inspect returned outcomes'],
        items: [
          {
            source,
            proposed: 'create',
            outcome: { completed: 'created', partial: 'uncertain', blocked: 'unattempted' }[state],
          },
        ],
        summary: {
          selected: 1,
          created: state === 'completed' ? 1 : 0,
          updated: 0,
          unchanged: 0,
          completed: state === 'completed' ? 1 : 0,
          failed: 0,
          uncertain: state === 'partial' ? 1 : 0,
          unattempted: state === 'blocked' ? 1 : 0,
        },
      };
      s.executeBatch.resolves({ report });
      Object.assign(s.instance, { jsonEnabled: () => false });
      const envelope = await s.instance.run();
      expect(envelope.status).to.equal(state === 'completed' ? 'success' : state);
      expect(envelope.result!.mode).to.equal('execute');
      expect(envelope.result!.reportFile).to.equal(null);
      expect(envelope.result!.report).to.deep.equal(report);
      expect(s.executeBatch.firstCall.args[1]).not.to.have.property('reportFile');
      expect(s.preflightBatch.notCalled).to.equal(true);
      expect(s.log.args.flat().join('\n')).not.to.include('undefined');
      expect(await readdir(root)).to.deep.equal([]);
    });
  }

  it('preview performs preflight without report directories or dispatch', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cms-deploy-preview-'));
    sinon.stub(process, 'cwd').returns(root);
    const s = command();
    const envelope = await s.instance.run();
    expect(envelope.status).to.equal('success');
    expect(envelope.result!.reportFile).to.equal(null);
    expect(envelope.result!.report).to.equal(null);
    expect(s.preflightBatch.calledOnce && s.executeBatch.notCalled).to.equal(true);
    expect(await readdir(root)).to.deep.equal([]);
  });

  for (const custom of [false, true]) {
    it(`opts into ${custom ? 'custom override' : 'default'} report allocation before dispatch`, async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'cms-deploy-report-option-'));
      sinon.stub(process, 'cwd').returns(root);
      const directory = path.join(root, 'exact');
      const s = command({
        preview: false,
        report: true,
        ...(custom ? { 'report-dir': directory } : {}),
      });
      s.executeBatch.callsFake(async (_connection: unknown, input: { reportFile: string }) => {
        const allocated = path.dirname(input.reportFile);
        expect(custom ? allocated : path.dirname(allocated)).to.equal(
          custom ? directory : path.join(root, 'logs', 'cms', 'reports'),
        );
        expect(await readdir(allocated)).to.deep.equal([]);
        // A pending persistence failure must never be described as completed dispatch.
        throw new Error('Pending report persistence failed');
      });
      const envelope = await s.instance.run();
      expect(envelope.status).to.equal('blocked');
      expect(envelope.result!.summary.completed).to.equal(0);
      expect(s.executeBatch.calledOnce).to.equal(true);
      expect(await readdir(root)).to.deep.equal([custom ? 'exact' : 'logs']);
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
      const s = command({ preview: false, 'report-dir': reportDirectory });
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
    const s = command({ preview: false, 'report-dir': directory });
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

  for (const json of [false, true]) {
    it(`delivers live deploy progress without leaking technical failures, JSON ${json}`, async () => {
      const s = command({ preview: false });
      Object.assign(s.instance, { jsonEnabled: () => json });
      s.executeBatch.callsFake(
        async (_connection: unknown, input: { onOutcome: (event: unknown) => void }) => {
          for (const [index, state] of ['created', 'uncertain', 'unattempted'].entries())
            input.onOutcome({
              operation: 'deploy',
              state,
              ordinal: index + 1,
              label: ['Alpha', 'Beta', 'Charlie'][index],
              language: 'en_US',
              target: { contentId: '20Y000000000001AAA' },
              diagnostics: [
                { code: 'TECHNICAL', message: 'private remote failure password=secret-value' },
              ],
            });
          return {
            report: {
              state: 'partial',
              selection: { mode: 'source-dir', items: [source] },
              blockedReasons: ['private remote failure password=secret-value'],
              items: [{ source, proposed: 'create', outcome: 'uncertain' }],
              summary: {
                selected: 1,
                created: 0,
                updated: 0,
                unchanged: 0,
                completed: 0,
                failed: 0,
                uncertain: 1,
                unattempted: 0,
              },
            },
          };
        },
      );
      const result = await s.instance.run();
      expect(result.status).to.equal('partial');
      const text = s.log.args.flat().join('\n');
      expect(text).not.to.match(
        /20Y000000000001AAA|private remote failure|secret-value|local.json/u,
      );
      if (json) expect(text).to.equal('');
      else {
        expect(text).to.include('deploy: Alpha (en_US) — created');
        expect(text).to.include('deploy: Beta (en_US) — uncertain');
        expect(text).to.include('deploy: Charlie (en_US) — unattempted');
      }
    });
  }
  it('reports pre-journal executor exceptions as blocked without false completed writes', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cms-deploy-prejournal-'));
    const directory = path.join(root, 'reports');
    const s = command({
      preview: false,
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
      { 'source-dir': undefined },
      { 'source-dir': ['./a'], metadata: ['email'] },
      { 'content-type': ['sfdc_cms__email'] },
      { 'workspace-name': 'ambiguous' },
      { 'default-language': true },
      { language: '' },
      { 'target-org': { getUsername: () => ' ' } },
    ]) {
      const s = command({ preview: false, 'report-dir': path.join(root, 'reports'), ...extra });
      Object.assign(s.instance, { selectSources: selectDeploySources });
      const envelope = await s.instance.run();
      expect(envelope.status).to.equal('blocked');
      expect(s.getOrgContext.notCalled && s.executeBatch.notCalled).to.equal(true);
      expect(await readdir(root)).to.deep.equal([]);
    }
  });

  it('rejects invalid source combinations through the real selector before authentication', async () => {
    for (const extra of [
      { 'source-dir': undefined },
      { 'source-dir': ['./a'], metadata: ['email'] },
      { 'content-type': ['sfdc_cms__email'] },
      {
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
      { 'target-org': { getUsername: () => ' ' } },
      { 'workspace-id': undefined },
      { 'workspace-name': 'Marketing' },
      { language: undefined },
      { 'default-language': true },
      { language: '' },
      { 'workspace-id': ' ' },
      { report: true },
      { 'report-dir': './reports' },
      { report: true, 'report-dir': './reports' },
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
      expect(result.mode).to.equal('preview');
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
            'source-dir': ['local.json'],
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
    expect(s.log.firstCall.args[0]).to.include(
      'No mutations, content writes or reports; diagnostic logs remain',
    );
  });
});
