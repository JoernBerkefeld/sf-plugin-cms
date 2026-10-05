import { isDeepStrictEqual } from 'node:util';
import { SOURCE_PROFILES } from '../contracts/source-definition.js';
import { assertExactKeys, assertRelativePosixPath } from '../contracts/shared.js';
import {
  assertWorkspaceExportManifest,
  type WorkspaceExportManifest,
} from '../contracts/workspace-export.js';
import { projectSourceDefinitions, type SourceDefinitionInputItem } from './source-definition.js';
import {
  requiredContentIdentifier,
  requiredVariantIdentifier,
  variantIdentity,
} from './variant-identity.js';

export type SourceAdmissionEvidence = {
  readonly contract: 'sf-cms-source-admission';
  readonly contractVersion: '1.0.0';
  readonly workspace: Readonly<Record<string, unknown>>;
  readonly inventory: {
    readonly contentType: (typeof SOURCE_PROFILES)[number]['contentType'];
    readonly pages: readonly {
      readonly page: number;
      readonly response: Readonly<Record<string, unknown>>;
    }[];
    readonly variants: readonly Readonly<Record<string, unknown>>[];
  };
  readonly selections: readonly {
    readonly rawItemPath: string;
    readonly variantId: string;
    readonly parent: Readonly<Record<string, unknown>>;
  }[];
};

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// Validate all retained native fields, without removing fields or coercing non-JSON values.
function json(value: unknown, ancestors = new Set<object>()): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'object' || value === null || ancestors.has(value))
    throw new TypeError('Source admission evidence must contain only JSON values');
  if (
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) !== Object.prototype &&
    Object.getPrototypeOf(value) !== null
  )
    throw new TypeError('Source admission evidence must contain JSON objects');
  ancestors.add(value);
  let result: unknown;
  if (Array.isArray(value)) {
    if (
      Object.keys(value).length !== value.length ||
      Reflect.ownKeys(value).length !== value.length + 1 ||
      Object.keys(value).some((key, index) => key !== String(index))
    )
      throw new TypeError('Source admission evidence requires JSON arrays');
    result = value.map((child: unknown) => json(child, ancestors));
  } else {
    if (Reflect.ownKeys(value).length !== Object.keys(value).length)
      throw new TypeError('Source admission evidence requires JSON object keys');
    result = Object.fromEntries(
      Object.keys(value)
        .toSorted()
        .map((key) => [key, json((value as Record<string, unknown>)[key], ancestors)]),
    );
  }
  ancestors.delete(value);
  return result;
}

function ordered(ids: readonly string[]): void {
  if (ids.some((id, index) => typeof id !== 'string' || !id || (index > 0 && ids[index - 1] >= id)))
    throw new TypeError('Source admission IDs must be unique and exactly sorted');
}

function assertEvidence(value: unknown): asserts value is SourceAdmissionEvidence {
  json(value);
  assertExactKeys(
    value,
    ['contract', 'contractVersion', 'workspace', 'inventory', 'selections'],
    'Source admission',
  );
  if (value.contract !== 'sf-cms-source-admission' || value.contractVersion !== '1.0.0')
    throw new TypeError('Unsupported source admission contract/version');
  if (!record(value.workspace)) throw new TypeError('Source admission workspace must be an object');
  assertExactKeys(value.inventory, ['contentType', 'pages', 'variants'], 'Source inventory');
  const family = value.inventory.contentType;
  if (!SOURCE_PROFILES.some((profile) => profile.contentType === family))
    throw new TypeError('Unsupported source admission family');
  const { pages, variants } = value.inventory;
  if (
    !Array.isArray(pages) ||
    pages.length === 0 ||
    pages.length > 1000 ||
    !Array.isArray(variants)
  )
    throw new TypeError('Source inventory requires bounded pages and variants');
  for (const [index, page] of pages.entries()) {
    assertExactKeys(page, ['page', 'response'], 'Source search page');
    if (page.page !== index || !record(page.response))
      throw new TypeError('Source search pages must be consecutive from zero');
  }
  ordered(
    variants.map((variant: unknown) => {
      if (!record(variant)) throw new TypeError('Source variant must be an object');
      return requiredVariantIdentifier(variant);
    }),
  );
  if (!Array.isArray(value.selections) || value.selections.length === 0)
    throw new TypeError('Source selections must not be empty');
  for (const selection of value.selections) {
    assertExactKeys(selection, ['rawItemPath', 'variantId', 'parent'], 'Source selection');
    assertRelativePosixPath(selection.rawItemPath, 'Source raw item path');
    if (!record(selection.parent)) throw new TypeError('Source parent must be an object');
  }
  ordered(
    value.selections.map(
      (selection: SourceAdmissionEvidence['selections'][number]) => selection.variantId,
    ),
  );
}

/**
 * Serialize detached historical JSON deterministically, without claiming acquisition authenticity.
 * @param {SourceAdmissionEvidence} evidence - Original source admission records.
 * @returns {string} Sorted, two-space JSON with a terminal LF.
 */
export function serializeSourceAdmissionEvidence(evidence: SourceAdmissionEvidence): string {
  assertEvidence(evidence);
  return `${JSON.stringify(json(evidence), null, 2)}\n`;
}

/**
 * Replay original admission against already hash-verified baseline records, never candidate definitions.
 * @param {unknown} evidence - Retained original workspace/search/GET evidence.
 * @param {WorkspaceExportManifest} manifest - Baseline manifest, whose integrity the caller verifies.
 * @param {ReadonlyMap<string, Readonly<Record<string, unknown>>>} rawItems - Original JSON keyed by entry.file.
 * @returns {readonly SourceDefinitionInputItem[]} Detached, projection-qualified original inputs.
 */
