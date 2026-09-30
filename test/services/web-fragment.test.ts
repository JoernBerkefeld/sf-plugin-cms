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

const VALID_WEB_FRAGMENT_CONTENT_KEYS = {
  fresh_second_fragment: 'MCBBBBBBBBBBBBBBBBBBBBBBBBBB',
  fresh_web_fragment: 'MCAAAAAAAAAAAAAAAAAAAAAAAAAA',
} as const;

function mapping(
  sourceApiName = 'source_web_fragment',
  targetApiName: keyof typeof VALID_WEB_FRAGMENT_CONTENT_KEYS = 'fresh_web_fragment',
) {
  return {
    source: { family: 'cms', type: 'webFragment', apiName: sourceApiName },
    target: { contentKey: VALID_WEB_FRAGMENT_CONTENT_KEYS[targetApiName], apiName: targetApiName },
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

function fakeInvalidIdentity(
  overrides: Record<string, unknown> = {},
): Promise<never> & { stream(): PassThrough } {
  const message = 'Provide a valid content key, ID, or FQN.';
  return Object.assign(
    Promise.reject(
      Object.assign(new Error(message), {
        data: { errorCode: 'INVALID_ID_FIELD', message },
        statusCode: 400,
        ...overrides,
      }),
    ),
    { stream: () => new PassThrough() },
  );
}

describe('web fragment create-only profile', () => {
  it('routes the observed invalid key through planning and rejects it before transport', async () => {
    const invalid = {
      ...mapping(),
      target: { ...mapping().target, contentKey: 'MCNWEB_20260929_153130_DF4EC01F' },
    };
    expect(() => planWebFragmentCopies(source(), [invalid])).to.throw(
      'Web fragment mapping 0.target.contentKey must match ^MC[A-Z2-7]{26}$',
    );

    const request = sinon.stub();
    const query = sinon.stub();
    let failure: unknown;
    try {
      await executeWorkspaceImport({
        connection: { query, request, version: '67.0' },
        destinationOrgId: 'target-org',
        destinationWorkspace: {
          defaultLanguage: 'en_US',
          id: 'destination-space',
          rootFolderId: 'root-folder',
        },
        dryRun: false,
        loadedSource: source(),
        reportDirectory: 'unused-report',
        sourceDirectory: 'synthetic-source',
        webFragmentMappings: [invalid],
        workspaceId: 'destination-space',
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).to.be.instanceOf(TypeError);
    expect(request.notCalled).to.equal(true);
    expect(query.notCalled).to.equal(true);
  });

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

  it('uses the connection-selected version and encoded developer name in a named Connect GET', async () => {
    const prerequisite = {
      ...planWebFragmentCopies(source(), [mapping()]).dataGraphs[0],
      targetDeveloperName: 'Marketing Graph/One',
    };
    const request = sinon.stub().resolves({
      name: 'Marketing Graph/One',
      dataspaceName: 'default',
      status: 'ReAdY',
    });
    await validateDataGraphPrerequisites({ request, version: '68.0' }, [prerequisite]);
    expect(
      request.calledOnceWithExactly({
        method: 'GET',
        url: '/services/data/v68.0/ssot/data-graphs/Marketing%20Graph%2FOne',
      }),
    ).to.equal(true);
    expect(prerequisite).to.include({ validationStatus: 'passed' });
    expect(prerequisite.validationEvidence).to.deep.equal({
      url: '/services/data/v68.0/ssot/data-graphs/Marketing%20Graph%2FOne',
      name: 'Marketing Graph/One',
      dataspaceName: 'default',
      status: 'ReAdY',
    });
  });

  for (const status of ['ready', 'READY', 'active', 'AcTiVe']) {
    it(`accepts an exact non-array response with ${status} status`, async () => {
      const prerequisites = planWebFragmentCopies(source(), [mapping()]).dataGraphs;
      await validateDataGraphPrerequisites(
        {
          request: sinon.stub().resolves({
            name: 'Marketing',
            dataspaceName: 'default',
            status,
          }),
          version: '67.0',
        },
        prerequisites,
      );
      expect(prerequisites[0].validationStatus).to.equal('passed');
    });
  }

  for (const [label, response] of [
    ['an array', [{ name: 'Marketing', dataspaceName: 'default', status: 'ready' }]],
    ['a missing developer name', { dataspaceName: 'default', status: 'ready' }],
    ['a blank developer name', { name: '', dataspaceName: 'default', status: 'ready' }],
    ['a wrong developer name', { name: 'marketing', dataspaceName: 'default', status: 'ready' }],
    ['a missing data space', { name: 'Marketing', status: 'ready' }],
    ['a blank data space', { name: 'Marketing', dataspaceName: '', status: 'ready' }],
    ['a wrong data space', { name: 'Marketing', dataspaceName: 'Default', status: 'ready' }],
    ['a missing status', { name: 'Marketing', dataspaceName: 'default' }],
    ['a blank status', { name: 'Marketing', dataspaceName: 'default', status: '   ' }],
    ['another status', { name: 'Marketing', dataspaceName: 'default', status: 'draft' }],
    ['a malformed response', 'not-an-object'],
  ] as const) {
    it(`fails closed for ${label}`, async () => {
      const prerequisites = planWebFragmentCopies(source(), [mapping()]).dataGraphs;
      let failure: unknown;
      try {
        await validateDataGraphPrerequisites(
          { request: sinon.stub().resolves(response), version: '67.0' },
          prerequisites,
        );
      } catch (error) {
        failure = error;
      }
      expect(failure).to.be.instanceOf(TypeError);
      expect(prerequisites[0].validationStatus).to.equal('failed');
    });
  }

  it('fails closed on request failure and records evidence', async () => {
    const prerequisites = planWebFragmentCopies(source(), [mapping()]).dataGraphs;
    let failure: unknown;
    try {
      await validateDataGraphPrerequisites(
        { request: sinon.stub().rejects(new Error('unavailable')), version: '67.0' },
        prerequisites,
      );
    } catch (error) {
      failure = error;
    }
    expect(failure).to.be.instanceOf(TypeError);
    expect(prerequisites[0]).to.include({ validationStatus: 'failed' });
    expect(prerequisites[0].validationEvidence).to.include({ failure: 'unavailable' });
  });

  it('groups duplicate target pairs and propagates status and evidence to every occurrence', async () => {
    const prerequisites = planWebFragmentCopies(source([item(), item('second_web_fragment')]), [
      mapping(),
      mapping('second_web_fragment', 'fresh_second_fragment'),
    ]).dataGraphs;
    const request = sinon.stub().resolves({
      name: 'Marketing',
      dataspaceName: 'default',
      status: 'active',
    });
    await validateDataGraphPrerequisites({ request, version: '67.0' }, prerequisites);
    expect(request.callCount).to.equal(1);
    expect(prerequisites.map(({ validationStatus }) => validationStatus)).to.deep.equal([
      'passed',
      'passed',
    ]);
    expect(prerequisites[0].validationEvidence).to.equal(prerequisites[1].validationEvidence);
  });

  it('dry-runs without mutation and apply immediately revalidates Data Graph before create', async () => {
    let apiQueries = 0;
    let graphRequests = 0;
    const query = sinon.stub().callsFake((soql: string) => {
      if (soql.startsWith('SELECT ApiName')) apiQueries += 1;
      return Promise.resolve({ done: true, records: [], totalSize: 0 });
    });
    const request = sinon.stub().callsFake(({ method, url }: { method: string; url: string }) => {
      if (url.includes('/ssot/data-graphs/')) {
        graphRequests += 1;
        return Promise.resolve({ name: 'Marketing', dataspaceName: 'default', status: 'ready' });
      }
      if (method === 'GET') return fakeNotFound();
      return Promise.resolve({
        contentKey: VALID_WEB_FRAGMENT_CONTENT_KEYS.fresh_web_fragment,
        id: 'created-content',
        primaryVariantId: 'created-variant',
      });
    });
    const dryRun = await executeWorkspaceImport({
      connection: { query, request, version: '67.0' },
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
        connection: { query, request, version: '67.0' },
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
      expect(graphRequests).to.equal(3);
      expect(request.getCalls().filter(({ args }) => args[0].method === 'POST')).to.have.length(1);
    } finally {
      await import('node:fs/promises').then(({ rm }) => rm(root, { force: true, recursive: true }));
    }
  });

  for (const [statusLabel, statusCode] of [
    ['400 status', 400],
    ['unavailable status', undefined],
  ] as const) {
    it(`accepts the exact live invalid-identity absence response with ${statusLabel} during dry-run and apply recheck`, async () => {
      let apiQueries = 0;
      let graphRequests = 0;
      let keyChecks = 0;
      const query = sinon.stub().callsFake((soql: string) => {
        if (soql.startsWith('SELECT ApiName')) apiQueries += 1;
        return Promise.resolve({ done: true, records: [], totalSize: 0 });
      });
      const request = sinon.stub().callsFake(({ method, url }: { method: string; url: string }) => {
        if (url.includes('/ssot/data-graphs/')) {
          graphRequests += 1;
          return Promise.resolve({ name: 'Marketing', dataspaceName: 'default', status: 'active' });
        }
        if (method === 'GET') {
          keyChecks += 1;
          return fakeInvalidIdentity({ statusCode });
        }
        return Promise.resolve({
          contentKey: VALID_WEB_FRAGMENT_CONTENT_KEYS.fresh_web_fragment,
          id: 'created-content',
          primaryVariantId: 'created-variant',
        });
      });
      const options = {
        connection: { query, request, version: '67.0' },
        destinationOrgId: 'target-org',
        destinationWorkspace: {
          defaultLanguage: 'en_US',
          id: 'destination-space',
          rootFolderId: 'root-folder',
        },
        loadedSource: source(),
        sourceDirectory: 'synthetic-source',
        webFragmentMappings: [mapping()],
        workspaceId: 'destination-space',
      };

      const dryRun = await executeWorkspaceImport({ ...options, dryRun: true });
      expect(dryRun.dryRun).to.equal(true);
      expect(request.getCalls().every(({ args }) => args[0].method === 'GET')).to.equal(true);

      const root = await import('node:fs/promises').then(({ mkdtemp }) =>
        mkdtemp(String.raw`${process.env.TEMP ?? '.'}\cms-web-fragment-live-absence-`),
      );
      try {
        const applied = await executeWorkspaceImport({
          ...options,
          dryRun: false,
          reportDirectory: String.raw`${root}\report`,
        });
        expect(applied.report?.state).to.equal('completed');
        expect(keyChecks).to.equal(3);
        expect(apiQueries).to.equal(3);
        expect(graphRequests).to.equal(3);
        expect(request.getCalls().filter(({ args }) => args[0].method === 'POST')).to.have.length(
          1,
        );
      } finally {
        await import('node:fs/promises').then(({ rm }) =>
          rm(root, { force: true, recursive: true }),
        );
      }
    });
  }

  it('fails closed on malformed and unrelated invalid-identity responses', async () => {
    const exactMessage = 'Provide a valid content key, ID, or FQN.';
    const failures = [
      { data: { errorCode: 'INVALID_ID_FIELD', message: `${exactMessage}!` }, statusCode: 400 },
      { data: { errorCode: 'INVALID_FIELD', message: exactMessage }, statusCode: 400 },
      { data: { errorCode: 'INVALID_ID_FIELD', message: exactMessage }, statusCode: 401 },
      {
        data: [
          { errorCode: 'INVALID_ID_FIELD', message: exactMessage },
          { errorCode: 'INVALID_ID_FIELD', message: exactMessage },
        ],
        statusCode: 400,
      },
      { data: 'malformed', statusCode: 400 },
    ];

    for (const overrides of failures) {
      const query = sinon.stub().resolves({ done: true, records: [], totalSize: 0 });
      const request = sinon.stub().returns(fakeInvalidIdentity(overrides));
      let failure: unknown;
      try {
        await executeWorkspaceImport({
          connection: { query, request, version: '67.0' },
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
      } catch (error) {
        failure = error;
      }
      expect(failure).to.be.instanceOf(Error);
      expect(request.callCount).to.equal(1);
    }
  });

  it('does not create when immediate Data Graph revalidation fails', async () => {
    let graphRequests = 0;
    const query = sinon.stub().resolves({ done: true, records: [], totalSize: 0 });
    const request = sinon.stub().callsFake(({ method, url }: { method: string; url: string }) => {
      if (url.includes('/ssot/data-graphs/')) {
        graphRequests += 1;
        return Promise.resolve(
          graphRequests === 1
            ? { name: 'Marketing', dataspaceName: 'default', status: 'ready' }
            : { name: 'Marketing', dataspaceName: 'default', status: 'draft' },
        );
      }
      if (method === 'GET') return fakeNotFound();
      return Promise.resolve({});
    });
    let failure: unknown;
    try {
      await executeWorkspaceImport({
        connection: { query, request, version: '67.0' },
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
