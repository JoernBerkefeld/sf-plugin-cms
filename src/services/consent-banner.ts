import { randomUUID as nodeRandomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { LoadedWorkspaceExport, WorkspaceImportItem } from './import-workspace.js';

const CONSENT_BANNER_TYPE = 'sfdc_cms__consentBanner' as const;
const BLOCK_KEY = 'sfdc_cms:block' as const;
const TITLE_KEY = 'sfdc_cms:title' as const;
const REPORT_FORMAT = 'sf-cms-consent-banner-read-report@1' as const;
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
const BODY_KEYS = [
  'lightning:brandSource',
  'lightning:colorScheme',
  'lightning:dataProviders',
  'lightning:horizontalAlignment',
  'lightning:padding',
  'lightning:verticalAlignment',
  'maxWidth',
  'minWidth',
  BLOCK_KEY,
  TITLE_KEY,
] as const;
const BLOCK_KEYS = ['attributes', 'children', 'definition', 'id', 'type'] as const;
const ROOT_KEYS = ['children', 'definition', 'id', 'type'] as const;

type JsonRecord = Record<string, unknown>;
type ConsentBannerEnvelope = 'content' | 'variant';

export const CONSENT_BANNER_READ_REPORT_FORMAT = REPORT_FORMAT;

export type ConsentBannerSemanticContent = {
  readonly contentType: typeof CONSENT_BANNER_TYPE;
  readonly apiName: string;
  readonly title: string;
  readonly urlName: string;
  readonly language: string;
  readonly body: Readonly<JsonRecord>;
};
export type ConsentBannerNormalization = {
  readonly semantic: ConsentBannerSemanticContent;
  readonly provenance: {
    readonly managedContentId: string;
    readonly managedContentVariantId: string;
    readonly contentSpaceId: string;
    readonly contentKey: string;
  };
  readonly dependencies: readonly [];
  readonly references: readonly [];
};
export type ConsentBannerReadReport = {
  readonly format: typeof REPORT_FORMAT;
  readonly workspaceId: string;
  readonly apiName: string;
  readonly variantId: string;
  readonly rawItemPath: string;
  readonly normalization: ConsentBannerNormalization;
};
export type PlannedConsentBannerCopies = {
  readonly items: readonly WorkspaceImportItem[];
  readonly targets: readonly {
    sourceApiName: string;
    apiName: string;
    title: string;
    urlName: string;
  }[];
};
export type ConsentBannerCreatePayload = {
  readonly apiName: string;
  readonly contentBody: WorkspaceImportItem['contentBody'];
  readonly contentSpaceOrFolderId: string;
  readonly contentType: typeof CONSENT_BANNER_TYPE;
  readonly title: string;
  readonly urlName: string;
};
export type ConsentBannerReadbackExpectation = {
  readonly workspaceId: string;
  readonly apiName: string;
  readonly title: string;
  readonly urlName: string;
  readonly contentId: string;
  readonly variantId: string;
  readonly semantic: ConsentBannerSemanticContent;
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
function assertExactKeys(value: JsonRecord, keys: readonly string[], label: string): void {
  if (!exactKeys(value, keys))
    throw new TypeError(`${label} must contain exactly ${keys.join(', ')}`);
}
function identifier(value: unknown, label: string): asserts value is string {
  if (!nonemptyString(value) || !/^[A-Za-z0-9_-]+$/u.test(value))
    throw new TypeError(`${label} must be a nonempty identifier`);
}
function urlName(value: unknown, label: string): asserts value is string {
  if (!nonemptyString(value) || !/^[a-z0-9-]+$/u.test(value))
    throw new TypeError(`${label} must contain lowercase letters, digits, or hyphens`);
}
function uuidV4(value: unknown): value is string {
  return typeof value === 'string' && UUID_V4.test(value);
}
function envelope(value: JsonRecord): ConsentBannerEnvelope | undefined {
  if ('contentId' in value && !('id' in value) && exactKeys(value, CONTENT_DETAIL_KEYS))
    return 'content';
  if ('id' in value && !('contentId' in value) && exactKeys(value, VARIANT_DETAIL_KEYS))
    return 'variant';
  return undefined;
}
function contentType(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (!record(value) || !('fullyQualifiedName' in value)) return undefined;
  return typeof value.fullyQualifiedName === 'string' ? value.fullyQualifiedName : undefined;
}
function forbiddenReference(value: unknown): boolean {
  if (Array.isArray(value)) return value.some((child) => forbiddenReference(child));
  if (!record(value)) return false;
  const forbidden =
    /^(?:consentConfig|consentConfiguration|cms|dataGraph|external|externalId|externalSource|file|flow|formHandler|provider|providers|ref|reference|references|site|siteId|source|sourceId)$/u;
  if (Object.keys(value).some((key) => forbidden.test(key))) return true;
  if (typeof value.type === 'string' && (value.type === 'file' || value.type.endsWith('Reference')))
    return true;
  return Object.values(value).some((child) => forbiddenReference(child));
}
function assertUnit(value: unknown, unit: '%' | 'px', amount: number, label: string): void {
  if (
    !record(value) ||
    !exactKeys(value, ['unit', 'value']) ||
    value.unit !== unit ||
    value.value !== amount
  )
    throw new TypeError(`${label} must match the evidenced unit value`);
}
function assertBlock(value: unknown, definition: string, label: string, root = false): JsonRecord {
  if (!record(value)) throw new TypeError(`${label} must be an object`);
  assertExactKeys(value, root ? ROOT_KEYS : BLOCK_KEYS, label);
  if (
    value.type !== 'block' ||
    value.definition !== definition ||
    !uuidV4(value.id) ||
    !Array.isArray(value.children)
  )
    throw new TypeError(`${label} must match the evidenced block definition`);
  return value;
}
function assertColumnAttributes(value: unknown, width: number, label: string): void {
  if (!record(value)) throw new TypeError(`${label} must be an object`);
  assertExactKeys(
    value,
    [
      'columnWidth',
      'lightning:backgroundImage',
      'lightning:borderRadius',
      'lightning:borderWidth',
      'lightning:colorScheme',
      'lightning:margin',
      'lightning:padding',
      'lightning:verticalAlignment',
    ],
    label,
  );
  if (
    value.columnWidth !== width ||
    !isDeepStrictEqual(value['lightning:backgroundImage'], {
      position: 'center center',
      repeat: 'no-repeat',
      size: 'cover',
    }) ||
    value['lightning:borderRadius'] !== '{!$brand.borderRadius.square}' ||
    value['lightning:borderWidth'] !== '{!$brand.borderWeight.none}' ||
    value['lightning:colorScheme'] !== '{!$brand.colorScheme}' ||
    value['lightning:margin'] !== '{!$brand.spacing.none}' ||
    value['lightning:padding'] !== '{!$brand.spacing.xSmall}' ||
    value['lightning:verticalAlignment'] !== 'top'
  )
    throw new TypeError(`${label} must match the evidenced layout constants`);
}
function assertActionButton(
  value: unknown,
  action: 'sfdc_cms__consentRejectAction' | 'sfdc_cms__consentAcceptAction',
  style: 'secondary' | 'primary',
  text: 'Reject' | 'Allow',
  label: string,
): void {
  const button = assertBlock(value, 'lightning/actionButton', label);
  if ((button.children as unknown[]).length > 0 || !record(button.attributes))
    throw new TypeError(`${label} must have no children`);
  const attributes = button.attributes;
  assertExactKeys(
    attributes,
    [
      'lightning:borderRadius',
      'lightning:borderWidth',
      'lightning:buttonColorGroup',
      'lightning:click',
      'lightning:horizontalAlignment',
      'lightning:margin',
      'lightning:padding',
      'lightning:typography',
      'sfdc_cms:styleGroup',
      'text',
      'width',
    ],
    `${label}.attributes`,
  );
  const prefix = `{!$brand.buttonStyleGroup.${style}`;
  if (
    attributes['lightning:borderRadius'] !== `${prefix}.lightning:borderRadius}` ||
    attributes['lightning:borderWidth'] !== `${prefix}.lightning:borderWidth}` ||
    attributes['lightning:buttonColorGroup'] !== `${prefix}.lightning:buttonColorGroup}` ||
    attributes['lightning:horizontalAlignment'] !== 'center' ||
    attributes['lightning:margin'] !== '{!$brand.spacing.none}' ||
    attributes['lightning:padding'] !== `${prefix}.lightning:padding}` ||
    attributes['lightning:typography'] !== `${prefix}.lightning:typography}` ||
    attributes['sfdc_cms:styleGroup'] !== `${prefix}}` ||
    attributes.text !== text
  )
    throw new TypeError(`${label} must match the evidenced ${style} button`);
  assertUnit(attributes.width, '%', 100, `${label}.width`);
  const click = attributes['lightning:click'];
  if (
    !record(click) ||
    !exactKeys(click, ['actions']) ||
    !Array.isArray(click.actions) ||
    click.actions.length !== 1
  )
    throw new TypeError(`${label} must contain exactly one action`);
  const actionValue = click.actions[0];
  if (
    !record(actionValue) ||
    !exactKeys(actionValue, ['attributes', 'definition']) ||
    actionValue.definition !== action ||
    !record(actionValue.attributes) ||
    Object.keys(actionValue.attributes).length > 0
  )
    throw new TypeError(`${label} action must be exactly ${action}`);
}
function assertBody(value: unknown, expectedTitle?: string): asserts value is JsonRecord {
  if (!record(value)) throw new TypeError('Consent Banner contentBody must be an object');
  assertExactKeys(value, BODY_KEYS, 'Consent Banner contentBody');
  if (
    !isDeepStrictEqual(value['lightning:brandSource'], { defaultBrandOption: 'sfdcBrand' }) ||
    value['lightning:colorScheme'] !== '{!$brand.colorScheme}' ||
    !Array.isArray(value['lightning:dataProviders']) ||
    value['lightning:dataProviders'].length > 0 ||
    value['lightning:horizontalAlignment'] !== 'center' ||
    value['lightning:padding'] !== '{!$brand.spacing.none}' ||
    value['lightning:verticalAlignment'] !== 'bottom'
  )
    throw new TypeError('Consent Banner root attributes must match the evidenced profile');
  assertUnit(value.maxWidth, '%', 70, 'Consent Banner maxWidth');
  assertUnit(value.minWidth, 'px', 200, 'Consent Banner minWidth');
  if (
    !nonemptyString(value[TITLE_KEY]) ||
    (expectedTitle !== undefined && value[TITLE_KEY] !== expectedTitle)
  )
    throw new TypeError('Consent Banner body title must match the top-level title');
  const root = assertBlock(
    value[BLOCK_KEY],
    'sfdc_cms/rootContentBlock',
    'Consent Banner root',
    true,
  );
  if ((root.children as unknown[]).length !== 1)
    throw new TypeError('Consent Banner root must contain one section');
  const section = assertBlock(
    (root.children as unknown[])[0],
    'lightning/section',
    'Consent Banner section',
  );
  if (
    !record(section.attributes) ||
    !isDeepStrictEqual(section.attributes, {
      'lightning:backgroundImage': {
        position: 'center center',
        repeat: 'no-repeat',
        size: 'cover',
      },
      'lightning:borderRadius': '{!$brand.borderRadius.square}',
      'lightning:borderWidth': '{!$brand.borderWeight.thin}',
      'lightning:colorScheme': '{!$brand.colorScheme}',
      'lightning:margin': '{!$brand.spacing.small}',
      'lightning:padding': '{!$brand.spacing.xSmall}',
      reverseOrderOnMobile: false,
      stackOnMobile: true,
    })
  )
    throw new TypeError('Consent Banner section attributes must match the evidenced profile');
  const columns = section.children as unknown[];
  if (columns.length !== 3)
    throw new TypeError('Consent Banner section must contain three columns');
  const paragraphColumn = assertBlock(
    columns[0],
    'lightning/column',
    'Consent Banner paragraph column',
  );
  assertColumnAttributes(
    paragraphColumn.attributes,
    8,
    'Consent Banner paragraph column attributes',
  );
  if ((paragraphColumn.children as unknown[]).length !== 1)
    throw new TypeError('Consent Banner paragraph column must contain one paragraph');
  const paragraph = assertBlock(
    (paragraphColumn.children as unknown[])[0],
    'lightning/paragraph',
    'Consent Banner paragraph',
  );
  if (
    (paragraph.children as unknown[]).length > 0 ||
    !record(paragraph.attributes) ||
    !isDeepStrictEqual(paragraph.attributes, {
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
    })
  )
    throw new TypeError('Consent Banner paragraph must match the evidenced profile');
  for (const [index, action, style, text] of [
    [1, 'sfdc_cms__consentRejectAction', 'secondary', 'Reject'],
    [2, 'sfdc_cms__consentAcceptAction', 'primary', 'Allow'],
  ] as const) {
    const column = assertBlock(columns[index], 'lightning/column', `Consent Banner ${text} column`);
    assertColumnAttributes(column.attributes, 2, `Consent Banner ${text} column attributes`);
    if ((column.children as unknown[]).length !== 1)
      throw new TypeError(`Consent Banner ${text} column must contain one button`);
    assertActionButton(
      (column.children as unknown[])[0],
      action,
      style,
      text,
      `Consent Banner ${text} button`,
    );
  }
  if (forbiddenReference(value))
    throw new TypeError('Consent Banner profile forbids external and unknown references');
}

/**
 * Normalize one exact Draft Consent Banner detail envelope.
 * @param {unknown} value - Candidate content or variant detail envelope.
 * @returns {ConsentBannerNormalization | null} Strict semantics and provenance, or null.
 */
export function normalizeConsentBanner(value: unknown): ConsentBannerNormalization | null {
  try {
    if (!record(value)) return null;
    const kind = envelope(value);
    if (kind === undefined || contentType(value.contentType) !== CONSENT_BANNER_TYPE) return null;
    if (
      !nonemptyString(value.apiName) ||
      !nonemptyString(value.title) ||
      !nonemptyString(value.urlName) ||
      !nonemptyString(value.language) ||
      !nonemptyString(value.contentKey) ||
      !nonemptyString(value.managedContentId) ||
      !nonemptyString(value.managedContentVariantId) ||
      value.managedContentId === value.managedContentVariantId ||
      (kind === 'content' && value.contentId !== value.managedContentId) ||
      (kind === 'variant' && value.id !== value.managedContentVariantId) ||
      !record(value.contentSpace) ||
      value.contentSpace.id === undefined ||
      !nonemptyString(value.contentSpace.id) ||
      value.isPublished !== false ||
      !isDeepStrictEqual(value.status, { label: 'Draft', status: 'Draft' }) ||
      value.externalId !== null
    )
      return null;
    assertBody(value.contentBody, value.title);
    return {
      semantic: {
        contentType: CONSENT_BANNER_TYPE,
        apiName: value.apiName,
        title: value.title,
        urlName: value.urlName,
        language: value.language,
        body: structuredClone(value.contentBody),
      },
      provenance: {
        managedContentId: value.managedContentId,
        managedContentVariantId: value.managedContentVariantId,
        contentSpaceId: value.contentSpace.id,
        contentKey: value.contentKey,
      },
      dependencies: [],
      references: [],
    };
  } catch {
    return null;
  }
}

/**
 * Reject any dependency-bearing Consent Banner item.
 * @param {WorkspaceImportItem} item - Candidate imported Consent Banner item.
 * @returns {{ dependencies: readonly []; references: readonly [] }} Empty inventories.
 */
export function classifyConsentBannerDependencies(item: WorkspaceImportItem): {
  readonly dependencies: readonly [];
  readonly references: readonly [];
} {
  if (item.contentType !== CONSENT_BANNER_TYPE)
    throw new TypeError(`Consent Banner requires exact content type ${CONSENT_BANNER_TYPE}`);
  assertBody(item.contentBody, item.title);
  if (
    forbiddenReference(item) ||
    item.externalSource !== undefined ||
    item.externalId !== undefined
  )
    throw new TypeError(
      'Consent Banner profile forbids source, external, CMS, site, consent-config, Data 360, provider, file, and unknown references',
    );
  return { dependencies: [], references: [] };
}

/**
 * Build a deterministic identity-bound Consent Banner report.
 * @param {Omit<ConsentBannerReadReport, 'format'>} input - Report identity and normalization.
 * @returns {ConsentBannerReadReport} Versioned strict report.
 */
export function buildConsentBannerReadReport(
  input: Omit<ConsentBannerReadReport, 'format'>,
): ConsentBannerReadReport {
  const report: ConsentBannerReadReport = { format: REPORT_FORMAT, ...input };
  if (!validateConsentBannerReadReport(report))
    throw new TypeError('Invalid Consent Banner read report input');
  return report;
}

/**
 * Validate the exact Consent Banner report and raw-item binding.
 * @param {unknown} value - Candidate report.
 * @param {Partial<Omit<ConsentBannerReadReport, 'format' | 'normalization'>>} expected - Optional identity bindings.
 * @returns {value is ConsentBannerReadReport} Whether the candidate is valid.
 */
export function validateConsentBannerReadReport(
  value: unknown,
  expected: Partial<Omit<ConsentBannerReadReport, 'format' | 'normalization'>> = {},
): value is ConsentBannerReadReport {
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
    value.format !== REPORT_FORMAT ||
    !nonemptyString(value.workspaceId) ||
    !nonemptyString(value.apiName) ||
    !nonemptyString(value.variantId) ||
    value.rawItemPath !== `items/${value.variantId}.json` ||
    !record(value.normalization) ||
    !exactKeys(value.normalization, ['dependencies', 'provenance', 'references', 'semantic']) ||
    !Array.isArray(value.normalization.dependencies) ||
    value.normalization.dependencies.length > 0 ||
    !Array.isArray(value.normalization.references) ||
    value.normalization.references.length > 0 ||
    !record(value.normalization.semantic) ||
    !record(value.normalization.provenance)
  )
    return false;
  const semantic = value.normalization.semantic;
  const provenance = value.normalization.provenance;
  try {
    assertExactKeys(
      semantic,
      ['apiName', 'body', 'contentType', 'language', 'title', 'urlName'],
      'Consent Banner semantic',
    );
    assertExactKeys(
      provenance,
      ['contentKey', 'contentSpaceId', 'managedContentId', 'managedContentVariantId'],
      'Consent Banner provenance',
    );
    if (
      semantic.contentType !== CONSENT_BANNER_TYPE ||
      !nonemptyString(semantic.apiName) ||
      !nonemptyString(semantic.title) ||
      !nonemptyString(semantic.urlName) ||
      !nonemptyString(semantic.language) ||
      !nonemptyString(provenance.contentKey) ||
      !nonemptyString(provenance.contentSpaceId) ||
      !nonemptyString(provenance.managedContentId) ||
      !nonemptyString(provenance.managedContentVariantId) ||
      value.variantId !== provenance.managedContentVariantId
    )
      return false;
    assertBody(semantic.body, semantic.title);
  } catch {
    return false;
  }
  return Object.entries(expected).every(([key, expectedValue]) => value[key] === expectedValue);
}

function collectBlockIds(value: unknown, ids: Set<string>): void {
  if (Array.isArray(value)) {
    for (const child of value) collectBlockIds(child, ids);
    return;
  }
  if (!record(value)) return;
  if (value.type === 'block' && nonemptyString(value.id)) ids.add(value.id);
  for (const child of Object.values(value)) collectBlockIds(child, ids);
}

function regenerateBlockIds(
  value: unknown,
  generate: () => string,
  sourceIds: ReadonlySet<string>,
  generatedIds: Set<string>,
): unknown {
  if (Array.isArray(value))
    return value.map((child) => regenerateBlockIds(child, generate, sourceIds, generatedIds));
  if (!record(value)) return value;
  const generated = value.type === 'block' ? generate() : undefined;
  if (
    generated !== undefined &&
    (!uuidV4(generated) || sourceIds.has(generated) || generatedIds.has(generated))
  )
    throw new TypeError('Generated Consent Banner block IDs must be fresh unique UUID v4 values');
  if (generated !== undefined) generatedIds.add(generated);
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key,
      key === 'id' && generated !== undefined
        ? generated
        : regenerateBlockIds(child, generate, sourceIds, generatedIds),
    ]),
  );
}

