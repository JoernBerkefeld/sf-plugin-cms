import type { Connection } from '@salesforce/core';
import { normalizeContentTypeAlias } from './content-type-alias.js';
import { getVariant } from './read.js';
import {
  enumerateNativeWorkspace,
  type NativeInventoryOptions,
  type NativeInventoryRow,
} from './retrieve-native-inventory.js';
export const DELETE_CONTENT_TYPES = [
  'sfdc_cms__email',
  'sfdc_cms__emailTemplate',
  'sfdc_cms__image',
  'sfdc_cms__document',
  'sfdc_cms__audio',
] as const;
export type DeleteContentType = (typeof DELETE_CONTENT_TYPES)[number];
import { requiredContentIdentifier, requiredVariantIdentifier } from './variant-identity.js';

export type DeleteSelectionFlags = {
  metadata?: readonly string[];
  'content-type'?: readonly string[];
  'content-key-or-id'?: readonly string[];
};
export type ExactDeleteSelector = {
  contentType: DeleteContentType;
  kind: 'api-name' | 'content-key-or-id';
  value: string;
};
export type NativeDeleteTarget = {
  contentId: string;
  variantId: string;
  contentType: DeleteContentType;
  apiName: string | null;
  language: string;
  variantType: 'Content' | 'Translation';
  isPrimary: boolean;
  isPublished: boolean;
  status: string;
  version: {
    managedContentVersionId?: string;
    contentVersion?: number;
    variantVersion?: number;
    versionNumber?: string;
  };
};
export type NativeDeleteItem = {
  contentId: string;
  contentType: DeleteContentType;
  available: NativeDeleteTarget[];
  selected: NativeDeleteTarget[];
  requiresLanguageSelection: boolean;
};
export type NativeDeleteResolution = {
  workspaceId: string;
  apiVersion: string;
  items: NativeDeleteItem[];
  inventory: { complete: true; recordCount: number; pagesRequested: number };
};

function exact(value: string): string {
  if (typeof value !== 'string' || value.trim().length === 0 || /[*?[\]]/u.test(value))
    throw new TypeError('Delete requires a nonempty exact item selector; wildcards are forbidden');
  return value;
}
function family(value: string): DeleteContentType {
  const type = normalizeContentTypeAlias(value, DELETE_CONTENT_TYPES);
  if (!type) throw new TypeError('Delete requires email, emailTemplate, image, document or audio');
  return type;
}

/**
 * Validate exact item selection locally, before connection or preview org access.
 * @param {DeleteSelectionFlags} flags - Exact metadata or the existing parent/key route.
 * @returns {ExactDeleteSelector[]} Detached deduplicated selectors, never type-wide discovery.
 */
export function normalizeDeleteSelection(flags: DeleteSelectionFlags): ExactDeleteSelector[] {
  const selectors: ExactDeleteSelector[] = [];
  if (flags.metadata === undefined) {
    const types = [...new Set((flags['content-type'] ?? []).map((value) => family(value)))];
    if (types.length !== 1) throw new TypeError('Delete parent selection requires one family');
    for (const value of flags['content-key-or-id'] ?? []) {
      exact(value);
      if (value.includes(':') || value.startsWith('9Ps'))
        throw new TypeError('Delete requires a parent identifier, not a native variant ID');
      selectors.push({ contentType: types[0], kind: 'content-key-or-id', value });
    }
  } else {
    if (flags['content-type'] !== undefined || flags['content-key-or-id'] !== undefined)
      throw new TypeError('Delete metadata is exclusive of parent selection');
    for (const value of flags.metadata) {
      exact(value);
      const parts = value.split(':');
      if (parts.length !== 2) throw new TypeError('Delete metadata requires Type:ApiName');
      selectors.push({ contentType: family(parts[0]), kind: 'api-name', value: exact(parts[1]) });
    }
  }
  if (selectors.length === 0) throw new TypeError('Delete requires explicit exact items');
  return selectors.filter(
    (value, index) =>
      selectors.findIndex(
        (other) =>
          other.contentType === value.contentType &&
          other.kind === value.kind &&
          other.value === value.value,
      ) === index,
  );
}
function blocked(parent: string, rows: NativeInventoryRow[], reason: string): never {
  throw new TypeError(
    `Delete item ${parent} blocked: ${reason}; candidates ${rows
      .map((row) => `${row.Id}/${row.VariantType ?? 'unknown'}/${row.Language}`)
      .join(', ')}`,
  );
}

/**
 * Resolve actual item locales to identity-bound native IDs using read-only requests only.
 * This is not mutation authorization or a promise about DELETE collateral effects.
 * @param {Pick<Connection, 'request' | 'getApiVersion'>} connection - Selected org connection.
 * @param {object} input - Workspace, raw exact selectors and optional explicit locale subset or all locales.
 * @param {string} input.workspaceId - Exact authored workspace ID.
 * @param {DeleteSelectionFlags} input.selection - Raw exact item selectors.
 * @param {readonly string[]} [input.languages] - Explicit locale subset or sole wildcard.
 * @param {NativeInventoryOptions} options - Existing bounded read and cancellation options.
 * @returns {Promise<NativeDeleteResolution>} Complete selected items; unresolved multi-locale choice remains explicit.
 */
