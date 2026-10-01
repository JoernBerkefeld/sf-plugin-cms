import { randomUUID as nodeRandomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { LoadedWorkspaceExport, WorkspaceImportItem } from './import-workspace.js';

const PREFERENCE_PAGE_TYPE = 'sfdc_cms__preferencePage' as const;
const BLOCK_KEY = 'sfdc_cms:block' as const;
const TITLE_KEY = 'sfdc_cms:title' as const;
const ROOT_BLOCK = 'sfdc_cms/rootContentBlock' as const;
const SUBSCRIPTIONS_BLOCK = 'sfdc_cms/preferencePageSubscriptionsBlock' as const;
const SUBMIT_BLOCK = 'sfdc_cms/preferencePageSubmitBlock' as const;
const UUID_V4 = /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/iu;
const COMMON_DETAIL_KEYS = [
  'apiName',
  'contentBody',
  'contentFqn',
  'contentKey',
  'contentSpace',
  'contentType',
  'createdBy',
  'createdDate',
  'externalId',
  'folder',
  'isPublished',
  'language',
  'lastModifiedBy',
  'lastModifiedDate',
  'managedContentId',
  'managedContentVariantId',
  'managedContentVersionId',
  'status',
  'title',
  'urlName',
] as const;
const CONTENT_DETAIL_KEYS = [...COMMON_DETAIL_KEYS, 'contentId'] as const;
const VARIANT_DETAIL_KEYS = [...COMMON_DETAIL_KEYS, 'id'] as const;

type JsonRecord = Record<string, unknown>;
type Envelope = 'content' | 'variant';

export const PREFERENCE_PAGE_READ_REPORT_FORMAT = 'sf-cms-preference-page-read-report@1' as const;

export type PreferencePageUnresolvedReference = {
  readonly referenceKey: string;
  readonly kind: 'engagement-channel-type' | 'communication-subchannel-type';
  readonly sourceId: string;
};
export type PreferencePageNormalization = {
  readonly semantic: {
    readonly contentType: typeof PREFERENCE_PAGE_TYPE;
    readonly apiName: string;
    readonly title: string;
    readonly language: string;
    readonly body: Readonly<JsonRecord>;
  };
  readonly provenance: {
    readonly managedContentId: string;
    readonly managedContentVariantId: string;
    readonly contentSpaceId: string;
    readonly contentKey: string;
  };
  readonly unresolvedReferences: readonly PreferencePageUnresolvedReference[];
  readonly brandContentKey?: string;
};
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
  Omit<PreferencePageReadReport, 'format' | 'normalization'>
> & {
  readonly normalization?: PreferencePageNormalization;
};
export type PreferencePageTargetIdentity = {
  readonly sourceApiName: string;
  readonly apiName: string;
};
export type PreferencePageDependencyMapping = {
  readonly sourceId: string;
  readonly targetId: string;
};
export type PreferencePageBrandSelector = {
  readonly apiName?: string;
  readonly contentKey?: string;
};
export type PlannedPreferencePageCopy = {
  readonly item: WorkspaceImportItem;
  readonly target: PreferencePageTargetIdentity;
  readonly channelMappings: readonly PreferencePageDependencyMapping[];
  readonly subchannelMappings: readonly PreferencePageDependencyMapping[];
  readonly brandSelector?: PreferencePageBrandSelector;
};
export type PlannedPreferencePageCopies = {
  readonly items: readonly WorkspaceImportItem[];
  readonly targets: readonly PreferencePageTargetIdentity[];
  readonly copies: readonly PlannedPreferencePageCopy[];
};
export type PreferencePageReadbackExpectation = {
  readonly workspaceId: string;
  readonly apiName: string;
  readonly contentId: string;
  readonly variantId: string;
  readonly body: Readonly<JsonRecord>;
};
export type PreferencePageCreatePayload = {
  apiName: string;
  contentBody: WorkspaceImportItem['contentBody'];
  contentSpaceOrFolderId: string;
  contentType: typeof PREFERENCE_PAGE_TYPE;
};

function record(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function nonemptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}
function exactKeys(value: JsonRecord, keys: readonly string[]): boolean {
  return Object.keys(value).toSorted().join('\0') === [...keys].toSorted().join('\0');
}
function identifier(value: unknown, label: string): asserts value is string {
  if (!nonemptyString(value) || !/^[A-Za-z0-9_-]+$/u.test(value))
    throw new TypeError(`${label} must be a nonempty identifier`);
}
function uuidV4(value: unknown): value is string {
  return typeof value === 'string' && UUID_V4.test(value);
}
function envelope(value: JsonRecord): Envelope | undefined {
  if ('contentId' in value && !('id' in value) && exactKeys(value, CONTENT_DETAIL_KEYS))
    return 'content';
  if ('id' in value && !('contentId' in value) && exactKeys(value, VARIANT_DETAIL_KEYS))
    return 'variant';
  return undefined;
}
function contentType(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (!record(value) || !exactKeys(value, ['fullyQualifiedName'])) return undefined;
  return typeof value.fullyQualifiedName === 'string' ? value.fullyQualifiedName : undefined;
}
function safeRawItemPath(value: unknown): value is string {
  return nonemptyString(value) && /^items\/[A-Za-z0-9_-]+\.json$/u.test(value);
}
function collectBodyEvidence(body: unknown): {
  references: PreferencePageUnresolvedReference[];
  brandContentKey?: string;
} {
  if (!record(body)) throw new TypeError('Preference Page contentBody must be an object');
  const allowed = new Set([
    'lightning:brandSource',
    'lightning:dataProviders',
    TITLE_KEY,
    'sfdc_cms:description',
    BLOCK_KEY,
  ]);
  if (Object.keys(body).some((key) => !allowed.has(key)))
    throw new TypeError('Preference Page contentBody contains unsupported fields');
  if (!nonemptyString(body[TITLE_KEY]) || typeof body['sfdc_cms:description'] !== 'string')
    throw new TypeError('Preference Page title and description are required');
  if (!Array.isArray(body['lightning:dataProviders']) || body['lightning:dataProviders'].length > 0)
    throw new TypeError('Preference Page dataProviders must be empty');
  let brandContentKey: string | undefined;
  if (body['lightning:brandSource'] !== undefined) {
    const brand = body['lightning:brandSource'];
    if (!record(brand) || !exactKeys(brand, ['contentKey']) || !nonemptyString(brand.contentKey))
      throw new TypeError('Preference Page brandSource must be absent or exact { contentKey }');
    brandContentKey = brand.contentKey;
  }
  const root = body[BLOCK_KEY];
  if (
    !record(root) ||
    !exactKeys(root, ['children', 'definition', 'id', 'type']) ||
    root.type !== 'block' ||
    root.definition !== ROOT_BLOCK ||
    !uuidV4(root.id) ||
    !Array.isArray(root.children)
  )
    throw new TypeError('Preference Page root block is malformed');
  if (root.children.length !== 2)
    throw new TypeError('Preference Page requires subscriptions and submit blocks');
  const references: PreferencePageUnresolvedReference[] = [];
  for (const [index, child] of root.children.entries()) {
    if (
      !record(child) ||
      !exactKeys(child, ['attributes', 'children', 'definition', 'id', 'type']) ||
      child.type !== 'block' ||
      !uuidV4(child.id) ||
      !Array.isArray(child.children) ||
      child.children.length > 0 ||
      !record(child.attributes)
    )
      throw new TypeError('Preference Page child block is malformed');
    if (index === 0) {
      if (child.definition !== SUBSCRIPTIONS_BLOCK || !record(child.attributes.subscriptionConfig))
        throw new TypeError('Preference Page subscriptions block is malformed');
      const config = child.attributes.subscriptionConfig;
      if (
        !exactKeys(config, ['engChannelTypeId', 'commSubChannelTypeIds']) ||
        !nonemptyString(config.engChannelTypeId) ||
        !Array.isArray(config.commSubChannelTypeIds) ||
        config.commSubChannelTypeIds.some((id) => !nonemptyString(id))
      )
        throw new TypeError('Preference Page subscriptionConfig is malformed');
      references.push({
        referenceKey: 'subscription-0:channel',
        kind: 'engagement-channel-type',
        sourceId: config.engChannelTypeId,
      });
      for (const [subIndex, sourceId] of config.commSubChannelTypeIds.entries())
        references.push({
          referenceKey: `subscription-0:subchannel-${subIndex}`,
          kind: 'communication-subchannel-type',
          sourceId: sourceId as string,
        });
    } else if (child.definition !== SUBMIT_BLOCK) {
      throw new TypeError('Preference Page submit block is malformed');
    }
  }
  return { references, ...(brandContentKey === undefined ? {} : { brandContentKey }) };
}

/**
 * Normalize one exact Draft Preference Page content or variant detail envelope.
 * @param {unknown} value - Candidate content or variant detail.
 * @returns {PreferencePageNormalization | null} Strict portable semantics and source evidence.
 */
export function normalizePreferencePage(value: unknown): PreferencePageNormalization | null {
  try {
    if (!record(value)) return null;
    const kind = envelope(value);
    if (kind === undefined || contentType(value.contentType) !== PREFERENCE_PAGE_TYPE) return null;
    if (
      !nonemptyString(value.apiName) ||
      !nonemptyString(value.title) ||
      !nonemptyString(value.language) ||
      !nonemptyString(value.contentKey) ||
      !nonemptyString(value.managedContentId) ||
      !nonemptyString(value.managedContentVariantId) ||
      value.managedContentId === value.managedContentVariantId ||
      (kind === 'content' && value.contentId !== value.managedContentId) ||
      (kind === 'variant' && value.id !== value.managedContentVariantId) ||
      !record(value.contentSpace) ||
      !exactKeys(value.contentSpace, ['id', 'resourceUrl']) ||
      !nonemptyString(value.contentSpace.id) ||
      value.isPublished !== false ||
      !record(value.status) ||
      value.status.status !== 'Draft' ||
      value.externalId !== null
    )
      return null;
    const evidence = collectBodyEvidence(value.contentBody);
    return {
      semantic: {
        contentType: PREFERENCE_PAGE_TYPE,
        apiName: value.apiName,
        title: value.title,
        language: value.language,
        body: structuredClone(value.contentBody) as JsonRecord,
      },
      provenance: {
        managedContentId: value.managedContentId,
        managedContentVariantId: value.managedContentVariantId,
        contentSpaceId: value.contentSpace.id,
        contentKey: value.contentKey,
      },
      unresolvedReferences: evidence.references,
      ...(evidence.brandContentKey === undefined
        ? {}
        : { brandContentKey: evidence.brandContentKey }),
    };
  } catch {
    return null;
  }
}
function validNormalization(value: unknown): value is PreferencePageNormalization {
  if (
    !record(value) ||
    !record(value.semantic) ||
    !record(value.provenance) ||
    !Array.isArray(value.unresolvedReferences)
  )
    return false;
  try {
    const optionalBrand = value.brandContentKey === undefined ? [] : ['brandContentKey'];
    if (
      !exactKeys(value, ['semantic', 'provenance', 'unresolvedReferences', ...optionalBrand]) ||
      !exactKeys(value.semantic, ['apiName', 'body', 'contentType', 'language', 'title']) ||
      !exactKeys(value.provenance, [
        'contentKey',
        'contentSpaceId',
        'managedContentId',
        'managedContentVariantId',
      ]) ||
      value.semantic.contentType !== PREFERENCE_PAGE_TYPE ||
      !nonemptyString(value.semantic.apiName) ||
      !nonemptyString(value.semantic.title) ||
      !nonemptyString(value.semantic.language) ||
      !nonemptyString(value.provenance.contentKey) ||
      !nonemptyString(value.provenance.contentSpaceId) ||
      !nonemptyString(value.provenance.managedContentId) ||
      !nonemptyString(value.provenance.managedContentVariantId)
    )
      return false;
    const evidence = collectBodyEvidence(value.semantic.body);
    return (
      isDeepStrictEqual(evidence.references, value.unresolvedReferences) &&
      evidence.brandContentKey === value.brandContentKey
    );
  } catch {
    return false;
  }
}
export function buildPreferencePageReadReport(
  input: PreferencePageReadReportInput,
): PreferencePageReadReport {
  const report = { format: PREFERENCE_PAGE_READ_REPORT_FORMAT, ...input };
  if (!validatePreferencePageReadReport(report))
    throw new TypeError('Invalid Preference Page read report input');
  return report;
}
export function validatePreferencePageReadReport(
  value: unknown,
  expected: PreferencePageReadReportExpectedIdentity = {},
): value is PreferencePageReadReport {
  if (
    !record(value) ||
    !exactKeys(value, [
      'apiName',
      'format',
      'normalization',
      'rawItemPath',
      'variantId',
      'workspaceId',
    ]) ||
    value.format !== PREFERENCE_PAGE_READ_REPORT_FORMAT ||
    !nonemptyString(value.workspaceId) ||
    !nonemptyString(value.apiName) ||
    !nonemptyString(value.variantId) ||
    !safeRawItemPath(value.rawItemPath) ||
    !validNormalization(value.normalization) ||
    value.variantId !== value.normalization.provenance.managedContentVariantId
  )
    return false;
  return Object.entries(expected).every(([key, expectedValue]) =>
    key === 'normalization' ? expectedValue === value.normalization : value[key] === expectedValue,
  );
}
function parseDependencyRows(value: unknown, label: string): PreferencePageDependencyMapping[] {
  if (!Array.isArray(value) || value.length === 0)
    throw new TypeError(`${label} must be a nonempty array`);
  const result: PreferencePageDependencyMapping[] = [];
  const bySource = new Map<string, string>();
  for (const [index, row] of value.entries()) {
    if (!record(row) || !exactKeys(row, ['sourceId', 'targetId']))
      throw new TypeError(`${label}[${index}] must contain sourceId and targetId`);
    identifier(row.sourceId, `${label}[${index}].sourceId`);
    identifier(row.targetId, `${label}[${index}].targetId`);
    const prior = bySource.get(row.sourceId);
    if (prior !== undefined && prior !== row.targetId)
      throw new TypeError(`${label} contains conflicting duplicate source mappings`);
    bySource.set(row.sourceId, row.targetId);
    result.push({ sourceId: row.sourceId, targetId: row.targetId });
  }
  return result;
}
function freshBlockIds(
  body: WorkspaceImportItem['contentBody'],
  generate: () => string,
  sourceIds: Set<string>,
  generated: Set<string>,
): WorkspaceImportItem['contentBody'] {
  const cloned = structuredClone(body);
  const root = cloned[BLOCK_KEY] as JsonRecord;
  for (const block of [root, ...((root.children as JsonRecord[]) ?? [])]) {
    const id = generate();
    if (!uuidV4(id) || sourceIds.has(id) || generated.has(id))
      throw new TypeError(
        'Generated Preference Page block ID must be a fresh package-wide unique UUID v4',
      );
    generated.add(id);
    block.id = id;
  }
  return cloned;
}
/**
 * Plan detached Preference Page copies and explicit dependency mappings.
 * @param {LoadedWorkspaceExport} source - Strictly loaded typed package.
 * @param {unknown} input - Exact Preference Page mapping rows.
 * @param {() => string} generateId - UUID-v4 generator.
 * @returns {PlannedPreferencePageCopies} Detached planned pages and dependencies.
 */
export function planPreferencePageCopies(
  source: LoadedWorkspaceExport,
  input: unknown,
  generateId: () => string = nodeRandomUUID,
): PlannedPreferencePageCopies {
  if (!source.integrity.verified) throw new TypeError('Source integrity must be verified first');
  if (!Array.isArray(input) || input.length === 0)
    throw new TypeError('Preference Page mappings must be a nonempty array');
  const sourceBlockIds = new Set<string>();
  for (const item of source.items) {
    const root = item.contentBody[BLOCK_KEY] as JsonRecord | undefined;
    if (record(root) && typeof root.id === 'string') sourceBlockIds.add(root.id);
    if (record(root) && Array.isArray(root.children))
      for (const child of root.children)
        if (record(child) && typeof child.id === 'string') sourceBlockIds.add(child.id);
  }
  const generated = new Set<string>();
  const selected = new Set<string>();
  const targetNames = new Set<string>();
  const packageChannelMappings = new Map<string, string>();
  const packageSubchannelMappings = new Map<string, string>();
  const items: WorkspaceImportItem[] = [];
  const targets: PreferencePageTargetIdentity[] = [];
  const copies: PlannedPreferencePageCopy[] = [];
  for (const [index, row] of input.entries()) {
    if (
      !record(row) ||
      !exactKeys(row, [
        'source',
        'target',
        'channels',
        'subchannels',
        ...(row.brand === undefined ? [] : ['brand']),
      ])
    )
      throw new TypeError(`Preference Page mapping ${index} has an unsupported shape`);
    if (
      !record(row.source) ||
      !record(row.target) ||
      !exactKeys(row.source, ['apiName', 'family', 'type']) ||
      !exactKeys(row.target, ['apiName'])
    )
      throw new TypeError(`Preference Page mapping ${index} source and target are malformed`);
    if (row.source.family !== 'cms' || row.source.type !== 'preferencePage')
      throw new TypeError(`Preference Page mapping ${index}.source must select cms/preferencePage`);
    identifier(row.source.apiName, `Preference Page mapping ${index}.source.apiName`);
    identifier(row.target.apiName, `Preference Page mapping ${index}.target.apiName`);
    const sourceApiName = row.source.apiName;
    const targetApiName = row.target.apiName;
    if (selected.has(sourceApiName) || targetNames.has(targetApiName))
      throw new TypeError('Preference Page source and target API names must be unique');
    const matches = source.items.filter(
      (item) => item.contentType === PREFERENCE_PAGE_TYPE && item.apiName === sourceApiName,
    );
    if (matches.length !== 1)
      throw new TypeError(
        `Source apiName must match exactly one Preference Page: ${sourceApiName}`,
      );
    const original = matches[0];
    const normalized = normalizePreferencePageItem(original);
    const channels = parseDependencyRows(row.channels, `Preference Page mapping ${index}.channels`);
    const subchannels = parseDependencyRows(
      row.subchannels,
      `Preference Page mapping ${index}.subchannels`,
    );
    for (const mapping of channels) {
      const existing = packageChannelMappings.get(mapping.sourceId);
      if (existing !== undefined && existing !== mapping.targetId)
        throw new TypeError(
          `Preference Page channel source ID maps inconsistently across pages: ${mapping.sourceId}`,
        );
      packageChannelMappings.set(mapping.sourceId, mapping.targetId);
    }
    for (const mapping of subchannels) {
      const existing = packageSubchannelMappings.get(mapping.sourceId);
      if (existing !== undefined && existing !== mapping.targetId)
        throw new TypeError(
          `Preference Page subchannel source ID maps inconsistently across pages: ${mapping.sourceId}`,
        );
      packageSubchannelMappings.set(mapping.sourceId, mapping.targetId);
    }
    const channelSources = new Set(
      normalized.unresolvedReferences
        .filter((r) => r.kind === 'engagement-channel-type')
        .map((r) => r.sourceId),
    );
    const subchannelSources = new Set(
      normalized.unresolvedReferences
        .filter((r) => r.kind === 'communication-subchannel-type')
        .map((r) => r.sourceId),
    );
    if (
      !isDeepStrictEqual(new Set(channels.map((r) => r.sourceId)), channelSources) ||
      !isDeepStrictEqual(new Set(subchannels.map((r) => r.sourceId)), subchannelSources)
    )
      throw new TypeError(
        'Preference Page mappings must cover exactly the report-bound channel and subchannel source IDs',
      );
    let brandSelector: PreferencePageBrandSelector | undefined;
    if (normalized.brandContentKey === undefined) {
      if (row.brand !== undefined)
        throw new TypeError('Brand-free Preference Page must not supply a Brand mapping');
    } else {
      if (
        !record(row.brand) ||
        !(
          (exactKeys(row.brand, ['apiName']) && nonemptyString(row.brand.apiName)) ||
          (exactKeys(row.brand, ['contentKey']) && nonemptyString(row.brand.contentKey))
        )
      )
        throw new TypeError(
          'Branded Preference Page requires exactly one destination Brand selector',
        );
      brandSelector = structuredClone(row.brand) as PreferencePageBrandSelector;
    }
    const body = freshBlockIds(original.contentBody, generateId, sourceBlockIds, generated);
    const config = (
      ((body[BLOCK_KEY] as JsonRecord).children as JsonRecord[])[0].attributes as JsonRecord
    ).subscriptionConfig as JsonRecord;
    const channelMap = new Map(channels.map((mapping) => [mapping.sourceId, mapping.targetId]));
    const subchannelMap = new Map(
      subchannels.map((mapping) => [mapping.sourceId, mapping.targetId]),
    );
    config.engChannelTypeId = channelMap.get(config.engChannelTypeId as string)!;
    config.commSubChannelTypeIds = (config.commSubChannelTypeIds as string[]).map((id) =>
      subchannelMap.get(id)!,
    );
    const planned = {
      ...structuredClone(original),
      apiName: targetApiName,
      contentBody: body,
    } as WorkspaceImportItem;
    selected.add(sourceApiName);
    targetNames.add(targetApiName);
    items.push(planned);
    const target = { sourceApiName, apiName: targetApiName };
    targets.push(target);
    copies.push({
      item: planned,
      target,
      channelMappings: channels,
      subchannelMappings: subchannels,
      ...(brandSelector === undefined ? {} : { brandSelector }),
    });
  }
  return { items, targets, copies };
}
function normalizePreferencePageItem(item: WorkspaceImportItem): PreferencePageNormalization {
  const evidence = collectBodyEvidence(item.contentBody);
  return {
    semantic: {
      contentType: PREFERENCE_PAGE_TYPE,
      apiName: item.apiName ?? '',
      title: item.title,
      language: item.language,
      body: structuredClone(item.contentBody),
    },
    provenance: {
      managedContentId: item.id,
      managedContentVariantId: item.id,
      contentSpaceId: item.contentSpace.id,
      contentKey: item.contentKey,
    },
    unresolvedReferences: evidence.references,
    ...(evidence.brandContentKey === undefined
      ? {}
      : { brandContentKey: evidence.brandContentKey }),
  };
}
/**
 * Build the family-specific generic CMS CREATE payload.
 * @param {WorkspaceImportItem} item - Planned Preference Page item.
 * @param {string} contentSpaceOrFolderId - Exact destination root folder.
 * @returns {PreferencePageCreatePayload} Payload omitting root key/title/urlName.
 */
export function preferencePageCreatePayload(
  item: WorkspaceImportItem,
  contentSpaceOrFolderId: string,
): PreferencePageCreatePayload {
  if (item.contentType !== PREFERENCE_PAGE_TYPE || item.apiName === undefined)
    throw new TypeError('Preference Page CREATE requires exact type and apiName');
  identifier(contentSpaceOrFolderId, 'Preference Page destination root folder ID');
  collectBodyEvidence(item.contentBody);
  return {
    apiName: item.apiName,
    contentBody: structuredClone(item.contentBody),
    contentSpaceOrFolderId,
    contentType: PREFERENCE_PAGE_TYPE,
  };
}
/**
 * Verify independent exact Draft content and variant readback.
 * @param {unknown} content - Content-detail response.
 * @param {unknown} variant - Variant-detail response.
 * @param {PreferencePageReadbackExpectation} expected - Exact planned and returned identity.
 * @returns {PreferencePageNormalization} Verified normalization.
 */
export function assertPreferencePageReadback(
  content: unknown,
  variant: unknown,
  expected: PreferencePageReadbackExpectation,
): PreferencePageNormalization {
  const left = normalizePreferencePage(content);
  const right = normalizePreferencePage(variant);
  if (
    left === null ||
    right === null ||
    !isDeepStrictEqual(left, right) ||
    left.provenance.contentSpaceId !== expected.workspaceId ||
    left.provenance.managedContentId !== expected.contentId ||
    left.provenance.managedContentVariantId !== expected.variantId ||
    left.semantic.apiName !== expected.apiName ||
    !isDeepStrictEqual(left.semantic.body, expected.body)
  )
    throw new TypeError(
      'Preference Page readback identity, Draft state, or semantics differ from the planned target',
    );
  return left;
}
