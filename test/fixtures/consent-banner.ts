import type {
  LoadedWorkspaceExport,
  WorkspaceImportItem,
} from '../../src/services/import-workspace.js';

const IDS = [
  '10000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000002',
  '10000000-0000-4000-8000-000000000003',
  '10000000-0000-4000-8000-000000000004',
  '10000000-0000-4000-8000-000000000005',
  '10000000-0000-4000-8000-000000000006',
  '10000000-0000-4000-8000-000000000007',
  '10000000-0000-4000-8000-000000000008',
] as const;
const backgroundImage = { position: 'center center', repeat: 'no-repeat', size: 'cover' };
const columnLayout = {
  'lightning:backgroundImage': backgroundImage,
  'lightning:borderRadius': '{!$brand.borderRadius.square}',
  'lightning:borderWidth': '{!$brand.borderWeight.none}',
  'lightning:colorScheme': '{!$brand.colorScheme}',
  'lightning:margin': '{!$brand.spacing.none}',
  'lightning:padding': '{!$brand.spacing.xSmall}',
  'lightning:verticalAlignment': 'top',
};

function button(id: string, style: 'primary' | 'secondary', text: 'Allow' | 'Reject') {
  const definition =
    style === 'primary' ? 'sfdc_cms__consentAcceptAction' : 'sfdc_cms__consentRejectAction';
  return {
    attributes: {
      'lightning:borderRadius': `{!$brand.buttonStyleGroup.${style}.lightning:borderRadius}`,
      'lightning:borderWidth': `{!$brand.buttonStyleGroup.${style}.lightning:borderWidth}`,
      'lightning:buttonColorGroup': `{!$brand.buttonStyleGroup.${style}.lightning:buttonColorGroup}`,
      'lightning:click': { actions: [{ attributes: {}, definition }] },
      'lightning:horizontalAlignment': 'center',
      'lightning:margin': '{!$brand.spacing.none}',
      'lightning:padding': `{!$brand.buttonStyleGroup.${style}.lightning:padding}`,
      'lightning:typography': `{!$brand.buttonStyleGroup.${style}.lightning:typography}`,
      'sfdc_cms:styleGroup': `{!$brand.buttonStyleGroup.${style}}`,
      text,
      width: { unit: '%', value: 100 },
    },
    children: [],
    definition: 'lightning/actionButton',
    id,
    type: 'block',
  };
}

export function consentBannerBody(title = 'Consent banner', ids: readonly string[] = IDS) {
  return {
    'lightning:brandSource': { defaultBrandOption: 'sfdcBrand' },
    'lightning:colorScheme': '{!$brand.colorScheme}',
    'lightning:dataProviders': [],
    'lightning:horizontalAlignment': 'center',
    'lightning:padding': '{!$brand.spacing.none}',
    'lightning:verticalAlignment': 'bottom',
    maxWidth: { unit: '%', value: 70 },
    minWidth: { unit: 'px', value: 200 },
    'sfdc_cms:block': {
      children: [
        {
          attributes: {
            'lightning:backgroundImage': backgroundImage,
            'lightning:borderRadius': '{!$brand.borderRadius.square}',
            'lightning:borderWidth': '{!$brand.borderWeight.thin}',
            'lightning:colorScheme': '{!$brand.colorScheme}',
            'lightning:margin': '{!$brand.spacing.small}',
            'lightning:padding': '{!$brand.spacing.xSmall}',
            reverseOrderOnMobile: false,
            stackOnMobile: true,
          },
          children: [
            {
              attributes: { ...columnLayout, columnWidth: 8 },
              children: [
                {
                  attributes: {
                    align: 'left',
                    'lightning:borderRadius': '{!$brand.borderRadius.square}',
                    'lightning:borderWidth': '{!$brand.borderWeight.none}',
                    'lightning:colorGroup': {
                      backgroundColor: '{!$brand.colorScheme.root}',
                      borderColor: '{!$brand.colorScheme.neutral}',
                      linkColor: '{!$brand.colorScheme.primaryAccent}',
                      textColor: '{!$brand.colorScheme.contrast}',
                    },
                    'lightning:margin': '{!$brand.spacing.none}',
                    'lightning:padding': '{!$brand.spacing.none}',
                    'lightning:typography': '{!$brand.typography.paragraph.paragraph1}',
                  },
                  children: [],
                  definition: 'lightning/paragraph',
                  id: ids[3],
                  type: 'block',
                },
              ],
              definition: 'lightning/column',
              id: ids[2],
              type: 'block',
            },
            {
              attributes: { ...columnLayout, columnWidth: 2 },
              children: [button(ids[5], 'secondary', 'Reject')],
              definition: 'lightning/column',
              id: ids[4],
              type: 'block',
            },
            {
              attributes: { ...columnLayout, columnWidth: 2 },
              children: [button(ids[6], 'primary', 'Allow')],
              definition: 'lightning/column',
              id: ids[7],
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
    'sfdc_cms:title': title,
  };
}

export function consentBannerItem(
  overrides: Partial<WorkspaceImportItem> = {},
): WorkspaceImportItem {
  return {
    apiName: 'source_consent_banner_api',
    contentBody: consentBannerBody(),
    contentKey: 'MCCCCCCCCCCCCCCCCCCCCCCCCCCC',
    contentSpace: { id: 'source-space' },
    contentType: 'sfdc_cms__consentBanner',
    id: 'source-consent-banner-variant',
    language: 'en_US',
    title: 'Consent banner',
    urlName: 'consent-banner',
    ...overrides,
  };
}

export function consentBannerDetail(
  kind: 'content' | 'variant' = 'variant',
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const common = {
    apiName: 'source_consent_banner_api',
    contentBody: consentBannerBody(),
    contentFqn: 'marketing--workspace.sfdc_cms__consentBanner--source_consent_banner_api',
    contentKey: 'MCCCCCCCCCCCCCCCCCCCCCCCCCCC',
    contentSpace: { id: 'source-space', resourceUrl: '/connect/cms/spaces/source-space' },
    contentType: { fullyQualifiedName: 'sfdc_cms__consentBanner' },
    createdBy: { id: 'user-id', resourceUrl: '/users/user-id' },
    createdDate: '2026-10-01T00:00:00.000Z',
    externalId: null,
    folder: { id: 'folder-id', resourceUrl: '/connect/cms/folders/folder-id' },
    isPublished: false,
    language: 'en_US',
    lastModifiedBy: { id: 'user-id', resourceUrl: '/users/user-id' },
    lastModifiedDate: '2026-10-01T00:00:00.000Z',
    managedContentId: 'content-consent-banner-id',
    managedContentVariantId: 'variant-consent-banner-id',
    managedContentVersionId: 'version-consent-banner-id',
    status: { label: 'Draft', status: 'Draft' },
    title: 'Consent banner',
    urlName: 'consent-banner',
  };
  return {
    ...common,
    ...(kind === 'content'
      ? { contentId: 'content-consent-banner-id' }
      : { id: 'variant-consent-banner-id' }),
    ...overrides,
  };
}

export function consentBannerSource(item = consentBannerItem()): LoadedWorkspaceExport {
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
          file: 'items/source-consent-banner-variant.json',
          variantId: 'source-consent-banner-variant',
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
          path: 'items/source-consent-banner-variant.json',
          sha256: 'a'.repeat(64),
          kind: 'cms.content',
        },
      ],
    },
    manifestSha256: 'b'.repeat(64),
    sourceDirectory: 'synthetic-source',
  };
}
