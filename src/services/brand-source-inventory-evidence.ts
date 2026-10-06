import { isDeepStrictEqual } from 'node:util';
import { assertExactKeys, assertRelativePosixPath, assertSha256 } from '../contracts/shared.js';
import { sourcePathSegment } from '../contracts/source-definition.js';
import {
  assertWorkspaceExportManifest,
  type WorkspaceExportManifest,
} from '../contracts/workspace-export.js';
import { normalizeBrand, validateBrandReadReport } from './brand.js';
import { projectSourceDefinitions, type SourceDefinitionInputItem } from './source-definition.js';

export const BRAND_SOURCE_INVENTORY_PATH = 'evidence/brand-source-inventory.v1.json' as const;
export const BRAND_SOURCE_INVENTORY_KIND = 'cms.brand-source-inventory' as const;
type NativeRecord = Readonly<Record<string, unknown>>;
type Page = { readonly afterId: string | null; readonly response: NativeRecord };
export type BrandSourceInventoryEvidence = {
  readonly contract: 'sf-cms-brand-source-inventory';
  readonly contractVersion: '1.0.0';
  readonly source: {
    readonly orgId: string;
    readonly apiVersion: string;
    readonly acquiredAt: string;
  };
  readonly workspace: NativeRecord;
  readonly selections: readonly {
    readonly rawItemPath: string;
    readonly rawSha256: string;
    readonly reportPath: string;
    readonly reportSha256: string;
    readonly parent: NativeRecord;
    readonly inventory: {
      readonly parentId: string;
      readonly workspaceId: string;
      readonly query: string;
      readonly pages: readonly Page[];
      readonly countQuery: string;
      readonly countResponse: NativeRecord;
      readonly recheck: { readonly pages: readonly Page[]; readonly countResponse: NativeRecord };
    };
  }[];
};

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function requireRecord(value: unknown): asserts value is Record<string, unknown> {
  if (!record(value)) throw new TypeError('Brand evidence requires native JSON objects');
}
function canonical(value: unknown, ancestors = new Set<object>()): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'object' || value === null || ancestors.has(value))
    throw new TypeError('Brand evidence requires finite JSON values');
  if (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value)))
    throw new TypeError('Brand evidence requires plain JSON objects');
  const keys = Object.keys(value);
  if (Reflect.ownKeys(value).length !== keys.length + (Array.isArray(value) ? 1 : 0))
    throw new TypeError('Brand evidence rejects hidden JSON fields');
  ancestors.add(value);
  let result: unknown;
  if (Array.isArray(value)) {
    if (keys.length !== value.length || keys.some((key, index) => key !== String(index)))
      throw new TypeError('Brand evidence requires dense JSON arrays');
    result = value.map((child: unknown) => canonical(child, ancestors));
  } else {
    result = Object.fromEntries(
      keys
        .toSorted()
        .map((key) => [key, canonical((value as Record<string, unknown>)[key], ancestors)]),
    );
  }
  ancestors.delete(value);
  return result;
}
function id(value: unknown, prefix: string): asserts value is string {
  if (
    typeof value !== 'string' ||
    !new RegExp(`^${prefix}[A-Za-z0-9]{12}[A-Z0-5]{3}$`, 'u').test(value)
  )
    throw new TypeError('Brand inventory requires exact native 18-character IDs');
}
function queries(parentId: string, workspaceId: string): { query: string; countQuery: string } {
  const predicate = `ManagedContentId = '${parentId}' AND ManagedContent.AuthoredManagedContentSpaceId = '${workspaceId}'`;
  return {
    query: `SELECT Id, ManagedContentId, Language, IsPublished, ManagedContentVariantStatus, IsPrimary, Name, UrlName, ManagedContentKey, ManagedContent.AuthoredManagedContentSpaceId, ManagedContent.ApiName FROM ManagedContentVariant WHERE ${predicate} ORDER BY Id LIMIT 2000`,
    countQuery: `SELECT ManagedContentId, COUNT(Id) siblingCount FROM ManagedContentVariant WHERE ${predicate} GROUP BY ManagedContentId LIMIT 1`,
  };
}
function attributes(value: unknown, type: string, nativeId: string, apiVersion: string): void {
  assertExactKeys(value, ['type', 'url'], 'Brand native attributes');
  if (
    value.type !== type ||
    value.url !== `/services/data/v${apiVersion}/sobjects/${type}/${nativeId}`
  )
    throw new TypeError('Brand native attributes identity/version disagreement');
}
function rows(
  pages: unknown,
  parentId: string,
  workspaceId: string,
  apiVersion: string,
): NativeRecord[] {
  if (!Array.isArray(pages) || pages.length < 2 || pages.length > 1000)
    throw new TypeError('Brand inventory requires bounded pages and explicit empty termination');
  const result: NativeRecord[] = [];
  let cursor: string | null = null;
  for (const [index, page] of pages.entries()) {
    assertExactKeys(page, ['afterId', 'response'], 'Brand keyset page');
    assertExactKeys(page.response, ['totalSize', 'done', 'records'], 'Brand query response');
    const response = page.response;
    if (
      page.afterId !== cursor ||
      response.done !== true ||
      !Array.isArray(response.records) ||
      response.records.length > 2000 ||
      response.totalSize !== response.records.length ||
      (response.records.length === 0) !== (index === pages.length - 1)
    )
      throw new TypeError('Brand inventory cursor/count/termination disagreement');
    for (const row of response.records) {
      assertExactKeys(
        row,
        [
          'attributes',
          'Id',
          'ManagedContentId',
          'Language',
          'IsPublished',
          'ManagedContentVariantStatus',
          'IsPrimary',
          'Name',
          'UrlName',
          'ManagedContentKey',
          'ManagedContent',
        ],
        'Brand query row',
      );
      id(row.Id, '9Ps');
      attributes(row.attributes, 'ManagedContentVariant', row.Id, apiVersion);
      assertExactKeys(
        row.ManagedContent,
        ['attributes', 'AuthoredManagedContentSpaceId', 'ApiName'],
        'Brand query parent',
      );
      attributes(row.ManagedContent.attributes, 'ManagedContent', parentId, apiVersion);
      if (
        (cursor !== null && row.Id <= cursor) ||
        row.ManagedContentId !== parentId ||
        row.ManagedContent.AuthoredManagedContentSpaceId !== workspaceId ||
        row.IsPublished !== false ||
        row.ManagedContentVariantStatus !== 'Draft' ||
        row.IsPrimary !== true ||
        typeof row.Language !== 'string' ||
        !row.Language ||
        typeof row.Name !== 'string' ||
        !row.Name ||
        typeof row.UrlName !== 'string' ||
        !row.UrlName ||
        typeof row.ManagedContentKey !== 'string' ||
        !row.ManagedContentKey ||
        typeof row.ManagedContent.ApiName !== 'string' ||
        !row.ManagedContent.ApiName
      )
        throw new TypeError('Brand inventory row identity/status/primary disagreement');
      cursor = row.Id;
      result.push(row);
      if (result.length > 250_000) throw new TypeError('Brand inventory exceeds row cap');
    }
  }
  return result;
}
function count(value: unknown, parentId: string, expected: number): void {
  assertExactKeys(value, ['totalSize', 'done', 'records'], 'Brand grouped count response');
  if (
    value.totalSize !== 1 ||
    value.done !== true ||
    !Array.isArray(value.records) ||
    value.records.length !== 1
  )
    throw new TypeError('Brand grouped count is incomplete');
  const aggregate: unknown = value.records[0];
  assertExactKeys(
    aggregate,
    ['attributes', 'ManagedContentId', 'siblingCount'],
    'Brand grouped count row',
  );
  assertExactKeys(aggregate.attributes, ['type'], 'Brand aggregate attributes');
  if (
    aggregate.attributes.type !== 'AggregateResult' ||
    aggregate.ManagedContentId !== parentId ||
    aggregate.siblingCount !== expected
  )
    throw new TypeError('Brand grouped count/parent disagreement');
}
function assertEvidence(value: unknown): asserts value is BrandSourceInventoryEvidence {
  canonical(value);
  assertExactKeys(
    value,
    ['contract', 'contractVersion', 'source', 'workspace', 'selections'],
    'Brand source evidence',
  );
  if (value.contract !== 'sf-cms-brand-source-inventory' || value.contractVersion !== '1.0.0')
    throw new TypeError('Unsupported Brand source inventory contract/version');
  assertExactKeys(value.source, ['orgId', 'apiVersion', 'acquiredAt'], 'Brand source provenance');
  id(value.source.orgId, '00D');
  if (
    typeof value.source.apiVersion !== 'string' ||
    !/^\d+\.0$/u.test(value.source.apiVersion) ||
    typeof value.source.acquiredAt !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value.source.acquiredAt) ||
    !Number.isFinite(Date.parse(value.source.acquiredAt))
  )
    throw new TypeError('Brand source API version/acquisition time is invalid');
  requireRecord(value.workspace);
  id(value.workspace.id, '0Zu');
  if (
    typeof value.workspace.name !== 'string' ||
    !value.workspace.name ||
    !Array.isArray(value.selections) ||
    value.selections.length === 0 ||
    value.selections.length > 250_000
  )
    throw new TypeError('Brand workspace/selections are required');
  let previous = '';
  for (const selection of value.selections) {
    assertExactKeys(
      selection,
      ['rawItemPath', 'rawSha256', 'reportPath', 'reportSha256', 'parent', 'inventory'],
      'Brand selection',
    );
    assertRelativePosixPath(selection.rawItemPath, 'Brand raw path');
    assertRelativePosixPath(selection.reportPath, 'Brand report path');
    assertSha256(selection.rawSha256, 'Brand raw hash');
    assertSha256(selection.reportSha256, 'Brand report hash');
    requireRecord(selection.parent);
    assertExactKeys(
      selection.inventory,
      ['parentId', 'workspaceId', 'query', 'pages', 'countQuery', 'countResponse', 'recheck'],
      'Brand inventory',
    );
    const inventory = selection.inventory;
    id(inventory.parentId, '20Y');
    id(inventory.workspaceId, '0Zu');
    if (
      inventory.workspaceId !== value.workspace.id ||
      inventory.query !== queries(inventory.parentId, inventory.workspaceId).query ||
      inventory.countQuery !== queries(inventory.parentId, inventory.workspaceId).countQuery
    )
      throw new TypeError('Brand inventory canonical query/scope disagreement');
    assertExactKeys(inventory.recheck, ['pages', 'countResponse'], 'Brand inventory recheck');
    const original = rows(
      inventory.pages,
      inventory.parentId,
      inventory.workspaceId,
      value.source.apiVersion,
    );
    const repeated = rows(
      inventory.recheck.pages,
      inventory.parentId,
      inventory.workspaceId,
      value.source.apiVersion,
    );
    count(inventory.countResponse, inventory.parentId, original.length);
    count(inventory.recheck.countResponse, inventory.parentId, repeated.length);
    if (original.length !== 1 || !isDeepStrictEqual(original, repeated))
      throw new TypeError('Brand requires single unchanged native sibling recheck');
    const variantId = original[0].Id as string;
    if (variantId <= previous)
      throw new TypeError('Brand selections require unique ordered variants');
    previous = variantId;
  }
}

