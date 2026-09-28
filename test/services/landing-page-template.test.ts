import { expect } from 'chai';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import sinon from 'sinon';
import {
  assertLandingPageTemplateItem,
  planLandingPageTemplateCopies,
  validateLandingPageTemplatePrerequisites,
} from '../../src/services/landing-page-template.js';
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
        attributes: {
          imageInfo: {
            source: { ref: { contentKey: 'source-image-key' }, type: 'imageReference' },
            url: '/cms/media/source-image-key?fileName=hero.png&fileHash=abc',
          },
        },
        children: [],
        definition: 'lightning/image',
        id: 'image-1',
        type: 'block',
      },
    ],
    definition: 'sfdc_cms/rootContentBlock',
    id: 'root-1',
    type: 'block',
  },
  'sfdc_cms:description': 'Captured template description',
  'sfdc_cms:seoProperties': { isIndexed: false, title: 'Captured SEO title' },
  'sfdc_cms:title': 'Source template',
  'sfdc_cms:urlName': 'source-template',
  'sfdc_cms:variants': [],
};

function template(apiName = 'source_template'): WorkspaceImportItem {
  return {
    apiName,
    contentBody: structuredClone(body),
    contentKey: `${apiName}_key`,
    contentSpace: { id: 'source-space' },
    contentType: 'sfdc_cms__landingPageTemplate',
    id: `${apiName}_variant`,
    language: 'en_US',
    title: 'Source template',
    urlName: 'source-template',
  };
}

function source(items: WorkspaceImportItem[] = [template()]): LoadedWorkspaceExport {
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
      entries: items.map((item) => ({ file: `items/${item.id}.json`, variantId: item.id })),
      rejectedVariantIds: [],
      failedVariantIds: [],
      warnings: [
        {
          code: 'REFERENCE_UNSUPPORTED',
          message: 'captured structured relationship',
          variantIds: items.map(({ id }) => id),
        },
      ],
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
      externalReferences: items.map((item, index) => ({
        referenceId: `ref:${String(index).padStart(64, 'a')}`,
        owner: 'cms',
        kind: 'cms.relationship',
        source: { workspaceId: 'source-space', sourceId: item.id },
        portableKey: { scheme: 'cms-opaque-v1', value: item.id },
        required: true,
        resolution: 'unsupported',
      })),
      items: items.map((item) => ({
        path: `items/${item.id}.json`,
        sha256: 'b'.repeat(64),
        kind: 'cms.content',
      })),
    },
    manifestSha256: 'c'.repeat(64),
    sourceDirectory: 'synthetic-source',
  };
}

