import type { Connection } from '@salesforce/core';
import type { Duplex } from 'node:stream';
import { isDeepStrictEqual } from 'node:util';
import { assertExactKeys } from '../contracts/shared.js';
import type { JsonRequestOptions } from '../transport/json-request.js';
import { redactSecrets } from '../transport/redact-secrets.js';
import { getCmsApiSelection } from '../api-policy.js';

type NativeConnection = Pick<Connection, 'request' | 'getApiVersion'>;
export type NativeInventoryRow = {
  Id: string;
  ManagedContentId: string;
  ContentTypeFullyQualifiedName: string;
  Language: string;
  IsPublished: boolean;
  ManagedContentVariantStatus: string;
  IsPrimary: boolean;
  Name: string;
  UrlName: string | null;
  ManagedContentKey: string;
  ManagedContent: { AuthoredManagedContentSpaceId: string; ApiName: string | null };
};
export type NativeInventoryOptions = JsonRequestOptions & {
  maxPages?: number;
  maxRows?: number;
};
export type NativeInventory = {
  apiVersion: string;
  workspaceId: string;
  records: NativeInventoryRow[];
  complete: true;
  /** Includes both explicit empty terminal pages and both aggregate requests. */
  pagesRequested: number;
};
export class NativeInventoryRequestError extends TypeError {
  public readonly status?: number;
  public readonly statusObserved: boolean;
  public readonly errorCode?: string;
  public readonly responseMessage?: string;
  public readonly errorEntryCount: number;

  public constructor(error: unknown) {
    const raw =
      error !== null && typeof error === 'object' ? (error as Record<string, unknown>) : {};
    const response =
      raw.response !== null && typeof raw.response === 'object'
        ? (raw.response as Record<string, unknown>)
        : {};
    const status = [raw.statusCode, raw.status, response.statusCode, response.status].find(
      (value): value is number => typeof value === 'number' && Number.isInteger(value),
    );
    const data: unknown = raw.data ?? response.data;
    const fallbackEntries = data === undefined ? [] : [data];
    const entries = Array.isArray(data) ? data : fallbackEntries;
    const entry =
      entries.length === 1 && entries[0] !== null && typeof entries[0] === 'object'
        ? (entries[0] as Record<string, unknown>)
        : {};
    super(
      redactSecrets(error instanceof Error ? error.message : 'Native inventory request failed'),
    );
    this.name = 'NativeInventoryRequestError';
    this.status = status;
    this.statusObserved = status !== undefined;
    this.errorEntryCount = entries.length;
    const code = entry.errorCode ?? raw.errorCode;
    this.errorCode = typeof code === 'string' ? redactSecrets(code) : undefined;
    this.responseMessage =
      typeof entry.message === 'string' ? redactSecrets(entry.message) : undefined;
  }
}
const PROJECTION =
  'Id, ManagedContentId, ContentTypeFullyQualifiedName, Language, IsPublished, ManagedContentVariantStatus, IsPrimary, Name, UrlName, ManagedContentKey, ManagedContent.AuthoredManagedContentSpaceId, ManagedContent.ApiName';

function exactId(value: unknown, prefix: string): asserts value is string {
  if (
    typeof value !== 'string' ||
    !new RegExp(`^${prefix}[A-Za-z0-9]{12}[A-Z0-5]{3}$`, 'u').test(value)
  )
    throw new TypeError('Native inventory requires exact native IDs');
}
function object(value: unknown): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new TypeError('Native inventory requires native objects');
}
function contentType(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[A-Za-z][A-Za-z0-9_]*__[A-Za-z][A-Za-z0-9_]*$/u.test(value))
    throw new TypeError('Native inventory requires qualified content types');
}

