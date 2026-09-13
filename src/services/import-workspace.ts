import type { Connection } from '@salesforce/core';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, readdir, realpath, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import type { JsonRequestOptions } from '../transport/json-request.js';
import { CmsRequestError } from '../transport/json-request.js';
import type { WorkspaceExportManifest, WorkspaceExportWarning } from './export-workspace.js';
import { getContent } from './read.js';
import {
  createContent,
  createVariant,
  type CreateContentInput,
  type CreateVariantInput,
} from './write.js';

type RequestConnection = Pick<Connection, 'request'>;
type JsonObject = { readonly [key: string]: JsonValue };
type JsonValue = boolean | JsonObject | readonly JsonValue[] | null | number | string;

export type WorkspaceImportItem = JsonObject & {
  readonly apiName?: string;
  readonly contentBody: JsonObject;
  readonly contentKey: string;
  readonly contentSpace: JsonObject & { readonly id: string };
  readonly contentType: string;
  readonly externalId?: string;
  readonly externalSource?: JsonObject;
  readonly id: string;
  readonly language: string;
  readonly title: string;
  readonly urlName?: string;
};

export type LoadedWorkspaceExport = {
  readonly isPartial: boolean;
  readonly items: readonly WorkspaceImportItem[];
  readonly manifest: WorkspaceExportManifest;
  readonly manifestSha256: string;
  readonly sourceDirectory: string;
};

export type DestinationWorkspace = JsonObject & {
  readonly defaultLanguage: string;
  readonly id: string;
  readonly rootFolderId: string;
};

export type WorkspaceImportGroupPlan = {
  readonly contentKey: string;
  readonly primary: WorkspaceImportItem;
  readonly variants: readonly WorkspaceImportItem[];
};

export type WorkspaceImportPlan = {
  readonly destinationWorkspaceId: string;
  readonly groups: readonly WorkspaceImportGroupPlan[];
  readonly rootFolderId: string;
  readonly source: LoadedWorkspaceExport;
};

export type CreatedParentRecord = {
  readonly childVariantIds: string[];
  readonly contentId: string;
  readonly contentKey: string;
  readonly primaryVariantId: string;
};

export type WorkspaceImportOperation = {
  readonly contentKey: string;
  readonly destinationOrgId: string;
  readonly destinationWorkspaceId: string;
  readonly language: string;
  readonly operationId: string;
  readonly operationKind: 'create-parent' | 'create-child';
  readonly requestIdentity: string;
  readonly requestSha256: string;
  readonly runId: string;
  error?: string;
  result?: {
    readonly contentId?: string;
    readonly primaryVariantId?: string;
    readonly variantId?: string;
  };
  state: 'pending' | 'succeeded' | 'failed';
};

export type WorkspaceImportRunReport = {
  readonly createdParents: CreatedParentRecord[];
  readonly destinationOrgId: string;
  readonly destinationWorkspaceId: string;
  readonly operations: WorkspaceImportOperation[];
  readonly runId: string;
  readonly sourceDirectory: string;
  readonly sourceManifestSha256: string;
  state: 'applying' | 'completed' | 'failed' | 'ownership-uncertain';
};

export class WorkspaceImportOwnershipUncertainError extends Error {
  public readonly operation: WorkspaceImportOperation;
  public readonly state = 'ownership-uncertain' as const;

  public constructor(operation: WorkspaceImportOperation, cause: unknown) {
    super(
      `CMS mutation may have succeeded, but its result could not be persisted for ${operation.contentKey}/${operation.language}; reconcile operation ${operation.operationId} before any new apply`,
      { cause },
    );
    this.name = 'WorkspaceImportOwnershipUncertainError';
    this.operation = operation;
  }
}

export type WorkspaceImportReportPersistence = {
  readonly rewrite: (file: string, report: WorkspaceImportRunReport) => Promise<void>;
};

