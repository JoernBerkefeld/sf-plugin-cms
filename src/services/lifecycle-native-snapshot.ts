import type { Connection } from '@salesforce/core';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { sourcePathSegment } from '../contracts/source-definition.js';
import { getContent, getVariant, type CmsRecord } from './read.js';
import { inventoryExportReferences } from './export-references.js';
import { assertNativeBody, decodeNativeHtml, safeNativeRawHtml } from './import-identities.js';
import type { WorkspaceImportItem } from './import-workspace.js';
import { extractEditableMediaSource } from './editable-media-source.js';
import { acquireEditableMediaSource } from './retrieve-media-source.js';
import {
  enumerateNativeFamily,
  enumerateNativeSiblings,
  type NativeInventory,
  type NativeInventoryOptions,
  type NativeInventoryRow,
} from './retrieve-native-inventory.js';
import { requiredContentIdentifier, requiredVariantIdentifier } from './variant-identity.js';

export type LifecycleNativeSelector = {
  workspaceId: string;
  contentType: string;
  apiName: string;
  language: string;
};
export type LifecycleNativeObservation = {
  isPublished: boolean;
  status: { label: string; status: string };
};
export type LifecycleNativeIdentitySnapshot = {
  identity: LifecycleNativeSelector & { contentId: string; variantId: string; contentKey: string };
  canonicalAuthoringHash: string;
  parentLifecycle: LifecycleNativeObservation;
  variantLifecycle: LifecycleNativeObservation;
  parent: CmsRecord;
  variant: CmsRecord;
  family: NativeInventory;
  siblings: NativeInventory;
};
export type LifecycleNativeMediaReceipt = { sha256: string; size: number; mimeType: string };
export type LifecycleNativeSnapshot = LifecycleNativeIdentitySnapshot & {
  references: ReturnType<typeof inventoryExportReferences>['externalReferences'];
  mediaReceipt?: LifecycleNativeMediaReceipt;
};
type NativeConnection = Pick<Connection, 'request' | 'getApiVersion'> &
  Partial<Pick<Connection, 'accessToken' | 'instanceUrl'>>;

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => canonical(entry));
  if (!object(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .toSorted()
      .map((key) => [key, canonical(value[key])]),
  );
}
function authoringHash(value: CmsRecord): string {
  return createHash('sha256')
    .update(
      JSON.stringify(
        canonical({
          apiName: value.apiName,
          contentBody: value.contentBody,
          title: value.title,
          urlName: value.urlName,
        }),
      ),
    )
    .digest('hex');
}
function lifecycle(value: CmsRecord): LifecycleNativeObservation {
  if (
    typeof value.isPublished !== 'boolean' ||
    !object(value.status) ||
    typeof value.status.label !== 'string' ||
    !value.status.label ||
    typeof value.status.status !== 'string' ||
    !value.status.status
  )
    throw new TypeError('Native lifecycle requires isPublished and native label/status objects');
  return {
    isPublished: value.isPublished,
    status: { label: value.status.label, status: value.status.status },
  };
}
function bind(value: CmsRecord, row: NativeInventoryRow): void {
  if (
    requiredContentIdentifier(value) !== row.ManagedContentId ||
    requiredVariantIdentifier(value) !== row.Id ||
    !object(value.contentType) ||
    value.contentType.fullyQualifiedName !== row.ContentTypeFullyQualifiedName ||
    !object(value.contentSpace) ||
    value.contentSpace.id !== row.ManagedContent.AuthoredManagedContentSpaceId ||
    value.apiName !== row.ManagedContent.ApiName ||
    value.language !== row.Language ||
    value.contentKey !== row.ManagedContentKey ||
    !object(value.contentBody)
  )
    throw new TypeError('Native detail identity disagrees with inventory');
}

