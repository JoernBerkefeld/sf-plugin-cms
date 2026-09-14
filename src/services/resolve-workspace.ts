import type { Connection } from '@salesforce/core';
import type { JsonRequestOptions } from '../transport/json-request.js';
import { getWorkspace, listWorkspaces, type CmsRecord } from './read.js';

const WORKSPACE_PAGE_SIZE = 250;
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

export type WorkspaceSummary = {
  readonly id: string;
  readonly name?: string;
};

function nonemptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function folded(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('en-US');
}

function workspaceSummary(value: CmsRecord, page: number): WorkspaceSummary {
  if (!nonemptyString(value.id)) {
    throw new Error(
      `Workspace listing page ${page} contains an item with a missing or malformed ID.`,
    );
  }
  return {
    id: value.id,
    ...(nonemptyString(value.name) ? { name: value.name } : {}),
  };
}

export async function enumerateWorkspaces(
  connection: RequestConnection,
  options: JsonRequestOptions = {},
  query: Readonly<Record<string, string | number>> = {},
): Promise<WorkspaceSummary[]> {
  const workspaces = new Map<string, WorkspaceSummary>();
  const foldedIds = new Map<string, string>();
  const pageFingerprints = new Set<string>();

  for (let page = 0; page < WORKSPACE_PAGE_CAP; page += 1) {
    const response = await listWorkspaces(
      connection,
      { ...query, page, pageSize: WORKSPACE_PAGE_SIZE },
      options,
    );
    if (response.items.length === 0) return [...workspaces.values()];

    const summaries = response.items.map((item) => workspaceSummary(item, page));
    const fingerprint = JSON.stringify(summaries.map(({ id, name }) => [id, name ?? '']));
    if (pageFingerprints.has(fingerprint)) {
      throw new Error(`Workspace listing repeated page content at page ${page}.`);
    }
    pageFingerprints.add(fingerprint);

    let additions = 0;
    for (const summary of summaries) {
      const foldedId = folded(summary.id);
      const existingCasing = foldedIds.get(foldedId);
      if (existingCasing !== undefined && existingCasing !== summary.id) {
        throw new Error(
          `Workspace IDs ${existingCasing} and ${summary.id} differ only by case or Unicode normalization and are ambiguous.`,
        );
      }
      foldedIds.set(foldedId, summary.id);
      if (!workspaces.has(summary.id)) {
        workspaces.set(summary.id, summary);
        additions += 1;
      }
    }
    if (additions === 0) {
      throw new Error(`Workspace listing made no progress at page ${page}.`);
    }
  }

  throw new Error(`Workspace listing exceeded the ${WORKSPACE_PAGE_CAP}-page safety limit.`);
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
  const requestedFoldedName = folded(requestedName);
  const listed = await enumerateWorkspaces(connection, options, { nameFragment: requestedName });
  const matches = listed.filter(
    ({ name }) => name !== undefined && folded(name) === requestedFoldedName,
  );

  if (matches.length === 0) {
    throw new Error(`No workspace has the exact case-insensitive name ${requestedName}.`);
  }
  if (matches.length > 1) {
    throw new Error(
      `Workspace name ${requestedName} is ambiguous across IDs: ${matches
        .map(({ id }) => id)
        .toSorted()
        .join(', ')}. Use --workspace-id.`,
    );
  }
  return validatedWorkspace(connection, matches[0].id, options);
}
