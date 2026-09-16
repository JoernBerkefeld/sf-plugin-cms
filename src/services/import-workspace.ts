import type { Connection } from '@salesforce/core';
import type { CmsDiagnostic } from '../contracts/shared.js';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import type { JsonRequestOptions } from '../transport/json-request.js';
import {
  cleanupOwnedPath,
  replaceFileByAtomicRename,
  type AtomicPublishOptions,
  type CleanupOptions,
} from './atomic-publish.js';
import { CmsRequestError } from '../transport/json-request.js';
import {
  assertWorkspaceExportManifest,
  type WorkspaceExportManifest,
} from '../contracts/workspace-export.js';
import type {
  WorkspaceImportMapping,
  WorkspaceImportReference,
  WorkspaceImportResult as WorkspaceImportContractResult,
} from '../contracts/workspace-import.js';
import { getContent, type CmsRecord } from './read.js';
import { variantIdentity } from './variant-identity.js';
import { inventoryExportReferences } from './export-references.js';
import { planImportIdentities, planNativeCopies } from './import-identities.js';
import { loadEditableRawHtml, type EditableHtmlEvidence } from './editable-raw-html-import.js';
import { isDeepStrictEqual } from 'node:util';
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
  readonly integrity: WorkspaceImportContractResult['integrity'];
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
    readonly contentKey?: string;
    readonly primaryVariantId?: string;
    readonly variantId?: string;
  };
  state: 'pending' | 'succeeded' | 'failed';
};

export type WorkspaceImportRunReport = {
  readonly editableSource?: EditableHtmlEvidence;
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
  readonly editableDirectory?: string;
  readonly loadedSource?: LoadedWorkspaceExport;
  readonly identityMappings?: unknown;
  readonly nativeCopyMappings?: unknown;
  readonly reportDirectory?: string;
  readonly reportPersistence?: WorkspaceImportReportPersistence;
  readonly requestOptions?: JsonRequestOptions;
  readonly sourceDirectory: string;
  readonly workspaceId: string;
};

export type WorkspaceImportExecutionResult = {
  readonly diagnostics: CmsDiagnostic[];
  readonly contractResult: WorkspaceImportContractResult;
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

function parseJson(bytes: Buffer | string, label: string): unknown {
  try {
    return JSON.parse(bytes.toString()) as unknown;
  } catch {
    throw new TypeError(`${label} must contain valid JSON`);
  }
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

/**
 * Read a regular file while detecting observed replacement or modification.
 * @param {string} file - Absolute file path.
 * @param {string} label - Error context.
 * @returns {Promise<Buffer>} Original file bytes.
 */
export async function readStableRegularFile(file: string, label: string): Promise<Buffer> {
  await assertRegularFile(file, label);
  const before = await lstat(file);
  const bytes = await readFile(file);
  const after = await lstat(file);
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ino !== after.ino) {
    throw new TypeError(`${label} changed while it was being loaded`);
  }
  return bytes;
}

/**
 * Enumerate regular package files without following symlinks.
 * @param {string} directory - Directory to inspect.
 * @param {string} packageRoot - Root for relative paths.
 * @returns {Promise<string[]>} Sorted portable relative filenames.
 */
export async function enumeratePackageFiles(
  directory: string,
  packageRoot: string,
): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    const metadata = await lstat(absolute);
    if (metadata.isSymbolicLink()) {
      throw new TypeError('Workspace package must not contain symlinks or reparse points');
    }
    if (metadata.isDirectory()) {
      files.push(...(await enumeratePackageFiles(absolute, packageRoot)));
    } else if (metadata.isFile()) {
      files.push(path.relative(packageRoot, absolute).split(path.sep).join('/'));
    } else {
      throw new TypeError('Workspace package must contain only regular files and directories');
    }
  }
  return files.toSorted();
}

function validateItem(raw: unknown, variantId: string, workspaceId: string): WorkspaceImportItem {
  if (!isRecord(raw)) throw new TypeError(`Item ${variantId} must contain an object`);
  const identity = variantIdentity(raw, variantId);
  assertIdentifier(identity.variantId, `Item ${variantId}.id`);
  // Normalize only the in-memory import view after raw-byte integrity verification.
  const normalized: Record<string, unknown> = { ...raw, id: identity.variantId };
  if (isRecord(normalized.contentType)) {
    if (
      Object.keys(normalized.contentType).some(
        (key) => key !== 'fullyQualifiedName' && key !== 'name',
      )
    ) {
      throw new TypeError(`Item ${variantId}.contentType contains unsupported summary fields`);
    }
    normalized.contentType = normalized.contentType.fullyQualifiedName;
  }
  if (normalized.externalId === null) delete normalized.externalId;
  if (normalized.externalSource === null) delete normalized.externalSource;
  const value = normalized;
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
  return manifest.completeness === 'partial';
}