/**
 * Plan strict Consent Banner copies with fresh identities and recursive block IDs.
 * @param {LoadedWorkspaceExport} source - Strictly loaded source package.
 * @param {unknown} input - Exact mapping rows.
 * @param {() => string} generateId - UUID-v4 generator.
 * @returns {PlannedConsentBannerCopies} Detached planned items and target identities.
 */
export function planConsentBannerCopies(
  source: LoadedWorkspaceExport,
  input: unknown,
  generateId: () => string = nodeRandomUUID,
): PlannedConsentBannerCopies {
  if (!source.integrity.verified) throw new TypeError('Source integrity must be verified first');
  if (!Array.isArray(input) || input.length === 0)
    throw new TypeError('Consent Banner mappings must be a nonempty array');
  const sourceNames = new Set(source.items.map(({ apiName }) => apiName));
  const sourceTitles = new Set(source.items.map(({ title }) => title));
  const sourceUrls = new Set(source.items.map(({ urlName }) => urlName));
  const selected = new Set<string>();
  const targetNames = new Set<string>();
  const targetTitles = new Set<string>();
  const targetUrls = new Set<string>();
  const sourceBlockIds = new Set<string>();
  for (const item of source.items) collectBlockIds(item.contentBody, sourceBlockIds);
  const generatedBlockIds = new Set<string>();
  const items: WorkspaceImportItem[] = [];
  const targets: PlannedConsentBannerCopies['targets'][number][] = [];
  for (const [index, row] of input.entries()) {
    if (!record(row)) throw new TypeError(`Consent Banner mapping ${index} must be an object`);
    assertExactKeys(row, ['source', 'target'], `Consent Banner mapping ${index}`);
    if (!record(row.source) || !record(row.target))
      throw new TypeError(`Consent Banner mapping ${index} source and target must be objects`);
    assertExactKeys(
      row.source,
      ['apiName', 'family', 'type'],
      `Consent Banner mapping ${index}.source`,
    );
    assertExactKeys(
      row.target,
      ['apiName', 'title', 'urlName'],
      `Consent Banner mapping ${index}.target`,
    );
    if (row.source.family !== 'cms' || row.source.type !== 'consentBanner')
      throw new TypeError(`Consent Banner mapping ${index}.source must select cms/consentBanner`);
    identifier(row.source.apiName, `Consent Banner mapping ${index}.source.apiName`);
    identifier(row.target.apiName, `Consent Banner mapping ${index}.target.apiName`);
    urlName(row.target.urlName, `Consent Banner mapping ${index}.target.urlName`);
    if (!nonemptyString(row.target.title))
      throw new TypeError(`Consent Banner mapping ${index}.target.title must be nonempty`);
    const sourceApiName = row.source.apiName;
    const apiName = row.target.apiName;
    const title = row.target.title;
    const targetUrl = row.target.urlName;
    if (selected.has(sourceApiName))
      throw new TypeError(`Duplicate Consent Banner selection: ${sourceApiName}`);
    const matches = source.items.filter(
      (item) => item.contentType === CONSENT_BANNER_TYPE && item.apiName === sourceApiName,
    );
    if (matches.length !== 1)
      throw new TypeError(`Source apiName must match exactly one Consent Banner: ${sourceApiName}`);
    if (
      sourceNames.has(apiName) ||
      sourceTitles.has(title) ||
      sourceUrls.has(targetUrl) ||
      targetNames.has(apiName) ||
      targetTitles.has(title) ||
      targetUrls.has(targetUrl)
    )
      throw new TypeError(
        'Target Consent Banner apiName, title, and urlName must be fresh and unique',
      );
    classifyConsentBannerDependencies(matches[0]);
    const body = regenerateBlockIds(
      structuredClone(matches[0].contentBody),
      generateId,
      sourceBlockIds,
      generatedBlockIds,
    );
    if (!record(body)) throw new TypeError('Generated Consent Banner body must be an object');
    body[TITLE_KEY] = title;
    const planned = {
      ...structuredClone(matches[0]),
      apiName,
      title,
      urlName: targetUrl,
      contentBody: body,
    } as WorkspaceImportItem;
    classifyConsentBannerDependencies(planned);
    selected.add(sourceApiName);
    targetNames.add(apiName);
    targetTitles.add(title);
    targetUrls.add(targetUrl);
    items.push(planned);
    targets.push({ sourceApiName, apiName, title, urlName: targetUrl });
  }
  return { items, targets };
}

