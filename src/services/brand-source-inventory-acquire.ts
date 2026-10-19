import type { Connection } from '@salesforce/core';
import { randomUUID } from 'node:crypto';
import { logApiEvent } from '../logging.js';
import type { Duplex } from 'node:stream';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { assertExactKeys } from '../contracts/shared.js';
import type { WorkspaceExportManifest } from '../contracts/workspace-export.js';
import type { JsonRequestOptions } from '../transport/json-request.js';
import { redactSecrets } from '../transport/redact-secrets.js';
import { getContent, getVariant, getWorkspace } from './read.js';
import {
  BRAND_SOURCE_INVENTORY_KIND,
  BRAND_SOURCE_INVENTORY_PATH,
  replayBrandSourceInventoryEvidence,
  serializeBrandSourceInventoryEvidence,
  type BrandSourceInventoryEvidence,
} from './brand-source-inventory-evidence.js';
import type { SourceDefinitionInputItem } from './source-definition.js';

type NativeRecord = Readonly<Record<string, unknown>>;
type SourceConnection = Pick<Connection, 'request' | 'getApiVersion' | 'getAuthInfoFields'>;
type Inventory = BrandSourceInventoryEvidence['selections'][number]['inventory'];
export type BrandSourceInventoryAcquisition = {
  readonly evidence: BrandSourceInventoryEvidence;
  readonly bytes: string;
  readonly items: readonly SourceDefinitionInputItem[];
};
export type BrandSourceInventoryAcquireOptions = JsonRequestOptions & {
  readonly acquiredAt?: string;
};

function exactId(value: unknown, prefix: string): asserts value is string {
  if (
    typeof value !== 'string' ||
    !new RegExp(`^${prefix}[A-Za-z0-9]{12}[A-Z0-5]{3}$`, 'u').test(value)
  )
    throw new TypeError('Brand acquisition requires exact native IDs');
}
function native(value: unknown): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new TypeError('Brand acquisition requires native objects');
}

// Shadow only refresh replay on the request receiver; never change the caller's CLI connection.
function readonlyConnection(connection: SourceConnection): Pick<Connection, 'request'> {
  const receiver = Object.create(connection) as SourceConnection;
  Object.defineProperty(receiver, '_refreshDelegate', { value: undefined });
  return {
    request: (request, options) => {
      if (typeof request === 'string' || request.method !== 'GET')
        throw new TypeError('Brand acquisition permits explicit GET only');
      return receiver.request(request, { ...options, retry: { maxRetries: 0 } });
    },
  };
}

async function query(
  connection: Pick<Connection, 'request'>,
  apiVersion: string,
  soql: string,
  options: JsonRequestOptions,
): Promise<NativeRecord> {
  const timeout = options.timeoutMs ?? 30_000;
  if (!Number.isFinite(timeout) || timeout <= 0 || options.signal?.aborted)
    throw new TypeError('Brand acquisition timeout/cancellation');
  const event = {
    requestId: randomUUID(),
    startedAt: Date.now(),
    method: 'GET',
    url: `/services/data/v${apiVersion}/query?q=${encodeURIComponent(soql)}`,
    operationKey: 'inventory.brand',
  };
  logApiEvent('request', event);
  let request: Promise<unknown> & { stream(): Duplex };
  try {
    request = connection.request<unknown>(
      { method: 'GET', url: event.url },
      { timeout },
    ) as typeof request;
  } catch (error) {
    logApiEvent('error', event, error);
    throw error;
  }
  const cancel = (): void => {
    request.stream().destroy(new Error('Brand acquisition cancelled'));
  };
  options.signal?.addEventListener('abort', cancel, { once: true });
  try {
    const data = await request;
    logApiEvent('response', event, data);
    const response = structuredClone(data);
    assertExactKeys(response, ['totalSize', 'done', 'records'], 'Brand query response');
    if (
      response.done !== true ||
      !Array.isArray(response.records) ||
      response.totalSize !== response.records.length
    )
      throw new TypeError('Brand acquisition incomplete query/count response');
    return response;
  } catch (error) {
    logApiEvent('error', event, error);
    throw new TypeError(redactSecrets(error instanceof Error ? error.message : String(error)));
  } finally {
    options.signal?.removeEventListener('abort', cancel);
  }
}