function mapping(sourceApiName = 'source_template', targetApiName = 'fresh_template') {
  return {
    source: { family: 'cms', type: 'landingPageTemplate', apiName: sourceApiName },
    target: { contentKey: `${targetApiName}_key`, apiName: targetApiName },
    cmsDependencies: [
      {
        sourceContentKey: 'source-image-key',
        sourceType: 'image',
        targetApiName: 'target_image',
        targetTitle: 'Target image title',
      },
    ],
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

describe('landing-page-template create-only profile', () => {
  it('selects one or many exact type-qualified API names from captured template shapes', () => {
    const loaded = source([template(), template('second_template')]);
    const before = structuredClone(loaded);
    const result = planLandingPageTemplateCopies(loaded, [
      mapping('second_template', 'fresh_second'),
      mapping(),
    ]);

    expect(result.items.map(({ apiName }) => apiName)).to.deep.equal([
      'fresh_second',
      'fresh_template',
    ]);
    expect(result.cmsPrerequisites).to.have.length(2);
    expect(result.dataGraphs).to.have.length(2);
    expect(loaded).to.deep.equal(before);
  });

  it('rejects wrong types, unsupported dependency shapes, and missing exact maps', () => {
    expect(() =>
      assertLandingPageTemplateItem({ ...template(), contentType: 'sfdc_cms__landingPage' }),
    ).to.throw();
    const unsupported = {
      ...template(),
      contentBody: {
        ...template().contentBody,
        'sfdc_cms:block': {
          children: [
            { attributes: { source: { ref: { contentKey: 'x' }, type: 'contentReference' } } },
          ],
        },
      },
    };
    expect(() => assertLandingPageTemplateItem(unsupported)).to.throw('unsupported CMS dependency');
    expect(() =>
      planLandingPageTemplateCopies(source(), [{ ...mapping(), cmsDependencies: [] }]),
    ).to.throw('exactly one mapping row');
    expect(() =>
      planLandingPageTemplateCopies(source([template(), { ...template(), id: 'duplicate' }]), [
        mapping(),
      ]),
    ).to.throw('exactly one');
  });

  it('uses exact API-name resolution before title fallback and rewrites only resolved keys', async () => {
    const proposal = planLandingPageTemplateCopies(source(), [mapping()]);
    const query = sinon.stub().resolves({
      done: true,
      records: [{ DeveloperName: 'Marketing', DataSpaceDevName: 'default' }],
      totalSize: 1,
    });
    const request = sinon.stub().callsFake(({ url }: { url: string }) => {
      if (url.includes('/items/search'))
        return Promise.resolve({
          items: [
            {
              id: 'image-variant',
              managedContentSpaceId: 'destination-space',
              type: 'ManagedContentVariantSearchResultRepresentation',
            },
          ],
          total: 1,
        });
      return Promise.resolve({
        apiName: 'target_image',
        contentKey: 'target-image-key',
        contentSpace: { id: 'destination-space' },
        contentType: { fullyQualifiedName: 'sfdc_cms__image' },
        id: 'image-variant',
        title: 'Target image title',
      });
    });

    await validateLandingPageTemplatePrerequisites(
      { query, request },
      'destination-space',
      proposal,
    );

    expect(proposal.cmsPrerequisites[0]).to.include({
      resolution: 'api-name',
      targetContentKey: 'target-image-key',
      validationStatus: 'passed',
    });
    expect(JSON.stringify(proposal.items[0].contentBody)).not.to.include('source-image-key');
    expect(JSON.stringify(proposal.items[0].contentBody)).to.include('target-image-key');
  });

  it('falls back by exact title only after a successful zero-result API-name lookup', async () => {
    const proposal = planLandingPageTemplateCopies(source(), [mapping()]);
    let searches = 0;
    const request = sinon.stub().callsFake(({ url }: { url: string }) => {
      if (url.includes('/items/search')) {
        searches += 1;
        return Promise.resolve(
          searches === 1
            ? { items: [], total: 0 }
            : {
                items: [
                  {
                    id: 'image-variant',
                    managedContentSpaceId: 'destination-space',
                    type: 'ManagedContentVariantSearchResultRepresentation',
                  },
                ],
                total: 1,
              },
        );
      }
      return Promise.resolve({
        apiName: 'unreadable_server_name',
        contentKey: 'target-image-key',
        contentSpace: { id: 'destination-space' },
        contentType: 'sfdc_cms__image',
        id: 'image-variant',
        title: 'Target image title',
      });
    });
    await validateLandingPageTemplatePrerequisites(
      {
        query: sinon.stub().resolves({
          done: true,
          records: [{ DeveloperName: 'Marketing', DataSpaceDevName: 'default' }],
          totalSize: 1,
        }),
        request,
      },
      'destination-space',
      proposal,
    );
    expect(proposal.cmsPrerequisites[0].resolution).to.equal('title-fallback');
    expect(searches).to.equal(2);
  });

  it('dry-runs without mutation and apply rechecks every prerequisite sequentially', async () => {
    let apiQueries = 0;
    let graphQueries = 0;
    let searches = 0;
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
    const request = sinon.stub().callsFake(({ method, url }: { method: string; url: string }) => {
      if (url.includes('/items/search')) {
        searches += 1;
        return Promise.resolve({
          items: [
            {
              id: 'image-variant',
              managedContentSpaceId: 'destination-space',
              type: 'ManagedContentVariantSearchResultRepresentation',
            },
          ],
          total: 1,
        });
      }
      if (url.includes('/variants/image-variant')) {
        return Promise.resolve({
          apiName: 'target_image',
          contentKey: 'target-image-key',
          contentSpace: { id: 'destination-space' },
          contentType: 'sfdc_cms__image',
          id: 'image-variant',
          title: 'Target image title',
        });
      }
      if (method === 'GET') return fakeNotFound();
      return Promise.resolve({
        contentKey: 'fresh_template_key',
        id: 'created-content',
        primaryVariantId: 'created-variant',
      });
    });
    const common = {
      connection: { query, request },
      destinationOrgId: 'target-org',
      destinationWorkspace: {
        defaultLanguage: 'en_US',
        id: 'destination-space',
        rootFolderId: 'root-folder',
      },
      loadedSource: source(),
      sourceDirectory: 'synthetic-source',
      landingPageTemplateMappings: [mapping()],
      workspaceId: 'destination-space',
    };
    const dryRun = await executeWorkspaceImport({ ...common, dryRun: true });
    expect(dryRun.dryRun).to.equal(true);
    expect(request.getCalls().filter(({ args }) => args[0].method === 'POST')).to.have.length(0);

    const { mkdtemp, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const root = await mkdtemp(path.join(tmpdir(), 'cms-landing-template-'));
    try {
      const postBodies: Array<Record<string, unknown>> = [];
      request.callsFake(({ body, method, url }: { body?: string; method: string; url: string }) => {
        if (url.includes('/items/search')) {
          searches += 1;
          return Promise.resolve({
            items: [
              {
                id: 'image-variant',
                managedContentSpaceId: 'destination-space',
                type: 'ManagedContentVariantSearchResultRepresentation',
              },
            ],
            total: 1,
          });
        }
        if (url.includes('/variants/image-variant')) {
          return Promise.resolve({
            apiName: 'target_image',
            contentKey: 'target-image-key',
            contentSpace: { id: 'destination-space' },
            contentType: 'sfdc_cms__image',
            id: 'image-variant',
            title: 'Target image title',
          });
        }
        if (method === 'GET') return fakeNotFound();
        postBodies.push(JSON.parse(body ?? '{}') as Record<string, unknown>);
        return Promise.resolve({
          contentKey: 'fresh_template_key',
          id: 'created-content',
          primaryVariantId: 'created-variant',
        });
      });
      const applied = await executeWorkspaceImport({
        ...common,
        dryRun: false,
        reportDirectory: path.join(root, 'report'),
      });
      expect(applied.report?.state).to.equal('completed');
      expect(applied.report?.cmsPrerequisites?.[0]).to.include({
        resolution: 'api-name',
        validationStatus: 'passed',
      });
      expect(apiQueries).to.equal(3);
      expect(graphQueries).to.equal(3);
      expect(searches).to.equal(3);
      expect(request.getCalls().filter(({ args }) => args[0].method === 'POST')).to.have.length(1);
      expect(postBodies).to.have.length(1);
      expect(JSON.stringify(postBodies[0])).not.to.include('source-image-key');
      expect(JSON.stringify(postBodies[0])).not.to.include('/cms/media/source-image-key');
      expect(JSON.stringify(postBodies[0])).to.include('target-image-key');
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