export type ExecuteWorkspaceImportOptions = {
  readonly allowPartial?: boolean;
  readonly connection: RequestConnection;
  readonly destinationOrgId: string;
  readonly destinationWorkspace: unknown;
  readonly dryRun?: boolean;
  readonly reportDirectory?: string;
  readonly reportPersistence?: WorkspaceImportReportPersistence;
  readonly requestOptions?: JsonRequestOptions;
  readonly sourceDirectory: string;
  readonly workspaceId: string;
};

export type WorkspaceImportResult = {
  readonly dryRun: boolean;
  readonly plan: WorkspaceImportPlan;
  readonly report?: WorkspaceImportRunReport;
  readonly reportFile?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonemptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function integerAtLeastZero(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function assertJsonSafe(value: unknown, label: string): asserts value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (Array.isArray(value)) {
    for (const item of value) assertJsonSafe(item, label);
    return;
  }
  if (isRecord(value)) {
    for (const item of Object.values(value)) assertJsonSafe(item, label);
    return;
  }
  throw new TypeError(`${label} must be JSON-safe`);
}

function assertPlainObject(value: unknown, label: string): asserts value is JsonObject {
  if (!isRecord(value)) throw new TypeError(`${label} must be an object`);
  assertJsonSafe(value, label);
}

function assertIdentifier(value: unknown, label: string): asserts value is string {
  if (!nonemptyString(value)) throw new TypeError(`${label} must be a nonempty string`);
  if (value.includes('/') || value.includes('\\')) {
    throw new TypeError(`${label} must not contain path separators`);
  }
}

function assertOptionalString(record: Record<string, unknown>, key: string, label: string): void {
  if (record[key] !== undefined && !nonemptyString(record[key])) {
    throw new TypeError(`${label}.${key} must be a nonempty string when present`);
  }
}

function parseJson(bytes: string, label: string): unknown {
  try {
    return JSON.parse(bytes) as unknown;
  } catch {
    throw new TypeError(`${label} must contain valid JSON`);
  }
}

function validateWarning(value: unknown, index: number): WorkspaceExportWarning {
  if (!isRecord(value) || !nonemptyString(value.code) || !nonemptyString(value.message)) {
    throw new TypeError(`manifest.warnings[${index}] is malformed`);
  }
  const codes = new Set([
    'COUNT_MISMATCH',
    'DETAIL_FAILED',
    'DUPLICATE_VARIANTS',
    'OWNERSHIP_MISMATCH',
    'PREMATURE_EMPTY_PAGE',
    'UNSUPPORTED_WILDCARD',
  ]);
  if (!codes.has(value.code))
    throw new TypeError(`manifest.warnings[${index}].code is unsupported`);
  if (
    value.variantIds !== undefined &&
    (!Array.isArray(value.variantIds) || !value.variantIds.every(nonemptyString))
  ) {
    throw new TypeError(`manifest.warnings[${index}].variantIds is malformed`);
  }
  return value as WorkspaceExportWarning;
}

function validateManifest(value: unknown): WorkspaceExportManifest {
  if (!isRecord(value)) throw new TypeError('manifest.json must contain an object');
  if (value.schemaVersion !== 1)
    throw new TypeError('Only workspace export schemaVersion 1 is supported');
  if (value.mode !== 'experimental-best-effort') {
    throw new TypeError('Only experimental-best-effort workspace exports are supported');
  }
  assertIdentifier(value.workspaceId, 'manifest.workspaceId');
  for (const key of ['expectedCount', 'foundCount', 'exportedCount', 'pagesRequested']) {
    if (!integerAtLeastZero(value[key])) throw new TypeError(`manifest.${key} is malformed`);
  }
  if (!isRecord(value.search)) throw new TypeError('manifest.search is malformed');
  const search = value.search;
  if (
    !Array.isArray(search.contentSpaceOrFolderIds) ||
    search.contentSpaceOrFolderIds.length !== 1 ||
    search.contentSpaceOrFolderIds[0] !== value.workspaceId ||
    !Array.isArray(search.languages) ||
    search.languages.length !== 1 ||
    search.languages[0] !== 'All' ||
    search.pageSize !== 250 ||
    search.queryTerm !== '*'
  ) {
    throw new TypeError('manifest.search does not match the schemaVersion 1 export contract');
  }
  if (!Array.isArray(value.entries)) throw new TypeError('manifest.entries must be an array');
  if (!Array.isArray(value.rejectedVariantIds) || !value.rejectedVariantIds.every(nonemptyString)) {
    throw new TypeError('manifest.rejectedVariantIds is malformed');
  }
  if (!Array.isArray(value.failedVariantIds) || !value.failedVariantIds.every(nonemptyString)) {
    throw new TypeError('manifest.failedVariantIds is malformed');
  }
  if (!Array.isArray(value.warnings)) throw new TypeError('manifest.warnings must be an array');
  for (const [index, warning] of value.warnings.entries()) validateWarning(warning, index);
  return value as unknown as WorkspaceExportManifest;
}

function safeEntryPath(sourceDirectory: string, file: unknown, variantId: string): string {
  if (!nonemptyString(file)) throw new TypeError(`Manifest entry ${variantId} has no file`);
  if (path.isAbsolute(file) || file.includes('\\')) {
    throw new TypeError(`Manifest entry ${variantId} has an unsafe file path`);
  }
  const segments = file.split('/');
  if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) {
    throw new TypeError(`Manifest entry ${variantId} has an unsafe file path`);
  }
  if (segments.length !== 2 || segments[0] !== 'items' || segments[1] !== `${variantId}.json`) {
    throw new TypeError(`Manifest entry ${variantId} has a substituted file mapping`);
  }
  return path.join(sourceDirectory, ...segments);
}