async function pages(
  connection: Pick<Connection, 'request'>,
  apiVersion: string,
  baseQuery: string,
  parentId: string,
  workspaceId: string,
  options: JsonRequestOptions,
): Promise<Inventory['pages']> {
  const result: Inventory['pages'][number][] = [];
  let afterId: string | null = null;
  let size = 0;
  for (let page = 0; page < 1000; page += 1) {
    const soql =
      afterId === null
        ? baseQuery
        : baseQuery.replace(' ORDER BY Id', ` AND Id > '${afterId}' ORDER BY Id`);
    const response = await query(connection, apiVersion, soql, options);
    const records = response.records as unknown[];
    if (records.length > 2000 || size + records.length > 250_000)
      throw new TypeError('Brand acquisition page/row cap exceeded');
    result.push({ afterId, response });
    if (records.length === 0) return result;
    for (const row of records) {
      native(row);
      exactId(row.Id, '9Ps');
      native(row.ManagedContent);
      if (
        (afterId !== null && row.Id <= afterId) ||
        row.ManagedContentId !== parentId ||
        row.ManagedContent.AuthoredManagedContentSpaceId !== workspaceId
      )
        throw new TypeError('Brand acquisition cursor/parent/workspace disagreement');
      afterId = row.Id;
    }
    size += records.length;
  }
  throw new TypeError('Brand acquisition requires explicit empty termination within page cap');
}

/**
 * Acquire canonical source-only Brand proof without filesystem publication or mutations.
 * @param {SourceConnection} connection - Authenticated source CLI connection; no refresh/retry replay.
 * @param {WorkspaceExportManifest} manifest - Original baseline descriptors (proof item may be absent).
 * @param {ReadonlyMap<string, NativeRecord>} rawItems - Caller-byte-verified originals keyed by raw JSON path.
 * @param {ReadonlyMap<string, NativeRecord>} reports - Caller-byte-verified reports keyed by report JSON path.
 * @param {BrandSourceInventoryAcquireOptions} options - Cancellation, timeout and acquisition timestamp.
 * @returns {Promise<BrandSourceInventoryAcquisition>} Detached validated proof, canonical bytes and projection inputs.
 */
