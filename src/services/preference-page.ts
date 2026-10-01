const PREFERENCE_PAGE_TYPE = 'sfdc_cms__preferencePage' as const;
const BLOCK_KEY = 'sfdc_cms:block';
const SUBSCRIPTIONS_BLOCK = 'sfdc_cms/preferencePageSubscriptionsBlock';
const SUBMIT_BLOCK = 'sfdc_cms/preferencePageSubmitBlock';

const COMMON_LIVE_DETAIL_KEYS = [
  'contentType',
  'apiName',
  'managedContentId',
  'managedContentVariantId',
  'contentSpace',
  'contentBody',
  'contentFqn',
  'contentKey',
  'createdBy',
  'createdDate',
  'externalId',
  'folder',
  'isPublished',
  'language',
  'lastModifiedBy',
  'lastModifiedDate',
  'managedContentVersionId',
  'status',
  'title',
  'urlName',
] as const;
const CONTENT_DETAIL_KEYS = [...COMMON_LIVE_DETAIL_KEYS, 'contentId'] as const;
const VARIANT_DETAIL_KEYS = [...COMMON_LIVE_DETAIL_KEYS, 'id'] as const;
const CONTENT_TYPE_KEYS = ['fullyQualifiedName'] as const;
const CONTENT_SPACE_KEYS = ['id', 'resourceUrl'] as const;
const CONTENT_BODY_KEYS = [
  'lightning:brandSource',
  'lightning:dataProviders',
  'sfdc_cms:title',
  'sfdc_cms:description',
  BLOCK_KEY,
] as const;
const SUBSCRIPTIONS_ATTRIBUTE_KEYS = [
  'subscriptionConfig',
  'lightning:colorScheme',
  'lightning:typography',
  'lightning:padding',
  'lightning:margin',
  'lightning:borderRadius',
  'lightning:borderWidth',
] as const;
const SUBMIT_ATTRIBUTE_KEYS = [
  'lightning:colorScheme',
  'lightning:typography',
  'primaryButtonColorGroup',
  'primaryButtonTypography',
  'primaryButtonPadding',
  'primaryButtonBorderRadius',
  'primaryButtonBorderWidth',
  'secondaryButtonColorGroup',
  'secondaryButtonTypography',
  'secondaryButtonPadding',
  'secondaryButtonBorderRadius',
  'secondaryButtonBorderWidth',
  'lightning:padding',
  'lightning:margin',
  'lightning:borderRadius',
  'lightning:borderWidth',
] as const;

type JsonRecord = Record<string, unknown>;

export type PreferencePageUnresolvedReference = {
  readonly referenceKey: string;
  readonly kind: 'engagement-channel-type' | 'communication-subchannel-type';
  readonly sourceId: string;
};

export type PreferencePageSourceProvenance = {
  readonly managedContentId: string;
  readonly managedContentVariantId: string;
  readonly contentSpaceId: string;
};

export type PreferencePageSemanticBlock = {
  readonly definition: typeof SUBSCRIPTIONS_BLOCK | typeof SUBMIT_BLOCK;
  readonly type: 'block';
  readonly attributes: Readonly<JsonRecord>;
  readonly children: readonly PreferencePageSemanticBlock[];
};

export type PreferencePageSemanticContent = {
  readonly contentType: typeof PREFERENCE_PAGE_TYPE;
  readonly title: string;
  readonly description: string;
  readonly defaultBrandOption: string;
  readonly dataProviders: readonly unknown[];
  readonly blocks: readonly PreferencePageSemanticBlock[];
};

export type PreferencePageNormalization = {
  readonly semantic: PreferencePageSemanticContent;
  readonly provenance: PreferencePageSourceProvenance;
  readonly unresolvedReferences: readonly PreferencePageUnresolvedReference[];
};

export const PREFERENCE_PAGE_READ_REPORT_FORMAT = 'sf-cms-preference-page-read-report@1' as const;

export type PreferencePageReadReport = {
  readonly format: typeof PREFERENCE_PAGE_READ_REPORT_FORMAT;
  readonly workspaceId: string;
  readonly apiName: string;
  readonly variantId: string;
  readonly rawItemPath: string;
  readonly normalization: PreferencePageNormalization;
};

export type PreferencePageReadReportInput = Omit<PreferencePageReadReport, 'format'>;

export type PreferencePageReadReportExpectedIdentity = Partial<
  Pick<
    PreferencePageReadReport,
    'workspaceId' | 'apiName' | 'variantId' | 'rawItemPath' | 'normalization'
  >
>;

function record(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonemptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function hasOnlyKeys(value: JsonRecord, allowedKeys: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowedKeys.includes(key));
}

