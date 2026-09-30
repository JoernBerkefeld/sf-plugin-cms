import type { Connection } from '@salesforce/core';
import {
  getSelectedOperation,
  requestJson,
  type JsonRequestOptions,
} from '../transport/json-request.js';
import { getVariant } from './read.js';
import { requiredVariantIdentifier } from './variant-identity.js';

const PAGE_SIZE = 250;
const PAGE_CAP = 1000;

type JsonRecord = Record<string, unknown>;
type RequestConnection = Pick<Connection, 'request'> & Partial<Pick<Connection, 'version'>>;

function record(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function responseItems(value: unknown): unknown[] {
  if (!record(value) || !Array.isArray(value.items))
    throw new TypeError('CMS prerequisite search must return items');
  return value.items;
}

function responseCount(value: unknown): number {
  if (record(value)) {
    for (const key of ['total', 'totalCount', 'count']) {
      if (typeof value[key] === 'number' && Number.isInteger(value[key]) && value[key] >= 0)
        return value[key];
    }
  }
  throw new TypeError('CMS prerequisite search must return a count');
}

function detailContentType(detail: JsonRecord): unknown {
  return record(detail.contentType) ? detail.contentType.fullyQualifiedName : detail.contentType;
}

/**
 * Search one destination workspace and return exact, fully read CMS variant matches.
 * @param {RequestConnection} connection - Destination org connection.
 * @param {string} workspaceId - Exact destination workspace ID.
 * @param {string} contentType - Exact fully qualified CMS content type.
 * @param {string} queryTerm - Server search term used only to obtain candidates.
 * @param {(detail: JsonRecord) => boolean} predicate - Exact client-side match predicate.
 * @param {JsonRequestOptions} options - Optional request metadata and signal.
 * @returns {Promise<JsonRecord[]>} Exact detailed matches; zero, one, or many are preserved.
 */
export async function lookupExactCmsVariants(
  connection: RequestConnection,
  workspaceId: string,
  contentType: string,
  queryTerm: string,
  predicate: (detail: JsonRecord) => boolean,
  options: JsonRequestOptions = {},
): Promise<JsonRecord[]> {
  const candidates = new Map<string, true>();
  let expected: number | undefined;
  for (let page = 0; page < PAGE_CAP; page += 1) {
    const response = await requestJson<unknown>(
      connection,
      getSelectedOperation('workspace.variant.search'),
      {
        query: {
          contentSpaceOrFolderIds: [workspaceId],
          contentTypeFQN: contentType,
          languages: ['All'],
          page,
          pageSize: PAGE_SIZE,
          queryTerm,
        },
      },
      options,
    );
    const items = responseItems(response.data);
    const count = responseCount(response.data);
    if (expected === undefined) expected = count;
    else if (expected !== count) throw new TypeError('CMS prerequisite search count changed');
    for (const item of items) {
      if (
        !record(item) ||
        item.type !== 'ManagedContentVariantSearchResultRepresentation' ||
        typeof item.id !== 'string' ||
        item.managedContentSpaceId !== workspaceId ||
        candidates.has(item.id)
      ) {
        throw new TypeError('CMS prerequisite search returned ambiguous scope evidence');
      }
      candidates.set(item.id, true);
    }
    if (items.length === 0 || candidates.size >= count) break;
    if (page === PAGE_CAP - 1) throw new TypeError('CMS prerequisite search exceeded page cap');
  }
  if (expected === undefined || candidates.size !== expected)
    throw new TypeError('CMS prerequisite search count was not satisfied');

  const matches: JsonRecord[] = [];
  for (const id of candidates.keys()) {
    const detail = await getVariant(connection, id, options);
    if (
      !record(detail.contentSpace) ||
      detail.contentSpace.id !== workspaceId ||
      detailContentType(detail) !== contentType
    ) {
      throw new TypeError('CMS prerequisite detail changed workspace or type scope');
    }
    if (requiredVariantIdentifier(detail, 'CMS prerequisite detail') !== id) {
      throw new TypeError('CMS prerequisite detail changed variant identity');
    }
    if (predicate(detail as JsonRecord)) matches.push(detail as JsonRecord);
  }
  return matches;
}
