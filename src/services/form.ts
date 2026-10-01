import { randomUUID as nodeRandomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { LoadedWorkspaceExport, WorkspaceImportItem } from './import-workspace.js';

const FORM_TYPE = 'sfdc_cms__form' as const;
const TITLE_KEY = 'sfdc_cms:title' as const;
const FORM_REPORT_FORMAT = 'sf-cms-form-read-report@1' as const;
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
type FormEnvelope = 'content' | 'variant';

export const FORM_READ_REPORT_FORMAT = FORM_REPORT_FORMAT;

export type FormActionDescriptor =
  | { readonly type: 'custom'; readonly name: 'formsubmit' }
  | {
      readonly type: 'built-in';
      readonly name: 'umaFormSubmissionAction' | 'showThankYouAction';
    };

export type FormSourceProvenance = {
  readonly managedContentId: string;
  readonly managedContentVariantId: string;
  readonly contentSpaceId: string;
  readonly contentKey: string;
};

export type FormSemanticContent = {
  readonly contentType: typeof FORM_TYPE;
  readonly apiName: string;
  readonly title: string;
  readonly urlName: string;
  readonly language: string;
  readonly body: Readonly<JsonRecord>;
};

export type FormNormalization = {
  readonly semantic: FormSemanticContent;
  readonly provenance: FormSourceProvenance;
  readonly dependencies: readonly [];
  readonly references: readonly [];
};

export type FormReadReport = {
  readonly format: typeof FORM_REPORT_FORMAT;
  readonly workspaceId: string;
  readonly apiName: string;
  readonly variantId: string;
  readonly rawItemPath: string;
  readonly normalization: FormNormalization;
};

export type FormReadReportInput = Omit<FormReadReport, 'format'>;
export type FormReadReportExpectedIdentity = Partial<
  Omit<FormReadReport, 'format' | 'normalization'>
>;

export type FormCopyMapping = {
  readonly source: { readonly family: 'cms'; readonly type: 'form'; readonly apiName: string };
  readonly target: { readonly apiName: string; readonly title: string; readonly urlName: string };
};

export type PlannedFormTargetIdentity = {
  readonly sourceApiName: string;
  readonly apiName: string;
  readonly title: string;
  readonly urlName: string;
};

export type PlannedFormCopies = {
  readonly items: readonly WorkspaceImportItem[];
  readonly targets: readonly PlannedFormTargetIdentity[];
};

export type FormCreatePayload = {
  readonly apiName: string;
  readonly contentBody: WorkspaceImportItem['contentBody'];
  readonly contentSpaceOrFolderId: string;
  readonly contentType: typeof FORM_TYPE;
  readonly title: string;
  readonly urlName: string;
};

export type FormReadbackExpectation = {
  readonly workspaceId: string;
  readonly apiName: string;
  readonly title: string;
  readonly urlName: string;
  readonly contentId: string;
  readonly variantId: string;
  readonly semantic: FormSemanticContent;
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
  if (!nonemptyString(value) || !/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw new TypeError(`${label} must be a nonempty identifier without whitespace or separators`);
  }
}

function urlName(value: unknown, label: string): asserts value is string {
  if (!nonemptyString(value) || !/^[a-z0-9-]+$/u.test(value)) {
    throw new TypeError(`${label} must contain lowercase letters, digits, or hyphens`);
  }
}

function uuidV4(value: unknown): value is string {
  return typeof value === 'string' && UUID_V4.test(value);
}

function envelope(value: JsonRecord): FormEnvelope | undefined {
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

function assertFormBody(value: unknown): asserts value is JsonRecord {
  if (!record(value)) throw new TypeError('Form contentBody must be an object');
}

function safeRawItemPath(value: unknown, variantId: string): value is string {
  return value === `items/${variantId}.json`;
}

/**
 * Normalize one exact Draft Form content or variant detail envelope.
 * @param {unknown} value - Candidate Form detail envelope.
 * @returns {FormNormalization | null} Strict portable semantics and separate source provenance, or null.
 */
export function normalizeForm(value: unknown): FormNormalization | null {
  try {
    if (!record(value)) return null;
    const kind = envelope(value);
    if (kind === undefined || contentType(value.contentType) !== FORM_TYPE) return null;
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
    ) {
      return null;
    }
    assertFormBody(value.contentBody);
    return {
      semantic: {
        contentType: FORM_TYPE,
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
 * Validate transport-level Form requirements without guessing whether body fields are portable.
 * @param {WorkspaceImportItem} item - Form workspace item to inspect.
 * @returns {{ dependencies: readonly []; references: readonly [] }} No client-invented mapping requirements.
 */
export function classifyFormDependencies(item: WorkspaceImportItem): {
  readonly dependencies: readonly [];
  readonly references: readonly [];
} {
  if (item.contentType !== FORM_TYPE)
    throw new TypeError(`Form requires exact content type ${FORM_TYPE}`);
  assertFormBody(item.contentBody);
  return { dependencies: [], references: [] };
}

/**
 * Build a deterministic identity-bound Form read report.
 * @param {FormReadReportInput} input - Valid report identity and normalization.
 * @returns {FormReadReport} Versioned Form report.
 */
export function buildFormReadReport(input: FormReadReportInput): FormReadReport {
  const report: FormReadReport = { format: FORM_REPORT_FORMAT, ...input };
  if (!validateFormReadReport(report)) throw new TypeError('Invalid Form read report input');
  return report;
}

/**
 * Validate the exact Form read-report format and safe item-to-variant binding.
 * @param {unknown} value - Candidate report.
 * @param {FormReadReportExpectedIdentity} expected - Optional exact identity bindings.
 * @returns {value is FormReadReport} Whether the candidate is an exact Form report.
 */
export function validateFormReadReport(
  value: unknown,
  expected: FormReadReportExpectedIdentity = {},
): value is FormReadReport {
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
    value.format !== FORM_REPORT_FORMAT ||
    !nonemptyString(value.workspaceId) ||
    !nonemptyString(value.apiName) ||
    !nonemptyString(value.variantId) ||
    !safeRawItemPath(value.rawItemPath, value.variantId) ||
    !record(value.normalization) ||
    !exactKeys(value.normalization, ['dependencies', 'provenance', 'references', 'semantic']) ||
    !record(value.normalization.provenance) ||
    value.variantId !== value.normalization.provenance.managedContentVariantId ||
    !Array.isArray(value.normalization.dependencies) ||
    value.normalization.dependencies.length > 0 ||
    !Array.isArray(value.normalization.references) ||
    value.normalization.references.length > 0
  ) {
    return false;
  }
  const normalized = normalizeSemantic(value.normalization);
  if (normalized === null) return false;
  return Object.entries(expected).every(([key, expectedValue]) => value[key] === expectedValue);
}

function normalizeSemantic(value: JsonRecord): FormNormalization | null {
  if (!record(value.semantic) || !record(value.provenance)) return null;
  const semantic = value.semantic;
  const provenance = value.provenance;
  try {
    assertExactKeys(
      semantic,
      ['apiName', 'body', 'contentType', 'language', 'title', 'urlName'],
      'Form semantic',
    );
    assertExactKeys(
      provenance,
      ['contentKey', 'contentSpaceId', 'managedContentId', 'managedContentVariantId'],
      'Form provenance',
    );
    if (
      semantic.contentType !== FORM_TYPE ||
      !nonemptyString(semantic.apiName) ||
      !nonemptyString(semantic.title) ||
      !nonemptyString(semantic.urlName) ||
      !nonemptyString(semantic.language) ||
      !nonemptyString(provenance.contentKey) ||
      !nonemptyString(provenance.contentSpaceId) ||
      !nonemptyString(provenance.managedContentId) ||
      !nonemptyString(provenance.managedContentVariantId)
    ) {
      return null;
    }
    assertFormBody(semantic.body);
    return value as FormNormalization;
  } catch {
    return null;
  }
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
  ) {
    throw new TypeError('Generated Form block IDs must be fresh unique UUID v4 values');
  }
  if (generated !== undefined) generatedIds.add(generated);
  const regenerated = Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key,
      key === 'id' && generated !== undefined
        ? generated
        : regenerateBlockIds(child, generate, sourceIds, generatedIds),
    ]),
  );
  if (generated !== undefined) regenerated.id = generated;
  return regenerated;
}

