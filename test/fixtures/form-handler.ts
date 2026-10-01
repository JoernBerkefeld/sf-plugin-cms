import type {
  LoadedWorkspaceExport,
  WorkspaceImportItem,
} from '../../src/services/import-workspace.js';

const ROOT_ID = '10000000-0000-4000-8000-000000000001';

export function formHandlerBody(title = 'External form handler', rootId = ROOT_ID) {
  return {
    'lightning:brandSource': { defaultBrandOption: 'sfdcBrand' },
    'lightning:dataProviders': [],
    'sfdc_cms:title': title,
    'sfdc_cms:block': {
      children: [],
      definition: 'sfdc_cms/rootContentBlock',
      id: rootId,
      type: 'block',
    },
  };
}

export function formHandlerItem(overrides: Partial<WorkspaceImportItem> = {}): WorkspaceImportItem {
  return {
    apiName: 'source_form_handler_api',
    contentBody: formHandlerBody(),
    contentKey: 'MCHHHHHHHHHHHHHHHHHHHHHHHHHH',
    contentSpace: { id: 'source-space' },
    contentType: 'sfdc_cms__formHandler',
    id: 'source-form-handler-variant',
    language: 'en_US',
    title: 'External form handler',
    urlName: 'external-form-handler',
    ...overrides,
  };
}

export function formHandlerDetail(
  kind: 'content' | 'variant' = 'variant',
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const common = {
    apiName: 'source_form_handler_api',
    contentBody: formHandlerBody(),
    contentFqn: 'marketing--workspace.sfdc_cms__formHandler--source_form_handler_api',
    contentKey: 'MCHHHHHHHHHHHHHHHHHHHHHHHHHH',
    contentSpace: { id: 'source-space', resourceUrl: '/connect/cms/spaces/source-space' },
    contentType: { fullyQualifiedName: 'sfdc_cms__formHandler' },
    createdBy: { id: 'user-id', resourceUrl: '/users/user-id' },
    createdDate: '2026-10-01T00:00:00.000Z',
    externalId: null,
    folder: { id: 'folder-id', resourceUrl: '/connect/cms/folders/folder-id' },
    isPublished: false,
    language: 'en_US',
    lastModifiedBy: { id: 'user-id', resourceUrl: '/users/user-id' },
    lastModifiedDate: '2026-10-01T00:00:00.000Z',
    managedContentId: 'content-form-handler-id',
    managedContentVariantId: 'variant-form-handler-id',
    managedContentVersionId: 'version-form-handler-id',
    status: { label: 'Draft', status: 'Draft' },
    title: 'External form handler',
    urlName: 'external-form-handler',
  };
  return {
    ...common,
    ...(kind === 'content'
      ? { contentId: 'content-form-handler-id' }
      : { id: 'variant-form-handler-id' }),
    ...overrides,
  };
}

export function formHandlerSource(item = formHandlerItem()): LoadedWorkspaceExport {
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
      entries: [
        {
          file: 'items/source-form-handler-variant.json',
          variantId: 'source-form-handler-variant',
        },
      ],
      rejectedVariantIds: [],
      failedVariantIds: [],
      warnings: [],
      contract: 'sf-cms-workspace-export',
      contractVersion: '1.0.0',
      provenance: {
        producer: 'sf-plugin-cms',
        sourceOrgId: 'source-org',
        sourceWorkspaceId: 'source-space',
        pluginVersion: '0.6.1',
        generatedAt: '2026-10-01T00:00:00.000Z',
      },
      completeness: 'complete',
      dependencies: [],
      externalReferences: [],
      items: [
        {
          path: 'items/source-form-handler-variant.json',
          sha256: 'a'.repeat(64),
          kind: 'cms.content',
        },
      ],
    },
    manifestSha256: 'b'.repeat(64),
    sourceDirectory: 'synthetic-source',
  };
}
