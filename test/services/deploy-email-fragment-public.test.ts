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
import DeployContent from '../../src/commands/cms/deploy/content.js';

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
        metadata,
      });
      expect(selected.items).to.have.length(1);
      expect(selected.items[0].contentBody).to.deep.equal(current.definition.contentBody);
      expect(selected.items[0].companionPaths).to.deep.equal([]);
      expect(selected.items[0].definition.identity.context.workspaceApiName).to.equal('Source');
    }
  });
  it('requires a destination API name for non-Fragment metadata and mixed selectors', async () => {
    for (const metadata of [['email'], ['emailFragment', 'email']]) {
      try {
        await selectDeploySources({ metadata });
        expect.fail('Expected non-Fragment destination name requirement');
      } catch (error) {
        expect((error as Error).message).to.include('resolved destination workspace API name');
      }
    }
  });

  it('retains mapped folders on repeated batch calls and rejects missing contextual evidence', async () => {
    const current = await fixture();
    const scope = {
      ...input(current.file),
      destinationFolderIds: { 'emailFragment:Welcome': '9Pu000000000002AAA' },
    };
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = await executeDeployBatch(current.connection, scope);
      expect(result.report.state).to.equal('blocked');
      expect(
        current.calls.some((call) =>
          call.url.includes('/connect/cms/folders/9Pu000000000002AAA?contextContentSpaceId='),
        ),
      ).to.equal(true);
    }
    expect(current.calls.every((call) => call.method === 'GET')).to.equal(true);
  });

  for (const depth of [0, 1, 2]) {
    it(`runs explicit-ID depth ${depth} CREATE then same-folder UPDATE and GET-only unchanged`, async () => {
      const current = await createFixture();
      const root = {
        id: String(current.workspace.rootFolderId),
        name: 'Destination',
        folderType: 'System',
        isShared: false,
      };
      const child = {
        id: '9Pu000000000002AAA',
        name: 'Child',
        folderType: 'Standard',
        isShared: false,
        parentFolderId: root.id,
      };
      const leaf = {
        id: '9Pu000000000003AAA',
        name: 'Leaf',
        folderType: 'Standard',
        isShared: false,
        parentFolderId: child.id,
      };
      current.folders[root.id] = { ...root, folderHierarchy: [] };
      current.folders[child.id] = { ...child, folderHierarchy: [root] };
      current.folders[leaf.id] = { ...leaf, folderHierarchy: [root, child] };
      const selected = [root, child, leaf][depth];
      current.definition.folderPath = ['Child', 'Leaf'].slice(0, depth);
      await current.save();
      const scope = {
        ...input(current.file),
        destinationFolderIds: { 'emailFragment:Welcome': selected.id },
      };
      const created = await executeDeployBatch(current.connection, scope);
      expect(created.report.summary.created, JSON.stringify(created.report)).to.equal(1);
      const post = current.calls.find((call) => call.method === 'POST')!;
      expect(JSON.parse(String(post.body)).contentSpaceOrFolderId).to.equal(selected.id);
      current.definition.contentBody['sfdc_cms:title'] = 'Updated body';
      await current.save();
      const updated = await executeDeployBatch(current.connection, scope);
      expect(updated.report.summary.updated, JSON.stringify(updated.report)).to.equal(1);
      const put = JSON.parse(String(current.calls.find((call) => call.method === 'PUT')!.body));
      expect(put).not.to.have.property('contentSpaceOrFolderId');
      expect(put).not.to.have.property('folder');
      const before = current.calls.length;
      const repeated = await executeDeployBatch(current.connection, scope);
      expect(repeated.report.summary.unchanged, JSON.stringify(repeated.report)).to.equal(1);
      expect(current.calls.slice(before).every((call) => call.method === 'GET')).to.equal(true);
      expect(current.calls.some((call) => call.url.includes('folder-items'))).to.equal(false);
    });
  }

  it('rejects equal-name native folder ID drift before writes and after UPDATE', async () => {
    for (const afterWrite of [false, true]) {
      const current = await fixture();
      const root = {
        id: String(current.workspace.rootFolderId),
        name: 'Destination',
        folderType: 'System',
        isShared: false,
      };
      const child = {
        id: '9Pu000000000002AAA',
        name: 'Child',
        folderType: 'Standard',
        isShared: false,
        parentFolderId: root.id,
      };
      const other = { ...child, id: '9Pu000000000003AAA' };
      current.folders[child.id] = { ...child, folderHierarchy: [root] };
      current.folders[other.id] = { ...other, folderHierarchy: [root] };
      current.definition.folderPath = ['Child'];
      current.detail.folder = { id: afterWrite ? child.id : other.id };
      current.parent.folder = structuredClone(current.detail.folder);
      await current.save();
      if (afterWrite)
        current.onRequest((method) => {
          if (method === 'PUT') {
            current.detail.folder = { id: other.id };
            current.parent.folder = { id: other.id };
          }
        });
      const result = await executeDeployBatch(current.connection, {
        ...input(current.file),
        destinationFolderIds: { 'emailFragment:Welcome': child.id },
      });
      expect(result.report.summary.completed, JSON.stringify(result.report)).to.equal(0);
      expect(current.calls.filter((call) => call.method !== 'GET')).to.have.length(
        afterWrite ? 1 : 0,
      );
    }
  });

  it('blocks fresh ancestry drift after durable intent and rejects post-CREATE equal-name ID drift without replay', async () => {
    for (const phase of ['before', 'after'] as const) {
      const current = await createFixture();
      const root = {
        id: String(current.workspace.rootFolderId),
        name: 'Destination',
        folderType: 'System',
        isShared: false,
      };
      const child = {
        id: '9Pu000000000002AAA',
        name: 'Child',
        folderType: 'Standard',
        isShared: false,
        parentFolderId: root.id,
      };
      const other = { ...child, id: '9Pu000000000003AAA' };
      current.folders[child.id] = { ...child, folderHierarchy: [root] };
      current.folders[other.id] = { ...other, folderHierarchy: [root] };
      current.definition.folderPath = ['Child'];
      await current.save();
      if (phase === 'after')
        current.onRequest((method) => {
          if (method === 'POST') {
            current.detail.folder = { id: other.id };
            current.parent.folder = { id: other.id };
          }
        });
      let altered = false;
      const result = await executeDeployBatch(
        current.connection,
        {
          ...input(current.file),
          reportFile: current.reportFile,
          destinationFolderIds: { 'emailFragment:Welcome': child.id },
        },
        {},
        {
          rewrite: async (file, report) => writeFile(file, JSON.stringify(report)),
          item: {
            rewrite: async (file, report) => {
              await writeFile(file, JSON.stringify(report));
              if (phase === 'before' && !altered) {
                altered = true;
                current.folders[child.id].isShared = true;
              }
            },
          },
        },
      );
      expect(result.report.summary.completed, JSON.stringify(result.report)).to.equal(0);
      expect(current.calls.filter((call) => call.method !== 'GET')).to.have.length(
        phase === 'after' ? 1 : 0,
      );
      if (phase === 'after') expect(result.report.summary.uncertain).to.equal(1);
      else expect(altered).to.equal(true);
    }
  });

  it('blocks the public v68 nested investigation before intent or mutation even with one match', async () => {
    const current = await createFixture();
    current.api('68.0');
    current.definition.folderPath = ['Child'];
    await current.save();
    const root = {
      id: String(current.workspace.rootFolderId),
      name: 'Root',
      folderType: 'System',
      isShared: false,
    };
    const childId = '9Pu000000000002AAA';
    current.folders[childId] = {
      id: childId,
      name: 'Child',
      folderType: 'Standard',
      isShared: false,
      parentFolderId: root.id,
      folderHierarchy: [root],
    };
    const original = current.connection.request.bind(current.connection);
    let pages = 0;
    current.connection.request = ((input: { method: string; url: string }, options?: unknown) => {
      if (input.url.includes('/folder-items')) {
        current.calls.push(structuredClone(input));
        const page = Number(new URL(input.url, 'https://example.invalid').searchParams.get('page'));
        pages++;
        return Promise.resolve({
          folderId: root.id,
          parentFolderId: null,
          folderItems:
            page === 1
              ? []
              : [
                  {
                    isFolder: true,
                    title: page === 0 ? 'Child' : 'Other',
                    managedContentOrFolderId: page === 0 ? childId : '9Pu000000000003AAA',
                    folderSummary: { folderType: 'Standard', isShared: false },
                  },
                ],
        });
      }
      return original(
        {
          ...input,
          url: input.url.replace('/services/data/v68.0/query', '/services/data/v67.0/query'),
        },
        options as never,
      );
    }) as typeof current.connection.request;
    const result = await executeDeployBatch(current.connection, input(current.file));
    expect(result.report.state).to.equal('blocked');
    expect(JSON.stringify(result)).to.include('no authoritative pagination completion contract');
    expect(pages).to.equal(3);
    expect(result.report).not.to.have.property('operations');
    expect(current.calls.every((call) => call.method === 'GET')).to.equal(true);
  });

  it('preserves optional subset mappings with unmapped root and blocks unmapped nested before any write', async () => {
    for (const nested of [false, true]) {
      const current = await createFixture();
      const root = {
        id: String(current.workspace.rootFolderId),
        name: 'Destination',
        folderType: 'System',
        isShared: false,
      };
      current.folders[root.id] = { ...root, folderHierarchy: [] };
      const other = structuredClone(current.definition);
      other.identity.apiName = 'Second';
      other.title = 'Other';
      other.urlName = 'other';
      other.contentBody['sfdc_cms:title'] = 'Other';
      other.folderPath = nested ? ['Child'] : [];
      await writeFile(
        path.join(path.dirname(current.file), 'Second.cms-email-fragment.json'),
        JSON.stringify(other),
      );
      const preview = await preflightDeployBatch(current.connection, {
        ...input(current.file),
        sources: { 'source-dir': [path.dirname(current.file)], 'content-type': ['emailFragment'] },
        destinationFolderIds: { 'emailFragment:Welcome': root.id },
      });
      expect(preview.eligible, JSON.stringify(preview)).to.equal(!nested);
      expect(current.calls.every((call) => call.method === 'GET')).to.equal(true);
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
    expect(await readdir(path.dirname(current.file))).to.deep.equal([
      '.sf-cms-run-owner',
      path.basename(current.file),
    ]);
  });
  it('discloses JSON-escaped derived Fragment titles in non-JSON command preview without mutations or reports', async () => {
    const current = await fixture();
    const sourceTitle = String.raw`Stale "A"\metadata`;
    const effectiveTitle = String.raw`Authored "B"\metadata`;
    current.definition.title = sourceTitle;
    current.definition.contentBody['sfdc_cms:title'] = effectiveTitle;
    await current.save();
    const directory = path.dirname(current.file);
    const filesBefore = await readdir(directory);
    const sourceBefore = await readFile(current.file, 'utf8');
    const lines: string[] = [];
    const execute = sinon.stub().throws(new Error('Preview must not execute mutations'));
    const instance = Object.create(DeployContent.prototype) as DeployContent;
    Object.assign(instance, {
      parse: async () => ({
        flags: {
          'target-org': { getUsername: () => 'offline-fixture' },
          'api-version': '67.0',
          'workspace-id': workspaceId,
          language: 'en_US',
          'default-language': false,
          'source-dir': [current.file],
          preview: true,
          report: false,
        },
      }),
      getOrgContext: async () => ({
        connection: current.connection,
        orgId: '00D000000000001AAA',
      }),
      resolveDestinationWorkspace: async () => ({ id: workspaceId, workspace: current.workspace }),
      selectSources: selectDeploySources,
      preflightBatch: preflightDeployBatch,
      executeBatch: execute,
      jsonEnabled: () => false,
      log: (line: string) => lines.push(line),
    });
    try {
      const result = await instance.run();
      expect(result.status, JSON.stringify(result)).to.equal('success');
      expect(lines).to.include('Item 1: update (unqualified)');
      expect(lines).to.include(
        `  Derived Fragment metadata: title ${JSON.stringify(sourceTitle)} -> ${JSON.stringify(effectiveTitle)}`,
      );
      expect(result.result!.preparation!.items[0].fragment).to.have.deep.property('envelope', {
        sourceTitle,
        effectiveTitle,
        derived: true,
      });
      expect(result.result!.report).to.equal(null);
      expect(result.result!.reportFile).to.equal(null);
      expect(execute.called).to.equal(false);
      expect(current.calls.length).to.be.greaterThan(0);
      expect(current.calls.every((call) => call.method === 'GET')).to.equal(true);
      expect(await readdir(directory)).to.deep.equal(filesBefore);
      expect(await readFile(current.file, 'utf8')).to.equal(sourceBefore);
    } finally {
      process.exitCode = undefined;
    }
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
      expect(result.report.blockedReasons.join('; ')).to.match(
        /variant|requires numeric CMS API 68.0|reference/u,
      );
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
