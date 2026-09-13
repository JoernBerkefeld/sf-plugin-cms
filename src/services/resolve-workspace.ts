import type { Connection } from '@salesforce/core';
import type { JsonRequestOptions } from '../transport/json-request.js';
import { getWorkspace, listWorkspaces, type CmsRecord } from './read.js';

const WORKSPACE_PAGE_SIZE = 100;
const WORKSPACE_PAGE_CAP = 1000;

type RequestConnection = Pick<Connection, 'request'>;

export type WorkspaceSelector = {
  readonly workspaceId?: string;
  readonly workspaceName?: string;
};

export type ResolvedWorkspace = {
  readonly id: string;
  readonly workspace: CmsRecord;
};

function nonemptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function workspaceIdentity(value: CmsRecord): { id: string; name: string } | undefined {
  return nonemptyString(value.id) && nonemptyString(value.name)
    ? { id: value.id, name: value.name }
    : undefined;
}

async function validatedWorkspace(
  connection: RequestConnection,
  workspaceId: string,
  options: JsonRequestOptions,
): Promise<ResolvedWorkspace> {
  const workspace = await getWorkspace(connection, workspaceId, options);
  if (workspace.id !== workspaceId) {
    throw new Error(
      `Workspace validation returned ID ${String(workspace.id)} instead of selected ID ${workspaceId}.`,
    );
  }
  return { id: workspaceId, workspace };
}

export function assertWorkspaceSelector(selector: WorkspaceSelector): void {
  const hasId = nonemptyString(selector.workspaceId);
  const hasName = nonemptyString(selector.workspaceName);
  if (hasId === hasName) {
    throw new Error('Specify exactly one of --workspace-id or --workspace-name.');
  }
}

export async function resolveWorkspace(
  connection: RequestConnection,
  selector: WorkspaceSelector,
  options: JsonRequestOptions = {},
): Promise<ResolvedWorkspace> {
  assertWorkspaceSelector(selector);
  if (nonemptyString(selector.workspaceId)) {
    return validatedWorkspace(connection, selector.workspaceId, options);
  }

  const requestedName = selector.workspaceName!;
  const matches = new Map<string, CmsRecord>();
  const observedIds = new Set<string>();
  const pageFingerprints = new Set<string>();

  for (let page = 0; page < WORKSPACE_PAGE_CAP; page += 1) {
    const response = await listWorkspaces(
      connection,
      { nameFragment: requestedName, page, pageSize: WORKSPACE_PAGE_SIZE },
      options,
    );
    const identities = response.items
      .map((item) => workspaceIdentity(item))
      .filter((value) => value !== undefined);
    const fingerprint = JSON.stringify(identities.map(({ id, name }) => [id, name]));
    if (pageFingerprints.has(fingerprint) && identities.length > 0) {
      throw new Error(`Workspace listing repeated a page while resolving name ${requestedName}.`);
    }
    pageFingerprints.add(fingerprint);

    let additions = 0;
    for (const identity of identities) {
      if (!observedIds.has(identity.id)) {
        observedIds.add(identity.id);
        additions += 1;
      }
      if (identity.name === requestedName) matches.set(identity.id, identity);
    }

    if (response.items.length === 0) break;
    if (additions === 0) {
      throw new Error(`Workspace listing made no progress while resolving name ${requestedName}.`);
    }

    const trustworthyPage = response.page === page && response.pageSize === WORKSPACE_PAGE_SIZE;
    const advertisedComplete =
      trustworthyPage &&
      response.total !== undefined &&
      response.total >= observedIds.size &&
      observedIds.size >= response.total;
    if (advertisedComplete && response.items.length < WORKSPACE_PAGE_SIZE) break;

    if (page === WORKSPACE_PAGE_CAP - 1) {
      throw new Error(`Workspace listing exceeded the ${WORKSPACE_PAGE_CAP}-page safety limit.`);
    }
  }

  if (matches.size === 0) throw new Error(`No workspace has the exact name ${requestedName}.`);
  if (matches.size > 1) {
    throw new Error(
      `Workspace name ${requestedName} is ambiguous across IDs: ${[...matches.keys()].toSorted().join(', ')}. Use --workspace-id.`,
    );
  }
  return validatedWorkspace(connection, [...matches.keys()][0], options);
}
