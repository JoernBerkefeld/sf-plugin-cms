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

// Folder items per page; the end is the first short page (the answer has no next-page link).
const FOLDER_PAGE_SIZE = 100;

/** A child folder as `folder-items?itemType=Folders` lists it. */
export type ChildFolder = { id: string; name: string; folderType: string | null };

/**
 * Child folders of a folder, every page (`GET /connect/cms/folders/{id}/folder-items`, v68).
 * @param {RequestConnection} connection - Org connection.
 * @param {string} folderId - Parent folder ID.
 * @returns {Promise<ChildFolder[]>} Child folders in API order.
 */
export async function childFolders(
  connection: RequestConnection,
  folderId: string,
): Promise<ChildFolder[]> {
  const children: ChildFolder[] = [];
  for (let page = 0; ; page += 1) {
    const { data } = await requestJson<unknown>(
      connection,
      getSelectedOperation('folder.items.list'),
      {
        path: { folderId },
        query: { itemType: 'Folders', page, pageSize: FOLDER_PAGE_SIZE },
      },
    );
    const items = isRecord(data) ? data.folderItems : undefined;
    if (!Array.isArray(items))
      throw new CmsError('UNEXPECTED_RESPONSE', `Folder ${folderId} items without folderItems`);
    for (const item of items)
      if (
        isRecord(item) &&
        item.isFolder === true &&
        typeof item.managedContentOrFolderId === 'string'
      )
        children.push({
          id: item.managedContentOrFolderId,
          name: String(item.title),
          folderType:
            isRecord(item.folderSummary) && typeof item.folderSummary.folderType === 'string'
              ? item.folderSummary.folderType
              : null,
        });
    if (items.length < FOLDER_PAGE_SIZE) return children;
  }
}

/**
 * Folder ID of a logical folder path in a workspace, found by walking the tree from the root by
 * name. Cached per run.
 * @param {RequestConnection} connection - Org connection.
 * @param {CmsWorkspace} workspace - Destination workspace.
 * @returns {(folderPath: string[]) => Promise<string>} Lookup; FOLDER_NOT_FOUND or
 *   FOLDER_AMBIGUOUS when a name does not match exactly one folder.
 */
export function folderIdCache(
  connection: RequestConnection,
  workspace: CmsWorkspace,
): (folderPath: string[]) => Promise<string> {
  const children = new Map<string, Promise<ChildFolder[]>>();
  return async (folderPath) => {
    if (!workspace.rootFolderId)
      throw new CmsError('UNEXPECTED_RESPONSE', `Workspace ${workspace.id} has no root folder`);
    let current = workspace.rootFolderId;
    for (const [depth, name] of folderPath.entries()) {
      const key = current.slice(0, 15);
      let list = children.get(key);
      if (!list) {
        list = childFolders(connection, current);
        children.set(key, list);
      }
      const listed = await list;
      const matches = listed.filter(
        (folder) => folder.name === name && folder.folderType !== 'System',
      );
      const where = `/${folderPath.slice(0, depth + 1).join('/')}`;
      if (matches.length === 0)
        throw new CmsError(
          'FOLDER_NOT_FOUND',
          `Folder ${where} does not exist in workspace ${workspace.apiName ?? workspace.id}`,
        );
      if (matches.length > 1)
        throw new CmsError(
          'FOLDER_AMBIGUOUS',
          `${matches.length} folders are named ${where} in workspace ${workspace.apiName ?? workspace.id}`,
        );
      current = matches[0].id;
    }
    return current;
  };
}