function hasExactKeys(value: JsonRecord, expectedKeys: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expectedKeys.length && hasOnlyKeys(value, expectedKeys);
}

function safeRawItemPath(value: unknown): value is string {
  if (!nonemptyString(value) || !value.startsWith('items/') || !value.endsWith('.json'))
    return false;
  if (value.includes('\\') || value.startsWith('/') || /^[A-Za-z]:/.test(value)) return false;
  const segments = value.split('/');
  return segments.every((segment) => segment.length > 0 && segment !== '.' && segment !== '..');
}

type DetailEnvelope = 'content' | 'variant';

function detailEnvelope(value: JsonRecord): DetailEnvelope | undefined {
  const hasContentId = value.contentId !== undefined;
  const hasVariantId = value.id !== undefined;
  if (hasContentId && hasVariantId) return undefined;

  if (hasContentId) {
    return hasOnlyKeys(value, CONTENT_DETAIL_KEYS) ? 'content' : undefined;
  }
  return hasOnlyKeys(value, VARIANT_DETAIL_KEYS) ? 'variant' : undefined;
}

function contentType(value: JsonRecord): string | undefined {
  if (typeof value.contentType === 'string') return value.contentType;
  if (
    record(value.contentType) &&
    hasOnlyKeys(value.contentType, CONTENT_TYPE_KEYS) &&
    typeof value.contentType.fullyQualifiedName === 'string'
  ) {
    return value.contentType.fullyQualifiedName;
  }
  return undefined;
}

function normalizeBlock(
  value: unknown,
  blockIndex: number,
  unresolved: PreferencePageUnresolvedReference[],
): PreferencePageSemanticBlock | undefined {
  if (
    !record(value) ||
    !hasOnlyKeys(value, ['id', 'type', 'definition', 'attributes', 'children']) ||
    !nonemptyString(value.id) ||
    value.type !== 'block' ||
    (value.children !== undefined &&
      (!Array.isArray(value.children) || value.children.length > 0)) ||
    !record(value.attributes)
  ) {
    return undefined;
  }

  if (value.definition === SUBSCRIPTIONS_BLOCK) {
    if (
      !hasOnlyKeys(value.attributes, SUBSCRIPTIONS_ATTRIBUTE_KEYS) ||
      !record(value.attributes.subscriptionConfig) ||
      !hasOnlyKeys(value.attributes.subscriptionConfig, [
        'engChannelTypeId',
        'commSubChannelTypeIds',
      ])
    ) {
      return undefined;
    }
    const config = value.attributes.subscriptionConfig;
    if (
      !nonemptyString(config.engChannelTypeId) ||
      !Array.isArray(config.commSubChannelTypeIds) ||
      config.commSubChannelTypeIds.some((entry) => !nonemptyString(entry))
    ) {
      return undefined;
    }

    const subscriptionKey = `subscription-${blockIndex}`;
    const channelKey = `${subscriptionKey}:channel`;
    const subchannelKeys = config.commSubChannelTypeIds.map(
      (_entry, subchannelIndex) => `${subscriptionKey}:subchannel-${subchannelIndex}`,
    );
    unresolved.push({
      referenceKey: channelKey,
      kind: 'engagement-channel-type',
      sourceId: config.engChannelTypeId,
    });
    for (const [subchannelIndex, sourceId] of config.commSubChannelTypeIds.entries()) {
      unresolved.push({
        referenceKey: subchannelKeys[subchannelIndex],
        kind: 'communication-subchannel-type',
        sourceId,
      });
    }

    return {
      definition: SUBSCRIPTIONS_BLOCK,
      type: 'block',
      attributes: {
        subscriptionConfig: {
          engagementChannelReference: channelKey,
          communicationSubchannelReferences: subchannelKeys,
        },
      },
      children: [],
    };
  }

  if (value.definition !== SUBMIT_BLOCK) return undefined;
  const hasLabel = value.attributes.label !== undefined;
  if (
    !hasOnlyKeys(
      value.attributes,
      hasLabel ? ['label', ...SUBMIT_ATTRIBUTE_KEYS] : SUBMIT_ATTRIBUTE_KEYS,
    ) ||
    (hasLabel && !nonemptyString(value.attributes.label))
  ) {
    return undefined;
  }

  return {
    definition: SUBMIT_BLOCK,
    type: 'block',
    attributes: hasLabel ? { label: value.attributes.label } : {},
    children: [],
  };
}

/**
 * Classify and normalize one evidenced custom-CMS Preference Page record.
 * @param {unknown} value - Search, content, export, or variant response record.
 * @returns {PreferencePageNormalization | null} Semantic result, or null when evidence is incomplete.
 */
