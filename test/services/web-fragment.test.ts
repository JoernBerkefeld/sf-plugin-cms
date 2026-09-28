import { expect } from 'chai';
import { PassThrough } from 'node:stream';
import sinon from 'sinon';
import {
  assertWebFragmentItem,
  planWebFragmentCopies,
  validateDataGraphPrerequisites,
} from '../../src/services/web-fragment.js';
import {
  executeWorkspaceImport,
  type LoadedWorkspaceExport,
  type WorkspaceImportItem,
} from '../../src/services/import-workspace.js';

const body = {
  'lightning:backgroundImage': { position: 'center center', repeat: 'no-repeat', size: 'cover' },
  'lightning:brandSource': { defaultBrandOption: 'sfdcBrand' },
  'lightning:dataProviders': [
    {
      attributes: { dataGraphApiName: 'Marketing', dataspace: 'default' },
      definition: 'sfdc_cms__dataGraphDataProvider',
      sfdcExpressionKey: '$dataGraph',
    },
  ],
  'lightning:expressions': [],
  'sfdc_cms:block': {
    children: [
      {
        attributes: {},
        children: [],
        definition: 'lightning/section',
        id: 'section-1',
        type: 'block',
      },
    ],
    definition: 'sfdc_cms/rootContentBlock',
    id: 'root-1',
    type: 'block',
  },
  'sfdc_cms:title': 'Landing block',
  'sfdc_cms:variants': [],
};

function item(apiName = 'source_web_fragment'): WorkspaceImportItem {
  return {
    apiName,
    contentBody: structuredClone(body),
    contentKey: `${apiName}_key`,
    contentSpace: { id: 'source-space' },
    contentType: 'sfdc_cms__webFragment',
    id: `${apiName}_variant`,
    language: 'en_US',
    title: 'Landing block',
    urlName: `${apiName}-url`,
  };
}

function source(items: WorkspaceImportItem[] = [item()]): LoadedWorkspaceExport {
  return {
    integrity: {
      listedItemCount: items.length,
      unlistedFileCount: 0,
      verified: true,
      verifiedItemCount: items.length,
    },
    isPartial: false,
    items,
    manifest: {
      schemaVersion: 1,
      mode: 'experimental-best-effort',
      workspaceId: 'source-space',
      search: {
        contentSpaceOrFolderIds: ['source-space'],
        languages: ['All'],
        pageSize: 250,
        queryTerm: '*',
      },
      expectedCount: items.length,
      foundCount: items.length,
      exportedCount: items.length,
      pagesRequested: 1,
      entries: items.map((value) => ({ file: `items/${value.id}.json`, variantId: value.id })),
      rejectedVariantIds: [],
      failedVariantIds: [],
      warnings: [{ code: 'UNSUPPORTED_WILDCARD', message: 'provenance only' }],
      contract: 'sf-cms-workspace-export',
      contractVersion: '1.0.0',
      provenance: {
        producer: 'sf-plugin-cms',
        sourceOrgId: 'source-org',
        sourceWorkspaceId: 'source-space',
        pluginVersion: '0.4.0',
        generatedAt: '2026-09-28T00:00:00.000Z',
      },
      completeness: 'complete',
      dependencies: [],
      externalReferences: [],
      items: items.map((value) => ({
        path: `items/${value.id}.json`,
        sha256: 'a'.repeat(64),
        kind: 'cms.content',
      })),
    },
    manifestSha256: 'b'.repeat(64),
    sourceDirectory: 'synthetic-source',
  };
}

function mapping(sourceApiName = 'source_web_fragment', targetApiName = 'fresh_web_fragment') {
  return {
    source: { family: 'cms', type: 'webFragment', apiName: sourceApiName },
    target: { contentKey: `${targetApiName}_key`, apiName: targetApiName },
    dataGraphs: [
      {
        sourceDeveloperName: 'Marketing',
        sourceDataSpace: 'default',
        targetDeveloperName: 'Marketing',
        targetDataSpace: 'default',
      },
    ],
  };
}

function fakeNotFound(): Promise<never> & { stream(): PassThrough } {
  return Object.assign(Promise.reject(Object.assign(new Error('missing'), { statusCode: 404 })), {
    stream: () => new PassThrough(),
  });
}

