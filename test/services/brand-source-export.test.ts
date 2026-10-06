import type { Connection } from '@salesforce/core';
import sinon from 'sinon';
import ImportWorkspace from '../../src/commands/cms/import/workspace.js';
import { expect } from 'chai';
import { createHash } from 'node:crypto';
import { lstat, mkdtemp, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { exportWorkspace } from '../../src/services/export-workspace.js';
import { publishDirectoryNoClobber } from '../../src/services/atomic-publish.js';
import {
  BRAND_SOURCE_INVENTORY_PATH,
  replayBrandSourceInventoryEvidence,
  serializeBrandSourceInventoryEvidence,
} from '../../src/services/brand-source-inventory-evidence.js';
import { brandDetail } from '../fixtures/brand.js';
import {
  loadWorkspaceExport,
  getLoadedBrandSourceInventory,
  planSourceWorkspaceImport,
  revalidateSourceWorkspaceImport,
  executeWorkspaceImport,
  type SourceWorkspaceImportOptions,
} from '../../src/services/import-workspace.js';
import { loadSourceDefinitions } from '../../src/services/source-definition-import.js';
import type { WorkspaceExportManifest } from '../../src/contracts/workspace-export.js';
import {
  refreshBrandSourceInventory,
  assertBrandSourceRefreshProof,
  type BrandSourceRefreshOptions,
} from '../../src/services/brand-source-inventory-refresh.js';

const workspaceId = '0Zuaj000007dgL8CAI';
const parentId = '20Yaj00000EpKvtEAF';
const variantId = '9Psaj00000IF7YHCA1';
const orgId = '00Daj00000bRQabEAG';
const rawPath = `items/${variantId}.json`;
const reportPath = `reports/brands/${variantId}.json`;
const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
type Native = Record<string, unknown>;

function setup() {
  const raw: Native = {
    ...brandDetail(variantId, 'Phase_5_Discovery_Brand', workspaceId),
    managedContentId: parentId,
    folder: null,
  };
  const parent = { ...structuredClone(raw), contentVersion: 1, variantVersion: '1.1' };
  const search = {
    total: 1,
    items: [
      {
        type: 'ManagedContentVariantSearchResultRepresentation',
        id: variantId,
        managedContentSpaceId: workspaceId,
      },
    ],
  };
  const row = {
    attributes: {
      type: 'ManagedContentVariant',
      url: `/services/data/v67.0/sobjects/ManagedContentVariant/${variantId}`,
    },
    Id: variantId,
    ManagedContentId: parentId,
    Language: raw.language,
    IsPublished: false,
    ManagedContentVariantStatus: 'Draft',
    IsPrimary: true,
    Name: raw.title,
    UrlName: raw.urlName,
    ManagedContentKey: raw.contentKey,
    ManagedContent: {
      attributes: {
        type: 'ManagedContent',
        url: `/services/data/v67.0/sobjects/ManagedContent/${parentId}`,
      },
      AuthoredManagedContentSpaceId: workspaceId,
      ApiName: raw.apiName,
    },
  };
  const full = { totalSize: 1, done: true, records: [row] };
  const empty = { totalSize: 0, done: true, records: [] };
  const count = {
    totalSize: 1,
    done: true,
    records: [
      { attributes: { type: 'AggregateResult' }, ManagedContentId: parentId, siblingCount: 1 },
    ],
  };
  const responses: unknown[] = [
    search,
    raw,
    {
      id: workspaceId,
      name: 'Content Workspace for Marketing Cloud',
      apiName: 'Default_Content_Workspace',
    },
    full,
    empty,
    count,
    parent,
    structuredClone(raw),
    structuredClone(full),
    empty,
    count,
  ];
  const calls: { method: string; url: string; options: unknown; refresh: unknown }[] = [];
  const connection = {
    _refreshDelegate: {},
    getApiVersion: () => '67.0',
    getAuthInfoFields: () => ({ orgId }),
    request(
      this: { _refreshDelegate?: unknown },
      request: { method: string; url: string },
      options: unknown,
    ) {
      calls.push({ ...request, options, refresh: this._refreshDelegate });
      const response = responses.shift();
      if (response instanceof Error) return Promise.reject(response);
      return Promise.resolve(structuredClone(response));
    },
  };
  return { raw, parent, search, row, responses, calls, connection };
}
const queueRefresh = (live: ReturnType<typeof setup>) => {
  const next = setup();
  live.responses.push(...next.responses.slice(2));
};
async function failure(operation: Promise<unknown>): Promise<Error> {
  try {
    await operation;
  } catch (error) {
    return error as Error;
  }
  throw new Error('Expected rejection');
}
async function absent(target: string): Promise<boolean> {
  try {
    await lstat(target);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
    throw error;
  }
}

describe('Brand source export canonical persistence', () => {
  let root: string;
  let baseline: string;
  let definitions: string;
  beforeEach(async () => {
    // Retained run-owned OS-temp fixtures; no recursive cleanup.
    root = await mkdtemp(path.join(os.tmpdir(), 'cms-brand-source-export-'));
    baseline = path.join(root, 'baseline');
    definitions = path.join(root, 'definitions');
  });
  const options = () => ({
    sourceOrgId: orgId,
    generatedAt: '2026-10-05T10:43:00.000Z',
    pluginVersion: '0.9.0',
    definitionDirectory: definitions,
    selection: {
      contentType: 'sfdc_cms__brand',
      apiNames: ['Phase_5_Discovery_Brand'],
      brandReports: true,
    },
  });
  const run = (fixture: ReturnType<typeof setup>, extra = {}) =>
    exportWorkspace(fixture.connection as unknown as Connection, workspaceId, baseline, {
      ...options(),
      ...extra,
    });

  const plannerOptions = (
    source: SourceWorkspaceImportOptions['source'],
    live: ReturnType<typeof setup>,
  ): SourceWorkspaceImportOptions => ({
    source,
    sourceConnection: live.connection as unknown as BrandSourceRefreshOptions['sourceConnection'],
    sourceOrgId: orgId,
    definitionDirectory: definitions,
    workspaceId: '0Zufj000006rx4wCAA',
    destinationWorkspace: {
      id: '0Zufj000006rx4wCAA',
      rootFolderId: '9Pufj000006rx4wCAA',
      defaultLanguage: 'en_US',
    },
    brandMappings: [
      {
        source: { family: 'cms', type: 'brand', apiName: 'Phase_5_Discovery_Brand' },
        target: { apiName: 'Fresh_Brand', title: 'Fresh Brand', urlName: 'fresh-brand' },
      },
    ],
  });
  for (const scenario of [
    'collision',
    'empty-terminal',
    'short-terminal',
    'duplicate',
    'workspace',
    'detail-id',
  ] as const) {
    it(`exhausts the extra Brand-family inventory: ${scenario}`, async () => {
      const fixture = setup();
      await run(fixture);
      const live = setup();
      live.responses.splice(0, 2);
      queueRefresh(live);
      const planned = plannerOptions(
        await loadWorkspaceExport(baseline, { profile: 'brand-source' }),
        live,
      );
      const pages: number[] = [];
      let posts = 0;
      const target = {
        request: sinon
          .stub()
          .callsFake(async ({ method, url }: { method: string; url: string }) => {
            if (method === 'POST') {
              posts += 1;
              throw new Error('Unexpected POST');
            }
            if (url.includes('/items/search')) {
              const query = new URL(url, 'https://cms.test').searchParams;
              // The workspace-wide check is independently covered; exercise the extra family pass.
              if (!query.has('contentTypeFQN')) return { count: 0, items: [] };
              expect(query.get('contentTypeFQN')).to.equal('sfdc_cms__brand');
              const page = Number(query.get('page'));
              pages.push(page);
              let ids: string[] = [];
              if (page === 0) ids = Array.from({ length: 250 }, (_, index) => `brand-${index}`);
              else if (scenario !== 'empty-terminal')
                ids = [scenario === 'duplicate' ? 'brand-0' : 'late'];
              return {
                count: ids.length,
                items: ids.map((id) => ({
                  id,
                  type: 'ManagedContentVariantSearchResultRepresentation',
                  managedContentSpaceId:
                    scenario === 'workspace' && page === 1 ? 'other' : planned.workspaceId,
                })),
              };
            }
            const id = url.split('/').at(-1)!;
            return {
              managedContentVariantId: scenario === 'detail-id' && id === 'late' ? 'wrong' : id,
              managedContentId: `parent-${id}`,
              contentSpace: { id: planned.workspaceId },
              contentType: { fullyQualifiedName: 'sfdc_cms__brand' },
              apiName: scenario === 'collision' && id === 'late' ? 'Fresh_Brand' : `Other-${id}`,
              title: `Other title-${id}`,
              urlName: `other-url-${id}`,
            };
          }),
      };
      const operation = executeWorkspaceImport({
        ...planned,
        sourceDirectory: baseline,
        loadedSource: planned.source,
        connection: target,
        destinationOrgId: 'target-org',
        dryRun: true,
      });
      if (scenario === 'empty-terminal' || scenario === 'short-terminal') {
        const result = await operation;
        expect(result.dryRun).to.equal(true);
      } else {
        const error = await failure(operation);
        expect(error.message).to.match(/collision|identity|workspace|scope/u);
      }
      expect(pages).to.deep.equal([0, 1]);
      expect(posts).to.equal(0);
    });
  }

  for (const mode of [
    'apply',
    'command',
    'auth',
    'source-drift',
    'file-drift',
    'root-drift',
    'journal-file-drift',
    'readback-root',
    'uncertain',
  ] as const) {
    it(`wires authenticated Brand source CREATE with final acquisition gate: ${mode}`, async () => {
      const fixture = setup();
      const exported = await run(fixture);
      const originalFiles = new Map<string, Buffer>();
      for (const file of ['manifest.json', ...exported.manifest.items.map((item) => item.path)])
        originalFiles.set(file, await readFile(path.join(baseline, file)));
      const live = setup();
      live.responses.splice(0, 2);
      queueRefresh(live);
      const planned = plannerOptions(
        await loadWorkspaceExport(baseline, { profile: 'brand-source' }),
        live,
      );
      let posted: Native | undefined;
      let posts = 0;
      const target = {
        request: sinon
          .stub()
          .callsFake(({ method, url, body }: { method: string; url: string; body?: string }) => {
            const response = async (): Promise<unknown> => {
              if (method === 'POST') {
                posts += 1;
                posted = JSON.parse(body!) as Native;
                if (mode === 'uncertain') throw new Error('CREATE uncertain');
                return {
                  contentKey: 'generated',
                  managedContentId: 'new-parent',
                  managedContentVariantId: 'new-variant',
                };
              }
              if (url.includes('/items/search')) return { count: 0, total: 0, items: [] };
              if (url.includes('/spaces/')) {
                if (live.responses.length === 9) {
                  if (mode === 'source-drift')
                    live.responses[1] = {
                      totalSize: 1,
                      done: true,
                      records: [{ ...live.row, Language: 'fr' }],
                    };
                  if (mode === 'file-drift') {
                    const file = path.join(
                      definitions,
                      'cms/Default_Content_Workspace/brand/Phase_5_Discovery_Brand.cms-brand.json',
                    );
                    await writeFile(file, '{}');
                  }
                }
                return {
                  ...(planned.destinationWorkspace as Native),
                  spaceType: { apiName: 'Marketing' },
                };
              }
              return {
                ...fixture.raw,
                apiName: 'Fresh_Brand',
                title: 'Fresh Brand',
                urlName: 'fresh-brand',
                contentBody: posted?.contentBody,
                managedContentId: 'new-parent',
                managedContentVariantId: 'new-variant',
                contentKey: 'generated',
                contentSpace: { id: planned.workspaceId },
                folder: {
                  id:
                    mode === 'readback-root'
                      ? 'wrong-root'
                      : (planned.destinationWorkspace as Native).rootFolderId,
                },
              };
            };
            return Object.assign(response(), { stream: () => ({ destroy: () => {} }) });
          }),
      };
      if (mode === 'auth') live.connection.getAuthInfoFields = () => ({ orgId: 'wrong' });
      // Mutation while source acquisition is awaited must be caught by the final local gate.
      if (mode === 'root-drift') {
        const request = live.connection.request;
        live.connection.request = function (...args: Parameters<typeof request>) {
          if (live.responses.length === 1) {
            const file = path.join(baseline, 'manifest.json');
            return readFile(file, 'utf8').then(async (bytes) => {
              await writeFile(file, bytes + '\n');
              return request.apply(this, args);
            });
          }
          return request.apply(this, args);
        };
      }
      const reportDirectory = path.join(root, 'apply-report');
      if (mode === 'command') {
        const map = path.join(root, 'brand-map.json');
        await writeFile(map, JSON.stringify(planned.brandMappings));
        const context = sinon.stub();
        context.onFirstCall().resolves({ connection: target, orgId: 'target-org' });
        context.onSecondCall().resolves({ connection: live.connection, orgId });
        const command = Object.create(ImportWorkspace.prototype) as ImportWorkspace;
        Object.assign(command, {
          parse: sinon.stub().resolves({
            flags: {
              'target-org': 'target-alias',
              'source-org': 'source-alias',
              'api-version': '67.0',
              'source-dir': baseline,
              'definition-dir': definitions,
              'brand-map': map,
              'workspace-id': planned.workspaceId,
              apply: true,
              'report-dir': reportDirectory,
            },
          }),
          getOrgContext: context,
          jsonEnabled: () => true,
        });
        const result = await command.run();
        process.exitCode = undefined;
        expect(result.status, JSON.stringify(result.diagnostics)).to.equal('success');
        expect(context.firstCall.args).to.deep.equal(['target-alias', '67.0']);
        expect(context.secondCall.args).to.deep.equal(['source-alias', '67.0']);
      } else {
        const operation = executeWorkspaceImport({
          ...planned,
          sourceDirectory: baseline,
          loadedSource: planned.source,
          connection: target,
          destinationOrgId: 'target-org',
          reportDirectory,
          ...(mode === 'journal-file-drift'
            ? {
                reportPersistence: {
                  rewrite: async (file: string, report: unknown) => {
                    await writeFile(file, JSON.stringify(report));
                    const value = report as { brandSource?: { acquiredAt: string } };
                    if (value.brandSource && live.calls.length === 18) {
                      // Source refresh is complete; changing files during the last awaited journal write must block POST.
                      await writeFile(
                        path.join(
                          definitions,
                          'cms/Default_Content_Workspace/brand/Phase_5_Discovery_Brand.cms-brand.json',
                        ),
                        '{}',
                      );
                    }
                  },
                },
              }
            : {}),
        });
        await (mode === 'apply' ? operation : failure(operation));
      }
      expect(posts).to.equal(
        ['apply', 'command', 'readback-root', 'uncertain'].includes(mode) ? 1 : 0,
      );
      if (mode === 'apply' || mode === 'command') {
        expect(posted!.contentSpaceOrFolderId).to.equal(
          (planned.destinationWorkspace as Native).rootFolderId,
        );
        expect(posted).not.to.have.property('contentKey');
        expect(posted!.apiName).to.equal('Fresh_Brand');
        for (const [file, bytes] of originalFiles) {
          const retained = await readFile(path.join(baseline, file));
          expect(retained).to.deep.equal(bytes);
          expect(hash(retained)).to.equal(hash(bytes));
        }
        const definitionsLoaded = await loadSourceDefinitions(planned.source, definitions);
        expect(definitionsLoaded.originals[0].workspaceApiName).to.equal(
          'Default_Content_Workspace',
        );
        expect(definitionsLoaded.edits.entries[0].definitionPath).to.equal(
          'cms/Default_Content_Workspace/brand/Phase_5_Discovery_Brand.cms-brand.json',
        );
        const journal = JSON.parse(
          await readFile(path.join(reportDirectory, 'workspace-import-run.json'), 'utf8'),
        ) as Native;
        expect(journal.state).to.equal('completed');
        expect(journal.brandSource).to.include({
          sourceOrgId: orgId,
          sourceWorkspaceId: workspaceId,
          historicalArtifactSha256: getLoadedBrandSourceInventory(planned.source).artifactSha256,
        });
        expect(live.calls).to.have.length(18);
      }
      if (mode === 'uncertain') {
        const journal = JSON.parse(
          await readFile(path.join(reportDirectory, 'workspace-import-run.json'), 'utf8'),
        ) as Native;
        expect(journal.state).to.equal('ownership-uncertain');
      }
    });
  }

  it('plans and repeatedly live-revalidates Brand source with pinned candidate payload', async () => {
    const fixture = setup();
    await run(fixture);
    const source = await loadWorkspaceExport(baseline, { profile: 'brand-source' });
    const live = setup();
    live.responses.splice(0, 2);
    const intent = await planSourceWorkspaceImport(plannerOptions(source, live));
    expect(live.calls).to.have.length(9);
    const proposal = structuredClone(intent.proposal);
    expect(intent.sourceDefinitions.originals[0].raw.contentBody).to.deep.equal(
      fixture.raw.contentBody,
    );
    expect(intent.proposal.items[0].contentBody).to.deep.equal({
      ...(fixture.raw.contentBody as Native),
      'sfdc_cms:title': 'Fresh Brand',
    });
    expect(intent.source.manifest.warnings).to.deep.equal(source.manifest.warnings);
    for (let repeat = 0; repeat < 2; repeat += 1) {
      queueRefresh(live);
      await revalidateSourceWorkspaceImport(intent);
      expect(intent.proposal).to.deep.equal(proposal);
    }
    expect(live.calls).to.have.length(27);
    expect(live.calls.every((call) => call.method === 'GET')).to.equal(true);
    const copiedError = await failure(revalidateSourceWorkspaceImport(structuredClone(intent)));
    expect(copiedError.message).to.match(/not planned/u);
    (intent.proposal.items[0].contentBody as Native)['sfdc_cms:title'] = 'Forged';
    const modifiedError = await failure(revalidateSourceWorkspaceImport(intent));
    expect(modifiedError.message).to.match(/modified/u);
    expect(live.calls).to.have.length(27);
  });

  for (const mode of [
    'missing',
    'option-org',
    'auth-org',
    'api',
    'copied-source',
    'modified-source',
  ]) {
    it(`rejects Brand planner ${mode} before any source request`, async () => {
      await run(setup());
      const source = await loadWorkspaceExport(baseline, { profile: 'brand-source' });
      const live = setup();
      const options = plannerOptions(source, live);
      if (mode === 'auth-org') live.connection.getAuthInfoFields = () => ({ orgId: 'wrong' });
      if (mode === 'api') live.connection.getApiVersion = () => '66.0';
      if (mode === 'modified-source') source.manifest.warnings.splice(0);
      await failure(
        planSourceWorkspaceImport({
          ...options,
          ...(mode === 'missing' ? { sourceConnection: undefined } : {}),
          ...(mode === 'option-org' ? { sourceOrgId: 'wrong' } : {}),
          ...(mode === 'copied-source' ? { source: structuredClone(source) } : {}),
        }),
      );
      expect(live.calls).to.have.length(0);
    });
  }

  for (const stage of ['plan', 'revalidate']) {
    for (const drift of ['sibling', 'body', 'auth', 'api', 'definition']) {
      it(`blocks ${stage} on ${drift} drift with zero POST`, async () => {
        await run(setup());
        const source = await loadWorkspaceExport(baseline, { profile: 'brand-source' });
        const live = setup();
        live.responses.splice(0, 2);
        const options = plannerOptions(source, live);
        const intent =
          stage === 'revalidate' ? await planSourceWorkspaceImport(options) : undefined;
        if (intent !== undefined) queueRefresh(live);
        if (drift === 'sibling') (live.responses[1] as Native).totalSize = 2;
        if (drift === 'body') live.responses[5] = { ...live.raw, contentBody: {} };
        if (drift === 'auth') live.connection.getAuthInfoFields = () => ({ orgId: 'wrong' });
        if (drift === 'api') live.connection.getApiVersion = () => '66.0';
        if (drift === 'definition') {
          const file = path.join(
            definitions,
            'cms/Default_Content_Workspace/brand/Phase_5_Discovery_Brand.cms-brand.json',
          );
          const candidate = JSON.parse(await readFile(file, 'utf8')) as Native;
          (candidate.contentBody as Native).baseFontFamily = 'Changed';
          await writeFile(file, JSON.stringify(candidate));
        }
        await failure(
          intent === undefined
            ? planSourceWorkspaceImport(options)
            : revalidateSourceWorkspaceImport(intent),
        );
        expect(live.calls.every((call) => call.method === 'GET')).to.equal(true);
      });
    }
  }

  for (const boundary of [
    'root',
    'language',
    'api-collision',
    'title-collision',
    'url-collision',
  ]) {
    it(`retains Brand source ${boundary} admission restrictions`, async () => {
      await run(setup());
      const source = await loadWorkspaceExport(baseline, { profile: 'brand-source' });
      const live = setup();
      live.responses.splice(0, 2);
      const options = plannerOptions(source, live);
      const destination = options.destinationWorkspace as Native;
      const mapping = (options.brandMappings as { target: Native }[])[0];
      if (boundary === 'root') destination.rootFolderId = '';
      if (boundary === 'language') destination.defaultLanguage = 'de_DE';
      if (boundary === 'api-collision') mapping.target.apiName = source.items[0].apiName;
      if (boundary === 'title-collision') mapping.target.title = source.items[0].title;
      if (boundary === 'url-collision') mapping.target.urlName = source.items[0].urlName;
      await failure(planSourceWorkspaceImport(options));
      expect(live.calls.every((call) => call.method === 'GET')).to.equal(true);
    });
  }

  it('refreshes authenticated original Brand proof without rewriting historical bytes', async () => {
    await run(setup());
    const source = await loadWorkspaceExport(baseline, { profile: 'brand-source' });
    const historical = getLoadedBrandSourceInventory(source);
    const bytes = await readFile(path.join(baseline, BRAND_SOURCE_INVENTORY_PATH));
    const live = setup();
    live.responses.splice(0, 2);
    const proof = await refreshBrandSourceInventory(source, {
      sourceConnection: live.connection as unknown as BrandSourceRefreshOptions['sourceConnection'],
      sourceOrgId: orgId,
    });
    expect(proof.sourceManifestSha256).to.equal(source.manifestSha256);
    expect(proof.historicalArtifactSha256).to.equal(historical.artifactSha256);
    expect(proof.sourceOrgId).to.equal(orgId);
    expect(proof.sourceApiVersion).to.equal('67.0');
    expect(proof.sourceWorkspaceId).to.equal(workspaceId);
    expect(proof.refreshedArtifactSha256).to.match(/^[a-f0-9]{64}$/u);
    expect(live.calls).to.have.length(9);
    expect(live.calls.every((call) => call.method === 'GET')).to.equal(true);
    expect(getLoadedBrandSourceInventory(source)).to.deep.equal(historical);
    expect(await readFile(path.join(baseline, BRAND_SOURCE_INVENTORY_PATH))).to.deep.equal(bytes);
    expect(() => assertBrandSourceRefreshProof(proof)).not.to.throw();
    expect(() => assertBrandSourceRefreshProof(structuredClone(proof))).to.throw(/not acquired/u);
    (proof as { sourceOrgId: string }).sourceOrgId = '00Dfj00000bRQabEAG';
    expect(() => assertBrandSourceRefreshProof(proof)).to.throw(/modified/u);
  });

  it('rejects missing or wrong independent source org/API before any request', async () => {
    await run(setup());
    const source = await loadWorkspaceExport(baseline, { profile: 'brand-source' });
    for (const mode of ['missing', 'option-org', 'auth-org', 'api']) {
      const live = setup();
      if (mode === 'auth-org')
        live.connection.getAuthInfoFields = () => ({ orgId: '00Dfj00000bRQabEAG' });
      if (mode === 'api') live.connection.getApiVersion = () => '66.0';
      const error = await failure(
        refreshBrandSourceInventory(source, {
          sourceConnection: (mode === 'missing'
            ? undefined
            : live.connection) as unknown as BrandSourceRefreshOptions['sourceConnection'],
          sourceOrgId: mode === 'option-org' ? '00Dfj00000bRQabEAG' : orgId,
        }),
      );
      expect(error.message).to.match(/authenticated source org\/API/u);
      expect(live.calls).to.have.length(0);
    }
  });

  it('stops GET-only refresh on sibling, native body, parent, workspace and authentication drift', async () => {
    await run(setup());
    const source = await loadWorkspaceExport(baseline, { profile: 'brand-source' });
    for (const mode of ['sibling', 'body', 'parent', 'workspace', 'authentication']) {
      const live = setup();
      live.responses.splice(0, 2);
      if (mode === 'sibling') (live.responses[1] as Native).totalSize = 2;
      if (mode === 'body') live.responses[5] = { ...live.raw, contentBody: {} };
      if (mode === 'parent')
        (live.responses[4] as Native).lastModifiedDate = '2026-10-05T12:00:00.000Z';
      if (mode === 'workspace') (live.responses[0] as Native).name = 'Changed';
      if (mode === 'authentication') live.responses[1] = new Error('Authentication failed');
      await failure(
        refreshBrandSourceInventory(source, {
          sourceConnection:
            live.connection as unknown as BrandSourceRefreshOptions['sourceConnection'],
          sourceOrgId: orgId,
        }),
      );
      expect(live.calls.every((call) => call.method === 'GET')).to.equal(true);
      expect(getLoadedBrandSourceInventory(source).sourceManifestSha256).to.equal(
        source.manifestSha256,
      );
    }
  });

  it('publishes real canonical proof hashes and original search records with sole warning unchanged', async () => {
    const fixture = setup();
    const result = await run(fixture);
    expect(result.manifest.schemaVersion).to.equal(1);
    expect(result.manifest.contractVersion).to.equal('1.0.0');
    expect(result.manifest.warnings).to.deep.equal([
      {
        code: 'UNSUPPORTED_WILDCARD',
        message: 'Wildcard search is unsupported and this export is experimental best-effort.',
      },
    ]);
    const bytes = await readFile(path.join(baseline, BRAND_SOURCE_INVENTORY_PATH));
    const proof = JSON.parse(bytes.toString()) as Parameters<
      typeof serializeBrandSourceInventoryEvidence
    >[0];
    expect(bytes.toString()).to.equal(serializeBrandSourceInventoryEvidence(proof));
    expect(
      result.manifest.items.find((item) => item.path === BRAND_SOURCE_INVENTORY_PATH),
    ).to.deep.equal({
      path: BRAND_SOURCE_INVENTORY_PATH,
      kind: 'cms.brand-source-inventory',
      sha256: hash(bytes),
    });
    expect(proof.source.orgId).to.equal(orgId);
    expect(proof.source.apiVersion).to.equal('67.0');
    expect(Object.keys(proof)).not.to.include('manifestSha256');
    for (const item of result.manifest.items)
      expect(hash(await readFile(path.join(baseline, item.path)))).to.equal(item.sha256);
    const historical = JSON.parse(
      await readFile(path.join(baseline, 'evidence/source-admission.v1.json'), 'utf8'),
    ) as { inventory: { pages: unknown[] } };
    expect(historical.inventory.pages).to.deep.equal([{ page: 0, response: fixture.search }]);
    const originals = replayBrandSourceInventoryEvidence(
      proof,
      result.manifest,
      new Map([
        [rawPath, JSON.parse(await readFile(path.join(baseline, rawPath), 'utf8')) as Native],
      ]),
      new Map([
        [reportPath, JSON.parse(await readFile(path.join(baseline, reportPath), 'utf8')) as Native],
      ]),
    );
    expect(originals).to.have.length(1);
    const definition = JSON.parse(
      await readFile(
        path.join(
          definitions,
          'cms/Default_Content_Workspace/brand/Phase_5_Discovery_Brand.cms-brand.json',
        ),
        'utf8',
      ),
    ) as Native;
    expect(definition.contentBody).to.deep.equal(fixture.raw.contentBody);
    expect(definition.identity).to.have.nested.property(
      'context.workspaceApiName',
      'Default_Content_Workspace',
    );
    expect(proof.workspace).to.include({
      name: 'Content Workspace for Marketing Cloud',
      apiName: 'Default_Content_Workspace',
    });
    expect(originals[0].workspaceApiName).to.equal('Default_Content_Workspace');
    expect(fixture.calls).to.have.length(11);
    expect(fixture.calls.every((call) => call.method === 'GET')).to.equal(true);
    for (const call of fixture.calls.slice(2)) {
      expect(call.refresh).to.equal(undefined);
      expect(call.options).to.deep.equal({ retry: { maxRetries: 0 }, timeout: 30_000 });
    }
  });

  it('loads actual export through explicit source profile with detached historical proof', async () => {
    const fixture = setup();
    await run(fixture);
    const loaded = await loadWorkspaceExport(baseline, { profile: 'brand-source' });
    const proof = getLoadedBrandSourceInventory(loaded);
    expect(proof.sourceManifestSha256).to.equal(loaded.manifestSha256);
    expect(proof.artifactSha256).to.equal(
      hash(await readFile(path.join(baseline, BRAND_SOURCE_INVENTORY_PATH))),
    );
    expect(proof.evidence.source).to.include({ orgId, apiVersion: '67.0' });
    expect(proof.evidence.selections[0].parent).to.deep.equal(fixture.parent);
    const source = await loadSourceDefinitions(loaded, definitions);
    expect(source.originals[0].raw).to.deep.equal(fixture.raw);
    expect(source.originals[0].workspaceApiName).to.equal('Default_Content_Workspace');
    expect(source.edits.entries[0].definitionPath).to.equal(
      'cms/Default_Content_Workspace/brand/Phase_5_Discovery_Brand.cms-brand.json',
    );
    expect(source.brandSourceInventory).to.deep.equal(proof);
    expect(source.edits.entries[0].changed).to.equal(false);
    Object.assign(proof.evidence.selections[0].parent, { title: 'Detached' });
    expect(getLoadedBrandSourceInventory(loaded).evidence.selections[0].parent.title).to.equal(
      fixture.raw.title,
    );
    expect(() => getLoadedBrandSourceInventory(structuredClone(loaded))).to.throw(
      /explicit brand-source/u,
    );
    expect(await failure(loadWorkspaceExport(baseline, { profile: 'brand' })))
      .to.have.property('message')
      .that.matches(/no warnings/u);
    loaded.manifest.warnings.splice(0);
    expect(() => getLoadedBrandSourceInventory(loaded)).to.throw(/unchanged/u);
  });

  for (const problem of [
    'wrong kind',
    'wrong path',
    'wrong sha',
    'raw bytes',
    'report bytes',
    'canonical count',
    'duplicate JSON',
    'duplicate manifest JSON',
    'evidence BOM',
    'evidence UTF8',
    'unknown warning',
    'duplicate raw JSON',
    'duplicate report JSON',
    'unknown evidence',
    'raw identity',
    'report identity',
    'report descriptor',
    'source org',
    'source API',
    'workspace',
    'parent',
    'recheck',
    'missing artifact',
    'missing warning',
    'extra warning',
    'duplicate warning',
    'warning message',
    'warning variants',
    'partial',
    'failed',
    'rejected',
  ]) {
    it(`rejects source load with ${problem} in actual export`, async () => {
      await run(setup());
      const manifest = JSON.parse(
        await readFile(path.join(baseline, 'manifest.json'), 'utf8'),
      ) as WorkspaceExportManifest;
      const artifact = manifest.items.find((item) => item.path === BRAND_SOURCE_INVENTORY_PATH)!;
      const replace = async (file: string, bytes: string) => {
        await writeFile(path.join(baseline, file), bytes);
        manifest.items.find((item) => item.path === file)!.sha256 = hash(bytes);
      };
      const proof = JSON.parse(
        await readFile(path.join(baseline, artifact.path), 'utf8'),
      ) as Parameters<typeof serializeBrandSourceInventoryEvidence>[0];
      if (problem === 'wrong kind') artifact.kind = 'cms.source-admission';
      if (problem === 'wrong path') {
        await rename(
          path.join(baseline, artifact.path),
          path.join(baseline, 'evidence/wrong.json'),
        );
        artifact.path = 'evidence/wrong.json';
      }
      if (problem === 'wrong sha') artifact.sha256 = '0'.repeat(64);
      if (problem === 'raw bytes') await writeFile(path.join(baseline, rawPath), '{}');
      if (problem === 'report bytes') await writeFile(path.join(baseline, reportPath), '{}');
      if (problem === 'canonical count')
        Object.assign(proof.selections[0].inventory.countResponse, { records: [] });
      if (problem === 'unknown evidence') Object.assign(proof, { unexpected: true });
      if (problem === 'source org') Object.assign(proof.source, { orgId: '00Dfj00000bRQabEAG' });
      if (problem === 'source API') Object.assign(proof.source, { apiVersion: '66.0' });
      if (problem === 'workspace') Object.assign(proof.workspace, { id: '0Zufj000006rx4wCAA' });
      if (problem === 'parent') Object.assign(proof.selections[0].parent, { title: 'Changed' });
      if (problem === 'recheck')
        Object.assign(proof.selections[0].inventory.recheck.countResponse, { records: [] });
      if (
        [
          'canonical count',
          'unknown evidence',
          'source org',
          'source API',
          'workspace',
          'parent',
          'recheck',
        ].includes(problem)
      )
        await replace(artifact.path, JSON.stringify(proof));
      if (problem === 'duplicate JSON')
        await replace(
          artifact.path,
          JSON.stringify(proof).replace('{', '{"contract":"sf-cms-brand-source-inventory",'),
        );
      for (const [label, file] of [
        ['raw', rawPath],
        ['report', reportPath],
      ]) {
        if (problem === `duplicate ${label} JSON`) {
          const text = await readFile(path.join(baseline, file), 'utf8');
          await replace(file, text.replace('{', '{"duplicate":1,"duplicate":2,'));
        }
        if (problem === `${label} identity`) {
          const record = JSON.parse(await readFile(path.join(baseline, file), 'utf8')) as Native;
          record.apiName = 'Changed';
          await replace(file, JSON.stringify(record));
        }
      }
      if (problem === 'report descriptor') manifest.brandReports![0].apiName = 'Changed';
      if (problem === 'missing artifact') {
        await rename(
          path.join(baseline, artifact.path),
          path.join(baseline, 'evidence/missing.json'),
        );
        artifact.kind = 'cms.unrelated';
        artifact.path = 'evidence/missing.json';
      }
      if (problem === 'missing warning') manifest.warnings.splice(0);
      if (problem === 'extra warning')
        manifest.warnings.push({ code: 'COUNT_MISMATCH', message: 'Unknown' });
      if (problem === 'duplicate warning')
        manifest.warnings.push(structuredClone(manifest.warnings[0]));
      if (problem === 'warning message') manifest.warnings[0].message = 'Changed';
      if (problem === 'warning variants') manifest.warnings[0].variantIds = [variantId];
      if (problem === 'partial') manifest.completeness = 'partial';
      if (problem === 'failed') manifest.failedVariantIds.push(variantId);
      if (problem === 'rejected') manifest.rejectedVariantIds.push(variantId);
      if (problem === 'evidence BOM')
        await replace(artifact.path, `\uFEFF${JSON.stringify(proof)}`);
      if (problem === 'evidence UTF8') {
        const bytes = Buffer.from([255]);
        await writeFile(path.join(baseline, artifact.path), bytes);
        artifact.sha256 = hash(bytes);
      }
      if (problem === 'unknown warning') Object.assign(manifest.warnings[0], { code: 'UNKNOWN' });
      let manifestText = JSON.stringify(manifest);
      if (problem === 'duplicate manifest JSON')
        manifestText = manifestText.replace('{', '{"workspaceId":"wrong",');
      await writeFile(path.join(baseline, 'manifest.json'), manifestText);
      expect(
        await failure(
          loadWorkspaceExport(baseline, { profile: 'brand-source', allowPartial: true }),
        ),
      ).to.be.instanceOf(Error);
    });
  }

  it('rejects an old Brand baseline without canonical inventory with actionable error', async () => {
    const fixture = setup();
    fixture.responses.splice(2);
    await run(fixture, { definitionDirectory: undefined });
    const error = await failure(loadWorkspaceExport(baseline, { profile: 'brand-source' }));
    expect(error.message).to.match(/inventory evidence unavailable.*re-export/u);
  });

  for (const problem of [
    'inventory drift',
    'GET body drift',
    'source org mismatch',
    'source ownership mismatch',
  ]) {
    it(`rejects ${problem} before baseline or definitions publication`, async () => {
      const fixture = setup();
      if (problem === 'inventory drift')
        ((fixture.responses[8] as Native).records as Native[])[0].Name = 'Changed';
      if (problem === 'GET body drift') fixture.responses[7] = { ...fixture.raw, title: 'Changed' };
      if (problem === 'source org mismatch')
        fixture.connection.getAuthInfoFields = () => ({ orgId: '00Dfj00000bRQabEAG' });
      if (problem === 'source ownership mismatch')
        fixture.row.ManagedContent.AuthoredManagedContentSpaceId = '0Zufj000006rx4wCAA';
      expect(await failure(run(fixture))).to.be.instanceOf(Error);
      expect(await absent(baseline)).to.equal(true);
      expect(await absent(definitions)).to.equal(true);
      expect(await readdir(root)).to.deep.equal([]);
      expect(fixture.calls.every((call) => call.method === 'GET')).to.equal(true);
    });
  }

  for (const changedPath of [
    rawPath,
    reportPath,
    BRAND_SOURCE_INVENTORY_PATH,
    'manifest.json',
    'unlisted.json',
  ]) {
    it(`retains baseline but blocks definitions after publication tampering: ${changedPath}`, async () => {
      const fixture = setup();
      const error = await failure(
        run(fixture, {
          atomicPublish: {
            publishPath: async (temporary: string, target: string) => {
              await publishDirectoryNoClobber(temporary, target);
              await writeFile(path.join(target, changedPath), '{}\n');
            },
          },
        }),
      );
      expect(error.message).to.include('Baseline export retained');
      expect(await absent(baseline)).to.equal(false);
      expect(await absent(definitions)).to.equal(true);
    });
  }

  it('blocks additional discovery warnings before canonical acquisition or publication', async () => {
    const fixture = setup();
    fixture.search.items.push(structuredClone(fixture.search.items[0]));
    expect(await failure(run(fixture))).to.be.instanceOf(Error);
    expect(fixture.calls).to.have.length(2);
    expect(await absent(baseline)).to.equal(true);
    expect(await absent(definitions)).to.equal(true);
  });

  it('does not acquire canonical inventory for default Brand report export', async () => {
    const fixture = setup();
    fixture.responses.splice(2);
    const result = await run(fixture, { definitionDirectory: undefined });
    expect(fixture.calls).to.have.length(2);
    expect(
      result.manifest.items.some((item) => item.kind === 'cms.brand-source-inventory'),
    ).to.equal(false);
    expect(await absent(definitions)).to.equal(true);
  });

  for (const mode of ['editable', 'EmailTemplate']) {
    it(`keeps ${mode} export free of canonical Brand queries`, async () => {
      const fixture = setup();
      const raw = {
        managedContentVariantId: variantId,
        managedContentId: parentId,
        contentSpace: { id: workspaceId },
        contentType: { fullyQualifiedName: 'sfdc_cms__emailTemplate' },
        apiName: 'Template',
        language: 'en_US',
        title: 'Template',
        folder: null,
        contentBody: {
          'sfdc_cms:title': 'Template',
          messagePurpose: 'Transactional',
          rawHtml: '&lt;p&gt;Hello&lt;/p&gt;',
          'lightning:expressions': [],
          'sfdc_cms:variants': [],
        },
      };
      fixture.responses.splice(0, fixture.responses.length, fixture.search, raw);
      if (mode === 'EmailTemplate')
        fixture.responses.push(
          { id: workspaceId, name: 'Demo' },
          {
            managedContentId: parentId,
            contentSpace: { id: workspaceId },
            contentType: raw.contentType,
            folder: null,
          },
        );
      const result = await run(fixture, {
        selection: { contentType: 'sfdc_cms__emailTemplate', apiNames: ['Template'] },
        ...(mode === 'editable'
          ? { definitionDirectory: undefined, editableDirectory: definitions }
          : {}),
      });
      expect(fixture.calls).to.have.length(mode === 'editable' ? 2 : 4);
      expect(fixture.calls.some((call) => call.url.includes('/query?'))).to.equal(false);
      expect(
        result.manifest.items.some((item) => item.kind === 'cms.brand-source-inventory'),
      ).to.equal(false);
    });
  }
});