async function enumerate(
  connection: NativeConnection,
  workspaceId: string,
  parentId: string | undefined,
  types: readonly string[] | undefined,
  options: NativeInventoryOptions,
): Promise<NativeInventory> {
  exactId(workspaceId, '0Zu');
  const selection = getCmsApiSelection(connection);
  const maxPages = options.maxPages ?? 1000;
  const maxRows = options.maxRows ?? 250_000;
  for (const [value, cap] of [
    [maxPages, 1000],
    [maxRows, 250_000],
  ]) {
    if (!Number.isSafeInteger(value) || value < 1 || value > cap)
      throw new TypeError('Native inventory requires bounded positive limits');
  }
  const timeout = options.timeoutMs ?? 30_000;
  if (!Number.isFinite(timeout) || timeout <= 0 || options.signal?.aborted)
    throw new TypeError('Native inventory timeout/cancellation');
  const predicate = [
    ...(parentId === undefined ? [] : [`ManagedContentId = '${parentId}'`]),
    `ManagedContent.AuthoredManagedContentSpaceId = '${workspaceId}'`,
    ...(types === undefined
      ? []
      : [`ContentTypeFullyQualifiedName IN (${types.map((type) => `'${type}'`).join(', ')})`]),
  ].join(' AND ');
  // As in Brand acquisition, shadow refresh replay without changing the caller connection.
  const receiver = Object.create(connection) as NativeConnection;
  Object.defineProperty(receiver, '_refreshDelegate', { value: undefined });
  let pagesRequested = 0;
  const query = async (soql: string): Promise<unknown[]> => {
    if (options.signal?.aborted) throw new TypeError('Native inventory cancelled');
    pagesRequested += 1;
    const request = receiver.request<unknown>(
      { method: 'GET', url: `${selection.restDataPath}/query?q=${encodeURIComponent(soql)}` },
      { timeout, retry: { maxRetries: 0 } },
    ) as Promise<unknown> & { stream(): Duplex };
    const cancel = (): void => {
      request.stream().destroy(new Error('Native inventory cancelled'));
    };
    options.signal?.addEventListener('abort', cancel, { once: true });
    try {
      const response = structuredClone(await request);
      if (options.signal?.aborted) throw new TypeError('Native inventory cancelled');
      assertExactKeys(
        response,
        ['totalSize', 'done', 'records'],
        'Native inventory query response',
      );
      if (
        response.done !== true ||
        !Array.isArray(response.records) ||
        response.totalSize !== response.records.length ||
        response.records.length > 2000
      )
        throw new TypeError('Native inventory incomplete query/count response');
      return response.records;
    } catch (error) {
      throw new NativeInventoryRequestError(error);
    } finally {
      options.signal?.removeEventListener('abort', cancel);
    }
  };
  const readPages = async (): Promise<NativeInventoryRow[]> => {
    const records: NativeInventoryRow[] = [];
    let afterId: string | undefined;
    for (let page = 0; page < maxPages; page += 1) {
      const rows = await query(
        `SELECT ${PROJECTION} FROM ManagedContentVariant WHERE ${predicate}${afterId === undefined ? '' : ` AND Id > '${afterId}'`} ORDER BY Id LIMIT 2000`,
      );
      if (rows.length === 0) return records;
      if (records.length + rows.length > maxRows)
        throw new TypeError('Native inventory row cap exceeded');
      for (const row of rows) {
        object(row);
        exactId(row.Id, '9Ps');
        exactId(row.ManagedContentId, '20Y');
        object(row.ManagedContent);
        contentType(row.ContentTypeFullyQualifiedName);
        if (
          (afterId !== undefined && row.Id <= afterId) ||
          row.ManagedContent.AuthoredManagedContentSpaceId !== workspaceId ||
          (parentId !== undefined && row.ManagedContentId !== parentId) ||
          (types !== undefined && !types.includes(row.ContentTypeFullyQualifiedName))
        )
          throw new TypeError('Native inventory cursor/parent/workspace/type disagreement');
        for (const key of [
          'Language',
          'ManagedContentVariantStatus',
          'Name',
          'ManagedContentKey',
        ]) {
          if (typeof row[key] !== 'string' || (row[key] as string).length === 0)
            throw new TypeError('Native inventory malformed native row');
        }
        if (
          typeof row.IsPublished !== 'boolean' ||
          typeof row.IsPrimary !== 'boolean' ||
          (row.UrlName !== null && typeof row.UrlName !== 'string') ||
          (row.ManagedContent.ApiName !== null && typeof row.ManagedContent.ApiName !== 'string')
        )
          throw new TypeError('Native inventory malformed native row');
        afterId = row.Id;
        records.push(row as NativeInventoryRow);
      }
    }
    throw new TypeError('Native inventory requires explicit empty termination within page cap');
  };
  const readCounts = async (records: NativeInventoryRow[]): Promise<Map<string, number>> => {
    const rows = await query(
      `SELECT ManagedContentId, COUNT(Id) siblingCount FROM ManagedContentVariant WHERE ${predicate} GROUP BY ManagedContentId LIMIT 2000`,
    );
    // A full aggregate LIMIT cannot establish that another parent group was not omitted.
    if (rows.length === 2000)
      throw new TypeError('Native inventory aggregate count may be truncated');
    const expected = new Map<string, number>();
    for (const row of records)
      expected.set(row.ManagedContentId, (expected.get(row.ManagedContentId) ?? 0) + 1);
    const counts = new Map<string, number>();
    for (const row of rows) {
      object(row);
      exactId(row.ManagedContentId, '20Y');
      if (
        counts.has(row.ManagedContentId) ||
        !Number.isSafeInteger(row.siblingCount) ||
        (row.siblingCount as number) < 1 ||
        expected.get(row.ManagedContentId) !== row.siblingCount
      )
        throw new TypeError('Native inventory aggregate count disagreement');
      counts.set(row.ManagedContentId, row.siblingCount as number);
    }
    if (!isDeepStrictEqual(counts, expected))
      throw new TypeError('Native inventory aggregate count disagreement');
    return counts;
  };
  const records = await readPages();
  const counts = await readCounts(records);
  const repeated = await readPages();
  const repeatedCounts = await readCounts(repeated);
  if (!isDeepStrictEqual(records, repeated) || !isDeepStrictEqual(counts, repeatedCounts))
    throw new TypeError('Native inventory changed during repeat read');
  return {
    apiVersion: selection.effectiveApiVersion,
    workspaceId,
    records,
    complete: true,
    pagesRequested,
  };
}