function validateRelationships(items: readonly WorkspaceImportItem[]): void {
  const pairIds = new Map<string, string>();
  const keyToApiName = new Map<string, string>();
  const apiNameToKey = new Map<string, string>();
  const contentIdToKey = new Map<string, string>();
  const keyToContentId = new Map<string, string>();
  for (const item of items) {
    const { contentId } = variantIdentity(item, item.id);
    if (contentId !== undefined) {
      const priorKey = contentIdToKey.get(contentId);
      const priorId = keyToContentId.get(item.contentKey);
      if (
        (priorKey !== undefined && priorKey !== item.contentKey) ||
        (priorId !== undefined && priorId !== contentId)
      ) {
        throw new TypeError('Content keys have conflicting parent content identities');
      }
      contentIdToKey.set(contentId, item.contentKey);
      keyToContentId.set(item.contentKey, contentId);
    }
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
  const manifestValue = parseJson(manifestBytes, 'manifest.json');
  assertWorkspaceExportManifest(manifestValue);
  const manifest = manifestValue;
  const packageFiles = await enumeratePackageFiles(canonicalSource, canonicalSource);
  const expectedFiles = [
    'manifest.json',
    ...manifest.items.map(({ path: itemPath }) => itemPath),
  ].toSorted();
  if (JSON.stringify(packageFiles) !== JSON.stringify(expectedFiles)) {
    throw new TypeError(
      'Workspace package contains missing, substituted, or unlisted regular files',
    );
  }
  const manifestItems = new Map(manifest.items.map((item_) => [item_.path, item_]));
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
    const declaredItem = manifestItems.get(entry.file);
    if (declaredItem === undefined || declaredItem.kind !== 'cms.content') {
      throw new TypeError(`Manifest entry ${entry.variantId} has no matching CMS content item`);
    }
    const itemBytes = await readStableRegularFile(itemFile, `Item file for ${entry.variantId}`);
    const actualSha256 = createHash('sha256').update(itemBytes).digest('hex');
    if (actualSha256 !== declaredItem.sha256) {
      throw new TypeError(`Item file for ${entry.variantId} failed SHA-256 verification`);
    }
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
  validateRelationships(items);
  const isPartial = partialFromManifest(manifest);
  if (isPartial && options.allowPartial !== true) {
    throw new TypeError(
      'Workspace export is partial; pass allowPartial only to accept recorded omissions',
    );
  }
  return {
    integrity: {
      listedItemCount: manifest.items.length,
      verifiedItemCount: manifest.items.length,
      unlistedFileCount: 0,
      verified: true,
    },
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

function rewriteCmsContentBodyReferences(
  value: JsonValue,
  replacements: ReadonlyMap<string, string>,
): JsonValue {
  if (Array.isArray(value)) {
    return value.map((item_) => rewriteCmsContentBodyReferences(item_, replacements));
  }
  if (!isRecord(value)) return value;

  return Object.fromEntries(
    Object.entries(value).map(([key, item_]) => {
      if (key === 'ref' && isRecord(item_) && nonemptyString(item_.contentKey)) {
        const replacement = replacements.get(item_.contentKey);
        return [key, replacement === undefined ? item_ : { ...item_, contentKey: replacement }];
      }
      return [key, rewriteCmsContentBodyReferences(item_ as JsonValue, replacements)];
    }),
  );
}

function rewriteItem(
  item: WorkspaceImportItem,
  replacements: ReadonlyMap<string, string>,
): WorkspaceImportItem {
  return {
    ...item,
    contentBody: rewriteCmsContentBodyReferences(item.contentBody, replacements) as JsonObject,
  };
}

function cmsContentBodyReferenceKeys(
  value: JsonValue,
  sourceValues: ReadonlySet<string>,
): Set<string> {
  const references = new Set<string>();
  if (Array.isArray(value)) {
    for (const item_ of value) {
      for (const key of cmsContentBodyReferenceKeys(item_, sourceValues)) references.add(key);
    }
    return references;
  }
  if (!isRecord(value)) return references;
  if (
    isRecord(value.ref) &&
    nonemptyString(value.ref.contentKey) &&
    sourceValues.has(value.ref.contentKey)
  ) {
    references.add(value.ref.contentKey);
  }
  for (const item_ of Object.values(value)) {
    for (const key of cmsContentBodyReferenceKeys(item_ as JsonValue, sourceValues)) {
      references.add(key);
    }
  }
  return references;
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

function assertTransportableBody(value: JsonValue): void {
  if (Array.isArray(value)) {
    for (const child of value) assertTransportableBody(child);
    return;
  }
  if (!isRecord(value)) return;
  if (
    'ref' in value ||
    value.type === 'file' ||
    (typeof value.type === 'string' && value.type.endsWith('Reference'))
  ) {
    throw new TypeError('Unresolved content reference or media transport; import is blocked');
  }
  for (const child of Object.values(value)) assertTransportableBody(child as JsonValue);
}

function selectedNativeReferences(
  source: LoadedWorkspaceExport,
  selectedItems: readonly WorkspaceImportItem[],
): WorkspaceExportManifest['externalReferences'] {
  const selectedIds = new Set(selectedItems.map(({ id }) => id));
  const inventory = inventoryExportReferences(
    source.manifest.workspaceId,
    // The inventory only reads JSON; its transport type uses mutable array annotations.
    new Map(source.items.map((item) => [item.id, item as CmsRecord])),
  );
  const evidenced = new Map(
    inventory.externalReferences
      .filter(({ kind }) => kind === 'cms.relationship')
      .map((reference) => [reference.referenceId, reference]),
  );
  return source.manifest.externalReferences.filter((reference) => {
    // Only the exporter-proven variant-owned relationship shape can be excluded.
    // Unknown kinds, mismatched identities and contradictory associations fail closed.
    const ownerId = reference.source.sourceId;
    if (
      selectedIds.has(ownerId) ||
      !isDeepStrictEqual(reference, evidenced.get(reference.referenceId))
    )
      return true;
    const ownerEntry = source.manifest.entries.find(({ variantId }) => variantId === ownerId);
    return (
      ownerEntry === undefined ||
      source.manifest.items.some(
        (item) => item.referenceId === reference.referenceId && item.path !== ownerEntry.file,
      )
    );
  });
}

function preflightReferences(
  plan: Pick<WorkspaceImportPlan, 'groups' | 'source'>,
  references = plan.source.manifest.externalReferences,
): void {
  if (
    references.some((reference) => reference.required && reference.resolution !== 'included') ||
    plan.source.manifest.dependencies.length > 0
  ) {
    throw new TypeError('Unresolved required package reference; import is blocked');
  }
  const urls = new Set<string>();
  for (const group of plan.groups) {
    if (new Set([group.primary, ...group.variants].map((item) => item.contentType)).size !== 1) {
      throw new TypeError('Parent variants have conflicting content types');
    }
    for (const item of [group.primary, ...group.variants]) {
      if (
        'references' in item ||
        'referencesList' in item ||
        item.contentType === 'sfdc_cms__image' ||
        item.contentType === 'sfdc_cms__doc'
      ) {
        throw new TypeError('Unresolved content reference or media transport; import is blocked');
      }
      assertTransportableBody(item.contentBody);
      if (item.externalSource !== undefined) assertTransportableBody(item.externalSource);
      const bodyUrl = item.contentBody['sfdc_cms:urlName'];
      if (
        bodyUrl !== undefined &&
        (typeof bodyUrl !== 'string' || (item.urlName !== undefined && item.urlName !== bodyUrl))
      ) {
        throw new TypeError('Conflicting body and variant URL names');
      }
      const url = item.urlName ?? bodyUrl;
      if (typeof url === 'string') {
        if (urls.has(url)) throw new TypeError('Target URL names must be unique across variants');
        urls.add(url);
      }
    }
  }
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

function compareMappingIdentity(
  left: WorkspaceImportMapping | WorkspaceImportReference,
  right: WorkspaceImportMapping | WorkspaceImportReference,
): number {
  return `${left.kind}\u0000${left.referenceId}`.localeCompare(
    `${right.kind}\u0000${right.referenceId}`,
  );
}

function importContractResult(
  source: LoadedWorkspaceExport,
  destinationOrgId: string,
  plan: WorkspaceImportPlan,
  mappings: WorkspaceImportMapping[],
  references: WorkspaceImportReference[],
): WorkspaceImportContractResult {
  return {
    sourcePackage: {
      manifestSha256: source.manifestSha256,
      workspaceId: source.manifest.workspaceId,
    },
    target: {
      orgId: destinationOrgId,
      workspaceId: plan.destinationWorkspaceId,
    },
    integrity: source.integrity,
    mappings: mappings.toSorted(compareMappingIdentity),
    references: references.toSorted(compareMappingIdentity),
  };
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

type AtomicRewriteOptions = AtomicPublishOptions & CleanupOptions;

export async function rewriteAtomic(
  file: string,
  value: unknown,
  options: AtomicRewriteOptions = {},
): Promise<void> {
  const temporary = `${file}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeExclusive(temporary, value);
    await replaceFileByAtomicRename(temporary, file, options);
  } catch (error) {
    await cleanupOwnedPath(temporary, error, options);
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

function verifyNativeCopy(
  response: Record<string, unknown>,
  payload: CreateContentInput,
  created: CreatedParentRecord,
  language: string,
): void {
  const type = isRecord(response.contentType)
    ? response.contentType.fullyQualifiedName
    : response.contentType;
  if (
    response.contentKey !== created.contentKey ||
    responseIdentifier(response, ['managedContentId', 'id'], 'content ID') !== created.contentId ||
    response.apiName !== payload.apiName ||
    response.urlName !== payload.urlName ||
    response.language !== language ||
    response.title !== payload.title ||
    type !== payload.contentType ||
    !isRecord(response.contentSpace) ||
    response.contentSpace.id !== payload.contentSpaceOrFolderId ||
    response.isPublished !== false ||
    !isRecord(response.status) ||
    response.status.status !== 'Draft' ||
    !isRecord(response.contentBody)
  )
    throw new TypeError('Native copy readback identity or draft verification failed');
  for (const [key, value] of Object.entries(payload.contentBody)) {
    // Salesforce entity-encodes raw HTML on retrieval; compare one encoding layer only.
    const encoded =
      key === 'rawHtml' && typeof value === 'string'
        ? value
            .replaceAll('&', '&amp;')
            .replaceAll('<', '&lt;')
            .replaceAll('>', '&gt;')
            .replaceAll('"', '&quot;')
            .replaceAll("'", '&#39;')
        : value;
    if (
      !isDeepStrictEqual(response.contentBody[key], value) &&
      !isDeepStrictEqual(response.contentBody[key], encoded)
    )
      throw new TypeError(`Native copy readback body differs: ${key}`);
  }
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

/**
 * Reconstruct editable HTML before native validation, retaining all original identity inventory.
 * @param {LoadedWorkspaceExport} source - Complete verified original package.
 * @param {unknown} mappings - Native copy selections and fresh identities.
 * @param {string} editableDirectory - Optional verified HTML companion.
 * @returns {Promise<object>} Native proposal and optional all-companion evidence.
 */
export async function planNativeWorkspaceImport(
  source: LoadedWorkspaceExport,
  mappings: unknown,
  editableDirectory?: string,
) {
  if (editableDirectory === undefined) return { proposal: planNativeCopies(source, mappings) };
  const editable = await loadEditableRawHtml(source, editableDirectory);
  const editedById = new Map(editable.items.map((item) => [item.id, item]));
  const proposal = planNativeCopies(
    { ...source, items: source.items.map((item) => editedById.get(item.id) ?? item) },
    mappings,
    editable.literalHtmlVariantIds,
  );
  for (const item of proposal.items) {
    if (!editedById.has(item.id))
      throw new TypeError(`Selected variant ${item.id} is missing from the editable companion`);
  }
  preflightReferences(
    {
      source,
      groups: proposal.items.map((primary) => ({
        contentKey: primary.contentKey,
        primary,
        variants: [],
      })),
    },
    selectedNativeReferences(source, proposal.items),
  );
  return { proposal, editableSource: editable.editableSource };
}

export async function executeWorkspaceImport(
  options: ExecuteWorkspaceImportOptions,
): Promise<WorkspaceImportExecutionResult> {
  if (!nonemptyString(options.destinationOrgId)) {
    throw new TypeError('destinationOrgId must be the nonempty destination org ID');
  }
  const source =
    options.loadedSource ??
    (await loadWorkspaceExport(options.sourceDirectory, {
      allowPartial: options.allowPartial,
    }));
  if (!source.integrity.verified) throw new TypeError('Source integrity must be verified first');
  if (source.isPartial && options.allowPartial !== true) {
    throw new TypeError('Workspace export is partial; explicit allowPartial is required');
  }
  validateRelationships(source.items);
  const native = options.nativeCopyMappings !== undefined;
  if (native && options.identityMappings !== undefined)
    throw new TypeError('Choose one identity profile');
  if (options.editableDirectory !== undefined && !native)
    throw new TypeError('editableDirectory requires nativeCopyMappings');
  let proposal;
  let editableSource: EditableHtmlEvidence | undefined;
  if (native) {
    ({ proposal, editableSource } = await planNativeWorkspaceImport(
      source,
      options.nativeCopyMappings,
      options.editableDirectory,
    ));
  } else if (options.identityMappings !== undefined)
    proposal = planImportIdentities(source, options.identityMappings);
  const selectedIds = new Set(proposal?.items.map((item) => item.id));
  const editableDiagnostics: CmsDiagnostic[] =
    editableSource === undefined
      ? []
      : [
          {
            code: 'EDITABLE_HTML_INPUT',
            message: `Editable HTML input: original package integrity and references describe only the unchanged baseline, not the edited payload. ${editableSource.entries.filter((entry) => entry.changed && selectedIds.has(entry.variantId)).length} selected HTML modification(s) ${options.dryRun === true ? 'planned' : 'applied'}; ${editableSource.entries.filter((entry) => entry.changed).length} changed entry/entries across all ${editableSource.entries.length} companion entries. No CMS reference rewriting is established by HTML edits.`,
            retryable: false,
          },
        ];
  const selectedSource = native ? { ...source, items: proposal!.items } : source;
  const sourcePlan = planWorkspaceImport(
    selectedSource,
    options.destinationWorkspace,
    options.workspaceId,
  );
  // Keep original variant IDs and source manifest associations; never substitute the raw package.
  const proposedById = new Map(proposal?.items.map((item) => [item.id, item]));
  const plan: WorkspaceImportPlan =
    proposal === undefined
      ? sourcePlan
      : {
          ...sourcePlan,
          source,
          groups: sourcePlan.groups.map((group) => ({
            contentKey: proposedById.get(group.primary.id)!.contentKey,
            primary: proposedById.get(group.primary.id)!,
            variants: group.variants.map((variant) => proposedById.get(variant.id)!),
          })),
        };
  preflightReferences(plan, native ? selectedNativeReferences(source, proposal!.items) : undefined);
  const requestOptions = options.requestOptions ?? {};
  if (!native) await preflightConflicts(options.connection, plan, requestOptions);
  const hasNamedIdentities = plan.groups.some((group) =>
    [group.primary, ...group.variants].some(
      (item) =>
        item.apiName !== undefined ||
        item.urlName !== undefined ||
        item.contentBody['sfdc_cms:urlName'] !== undefined,
    ),
  );
  if (!native && hasNamedIdentities && options.dryRun !== true) {
    throw new TypeError(
      'Destination API-name/URL-name uniqueness cannot be verified by the supported CMS APIs; import is blocked',
    );
  }
  const references = source.manifest.externalReferences
    .filter(({ resolution }) => resolution !== 'included')
    .map<WorkspaceImportReference>(({ kind, referenceId, resolution }) => ({
      referenceId,
      kind,
      status: resolution === 'unsupported' ? 'unsupported' : 'unresolved',
    }))
    .toSorted(compareMappingIdentity);
  if (options.dryRun === true) {
    const diagnostics: CmsDiagnostic[] = [
      ...editableDiagnostics,
      {
        code: 'SERVER_CONFLICT_CHECK_UNVERIFIED',
        message: native
          ? 'Native copy omits contentKey. API-name conflicts can reject; duplicate URLs can create distinct objects. Destination name availability is not prevalidated.'
          : 'Content-key absence was checked, but complete server conflict validation is unverified; this is a read-only proposal.',
        retryable: false,
      },
      {
        code: 'APPLY_READINESS_UNVERIFIED',
        message: 'Dry-run success is not deploy readiness and does not authorize apply.',
        retryable: false,
      },
    ];
    if (hasNamedIdentities && !native) {
      diagnostics.unshift({
        code: 'NAME_AVAILABILITY_UNVERIFIED',
        message:
          'Destination API-name/URL-name availability is unverified; named apply remains blocked until collision evidence is available.',
        retryable: false,
      });
    }
    return {
      diagnostics,
      contractResult: importContractResult(source, options.destinationOrgId, plan, [], references),
      dryRun: true,
      plan,
    };
  }
  if (!nonemptyString(options.reportDirectory)) {
    throw new TypeError('reportDirectory is required for an applied import');
  }
  const reportDirectory = path.resolve(options.reportDirectory);
  await mkdir(reportDirectory);
  const reportFile = path.join(reportDirectory, 'workspace-import-run.json');
  const report: WorkspaceImportRunReport = {
    ...(editableSource === undefined ? {} : { editableSource }),
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
  const mappings: WorkspaceImportMapping[] = [];
  const includedReferences = new Map(
    source.manifest.externalReferences
      .filter(({ kind, resolution }) => kind === 'cms.content' && resolution === 'included')
      .map((reference) => [reference.referenceId, reference]),
  );
  const referenceByVariantId = new Map(
    source.manifest.items
      .filter(({ referenceId }) => referenceId !== undefined)
      .map((item_) => [
        path.posix.basename(item_.path, '.json'),
        includedReferences.get(item_.referenceId!),
      ]),
  );
  const replacements = new Map<string, string>();
  const sourceReferencesByValue = new Map(
    [...includedReferences.values()].flatMap((reference) => [
      [reference.source.sourceId, reference] as const,
      [reference.portableKey.value, reference] as const,
    ]),
  );
  const sourceReferenceValues = new Set(sourceReferencesByValue.keys());
  const unresolvedMappingIds = new Set<string>();
  // Editable native copies have no reference-bearing body or child variants. Bind every
  // exact CREATE payload in the initial durable journal, before any mutation.
  if (editableSource !== undefined) {
    for (const group of plan.groups) {
      const payload = createPayload(group, plan.destinationWorkspaceId);
      delete payload.contentKey;
      delete payload.externalId;
      delete payload.externalSource;
      report.operations.push(
        pendingOperation(
          report,
          'create-parent',
          group.contentKey,
          group.primary.language,
          payload,
        ),
      );
    }
  }
  await writeExclusive(reportFile, report);
  try {
    for (const group of plan.groups) {
      const groupReferenceKeys = new Set<string>();
      for (const item_ of [group.primary, ...group.variants]) {
        for (const key of cmsContentBodyReferenceKeys(item_.contentBody, sourceReferenceValues)) {
          groupReferenceKeys.add(key);
        }
      }
      const hasUnknownRequiredMapping = [...groupReferenceKeys].some(
        (key) => !replacements.has(key),
      );
      if (hasUnknownRequiredMapping) {
        for (const key of groupReferenceKeys) {
          if (!replacements.has(key)) {
            const unresolvedReference = sourceReferencesByValue.get(key);
            if (unresolvedReference !== undefined) {
              unresolvedMappingIds.add(unresolvedReference.referenceId);
            }
          }
        }
      }
      const rewrittenGroup = hasUnknownRequiredMapping
        ? group
        : {
            ...group,
            primary: rewriteItem(group.primary, replacements),
            variants: group.variants.map((variant) => rewriteItem(variant, replacements)),
          };
      const parentPayload = createPayload(
        rewrittenGroup,
        native ? plan.destinationWorkspaceId : plan.rootFolderId,
      );
      if (native) {
        delete parentPayload.contentKey;
        delete parentPayload.externalId;
        delete parentPayload.externalSource;
      }
      const parentOperation =
        editableSource === undefined
          ? pendingOperation(
              report,
              'create-parent',
              group.contentKey,
              group.primary.language,
              parentPayload,
            )
          : report.operations.find((operation) => operation.contentKey === group.contentKey)!;
      if (editableSource === undefined) report.operations.push(parentOperation);
      else if (
        parentOperation.requestSha256 !==
        operationIdentity(
          report.runId,
          'create-parent',
          group.contentKey,
          group.primary.language,
          parentPayload,
        ).requestSha256
      )
        throw new TypeError('Editable CREATE payload changed after initial journal');
      await rewrite(reportFile, report);
      let parentResponse: Record<string, unknown>;
      try {
        parentResponse = await createContent(options.connection, parentPayload, requestOptions);
      } catch (error) {
        parentOperation.state = native ? 'pending' : 'failed';
        if (native) report.state = 'ownership-uncertain';
        parentOperation.error = error instanceof Error ? error.message : String(error);
        try {
          await rewrite(reportFile, report);
        } catch {
          // Preserve the mutation error when recording its failure is unavailable.
        }
        throw error;
      }
      // Persist returned identity before any semantic verification or further requests.
      if (native) {
        parentOperation.result = {
          contentKey:
            typeof parentResponse.contentKey === 'string' ? parentResponse.contentKey : undefined,
          contentId: [parentResponse.managedContentId, parentResponse.id].find(nonemptyString),
          primaryVariantId: [
            parentResponse.managedContentVariantId,
            parentResponse.primaryVariantId,
          ].find(nonemptyString),
        };
        report.state = 'ownership-uncertain';
        await persistOperationResult(reportFile, report, parentOperation, rewrite);
      }
      const created = validateParentResponse(
        parentResponse,
        native
          ? responseIdentifier(parentResponse, ['contentKey'], 'generated key')
          : group.contentKey,
      );
      report.createdParents.push(created);
      parentOperation.state = 'succeeded';
      parentOperation.result = {
        contentId: created.contentId,
        contentKey: created.contentKey,
        primaryVariantId: created.primaryVariantId,
      };
      await persistOperationResult(reportFile, report, parentOperation, rewrite);
      if (native) {
        if (
          source.items.some(
            (item) =>
              item.contentKey === created.contentKey ||
              variantIdentity(item, item.id).contentId === created.contentId,
          )
        )
          throw new TypeError('Native response reused a source identity');
        const readback = await getContent(
          options.connection,
          created.contentKey,
          {},
          requestOptions,
        );
        verifyNativeCopy(readback, parentPayload, created, group.primary.language);
        report.state = 'applying';
      }
      const reference = referenceByVariantId.get(group.primary.id);
      if (reference !== undefined) {
        replacements.set(reference.source.sourceId, created.contentId);
        replacements.set(reference.portableKey.value, created.contentKey);
        if (hasUnknownRequiredMapping) unresolvedMappingIds.add(reference.referenceId);
        if (!hasUnknownRequiredMapping && !unresolvedMappingIds.has(reference.referenceId)) {
          const outgoingPayloads: JsonValue[] = [
            parentPayload as unknown as JsonValue,
            ...rewrittenGroup.variants.map(
              (variant) => variantPayload(variant, group.contentKey) as unknown as JsonValue,
            ),
          ];
          const sourceIdentifiersRemain = outgoingPayloads.some(
            (payload) => cmsContentBodyReferenceKeys(payload, sourceReferenceValues).size > 0,
          );
          if (sourceIdentifiersRemain) {
            unresolvedMappingIds.add(reference.referenceId);
          } else {
            mappings.push({
              referenceId: reference.referenceId,
              kind: reference.kind,
              source: {
                sourceId: reference.source.sourceId,
                portableKey: reference.portableKey,
              },
              target: {
                targetId: created.contentId,
                targetReference: created.contentKey,
              },
              operation: 'created',
              status: 'resolved',
              cmsReferencesRewritten: true,
            });
          }
        }
      }
      for (const variant of rewrittenGroup.variants) {
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
    if (
      !(error instanceof WorkspaceImportOwnershipUncertainError) &&
      report.state !== 'ownership-uncertain'
    )
      report.state = 'failed';
    try {
      await rewrite(reportFile, report);
    } catch {
      // Preserve the primary error; the last durable report is the source of truth.
    }
    throw error;
  }
  for (const referenceId of unresolvedMappingIds) {
    const reference = includedReferences.get(referenceId);
    if (reference !== undefined) {
      references.push({
        referenceId,
        kind: reference.kind,
        status: 'unresolved',
      });
    }
  }
  return {
    diagnostics: editableDiagnostics,
    contractResult: importContractResult(
      source,
      options.destinationOrgId,
      plan,
      mappings,
      references,
    ),
    dryRun: false,
    plan,
    report,
    reportFile,
  };
}
