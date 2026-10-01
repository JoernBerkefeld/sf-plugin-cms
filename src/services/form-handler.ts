import { randomUUID as nodeRandomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { LoadedWorkspaceExport, WorkspaceImportItem } from './import-workspace.js';

const FORM_HANDLER_TYPE = 'sfdc_cms__formHandler' as const;
const BLOCK_KEY = 'sfdc_cms:block' as const;
const TITLE_KEY = 'sfdc_cms:title' as const;
const REPORT_FORMAT = 'sf-cms-form-handler-read-report@1' as const;
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
type FormHandlerEnvelope = 'content' | 'variant';

export const FORM_HANDLER_READ_REPORT_FORMAT = REPORT_FORMAT;

export type FormHandlerSourceProvenance = {
  readonly managedContentId: string;
  readonly managedContentVariantId: string;
  readonly contentSpaceId: string;
  readonly contentKey: string;
};
export type FormHandlerSemanticContent = {
  readonly contentType: typeof FORM_HANDLER_TYPE;
  readonly apiName: string;
  readonly title: string;
  readonly urlName: string;
  readonly language: string;
  readonly body: Readonly<JsonRecord>;
};
export type FormHandlerNormalization = {
  readonly semantic: FormHandlerSemanticContent;
  readonly provenance: FormHandlerSourceProvenance;
  readonly dependencies: readonly [];
  readonly references: readonly [];
};
export type FormHandlerReadReport = {
  readonly format: typeof REPORT_FORMAT;
  readonly workspaceId: string;
  readonly apiName: string;
  readonly variantId: string;
  readonly rawItemPath: string;
  readonly normalization: FormHandlerNormalization;
};
export type FormHandlerReadReportInput = Omit<FormHandlerReadReport, 'format'>;
export type FormHandlerReadReportExpectedIdentity = Partial<
  Omit<FormHandlerReadReport, 'format' | 'normalization'>
>;
export type PlannedFormHandlerTargetIdentity = {
  readonly sourceApiName: string;
  readonly apiName: string;
  readonly title: string;
  readonly urlName: string;
};
export type PlannedFormHandlerCopies = {
  readonly items: readonly WorkspaceImportItem[];
  readonly targets: readonly PlannedFormHandlerTargetIdentity[];
};
export type FormHandlerCreatePayload = {
  readonly apiName: string;
  readonly contentBody: WorkspaceImportItem['contentBody'];
  readonly contentSpaceOrFolderId: string;
  readonly contentType: typeof FORM_HANDLER_TYPE;
  readonly title: string;
  readonly urlName: string;
};
export type FormHandlerReadbackExpectation = {
  readonly workspaceId: string;
  readonly apiName: string;
  readonly title: string;
  readonly urlName: string;
  readonly contentId: string;
  readonly variantId: string;
  readonly semantic: FormHandlerSemanticContent;
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
function envelope(value: JsonRecord): FormHandlerEnvelope | undefined {
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
function forbiddenReference(value: unknown): boolean {
  if (Array.isArray(value)) return value.some((child) => forbiddenReference(child));
  if (!record(value)) return false;
  const forbidden =
    /^(?:dataGraph|externalSource|file|flow|formHandler|provider|providers|ref|reference|references|source)$/u;
  if (Object.keys(value).some((key) => forbidden.test(key))) return true;
  if (typeof value.type === 'string' && (value.type === 'file' || value.type.endsWith('Reference')))
    return true;
  return Object.values(value).some((child) => forbiddenReference(child));
}
function assertBody(value: unknown, expectedTitle?: string): asserts value is JsonRecord {
  if (!record(value)) throw new TypeError('Form Handler contentBody must be an object');
  assertExactKeys(
    value,
    ['lightning:brandSource', 'lightning:dataProviders', TITLE_KEY, BLOCK_KEY],
    'Form Handler contentBody',
  );
  const brand = value['lightning:brandSource'];
  if (
    !record(brand) ||
    !exactKeys(brand, ['defaultBrandOption']) ||
    brand.defaultBrandOption !== 'sfdcBrand'
  )
    throw new TypeError('Form Handler brandSource must select sfdcBrand');
  if (
    !Array.isArray(value['lightning:dataProviders']) ||
    value['lightning:dataProviders'].length > 0
  )
    throw new TypeError('Form Handler dataProviders must be empty');
  if (
    !nonemptyString(value[TITLE_KEY]) ||
    (expectedTitle !== undefined && value[TITLE_KEY] !== expectedTitle)
  )
    throw new TypeError('Form Handler body title must match the top-level title');
  const root = value[BLOCK_KEY];
  if (!record(root)) throw new TypeError('Form Handler root must be an object');
  assertExactKeys(root, ['children', 'definition', 'id', 'type'], 'Form Handler root');
  if (
    root.type !== 'block' ||
    root.definition !== 'sfdc_cms/rootContentBlock' ||
    !uuidV4(root.id) ||
    !Array.isArray(root.children) ||
    root.children.length > 0
  )
    throw new TypeError('Form Handler root must be an empty rootContentBlock with a UUID v4 id');
  if (forbiddenReference(value))
    throw new TypeError('Form Handler profile forbids references and providers');
}

/**
 * Normalize one exact Draft Form Handler content or variant detail envelope.
 * @param {unknown} value - Candidate content or variant detail envelope.
 * @returns {FormHandlerNormalization | null} Strict semantics and provenance, or null.
 */
export function normalizeFormHandler(value: unknown): FormHandlerNormalization | null {
  try {
    if (!record(value)) return null;
    const kind = envelope(value);
    if (kind === undefined || contentType(value.contentType) !== FORM_HANDLER_TYPE) return null;
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
      !exactKeys(value.contentSpace, ['id', 'resourceUrl']) ||
      !nonemptyString(value.contentSpace.id) ||
      value.isPublished !== false ||
      !record(value.status) ||
      !exactKeys(value.status, ['label', 'status']) ||
      value.status.status !== 'Draft' ||
      value.status.label !== 'Draft' ||
      value.externalId !== null
    )
      return null;
    assertBody(value.contentBody, value.title);
    return {
      semantic: {
        contentType: FORM_HANDLER_TYPE,
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
 * Classify the exact dependency-free Form Handler profile.
 * @param {WorkspaceImportItem} item - Candidate imported Form Handler item.
 * @returns {{ dependencies: readonly []; references: readonly [] }} Empty inventories.
 */
export function classifyFormHandlerDependencies(item: WorkspaceImportItem): {
  readonly dependencies: readonly [];
  readonly references: readonly [];
} {
  if (item.contentType !== FORM_HANDLER_TYPE)
    throw new TypeError(`Form Handler requires exact content type ${FORM_HANDLER_TYPE}`);
  assertBody(item.contentBody, item.title);
  if (forbiddenReference(item) || item.externalSource !== undefined)
    throw new TypeError('Form Handler profile forbids external/source objects and references');
  return { dependencies: [], references: [] };
}

/**
 * Build a deterministic identity-bound Form Handler read report.
 * @param {FormHandlerReadReportInput} input - Report identity and normalization.
 * @returns {FormHandlerReadReport} Versioned strict report.
 */
export function buildFormHandlerReadReport(
  input: FormHandlerReadReportInput,
): FormHandlerReadReport {
  const report: FormHandlerReadReport = { format: REPORT_FORMAT, ...input };
  if (!validateFormHandlerReadReport(report))
    throw new TypeError('Invalid Form Handler read report input');
  return report;
}
function validateNormalization(value: unknown): value is FormHandlerNormalization {
  if (
    !record(value) ||
    !exactKeys(value, ['dependencies', 'provenance', 'references', 'semantic']) ||
    !Array.isArray(value.dependencies) ||
    value.dependencies.length > 0 ||
    !Array.isArray(value.references) ||
    value.references.length > 0 ||
    !record(value.semantic) ||
    !record(value.provenance)
  )
    return false;
  try {
    assertExactKeys(
      value.semantic,
      ['apiName', 'body', 'contentType', 'language', 'title', 'urlName'],
      'Form Handler semantic',
    );
    assertExactKeys(
      value.provenance,
      ['contentKey', 'contentSpaceId', 'managedContentId', 'managedContentVariantId'],
      'Form Handler provenance',
    );
    if (
      value.semantic.contentType !== FORM_HANDLER_TYPE ||
      !nonemptyString(value.semantic.apiName) ||
      !nonemptyString(value.semantic.title) ||
      !nonemptyString(value.semantic.urlName) ||
      !nonemptyString(value.semantic.language) ||
      !nonemptyString(value.provenance.contentKey) ||
      !nonemptyString(value.provenance.contentSpaceId) ||
      !nonemptyString(value.provenance.managedContentId) ||
      !nonemptyString(value.provenance.managedContentVariantId)
    )
      return false;
    assertBody(value.semantic.body, value.semantic.title);
    return true;
  } catch {
    return false;
  }
}
/**
 * Validate the exact Form Handler read-report format and raw-item binding.
 * @param {unknown} value - Candidate report.
 * @param {FormHandlerReadReportExpectedIdentity} expected - Optional exact identity bindings.
 * @returns {value is FormHandlerReadReport} Whether the candidate is valid.
 */
export function validateFormHandlerReadReport(
  value: unknown,
  expected: FormHandlerReadReportExpectedIdentity = {},
): value is FormHandlerReadReport {
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
    !validateNormalization(value.normalization) ||
    value.variantId !== value.normalization.provenance.managedContentVariantId
  )
    return false;
  return Object.entries(expected).every(([key, expectedValue]) => value[key] === expectedValue);
}
function regenerateRootId(
  body: unknown,
  generate: () => string,
  sourceIds: ReadonlySet<string>,
  generatedIds: Set<string>,
): JsonRecord {
  const cloned = structuredClone(body);
  assertBody(cloned);
  const root = cloned[BLOCK_KEY] as JsonRecord;
  const generated = generate();
  if (!uuidV4(generated) || sourceIds.has(generated) || generatedIds.has(generated)) {
    throw new TypeError('Generated Form Handler root ID must be a fresh unique UUID v4');
  }
  generatedIds.add(generated);
  root.id = generated;
  return cloned;
}

/**
 * Plan detached strict Form Handler copies with fresh identities and root UUIDs.
 * @param {LoadedWorkspaceExport} source - Strictly loaded source package.
 * @param {unknown} input - Exact mapping rows.
 * @param {() => string} generateId - UUID-v4 generator.
 * @returns {PlannedFormHandlerCopies} Detached planned items and targets.
 */
export function planFormHandlerCopies(
  source: LoadedWorkspaceExport,
  input: unknown,
  generateId: () => string = nodeRandomUUID,
): PlannedFormHandlerCopies {
  if (!source.integrity.verified) throw new TypeError('Source integrity must be verified first');
  if (!Array.isArray(input) || input.length === 0)
    throw new TypeError('Form Handler mappings must be a nonempty array');
  const sourceNames = new Set(source.items.map(({ apiName }) => apiName));
  const sourceTitles = new Set(source.items.map(({ title }) => title));
  const sourceUrls = new Set(source.items.map(({ urlName }) => urlName));
  const selected = new Set<string>();
  const targetNames = new Set<string>();
  const targetTitles = new Set<string>();
  const targetUrls = new Set<string>();
  const sourceRootIds = new Set(
    source.items.map(
      (item) => (item.contentBody[BLOCK_KEY] as Record<string, unknown> | undefined)?.id,
    ),
  );
  const generatedRootIds = new Set<string>();
  const items: WorkspaceImportItem[] = [];
  const targets: PlannedFormHandlerTargetIdentity[] = [];
  for (const [index, row] of input.entries()) {
    if (!record(row)) throw new TypeError(`Form Handler mapping ${index} must be an object`);
    assertExactKeys(row, ['source', 'target'], `Form Handler mapping ${index}`);
    if (!record(row.source) || !record(row.target))
      throw new TypeError(`Form Handler mapping ${index} source and target must be objects`);
    assertExactKeys(
      row.source,
      ['apiName', 'family', 'type'],
      `Form Handler mapping ${index}.source`,
    );
    assertExactKeys(
      row.target,
      ['apiName', 'title', 'urlName'],
      `Form Handler mapping ${index}.target`,
    );
    if (row.source.family !== 'cms' || row.source.type !== 'formHandler')
      throw new TypeError(`Form Handler mapping ${index}.source must select cms/formHandler`);
    identifier(row.source.apiName, `Form Handler mapping ${index}.source.apiName`);
    identifier(row.target.apiName, `Form Handler mapping ${index}.target.apiName`);
    urlName(row.target.urlName, `Form Handler mapping ${index}.target.urlName`);
    if (!nonemptyString(row.target.title))
      throw new TypeError(`Form Handler mapping ${index}.target.title must be nonempty`);
    const sourceApiName = row.source.apiName;
    const apiName = row.target.apiName;
    const title = row.target.title;
    const targetUrl = row.target.urlName;
    if (selected.has(sourceApiName))
      throw new TypeError(`Duplicate Form Handler selection: ${sourceApiName}`);
    const matches = source.items.filter(
      (item) => item.contentType === FORM_HANDLER_TYPE && item.apiName === sourceApiName,
    );
    if (matches.length !== 1)
      throw new TypeError(`Source apiName must match exactly one Form Handler: ${sourceApiName}`);
    if (
      sourceNames.has(apiName) ||
      sourceTitles.has(title) ||
      sourceUrls.has(targetUrl) ||
      targetNames.has(apiName) ||
      targetTitles.has(title) ||
      targetUrls.has(targetUrl)
    )
      throw new TypeError(
        'Target Form Handler apiName, title, and urlName must be fresh and unique',
      );
    const original = matches[0];
    classifyFormHandlerDependencies(original);
    const body = regenerateRootId(
      original.contentBody,
      generateId,
      new Set([...sourceRootIds].filter((id): id is string => typeof id === 'string')),
      generatedRootIds,
    );
    body[TITLE_KEY] = title;
    const planned = {
      ...structuredClone(original),
      apiName,
      title,
      urlName: targetUrl,
      contentBody: body,
    } as WorkspaceImportItem;
    classifyFormHandlerDependencies(planned);
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
 * Build a strict Form Handler CREATE payload without source contentKey.
 * @param {WorkspaceImportItem} item - Planned Form Handler item.
 * @param {string} contentSpaceOrFolderId - Exact destination root folder ID.
 * @returns {FormHandlerCreatePayload} Create payload with server-generated key.
 */
export function formHandlerCreatePayload(
  item: WorkspaceImportItem,
  contentSpaceOrFolderId: string,
): FormHandlerCreatePayload {
  classifyFormHandlerDependencies(item);
  if (item.apiName === undefined || item.urlName === undefined)
    throw new TypeError('Form Handler CREATE requires apiName and urlName');
  identifier(contentSpaceOrFolderId, 'Form Handler destination root folder ID');
  return {
    apiName: item.apiName,
    contentBody: structuredClone(item.contentBody),
    contentSpaceOrFolderId,
    contentType: FORM_HANDLER_TYPE,
    title: item.title,
    urlName: item.urlName,
  };
}

/**
 * Compare independent content and variant readback for one Form Handler result.
 * @param {unknown} content - Content-detail readback.
 * @param {unknown} variant - Variant-detail readback.
 * @param {FormHandlerReadbackExpectation} expected - Exact planned and returned identity.
 * @returns {FormHandlerNormalization} Identical verified normalization.
 */
export function assertFormHandlerReadback(
  content: unknown,
  variant: unknown,
  expected: FormHandlerReadbackExpectation,
): FormHandlerNormalization {
  const normalizedContent = normalizeFormHandler(content);
  const normalizedVariant = normalizeFormHandler(variant);
  if (normalizedContent === null || normalizedVariant === null)
    throw new TypeError(
      'Form Handler readback must contain exact Draft content and variant envelopes',
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
        'Form Handler readback identity, workspace, or semantics differ from the planned target',
      );
  }
  if (!isDeepStrictEqual(normalizedContent, normalizedVariant))
    throw new TypeError('Form Handler content and variant readback must normalize identically');
  return normalizedContent;
}