/**
 * Enumerate principal-visible nondeleted native variants of the requested family, in every language/status.
 * @param {NativeConnection} connection - Source connection with the selected CMS API policy.
 * @param {string} workspaceId - Authored workspace native ID.
 * @param {readonly string[]} contentTypes - Qualified native family types.
 * @param {NativeInventoryOptions} options - Timeout, cancellation and bounded read limits.
 * @returns {Promise<NativeInventory>} Detached rows after terminal/count/repeat parity.
 */
export async function enumerateNativeFamily(
  connection: NativeConnection,
  workspaceId: string,
  contentTypes: readonly string[],
  options: NativeInventoryOptions = {},
): Promise<NativeInventory> {
  if (!Array.isArray(contentTypes) || contentTypes.length === 0 || contentTypes.length > 100)
    throw new TypeError('Native inventory requires bounded family types');
  const types = [...new Set(contentTypes)];
  for (const type of types) contentType(type);
  return enumerate(connection, workspaceId, undefined, types, options);
}

/**
 * Enumerate visible nondeleted workspace variants without type, language or status filters.
 * @param {NativeConnection} connection - Destination connection with the selected CMS API policy.
 * @param {string} workspaceId - Exact authored workspace ID.
 * @param {NativeInventoryOptions} options - Bounded read timeout/cancellation options.
 * @returns {Promise<NativeInventory>} Terminal/count/repeat-verified workspace observations.
 */
export async function enumerateNativeWorkspace(
  connection: NativeConnection,
  workspaceId: string,
  options: NativeInventoryOptions = {},
): Promise<NativeInventory> {
  return enumerate(connection, workspaceId, undefined, undefined, options);
}

/**
 * Independently enumerate all visible nondeleted siblings; deliberately no type/language/status filters.
 * @param {NativeConnection} connection - Source connection with the selected CMS API policy.
 * @param {string} workspaceId - Authored workspace native ID.
 * @param {string} parentId - ManagedContent parent native ID.
 * @param {NativeInventoryOptions} options - Timeout, cancellation and bounded read limits.
 * @returns {Promise<NativeInventory>} Detached sibling rows after terminal/count/repeat parity.
 */
export async function enumerateNativeSiblings(
  connection: NativeConnection,
  workspaceId: string,
  parentId: string,
  options: NativeInventoryOptions = {},
): Promise<NativeInventory> {
  exactId(parentId, '20Y');
  return enumerate(connection, workspaceId, parentId, undefined, options);
}
