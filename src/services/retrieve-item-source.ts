import type { Connection } from '@salesforce/core';
import { isDeepStrictEqual } from 'node:util';
import { sourcePathSegment } from '../contracts/source-definition.js';
import type { JsonRequestOptions } from '../transport/json-request.js';
import {
  enumerateNativeFamily,
  enumerateNativeSiblings,
  type NativeInventoryRow,
} from './retrieve-native-inventory.js';
import {
  extractEditableItemSourceV2,
  type EditableItemProjectionV2,
} from './editable-item-source-v2.js';
import { getContent, getVariant, getWorkspace } from './read.js';
import {
  acquireEditableMediaSource,
  type AcquiredEditableMediaSource,
} from './retrieve-media-source.js';
import {
  resolveNativeRetrieveSelection,
  type NativeRetrieveResolution,
  type ResolveNativeRetrieveInput,
} from './retrieve-native-resolution.js';
import { projectSourceDefinitions } from './source-definition.js';
import { requiredContentIdentifier, requiredVariantIdentifier } from './variant-identity.js';

type RequestConnection = Pick<Connection, 'request'> &
  Partial<Pick<Connection, 'version' | 'accessToken' | 'instanceUrl'>>;
export type AcquiredEditableSource = AcquiredEditableEmailSource | AcquiredEditableMediaSource;
export type AcquireEditableEmailSourceInput = {
  readonly workspaceId: string;
  readonly apiName: string;
} & (
  | { readonly language: string; readonly useDefaultLanguage?: never }
  | { readonly language?: never; readonly useDefaultLanguage: true }
);
export type AcquiredEditableEmailSource = {
  readonly directory: string;
  readonly projection: EditableItemProjectionV2;
  readonly evidence: { readonly variantId: string; readonly contentId: string };
};

function nonempty(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim())
    throw new TypeError(`${label} must be a nonempty string`);
  return value;
}

/**
 * Adapt only observed GET metadata; unknown envelope keys and all authoring fields stay strict.
 * Parent GET duplicates are checked against the selected variant before omission.
 * @param {Readonly<Record<string, unknown>>} raw - Selected original variant GET.
 * @param {Readonly<Record<string, unknown>>} parent - Original parent GET.
 * @returns {{ raw: Record<string, unknown>; parent: Record<string, unknown> }} Projection-only envelopes.
 */
function normalizeReadEnvelopes(
  raw: Readonly<Record<string, unknown>>,
  parent: Readonly<Record<string, unknown>>,
): { raw: Record<string, unknown>; parent: Record<string, unknown> } {
  // Only paired native User provenance is observed; never hide provider or unknown sources.
  if (
    ('source' in raw || 'source' in parent) &&
    (raw.source !== 'User' || parent.source !== 'User')
  )
    throw new TypeError('Unsupported or disagreeing source provenance');
  for (const key of [
    'apiName',
    'contentKey',
    'contentFqn',
    'contentBody',
    'language',
    'title',
    'urlName',
    'externalId',
  ]) {
    if (key in parent && !isDeepStrictEqual(parent[key], raw[key]))
      throw new TypeError(`Source parent ${key} disagreement`);
  }
  if ('externalId' in parent && parent.externalId !== null)
    throw new TypeError('External provider content is unsupported');
  if (
    'managedContentVariantId' in parent &&
    requiredVariantIdentifier(parent) !== requiredVariantIdentifier(raw)
  )
    throw new TypeError('Source parent variant identity disagreement');
  if (
    ('managedContentVersionId' in raw || 'managedContentVersionId' in parent) &&
    (typeof raw.managedContentVersionId !== 'string' ||
      !raw.managedContentVersionId ||
      raw.managedContentVersionId !== parent.managedContentVersionId)
  )
    throw new TypeError('Source parent version disagreement');
  // These are observed read metadata, never editable payload components. Keep the
  // original inventory untouched; only the strict projection receives these copies.
  const metadata = new Set([
    'source',
    'contentFqn',
    'createdBy',
    'createdDate',
    'lastModifiedBy',
    'lastModifiedDate',
    'managedContentVersionId',
  ]);
  const parentReadFields = new Set([
    ...metadata,
    'contentBody',
    'language',
    'externalId',
    'managedContentVariantId',
    'contentVersion',
    'variantVersion',
  ]);
  return {
    raw: Object.fromEntries(Object.entries(raw).filter(([key]) => !metadata.has(key))),
    parent: Object.fromEntries(
      Object.entries(parent).filter(([key]) => !parentReadFields.has(key)),
    ),
  };
}