async function assertRegularFile(file: string, label: string): Promise<void> {
  let metadata;
  try {
    metadata = await lstat(file);
  } catch (error) {
    if (isRecord(error) && error.code === 'ENOENT') {
      throw new TypeError(`${label} is missing`, { cause: error });
    }
    throw error;
  }
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new TypeError(`${label} must be a regular file and not a symlink or reparse point`);
  }
}

async function readStableRegularFile(file: string, label: string): Promise<string> {
  await assertRegularFile(file, label);
  const before = await lstat(file);
  const bytes = await readFile(file, 'utf8');
  const after = await lstat(file);
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ino !== after.ino) {
    throw new TypeError(`${label} changed while it was being loaded`);
  }
  return bytes;
}

function validateItem(value: unknown, variantId: string, workspaceId: string): WorkspaceImportItem {
  if (!isRecord(value)) throw new TypeError(`Item ${variantId} must contain an object`);
  assertIdentifier(value.id, `Item ${variantId}.id`);
  if (value.id !== variantId)
    throw new TypeError(`Item ${variantId} does not match its manifest variant ID`);
  for (const key of ['contentKey', 'language', 'contentType', 'title']) {
    if (!nonemptyString(value[key])) throw new TypeError(`Item ${variantId}.${key} is required`);
  }
  const contentType = value.contentType;
  if (
    !nonemptyString(contentType) ||
    !/^[A-Za-z][A-Za-z\d_]*__[A-Za-z][A-Za-z\d_]*$/u.test(contentType)
  ) {
    throw new TypeError(`Item ${variantId}.contentType must be a fully qualified API name`);
  }
  assertOptionalString(value, 'apiName', `Item ${variantId}`);
  assertOptionalString(value, 'externalId', `Item ${variantId}`);
  assertOptionalString(value, 'urlName', `Item ${variantId}`);
  assertPlainObject(value.contentBody, `Item ${variantId}.contentBody`);
  if (value.externalSource !== undefined) {
    assertPlainObject(value.externalSource, `Item ${variantId}.externalSource`);
  }
  if (!isRecord(value.contentSpace) || value.contentSpace.id !== workspaceId) {
    throw new TypeError(`Item ${variantId} belongs to a different source contentSpace`);
  }
  assertJsonSafe(value, `Item ${variantId}`);
  return value as WorkspaceImportItem;
}