describe('web fragment create-only profile', () => {
  it('selects one or many exact type-qualified API names and rewrites only mapped Data Graph names', () => {
    const loaded = source([item(), item('second_web_fragment')]);
    const before = structuredClone(loaded);
    const result = planWebFragmentCopies(loaded, [
      mapping('second_web_fragment', 'fresh_second_fragment'),
      mapping(),
    ]);

    expect(result.items.map(({ apiName }) => apiName)).to.deep.equal([
      'fresh_second_fragment',
      'fresh_web_fragment',
    ]);
    expect(result.dataGraphs).to.deep.equal([
      {
        sourceDeveloperName: 'Marketing',
        sourceDataSpace: 'default',
        targetDeveloperName: 'Marketing',
        targetDataSpace: 'default',
        resolution: 'preserved',
        validationStatus: 'pending',
      },
      {
        sourceDeveloperName: 'Marketing',
        sourceDataSpace: 'default',
        targetDeveloperName: 'Marketing',
        targetDataSpace: 'default',
        resolution: 'preserved',
        validationStatus: 'pending',
      },
    ]);
    expect(loaded).to.deep.equal(before);
  });

  it('accepts an explicit Data Graph developer-name/data-space mapping', () => {
    const mapped = mapping();
    mapped.dataGraphs[0].targetDeveloperName = 'TargetMarketing';
    mapped.dataGraphs[0].targetDataSpace = 'targetspace';
    const result = planWebFragmentCopies(source(), [mapped]);
    const providers = result.items[0].contentBody['lightning:dataProviders'] as Array<{
      attributes: Record<string, string>;
    }>;
    expect(providers[0].attributes).to.deep.equal({
      dataGraphApiName: 'TargetMarketing',
      dataspace: 'targetspace',
    });
    expect(result.dataGraphs[0].resolution).to.equal('explicit-map');
  });

  for (const [name, changed] of [
    ['wrong type', { contentType: 'sfdc_cms__emailFragment' }],
    ['title mismatch', { title: 'Different' }],
  ] as const) {
    it(`rejects ${name}`, () => {
      expect(() => assertWebFragmentItem({ ...item(), ...changed })).to.throw();
    });
  }

  it('rejects a missing API name', () => {
    const missing = { ...item() } as { apiName?: string } & WorkspaceImportItem;
    delete missing.apiName;
    expect(() => assertWebFragmentItem(missing)).to.throw();
  });

  it('fails closed on malformed providers, missing mappings, duplicate selection, and ambiguous source', () => {
    const original = item();
    const malformed = {
      ...original,
      contentBody: { ...original.contentBody, 'lightning:dataProviders': [] },
    };
    expect(() => assertWebFragmentItem(malformed)).to.throw('requires at least one');
    expect(() => planWebFragmentCopies(source(), [{ ...mapping(), dataGraphs: [] }])).to.throw(
      'exactly one mapping row',
    );
    expect(() => planWebFragmentCopies(source(), [mapping(), mapping()])).to.throw('Duplicate');
    expect(() =>
      planWebFragmentCopies(source([item(), { ...item(), id: 'duplicate' }]), [mapping()]),
    ).to.throw('exactly one');
  });

  it('proves exact Data Graph developer name and data space once', async () => {
    const query = sinon.stub().resolves({
      done: true,
      records: [{ DeveloperName: 'Marketing', DataSpaceDevName: 'default' }],
      totalSize: 1,
    });
    await validateDataGraphPrerequisites(
      { query },
      planWebFragmentCopies(source(), [mapping()]).dataGraphs,
    );
    expect(
      query.calledOnceWithExactly(
        "SELECT DeveloperName, DataSpaceDevName FROM DataGraph WHERE DeveloperName = 'Marketing' AND DataSpaceDevName = 'default'",
      ),
    ).to.equal(true);
  });

  for (const result of [
    { done: true, records: [], totalSize: 0 },
    {
      done: true,
      records: [
        { DeveloperName: 'Marketing', DataSpaceDevName: 'default' },
        { DeveloperName: 'Marketing', DataSpaceDevName: 'default' },
      ],
      totalSize: 2,
    },
    {
      done: true,
      records: [{ DeveloperName: 'Marketing', DataSpaceDevName: 'other' }],
      totalSize: 1,
    },
  ]) {
    it('fails closed when a Data Graph prerequisite is missing, ambiguous, or mismatched', async () => {
      let failure: unknown;
      try {
        await validateDataGraphPrerequisites(
          { query: sinon.stub().resolves(result) },
          planWebFragmentCopies(source(), [mapping()]).dataGraphs,
        );
      } catch (error) {
        failure = error;
      }
      expect(failure).to.be.instanceOf(TypeError);
    });
  }

  it('dry-runs without mutation and apply rechecks names and Data Graph before create', async () => {
    let apiQueries = 0;
    let graphQueries = 0;
    const query = sinon.stub().callsFake((soql: string) => {
      if (soql.startsWith('SELECT ApiName')) {
        apiQueries += 1;
        return Promise.resolve({ done: true, records: [], totalSize: 0 });
      }
      graphQueries += 1;
      return Promise.resolve({
        done: true,
        records: [{ DeveloperName: 'Marketing', DataSpaceDevName: 'default' }],
        totalSize: 1,
      });
    });
    const request = sinon.stub().callsFake(({ method }: { method: string }) => {
      if (method === 'GET') return fakeNotFound();
      return Promise.resolve({
        contentKey: 'fresh_web_fragment_key',
        id: 'created-content',
        primaryVariantId: 'created-variant',
      });
    });
    const dryRun = await executeWorkspaceImport({
      connection: { query, request },
      destinationOrgId: 'target-org',
      destinationWorkspace: {
        defaultLanguage: 'en_US',
        id: 'destination-space',
        rootFolderId: 'root-folder',
      },
      dryRun: true,
      loadedSource: source(),
      sourceDirectory: 'synthetic-source',
      webFragmentMappings: [mapping()],
      workspaceId: 'destination-space',
    });
    expect(dryRun.dryRun).to.equal(true);
    expect(request.getCalls().every(({ args }) => args[0].method === 'GET')).to.equal(true);

    const root = await import('node:fs/promises').then(({ mkdtemp }) =>
      mkdtemp(String.raw`${process.env.TEMP ?? '.'}\cms-web-fragment-`),
    );
    try {
      const applied = await executeWorkspaceImport({
        connection: { query, request },
        destinationOrgId: 'target-org',
        destinationWorkspace: {
          defaultLanguage: 'en_US',
          id: 'destination-space',
          rootFolderId: 'root-folder',
        },
        dryRun: false,
        loadedSource: source(),
        reportDirectory: String.raw`${root}\report`,
        sourceDirectory: 'synthetic-source',
        webFragmentMappings: [mapping()],
        workspaceId: 'destination-space',
      });
      expect(applied.report?.state).to.equal('completed');
      expect(applied.report?.dataGraphPrerequisites?.[0]).to.include({
        resolution: 'preserved',
        validationStatus: 'passed',
      });
      expect(apiQueries).to.equal(3);
      expect(graphQueries).to.equal(3);
      expect(request.getCalls().filter(({ args }) => args[0].method === 'POST')).to.have.length(1);
    } finally {
      await import('node:fs/promises').then(({ rm }) => rm(root, { force: true, recursive: true }));
    }
  });

  it('does not create when immediate Data Graph revalidation fails', async () => {
    let graphQueries = 0;
    const query = sinon.stub().callsFake((soql: string) => {
      if (soql.startsWith('SELECT ApiName')) {
        return Promise.resolve({ done: true, records: [], totalSize: 0 });
      }
      graphQueries += 1;
      return Promise.resolve(
        graphQueries === 1
          ? {
              done: true,
              records: [{ DeveloperName: 'Marketing', DataSpaceDevName: 'default' }],
              totalSize: 1,
            }
          : { done: true, records: [], totalSize: 0 },
      );
    });
    const request = sinon.stub().returns(fakeNotFound());
    let failure: unknown;
    try {
      await executeWorkspaceImport({
        connection: { query, request },
        destinationOrgId: 'target-org',
        destinationWorkspace: {
          defaultLanguage: 'en_US',
          id: 'destination-space',
          rootFolderId: 'root-folder',
        },
        dryRun: false,
        loadedSource: source(),
        reportDirectory: String.raw`${process.env.TEMP ?? '.'}\cms-web-fragment-blocked-${Date.now()}`,
        sourceDirectory: 'synthetic-source',
        webFragmentMappings: [mapping()],
        workspaceId: 'destination-space',
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).to.be.instanceOf(TypeError);
    expect(request.getCalls().filter(({ args }) => args[0].method === 'POST')).to.have.length(0);
  });
});