/**
 * Read native identity/lifecycle and independent siblings, without admitting an authoring profile.
 * This groundwork deliberately does not replace legacy Email behavior or authorize any mutation.
 * Static-profile/reference and media-byte admission must be layered on before public enablement.
 * @param {NativeConnection} connection - Existing read-only connection using the selected API.
 * @param {LifecycleNativeSelector} selector - Exact workspace, qualified family, API name and locale.
 * @param {NativeInventoryOptions} options - Bounded native inventory and JSON request options.
 * @returns {Promise<LifecycleNativeIdentitySnapshot>} Detached observations, not admission evidence.
 */
export async function acquireLifecycleNativeIdentitySnapshot(
  connection: NativeConnection,
  selector: LifecycleNativeSelector,
  options: NativeInventoryOptions = {},
): Promise<LifecycleNativeIdentitySnapshot> {
  const selected = structuredClone(selector);
  const requestOptions = { ...options };
  for (const value of [selected.apiName, selected.language]) sourcePathSegment(value);
  if (
    ![
      'sfdc_cms__email',
      'sfdc_cms__emailTemplate',
      'sfdc_cms__image',
      'sfdc_cms__document',
      'sfdc_cms__audio',
    ].includes(selected.contentType)
  )
    throw new TypeError('Unsupported native lifecycle family');
  const family = await enumerateNativeFamily(
    connection,
    selected.workspaceId,
    [selected.contentType],
    requestOptions,
  );
  const matches = family.records.filter(
    (row) => row.ManagedContent.ApiName === selected.apiName && row.Language === selected.language,
  );
  if (matches.length !== 1) throw new TypeError('Exactly one native selector match is required');
  const row = matches[0];
  const siblings = await enumerateNativeSiblings(
    connection,
    selected.workspaceId,
    row.ManagedContentId,
    requestOptions,
  );
  const matchedSibling = siblings.records.filter((entry) => entry.Id === row.Id);
  if (
    matchedSibling.length !== 1 ||
    !isDeepStrictEqual(matchedSibling[0], row) ||
    (selected.contentType !== 'sfdc_cms__email' && siblings.records.length !== 1)
  )
    throw new TypeError('Independent native sibling evidence disagrees or is not single-variant');
  const variant = await getVariant(connection, row.Id, requestOptions);
  const parent = await getContent(connection, row.ManagedContentId, {}, requestOptions);
  bind(variant, row);
  bind(parent, row);
  const variantLifecycle = lifecycle(variant);
  const parentLifecycle = lifecycle(parent);
  if (
    variantLifecycle.isPublished !== row.IsPublished ||
    variantLifecycle.status.status !== row.ManagedContentVariantStatus
  )
    throw new TypeError('Native variant lifecycle disagrees with inventory');
  const canonicalAuthoringHash = authoringHash(variant);
  if (authoringHash(parent) !== canonicalAuthoringHash)
    throw new TypeError('Native parent authoring disagrees with variant');
  return structuredClone({
    identity: {
      ...selected,
      contentId: row.ManagedContentId,
      variantId: row.Id,
      contentKey: row.ManagedContentKey,
    },
    canonicalAuthoringHash,
    parentLifecycle,
    variantLifecycle,
    parent,
    variant,
    family,
    siblings,
  });
}

/**
 * Acquire bounded static authoring/reference and exact binary integrity evidence, without mutation.
 * This internal helper does not enable public lifecycle admission or alter legacy Email services.
 * @param {NativeConnection} connection - Read connection and existing binary authentication context.
 * @param {LifecycleNativeSelector} selector - Exact native scope.
 * @param {NativeInventoryOptions} options - Bounded inventory and request options.
 * @returns {Promise<LifecycleNativeSnapshot>} Detached observations and JSON-only integrity receipts.
 */
