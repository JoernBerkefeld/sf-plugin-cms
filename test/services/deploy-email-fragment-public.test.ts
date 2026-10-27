import { expect } from 'chai';
import sinon from 'sinon';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createFixture } from './deploy-email-fragment-create.test.js';
import {
  fixture,
  workspaceId,
  contentId,
  variantId,
} from './deploy-email-fragment-update-preflight.test.js';
import { selectDeploySources } from '../../src/services/deploy-source-selection.js';
import { preflightDeployBatch } from '../../src/services/deploy-batch-preflight.js';
import { executeDeployBatch } from '../../src/services/deploy-batch-executor.js';

const input = (file: string) => ({
  sources: { 'source-dir': [file] },
  workspaceId,
  language: 'en_US',
  destinationOrgId: '00D000000000001AAA',
});
describe('public Fragment deploy pipeline', () => {
  afterEach(() => sinon.restore());
  it('selects full standalone JSON and exact/whole-type metadata independently of destination workspace name', async () => {
    const current = await fixture();
    const root = path.dirname(current.file);
    const directory = path.join(root, 'cms', 'Source', 'emailFragment');
    await mkdir(directory, { recursive: true });
    const file = path.join(directory, path.basename(current.file));
    await writeFile(file, await readFile(current.file));
    for (const metadata of [
      ['emailFragment:Welcome'],
      ['sfdc_cms__emailFragment'],
      ['emailFragment', 'emailFragment:Welcome'],
    ]) {
      const selected = await selectDeploySources({
        cwd: root,
        workspaceApiName: 'IndependentDestination',
        metadata,
      });
      expect(selected.items).to.have.length(1);
      expect(selected.items[0].contentBody).to.deep.equal(current.definition.contentBody);
      expect(selected.items[0].companionPaths).to.deep.equal([]);
      expect(selected.items[0].definition.identity.context.workspaceApiName).to.equal('Source');
    }
  });
  it('previews CREATE then executes once with independent readback and repeats unchanged without journals', async () => {
    const current = await createFixture();
    const scope = input(current.file);
    const preview = await preflightDeployBatch(current.connection, scope);
    expect(preview.eligible, JSON.stringify(preview)).to.equal(true);
    expect(preview.items[0].proposed).to.equal('create');
    expect(current.calls.every((call) => call.method === 'GET')).to.equal(true);
    const created = await executeDeployBatch(current.connection, scope);
    expect(created.report.summary.created, JSON.stringify(created.report)).to.equal(1);
    expect(created.report.state).to.equal('completed');
    expect(created.report.items[0].target).to.deep.equal({ contentId, variantId });
    const repeated = await executeDeployBatch(current.connection, scope);
    expect(repeated.report.summary.unchanged, JSON.stringify(repeated.report)).to.equal(1);
    expect(current.calls.filter((call) => call.method !== 'GET')).to.have.length(1);
    expect(await readdir(path.dirname(current.file))).to.deep.equal([path.basename(current.file)]);
  });
  it('previews and executes full-body UPDATE then unchanged preserving same IDs', async () => {
    const current = await fixture();
    const scope = input(current.file);
    const preview = await preflightDeployBatch(current.connection, scope);
    expect(preview.eligible, JSON.stringify(preview)).to.equal(true);
    expect(preview.items[0].proposed).to.equal('update');
    expect(preview.items[0].fragment!.payload.title).to.equal('Edited body title');
    expect(preview.preparation.items[0].desired.title).to.equal('Edited body title');
    const sourceBytes = await readFile(current.file, 'utf8');
    const updated = await executeDeployBatch(current.connection, scope);
    expect(updated.report.summary.updated, JSON.stringify(updated.report)).to.equal(1);
    expect(updated.report.items[0].target).to.deep.equal({ contentId, variantId });
    expect(updated.report.items[0].envelope).to.deep.equal({
      sourceTitle: 'Envelope',
      effectiveTitle: 'Edited body title',
      derived: true,
    });
    expect(await readFile(current.file, 'utf8')).to.equal(sourceBytes);
    expect(current.detail.contentBody).to.deep.equal(current.definition.contentBody);
    const repeated = await executeDeployBatch(current.connection, scope);
    expect(repeated.report.summary.unchanged, JSON.stringify(repeated.report)).to.equal(1);
    expect(current.calls.filter((call) => call.method !== 'GET')).to.have.length(1);
  });
  for (const blocker of ['sibling', 'folder', 'reference'] as const) {
    it(`blocks whole selection explicitly for unsupported ${blocker} without mutations`, async () => {
      const current = await fixture();
      if (blocker === 'sibling')
        current.rows.push({
          ...current.rows[0],
          Id: '9Ps000000000002AAA',
          Language: 'de',
          IsPrimary: false,
        });
      else if (blocker === 'folder') current.definition.folderPath = ['Nested'];
      else current.definition.contentBody.asset = { ref: 'unresolved' };
      await current.save();
      const result = await executeDeployBatch(current.connection, input(current.file));
      expect(result.report.state).to.equal('blocked');
      expect(result.report.blockedReasons.join('; ')).to.match(/variant|nonroot|reference/u);
      expect(current.calls.every((call) => call.method === 'GET')).to.equal(true);
    });
  }
  it('reconciles verified envelope metadata UPDATE without erasing unrelated inventory fields', async () => {
    const current = await fixture();
    current.definition.title = 'New envelope';
    current.definition.urlName = 'new-envelope';
    await current.save();
    const result = await executeDeployBatch(current.connection, input(current.file));
    expect(result.report.state, JSON.stringify(result.report)).to.equal('completed');
    expect(result.report.summary.updated).to.equal(1);
    expect(current.rows[0].Name).to.equal('Edited body title');
    const unchanged = await executeDeployBatch(current.connection, input(current.file));
    expect(unchanged.report.summary.unchanged).to.equal(1);
  });
  it('blocks raw or effective destination title collisions and unsupported boundary writes without journals', async () => {
    for (const name of ['Edited body title', 'Envelope', undefined]) {
      const current = await fixture();
      if (name === undefined) {
        current.definition.contentBody['sfdc_cms:title'] = 'Edited body title ';
        await current.save();
      } else {
        current.rows.push({
          ...current.rows[0],
          Id: '9Ps000000000002AAA',
          ManagedContentId: '20Y000000000002AAA',
          Name: name,
          UrlName: 'different',
          ManagedContentKey: 'MCOTHER',
          ManagedContent: { AuthoredManagedContentSpaceId: workspaceId, ApiName: 'Other' },
        });
      }
      const result = await executeDeployBatch(current.connection, {
        ...input(current.file),
        reportFile: current.reportFile,
      });
      expect(result.report.state).to.equal('blocked');
      expect(current.calls.every((call) => call.method === 'GET')).to.equal(true);
      const files = await readdir(path.dirname(current.file));
      expect(files.some((file) => file.includes('.json.'))).to.equal(false);
    }
  });
  it('blocks effective selected-title collisions before an earlier eligible CREATE', async () => {
    const current = await createFixture();
    const other = structuredClone(current.definition);
    other.identity.apiName = 'Second';
    other.urlName = 'second-url';
    await writeFile(
      path.join(path.dirname(current.file), 'Second.cms-email-fragment.json'),
      JSON.stringify(other),
    );
    const result = await executeDeployBatch(current.connection, {
      ...input(current.file),
      sources: { 'source-dir': [path.dirname(current.file)], 'content-type': ['emailFragment'] },
    });
    expect(result.report.state).to.equal('blocked');
    expect(result.report.blockedReasons.join('; ')).to.match(/title\/URL collision/u);
    expect(current.calls.every((call) => call.method === 'GET')).to.equal(true);
  });
  it('blocks a selected CREATE colliding with a stale-envelope UPDATE effective title before either writes', async () => {
    const current = await fixture();
    const other = structuredClone(current.definition);
    other.identity.apiName = 'Second';
    other.title = 'Edited body title';
    other.urlName = 'second-url';
    await writeFile(
      path.join(path.dirname(current.file), 'Second.cms-email-fragment.json'),
      JSON.stringify(other),
    );
    const result = await executeDeployBatch(current.connection, {
      ...input(current.file),
      sources: { 'source-dir': [path.dirname(current.file)], 'content-type': ['emailFragment'] },
    });
    expect(result.report.state).to.equal('blocked');
    expect(result.report.blockedReasons.join('; ')).to.match(/title\/URL collision/u);
    expect(current.calls.every((call) => call.method === 'GET')).to.equal(true);
  });
  it('blocks provider drift after item durable intent before remote dispatch', async () => {
    const current = await fixture();
    let altered = false;
    const result = await executeDeployBatch(
      current.connection,
      { ...input(current.file), reportFile: current.reportFile },
      {},
      {
        rewrite: async (file, report) => writeFile(file, JSON.stringify(report)),
        item: {
          rewrite: async (file, report) => {
            await writeFile(file, JSON.stringify(report));
            if (!altered) {
              altered = true;
              current.graph.status = 'Unavailable';
            }
          },
        },
      },
    );
    expect(altered).to.equal(true);
    expect(result.report.summary.completed).to.equal(0);
    expect(current.calls.every((call) => call.method === 'GET')).to.equal(true);
  });
  it('does not mutate an eligible first member when a later whole-type member is unsupported', async () => {
    const current = await createFixture();
    const other = structuredClone(current.definition);
    other.identity.apiName = 'ZBlocked';
    other.title = 'Other title';
    other.contentBody['sfdc_cms:title'] = 'Other title';
    other.urlName = 'other-title';
    other.contentBody.asset = { ref: 'unresolved' };
    await writeFile(
      path.join(path.dirname(current.file), 'ZBlocked.cms-email-fragment.json'),
      JSON.stringify(other),
    );
    const result = await executeDeployBatch(current.connection, {
      ...input(current.file),
      sources: { 'source-dir': [path.dirname(current.file)], 'content-type': ['emailFragment'] },
    });
    expect(result.report.summary.selected).to.equal(2);
    expect(result.report.summary.completed).to.equal(0);
    expect(result.report.summary.unattempted).to.equal(2);
    expect(result.report.blockedReasons.join('; ')).to.match(/reference/u);
    expect(current.calls.every((call) => call.method === 'GET')).to.equal(true);
  });
  it('stops on uncertain mutation without replay', async () => {
    const current = await createFixture();
    current.failPost(new Error('connection lost after dispatch'));
    const result = await executeDeployBatch(current.connection, input(current.file));
    expect(result.report.summary.uncertain).to.equal(1);
    expect(result.report.summary.completed).to.equal(0);
    expect(current.calls.filter((call) => call.method !== 'GET')).to.have.length(1);
  });
});