/**
 * Build a strict CREATE payload without source contentKey.
 * @param {WorkspaceImportItem} item - Planned Consent Banner item.
 * @param {string} contentSpaceOrFolderId - Exact destination root folder ID.
 * @returns {ConsentBannerCreatePayload} Create payload with a server-generated key.
 */
export function consentBannerCreatePayload(
  item: WorkspaceImportItem,
  contentSpaceOrFolderId: string,
): ConsentBannerCreatePayload {
  classifyConsentBannerDependencies(item);
  if (item.apiName === undefined || item.urlName === undefined)
    throw new TypeError('Consent Banner CREATE requires apiName and urlName');
  identifier(contentSpaceOrFolderId, 'Consent Banner destination root folder ID');
  return {
    apiName: item.apiName,
    contentBody: structuredClone(item.contentBody),
    contentSpaceOrFolderId,
    contentType: CONSENT_BANNER_TYPE,
    title: item.title,
    urlName: item.urlName,
  };
}

/**
 * Verify independent content and variant readback against the planned semantics.
 * @param {unknown} content - Content-detail readback.
 * @param {unknown} variant - Variant-detail readback.
 * @param {ConsentBannerReadbackExpectation} expected - Exact planned and returned identity.
 * @returns {ConsentBannerNormalization} Identical verified normalization.
 */
export function assertConsentBannerReadback(
  content: unknown,
  variant: unknown,
  expected: ConsentBannerReadbackExpectation,
): ConsentBannerNormalization {
  const normalizedContent = normalizeConsentBanner(content);
  const normalizedVariant = normalizeConsentBanner(variant);
  if (normalizedContent === null || normalizedVariant === null)
    throw new TypeError(
      'Consent Banner readback must contain exact Draft content and variant envelopes',
    );
  for (const normalized of [normalizedContent, normalizedVariant]) {
    if (
      normalized.provenance.contentSpaceId !== expected.workspaceId ||
      normalized.provenance.managedContentId !== expected.contentId ||
      normalized.provenance.managedContentVariantId !== expected.variantId ||
      normalized.semantic.apiName !== expected.apiName ||
      normalized.semantic.title !== expected.title ||
      normalized.semantic.urlName !== expected.urlName ||
      !isDeepStrictEqual(normalized.semantic, expected.semantic)
    )
      throw new TypeError(
        'Consent Banner readback identity, workspace, or semantics differ from the planned target',
      );
  }
  if (!isDeepStrictEqual(normalizedContent, normalizedVariant))
    throw new TypeError('Consent Banner content and variant readback must normalize identically');
  return normalizedContent;
}
