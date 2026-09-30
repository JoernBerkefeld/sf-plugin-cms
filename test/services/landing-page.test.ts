import { expect } from 'chai';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import sinon from 'sinon';
import {
  assertLandingPageItem,
  planLandingPageCopies,
  resolveLandingPageTemplateDependencies,
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

function template(apiName = 'source_template'): WorkspaceImportItem {
  const item = page(apiName);
  return {
    ...item,
    contentKey: `${apiName}_key`,
    contentType: 'sfdc_cms__landingPageTemplate',
    id: `${apiName}_variant`,
    title: 'Requested template',
    urlName: 'source-template',
    contentBody: {
      ...item.contentBody,
      'sfdc_cms:title': 'Requested template',
      'sfdc_cms:urlName': 'source-template',
    },
  };
}

function source(items: WorkspaceImportItem[] = [page(), template()]): LoadedWorkspaceExport {
  const sourcePage = items.find(({ contentType }) => contentType === 'sfdc_cms__landingPage');
  const sourceTemplate = items.find(
    ({ contentType }) => contentType === 'sfdc_cms__landingPageTemplate',
  );
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
      ...(sourcePage === undefined || sourceTemplate === undefined
        ? {}
        : {
            landingPageTemplatePairs: [
              {
                page: {
                  apiName: sourcePage.apiName!,
                  contentKey: sourcePage.contentKey,
                  variantId: sourcePage.id,
                },
                template: {
                  requestedTitle: sourceTemplate.title,
                  apiName: sourceTemplate.apiName!,
                  contentKey: sourceTemplate.contentKey,
                  variantId: sourceTemplate.id,
                },
                compatibility: {
                  basis: 'declared-source-pair' as const,
                  relationship: 'opaque-structural-match' as const,
                },
              },
            ],
          }),
      externalReferences: items
        .filter(({ contentType }) => contentType === 'sfdc_cms__landingPage')
        .map((item, index) => ({
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

const VALID_PAGE_CONTENT_KEYS = {
  fresh_page: 'MCAAAAAAAAAAAAAAAAAAAAAAAAAA',
  fresh_second: 'MCBBBBBBBBBBBBBBBBBBBBBBBBBB',
} as const;

function mapping(sourceApiName = 'source_page', targetApiName = 'fresh_page') {
  return {
    source: { family: 'cms', type: 'landingPage', apiName: sourceApiName },
    target: {
      contentKey:
        targetApiName === 'fresh_second'
          ? VALID_PAGE_CONTENT_KEYS.fresh_second
          : VALID_PAGE_CONTENT_KEYS.fresh_page,
      apiName: targetApiName,
    },
    templateDependency: {
      source: {
        requestedTitle: 'Requested template',
        apiName: 'source_template',
        contentKey: 'source_template_key',
      },
      targetApiName: 'target_template',
      targetTitle: 'Target template',
    },
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
    const firstTemplate = template();
    const secondTemplateBase = template('second_template');
    const secondTemplate: WorkspaceImportItem = {
      ...secondTemplateBase,
      title: 'Requested second template',
      contentBody: {
        ...secondTemplateBase.contentBody,
        'sfdc_cms:title': 'Requested second template',
      },
    };
    const secondPage = page('second_page');
    const loaded = source([page(), firstTemplate, secondPage, secondTemplate]);
    loaded.manifest.landingPageTemplatePairs = [
      loaded.manifest.landingPageTemplatePairs![0],
      {
        page: {
          apiName: secondPage.apiName!,
          contentKey: secondPage.contentKey,
          variantId: secondPage.id,
        },
        template: {
          requestedTitle: secondTemplate.title,
          apiName: secondTemplate.apiName!,
          contentKey: secondTemplate.contentKey,
          variantId: secondTemplate.id,
        },
        compatibility: {
          basis: 'declared-source-pair',
          relationship: 'opaque-structural-match',
        },
      },
    ];
    const before = structuredClone(loaded);
    const result = planLandingPageCopies(loaded, [
      {
        ...mapping('second_page', 'fresh_second'),
        templateDependency: {
          source: {
            requestedTitle: 'Requested second template',
            apiName: 'second_template',
            contentKey: 'second_template_key',
          },
          targetContentKey: 'target-second-template-key',
        },
      },
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

  it('rejects a noncanonical target content key through the template planner', () => {
    const invalid = {
      ...mapping(),
      target: { ...mapping().target, contentKey: 'fresh_landing_page_key' },
    };
    expect(() => planLandingPageCopies(source(), [invalid])).to.throw(
      'Template mapping 0.target.contentKey must match ^MC[A-Z2-7]{26}$',
    );
  });

  it('uses the landing-page content type for its derived-label boundary', () => {
    const boundary = 'P'.repeat(57);
    expect(
      planLandingPageCopies(source(), [mapping('source_page', boundary)]),
    ).to.have.nested.property('items[0].apiName', boundary);

    const tooLong = 'P'.repeat(58);
    expect(() => planLandingPageCopies(source(), [mapping('source_page', tooLong)])).to.throw(
      `Landing-page mapping 0.target.apiName ${tooLong} produces Salesforce label ${tooLong}--sfdc_cms__landingPage with length 81; maximum is 80`,
    );
  });

  it('binds the exact manifest pair and rejects selector disagreement', () => {
    const planned = planLandingPageCopies(source(), [mapping()]);
    expect(planned.templateDependencies[0].source).to.deep.include({
      requestedTitle: 'Requested template',
      apiName: 'source_template',
      contentKey: 'source_template_key',
    });
    expect(planned.items[0].contentBody).not.to.have.property('templateReference');
    expect(() =>
      planLandingPageCopies(source(), [
        {
          ...mapping(),
          templateDependency: {
            ...mapping().templateDependency,
            source: { ...mapping().templateDependency.source, apiName: 'wrong_template' },
          },
        },
      ]),
    ).to.throw('disagrees with manifest');
  });

  it('accepts only title/url differences and rejects other pair differences', () => {
    const loaded = source();
    const templateIndex = loaded.items.findIndex(
      ({ contentType }) => contentType === 'sfdc_cms__landingPageTemplate',
    );
    const sourceTemplate = loaded.items[templateIndex];
    const changed: LoadedWorkspaceExport = {
      ...loaded,
      items: loaded.items.map((item, index) =>
        index === templateIndex
          ? {
              ...sourceTemplate,
              contentBody: {
                ...sourceTemplate.contentBody,
                'sfdc_cms:description': 'Different structure',
              },
            }
          : item,
      ),
    };
    expect(() => planLandingPageCopies(changed, [mapping()])).to.throw(
      'differ outside title/urlName',
    );
  });

  it('keeps any additional unsupported relationship blocking', () => {
    const loaded = source();
    loaded.manifest.externalReferences.push({
      ...loaded.manifest.externalReferences[0],
      referenceId: `ref:${'d'.repeat(64)}`,
      portableKey: { scheme: 'cms-opaque-v1', value: 'additional-opaque-relationship' },
    });
    const proposal = planLandingPageCopies(loaded, [mapping()]);
    const relationshipIds = new Set(
      proposal.compatibility.map(({ relationshipReferenceId }) => relationshipReferenceId),
    );
    const remaining = loaded.manifest.externalReferences.filter(
      ({ referenceId }) => !relationshipIds.has(referenceId),
    );
    expect(remaining).to.have.length(1);
    expect(remaining[0].resolution).to.equal('unsupported');
  });

  it('validates the template dependency selector matrix', () => {
    const base = mapping();
    for (const templateDependency of [
      { source: base.templateDependency.source },
      {
        source: base.templateDependency.source,
        targetContentKey: 'key',
        targetApiName: 'api',
      },
      {
        source: base.templateDependency.source,
        targetContentKey: 'key',
        targetTitle: 'Title',
      },
      {
        source: base.templateDependency.source,
        targetApiName: 'api',
        targetId: 'forbidden-id',
      },
    ]) {
      expect(() => planLandingPageCopies(source(), [{ ...base, templateDependency }])).to.throw();
    }
  });

  it('normalizes image and Data Graph transformations for compatibility only', () => {
    const loaded = source();
    const templateIndex = loaded.items.findIndex(
      ({ contentType }) => contentType === 'sfdc_cms__landingPageTemplate',
    );
    const sourceTemplate = loaded.items[templateIndex];
    const transformedBody = structuredClone(sourceTemplate.contentBody);
    const providers = transformedBody['lightning:dataProviders'] as Array<{
      attributes: { dataGraphApiName: string; dataspace: string };
    }>;
    providers[0].attributes = { dataGraphApiName: 'OtherGraph', dataspace: 'otherSpace' };
    const block = transformedBody['sfdc_cms:block'] as {
      children: Array<{
        attributes: {
          imageInfo: { source: { ref: { contentKey: string } }; url: string };
        };
      }>;
    };
    block.children[0].attributes.imageInfo.source.ref.contentKey = 'template-image-key';
    block.children[0].attributes.imageInfo.url =
      '/cms/media/template-image-key?fileName=hero.png&fileHash=different';
    const transformed: LoadedWorkspaceExport = {
      ...loaded,
      items: loaded.items.map((item, index) =>
        index === templateIndex ? { ...sourceTemplate, contentBody: transformedBody } : item,
      ),
    };
    expect(planLandingPageCopies(transformed, [mapping()]).compatibility[0].status).to.equal(
      'passed',
    );
  });

  for (const identity of [
    {
      label: 'legacy id and equal parent aliases',
      fields: { id: 'target-template-variant', contentId: 'target-template-content' },
    },
    {
      label: 'managedContentVariantId',
      fields: { managedContentVariantId: 'target-template-variant' },
    },
    {
      label: 'equal dual fields',
      fields: {
        id: 'target-template-variant',
        managedContentVariantId: 'target-template-variant',
      },
    },
  ]) {
    it(`resolves a Draft unpublished target template with ${identity.label}`, async () => {
      const proposal = planLandingPageCopies(source(), [mapping()]);
      const request = sinon.stub().callsFake(({ url }: { url: string }) => {
        if (url.includes('/items/search')) {
          return Promise.resolve({
            items: [
              {
                id: 'target-template-variant',
                managedContentSpaceId: 'destination-space',
                type: 'ManagedContentVariantSearchResultRepresentation',
              },
            ],
            total: 1,
          });
        }
        return Promise.resolve({
          apiName: 'target_template',
          contentKey: 'target-template-key',
          contentSpace: { id: 'destination-space' },
          contentType: 'sfdc_cms__landingPageTemplate',
          ...identity.fields,
          managedContentId: 'target-template-content',
          isPublished: false,
          status: { status: 'Draft' },
          title: 'Target template',
          contentBody: structuredClone(body),
        });
      });
      const before = structuredClone(proposal.items);
      await resolveLandingPageTemplateDependencies(
        { request, version: '67.0' },
        'destination-space',
        proposal,
      );
      expect(proposal.templateDependencies[0]).to.deep.include({
        resolution: 'api-name',
        validationStatus: 'passed',
      });
      expect(proposal.templateDependencies[0].target?.variantId).to.equal(
        'target-template-variant',
      );
      expect(proposal.items).to.deep.equal(before);
    });
  }

  for (const identity of [
    {
      label: 'conflicting dual fields',
      fields: { id: 'target-template-variant', managedContentVariantId: 'different-variant' },
    },
    { label: 'missing identity', fields: {} },
    { label: 'malformed parent alias', fields: { id: 'target-template-variant', contentId: null } },
  ]) {
    it(`rejects a target template with ${identity.label}`, async () => {
      const proposal = planLandingPageCopies(source(), [mapping()]);
      const request = sinon.stub().callsFake(({ url }: { url: string }) => {
        if (url.includes('/items/search')) {
          return Promise.resolve({
            items: [
              {
                id: 'target-template-variant',
                managedContentSpaceId: 'destination-space',
                type: 'ManagedContentVariantSearchResultRepresentation',
              },
            ],
            total: 1,
          });
        }
        return Promise.resolve({
          apiName: 'target_template',
          contentKey: 'target-template-key',
          contentSpace: { id: 'destination-space' },
          contentType: 'sfdc_cms__landingPageTemplate',
          ...identity.fields,
          managedContentId: 'target-template-content',
          isPublished: false,
          status: { status: 'Draft' },
          title: 'Target template',
          contentBody: structuredClone(body),
        });
      });
      let failure: unknown;
      try {
        await resolveLandingPageTemplateDependencies(
          { request, version: '67.0' },
          'destination-space',
          proposal,
        );
      } catch (error) {
        failure = error;
      }
      expect(failure).to.be.instanceOf(TypeError);
      expect(proposal.templateDependencies[0].validationStatus).to.equal('failed');
    });
  }

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
    const request = sinon.stub().callsFake(({ url }: { url: string }) => {
      if (url.includes('/ssot/data-graphs/')) {
        return Promise.resolve({ name: 'Marketing', dataspaceName: 'default', status: 'ready' });
      }
      if (url.includes('/items/search')) {
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
      return Promise.resolve({
        apiName: 'target_image',
        contentKey: 'target-image-key',
        contentSpace: { id: 'destination-space' },
        contentType: 'sfdc_cms__image',
        id: 'image-variant',
        title: 'Target image title',
      });
    });
    await validateLandingPagePrerequisites(
      { query, request, version: '67.0' },
      'destination-space',
      proposal,
    );
    const serialized = JSON.stringify(proposal.items[0].contentBody);
    expect(serialized).not.to.include('source-image-key');
    expect(serialized).to.include('/cms/media/target-image-key?fileName=hero.png');
    expect(proposal.cmsPrerequisites[0].resolution).to.equal('api-name');
  });

  it('falls back to exact title only after successful zero API-name matches', async () => {
    const proposal = planLandingPageCopies(source(), [mapping()]);
    let searches = 0;
    const request = sinon.stub().callsFake(({ url }: { url: string }) => {
      if (url.includes('/ssot/data-graphs/'))
        return Promise.resolve({ name: 'Marketing', dataspaceName: 'default', status: 'ready' });
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
        version: '67.0',
      },
      'destination-space',
      proposal,
    );
    expect(proposal.cmsPrerequisites[0].resolution).to.equal('title-fallback');
    expect(searches).to.equal(2);
  });

  it('dry-runs without mutation and apply rechecks identity and prerequisites before create', async () => {
    let apiQueries = 0;
    let graphRequests = 0;
    let searches = 0;
    let contentGets = 0;
    const query = sinon.stub().callsFake((soql: string) => {
      if (soql.startsWith('SELECT ApiName')) apiQueries += 1;
      return Promise.resolve({ done: true, records: [], totalSize: 0 });
    });
    const request = sinon.stub().callsFake(({ method, url }: { method: string; url: string }) => {
      if (url.includes('/ssot/data-graphs/')) {
        graphRequests += 1;
        return Promise.resolve({ name: 'Marketing', dataspaceName: 'default', status: 'ready' });
      }
      if (url.includes('/items/search')) {
        searches += 1;
        const id = searches % 2 === 1 ? 'target-template-variant' : 'image-variant';
        return Promise.resolve({
          items: [
            {
              id,
              managedContentSpaceId: 'destination-space',
              type: 'ManagedContentVariantSearchResultRepresentation',
            },
          ],
          total: 1,
        });
      }
      if (url.includes('/variants/target-template-variant')) {
        return Promise.resolve({
          apiName: 'target_template',
          contentKey: 'target-template-key',
          contentSpace: { id: 'destination-space' },
          contentType: 'sfdc_cms__landingPageTemplate',
          contentBody: structuredClone(body),
          id: 'target-template-variant',
          managedContentId: 'target-template-content',
          isPublished: false,
          status: { status: 'Draft' },
          title: 'Target template',
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
        contentKey: VALID_PAGE_CONTENT_KEYS.fresh_page,
        id: 'created-content',
        primaryVariantId: 'created-variant',
      });
    });
    const common = {
      connection: { query, request, version: '67.0' },
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
    expect(dryRun.report).to.equal(undefined);
    expect(dryRun.reportFile).to.equal(undefined);
    expect(dryRun.templatePrerequisites?.[0].preflight).to.include({ status: 'passed' });
    expect(dryRun.templatePrerequisites?.[0]).not.to.have.property('preCreate');
    expect(request.getCalls().filter(({ args }) => args[0].method === 'POST')).to.have.length(0);

    const { mkdtemp, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const root = await mkdtemp(path.join(tmpdir(), 'cms-landing-page-'));
    try {
      const postBodies: Array<Record<string, unknown>> = [];
      request.callsFake(
        ({ body: requestBody, method, url }: { body?: string; method: string; url: string }) => {
          if (url.includes('/ssot/data-graphs/')) {
            graphRequests += 1;
            return Promise.resolve({
              name: 'Marketing',
              dataspaceName: 'default',
              status: 'active',
            });
          }
          if (url.includes('/items/search')) {
            searches += 1;
            const id = searches % 2 === 1 ? 'target-template-variant' : 'image-variant';
            return Promise.resolve({
              items: [
                {
                  id,
                  managedContentSpaceId: 'destination-space',
                  type: 'ManagedContentVariantSearchResultRepresentation',
                },
              ],
              total: 1,
            });
          }
          if (url.includes('/variants/target-template-variant')) {
            return Promise.resolve({
              apiName: 'target_template',
              contentKey: 'target-template-key',
              contentSpace: { id: 'destination-space' },
              contentType: 'sfdc_cms__landingPageTemplate',
              contentBody: structuredClone(body),
              id: 'target-template-variant',
              managedContentId: 'target-template-content',
              isPublished: false,
              status: { status: 'Draft' },
              title: 'Target template',
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
          return readFile(path.join(root, 'report', 'workspace-import-run.json'), 'utf8').then(
            (bytes) => {
              const journal = JSON.parse(bytes) as {
                operations: Array<{ state: string }>;
                templatePrerequisites: Array<{
                  preCreate?: { status: string };
                  finalRequestSha256?: string;
                }>;
              };
              expect(journal.operations.at(-1)?.state).to.equal('pending');
              expect(journal.templatePrerequisites[0].preCreate?.status).to.equal('passed');
              expect(journal.templatePrerequisites[0].finalRequestSha256).to.match(
                /^[a-f\d]{64}$/u,
              );
              return {
                contentKey: VALID_PAGE_CONTENT_KEYS.fresh_page,
                id: 'created-content',
                primaryVariantId: 'created-variant',
              };
            },
          );
        },
      );
      const applied = await executeWorkspaceImport({
        ...common,
        dryRun: false,
        reportDirectory: path.join(root, 'report'),
      });
      expect(applied.report?.state).to.equal('completed');
      expect(applied.templatePrerequisites?.[0].preflight.status).to.equal('passed');
      expect(applied.templatePrerequisites?.[0]).to.deep.include({
        sourcePage: {
          apiName: 'source_page',
          contentKey: 'source_page_key',
          variantId: 'source_page_variant',
        },
        sourceTemplate: {
          requestedTitle: 'Requested template',
          apiName: 'source_template',
          contentKey: 'source_template_key',
          variantId: 'source_template_variant',
        },
        requestedTargetSelector: {
          apiName: 'target_template',
          title: 'Target template',
        },
      });
      expect(applied.templatePrerequisites?.[0].normalization.version).to.equal(
        'landing-page-template-compatibility-v1',
      );
      expect(applied.templatePrerequisites?.[0].relationship.referenceId).to.match(/^ref:/u);
      expect(applied.templatePrerequisites?.[0].preCreate?.status).to.equal('passed');
      expect(applied.templatePrerequisites?.[0].finalRequestSha256).to.equal(
        createHash('sha256').update(JSON.stringify(postBodies[0])).digest('hex'),
      );
      expect(applied.templatePrerequisites?.[0].returned).to.deep.include({
        contentId: 'created-content',
        contentKey: VALID_PAGE_CONTENT_KEYS.fresh_page,
        primaryVariantId: 'created-variant',
        state: 'unverified',
      });
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
      expect(graphRequests).to.equal(3);
      expect(searches).to.equal(6);
      expect(contentGets).to.equal(3);
      expect(request.getCalls().filter(({ args }) => args[0].method === 'POST')).to.have.length(1);
      expect(postBodies).to.have.length(1);
      expect(JSON.stringify(postBodies[0])).not.to.include('source-image-key');
      expect(JSON.stringify(postBodies[0])).not.to.include('/cms/media/source-image-key');
      expect(JSON.stringify(postBodies[0])).not.to.include('target-template-key');
      expect(JSON.stringify(postBodies[0])).to.include('/cms/media/target-image-key');
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  for (const drift of ['status', 'body', 'workspace'] as const) {
    it(`blocks ${drift} drift before landing-page CREATE`, async () => {
      let templateReads = 0;
      const request = sinon.stub().callsFake(({ method, url }: { method: string; url: string }) => {
        if (url.includes('/ssot/data-graphs/')) {
          return Promise.resolve({ name: 'Marketing', dataspaceName: 'default', status: 'ready' });
        }
        if (url.includes('/items/search')) {
          const templateSearch = request
            .getCalls()
            .filter(({ args }) => String(args[0].url).includes('/items/search')).length;
          const id = templateSearch % 2 === 1 ? 'target-template-variant' : 'image-variant';
          return Promise.resolve({
            items: [
              {
                id,
                managedContentSpaceId: 'destination-space',
                type: 'ManagedContentVariantSearchResultRepresentation',
              },
            ],
            total: 1,
          });
        }
        if (url.includes('/variants/target-template-variant')) {
          templateReads += 1;
          return Promise.resolve({
            apiName: 'target_template',
            contentKey: 'target-template-key',
            contentSpace: {
              id:
                drift === 'workspace' && templateReads === 2 ? 'other-space' : 'destination-space',
            },
            contentType: 'sfdc_cms__landingPageTemplate',
            contentBody:
              drift === 'body' && templateReads === 2
                ? { ...structuredClone(body), 'sfdc_cms:description': 'drifted' }
                : structuredClone(body),
            id: 'target-template-variant',
            managedContentId: 'target-template-content',
            isPublished: false,
            status: { status: drift === 'status' && templateReads === 2 ? 'Published' : 'Draft' },
            title: 'Target template',
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
        throw new Error('CREATE must not be called after drift');
      });
      const { mkdtemp, rm } = await import('node:fs/promises');
      const { tmpdir } = await import('node:os');
      const root = await mkdtemp(path.join(tmpdir(), 'cms-landing-page-drift-'));
      try {
        let failure: unknown;
        try {
          await executeWorkspaceImport({
            connection: {
              query: sinon.stub().resolves({ done: true, records: [], totalSize: 0 }),
              request,
              version: '67.0',
            },
            destinationOrgId: 'target-org',
            destinationWorkspace: {
              defaultLanguage: 'en_US',
              id: 'destination-space',
              rootFolderId: 'root-folder',
            },
            landingPageMappings: [mapping()],
            loadedSource: source(),
            reportDirectory: path.join(root, 'report'),
            sourceDirectory: 'synthetic-source',
            workspaceId: 'destination-space',
          });
        } catch (error) {
          failure = error;
        }
        expect(failure).to.be.instanceOf(Error);
        expect(request.getCalls().filter(({ args }) => args[0].method === 'POST')).to.have.length(
          0,
        );
      } finally {
        await rm(root, { force: true, recursive: true });
      }
    });
  }
});
