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

/**
 * Validate folder evidence IDs and expand case-sensitive 15-character IDs without case folding.
 * @param {unknown} value - Salesforce identity from caller or API evidence.
 * @param {string} prefix - Required object key prefix.
 * @returns {string} Identity in 18-character form, retaining existing API IDs verbatim.
 */
export function canonicalFolderEvidenceId(value: unknown, prefix: string): string {
  if (
    typeof value !== 'string' ||
    !new RegExp(`^${prefix}[A-Za-z0-9]{12}(?:[A-Z0-5]{3})?$`, 'u').test(value)
  )
    throw new TypeError('Invalid folder evidence identity');
  if (value.length === 18) return value;
  let suffix = '';
  for (let start = 0; start < 15; start += 5) {
    let mask = 0;
    for (let offset = 0; offset < 5; offset += 1) {
      if (/[A-Z]/u.test(value[start + offset])) mask += 2 ** offset;
    }
    suffix += 'ABCDEFGHIJKLMNOPQRSTUVWXYZ012345'[mask];
  }
  return value + suffix;
}

function folderId(value: unknown): string | null {
  if (value === null) return null;
  if (!record(value)) throw new TypeError('Missing content folder evidence');
  return canonicalFolderEvidenceId(value.id, '9Pu');
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
  canonicalFolderEvidenceId(workspace.id, '0Zu');
  const rootId = canonicalFolderEvidenceId(workspace.rootFolderId, '9Pu');
  const selectedId = folderId(variantFolder);
  if (selectedId !== folderId(parentFolder))
    throw new TypeError('Variant and parent folder identities disagree');
  if (selectedId === null || selectedId === rootId) return [];

  const proof = await acquireContextualFolderEvidence(connection, workspace, selectedId, options);
  return proof.path;
}

export type ContextualFolderEvidence = {
  id: string;
  path: string[];
  ancestry: Record<string, unknown>[];
};

/**
 * Validate exact contextual folder detail against an independently bound workspace root.
 * @param {object} connection - Read-only transport.
 * @param {object} workspace - Independently acquired workspace identity and root.
 * @param {string} workspace.id - Bound workspace identity.
 * @param {string} workspace.rootFolderId - Bound workspace root identity.
 * @param {string} selectedId - Exact destination-local folder identifier.
 * @param {JsonRequestOptions} options - Bounded request options.
 * @param {boolean} strictSharing - Require explicit non-sharing on every ancestor.
 * @returns {Promise<ContextualFolderEvidence>} Detached placement proof, never name lookup.
 */
export async function acquireContextualFolderEvidence(
  connection: Pick<Connection, 'request'>,
  workspace: { id: string; rootFolderId: string },
  selectedId: string,
  options: JsonRequestOptions = {},
  strictSharing = false,
): Promise<ContextualFolderEvidence> {
  const workspaceId = canonicalFolderEvidenceId(workspace.id, '0Zu');
  const rootId = canonicalFolderEvidenceId(workspace.rootFolderId, '9Pu');
  selectedId = canonicalFolderEvidenceId(selectedId, '9Pu');
  // The context parameter makes the documented ordered ancestry relative to this workspace.
  const { data } = await requestJson<unknown>(
    connection,
    getSelectedOperation('folder.get'),
    { path: { folderId: selectedId }, query: { contextContentSpaceId: workspaceId } },
    options,
  );
  if (
    !record(data) ||
    canonicalFolderEvidenceId(data.id, '9Pu') !== selectedId ||
    data.folderType !== (selectedId === rootId ? 'System' : 'Standard') ||
    data.isShared !== false ||
    !Array.isArray(data.folderHierarchy) ||
    (selectedId !== rootId && data.folderHierarchy.length === 0) ||
    (selectedId === rootId && data.folderHierarchy.length > 0)
  )
    throw new TypeError('Incomplete or unsupported folder detail evidence');
  const hierarchy: unknown[] = [...data.folderHierarchy, data];
  const seen = new Set<string>();
  const names: string[] = [];
  let previousId: string | undefined;
  for (const [index, entry] of hierarchy.entries()) {
    if (!record(entry)) throw new TypeError('Invalid folder hierarchy entry');
    const id = canonicalFolderEvidenceId(entry.id, '9Pu');
    if (
      (strictSharing ? entry.isShared !== false : entry.isShared === true) ||
      (entry.contentSpaceId !== undefined &&
        canonicalFolderEvidenceId(entry.contentSpaceId, '0Zu') !== workspaceId) ||
      (entry.contentSpace !== undefined &&
        (!record(entry.contentSpace) ||
          canonicalFolderEvidenceId(entry.contentSpace.id, '0Zu') !== workspaceId))
    )
      throw new TypeError('Folder sharing or workspace evidence is ambiguous');
    if (seen.has(id)) throw new TypeError('Repeated folder hierarchy identity');
    seen.add(id);
    if (index === 0) {
      if (
        id !== rootId ||
        entry.folderType !== 'System' ||
        (strictSharing && entry.parentFolderId !== undefined && entry.parentFolderId !== null)
      )
        throw new TypeError('Folder hierarchy is outside the workspace root');
    } else {
      if (
        canonicalFolderEvidenceId(entry.parentFolderId, '9Pu') !== previousId ||
        entry.folderType !== 'Standard'
      )
        throw new TypeError('Folder hierarchy parent identity disagreement');
      sourcePathSegment(entry.name);
      names.push(entry.name);
    }
    previousId = id;
  }
  return { id: selectedId, path: names, ancestry: structuredClone(hierarchy) as Folder[] };
}