export async function acquireLifecycleNativeSnapshot(
  connection: NativeConnection,
  selector: LifecycleNativeSelector,
  options: NativeInventoryOptions = {},
): Promise<LifecycleNativeSnapshot> {
  const selected = structuredClone(selector);
  const requestOptions = { ...options };
  const snapshot = await acquireLifecycleNativeIdentitySnapshot(
    connection,
    selected,
    requestOptions,
  );
  const references = [] as LifecycleNativeSnapshot['references'];
  for (const detail of [snapshot.variant, snapshot.parent]) {
    const inventory = inventoryExportReferences(
      selected.workspaceId,
      new Map([[snapshot.identity.variantId, detail]]),
    );
    const [self] = inventory.externalReferences;
    if (
      inventory.dependencies.length > 0 ||
      inventory.warnings.length > 0 ||
      inventory.externalReferences.length !== 1 ||
      self.kind !== 'cms.content' ||
      self.owner !== 'cms' ||
      self.resolution !== 'included' ||
      !self.required ||
      self.source.workspaceId !== selected.workspaceId ||
      self.source.sourceId !== snapshot.identity.contentId ||
      self.portableKey.scheme !== 'cms-opaque-v1' ||
      self.portableKey.value !== snapshot.identity.contentKey ||
      inventory.itemReferenceIds.get(snapshot.identity.variantId) !== self.referenceId
    )
      throw new TypeError('Native lifecycle requires only the included self identity reference');
    if (references.length === 0) references.push(self);
  }
  if (['sfdc_cms__email', 'sfdc_cms__emailTemplate'].includes(selected.contentType)) {
    for (const detail of [snapshot.variant, snapshot.parent]) {
      if (detail.source !== undefined && detail.source !== 'User')
        throw new TypeError('External provider content is unsupported');
      assertNativeBody({ ...detail, contentType: selected.contentType } as WorkspaceImportItem);
      const rawHtml = (detail.contentBody as Record<string, unknown>).rawHtml;
      if (typeof rawHtml !== 'string' || !safeNativeRawHtml(decodeNativeHtml(rawHtml)))
        throw new TypeError('Unsafe native lifecycle raw HTML');
    }
    return structuredClone({ ...snapshot, references });
  }
  const acquired = await acquireEditableMediaSource(
    connection,
    {
      ...selected,
      contentType: selected.contentType as
        'sfdc_cms__image' | 'sfdc_cms__document' | 'sfdc_cms__audio',
    },
    requestOptions,
  );
  const { definition, companions } = acquired.projection;
  if (
    acquired.evidence.contentId !== snapshot.identity.contentId ||
    acquired.evidence.variantId !== snapshot.identity.variantId ||
    definition.contentType !== selected.contentType ||
    definition.identity.apiName !== selected.apiName ||
    definition.language !== selected.language ||
    definition.media.representation !== 'binary' ||
    companions.length !== 1 ||
    companions[0].role !== 'media' ||
    companions[0].path !== definition.media.companion.path
  )
    throw new TypeError('Native lifecycle requires exact binary media evidence, not URL-only');
  // Reuse native size/MD5/body guards against the original lifecycle observation, not just a later read.
  const { identity, contentType, language, folderPath } = definition;
  const bound = extractEditableMediaSource(
    {
      identity,
      contentType,
      language,
      folderPath,
      ...(snapshot.variant.title === undefined ? {} : { title: snapshot.variant.title as string }),
      ...(snapshot.variant.urlName === undefined
        ? {}
        : { urlName: snapshot.variant.urlName as string }),
    },
    snapshot.variant.contentBody,
    companions[0].bytes,
  );
  if (!isDeepStrictEqual(bound.definition, definition))
    throw new TypeError('Native lifecycle media metadata disagrees with snapshot');
  const repeated = await acquireLifecycleNativeIdentitySnapshot(
    connection,
    selected,
    requestOptions,
  );
  if (
    !isDeepStrictEqual(repeated.identity, snapshot.identity) ||
    !isDeepStrictEqual(repeated.parent, snapshot.parent) ||
    !isDeepStrictEqual(repeated.variant, snapshot.variant) ||
    !isDeepStrictEqual(repeated.siblings.records, snapshot.siblings.records)
  )
    throw new TypeError('Native lifecycle media changed during integrity acquisition');
  return structuredClone({
    ...snapshot,
    references,
    mediaReceipt: {
      sha256: createHash('sha256').update(companions[0].bytes).digest('hex'),
      size: companions[0].bytes.length,
      mimeType: definition.media.mimeType,
    },
  });
}
