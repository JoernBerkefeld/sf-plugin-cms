import { CmsError } from '../errors/registry.js';
import {
  getSelectedOperation,
  isRecord,
  requestJson,
  type OperationParameterValues,
  type RequestConnection,
} from '../transport/json-request.js';

/** A CMS workspace as the plugin reports it. `apiName` is null for non-enhanced workspaces. */
export type CmsWorkspace = {
  id: string;
  apiName: string | null;
  name: string;
  type: string;
  enhanced: boolean | null;
  defaultLanguage: string | null;
  rootFolderId: string | null;
};

/** A channel assigned to a workspace. */
export type CmsChannel = {
  id: string;
  name: string;
  type: string;
};

// Guards the paging loop against an API that keeps answering; real orgs need a few pages.
const PAGE_LIMIT = 1000;

function text(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' ? value : null;
}

/**
 * Read every page of a list operation until a page is empty or `nextPageUrl` is null.
 * @param {RequestConnection} connection - Org connection.
 * @param {'workspace.list' | 'workspace.channel.list'} operationKey - List operation.
 * @param {OperationParameterValues} path - Path values.
 * @param {(data: Record<string, unknown>) => unknown} itemsOf - Item array of one page.
 * @returns {Promise<Array<Record<string, unknown>>>} Items in order, each ID once.
 */
async function readAllPages(
  connection: RequestConnection,
  operationKey: 'workspace.list' | 'workspace.channel.list',
  path: OperationParameterValues,
  itemsOf: (data: Record<string, unknown>) => unknown,
): Promise<Array<Record<string, unknown>>> {
  const items = new Map<string, Record<string, unknown>>();
  for (let page = 0; page < PAGE_LIMIT; page += 1) {
    const { data } = await requestJson<unknown>(connection, getSelectedOperation(operationKey), {
      path,
      query: { page },
    });
    const records = isRecord(data) ? itemsOf(data) : undefined;
    if (!Array.isArray(records) || !records.every((record) => isRecord(record)))
      throw new CmsError('UNEXPECTED_RESPONSE', `${operationKey} page ${page} has no item list`);
    let added = 0;
    for (const record of records as Array<Record<string, unknown>>) {
      const id = text(record, 'id');
      if (!id) throw new CmsError('UNEXPECTED_RESPONSE', `${operationKey} item without an ID`);
      if (!items.has(id)) {
        items.set(id, record);
        added += 1;
      }
    }
    if (records.length === 0 || added === 0 || (isRecord(data) && data.nextPageUrl === null))
      return [...items.values()];
  }
  throw new CmsError(
    'UNEXPECTED_RESPONSE',
    `${operationKey} did not end after ${PAGE_LIMIT} pages`,
  );
}

function toWorkspace(record: Record<string, unknown>): CmsWorkspace {
  const spaceType = isRecord(record.spaceType) ? text(record.spaceType, 'apiName') : null;
  return {
    id: text(record, 'id')!,
    apiName: text(record, 'apiName'),
    name: text(record, 'name') ?? '',
    type: spaceType ?? '',
    enhanced: typeof record.isEnhancedSpace === 'boolean' ? record.isEnhancedSpace : null,
    defaultLanguage: text(record, 'defaultLanguage'),
    rootFolderId: text(record, 'rootFolderId'),
  };
}

/**
 * All CMS workspaces the user can see.
 * @param {RequestConnection} connection - Org connection.
 * @returns {Promise<CmsWorkspace[]>} Workspaces.
 */
export async function listWorkspaces(connection: RequestConnection): Promise<CmsWorkspace[]> {
  const records = await readAllPages(connection, 'workspace.list', {}, (data) => data.spaces);
  return records.map((record) => toWorkspace(record));
}

/**
 * Find one workspace by API name (case-sensitive) or ID.
 * @param {RequestConnection} connection - Org connection.
 * @param {string} apiNameOrId - `--workspace` value.
 * @returns {Promise<CmsWorkspace>} The workspace.
 */
export async function resolveWorkspace(
  connection: RequestConnection,
  apiNameOrId: string,
): Promise<CmsWorkspace> {
  const workspaces = await listWorkspaces(connection);
  const byId = workspaces.filter(
    (workspace) =>
      workspace.id === apiNameOrId ||
      (apiNameOrId.length === 15 && workspace.id.startsWith(apiNameOrId)),
  );
  const matches = byId.length > 0 ? byId : workspaces.filter((w) => w.apiName === apiNameOrId);
  if (matches.length === 0)
    throw new CmsError('WORKSPACE_NOT_FOUND', `No CMS workspace ${apiNameOrId} in this org`);
  if (matches.length > 1)
    throw new CmsError('WORKSPACE_AMBIGUOUS', `More than one CMS workspace matches ${apiNameOrId}`);
  return matches[0];
}

/**
 * All channels assigned to a workspace.
 * @param {RequestConnection} connection - Org connection.
 * @param {string} workspaceId - Workspace ID.
 * @returns {Promise<CmsChannel[]>} Channels.
 */
export async function listWorkspaceChannels(
  connection: RequestConnection,
  workspaceId: string,
): Promise<CmsChannel[]> {
  const records = await readAllPages(
    connection,
    'workspace.channel.list',
    { contentSpaceId: workspaceId },
    (data) =>
      Array.isArray(data.spaceChannels)
        ? data.spaceChannels.map((entry: unknown) =>
            isRecord(entry) ? entry.channelSummary : entry,
          )
        : undefined,
  );
  return records.map((record) => ({
    id: text(record, 'id')!,
    name: text(record, 'name') ?? '',
    type: text(record, 'type') ?? '',
  }));
}
