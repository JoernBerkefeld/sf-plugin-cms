import type { Connection } from '@salesforce/core';
import { isDeepStrictEqual } from 'node:util';
import { sourcePathSegment } from '../contracts/source-definition.js';
import {
  getSelectedOperation,
  requestJson,
  type JsonRequestOptions,
} from '../transport/json-request.js';
import { acquireContextualFolderEvidence } from './acquire-folder-evidence.js';

const PAGE_LIMIT = 3;
const PAGE_SIZE = 250;
const guidance =
  'Use --destination-folder-id emailFragment:ApiName=9Pu... with validated destination ancestry.';
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const identifier = (value: unknown, prefix: string): boolean =>
  typeof value === 'string' &&
  new RegExp(`^${prefix}[A-Za-z0-9]{12}(?:[A-Z0-5]{3})?$`, 'u').test(value);

function inconclusive(reason: string): never {
  throw new TypeError(`Fragment folder-name investigation inconclusive: ${reason}. ${guidance}`);
}

/**
 * Investigate only the first unresolved segment, without granting placement authority.
 * Three pages and at most two contextual detail GETs are the entire request budget.
 * No documented terminal rule exists, so even an observed single match cannot authorize descent.
 * @param {object} connection - Original version-aware destination read transport.
 * @param {object} workspace - Independently bound workspace and root.
 * @param {string} workspace.id - Exact destination workspace ID.
 * @param {string} workspace.rootFolderId - Independently bound root folder ID.
 * @param {readonly string[]} sourcePath - Exact portable segments, never case-folded.
 * @param {JsonRequestOptions} options - Existing cancellation and timeout options.
 * @returns {Promise<never>} Always blocks automatic placement with an actionable diagnostic.
 */
export async function investigateFolderName(
  connection: Pick<Connection, 'request'>,
  workspace: { id: string; rootFolderId: string },
  sourcePath: readonly string[],
  options: JsonRequestOptions = {},
): Promise<never> {
  for (const segment of sourcePath) sourcePathSegment(segment);
  if (
    sourcePath.length === 0 ||
    !identifier(workspace.id, '0Zu') ||
    !identifier(workspace.rootFolderId, '9Pu')
  )
    throw new TypeError('Invalid folder investigation identity/path');
  const seen = new Map<string, Record<string, unknown>>();
  const pages: unknown[] = [];
  const candidates = new Set<string>();
  for (let page = 0; page < PAGE_LIMIT; page++) {
    const { data } = await requestJson<unknown>(
      connection,
      getSelectedOperation('folder.items.list'),
      {
        path: { folderId: workspace.rootFolderId },
        query: {
          itemType: 'Folders',
          page,
          pageSize: PAGE_SIZE,
          includeSharedWithSpaceFolder: false,
        },
      },
      options,
    );
    if (
      !record(data) ||
      data.folderId !== workspace.rootFolderId ||
      data.parentFolderId !== null ||
      !Array.isArray(data.folderItems) ||
      data.folderItems.length > PAGE_SIZE
    )
      inconclusive('invalid folder collection identity, parent or shape');
    const rows: unknown[] = data.folderItems;
    if (pages.some((previous) => isDeepStrictEqual(previous, rows)))
      inconclusive('repeated page evidence cannot establish completion');
    pages.push(structuredClone(rows));
    for (const row of rows) {
      if (
        !record(row) ||
        row.isFolder !== true ||
        typeof row.title !== 'string' ||
        !identifier(row.managedContentOrFolderId, '9Pu') ||
        !record(row.folderSummary) ||
        !['Standard', 'System', 'SharedWithSpace'].includes(String(row.folderSummary.folderType)) ||
        typeof row.folderSummary.isShared !== 'boolean'
      )
        inconclusive('invalid folder row or folder classification');
      const id = row.managedContentOrFolderId as string;
      const previous = seen.get(id);
      if (previous)
        inconclusive(
          isDeepStrictEqual(previous, row)
            ? 'repeated folder identity'
            : 'changing folder evidence',
        );
      seen.set(id, structuredClone(row));
      if (
        row.folderSummary.folderType === 'Standard' &&
        row.folderSummary.isShared === false &&
        row.title === sourcePath[0]
      )
        candidates.add(id);
    }
  }
  let verified = 0;
  for (const id of candidates) {
    const proof = await acquireContextualFolderEvidence(connection, workspace, id, options, true);
    if (!isDeepStrictEqual(proof.path, [sourcePath[0]]))
      inconclusive('candidate title, parentage or root ancestry changed');
    verified++;
    if (verified > 1)
      throw new TypeError(
        `Ambiguous Fragment folder name: duplicate eligible siblings across bounded pages. ${guidance}`,
      );
  }
  inconclusive(
    `${verified} matching candidate(s) observed; no authoritative pagination completion contract, including for short or empty pages; automatic path resolution is unqualified`,
  );
}
