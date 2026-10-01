import { expect } from 'chai';
import {
  assertBrandReadback,
  brandCreatePayload,
  planBrandCopies,
  validateBrandImportReadReport,
} from '../../src/services/brand.js';
import type {
  LoadedWorkspaceExport,
  WorkspaceImportItem,
} from '../../src/services/import-workspace.js';

function item(body: WorkspaceImportItem['contentBody']): WorkspaceImportItem {
  return {
    apiName: 'source_brand',
    contentBody: body,
    contentKey: 'source-key',
    contentSpace: { id: 'source-space' },
    contentType: 'sfdc_cms__brand',
    id: 'source-variant',
    language: 'en_US',
    title: 'Source Brand',
    urlName: 'source-brand',
  };
}

function source(raw: WorkspaceImportItem): LoadedWorkspaceExport {
  return {
    integrity: {
      listedItemCount: 2,
      verifiedItemCount: 2,
      unlistedFileCount: 0,
      verified: true,
    },
    isPartial: false,
    items: [raw],
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
      expectedCount: 1,
      foundCount: 1,
      exportedCount: 1,
      pagesRequested: 1,
      entries: [{ file: 'items/source-variant.json', variantId: 'source-variant' }],
      rejectedVariantIds: [],
      failedVariantIds: [],
      warnings: [],
      contract: 'sf-cms-workspace-export',
      contractVersion: '1.0.0',
      provenance: {
        producer: 'sf-plugin-cms',
        sourceOrgId: 'source-org',
        sourceWorkspaceId: 'source-space',
        pluginVersion: '0.7.0',
        generatedAt: '2026-10-01T00:00:00.000Z',
      },
      completeness: 'complete',
      dependencies: [],
      externalReferences: [],
      items: [],
    },
    manifestSha256: 'a'.repeat(64),
    sourceDirectory: 'synthetic',
  };
}

function mapping() {
  return {
    source: { family: 'cms', type: 'brand', apiName: 'source_brand' },
    target: { apiName: 'target_brand', title: 'Target Brand', urlName: 'target-brand' },
  };
}

function readback(
  kind: 'content' | 'variant',
  body: WorkspaceImportItem['contentBody'],
): Record<string, unknown> {
  return {
    apiName: 'target_brand',
    contentBody: body,
    contentSpace: { id: 'target-space' },
    contentType: { fullyQualifiedName: 'sfdc_cms__brand' },
    isPublished: false,
    language: 'en_US',
    managedContentId: 'created-content',
    managedContentVariantId: 'created-variant',
    status: { label: 'Draft', status: 'Draft' },
    title: 'Target Brand',
    urlName: 'target-brand',
    ...(kind === 'content' ? { contentId: 'created-content' } : { id: 'created-variant' }),
  };
}

describe('Brand CREATE planning', () => {
  it('preserves broad body semantics and rewrites only target identity and present title', () => {
    const body = {
      arbitraryFutureShape: { sourceId: 'opaque-value', id: 'not-a-block-id' },
      'lightning:dataProviders': [],
      'sfdc_cms:title': 'Source Brand',
      'sfdc_cms:variants': [],
    };
    const plan = planBrandCopies(source(item(body)), [mapping()]);
    const planned = plan.items[0];
    expect(planned.apiName).to.equal('target_brand');
    expect(planned.title).to.equal('Target Brand');
    expect(planned.urlName).to.equal('target-brand');
    expect(planned.contentBody).to.deep.equal({
      arbitraryFutureShape: { sourceId: 'opaque-value', id: 'not-a-block-id' },
      'lightning:dataProviders': [],
      'sfdc_cms:title': 'Target Brand',
      'sfdc_cms:variants': [],
    });
    expect(brandCreatePayload(planned, 'destination-root')).to.deep.equal({
      apiName: 'target_brand',
      contentBody: planned.contentBody,
      contentSpaceOrFolderId: 'destination-root',
      contentType: 'sfdc_cms__brand',
      title: 'Target Brand',
      urlName: 'target-brand',
    });
  });

  it('preserves an absent embedded title and regenerates only objective block IDs', () => {
    const body = {
      nested: {
        id: 'ordinary-id',
        type: 'configuration',
        child: {
          id: '10000000-0000-4000-8000-000000000001',
          type: 'block',
          value: 'kept',
        },
      },
    };
    const plan = planBrandCopies(
      source(item(body)),
      [mapping()],
      () => '20000000-0000-4000-8000-000000000001',
    );
    expect(plan.items[0].contentBody).to.deep.equal({
      nested: {
        id: 'ordinary-id',
        type: 'configuration',
        child: {
          id: '20000000-0000-4000-8000-000000000001',
          type: 'block',
          value: 'kept',
        },
      },
    });
  });

  it('admits opaque import body fields while binding report identity and provenance', () => {
    const report = {
      apiName: 'source_brand',
      format: 'sf-cms-brand-read-report@1',
      normalization: {
        semantic: {
          body: { futureServerField: { retained: true } },
          contentType: 'sfdc_cms__brand',
          title: 'Source Brand',
        },
        provenance: {
          contentSpaceId: 'source-space',
          managedContentId: 'source-content',
          managedContentVariantId: 'source-variant',
        },
        unresolvedReferences: [],
      },
      rawItemPath: 'items/source-variant.json',
      variantId: 'source-variant',
      workspaceId: 'source-space',
    };
    expect(validateBrandImportReadReport(report)).to.equal(true);
    expect(
      validateBrandImportReadReport({
        ...report,
        normalization: { ...report.normalization, unresolvedReferences: ['unsafe-source-id'] },
      }),
    ).to.equal(false);
  });

  it('requires fresh exact mappings and fresh generated block UUIDs', () => {
    expect(() =>
      planBrandCopies(source(item({})), [
        {
          source: { family: 'cms', type: 'brand', apiName: 'source_brand' },
          target: { apiName: 'source_brand', title: 'Target Brand', urlName: 'target-brand' },
        },
      ]),
    ).to.throw('fresh and unique');
    expect(() =>
      planBrandCopies(
        source(item({ id: '10000000-0000-4000-8000-000000000001', type: 'block' })),
        [mapping()],
        () => '10000000-0000-4000-8000-000000000001',
      ),
    ).to.throw('fresh unique UUID v4');
  });

  it('accepts independent matching Draft readback and rejects semantic drift', () => {
    const planned = planBrandCopies(source(item({ custom: true })), [mapping()]).items[0];
    expect(() =>
      assertBrandReadback(
        readback('content', planned.contentBody),
        readback('variant', planned.contentBody),
        {
          workspaceId: 'target-space',
          apiName: 'target_brand',
          title: 'Target Brand',
          urlName: 'target-brand',
          contentId: 'created-content',
          variantId: 'created-variant',
          language: 'en_US',
          body: planned.contentBody,
        },
      ),
    ).not.to.throw();
    expect(() =>
      assertBrandReadback(
        readback('content', planned.contentBody),
        readback('variant', { custom: false }),
        {
          workspaceId: 'target-space',
          apiName: 'target_brand',
          title: 'Target Brand',
          urlName: 'target-brand',
          contentId: 'created-content',
          variantId: 'created-variant',
          language: 'en_US',
          body: planned.contentBody,
        },
      ),
    ).to.throw('differs from target');
  });
});