export function normalizePreferencePage(value: unknown): PreferencePageNormalization | null {
  if (!record(value)) return null;
  const envelope = detailEnvelope(value);
  if (envelope === undefined || contentType(value) !== PREFERENCE_PAGE_TYPE) return null;
  if (
    !nonemptyString(value.managedContentId) ||
    !nonemptyString(value.managedContentVariantId) ||
    value.managedContentId === value.managedContentVariantId ||
    (envelope === 'content' && value.contentId !== value.managedContentId) ||
    (envelope === 'variant' && value.contentId !== undefined) ||
    (envelope === 'variant' &&
      value.id !== undefined &&
      value.id !== value.managedContentVariantId) ||
    !record(value.contentSpace) ||
    !hasOnlyKeys(value.contentSpace, CONTENT_SPACE_KEYS) ||
    !nonemptyString(value.contentSpace.id) ||
    !record(value.contentBody) ||
    !hasOnlyKeys(value.contentBody, CONTENT_BODY_KEYS)
  ) {
    return null;
  }

  const body = value.contentBody;
  if (
    !nonemptyString(body['sfdc_cms:title']) ||
    typeof body['sfdc_cms:description'] !== 'string' ||
    !record(body['lightning:brandSource']) ||
    !hasOnlyKeys(body['lightning:brandSource'], ['defaultBrandOption']) ||
    !nonemptyString(body['lightning:brandSource'].defaultBrandOption) ||
    !Array.isArray(body['lightning:dataProviders']) ||
    body['lightning:dataProviders'].length > 0 ||
    !record(body[BLOCK_KEY])
  ) {
    return null;
  }

  const root = body[BLOCK_KEY];
  if (
    !hasOnlyKeys(root, ['id', 'type', 'definition', 'children']) ||
    !nonemptyString(root.id) ||
    root.definition !== 'sfdc_cms/rootContentBlock' ||
    root.type !== 'block' ||
    !Array.isArray(root.children)
  ) {
    return null;
  }

  const unresolvedReferences: PreferencePageUnresolvedReference[] = [];
  const blocks: PreferencePageSemanticBlock[] = [];
  for (const [index, child] of root.children.entries()) {
    const normalized = normalizeBlock(child, index, unresolvedReferences);
    if (normalized === undefined) return null;
    blocks.push(normalized);
  }
  if (
    blocks.length !== 2 ||
    blocks[0].definition !== SUBSCRIPTIONS_BLOCK ||
    blocks[1].definition !== SUBMIT_BLOCK
  ) {
    return null;
  }

  return {
    semantic: {
      contentType: PREFERENCE_PAGE_TYPE,
      title: body['sfdc_cms:title'],
      description: body['sfdc_cms:description'],
      defaultBrandOption: body['lightning:brandSource'].defaultBrandOption,
      dataProviders: [],
      blocks,
    },
    provenance: {
      managedContentId: value.managedContentId,
      managedContentVariantId: value.managedContentVariantId,
      contentSpaceId: value.contentSpace.id,
    },
    unresolvedReferences,
  };
}

function validUnresolvedReference(value: unknown): value is PreferencePageUnresolvedReference {
  return (
    record(value) &&
    hasExactKeys(value, ['referenceKey', 'kind', 'sourceId']) &&
    nonemptyString(value.referenceKey) &&
    (value.kind === 'engagement-channel-type' || value.kind === 'communication-subchannel-type') &&
    nonemptyString(value.sourceId)
  );
}

function validSemanticBlock(value: unknown): value is PreferencePageSemanticBlock {
  if (
    !record(value) ||
    !hasExactKeys(value, ['definition', 'type', 'attributes', 'children']) ||
    value.type !== 'block' ||
    !Array.isArray(value.children) ||
    value.children.length > 0 ||
    !record(value.attributes)
  ) {
    return false;
  }
  if (value.definition === SUBMIT_BLOCK) {
    return (
      hasExactKeys(value.attributes, []) ||
      (hasExactKeys(value.attributes, ['label']) && nonemptyString(value.attributes.label))
    );
  }
  if (value.definition !== SUBSCRIPTIONS_BLOCK) return false;
  if (
    !hasExactKeys(value.attributes, ['subscriptionConfig']) ||
    !record(value.attributes.subscriptionConfig)
  ) {
    return false;
  }
  const config = value.attributes.subscriptionConfig;
  return (
    hasExactKeys(config, ['engagementChannelReference', 'communicationSubchannelReferences']) &&
    nonemptyString(config.engagementChannelReference) &&
    Array.isArray(config.communicationSubchannelReferences) &&
    config.communicationSubchannelReferences.every(nonemptyString)
  );
}