function partialFromManifest(manifest: WorkspaceExportManifest): boolean {
  const partialWarningCodes = new Set([
    'COUNT_MISMATCH',
    'DETAIL_FAILED',
    'DUPLICATE_VARIANTS',
    'OWNERSHIP_MISMATCH',
    'PREMATURE_EMPTY_PAGE',
  ]);
  return (
    manifest.failedVariantIds.length > 0 ||
    manifest.rejectedVariantIds.length > 0 ||
    manifest.exportedCount !== manifest.expectedCount ||
    manifest.warnings.some(({ code }) => partialWarningCodes.has(code))
  );
}

function validateRelationships(items: readonly WorkspaceImportItem[]): void {
  const pairIds = new Map<string, string>();
  const keyToApiName = new Map<string, string>();
  const apiNameToKey = new Map<string, string>();
  for (const item of items) {
    const pair = `${item.contentKey}\u0000${item.language}`;
    if (pairIds.has(pair)) {
      throw new TypeError(
        `Duplicate contentKey/language mapping: ${item.contentKey}/${item.language}`,
      );
    }
    pairIds.set(pair, item.id);
    if (item.apiName === undefined) continue;
    const priorApiName = keyToApiName.get(item.contentKey);
    if (priorApiName !== undefined && priorApiName !== item.apiName) {
      throw new TypeError(`Content key ${item.contentKey} has conflicting apiName values`);
    }
    const priorKey = apiNameToKey.get(item.apiName);
    if (priorKey !== undefined && priorKey !== item.contentKey) {
      throw new TypeError(`apiName ${item.apiName} maps to conflicting content keys`);
    }
    keyToApiName.set(item.contentKey, item.apiName);
    apiNameToKey.set(item.apiName, item.contentKey);
  }
}

export async function loadWorkspaceExport(
  sourceDirectory: string,
  options: { readonly allowPartial?: boolean } = {},
): Promise<LoadedWorkspaceExport> {
  if (!nonemptyString(sourceDirectory))
    throw new TypeError('sourceDirectory must be a nonempty string');
  const sourceMetadata = await lstat(sourceDirectory);
  if (sourceMetadata.isSymbolicLink() || !sourceMetadata.isDirectory()) {
    throw new TypeError('sourceDirectory must be a directory and not a symlink or reparse point');
  }
  const canonicalSource = await realpath(sourceDirectory);
  const manifestFile = path.join(canonicalSource, 'manifest.json');
  const manifestBytes = await readStableRegularFile(manifestFile, 'manifest.json');
  const manifest = validateManifest(parseJson(manifestBytes, 'manifest.json'));
  const seenFiles = new Set<string>();
  const seenIds = new Set<string>();
  const items: WorkspaceImportItem[] = [];
  for (const [index, entry] of manifest.entries.entries()) {
    if (!isRecord(entry)) throw new TypeError(`manifest.entries[${index}] is malformed`);
    assertIdentifier(entry.variantId, `manifest.entries[${index}].variantId`);
    const itemFile = safeEntryPath(canonicalSource, entry.file, entry.variantId);
    const normalized = path.normalize(itemFile);
    if (!normalized.startsWith(`${canonicalSource}${path.sep}`)) {
      throw new TypeError(`Manifest entry ${entry.variantId} escapes the source directory`);
    }
    if (seenIds.has(entry.variantId) || seenFiles.has(normalized)) {
      throw new TypeError(`Duplicate manifest mapping for ${entry.variantId}`);
    }
    seenIds.add(entry.variantId);
    seenFiles.add(normalized);
    const itemBytes = await readStableRegularFile(itemFile, `Item file for ${entry.variantId}`);
    items.push(
      validateItem(
        parseJson(itemBytes, `Item file for ${entry.variantId}`),
        entry.variantId,
        manifest.workspaceId,
      ),
    );
  }
  if (manifest.exportedCount !== manifest.entries.length) {
    throw new TypeError('manifest.exportedCount does not match manifest.entries.length');
  }
  const itemDirectory = path.join(canonicalSource, 'items');
  const itemDirectoryMetadata = await lstat(itemDirectory);
  if (itemDirectoryMetadata.isSymbolicLink() || !itemDirectoryMetadata.isDirectory()) {
    throw new TypeError('items must be a directory and not a symlink or reparse point');
  }
  const directoryEntries = await readdir(itemDirectory);
  const actualFiles = directoryEntries.toSorted();
  const expectedFiles = manifest.entries.map(({ variantId }) => `${variantId}.json`).toSorted();
  if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) {
    throw new TypeError('items directory contains missing or substituted files');
  }
  validateRelationships(items);
  const isPartial = partialFromManifest(manifest);
  if (isPartial && options.allowPartial !== true) {
    throw new TypeError(
      'Workspace export is partial; pass allowPartial only to accept recorded omissions',
    );
  }
  return {
    isPartial,
    items,
    manifest,
    manifestSha256: createHash('sha256').update(manifestBytes).digest('hex'),
    sourceDirectory: canonicalSource,
  };
}

