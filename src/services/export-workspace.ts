import type { Connection } from '@salesforce/core';
import { mkdir, open, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import {
  getSelectedOperation,
  requestJson,
  type JsonRequestOptions,
} from '../transport/json-request.js';
import { getVariant, type CmsRecord } from './read.js';

const PAGE_SIZE = 250;
const ABSOLUTE_PAGE_CAP = 1000;

export type WorkspaceExportWarning = {
  code:
    | 'COUNT_MISMATCH'
    | 'DETAIL_FAILED'
    | 'DUPLICATE_VARIANTS'
    | 'OWNERSHIP_MISMATCH'
    | 'PREMATURE_EMPTY_PAGE'
    | 'UNSUPPORTED_WILDCARD';
  message: string;
  variantIds?: string[];
};

export type WorkspaceExportEntry = {
  file: string;
  variantId: string;
};

export type WorkspaceExportManifest = {
  schemaVersion: 1;
  mode: 'experimental-best-effort';
  workspaceId: string;
  search: {
    contentSpaceOrFolderIds: [string];
    languages: ['All'];
    pageSize: 250;
    queryTerm: '*';
  };
  expectedCount: number;
  foundCount: number;
  exportedCount: number;
  pagesRequested: number;
  entries: WorkspaceExportEntry[];
  rejectedVariantIds: string[];
  failedVariantIds: string[];
  warnings: WorkspaceExportWarning[];
};

export type ExportWorkspaceResult = {
  destination: string;
  manifest: WorkspaceExportManifest;
};

type RequestConnection = Pick<Connection, 'request'>;
type SearchRow = { id: string; managedContentSpaceId: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonemptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function responseItems(value: unknown): unknown[] {
  return isRecord(value) && Array.isArray(value.items) ? value.items : [];
}

function responseCount(value: unknown): number {
  if (!isRecord(value)) return 0;
  for (const key of ['total', 'totalCount', 'count']) {
    const count = value[key];
    if (typeof count === 'number' && Number.isInteger(count) && count >= 0) return count;
  }
  return 0;
}

function searchRow(value: unknown): SearchRow | undefined {
  if (!isRecord(value)) return undefined;
  return value.type === 'ManagedContentVariantSearchResultRepresentation' &&
    nonemptyString(value.id) &&
    nonemptyString(value.managedContentSpaceId)
    ? { id: value.id, managedContentSpaceId: value.managedContentSpaceId }
    : undefined;
}

function detailWorkspaceId(detail: CmsRecord): string | undefined {
  const contentSpace = detail.contentSpace;
  return isRecord(contentSpace) && nonemptyString(contentSpace.id) ? contentSpace.id : undefined;
}

function jsonBytes(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu;

export function safeWorkspaceDirectoryName(workspaceName: string): string {
  const replaced = [...workspaceName]
    .map((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 31 || codePoint === 127 || /[\\/<>:"|?*]/u.test(character)
        ? '_'
        : character;
    })
    .join('');
  const safeName = replaced.replaceAll(/[. ]+$/gu, '');
  if (
    safeName.length === 0 ||
    safeName === '.' ||
    safeName === '..' ||
    WINDOWS_RESERVED_NAME.test(safeName)
  ) {
    throw new Error(
      `Workspace name ${workspaceName} cannot be used as a portable directory name. Pass --output-dir explicitly.`,
    );
  }
  return safeName;
}

export function defaultWorkspaceDestination(workspaceName: string): string {
  return path.join('.', 'cms', safeWorkspaceDirectoryName(workspaceName));
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isRecord(error) && error.code === 'ENOENT') return false;
    throw error;
  }
}

async function writeExclusive(path: string, value: unknown): Promise<void> {
  const handle = await open(path, 'wx');
  try {
    await handle.writeFile(jsonBytes(value), 'utf8');
  } finally {
    await handle.close();
  }
}

export async function exportWorkspace(
  connection: RequestConnection,
  workspaceId: string,
  destination: string,
  options: JsonRequestOptions = {},
): Promise<ExportWorkspaceResult> {
  if (!nonemptyString(workspaceId)) throw new TypeError('workspaceId must be a nonempty string');
  if (!nonemptyString(destination)) throw new TypeError('destination must be a nonempty string');
  if (await exists(destination))
    throw new Error(`Export destination already exists: ${destination}`);

  const warnings: WorkspaceExportWarning[] = [
    {
      code: 'UNSUPPORTED_WILDCARD',
      message: 'Wildcard search is unsupported and this export is experimental best-effort.',
    },
  ];
  const rejected = new Set<string>();
  const ownershipMismatchIds = new Set<string>();
  const duplicateIds = new Set<string>();
  const candidates = new Map<string, SearchRow>();
  let expectedCount = 0;
  let pagesRequested = 0;
  let page = 0;
  let pageLimit = 1;

  while (page < pageLimit) {
    const response = await requestJson<unknown>(
      connection,
      getSelectedOperation('workspace.variant.search'),
      {
        query: {
          contentSpaceOrFolderIds: [workspaceId],
          languages: ['All'],
          page,
          pageSize: PAGE_SIZE,
          queryTerm: '*',
        },
      },
      options,
    );
    pagesRequested += 1;
    const items = responseItems(response.data);
    if (page === 0) {
      expectedCount = responseCount(response.data);
      pageLimit = Math.min(
        ABSOLUTE_PAGE_CAP,
        Math.max(1, Math.ceil(expectedCount / PAGE_SIZE) + 2),
      );
    }

    let additions = 0;
    for (const item of items) {
      const row = searchRow(item);
      if (!row) continue;
      if (row.managedContentSpaceId !== workspaceId) {
        rejected.add(row.id);
        ownershipMismatchIds.add(row.id);
        continue;
      }
      if (candidates.has(row.id)) {
        duplicateIds.add(row.id);
      } else {
        candidates.set(row.id, row);
        additions += 1;
      }
    }

    if (candidates.size >= expectedCount) break;
    if (items.length === 0) {
      if (candidates.size < expectedCount) {
        warnings.push({
          code: 'PREMATURE_EMPTY_PAGE',
          message: `Search returned an empty page before the advertised count was satisfied.`,
        });
      }
      break;
    }
    if (additions === 0) break;
    page += 1;
  }

  if (duplicateIds.size > 0) {
    warnings.push({
      code: 'DUPLICATE_VARIANTS',
      message: 'Duplicate variant IDs were ignored.',
      variantIds: [...duplicateIds].toSorted(),
    });
  }
  if (candidates.size !== expectedCount) {
    warnings.push({
      code: 'COUNT_MISMATCH',
      message: `Advertised ${expectedCount} variants but found ${candidates.size}.`,
    });
  }

  const details = new Map<string, CmsRecord>();
  const failedIds: string[] = [];
  for (const variantId of [...candidates.keys()].toSorted()) {
    try {
      const detail = await getVariant(connection, variantId, options);
      if (detailWorkspaceId(detail) === workspaceId) {
        details.set(variantId, detail);
      } else {
        rejected.add(variantId);
        ownershipMismatchIds.add(variantId);
      }
    } catch {
      failedIds.push(variantId);
      warnings.push({
        code: 'DETAIL_FAILED',
        message: `Variant detail request failed for ${variantId}.`,
        variantIds: [variantId],
      });
    }
  }

  if (ownershipMismatchIds.size > 0) {
    warnings.push({
      code: 'OWNERSHIP_MISMATCH',
      message: 'Variants outside the requested workspace were rejected.',
      variantIds: [...ownershipMismatchIds].toSorted(),
    });
  }

  const entries = [...details.keys()].toSorted().map((variantId) => ({
    file: `items/${variantId}.json`,
    variantId,
  }));
  const manifest: WorkspaceExportManifest = {
    schemaVersion: 1,
    mode: 'experimental-best-effort',
    workspaceId,
    search: {
      contentSpaceOrFolderIds: [workspaceId],
      languages: ['All'],
      pageSize: PAGE_SIZE,
      queryTerm: '*',
    },
    expectedCount,
    foundCount: candidates.size,
    exportedCount: entries.length,
    pagesRequested,
    entries,
    rejectedVariantIds: [...rejected].toSorted(),
    failedVariantIds: failedIds.toSorted(),
    warnings,
  };

  const parent = path.dirname(destination);
  await mkdir(parent, { recursive: true });
  const temporary = path.join(
    parent,
    `.${path.basename(destination)}.tmp-${process.pid}-${Date.now()}`,
  );
  try {
    await mkdir(temporary);
    await mkdir(path.join(temporary, 'items'));
    for (const entry of entries) {
      await writeExclusive(path.join(temporary, entry.file), details.get(entry.variantId));
    }
    await writeExclusive(path.join(temporary, 'manifest.json'), manifest);
    await rename(temporary, destination);
  } catch (error) {
    await rm(temporary, { force: true, recursive: true });
    throw error;
  }

  return { destination, manifest };
}