type JsonRecord = Record<string, unknown>;
function record(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function bindNativeDetail(
  connection: RequestConnection,
  row: NativeInventoryRow,
  options: JsonRequestOptions,
): Promise<JsonRecord> {
  const detail = await getVariant(connection, row.Id, options);
  const contentType = record(detail.contentType)
    ? detail.contentType.fullyQualifiedName
    : detail.contentType;
  if (
    requiredVariantIdentifier(detail) !== row.Id ||
    requiredContentIdentifier(detail) !== row.ManagedContentId ||
    !record(detail.contentSpace) ||
    detail.contentSpace.id !== row.ManagedContent.AuthoredManagedContentSpaceId ||
    contentType !== row.ContentTypeFullyQualifiedName ||
    detail.apiName !== row.ManagedContent.ApiName ||
    detail.language !== row.Language ||
    !record(detail.status) ||
    detail.status.status !== row.ManagedContentVariantStatus ||
    detail.isPublished !== row.IsPublished ||
    detail.contentKey !== row.ManagedContentKey
  )
    throw new TypeError('Native/detail identity/scope/metadata disagreement');
  return detail;
}

export type AcquireEditableTemplateSourceInput = AcquireEditableEmailSourceInput;
export type AcquiredEditableTemplateSource = AcquiredEditableEmailSource;

/**
 * Acquire one root-level, single-variant Template using qualified native inventory.
 * @param {RequestConnection} connection - Explicit source org connection.
 * @param {AcquireEditableTemplateSourceInput} input - Exact workspace, API name and language.
 * @param {JsonRequestOptions} requestOptions - Request metadata and cancellation signal.
 * @returns {Promise<AcquiredEditableTemplateSource>} Portable v2 projection and detached evidence.
 */
export async function acquireEditableTemplateSource(
  connection: RequestConnection,
  input: AcquireEditableTemplateSourceInput,
  requestOptions: JsonRequestOptions = {},
): Promise<AcquiredEditableTemplateSource> {
  return acquireEditableSource(connection, input, 'sfdc_cms__emailTemplate', requestOptions);
}

/**
 * Acquire one root-level, single-variant Email without filesystem or org writes.
 * Admission uses principal-visible nondeleted native API 67 inventory, not search.
 * @param {RequestConnection} connection - Explicit source org connection.
 * @param {AcquireEditableEmailSourceInput} input - Exact workspace, API name and language choice.
 * @param {JsonRequestOptions} requestOptions - Optional request metadata and cancellation signal.
 * @returns {Promise<AcquiredEditableEmailSource>} Portable relative directory, v2 files and detached IDs.
 */
export async function acquireEditableEmailSource(
  connection: RequestConnection,
  input: AcquireEditableEmailSourceInput,
  requestOptions: JsonRequestOptions = {},
): Promise<AcquiredEditableEmailSource> {
  return acquireEditableSource(connection, input, 'sfdc_cms__email', requestOptions);
}

async function acquireEditableSource(
  connection: RequestConnection,
  input: AcquireEditableEmailSourceInput,
  contentType: 'sfdc_cms__email' | 'sfdc_cms__emailTemplate',
  requestOptions: JsonRequestOptions,
): Promise<AcquiredEditableEmailSource> {
  const workspaceId = nonempty(input.workspaceId, 'workspaceId');
  const apiName = nonempty(input.apiName, 'apiName');
  sourcePathSegment(apiName);
  if (
    (input.language === undefined) === (input.useDefaultLanguage !== true) ||
    (input.useDefaultLanguage !== undefined && input.useDefaultLanguage !== true)
  )
    throw new TypeError('Specify exactly one language or useDefaultLanguage: true');
  if (input.language !== undefined) nonempty(input.language, 'language');
  const workspace = await getWorkspace(connection, workspaceId, requestOptions);
  if (workspace.id !== workspaceId) throw new TypeError('Workspace identity does not match');
  const workspaceApiName = nonempty(workspace.apiName, 'Workspace API name');
  sourcePathSegment(workspaceApiName);
  const language =
    input.language ?? nonempty(workspace.defaultLanguage, 'Workspace defaultLanguage');
  // Preserve the public connection shape while requiring explicit API-version evidence.
  const nativeConnection = nativeRequestConnection(connection);
  const family = await enumerateNativeFamily(
    nativeConnection,
    workspaceId,
    [contentType],
    requestOptions,
  );
  const inventory: JsonRecord[] = [];
  for (const row of family.records)
    inventory.push(await bindNativeDetail(connection, row, requestOptions));
  const matches = inventory.filter((raw) => raw.apiName === apiName && raw.language === language);
  if (matches.length !== 1)
    throw new TypeError(
      `${contentType === 'sfdc_cms__email' ? 'Email' : 'Template'} selection must match exactly one variant; found ${matches.length}`,
    );
  const raw = matches[0];
  const selectedRow = family.records.find((row) => row.Id === requiredVariantIdentifier(raw))!;
  return acquireBoundSource(
    connection,
    nativeConnection,
    workspace,
    selectedRow,
    raw,
    requestOptions,
  );
}

function nativeRequestConnection(
  connection: RequestConnection,
): Pick<Connection, 'request' | 'getApiVersion'> {
  const nativeConnection = Object.create(connection) as Pick<
    Connection,
    'request' | 'getApiVersion'
  >;
  if (typeof nativeConnection.getApiVersion !== 'function')
    Object.defineProperty(nativeConnection, 'getApiVersion', { value: () => connection.version });
  return nativeConnection;
}

export type PreparedEditableSourceSelection = {
  /** Detached observations, including explicit selectors that could not be resolved. */
  readonly resolution: NativeRetrieveResolution;
  /** Only IDs in the internally resolved selection are admitted; no inventory/proof input exists. */
  readonly acquire: (variantId: string) => Promise<AcquiredEditableSource>;
};

/**
 * Resolve once and retain private native evidence for independently guarded item acquisition.
 * Unresolved selectors remain failures for the caller to report, even when variants are selected.
 * @param {RequestConnection} connection - Explicit source connection used for every read.
 * @param {ResolveNativeRetrieveInput} input - Workspace, explicit language and normalized selection.
 * @param {JsonRequestOptions} requestOptions - Request metadata and cancellation signal.
 * @returns {Promise<PreparedEditableSourceSelection>} Detached resolution and guarded acquisition closure.
 */
export async function prepareEditableSourceSelection(
  connection: RequestConnection,
  input: ResolveNativeRetrieveInput,
  requestOptions: JsonRequestOptions = {},
): Promise<PreparedEditableSourceSelection> {
  // Snapshot before the first await: caller mutation cannot change scope or selected evidence.
  const selected = structuredClone(input);
  const options = { ...requestOptions };
  const workspaceId = nonempty(selected.workspaceId, 'workspaceId');
  nonempty(selected.language, 'language');
  const workspace = await getWorkspace(connection, workspaceId, options);
  if (workspace.id !== workspaceId) throw new TypeError('Workspace identity does not match');
  sourcePathSegment(nonempty(workspace.apiName, 'Workspace API name'));
  const nativeConnection = nativeRequestConnection(connection);
  const resolution = await resolveNativeRetrieveSelection(nativeConnection, selected, options);
  const rows = new Map(resolution.variants.map((row) => [row.Id, row]));
  return {
    resolution: structuredClone(resolution),
    acquire: async (variantId) => {
      const row = rows.get(variantId);
      if (!row) throw new TypeError('Variant is not in the resolved native selection');
      if (
        row.ManagedContent.AuthoredManagedContentSpaceId !== workspaceId ||
        row.Language !== selected.language ||
        !selected.selection.groups.some(
          (group) => group.contentType === row.ContentTypeFullyQualifiedName,
        )
      )
        throw new TypeError('Native selection scope disagreement');
      if (
        row.ContentTypeFullyQualifiedName === 'sfdc_cms__image' ||
        row.ContentTypeFullyQualifiedName === 'sfdc_cms__document' ||
        row.ContentTypeFullyQualifiedName === 'sfdc_cms__audio'
      ) {
        const source = await acquireEditableMediaSource(
          nativeConnection,
          {
            workspaceId,
            language: selected.language,
            apiName: nonempty(row.ManagedContent.ApiName, 'Media API name'),
            contentType: row.ContentTypeFullyQualifiedName,
          },
          options,
        );
        if (
          source.evidence.variantId !== row.Id ||
          source.evidence.contentId !== row.ManagedContentId ||
          source.projection.definition.identity.context.workspaceApiName !== workspace.apiName
        )
          throw new TypeError('Resolved media identity/workspace changed during acquisition');
        return source;
      }
      const raw = await bindNativeDetail(connection, row, options);
      return acquireBoundSource(connection, nativeConnection, workspace, row, raw, options);
    },
  };
}

async function acquireBoundSource(
  connection: RequestConnection,
  nativeConnection: Pick<Connection, 'request' | 'getApiVersion'>,
  workspace: JsonRecord,
  selectedRow: NativeInventoryRow,
  raw: JsonRecord,
  requestOptions: JsonRequestOptions,
): Promise<AcquiredEditableEmailSource> {
  const workspaceId = nonempty(workspace.id, 'workspaceId');
  const workspaceApiName = nonempty(workspace.apiName, 'Workspace API name');
  const apiName = nonempty(selectedRow.ManagedContent.ApiName, 'apiName');
  sourcePathSegment(apiName);
  const contentType = selectedRow.ContentTypeFullyQualifiedName;
  if (contentType !== 'sfdc_cms__email' && contentType !== 'sfdc_cms__emailTemplate')
    throw new TypeError('Unsupported editable source content type');
  const variantId = requiredVariantIdentifier(raw);
  const contentId = requiredContentIdentifier(raw);
  const parent = await getContent(connection, contentId, {}, requestOptions);
  const root = (folder: unknown): boolean =>
    folder === null ||
    (folder !== null &&
      typeof folder === 'object' &&
      !Array.isArray(folder) &&
      typeof workspace.rootFolderId === 'string' &&
      workspace.rootFolderId.length > 0 &&
      workspace.rootFolderId !== workspaceId &&
      'id' in folder &&
      folder.id === workspace.rootFolderId);
  if (!root(raw.folder) || !root(parent.folder))
    throw new TypeError('Source folder ancestry is unknown or non-root');
  // This independent parent scope deliberately retains every type/language/status.
  const nativeSiblings = await enumerateNativeSiblings(
    nativeConnection,
    workspaceId,
    contentId,
    requestOptions,
  );
  const siblings: JsonRecord[] = [];
  for (const row of nativeSiblings.records)
    siblings.push(await bindNativeDetail(connection, row, requestOptions));
  if (
    siblings.length !== 1 ||
    !isDeepStrictEqual(nativeSiblings.records[0], selectedRow) ||
    !isDeepStrictEqual(siblings[0], raw)
  )
    throw new TypeError('Complete single exact native sibling evidence is required');
  const normalized = normalizeReadEnvelopes(raw, parent);
  const source = projectSourceDefinitions([
    {
      workspaceApiName,
      workspaceId,
      apiName,
      contentType,
      folderPath: [],
      variantId,
      raw: normalized.raw,
      parent: normalized.parent,
      siblings: {
        complete: true,
        variants: [normalized.raw],
      },
    },
  ]).items[0];
  return {
    directory: `cms/${workspaceApiName}/${contentType === 'sfdc_cms__email' ? 'email' : 'emailTemplate'}`,
    projection: extractEditableItemSourceV2(source.definition, source.htmlBytes!.toString('utf8')),
    evidence: { variantId, contentId },
  };
}
