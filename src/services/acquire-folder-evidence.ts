import type { Connection } from '@salesforce/core';
import { sourcePathSegment } from '../contracts/source-definition.js';
import {
  getSelectedOperation,
  requestJson,
  type JsonRequestOptions,
} from '../transport/json-request.js';

type Folder = Record<string, unknown>;

function record(value: unknown): value is Folder {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function identifier(value: unknown, prefix: string): string {
  if (
    typeof value !== 'string' ||
    !new RegExp(`^${prefix}[A-Za-z0-9]{12}(?:[A-Z0-5]{3})?$`, 'u').test(value)
  )
    throw new TypeError('Invalid folder evidence identity');
  return value;
}

function folderId(value: unknown): string | null {
  if (value === null) return null;
  if (!record(value)) throw new TypeError('Missing content folder evidence');
  return identifier(value.id, '9Pu');
}

/**
 * Read an ordered portable folder path bound to independently acquired workspace/content evidence.
 * @param {object} connection - Read-only CMS connection.
 * @param {object} workspace - Previously identity-bound workspace detail.
 * @param {string} workspace.id - Bound workspace identity.
 * @param {string} workspace.rootFolderId - Bound workspace root folder identity.
 * @param {unknown} variantFolder - Folder from the selected variant detail.
 * @param {unknown} parentFolder - Folder from the independent parent content detail.
 * @param {object} options - Request cancellation and timeout options.
 * @returns {Promise<string[]>} Names below the workspace root, in ancestor order.
 */
export async function acquireFolderEvidence(
  connection: Pick<Connection, 'request'>,
  workspace: { id: string; rootFolderId: string },
  variantFolder: unknown,
  parentFolder: unknown,
  options: JsonRequestOptions = {},
): Promise<string[]> {
  const workspaceId = identifier(workspace.id, '0Zu');
  const rootId = identifier(workspace.rootFolderId, '9Pu');
  const selectedId = folderId(variantFolder);
  if (selectedId !== folderId(parentFolder))
    throw new TypeError('Variant and parent folder identities disagree');
  if (selectedId === null || selectedId === rootId) return [];

  // The context parameter makes the documented ordered ancestry relative to this workspace.
  const { data } = await requestJson<unknown>(
    connection,
    getSelectedOperation('folder.get'),
    { path: { folderId: selectedId }, query: { contextContentSpaceId: workspaceId } },
    options,
  );
  if (
    !record(data) ||
    data.id !== selectedId ||
    data.folderType !== 'Standard' ||
    data.isShared !== false ||
    !Array.isArray(data.folderHierarchy) ||
    data.folderHierarchy.length === 0
  )
    throw new TypeError('Incomplete or unsupported folder detail evidence');
  const hierarchy: unknown[] = [...data.folderHierarchy, data];
  const seen = new Set<string>();
  const names: string[] = [];
  let previousId: string | undefined;
  for (const [index, entry] of hierarchy.entries()) {
    if (!record(entry)) throw new TypeError('Invalid folder hierarchy entry');
    const id = identifier(entry.id, '9Pu');
    if (seen.has(id)) throw new TypeError('Repeated folder hierarchy identity');
    seen.add(id);
    if (index === 0) {
      if (id !== rootId || entry.folderType !== 'System')
        throw new TypeError('Folder hierarchy is outside the workspace root');
    } else {
      if (entry.parentFolderId !== previousId || entry.folderType !== 'Standard')
        throw new TypeError('Folder hierarchy parent identity disagreement');
      sourcePathSegment(entry.name);
      names.push(entry.name);
    }
    previousId = id;
  }
  return names;
}
