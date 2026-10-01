import type {
  LoadedWorkspaceExport,
  WorkspaceImportItem,
} from '../../src/services/import-workspace.js';

const IDS = [
  '10000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000002',
  '10000000-0000-4000-8000-000000000003',
  '10000000-0000-4000-8000-000000000004',
] as const;

const backgroundImage = { position: 'center center', repeat: 'no-repeat', size: 'cover' };
const baseLayout = {
  'lightning:backgroundImage': backgroundImage,
  'lightning:borderRadius': '{!$brand.borderRadius.square}',
  'lightning:borderWidth': '{!$brand.borderWeight.none}',
  'lightning:colorScheme': '{!$brand.colorScheme}',
  'lightning:margin': '{!$brand.spacing.none}',
  'lightning:padding': '{!$brand.spacing.xSmall}',
};

export function formBody(title = 'Contact form', ids: readonly string[] = IDS) {
  return {
    'lightning:brandSource': { defaultBrandOption: 'sfdcBrand' },
    'lightning:dataProviders': [],
    'sfdc_cms:title': title,
    'sfdc_cms:block': {
      children: [
        {
          attributes: { ...baseLayout, reverseOrderOnMobile: false, stackOnMobile: true },
          children: [
            {
              attributes: {
                ...baseLayout,
                columnWidth: 12,
                'lightning:verticalAlignment': 'top',
              },
              children: [
                {
                  attributes: {
                    actions: [
                      { type: 'custom', name: 'formsubmit' },
                      { type: 'built-in', name: 'umaFormSubmissionAction' },
                      { type: 'built-in', name: 'showThankYouAction' },
                    ],
                    label: 'Submit',
                  },
                  children: [],
                  definition: 'lightning/actionButton',
                  id: ids[3],
                  type: 'block',
                },
              ],
              definition: 'lightning/column',
              id: ids[2],
              type: 'block',
            },
          ],
          definition: 'lightning/section',
          id: ids[1],
          type: 'block',
        },
      ],
      definition: 'sfdc_cms/rootContentBlock',
      id: ids[0],
      type: 'block',
    },
  };
}

export function broadFormBody(title = 'Contact form'): WorkspaceImportItem['contentBody'] {
  const body = structuredClone(formBody(title)) as Record<string, unknown>;
  body['lightning:dataProviders'] = [
    {
      name: 'CustomerGraph',
      type: 'dataGraph',
      source: { externalId: 'graph-source', reference: 'source-ref' },
    },
  ];
  const root = body['sfdc_cms:block'] as Record<string, unknown>;
  const sections = root.children as Array<Record<string, unknown>>;
  const columns = sections[0].children as Array<Record<string, unknown>>;
  const blocks = columns[0].children as Array<Record<string, unknown>>;
  blocks.unshift({
    attributes: {
      fieldName: 'EmailAddress',
      flow: { apiName: 'ProcessForm' },
      formHandler: { apiName: 'HandleForm' },
      provider: 'CustomerGraph',
      ref: { contentKey: 'MCDEPENDENCY' },
    },
    children: [],
    definition: 'lightning/inputEmail',
    id: '10000000-0000-4000-8000-000000000005',
    type: 'block',
  });
  sections.push({
    attributes: { custom: true },
    children: [],
    definition: 'lightning/customSection',
    id: '10000000-0000-4000-8000-000000000006',
    type: 'block',
  });
  const button = blocks.at(-1)!;
  const attributes = button.attributes as Record<string, unknown>;
  (attributes.actions as Array<Record<string, unknown>>).push({
    type: 'custom',
    name: 'invokeFlow',
    target: 'ProcessForm',
  });
  return body as WorkspaceImportItem['contentBody'];
}
export function formItem(overrides: Partial<WorkspaceImportItem> = {}): WorkspaceImportItem {
  return {
    apiName: 'source_form_api',
    contentBody: formBody(),
    contentKey: 'MCBBBBBBBBBBBBBBBBBBBBBBBBBB',
    contentSpace: { id: 'source-space' },
    contentType: 'sfdc_cms__form',
    id: 'source-form-variant',
    language: 'en_US',
    title: 'Contact form',
    urlName: 'contact-form',
    ...overrides,
  };
}

export function formDetail(
  kind: 'content' | 'variant' = 'variant',
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const common = {
    apiName: 'source_form_api',
    contentBody: formBody(),
    contentFqn: 'marketing--workspace.sfdc_cms__form--source_form_api',
    contentKey: 'MCBBBBBBBBBBBBBBBBBBBBBBBBBB',
    contentSpace: { id: 'source-space', resourceUrl: '/connect/cms/spaces/source-space' },
    contentType: { fullyQualifiedName: 'sfdc_cms__form' },
    createdBy: { id: 'user-id', resourceUrl: '/users/user-id' },
    createdDate: '2026-10-01T00:00:00.000Z',
    externalId: null,
    folder: { id: 'folder-id', resourceUrl: '/connect/cms/folders/folder-id' },
    isPublished: false,
    language: 'en_US',
    lastModifiedBy: { id: 'user-id', resourceUrl: '/users/user-id' },
    lastModifiedDate: '2026-10-01T00:00:00.000Z',
    managedContentId: 'content-form-id',
    managedContentVariantId: 'variant-form-id',
    managedContentVersionId: 'version-form-id',
    status: { label: 'Draft', status: 'Draft' },
    title: 'Contact form',
    urlName: 'contact-form',
  };
  return {
    ...common,
    ...(kind === 'content' ? { contentId: 'content-form-id' } : { id: 'variant-form-id' }),
    ...overrides,
  };
}

export function formSource(item = formItem()): LoadedWorkspaceExport {
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
      entries: [{ file: 'items/source-form-variant.json', variantId: 'source-form-variant' }],
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
          path: 'items/source-form-variant.json',
          sha256: 'a'.repeat(64),
          kind: 'cms.content',
        },
      ],
    },
    manifestSha256: 'b'.repeat(64),
    sourceDirectory: 'synthetic-source',
  };
}
