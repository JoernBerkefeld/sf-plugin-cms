import type { Connection } from '@salesforce/core';
import { isDeepStrictEqual } from 'node:util';
import type { JsonRequestOptions } from '../transport/json-request.js';
import { acquireContextualFolderEvidence } from './acquire-folder-evidence.js';
import { sourcePathSegment } from '../contracts/source-definition.js';
import { investigateFolderName } from './investigate-folder-name.js';

/**
 * Resolve explicit placement or investigate unmapped nonroot names without authorizing placement.
 * @param {object} connection - Exact destination transport.
 * @param {object} workspace - Independently bound destination workspace/root.
 * @param {string} workspace.id - Bound workspace identity.
 * @param {string} workspace.rootFolderId - Bound workspace root identity.
 * @param {string[]} sourcePath - Portable authored path, compared exactly.
 * @param {string | undefined} destinationFolderId - Optional destination-local ID.
 * @param {JsonRequestOptions} options - Bounded request options.
 * @returns {Promise<object>} Detached selected ID, path and contextual ancestry.
 */
export async function resolveEmailFragmentFolder(
  connection: Pick<Connection, 'request'>,
  workspace: { id: string; rootFolderId: string },
  sourcePath: readonly string[],
  destinationFolderId: string | undefined,
  options: JsonRequestOptions = {},
) {
  for (const segment of sourcePath) sourcePathSegment(segment);
  if (destinationFolderId === undefined) {
    if (sourcePath.length > 0)
      return investigateFolderName(connection, workspace, sourcePath, options);
    return {
      id: workspace.rootFolderId,
      path: [] as string[],
      ancestry: [] as Record<string, unknown>[],
    };
  }
  const proof = await acquireContextualFolderEvidence(
    connection,
    workspace,
    destinationFolderId,
    options,
    true,
  );
  if (!isDeepStrictEqual(proof.path, sourcePath))
    throw new TypeError('Explicit destination folder ID/path disagreement with source.folderPath');
  return proof;
}

const id = (value: unknown): unknown =>
  value !== null && typeof value === 'object' && !Array.isArray(value) && 'id' in value
    ? value.id
    : undefined;

/**
 * Bind independent native parent and variant folder IDs, normalizing only null/null root evidence.
 * @param {unknown} variantFolder - Independent native variant folder.
 * @param {unknown} parentFolder - Independent native parent folder.
 * @param {string} selectedId - Validated placement ID.
 * @param {string} rootId - Independently bound workspace root ID.
 */
export function assertEmailFragmentNativeFolder(
  variantFolder: unknown,
  parentFolder: unknown,
  selectedId: string,
  rootId: string,
): void {
  if (variantFolder === null && parentFolder === null && selectedId === rootId) return;
  if (id(variantFolder) !== selectedId || id(parentFolder) !== selectedId)
    throw new TypeError('Fragment native folder identity disagrees with validated destination');
}