export async function acquireBrandSourceInventoryEvidence(
  connection: SourceConnection,
  manifest: WorkspaceExportManifest,
  rawItems: ReadonlyMap<string, NativeRecord>,
  reports: ReadonlyMap<string, NativeRecord>,
  options: BrandSourceInventoryAcquireOptions = {},
): Promise<BrandSourceInventoryAcquisition> {
  // Pin caller records before any asynchronous read; hashes remain external byte-verification claims.
  const baseline = structuredClone(manifest);
  const originals = structuredClone(rawItems);
  const originalReports = structuredClone(reports);
  const orgId = connection.getAuthInfoFields().orgId;
  const apiVersion = connection.getApiVersion();
  exactId(orgId, '00D');
  exactId(baseline.workspaceId, '0Zu');
  if (orgId !== baseline.provenance.sourceOrgId || !/^\d+\.0$/u.test(apiVersion))
    throw new TypeError('Brand acquisition source org/API binding disagreement');
  const selections: BrandSourceInventoryEvidence['selections'][number][] = [];
  const selected = baseline.entries.toSorted((left, right) => {
    if (left.variantId === right.variantId) return 0;
    return left.variantId < right.variantId ? -1 : 1;
  });
  if (selected.length === 0 || selected.length > 250_000)
    throw new TypeError('Brand acquisition requires bounded selections');
  // Validate every query identity before issuing even the workspace GET.
  for (const entry of selected) {
    exactId(entry.variantId, '9Ps');
    const raw = originals.get(entry.file);
    exactId(raw?.managedContentId, '20Y');
    if (raw?.managedContentVariantId !== entry.variantId)
      throw new TypeError('Brand acquisition selected variant disagreement');
  }
  const transport = readonlyConnection(connection);
  const acquiredAt = options.acquiredAt ?? new Date().toISOString();
  const workspace = structuredClone(await getWorkspace(transport, baseline.workspaceId, options));
  for (const entry of selected) {
    const raw = originals.get(entry.file)!;
    const parentId = raw.managedContentId as string;
    const predicate = `ManagedContentId = '${parentId}' AND ManagedContent.AuthoredManagedContentSpaceId = '${baseline.workspaceId}'`;
    const baseQuery = `SELECT Id, ManagedContentId, Language, IsPublished, ManagedContentVariantStatus, IsPrimary, Name, UrlName, ManagedContentKey, ManagedContent.AuthoredManagedContentSpaceId, ManagedContent.ApiName FROM ManagedContentVariant WHERE ${predicate} ORDER BY Id LIMIT 2000`;
    const countQuery = `SELECT ManagedContentId, COUNT(Id) siblingCount FROM ManagedContentVariant WHERE ${predicate} GROUP BY ManagedContentId LIMIT 1`;
    const originalPages = await pages(
      transport,
      apiVersion,
      baseQuery,
      parentId,
      baseline.workspaceId,
      options,
    );
    const countResponse = await query(transport, apiVersion, countQuery, options);
    // Fetch the actual native parent and each visible sibling before repeating canonical reads.
    const parent = structuredClone(await getContent(transport, parentId, {}, options));
    for (const page of originalPages) {
      for (const row of page.response.records as NativeRecord[]) {
        const detail = await getVariant(transport, row.Id as string, options);
        if (row.Id !== entry.variantId || !isDeepStrictEqual(detail, raw))
          throw new TypeError('Brand acquisition native detail/original body disagreement');
      }
    }
    const repeatedPages = await pages(
      transport,
      apiVersion,
      baseQuery,
      parentId,
      baseline.workspaceId,
      options,
    );
    const repeatedCount = await query(transport, apiVersion, countQuery, options);
    const descriptor = baseline.brandReports?.find((report) => report.rawItemPath === entry.file);
    const rawDescriptor = baseline.items.find((item) => item.path === entry.file);
    const reportDescriptor = baseline.items.find((item) => item.path === descriptor?.path);
    if (!descriptor || !rawDescriptor || !reportDescriptor)
      throw new TypeError('Brand acquisition requires original raw/report descriptors');
    selections.push({
      rawItemPath: entry.file,
      rawSha256: rawDescriptor.sha256,
      reportPath: descriptor.path,
      reportSha256: reportDescriptor.sha256,
      parent,
      inventory: {
        parentId,
        workspaceId: baseline.workspaceId,
        query: baseQuery,
        pages: originalPages,
        countQuery,
        countResponse,
        recheck: { pages: repeatedPages, countResponse: repeatedCount },
      },
    });
  }
  const evidence: BrandSourceInventoryEvidence = {
    contract: 'sf-cms-brand-source-inventory',
    contractVersion: '1.0.0',
    source: { orgId, apiVersion, acquiredAt },
    workspace,
    selections,
  };
  const bytes = serializeBrandSourceInventoryEvidence(evidence);
  if (
    baseline.items.some(
      (item) =>
        item.path === BRAND_SOURCE_INVENTORY_PATH || item.kind === BRAND_SOURCE_INVENTORY_KIND,
    )
  )
    throw new TypeError(
      'Brand acquisition requires a fresh baseline without prior canonical proof',
    );
  baseline.items.push({
    path: BRAND_SOURCE_INVENTORY_PATH,
    kind: BRAND_SOURCE_INVENTORY_KIND,
    sha256: createHash('sha256').update(bytes, 'utf8').digest('hex'),
  });
  const items = replayBrandSourceInventoryEvidence(
    JSON.parse(bytes),
    baseline,
    originals,
    originalReports,
  );
  return { evidence: structuredClone(evidence), bytes, items };
}