/**
 * Serialize retained native JSON deterministically without claiming authenticity.
 * @param {BrandSourceInventoryEvidence} evidence - Historical canonical inventory proof.
 * @returns {string} Sorted JSON with terminal LF.
 */
export function serializeBrandSourceInventoryEvidence(
  evidence: BrandSourceInventoryEvidence,
): string {
  assertEvidence(evidence);
  return `${JSON.stringify(canonical(evidence), null, 2)}\n`;
}

/**
 * Replay strictly against caller-byte-verified original path-keyed records; never hash parsed JSON.
 * @param {unknown} evidence - Original evidence artifact verified by the caller against manifest bytes.
 * @param {WorkspaceExportManifest} manifest - Independently pinned and verified original manifest.
 * @param {ReadonlyMap<string, NativeRecord>} rawItems - Byte-verified originals keyed by raw path.
 * @param {ReadonlyMap<string, NativeRecord>} reports - Byte-verified original reports keyed by report path.
 * @returns {readonly SourceDefinitionInputItem[]} Detached projection-qualified originals; warnings remain untouched.
 */
export function replayBrandSourceInventoryEvidence(
  evidence: unknown,
  manifest: WorkspaceExportManifest,
  rawItems: ReadonlyMap<string, NativeRecord>,
  reports: ReadonlyMap<string, NativeRecord>,
): readonly SourceDefinitionInputItem[] {
  assertEvidence(evidence);
  assertWorkspaceExportManifest(manifest);
  const source = structuredClone(evidence);
  const workspaceApiName = source.workspace.apiName;
  sourcePathSegment(workspaceApiName);
  const size = source.selections.length;
  if (
    manifest.provenance.sourceOrgId !== source.source.orgId ||
    manifest.workspaceId !== source.workspace.id ||
    manifest.provenance.sourceWorkspaceId !== source.workspace.id ||
    manifest.completeness !== 'complete' ||
    manifest.expectedCount !== size ||
    manifest.foundCount !== size ||
    manifest.exportedCount !== size ||
    manifest.entries.length !== size ||
    manifest.items.filter((item) => item.kind === 'cms.content').length !== size ||
    rawItems.size !== size ||
    reports.size !== size ||
    manifest.brandReports?.length !== size ||
    manifest.rejectedVariantIds.length > 0 ||
    manifest.failedVariantIds.length > 0 ||
    manifest.dependencies.length > 0 ||
    manifest.externalReferences.length > 0 ||
    !isDeepStrictEqual(manifest.warnings, [
      {
        code: 'UNSUPPORTED_WILDCARD',
        message: 'Wildcard search is unsupported and this export is experimental best-effort.',
      },
    ])
  )
    throw new TypeError(
      'Brand source requires complete exact original baseline and sole retained wildcard warning',
    );
  const proof = manifest.items.filter((item) => item.kind === BRAND_SOURCE_INVENTORY_KIND);
  if (proof.length !== 1 || proof[0].path !== BRAND_SOURCE_INVENTORY_PATH)
    throw new TypeError('Brand source inventory artifact binding is missing');
  const paths = new Set<string>();
  const root = (folder: unknown): boolean =>
    folder === null ||
    (record(folder) &&
      typeof source.workspace.rootFolderId === 'string' &&
      source.workspace.rootFolderId !== source.workspace.id &&
      /^9Pu[A-Za-z0-9]{12}[A-Z0-5]{3}$/u.test(source.workspace.rootFolderId) &&
      folder.id === source.workspace.rootFolderId);
  const result = source.selections.map((selection): SourceDefinitionInputItem => {
    const raw = rawItems.get(selection.rawItemPath);
    const report = reports.get(selection.reportPath);
    const row = selection.inventory.pages[0].response.records as NativeRecord[];
    const variantId = row[0].Id as string;
    const descriptor = manifest.brandReports!.find((item) => item.path === selection.reportPath);
    for (const [path, hash, kind] of [
      [selection.rawItemPath, selection.rawSha256, 'cms.content'],
      [selection.reportPath, selection.reportSha256, 'cms.brand.read-report'],
    ]) {
      const items = manifest.items.filter((item) => item.path === path);
      if (
        paths.has(path) ||
        items.length !== 1 ||
        items[0].sha256 !== hash ||
        items[0].kind !== kind
      )
        throw new TypeError('Brand original path/hash binding disagreement');
      paths.add(path);
    }
    if (
      !raw ||
      !report ||
      !descriptor ||
      descriptor.rawItemPath !== selection.rawItemPath ||
      descriptor.variantId !== variantId ||
      descriptor.apiName !== raw.apiName ||
      manifest.entries.filter(
        (entry) => entry.file === selection.rawItemPath && entry.variantId === variantId,
      ).length !== 1 ||
      !validateBrandReadReport(report, {
        workspaceId: manifest.workspaceId,
        apiName: raw.apiName as string,
        variantId,
        rawItemPath: selection.rawItemPath,
      }) ||
      !isDeepStrictEqual(report.normalization, normalizeBrand(raw)) ||
      !root(raw.folder) ||
      !root(selection.parent.folder)
    )
      throw new TypeError('Brand strict original report/body/root binding disagreement');
    for (const native of [raw, selection.parent]) {
      if (
        native.managedContentId !== selection.inventory.parentId ||
        native.managedContentVariantId !== variantId ||
        native.language !== row[0].Language ||
        native.isPublished !== row[0].IsPublished ||
        !record(native.status) ||
        native.status.status !== row[0].ManagedContentVariantStatus ||
        native.title !== row[0].Name ||
        native.urlName !== row[0].UrlName ||
        native.contentKey !== row[0].ManagedContentKey ||
        native.apiName !== (row[0].ManagedContent as NativeRecord).ApiName
      )
        throw new TypeError('Brand canonical/native identity disagreement');
    }
    return {
      workspaceApiName,
      workspaceId: manifest.workspaceId,
      apiName: raw.apiName as string,
      contentType: 'sfdc_cms__brand',
      folderPath: [],
      variantId,
      raw: structuredClone(raw),
      parent: selection.parent,
      siblings: { complete: true, variants: [structuredClone(raw)] },
    };
  });
  projectSourceDefinitions(result);
  return result;
}
