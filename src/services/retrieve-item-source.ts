import type { Connection } from '@salesforce/core';
import { isDeepStrictEqual } from 'node:util';
import { sourcePathSegment } from '../contracts/source-definition.js';
import type { JsonRequestOptions } from '../transport/json-request.js';
import { lookupExactCmsVariants } from './cms-prerequisite-lookup.js';
import {
  extractEditableItemSourceV2,
  type EditableItemProjectionV2,
} from './editable-item-source-v2.js';
import { getContent, getWorkspace } from './read.js';
import { projectSourceDefinitions } from './source-definition.js';
import { requiredContentIdentifier, requiredVariantIdentifier } from './variant-identity.js';

type RequestConnection = Pick<Connection, 'request'> & Partial<Pick<Connection, 'version'>>;
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

/**
 * Acquire one root-level, single-variant Email without filesystem or org writes.
 * Email uses complete global-count search semantics. Template page-local counts are
 * deliberately unsupported here; this service does not acquire Email Templates.
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
  const contentType = 'sfdc_cms__email';
  // Retain all languages and API names so sibling evidence cannot be filtered away.
  const inventory = await lookupExactCmsVariants(
    connection,
    workspaceId,
    contentType,
    '*',
    () => true,
    requestOptions,
  );
  const matches = inventory.filter((raw) => raw.apiName === apiName && raw.language === language);
  if (matches.length !== 1)
    throw new TypeError(`Email selection must match exactly one variant; found ${matches.length}`);
  const raw = matches[0];
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
  const siblings = inventory.filter(
    (candidate) => requiredContentIdentifier(candidate) === contentId,
  );
  if (siblings.length !== 1 || siblings[0] !== raw)
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
    directory: `cms/${workspaceApiName}/email`,
    projection: extractEditableItemSourceV2(source.definition, source.htmlBytes!.toString('utf8')),
    evidence: { variantId, contentId },
  };
}