/**
 * Plan detached strict Form copies with fresh names and regenerated UUID v4 block IDs.
 * @param {LoadedWorkspaceExport} source - Integrity-verified source workspace export.
 * @param {unknown} input - Nonempty exact Form mapping rows.
 * @param {() => string} generateId - UUID v4 generator injectable for deterministic tests.
 * @returns {PlannedFormCopies} Selected detached items and target identities; no target content key is allocated.
 */
export function planFormCopies(
  source: LoadedWorkspaceExport,
  input: unknown,
  generateId: () => string = nodeRandomUUID,
): PlannedFormCopies {
  if (!source.integrity.verified) throw new TypeError('Source integrity must be verified first');
  if (!Array.isArray(input) || input.length === 0)
    throw new TypeError('Form mappings must be a nonempty array');
  const sourceApiNames = new Set(source.items.map(({ apiName }) => apiName));
  const sourceTitles = new Set(source.items.map(({ title }) => title));
  const sourceUrls = new Set(source.items.map(({ urlName }) => urlName));
  const selected = new Set<string>();
  const targetApiNames = new Set<string>();
  const targetTitles = new Set<string>();
  const targetUrls = new Set<string>();
  const sourceBlockIds = new Set<string>();
  for (const item of source.items) collectBlockIds(item.contentBody, sourceBlockIds);
  const generatedBlockIds = new Set<string>();
  const items: WorkspaceImportItem[] = [];
  const targets: PlannedFormTargetIdentity[] = [];

  for (const [index, row] of input.entries()) {
    if (!record(row)) throw new TypeError(`Form mapping ${index} must be an object`);
    assertExactKeys(row, ['source', 'target'], `Form mapping ${index}`);
    if (!record(row.source) || !record(row.target))
      throw new TypeError(`Form mapping ${index} source and target must be objects`);
    assertExactKeys(row.source, ['apiName', 'family', 'type'], `Form mapping ${index}.source`);
    assertExactKeys(row.target, ['apiName', 'title', 'urlName'], `Form mapping ${index}.target`);
    if (row.source.family !== 'cms' || row.source.type !== 'form') {
      throw new TypeError(`Form mapping ${index}.source must select cms/form`);
    }
    identifier(row.source.apiName, `Form mapping ${index}.source.apiName`);
    identifier(row.target.apiName, `Form mapping ${index}.target.apiName`);
    if (!nonemptyString(row.target.title))
      throw new TypeError(`Form mapping ${index}.target.title must be nonempty`);
    urlName(row.target.urlName, `Form mapping ${index}.target.urlName`);
    const sourceApiName = row.source.apiName;
    const targetApiName = row.target.apiName;
    const targetTitle = row.target.title;
    const targetUrlName = row.target.urlName;
    if (selected.has(sourceApiName))
      throw new TypeError(`Duplicate Form selection: ${sourceApiName}`);
    const matches = source.items.filter(
      (item) => item.contentType === FORM_TYPE && item.apiName === sourceApiName,
    );
    if (matches.length !== 1)
      throw new TypeError(`Source apiName must match exactly one Form: ${sourceApiName}`);
    if (
      sourceApiNames.has(targetApiName) ||
      sourceTitles.has(targetTitle) ||
      sourceUrls.has(targetUrlName) ||
      targetApiNames.has(targetApiName) ||
      targetTitles.has(targetTitle) ||
      targetUrls.has(targetUrlName)
    ) {
      throw new TypeError('Target Form apiName, title, and urlName must be fresh and unique');
    }
    const item = matches[0];
    classifyFormDependencies(item);
    const generatedBody = regenerateBlockIds(
      structuredClone(item.contentBody),
      generateId,
      sourceBlockIds,
      generatedBlockIds,
    );
    if (!record(generatedBody)) throw new TypeError('Generated Form body must be an object');
    if (TITLE_KEY in generatedBody) generatedBody[TITLE_KEY] = targetTitle;
    const contentBody = generatedBody as WorkspaceImportItem['contentBody'];
    const planned = {
      ...structuredClone(item),
      apiName: targetApiName,
      title: targetTitle,
      urlName: targetUrlName,
      contentBody,
    } as WorkspaceImportItem;
    classifyFormDependencies(planned);
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
 * Build the strict Form CREATE payload, intentionally dropping source content-key provenance.
 * @param {WorkspaceImportItem} item - Planned Form item retaining source provenance.
 * @param {string} contentSpaceOrFolderId - Exact destination root folder ID.
 * @returns {FormCreatePayload} Create payload without source contentKey; body semantics remain intact.
 */
export function formCreatePayload(
  item: WorkspaceImportItem,
  contentSpaceOrFolderId: string,
): FormCreatePayload {
  classifyFormDependencies(item);
  if (item.apiName === undefined || item.urlName === undefined) {
    throw new TypeError('Form CREATE requires apiName and urlName');
  }
  identifier(contentSpaceOrFolderId, 'Form destination root folder ID');
  return {
    apiName: item.apiName,
    contentBody: structuredClone(item.contentBody),
    contentSpaceOrFolderId,
    contentType: FORM_TYPE,
    title: item.title,
    urlName: item.urlName,
  };
}

/**
 * Compare content and variant readback envelopes against one exact planned Form result.
 * @param {unknown} content - Returned content-detail envelope.
 * @param {unknown} variant - Returned variant-detail envelope.
 * @param {FormReadbackExpectation} expected - Target workspace, identities, returned IDs, and exact semantics.
 * @returns {FormNormalization} The normalized content result when both envelopes match exactly.
 */
export function assertFormReadback(
  content: unknown,
  variant: unknown,
  expected: FormReadbackExpectation,
): FormNormalization {
  const normalizedContent = normalizeForm(content);
  const normalizedVariant = normalizeForm(variant);
  if (normalizedContent === null || normalizedVariant === null) {
    throw new TypeError('Form readback must contain exact Draft content and variant envelopes');
  }
  for (const normalized of [normalizedContent, normalizedVariant]) {
    if (
      normalized.provenance.contentSpaceId !== expected.workspaceId ||
      normalized.provenance.managedContentId !== expected.contentId ||
      normalized.provenance.managedContentVariantId !== expected.variantId ||
      normalized.semantic.apiName !== expected.apiName ||
      normalized.semantic.title !== expected.title ||
      normalized.semantic.urlName !== expected.urlName ||
      !isDeepStrictEqual(normalized.semantic, expected.semantic)
    ) {
      throw new TypeError(
        'Form readback identity, workspace, or semantics differ from the planned target',
      );
    }
  }
  if (!isDeepStrictEqual(normalizedContent, normalizedVariant)) {
    throw new TypeError('Form content and variant readback envelopes must normalize identically');
  }
  return normalizedContent;
}
