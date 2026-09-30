import { expect } from 'chai';
import { planImportIdentities } from '../../src/services/import-identities.js';
import type {
  LoadedWorkspaceExport,
  WorkspaceImportItem,
} from '../../src/services/import-workspace.js';

const SOURCE_CONTENT_KEY = 'MCAAAAAAAAAAAAAAAAAAAAAAAAAA';

function source(): LoadedWorkspaceExport {
  const item: WorkspaceImportItem = {
    apiName: 'SourceApi',
    contentBody: { 'sfdc_cms:title': 'Source' },
    contentKey: SOURCE_CONTENT_KEY,
    contentSpace: { id: 'source-space' },
    contentType: 'sfdc_cms__news',
    id: 'source-variant',
    language: 'en_US',
    title: 'Source',
    urlName: 'source-url',
  };
  return {
    integrity: { listedItemCount: 1, unlistedFileCount: 0, verified: true, verifiedItemCount: 1 },
    isPartial: false,
    items: [item],
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
      warnings: [{ code: 'UNSUPPORTED_WILDCARD', message: 'provenance only' }],
      contract: 'sf-cms-workspace-export',
      contractVersion: '1.0.0',
      provenance: {
        producer: 'sf-plugin-cms',
        sourceOrgId: 'source-org',
        sourceWorkspaceId: 'source-space',
        pluginVersion: '0.5.0',
        generatedAt: '2026-09-29T00:00:00.000Z',
      },
      completeness: 'complete',
      dependencies: [],
      externalReferences: [],
      items: [{ path: 'items/source-variant.json', sha256: 'a'.repeat(64), kind: 'cms.content' }],
    },
    manifestSha256: 'b'.repeat(64),
    sourceDirectory: 'synthetic-source',
  };
}

describe('general explicit import identities', () => {
  it('rejects a noncanonical explicitly submitted target content key', () => {
    expect(() =>
      planImportIdentities(source(), [
        {
          sourceContentKey: SOURCE_CONTENT_KEY,
          contentKey: 'fresh_general_key',
          apiName: 'FreshApi',
          urlNames: { en_US: 'fresh-url' },
        },
      ]),
    ).to.throw('contentKey must match ^MC[A-Z2-7]{26}$');
  });
});
