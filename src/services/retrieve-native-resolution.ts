import type { Connection } from '@salesforce/core';
import {
  enumerateNativeFamily,
  type NativeInventoryOptions,
  type NativeInventoryRow,
} from './retrieve-native-inventory.js';
import type { RetrieveContentType, RetrieveSelection } from './retrieve-selection.js';

export type UnresolvedRetrieveSelector = {
  contentType: RetrieveContentType;
  kind: 'api-name' | 'content-key-or-id';
  /** Exact requested selector, never a fabricated API name. */
  selector: string;
  reason: 'missing' | 'ambiguous';
  /** Observed matching parents, including when none has the requested language. */
  parentIds: string[];
};
export type NativeRetrieveResolution = {
  workspaceId: string;
  language: string;
  apiVersion: string;
  /** Native inventory order; each variant occurs once regardless of selector overlap. */
  variants: NativeInventoryRow[];
  unresolved: UnresolvedRetrieveSelector[];
  inventory: {
    complete: true;
    pagesRequested: number;
    recordCount: number;
    contentTypes: RetrieveContentType[];
    scope: 'principal-visible-nondeleted-family-all-languages-and-statuses';
  };
};
export type ResolveNativeRetrieveInput = {
  workspaceId: string;
  language: string;
  selection: RetrieveSelection;
};

/**
 * Resolve exact selectors only after exhaustive native terminal/count/repeat verification.
 * @param {Pick<Connection, 'request' | 'getApiVersion'>} connection - Selected source connection.
 * @param {ResolveNativeRetrieveInput} input - Explicit workspace, language and normalized selectors.
 * @param {NativeInventoryOptions} options - Bounded native read timeout/cancellation options.
 * @returns {Promise<NativeRetrieveResolution>} Native variants and explicit unresolved member failures.
 */
export async function resolveNativeRetrieveSelection(
  connection: Pick<Connection, 'request' | 'getApiVersion'>,
  input: ResolveNativeRetrieveInput,
  options: NativeInventoryOptions = {},
): Promise<NativeRetrieveResolution> {
  if (typeof input.language !== 'string' || input.language.trim().length === 0)
    throw new TypeError('Native retrieve resolution requires an explicit language');
  const contentTypes = [...new Set(input.selection.groups.map((group) => group.contentType))];
  const inventory = await enumerateNativeFamily(
    connection,
    input.workspaceId,
    contentTypes,
    options,
  );
  const selected = new Set<string>();
  const unresolved: UnresolvedRetrieveSelector[] = [];
  for (const group of input.selection.groups) {
    const family = inventory.records.filter(
      (row) => row.ContentTypeFullyQualifiedName === group.contentType,
    );
    if (group.all)
      for (const row of family) if (row.Language === input.language) selected.add(row.Id);
    for (const kind of ['api-name', 'content-key-or-id'] as const) {
      const selectors = kind === 'api-name' ? group.apiNames : group.contentKeysOrIds;
      for (const selector of selectors) {
        // Parent identity only: a variant ID is never interpreted as a parent selector.
        const matches = family.filter((row) =>
          kind === 'api-name'
            ? row.ManagedContent.ApiName === selector
            : row.ManagedContentKey === selector || row.ManagedContentId === selector,
        );
        const parentIds = [...new Set(matches.map((row) => row.ManagedContentId))];
        const localized = matches.filter((row) => row.Language === input.language);
        if (parentIds.length !== 1 || localized.length === 0) {
          unresolved.push({
            contentType: group.contentType,
            kind,
            selector,
            reason: parentIds.length > 1 ? 'ambiguous' : 'missing',
            parentIds,
          });
          continue;
        }
        for (const row of localized) selected.add(row.Id);
      }
    }
  }
  return {
    workspaceId: inventory.workspaceId,
    language: input.language,
    apiVersion: inventory.apiVersion,
    variants: inventory.records.filter((row) => selected.has(row.Id)),
    unresolved,
    inventory: {
      complete: inventory.complete,
      pagesRequested: inventory.pagesRequested,
      recordCount: inventory.records.length,
      contentTypes,
      scope: 'principal-visible-nondeleted-family-all-languages-and-statuses',
    },
  };
}
