import type { DeployLocalSelection } from './deploy-source-selection.js';

export type FragmentDestinationInput = {
  definitionFile: string;
  workspaceId: string;
  destinationFolderId?: string;
};

const folderId = /^9Pu[A-Za-z0-9]{12}(?:[A-Z0-5]{3})?$/u;
const componentKey = /^emailFragment:[A-Za-z][A-Za-z0-9_]*$/u;

/**
 * Parse repeatable exact component-to-destination-folder assignments without org access.
 * @param {ReadonlyArray<string> | undefined} assignments - Repeatable CLI assignments.
 * @returns {Readonly<Record<string, string>> | undefined} Detached exact mapping or no mapping.
 */
export function parseDestinationFolderIds(
  assignments: readonly string[] | undefined,
): Readonly<Record<string, string>> | undefined {
  if (assignments === undefined) return undefined;
  if (!Array.isArray(assignments) || assignments.length === 0)
    throw new TypeError('Destination folder mappings must be nonempty');
  const result: Record<string, string> = {};
  for (const assignment of assignments) {
    const parts = typeof assignment === 'string' ? assignment.split('=') : [];
    const [key, id] = parts;
    if (parts.length !== 2 || !componentKey.test(key) || !folderId.test(id))
      throw new TypeError(
        'Destination folder mapping requires emailFragment:ApiName=9Pu... (15 or 18 characters)',
      );
    if (Object.hasOwn(result, key))
      throw new TypeError(`Duplicate destination folder mapping: ${key}`);
    result[key] = id;
  }
  return Object.freeze(result);
}

/**
 * Bind mappings to the actual guarded selection, never derive selectors from mapping keys.
 * @param {Readonly<Record<string, string>> | undefined} mappings - Caller destination assignments.
 * @param {DeployLocalSelection} selection - Actual guarded local selection.
 */
export function assertDestinationFolderMappings(
  mappings: Readonly<Record<string, string>> | undefined,
  selection: DeployLocalSelection,
): void {
  if (mappings === undefined) return;
  const keys = new Set(
    selection.items
      .filter((item) => item.targetIdentity.contentType === 'sfdc_cms__emailFragment')
      .map((item) => `emailFragment:${item.targetIdentity.apiName}`),
  );
  for (const [key, id] of Object.entries(mappings)) {
    if (!componentKey.test(key) || typeof id !== 'string' || !folderId.test(id))
      throw new TypeError('Invalid destination folder mapping');
    if (!keys.has(key)) throw new TypeError(`Unselected destination folder mapping: ${key}`);
  }
}

/**
 * Resolve an already admitted per-Fragment mapping for fresh operation preparation.
 * @param {Readonly<Record<string, string>> | undefined} mappings - Admitted component mapping.
 * @param {string} apiName - Selected Fragment API name.
 * @returns {string | undefined} Exact folder identifier or existing unmapped behavior.
 */
export function destinationFolderIdFor(
  mappings: Readonly<Record<string, string>> | undefined,
  apiName: string,
): string | undefined {
  return mappings?.[`emailFragment:${apiName}`];
}
