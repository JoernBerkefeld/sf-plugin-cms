import { CmsError } from '../errors/registry.js';
import {
  getSelectedOperation,
  isRecord,
  requestJson,
  type RequestConnection,
} from '../transport/json-request.js';
import type { CmsWorkspace } from './workspaces.js';

/**
 * Whether two Salesforce IDs name the same record (15- and 18-character forms both occur).
 * @param {string | null | undefined} left - ID.
 * @param {string | null | undefined} right - ID.
 * @returns {boolean} Same record.
 */
export function sameId(left: string | null | undefined, right: string | null | undefined): boolean {
  return !!left && !!right && left.slice(0, 15) === right.slice(0, 15);
}

/**
 * Logical folder path of a folder: the names below the workspace root, top down; [] for the
 * root. Reads `GET /connect/cms/folders/{id}`, whose `folderHierarchy` lists the ancestors from
 * the root (`folderType: System`) down to the parent.
 * @param {RequestConnection} connection - Org connection.
 * @param {CmsWorkspace} workspace - Workspace of the folder.
 * @param {string | undefined} folderId - Folder ID of the variant (absent = root).
 * @returns {Promise<string[]>} Folder names.
 */
export async function folderPathOf(
  connection: RequestConnection,
  workspace: CmsWorkspace,
  folderId: string | undefined,
): Promise<string[]> {
  if (!folderId || sameId(folderId, workspace.rootFolderId)) return [];
  const { data } = await requestJson<unknown>(connection, getSelectedOperation('folder.get'), {
    path: { folderId },
    query: { contextContentSpaceId: workspace.id },
  });
  if (!isRecord(data) || typeof data.name !== 'string')
    throw new CmsError('UNEXPECTED_RESPONSE', `Folder ${folderId} has no name`);
  if (data.folderType === 'System') return [];
  const ancestors = Array.isArray(data.folderHierarchy) ? data.folderHierarchy : [];
  const names = ancestors
    .filter((entry) => isRecord(entry) && entry.folderType !== 'System')
    .map((entry) => String((entry as Record<string, unknown>).name));
  return [...names, data.name];
}

/**
 * Cache of folder paths per folder ID for one run.
 * @param {RequestConnection} connection - Org connection.
 * @param {CmsWorkspace} workspace - Workspace.
 * @returns {(folderId: string | undefined) => Promise<string[]>} Cached lookup.
 */
export function folderPathCache(
  connection: RequestConnection,
  workspace: CmsWorkspace,
): (folderId: string | undefined) => Promise<string[]> {
  const cache = new Map<string, Promise<string[]>>();
  return (folderId) => {
    const key = folderId?.slice(0, 15) ?? '';
    let entry = cache.get(key);
    if (!entry) {
      entry = folderPathOf(connection, workspace, folderId);
      cache.set(key, entry);
    }
    return entry;
  };
}