export async function resolveNativeDeleteSelection(
  connection: Pick<Connection, 'request' | 'getApiVersion'>,
  input: { workspaceId: string; selection: DeleteSelectionFlags; languages?: readonly string[] },
  options: NativeInventoryOptions = {},
): Promise<NativeDeleteResolution> {
  const selectors = normalizeDeleteSelection(input.selection);
  const languages = input.languages === undefined ? undefined : [...new Set(input.languages)];
  if (
    languages !== undefined &&
    (languages.length === 0 ||
      languages.some(
        (value) =>
          typeof value !== 'string' ||
          value.trim().length === 0 ||
          (value !== '*' && /[*?[\]]/u.test(value)),
      ) ||
      (languages.includes('*') && languages.length !== 1))
  )
    throw new TypeError('Delete language requires an explicit subset or sole *');
  const inventory = await enumerateNativeWorkspace(connection, input.workspaceId, options);
  const parents = new Map<string, DeleteContentType>();
  for (const selector of selectors) {
    const matches = inventory.records.filter(
      (row) =>
        row.ContentTypeFullyQualifiedName === selector.contentType &&
        (selector.kind === 'api-name'
          ? row.ManagedContent.ApiName === selector.value
          : row.ManagedContentId === selector.value || row.ManagedContentKey === selector.value),
    );
    const ids = [...new Set(matches.map((row) => row.ManagedContentId))];
    if (ids.length !== 1)
      throw new TypeError(
        `Delete exact selector ${selector.value} is ${ids.length === 0 ? 'missing' : 'ambiguous'}; parents ${ids.join(', ')}`,
      );
    parents.set(ids[0], selector.contentType);
  }
  const items: NativeDeleteItem[] = [];
  for (const [contentId, contentType] of parents) {
    const rows = inventory.records.filter((row) => row.ManagedContentId === contentId);
    const locales = new Set<string>();
    for (const row of rows) {
      if (
        row.ContentTypeFullyQualifiedName !== contentType ||
        (row.VariantType !== 'Content' && row.VariantType !== 'Translation')
      )
        blocked(contentId, rows, 'unsupported or unknown classification');
      if (locales.has(row.Language))
        blocked(contentId, rows, 'multiple native IDs for the same locale');
      locales.add(row.Language);
    }
    if (
      languages !== undefined &&
      !languages.includes('*') &&
      languages.some((value) => !locales.has(value))
    )
      blocked(contentId, rows, 'requested locale is missing');
    const available: NativeDeleteTarget[] = [];
    for (const row of rows) {
      const detail = await getVariant(connection, row.Id, options);
      const type =
        typeof detail.contentType === 'object' && detail.contentType !== null
          ? (detail.contentType as Record<string, unknown>).fullyQualifiedName
          : detail.contentType;
      const space = detail.contentSpace as Record<string, unknown> | undefined;
      const status = detail.status as Record<string, unknown> | undefined;
      if (
        requiredVariantIdentifier(detail) !== row.Id ||
        requiredContentIdentifier(detail) !== contentId ||
        type !== contentType ||
        space?.id !== input.workspaceId ||
        detail.language !== row.Language ||
        detail.apiName !== row.ManagedContent.ApiName ||
        detail.isPublished !== row.IsPublished ||
        status?.status !== row.ManagedContentVariantStatus ||
        (detail.variantType !== undefined && detail.variantType !== row.VariantType)
      )
        blocked(contentId, rows, 'native GET identity/classification/status disagreement');
      const version: NativeDeleteTarget['version'] = {};
      for (const key of ['managedContentVersionId', 'versionNumber'] as const) {
        if (detail[key] !== undefined) {
          if (typeof detail[key] !== 'string' || detail[key].length === 0)
            blocked(contentId, rows, 'malformed version evidence');
          version[key] = detail[key];
        }
      }
      for (const key of ['contentVersion', 'variantVersion'] as const) {
        if (detail[key] !== undefined && detail[key] !== null) {
          if (
            typeof detail[key] !== 'number' ||
            !Number.isSafeInteger(detail[key]) ||
            detail[key] < 0
          )
            blocked(contentId, rows, 'malformed version evidence');
          version[key] = detail[key];
        }
      }
      available.push({
        contentId,
        variantId: row.Id,
        contentType,
        apiName: row.ManagedContent.ApiName,
        language: row.Language,
        variantType: row.VariantType as 'Content' | 'Translation',
        isPrimary: row.IsPrimary,
        isPublished: row.IsPublished,
        status: row.ManagedContentVariantStatus,
        version,
      });
    }
    const requiresLanguageSelection = languages === undefined && available.length > 1;
    items.push({
      contentId,
      contentType,
      available,
      requiresLanguageSelection,
      selected: requiresLanguageSelection
        ? []
        : available.filter(
            (target) =>
              languages === undefined ||
              languages.includes('*') ||
              languages.includes(target.language),
          ),
    });
  }
  return {
    workspaceId: inventory.workspaceId,
    apiVersion: inventory.apiVersion,
    items,
    inventory: {
      complete: true,
      recordCount: inventory.records.length,
      pagesRequested: inventory.pagesRequested,
    },
  };
}