export function replaySourceAdmissionEvidence(
  evidence: unknown,
  manifest: WorkspaceExportManifest,
  rawItems: ReadonlyMap<string, Readonly<Record<string, unknown>>>,
): readonly SourceDefinitionInputItem[] {
  assertEvidence(evidence);
  assertWorkspaceExportManifest(manifest);
  const source = structuredClone(evidence);
  const { workspace, inventory, selections } = source;
  const workspaceId = manifest.workspaceId;
  if (workspace.id !== workspaceId || typeof workspace.name !== 'string' || !workspace.name)
    throw new TypeError('Exact original source workspace API-name evidence is required');
  if (
    !isDeepStrictEqual(manifest.search, {
      contentSpaceOrFolderIds: [workspaceId],
      languages: ['All'],
      pageSize: 250,
      queryTerm: '*',
    })
  )
    throw new TypeError('Unsupported source search semantics');
  if (
    manifest.completeness !== 'complete' ||
    manifest.rejectedVariantIds.length > 0 ||
    manifest.failedVariantIds.length > 0 ||
    manifest.expectedCount !== selections.length ||
    manifest.foundCount !== selections.length ||
    manifest.exportedCount !== selections.length ||
    manifest.entries.length !== selections.length ||
    rawItems.size !== selections.length
  )
    throw new TypeError('Source selections require a complete bijective baseline');
  const ids = new Set<string>();
  let expected: number | undefined;
  let terminated = false;
  const template = inventory.contentType === 'sfdc_cms__emailTemplate';
  for (const { response } of inventory.pages) {
    if (terminated || !Array.isArray(response.items) || response.items.length > 250)
      throw new TypeError('Source search has invalid or extra pages');
    const count = [response.total, response.totalCount, response.count].find(
      (candidate) => typeof candidate === 'number' && Number.isInteger(candidate) && candidate >= 0,
    );
    if (typeof count !== 'number')
      throw new TypeError('Source search requires a nonnegative integer count');
    expected ??= count;
    if (
      (template && count !== response.items.length) ||
      (!template &&
        (expected > 250_000 ||
          inventory.pages.length > Math.min(1000, Math.max(1, Math.ceil(expected / 250) + 2))))
    )
      throw new TypeError('Source inventory count/capacity disagreement');
    for (const row of response.items) {
      if (
        !record(row) ||
        row.type !== 'ManagedContentVariantSearchResultRepresentation' ||
        typeof row.id !== 'string' ||
        !row.id ||
        row.managedContentSpaceId !== workspaceId
      )
        throw new TypeError('Unsupported source search representation/ownership');
      if (ids.has(row.id)) throw new TypeError('Duplicate source search variant');
      ids.add(row.id);
    }
    terminated = template ? response.items.length < 250 : ids.size === expected;
    if (!template && (ids.size > expected || (!terminated && response.items.length === 0)))
      throw new TypeError('Source inventory total/truncation disagreement');
  }
  if (!terminated || ids.size !== inventory.variants.length)
    throw new TypeError('Source inventory is incomplete or exceeds page capacity');
  const variants = new Map<string, Readonly<Record<string, unknown>>>();
  const siblings = new Map<string, Readonly<Record<string, unknown>>[]>();
  for (const raw of inventory.variants) {
    const id = requiredVariantIdentifier(raw);
    const contentId = requiredContentIdentifier(raw);
    variantIdentity(raw, id);
    const type = record(raw.contentType) ? raw.contentType.fullyQualifiedName : raw.contentType;
    if (
      !ids.has(id) ||
      type !== inventory.contentType ||
      !record(raw.contentSpace) ||
      raw.contentSpace.id !== workspaceId
    )
      throw new TypeError('Source inventory exact family/identity/ownership disagreement');
    variants.set(id, raw);
    const group = siblings.get(contentId) ?? [];
    group.push(raw);
    siblings.set(contentId, group);
  }
  const entries = new Map(manifest.entries.map((entry) => [entry.file, entry.variantId]));
  if (
    entries.size !== selections.length ||
    new Set(manifest.entries.map((entry) => entry.variantId)).size !== selections.length
  )
    throw new TypeError('Duplicate source baseline entry binding');
  const paths = new Set<string>();
  const root = (folder: unknown): boolean =>
    folder === null ||
    (record(folder) &&
      typeof workspace.rootFolderId === 'string' &&
      workspace.rootFolderId.length > 0 &&
      workspace.rootFolderId !== workspaceId &&
      folder.id === workspace.rootFolderId);
  const result = selections.map(({ rawItemPath, variantId, parent }): SourceDefinitionInputItem => {
    const raw = variants.get(variantId);
    const original = rawItems.get(rawItemPath);
    if (
      !raw ||
      paths.has(rawItemPath) ||
      entries.get(rawItemPath) !== variantId ||
      !original ||
      !isDeepStrictEqual(raw, original)
    )
      throw new TypeError('Source selected raw baseline/inventory binding disagreement');
    paths.add(rawItemPath);
    if (!root(raw.folder) || !root(parent.folder))
      throw new TypeError('Source folder ancestry is unknown or non-root');
    return {
      workspaceApiName: workspace.name as string,
      workspaceId,
      apiName: raw.apiName as string,
      contentType: inventory.contentType,
      folderPath: [],
      variantId,
      raw,
      parent,
      siblings: { complete: true, variants: siblings.get(requiredContentIdentifier(raw))! },
    };
  });
  projectSourceDefinitions(result);
  return result;
}