function destinationWorkspace(value: unknown, expectedId: string): DestinationWorkspace {
  if (!isRecord(value)) throw new TypeError('Destination workspace must be an object');
  if (value.id !== expectedId) {
    throw new TypeError(`Destination workspace ID must exactly match ${expectedId}`);
  }
  if (!nonemptyString(value.defaultLanguage)) {
    throw new TypeError('Destination workspace defaultLanguage must be a nonempty string');
  }
  if (!nonemptyString(value.rootFolderId)) {
    throw new TypeError('Destination workspace rootFolderId must be a nonempty string');
  }
  assertIdentifier(value.rootFolderId, 'Destination workspace rootFolderId');
  assertJsonSafe(value, 'Destination workspace');
  return value as DestinationWorkspace;
}

export function planWorkspaceImport(
  source: LoadedWorkspaceExport,
  workspace: unknown,
  expectedWorkspaceId: string,
): WorkspaceImportPlan {
  assertIdentifier(expectedWorkspaceId, 'workspaceId');
  const destination = destinationWorkspace(workspace, expectedWorkspaceId);
  const grouped = new Map<string, WorkspaceImportItem[]>();
  for (const item of source.items) {
    const group = grouped.get(item.contentKey) ?? [];
    group.push(item);
    grouped.set(item.contentKey, group);
  }
  const groups = [...grouped.entries()]
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([contentKey, items]) => {
      const primaries = items.filter(({ language }) => language === destination.defaultLanguage);
      if (primaries.length !== 1) {
        throw new TypeError(
          `Content key ${contentKey} must have exactly one ${destination.defaultLanguage} primary variant`,
        );
      }
      const primary = primaries[0];
      return {
        contentKey,
        primary,
        variants: items
          .filter(({ id }) => id !== primary.id)
          .toSorted((left, right) => left.language.localeCompare(right.language)),
      };
    });
  return {
    destinationWorkspaceId: destination.id,
    groups,
    rootFolderId: destination.rootFolderId,
    source,
  };
}

function createPayload(group: WorkspaceImportGroupPlan, rootFolderId: string): CreateContentInput {
  const item = group.primary;
  const payload: CreateContentInput = {
    contentBody: item.contentBody,
    contentKey: item.contentKey,
    contentSpaceOrFolderId: rootFolderId,
    contentType: item.contentType,
    title: item.title,
  };
  if (item.apiName !== undefined) payload.apiName = item.apiName;
  if (item.urlName !== undefined) payload.urlName = item.urlName;
  if (item.externalId !== undefined) payload.externalId = item.externalId;
  if (item.externalSource !== undefined) payload.externalSource = item.externalSource;
  return payload;
}

function variantPayload(item: WorkspaceImportItem, contentKey: string): CreateVariantInput {
  const payload: CreateVariantInput = {
    contentBody: item.contentBody,
    language: item.language,
    managedContentKeyOrId: contentKey,
    title: item.title,
  };
  if (item.urlName !== undefined) payload.urlName = item.urlName;
  return payload;
}

