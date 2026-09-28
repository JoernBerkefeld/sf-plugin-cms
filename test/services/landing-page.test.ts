import { expect } from 'chai';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import sinon from 'sinon';
import {
  assertLandingPageItem,
  planLandingPageCopies,
  validateLandingPagePrerequisites,
} from '../../src/services/landing-page.js';
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
  'sfdc_cms:description': 'Captured landing page description',
  'sfdc_cms:seoProperties': { isIndexed: false, title: 'Captured SEO title' },
  'sfdc_cms:title': 'Source landing page',
  'sfdc_cms:urlName': 'source-landing-page',
  'sfdc_cms:variants': [],
};

function page(apiName = 'source_page'): WorkspaceImportItem {
  return {
    apiName,
    contentBody: structuredClone(body),
    contentKey: `${apiName}_key`,
    contentSpace: { id: 'source-space' },
    contentType: 'sfdc_cms__landingPage',
    id: `${apiName}_variant`,
    language: 'en_US',
    title: 'Source landing page',
    urlName: 'source-landing-page',
  };
}

function source(items: WorkspaceImportItem[] = [page()]): LoadedWorkspaceExport {
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

function mapping(sourceApiName = 'source_page', targetApiName = 'fresh_page') {
  return {
    source: { family: 'cms', type: 'landingPage', apiName: sourceApiName },
    target: { contentKey: `${targetApiName}_key`, apiName: targetApiName },
    imageDependencies: [
      {
        sourceContentKey: 'source-image-key',
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

describe('landing-page create-only profile', () => {
  it('selects one or many exact type-qualified API names', () => {
    const loaded = source([page(), page('second_page')]);
    const before = structuredClone(loaded);
    const result = planLandingPageCopies(loaded, [
      mapping('second_page', 'fresh_second'),
      mapping(),
    ]);
    expect(result.items.map(({ apiName }) => apiName)).to.deep.equal([
      'fresh_page',
      'fresh_second',
    ]);
    expect(
      result.items.every(({ contentType }) => contentType === 'sfdc_cms__landingPage'),
    ).to.equal(true);
    expect(loaded).to.deep.equal(before);
  });

  it('rejects non-pages, mismatched image URLs, and unsupported dependency fields', () => {
    expect(() =>
      assertLandingPageItem({ ...page(), contentType: 'sfdc_cms__landingPageTemplate' }),
    ).to.throw('exact content type');
    const mismatch = page();
    const block = mismatch.contentBody['sfdc_cms:block'] as {
      children: Array<{ attributes: { imageInfo: { url: string } } }>;
    };
    block.children[0].attributes.imageInfo.url = '/cms/media/different-key?fileName=hero.png';
    expect(() => assertLandingPageItem(mismatch)).to.throw('must match');
    expect(() =>
      planLandingPageCopies(source(), [
        {
          ...mapping(),
          imageDependencies: [{ ...mapping().imageDependencies[0], sourceType: 'webFragment' }],
        },
      ]),
    ).to.throw('unsupported or missing fields');
  });

  it('uses exact API name first, rewrites image key and matching media URL', async () => {
    const proposal = planLandingPageCopies(source(), [mapping()]);
    const query = sinon.stub().resolves({
      done: true,
      records: [{ DeveloperName: 'Marketing', DataSpaceDevName: 'default' }],
      totalSize: 1,
    });
    const request = sinon.stub().callsFake(({ url }: { url: string }) =>
      url.includes('/items/search')
        ? Promise.resolve({
            items: [
              {
                id: 'image-variant',
                managedContentSpaceId: 'destination-space',
                type: 'ManagedContentVariantSearchResultRepresentation',
              },
            ],
            total: 1,
          })
        : Promise.resolve({
            apiName: 'target_image',
            contentKey: 'target-image-key',
            contentSpace: { id: 'destination-space' },
            contentType: 'sfdc_cms__image',
            id: 'image-variant',
            title: 'Target image title',
          }),
    );
    await validateLandingPagePrerequisites({ query, request }, 'destination-space', proposal);
    const serialized = JSON.stringify(proposal.items[0].contentBody);
    expect(serialized).not.to.include('source-image-key');
    expect(serialized).to.include('/cms/media/target-image-key?fileName=hero.png');
    expect(proposal.cmsPrerequisites[0].resolution).to.equal('api-name');
  });

  it('falls back to exact title only after successful zero API-name matches', async () => {
    const proposal = planLandingPageCopies(source(), [mapping()]);
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
        apiName: 'other_name',
        contentKey: 'target-image-key',
        contentSpace: { id: 'destination-space' },
        contentType: 'sfdc_cms__image',
        id: 'image-variant',
        title: 'Target image title',
      });
    });
    await validateLandingPagePrerequisites(
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

  it('dry-runs without mutation and apply rechecks identity and prerequisites before create', async () => {
    let apiQueries = 0;
    let graphQueries = 0;
    let searches = 0;
    let contentGets = 0;
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
      if (method === 'GET') {
        contentGets += 1;
        return fakeNotFound();
      }
      return Promise.resolve({
        contentKey: 'fresh_page_key',
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
      landingPageMappings: [mapping()],
      workspaceId: 'destination-space',
    };
    const dryRun = await executeWorkspaceImport({ ...common, dryRun: true });
    expect(dryRun.dryRun).to.equal(true);
    expect(request.getCalls().filter(({ args }) => args[0].method === 'POST')).to.have.length(0);

    const { mkdtemp, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const root = await mkdtemp(path.join(tmpdir(), 'cms-landing-page-'));
    try {
      const postBodies: Array<Record<string, unknown>> = [];
      request.callsFake(
        ({ body: requestBody, method, url }: { body?: string; method: string; url: string }) => {
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
          if (method === 'GET') {
            contentGets += 1;
            return fakeNotFound();
          }
          postBodies.push(JSON.parse(requestBody ?? '{}') as Record<string, unknown>);
          return Promise.resolve({
            contentKey: 'fresh_page_key',
            id: 'created-content',
            primaryVariantId: 'created-variant',
          });
        },
      );
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
      expect(applied.report?.dataGraphPrerequisites?.[0]).to.include({
        targetDeveloperName: 'Marketing',
        targetDataSpace: 'default',
        validationStatus: 'passed',
      });
      expect(apiQueries).to.equal(3);
      expect(graphQueries).to.equal(3);
      expect(searches).to.equal(3);
      expect(contentGets).to.equal(3);
      expect(request.getCalls().filter(({ args }) => args[0].method === 'POST')).to.have.length(1);
      expect(postBodies).to.have.length(1);
      expect(JSON.stringify(postBodies[0])).not.to.include('source-image-key');
      expect(JSON.stringify(postBodies[0])).not.to.include('/cms/media/source-image-key');
      expect(JSON.stringify(postBodies[0])).to.include('/cms/media/target-image-key');
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
