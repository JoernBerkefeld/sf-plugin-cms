import { randomUUID as nodeRandomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { LoadedWorkspaceExport, WorkspaceImportItem } from './import-workspace.js';

const BRAND_TYPE = 'sfdc_cms__brand' as const;
const TITLE_KEY = 'sfdc_cms:title' as const;
const UUID_V4 = /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/iu;

type JsonRecord = Record<string, unknown>;

const COMMON_KEYS = [
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
const CONTENT_KEYS = [...COMMON_KEYS, 'contentVersion', 'variantVersion'] as const;
const BODY_KEYS = [
  'baseFontFamily',
  'baseFontSize',
  'borderRadius',
  'borderWeight',
  'buttonStyleGroup',
  'colorScheme',
  'fontFamily',
  'fontSize',
  'fontWeight',
  'letterSpacing',
  'lightning:dataProviders',
  'sfdc_cms:title',
  'spacing',
  'typography',
  'sfdc_cms:einsteinBrandProperties',
  'sfdc_cms:variants',
] as const;
const FONT_KEYS = [
  'arial',
  'arialBlack',
  'calibri',
  'comicSansMs',
  'courierNew',
  'georgia',
  'impact',
  'lucidaConsole',
  'lucidaSansUnicode',
  'palatinoLinotype',
  'tahoma',
  'timesNewRoman',
  'trebuchetMs',
  'verdana',
] as const;

export const BRAND_READ_REPORT_FORMAT = 'sf-cms-brand-read-report@1' as const;

export type BrandSourceProvenance = {
  readonly managedContentId: string;
  readonly managedContentVariantId: string;
  readonly contentSpaceId: string;
};

export type BrandNormalization = {
  readonly semantic: {
    readonly contentType: typeof BRAND_TYPE;
    readonly title: string;
    readonly body: Readonly<JsonRecord>;
  };
  readonly provenance: BrandSourceProvenance;
  readonly unresolvedReferences: readonly [];
};

export type BrandReadReport = {
  readonly format: typeof BRAND_READ_REPORT_FORMAT;
  readonly workspaceId: string;
  readonly apiName: string;
  readonly variantId: string;
  readonly rawItemPath: string;
  readonly normalization: BrandNormalization;
};

export type BrandReadReportInput = Omit<BrandReadReport, 'format'>;
export type BrandReadReportExpectedIdentity = Partial<Omit<BrandReadReport, 'format'>>;

export type BrandCopyMapping = {
  readonly source: { readonly family: 'cms'; readonly type: 'brand'; readonly apiName: string };
  readonly target: { readonly apiName: string; readonly title: string; readonly urlName: string };
};

export type PlannedBrandTargetIdentity = {
  readonly sourceApiName: string;
  readonly apiName: string;
  readonly title: string;
  readonly urlName: string;
};

export type PlannedBrandCopies = {
  readonly items: readonly WorkspaceImportItem[];
  readonly targets: readonly PlannedBrandTargetIdentity[];
};

export type BrandCreatePayload = {
  readonly apiName: string;
  readonly contentBody: WorkspaceImportItem['contentBody'];
  readonly contentSpaceOrFolderId: string;
  readonly contentType: typeof BRAND_TYPE;
  readonly title: string;
  readonly urlName: string;
};

export type BrandReadbackExpectation = {
  readonly workspaceId: string;
  readonly apiName: string;
  readonly title: string;
  readonly urlName: string;
  readonly contentId: string;
  readonly variantId: string;
  readonly language: string;
  readonly body: WorkspaceImportItem['contentBody'];
};

function record(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonemptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function exactKeys(value: JsonRecord, keys: readonly string[]): boolean {
  const actual = Object.keys(value).toSorted();
  return (
    actual.length === keys.length && actual.every((key, index) => key === keys.toSorted()[index])
  );
}

function onlyKeys(value: JsonRecord, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function assertExactKeys(value: JsonRecord, keys: readonly string[], label: string): void {
  if (!exactKeys(value, keys))
    throw new TypeError(`${label} must contain exactly ${keys.join(', ')}`);
}

function identifier(value: unknown, label: string): asserts value is string {
  if (!nonemptyString(value) || !/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw new TypeError(`${label} must be a nonempty identifier without whitespace or separators`);
  }
}

function urlName(value: unknown, label: string): asserts value is string {
  if (!nonemptyString(value) || !/^[a-z0-9-]+$/u.test(value)) {
    throw new TypeError(`${label} must contain lowercase letters, digits, or hyphens`);
  }
}

function contentTypeName(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (!record(value)) return undefined;
  return typeof value.fullyQualifiedName === 'string' ? value.fullyQualifiedName : undefined;
}

function uuidV4(value: unknown): value is string {
  return typeof value === 'string' && UUID_V4.test(value);
}

function measurement(value: unknown, units: readonly string[] = ['rem']): boolean {
  return (
    record(value) &&
    exactKeys(value, ['unit', 'value']) &&
    units.includes(String(value.unit)) &&
    typeof value.value === 'number' &&
    Number.isFinite(value.value)
  );
}

function measurementMap(value: unknown, keys: readonly string[]): boolean {
  return record(value) && exactKeys(value, keys) && keys.every((key) => measurement(value[key]));
}

function inset(value: unknown): boolean {
  return measurementMap(value, ['bottom', 'left', 'right', 'top']);
}

function expression(value: unknown): value is string {
  return typeof value === 'string' && /^\{!\$brand\.[A-Za-z\d.]+\}$/u.test(value);
}

function typographyStyle(value: unknown): boolean {
  return (
    record(value) &&
    exactKeys(value, [
      'fontFamily',
      'fontSize',
      'fontWeight',
      'letterSpacing',
      'lineHeight',
      'textTransform',
    ]) &&
    expression(value.fontFamily) &&
    expression(value.fontSize) &&
    expression(value.fontWeight) &&
    value.letterSpacing === 'normal' &&
    value.lineHeight === 1.5 &&
    value.textTransform === 'none'
  );
}

function styleGroup(value: unknown, names: readonly string[]): boolean {
  return (
    record(value) && exactKeys(value, names) && names.every((name) => typographyStyle(value[name]))
  );
}

function buttonStyle(value: unknown, tertiary: boolean): boolean {
  if (
    !record(value) ||
    !exactKeys(value, [
      'lightning:borderRadius',
      'lightning:borderWidth',
      'lightning:buttonColorGroup',
      'lightning:padding',
      'lightning:typography',
    ]) ||
    !expression(value['lightning:borderRadius']) ||
    !expression(value['lightning:borderWidth']) ||
    !inset(value['lightning:padding']) ||
    !expression(value['lightning:typography']) ||
    !record(value['lightning:buttonColorGroup'])
  ) {
    return false;
  }
  const colors = value['lightning:buttonColorGroup'];
  const keys = tertiary
    ? ['textColor', 'textHoverColor']
    : [
        'backgroundColor',
        'backgroundHoverColor',
        'borderColor',
        'borderHoverColor',
        'textColor',
        'textHoverColor',
      ];
  return exactKeys(colors, keys) && keys.every((key) => expression(colors[key]));
}

function validBrandBody(value: unknown): value is JsonRecord {
  if (!record(value) || !exactKeys(value, BODY_KEYS)) return false;
  if (
    !expression(value.baseFontFamily) ||
    !measurement(value.baseFontSize, ['px']) ||
    !measurementMap(value.borderRadius, ['round', 'square']) ||
    !measurementMap(value.borderWeight, ['medium', 'none', 'thick', 'thin']) ||
    !record(value.buttonStyleGroup) ||
    !exactKeys(value.buttonStyleGroup, ['primary', 'secondary', 'tertiary']) ||
    !buttonStyle(value.buttonStyleGroup.primary, false) ||
    !buttonStyle(value.buttonStyleGroup.secondary, false) ||
    !buttonStyle(value.buttonStyleGroup.tertiary, true) ||
    !record(value.colorScheme) ||
    !exactKeys(value.colorScheme, [
      'contrast',
      'neutral',
      'primaryAccent',
      'primaryAccentContrast',
      'primaryAccentContrastDerived',
      'primaryAccentDerived',
      'root',
    ]) ||
    !Object.values(value.colorScheme).every((entry) => typeof entry === 'string') ||
    !record(value.fontFamily) ||
    !exactKeys(value.fontFamily, FONT_KEYS)
  ) {
    return false;
  }
  for (const font of Object.values(value.fontFamily)) {
    if (
      !record(font) ||
      !onlyKeys(font, ['category', 'fallbacks', 'name']) ||
      !nonemptyString(font.category) ||
      !nonemptyString(font.name) ||
      (font.fallbacks !== undefined &&
        (!Array.isArray(font.fallbacks) || !font.fallbacks.every(nonemptyString)))
    ) {
      return false;
    }
  }
  if (
    !measurementMap(value.fontSize, ['large', 'medium', 'small', 'xLarge', 'xSmall', 'xxLarge']) ||
    !record(value.fontWeight) ||
    !exactKeys(value.fontWeight, ['bold', 'light', 'normal']) ||
    !Object.values(value.fontWeight).every((entry) => typeof entry === 'number') ||
    !record(value.letterSpacing) ||
    !exactKeys(value.letterSpacing, ['compact', 'normal', 'wide']) ||
    !measurement(value.letterSpacing.compact, ['px']) ||
    value.letterSpacing.normal !== 'normal' ||
    !measurement(value.letterSpacing.wide, ['px']) ||
    !Array.isArray(value['lightning:dataProviders']) ||
    value['lightning:dataProviders'].length > 0 ||
    !nonemptyString(value['sfdc_cms:title']) ||
    !record(value.spacing) ||
    !exactKeys(value.spacing, ['large', 'medium', 'none', 'small', 'xLarge', 'xSmall']) ||
    !Object.values(value.spacing).every((entry) => inset(entry)) ||
    !record(value.typography) ||
    !exactKeys(value.typography, ['button', 'heading', 'input', 'label', 'paragraph']) ||
    !styleGroup(value.typography.button, ['button1']) ||
    !styleGroup(value.typography.heading, [
      'heading1',
      'heading2',
      'heading3',
      'heading4',
      'heading5',
      'heading6',
    ]) ||
    !styleGroup(value.typography.input, ['input1']) ||
    !styleGroup(value.typography.label, ['label1']) ||
    !styleGroup(value.typography.paragraph, ['paragraph1', 'paragraph2']) ||
    !record(value['sfdc_cms:einsteinBrandProperties']) ||
    !exactKeys(value['sfdc_cms:einsteinBrandProperties'], ['personality']) ||
    !record(value['sfdc_cms:einsteinBrandProperties'].personality) ||
    !exactKeys(value['sfdc_cms:einsteinBrandProperties'].personality, ['defaultPersonality']) ||
    !nonemptyString(value['sfdc_cms:einsteinBrandProperties'].personality.defaultPersonality) ||
    !Array.isArray(value['sfdc_cms:variants']) ||
    value['sfdc_cms:variants'].length > 0
  ) {
    return false;
  }
  return true;
}

function safeRawItemPath(value: unknown): value is string {
  if (!nonemptyString(value) || !value.startsWith('items/') || !value.endsWith('.json'))
    return false;
  if (value.includes('\\') || value.startsWith('/') || /^[A-Za-z]:/u.test(value)) return false;
  return value
    .split('/')
    .every((segment) => segment.length > 0 && segment !== '.' && segment !== '..');
}

function contentType(value: JsonRecord): string | undefined {
  return record(value.contentType) && onlyKeys(value.contentType, ['fullyQualifiedName', 'name'])
    ? (value.contentType.fullyQualifiedName as string | undefined)
    : undefined;
}

/**
 * Normalize one retained-evidence Brand content or variant record.
 * @param {unknown} value - Candidate Brand detail envelope.
 * @returns {BrandNormalization | null} Strict semantic and provenance separation, or null.
 */
export function normalizeBrand(value: unknown): BrandNormalization | null {
  if (!record(value)) return null;
  const isContent = 'contentVersion' in value || 'variantVersion' in value;
  if (
    !exactKeys(value, isContent ? CONTENT_KEYS : COMMON_KEYS) ||
    contentType(value) !== BRAND_TYPE
  )
    return null;
  if (
    !nonemptyString(value.managedContentId) ||
    !nonemptyString(value.managedContentVariantId) ||
    value.managedContentId === value.managedContentVariantId ||
    !record(value.contentSpace) ||
    !exactKeys(value.contentSpace, ['id', 'resourceUrl']) ||
    !nonemptyString(value.contentSpace.id) ||
    !validBrandBody(value.contentBody) ||
    value.title !== value.contentBody['sfdc_cms:title'] ||
    value.isPublished !== false ||
    !record(value.status) ||
    !exactKeys(value.status, ['label', 'status']) ||
    value.status.status !== 'Draft'
  ) {
    return null;
  }
  return {
    semantic: {
      contentType: BRAND_TYPE,
      title: value.contentBody['sfdc_cms:title'] as string,
      body: structuredClone(value.contentBody),
    },
    provenance: {
      managedContentId: value.managedContentId,
      managedContentVariantId: value.managedContentVariantId,
      contentSpaceId: value.contentSpace.id,
    },
    unresolvedReferences: [],
  };
}

function validNormalization(value: unknown): value is BrandNormalization {
  return (
    record(value) &&
    exactKeys(value, ['semantic', 'provenance', 'unresolvedReferences']) &&
    record(value.semantic) &&
    exactKeys(value.semantic, ['body', 'contentType', 'title']) &&
    value.semantic.contentType === BRAND_TYPE &&
    nonemptyString(value.semantic.title) &&
    validBrandBody(value.semantic.body) &&
    value.semantic.title === value.semantic.body['sfdc_cms:title'] &&
    record(value.provenance) &&
    exactKeys(value.provenance, [
      'contentSpaceId',
      'managedContentId',
      'managedContentVariantId',
    ]) &&
    nonemptyString(value.provenance.contentSpaceId) &&
    nonemptyString(value.provenance.managedContentId) &&
    nonemptyString(value.provenance.managedContentVariantId) &&
    value.provenance.managedContentId !== value.provenance.managedContentVariantId &&
    Array.isArray(value.unresolvedReferences) &&
    value.unresolvedReferences.length === 0
  );
}

export function buildBrandReadReport(input: BrandReadReportInput): BrandReadReport {
  const report: BrandReadReport = { format: BRAND_READ_REPORT_FORMAT, ...input };
  if (!validateBrandReadReport(report)) throw new Error('Invalid Brand read report input.');
  return report;
}

export function validateBrandReadReport(
  value: unknown,
  expected: BrandReadReportExpectedIdentity = {},
): value is BrandReadReport {
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
    value.format !== BRAND_READ_REPORT_FORMAT ||
    !nonemptyString(value.workspaceId) ||
    !nonemptyString(value.apiName) ||
    !nonemptyString(value.variantId) ||
    !safeRawItemPath(value.rawItemPath) ||
    !validNormalization(value.normalization) ||
    value.variantId !== value.normalization.provenance.managedContentVariantId
  ) {
    return false;
  }
  return Object.entries(expected).every(([key, expectedValue]) => value[key] === expectedValue);
}

/**
 * Validate Brand report identity for import without treating the retained export body schema as a CREATE allowlist.
 * @param {unknown} value - Candidate report.
 * @param {BrandReadReportExpectedIdentity} expected - Exact descriptor identity bindings.
 * @returns {value is BrandReadReport} Whether the report has safe identity/provenance structure and an opaque JSON body.
 */
export function validateBrandImportReadReport(
  value: unknown,
  expected: BrandReadReportExpectedIdentity = {},
): value is BrandReadReport {
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
    value.format !== BRAND_READ_REPORT_FORMAT ||
    !nonemptyString(value.workspaceId) ||
    !nonemptyString(value.apiName) ||
    !nonemptyString(value.variantId) ||
    !safeRawItemPath(value.rawItemPath) ||
    !record(value.normalization) ||
    !exactKeys(value.normalization, ['semantic', 'provenance', 'unresolvedReferences']) ||
    !record(value.normalization.semantic) ||
    !exactKeys(value.normalization.semantic, ['body', 'contentType', 'title']) ||
    value.normalization.semantic.contentType !== BRAND_TYPE ||
    !nonemptyString(value.normalization.semantic.title) ||
    !record(value.normalization.semantic.body) ||
    !record(value.normalization.provenance) ||
    !exactKeys(value.normalization.provenance, [
      'contentSpaceId',
      'managedContentId',
      'managedContentVariantId',
    ]) ||
    !nonemptyString(value.normalization.provenance.contentSpaceId) ||
    !nonemptyString(value.normalization.provenance.managedContentId) ||
    !nonemptyString(value.normalization.provenance.managedContentVariantId) ||
    value.normalization.provenance.managedContentId ===
      value.normalization.provenance.managedContentVariantId ||
    value.variantId !== value.normalization.provenance.managedContentVariantId ||
    !Array.isArray(value.normalization.unresolvedReferences) ||
    value.normalization.unresolvedReferences.length > 0
  ) {
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
  const generated = value.type === 'block' && nonemptyString(value.id) ? generate() : undefined;
  if (
    generated !== undefined &&
    (!uuidV4(generated) || sourceIds.has(generated) || generatedIds.has(generated))
  ) {
    throw new TypeError('Generated Brand block IDs must be fresh unique UUID v4 values');
  }
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
 * Plan detached Brand copies while preserving complete body semantics.
 * @param {LoadedWorkspaceExport} source - Strictly loaded typed Brand package.
 * @param {unknown} input - Nonempty exact Brand mapping rows.
 * @param {() => string} generateId - UUID generator for objective block nodes, if present.
 * @returns {PlannedBrandCopies} Selected detached items and fresh target identities.
 */
export function planBrandCopies(
  source: LoadedWorkspaceExport,
  input: unknown,
  generateId: () => string = nodeRandomUUID,
): PlannedBrandCopies {
  if (!source.integrity.verified) throw new TypeError('Source integrity must be verified first');
  if (!Array.isArray(input) || input.length === 0)
    throw new TypeError('Brand mappings must be a nonempty array');
  const sourceApiNames = new Set(source.items.map(({ apiName }) => apiName));
  const sourceTitles = new Set(source.items.map(({ title }) => title));
  const sourceUrls = new Set(source.items.map(({ urlName }) => urlName));
  const sourceBlockIds = new Set<string>();
  for (const item of source.items) collectBlockIds(item.contentBody, sourceBlockIds);
  const generatedBlockIds = new Set<string>();
  const selected = new Set<string>();
  const targetApiNames = new Set<string>();
  const targetTitles = new Set<string>();
  const targetUrls = new Set<string>();
  const items: WorkspaceImportItem[] = [];
  const targets: PlannedBrandTargetIdentity[] = [];

  for (const [index, row] of input.entries()) {
    if (!record(row)) throw new TypeError(`Brand mapping ${index} must be an object`);
    assertExactKeys(row, ['source', 'target'], `Brand mapping ${index}`);
    if (!record(row.source) || !record(row.target))
      throw new TypeError(`Brand mapping ${index} source and target must be objects`);
    assertExactKeys(row.source, ['apiName', 'family', 'type'], `Brand mapping ${index}.source`);
    assertExactKeys(row.target, ['apiName', 'title', 'urlName'], `Brand mapping ${index}.target`);
    if (row.source.family !== 'cms' || row.source.type !== 'brand')
      throw new TypeError(`Brand mapping ${index}.source must select cms/brand`);
    identifier(row.source.apiName, `Brand mapping ${index}.source.apiName`);
    identifier(row.target.apiName, `Brand mapping ${index}.target.apiName`);
    if (!nonemptyString(row.target.title))
      throw new TypeError(`Brand mapping ${index}.target.title must be nonempty`);
    urlName(row.target.urlName, `Brand mapping ${index}.target.urlName`);
    const sourceApiName = row.source.apiName;
    const targetApiName = row.target.apiName;
    const targetTitle = row.target.title;
    const targetUrlName = row.target.urlName;
    if (selected.has(sourceApiName))
      throw new TypeError(`Duplicate Brand selection: ${sourceApiName}`);
    const matches = source.items.filter(
      (item) => item.contentType === BRAND_TYPE && item.apiName === sourceApiName,
    );
    if (matches.length !== 1)
      throw new TypeError(`Source apiName must match exactly one Brand: ${sourceApiName}`);
    if (
      sourceApiNames.has(targetApiName) ||
      sourceTitles.has(targetTitle) ||
      sourceUrls.has(targetUrlName) ||
      targetApiNames.has(targetApiName) ||
      targetTitles.has(targetTitle) ||
      targetUrls.has(targetUrlName)
    ) {
      throw new TypeError('Target Brand apiName, title, and urlName must be fresh and unique');
    }
    const item = matches[0];
    if (!record(item.contentBody)) throw new TypeError('Brand contentBody must be an object');
    const regenerated = regenerateBlockIds(
      structuredClone(item.contentBody),
      generateId,
      sourceBlockIds,
      generatedBlockIds,
    );
    if (!record(regenerated)) throw new TypeError('Generated Brand body must be an object');
    if (TITLE_KEY in regenerated) regenerated[TITLE_KEY] = targetTitle;
    const planned = {
      ...structuredClone(item),
      apiName: targetApiName,
      title: targetTitle,
      urlName: targetUrlName,
      contentBody: regenerated as WorkspaceImportItem['contentBody'],
    } as WorkspaceImportItem;
    selected.add(sourceApiName);
    targetApiNames.add(targetApiName);
    targetTitles.add(targetTitle);
    targetUrls.add(targetUrlName);
    items.push(planned);
    targets.push({
      sourceApiName,
      apiName: targetApiName,
      title: targetTitle,
      urlName: targetUrlName,
    });
  }
  return { items, targets };
}

/**
 * Build a generic Brand CREATE payload without source identity provenance.
 * @param {WorkspaceImportItem} item - Planned Brand item retaining only source provenance outside the request.
 * @param {string} contentSpaceOrFolderId - Exact destination root folder ID.
 * @returns {BrandCreatePayload} Brand CREATE payload with the source content key omitted.
 */
export function brandCreatePayload(
  item: WorkspaceImportItem,
  contentSpaceOrFolderId: string,
): BrandCreatePayload {
  if (item.contentType !== BRAND_TYPE || item.apiName === undefined || item.urlName === undefined)
    throw new TypeError('Brand CREATE requires exact type, apiName, and urlName');
  identifier(contentSpaceOrFolderId, 'Brand destination root folder ID');
  return {
    apiName: item.apiName,
    contentBody: structuredClone(item.contentBody),
    contentSpaceOrFolderId,
    contentType: BRAND_TYPE,
    title: item.title,
    urlName: item.urlName,
  };
}

function readback(value: unknown): {
  readonly apiName: string;
  readonly title: string;
  readonly urlName: string;
  readonly language: string;
  readonly body: JsonRecord;
  readonly contentId: string;
  readonly variantId: string;
  readonly workspaceId: string;
} | null {
  if (!record(value) || contentTypeName(value.contentType) !== BRAND_TYPE) return null;
  const contentId = [value.managedContentId, value.contentId].find(nonemptyString);
  const variantId = [value.managedContentVariantId, value.id].find(nonemptyString);
  if (
    !nonemptyString(value.apiName) ||
    !nonemptyString(value.title) ||
    !nonemptyString(value.urlName) ||
    !nonemptyString(value.language) ||
    !nonemptyString(contentId) ||
    !nonemptyString(variantId) ||
    !record(value.contentSpace) ||
    !nonemptyString(value.contentSpace.id) ||
    !record(value.contentBody) ||
    value.isPublished !== false ||
    !record(value.status) ||
    value.status.status !== 'Draft'
  ) {
    return null;
  }
  return {
    apiName: value.apiName,
    title: value.title,
    urlName: value.urlName,
    language: value.language,
    body: value.contentBody,
    contentId,
    variantId,
    workspaceId: value.contentSpace.id,
  };
}

/**
 * Compare independent content-key and variant readback without imposing a body schema.
 * @param {unknown} content - Independent content-key detail response.
 * @param {unknown} variant - Independent variant-ID detail response.
 * @param {BrandReadbackExpectation} expected - Exact target identity, body, and returned IDs.
 * @returns {void} Nothing when both readbacks match exactly.
 */
export function assertBrandReadback(
  content: unknown,
  variant: unknown,
  expected: BrandReadbackExpectation,
): void {
  const contentValue = readback(content);
  const variantValue = readback(variant);
  if (contentValue === null || variantValue === null)
    throw new TypeError(
      'Brand readback must contain Draft unpublished content and variant envelopes',
    );
  const expectedValue = {
    apiName: expected.apiName,
    title: expected.title,
    urlName: expected.urlName,
    language: expected.language,
    body: expected.body,
    contentId: expected.contentId,
    variantId: expected.variantId,
    workspaceId: expected.workspaceId,
  };
  if (
    !isDeepStrictEqual(contentValue, expectedValue) ||
    !isDeepStrictEqual(variantValue, expectedValue)
  )
    throw new TypeError('Brand readback identity, workspace, status, or body differs from target');
}