function isProvenNotFound(error: unknown): boolean {
  return (
    error instanceof CmsRequestError && error.operationKey === 'content.get' && error.status === 404
  );
}

async function preflightConflicts(
  connection: RequestConnection,
  plan: WorkspaceImportPlan,
  requestOptions: JsonRequestOptions,
): Promise<void> {
  for (const group of plan.groups) {
    try {
      await getContent(connection, group.contentKey, {}, requestOptions);
      throw new Error(`Content key ${group.contentKey} already exists`);
    } catch (error) {
      if (isProvenNotFound(error)) continue;
      throw error;
    }
  }
}

function jsonBytes(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function writeExclusive(file: string, value: unknown): Promise<void> {
  const handle = await open(file, 'wx');
  try {
    await handle.writeFile(jsonBytes(value), 'utf8');
  } finally {
    await handle.close();
  }
}

async function rewriteAtomic(file: string, value: unknown): Promise<void> {
  const temporary = `${file}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeExclusive(temporary, value);
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

function responseIdentifier(
  record: Record<string, unknown>,
  keys: readonly string[],
  label: string,
): string {
  for (const key of keys) {
    if (nonemptyString(record[key])) return record[key];
  }
  throw new TypeError(`Create response is missing ${label}`);
}

function validateParentResponse(
  response: Record<string, unknown>,
  expectedContentKey: string,
): CreatedParentRecord {
  const contentKey = responseIdentifier(response, ['contentKey'], 'contentKey');
  if (contentKey !== expectedContentKey) {
    throw new TypeError(`Create response contentKey does not match ${expectedContentKey}`);
  }
  return {
    childVariantIds: [],
    contentId: responseIdentifier(response, ['id', 'contentId', 'managedContentId'], 'content ID'),
    contentKey,
    primaryVariantId: responseIdentifier(
      response,
      ['primaryVariantId', 'managedContentVariantId', 'variantId'],
      'primary variant ID',
    ),
  };
}

function validateChildResponse(response: Record<string, unknown>): string {
  return responseIdentifier(response, ['id', 'variantId', 'managedContentVariantId'], 'variant ID');
}

function operationIdentity(
  runId: string,
  kind: WorkspaceImportOperation['operationKind'],
  contentKey: string,
  language: string,
  payload: CreateContentInput | CreateVariantInput,
): Pick<WorkspaceImportOperation, 'operationId' | 'requestIdentity' | 'requestSha256'> {
  assertJsonSafe(payload, 'Mutation payload');
  const requestIdentity = `${kind}\u0000${contentKey}\u0000${language}\u0000${JSON.stringify(payload)}`;
  const requestSha256 = createHash('sha256').update(requestIdentity).digest('hex');
  return {
    operationId: createHash('sha256').update(`${runId}\u0000${requestSha256}`).digest('hex'),
    requestIdentity,
    requestSha256,
  };
}

function pendingOperation(
  report: WorkspaceImportRunReport,
  kind: WorkspaceImportOperation['operationKind'],
  contentKey: string,
  language: string,
  payload: CreateContentInput | CreateVariantInput,
): WorkspaceImportOperation {
  return {
    contentKey,
    destinationOrgId: report.destinationOrgId,
    destinationWorkspaceId: report.destinationWorkspaceId,
    language,
    operationKind: kind,
    runId: report.runId,
    state: 'pending',
    ...operationIdentity(report.runId, kind, contentKey, language, payload),
  };
}

async function persistOperationResult(
  reportFile: string,
  report: WorkspaceImportRunReport,
  operation: WorkspaceImportOperation,
  rewrite: WorkspaceImportReportPersistence['rewrite'],
): Promise<void> {
  try {
    await rewrite(reportFile, report);
  } catch (error) {
    operation.state = 'pending';
    delete operation.result;
    report.state = 'ownership-uncertain';
    try {
      await rewrite(reportFile, report);
    } catch {
      // The durable pending intent remains the manual-reconciliation source of truth.
    }
    throw new WorkspaceImportOwnershipUncertainError(operation, error);
  }
}

export async function executeWorkspaceImport(
  options: ExecuteWorkspaceImportOptions,
): Promise<WorkspaceImportResult> {
  if (!nonemptyString(options.destinationOrgId)) {
    throw new TypeError('destinationOrgId must be the nonempty destination org ID');
  }
  const source = await loadWorkspaceExport(options.sourceDirectory, {
    allowPartial: options.allowPartial,
  });
  const plan = planWorkspaceImport(source, options.destinationWorkspace, options.workspaceId);
  const requestOptions = options.requestOptions ?? {};
  await preflightConflicts(options.connection, plan, requestOptions);
  if (options.dryRun === true) return { dryRun: true, plan };
  if (!nonemptyString(options.reportDirectory)) {
    throw new TypeError('reportDirectory is required for an applied import');
  }
  const reportDirectory = path.resolve(options.reportDirectory);
  await mkdir(reportDirectory);
  const reportFile = path.join(reportDirectory, 'workspace-import-run.json');
  const report: WorkspaceImportRunReport = {
    createdParents: [],
    destinationOrgId: options.destinationOrgId,
    destinationWorkspaceId: plan.destinationWorkspaceId,
    operations: [],
    runId: randomUUID(),
    sourceDirectory: source.sourceDirectory,
    sourceManifestSha256: source.manifestSha256,
    state: 'applying',
  };
  const rewrite = options.reportPersistence?.rewrite ?? rewriteAtomic;
  await writeExclusive(reportFile, report);
  try {
    for (const group of plan.groups) {
      const parentPayload = createPayload(group, plan.rootFolderId);
      const parentOperation = pendingOperation(
        report,
        'create-parent',
        group.contentKey,
        group.primary.language,
        parentPayload,
      );
      report.operations.push(parentOperation);
      await rewrite(reportFile, report);
      let parentResponse: Record<string, unknown>;
      try {
        parentResponse = await createContent(options.connection, parentPayload, requestOptions);
      } catch (error) {
        parentOperation.state = 'failed';
        parentOperation.error = error instanceof Error ? error.message : String(error);
        try {
          await rewrite(reportFile, report);
        } catch {
          // Preserve the mutation error when recording its failure is unavailable.
        }
        throw error;
      }
      const created = validateParentResponse(parentResponse, group.contentKey);
      report.createdParents.push(created);
      parentOperation.state = 'succeeded';
      parentOperation.result = {
        contentId: created.contentId,
        primaryVariantId: created.primaryVariantId,
      };
      await persistOperationResult(reportFile, report, parentOperation, rewrite);
      for (const variant of group.variants) {
        const childPayload = variantPayload(variant, group.contentKey);
        const childOperation = pendingOperation(
          report,
          'create-child',
          group.contentKey,
          variant.language,
          childPayload,
        );
        report.operations.push(childOperation);
        await rewrite(reportFile, report);
        let childResponse: Record<string, unknown>;
        try {
          childResponse = await createVariant(options.connection, childPayload, requestOptions);
        } catch (error) {
          childOperation.state = 'failed';
          childOperation.error = error instanceof Error ? error.message : String(error);
          try {
            await rewrite(reportFile, report);
          } catch {
            // Preserve the mutation error when recording its failure is unavailable.
          }
          throw error;
        }
        const childVariantId = validateChildResponse(childResponse);
        created.childVariantIds.push(childVariantId);
        childOperation.state = 'succeeded';
        childOperation.result = { variantId: childVariantId };
        await persistOperationResult(reportFile, report, childOperation, rewrite);
      }
    }
    report.state = 'completed';
    await rewrite(reportFile, report);
  } catch (error) {
    if (!(error instanceof WorkspaceImportOwnershipUncertainError)) report.state = 'failed';
    try {
      await rewrite(reportFile, report);
    } catch {
      // Preserve the primary error; the last durable report is the source of truth.
    }
    throw error;
  }
  return { dryRun: false, plan, report, reportFile };
}