function validNormalization(value: unknown): value is PreferencePageNormalization {
  if (
    !record(value) ||
    !hasExactKeys(value, ['semantic', 'provenance', 'unresolvedReferences']) ||
    !record(value.semantic) ||
    !record(value.provenance) ||
    !Array.isArray(value.unresolvedReferences) ||
    !hasExactKeys(value.semantic, [
      'contentType',
      'title',
      'description',
      'defaultBrandOption',
      'dataProviders',
      'blocks',
    ]) ||
    value.semantic.contentType !== PREFERENCE_PAGE_TYPE ||
    !nonemptyString(value.semantic.title) ||
    typeof value.semantic.description !== 'string' ||
    !nonemptyString(value.semantic.defaultBrandOption) ||
    !Array.isArray(value.semantic.dataProviders) ||
    value.semantic.dataProviders.length > 0 ||
    !Array.isArray(value.semantic.blocks) ||
    value.semantic.blocks.length !== 2 ||
    !validSemanticBlock(value.semantic.blocks[0]) ||
    !validSemanticBlock(value.semantic.blocks[1]) ||
    value.semantic.blocks[0].definition !== SUBSCRIPTIONS_BLOCK ||
    value.semantic.blocks[1].definition !== SUBMIT_BLOCK ||
    !hasExactKeys(value.provenance, [
      'managedContentId',
      'managedContentVariantId',
      'contentSpaceId',
    ]) ||
    !nonemptyString(value.provenance.managedContentId) ||
    !nonemptyString(value.provenance.managedContentVariantId) ||
    !nonemptyString(value.provenance.contentSpaceId) ||
    value.provenance.managedContentId === value.provenance.managedContentVariantId ||
    !value.unresolvedReferences.every(validUnresolvedReference)
  ) {
    return false;
  }

  const config = value.semantic.blocks[0].attributes.subscriptionConfig as JsonRecord;
  const subchannelReferences = config.communicationSubchannelReferences as string[];
  const expectedReferences = [config.engagementChannelReference, ...subchannelReferences];
  return (
    expectedReferences.length === value.unresolvedReferences.length &&
    value.unresolvedReferences.every(
      (reference, index) => reference.referenceKey === expectedReferences[index],
    ) &&
    value.unresolvedReferences[0]?.kind === 'engagement-channel-type' &&
    value.unresolvedReferences
      .slice(1)
      .every((reference) => reference.kind === 'communication-subchannel-type')
  );
}

/**
 * Build a versioned, identity-bound Preference Page read report.
 * @param {PreferencePageReadReportInput} input - Validated read identity and normalization evidence.
 * @returns {PreferencePageReadReport} Deterministic internal report.
 */
export function buildPreferencePageReadReport(
  input: PreferencePageReadReportInput,
): PreferencePageReadReport {
  const report: PreferencePageReadReport = { format: PREFERENCE_PAGE_READ_REPORT_FORMAT, ...input };
  if (!validatePreferencePageReadReport(report))
    throw new Error('Invalid Preference Page read report input.');
  return report;
}

/**
 * Validate an internal Preference Page read report and optional expected identity bindings.
 * @param {unknown} value - Candidate report.
 * @param {PreferencePageReadReportExpectedIdentity} expected - Optional expected export identity.
 * @returns {value is PreferencePageReadReport} Whether the report is exact, safe, and bound.
 */
export function validatePreferencePageReadReport(
  value: unknown,
  expected: PreferencePageReadReportExpectedIdentity = {},
): value is PreferencePageReadReport {
  if (
    !record(value) ||
    !hasExactKeys(value, [
      'format',
      'workspaceId',
      'apiName',
      'variantId',
      'rawItemPath',
      'normalization',
    ]) ||
    value.format !== PREFERENCE_PAGE_READ_REPORT_FORMAT ||
    !nonemptyString(value.workspaceId) ||
    !nonemptyString(value.apiName) ||
    !nonemptyString(value.variantId) ||
    !safeRawItemPath(value.rawItemPath) ||
    !validNormalization(value.normalization) ||
    value.variantId !== value.normalization.provenance.managedContentVariantId
  ) {
    return false;
  }

  return (
    (expected.workspaceId === undefined || value.workspaceId === expected.workspaceId) &&
    (expected.apiName === undefined || value.apiName === expected.apiName) &&
    (expected.variantId === undefined || value.variantId === expected.variantId) &&
    (expected.rawItemPath === undefined || value.rawItemPath === expected.rawItemPath) &&
    (expected.normalization === undefined || value.normalization === expected.normalization)
  );
}
