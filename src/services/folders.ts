import { CmsError } from '../errors/registry.js';
import {
  getSelectedOperation,
  isRecord,
  requestJson,
  type RequestConnection,
} from '../transport/json-request.js';
import { requestJsonMutation, type JsonMutationOptions } from '../transport/json-mutation.js';
import type { WriteConnection } from '../transport/one-shot-connection.js';
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

const where = (folderPath: string[], depth: number): string =>
  `/${folderPath.slice(0, depth + 1).join('/')}`;

/** Where a logical folder path stands in the destination: the deepest existing folder and the names below it that do not exist yet ([] = the path exists; `folderId` is its folder). */
export type FolderPlan = { folderId: string; missing: string[] };

/** A folder a deploy created: its logical path (`/A/B`) and ID. */
export type CreatedFolder = { path: string; id: string };

/** Plans and creates the folders of logical folder paths in one workspace, cached per run. */
export type FolderPlanner = {
  /** Walk the path by name; FOLDER_AMBIGUOUS when a name matches several folders. */
  plan(folderPath: string[]): Promise<FolderPlan>;
  /**
   * The folder ID of the path, creating each missing folder (`POST /connect/cms/folders`); every
   * folder created is pushed to `created` as soon as Salesforce answered.
   */
  ensure(
    folderPath: string[],
    created: CreatedFolder[],
    options?: JsonMutationOptions,
  ): Promise<string>;
};

/**
 * Folder planner of a workspace: walks the destination tree from the root by name (exact names,
 * System folders skipped) and creates missing folders one level at a time. A folder created in
 * the run is found by later lookups of the same run.
 * @param {RequestConnection & WriteConnection} connection - Org connection.
 * @param {CmsWorkspace} workspace - Destination workspace.
 * @returns {FolderPlanner} Planner.
 */
export function folderPlanner(
  connection: RequestConnection & WriteConnection,
  workspace: CmsWorkspace,
): FolderPlanner {
  const children = new Map<string, Promise<ChildFolder[]>>();
  const listOf = (folderId: string): Promise<ChildFolder[]> => {
    const key = folderId.slice(0, 15);
    let list = children.get(key);
    if (!list) {
      list = childFolders(connection, folderId);
      children.set(key, list);
    }
    return list;
  };
  const plan = async (folderPath: string[]): Promise<FolderPlan> => {
    if (!workspace.rootFolderId)
      throw new CmsError('UNEXPECTED_RESPONSE', `Workspace ${workspace.id} has no root folder`);
    let current = workspace.rootFolderId;
    for (const [depth, name] of folderPath.entries()) {
      const listed = await listOf(current);
      const matches = listed.filter(
        (folder) => folder.name === name && folder.folderType !== 'System',
      );
      if (matches.length === 0) return { folderId: current, missing: folderPath.slice(depth) };
      if (matches.length > 1)
        throw new CmsError(
          'FOLDER_AMBIGUOUS',
          `${matches.length} folders are named ${where(folderPath, depth)} in workspace ${workspace.apiName ?? workspace.id}`,
        );
      current = matches[0].id;
    }
    return { folderId: current, missing: [] };
  };
  const ensure: FolderPlanner['ensure'] = async (folderPath, created, options = {}) => {
    const planned = await plan(folderPath);
    let current = planned.folderId;
    const existing = folderPath.length - planned.missing.length;
    for (const [index, name] of planned.missing.entries()) {
      const { data } = await requestJsonMutation<unknown>(
        connection,
        getSelectedOperation('folder.create'),
        { name, parentFolderId: current },
        {},
        options,
      );
      if (!isRecord(data) || typeof data.id !== 'string')
        throw new CmsError('UNEXPECTED_RESPONSE', `Folder ${name} was created without an ID`);
      const listed = await listOf(current);
      children.set(
        current.slice(0, 15),
        Promise.resolve([...listed, { id: data.id, name, folderType: 'Standard' }]),
      );
      children.set(data.id.slice(0, 15), Promise.resolve([]));
      created.push({ path: where(folderPath, existing + index), id: data.id });
      current = data.id;
    }
    return current;
  };
  return { plan, ensure };
}
