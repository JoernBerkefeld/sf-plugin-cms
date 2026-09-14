import {
  assertDiagnostics,
  assertExactKeys,
  assertIdentifier,
  assertNonemptyString,
  assertOpaqueCmsReference,
  assertRelativePosixPath,
  assertSha256,
  type CmsDiagnostics,
  type CmsProvenance,
  type OpaqueCmsReference,
} from './shared.js';

export const WORKSPACE_EXPORT_SET_CONTRACT = 'sf-cms-workspace-export-set' as const;
export const WORKSPACE_EXPORT_MANIFEST_CONTRACT = 'sf-cms-workspace-export' as const;
export const EXTERNAL_REFERENCE_CORRELATIONS_CONTRACT =
  'sf-cms-external-reference-correlations@1' as const;

export type WorkspaceExportManifestItem = {
  path: string;
  sha256: string;
  kind: string;
  referenceId?: string;
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
  entries: Array<{ file: string; variantId: string }>;
  rejectedVariantIds: string[];
  failedVariantIds: string[];
  warnings: Array<{
    code:
      | 'COUNT_MISMATCH'
      | 'DETAIL_FAILED'
      | 'DUPLICATE_VARIANTS'
      | 'OWNERSHIP_MISMATCH'
      | 'PREMATURE_EMPTY_PAGE'
      | 'REFERENCE_UNRESOLVED'
      | 'REFERENCE_UNSUPPORTED'
      | 'UNSUPPORTED_WILDCARD';
    message: string;
    variantIds?: string[];
  }>;
  contract: typeof WORKSPACE_EXPORT_MANIFEST_CONTRACT;
  contractVersion: '1.0.0';
  provenance: {
    producer: 'sf-plugin-cms';
    sourceOrgId: string;
    sourceWorkspaceId: string;
    pluginVersion: string;
    generatedAt: string;
  };
  completeness: 'complete' | 'partial';
  dependencies: string[];
  externalReferences: OpaqueCmsReference[];
  items: WorkspaceExportManifestItem[];
};

export type ExternalReferenceCorrelation = {
  sourceWorkspaceId: string;
  sourceReference: string;
  referenceKind: string;
  referenceId: string;
  packageManifestSha256: string;
};

export type WorkspaceExportSetEntry = {
  source: {
    kind: 'cms.workspace';
    sourceId: string;
    name: string;
    workspaceType: 'Marketing' | 'Content';
  };
  status: 'success' | 'partial' | 'failed';
  artifact: {
    path: string;
    manifestPath: string;
    manifestContract: typeof WORKSPACE_EXPORT_MANIFEST_CONTRACT;
    manifestContractVersion: '1.0.0';
    manifestSha256: string;
  } | null;
  diagnostics: CmsDiagnostics;
};

export type WorkspaceExportSetResult = {
  workspaceType: 'Marketing' | 'Content';
  outputDirectory: string;
  selection: {
    mode: 'all';
    discoveredCount: number;
    selectedCount: number;
  };
  summary: {
    succeededCount: number;
    partialCount: number;
    failedCount: number;
  };
  externalReferenceCorrelations: ExternalReferenceCorrelation[];
  workspaces: WorkspaceExportSetEntry[];
};

export function assertWorkspaceExportManifest(
  value: unknown,
): asserts value is WorkspaceExportManifest {
  assertExactKeys(
    value,
    [
      'schemaVersion',
      'mode',
      'workspaceId',
      'search',
      'expectedCount',
      'foundCount',
      'exportedCount',
      'pagesRequested',
      'entries',
      'rejectedVariantIds',
      'failedVariantIds',
      'warnings',
      'contract',
      'contractVersion',
      'provenance',
      'completeness',
      'dependencies',
      'externalReferences',
      'items',
    ],
    'manifest',
  );
  if (value.schemaVersion !== 1 || value.mode !== 'experimental-best-effort') {
    throw new TypeError('manifest schemaVersion/mode is unsupported');
  }
  assertIdentifier(value.workspaceId, 'manifest.workspaceId');
  assertExactKeys(
    value.search,
    ['contentSpaceOrFolderIds', 'languages', 'pageSize', 'queryTerm'],
    'manifest.search',
  );
  if (
    !Array.isArray(value.search.contentSpaceOrFolderIds) ||
    value.search.contentSpaceOrFolderIds.length !== 1 ||
    value.search.contentSpaceOrFolderIds[0] !== value.workspaceId ||
    !Array.isArray(value.search.languages) ||
    value.search.languages.length !== 1 ||
    value.search.languages[0] !== 'All' ||
    value.search.pageSize !== 250 ||
    value.search.queryTerm !== '*'
  ) {
    throw new TypeError('manifest.search is invalid');
  }
  for (const key of ['expectedCount', 'foundCount', 'exportedCount', 'pagesRequested'] as const) {
    assertCount(value[key], `manifest.${key}`);
  }
  assertLegacyManifestArrays(value);
  if (value.contract !== WORKSPACE_EXPORT_MANIFEST_CONTRACT || value.contractVersion !== '1.0.0') {
    throw new TypeError('manifest contract/version is unsupported');
  }
  assertExactKeys(
    value.provenance,
    ['producer', 'sourceOrgId', 'sourceWorkspaceId', 'pluginVersion', 'generatedAt'],
    'manifest.provenance',
  );
  if (value.provenance.producer !== 'sf-plugin-cms')
    throw new TypeError('manifest producer is invalid');
  assertIdentifier(value.provenance.sourceOrgId, 'manifest.provenance.sourceOrgId');
  assertIdentifier(value.provenance.sourceWorkspaceId, 'manifest.provenance.sourceWorkspaceId');
  if (value.provenance.sourceWorkspaceId !== value.workspaceId) {
    throw new TypeError('manifest provenance sourceWorkspaceId must match workspaceId');
  }
  assertNonemptyString(value.provenance.pluginVersion, 'manifest.provenance.pluginVersion');
  assertNonemptyString(value.provenance.generatedAt, 'manifest.provenance.generatedAt');
  if (value.completeness !== 'complete' && value.completeness !== 'partial') {
    throw new TypeError('manifest.completeness is invalid');
  }
  if (
    !Array.isArray(value.dependencies) ||
    !Array.isArray(value.externalReferences) ||
    !Array.isArray(value.items)
  ) {
    throw new TypeError('manifest arrays are required');
  }
  if (value.dependencies.length > 0) {
    throw new TypeError(
      'manifest.dependencies must be empty while dependency discovery is unavailable',
    );
  }
  let previousReference = '';
  const referenceIds = new Set<string>();
  for (const [index, reference] of value.externalReferences.entries()) {
    assertOpaqueCmsReference(reference, `manifest.externalReferences[${index}]`);
    if (reference.source.workspaceId !== value.workspaceId) {
      throw new TypeError(`manifest.externalReferences[${index}] workspaceId must match manifest`);
    }
    const sortKey = [reference.kind, reference.referenceId, reference.portableKey.value].join(
      '\u0000',
    );
    if (sortKey.localeCompare(previousReference) < 0) {
      throw new TypeError('manifest.externalReferences must be sorted');
    }
    previousReference = sortKey;
    if (referenceIds.has(reference.referenceId)) {
      throw new TypeError(`duplicate manifest reference ID: ${reference.referenceId}`);
    }
    referenceIds.add(reference.referenceId);
  }
  const paths = new Set<string>();
  for (const [index, item] of value.items.entries()) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw new TypeError(`manifest.items[${index}] must be an object`);
    }
    const keys = Object.keys(item).toSorted();
    if (
      JSON.stringify(keys) !==
      JSON.stringify(
        ['kind', 'path', 'referenceId', 'sha256'].filter((key) => key in item).toSorted(),
      )
    ) {
      throw new TypeError(`manifest.items[${index}] has invalid keys`);
    }
    assertRelativePosixPath(item.path, `manifest.items[${index}].path`);
    if (item.path === 'manifest.json')
      throw new TypeError('manifest.json must not be listed as an item');
    if (paths.has(item.path)) throw new TypeError(`duplicate manifest item path: ${item.path}`);
    paths.add(item.path);
    assertSha256(item.sha256, `manifest.items[${index}].sha256`);
    assertIdentifier(item.kind, `manifest.items[${index}].kind`);
    if (item.referenceId !== undefined && !referenceIds.has(item.referenceId)) {
      throw new TypeError(`manifest item has no reference descriptor: ${item.referenceId}`);
    }
  }
  if (value.completeness === 'complete' && hasAuthoritativeIncompleteness(value)) {
    throw new TypeError('manifest.completeness contradicts authoritative incompleteness evidence');
  }
}

function hasAuthoritativeIncompleteness(manifest: Record<string, unknown>): boolean {
  const warnings = manifest.warnings as WorkspaceExportManifest['warnings'];
  const externalReferences =
    manifest.externalReferences as WorkspaceExportManifest['externalReferences'];
  return (
    (manifest.rejectedVariantIds as unknown[]).length > 0 ||
    (manifest.failedVariantIds as unknown[]).length > 0 ||
    manifest.expectedCount !== manifest.foundCount ||
    manifest.foundCount !== manifest.exportedCount ||
    manifest.exportedCount !== (manifest.entries as unknown[]).length ||
    manifest.exportedCount !== (manifest.items as unknown[]).length ||
    warnings.some(({ code }) => code !== 'UNSUPPORTED_WILDCARD') ||
    externalReferences.some(
      ({ resolution }) => resolution === 'unresolved' || resolution === 'unsupported',
    )
  );
}

function assertLegacyManifestArrays(value: Record<string, unknown>): void {
  if (
    !Array.isArray(value.entries) ||
    !Array.isArray(value.rejectedVariantIds) ||
    !Array.isArray(value.failedVariantIds) ||
    !Array.isArray(value.warnings)
  ) {
    throw new TypeError('manifest legacy arrays are required');
  }
  const entryFiles = new Set<string>();
  for (const [index, entry] of value.entries.entries()) {
    const label = `manifest.entries[${index}]`;
    assertExactKeys(entry, ['file', 'variantId'], label);
    assertRelativePosixPath(entry.file, `${label}.file`);
    assertIdentifier(entry.variantId, `${label}.variantId`);
    if (entryFiles.has(entry.file))
      throw new TypeError(`duplicate manifest entry file: ${entry.file}`);
    entryFiles.add(entry.file);
  }
  for (const key of ['rejectedVariantIds', 'failedVariantIds'] as const) {
    const identifiers = value[key] as unknown[];
    for (const [index, identifier] of identifiers.entries()) {
      assertIdentifier(identifier, `manifest.${key}[${index}]`);
    }
  }
  for (const [index, warning] of value.warnings.entries()) {
    const label = `manifest.warnings[${index}]`;
    if (typeof warning !== 'object' || warning === null || Array.isArray(warning)) {
      throw new TypeError(`${label} must be an object`);
    }
    const keys = Object.keys(warning).toSorted();
    const expected = [
      'code',
      'message',
      ...(warning.variantIds === undefined ? [] : ['variantIds']),
    ].toSorted();
    if (JSON.stringify(keys) !== JSON.stringify(expected)) {
      throw new TypeError(`${label} has invalid keys`);
    }
    assertIdentifier(warning.code, `${label}.code`);
    assertNonemptyString(warning.message, `${label}.message`);
    if (warning.variantIds !== undefined) {
      if (!Array.isArray(warning.variantIds))
        throw new TypeError(`${label}.variantIds must be an array`);
      for (const [variantIndex, identifier] of warning.variantIds.entries()) {
        assertIdentifier(identifier, `${label}.variantIds[${variantIndex}]`);
      }
    }
  }
}

export function assertWorkspaceExportSetResult(
  value: unknown,
  provenance?: CmsProvenance,
  status?: 'success' | 'partial' | 'failed' | 'blocked',
): asserts value is WorkspaceExportSetResult {
  assertExactKeys(
    value,
    [
      'workspaceType',
      'outputDirectory',
      'selection',
      'summary',
      'externalReferenceCorrelations',
      'workspaces',
    ],
    'result',
  );
  if (value.workspaceType !== 'Marketing' && value.workspaceType !== 'Content') {
    throw new TypeError('result.workspaceType is invalid');
  }
  assertRelativePosixPath(value.outputDirectory, 'result.outputDirectory');
  assertExactKeys(
    value.selection,
    ['mode', 'discoveredCount', 'selectedCount'],
    'result.selection',
  );
  if (value.selection.mode !== 'all') throw new TypeError('result.selection.mode must be all');
  assertCount(value.selection.discoveredCount, 'result.selection.discoveredCount');
  assertCount(value.selection.selectedCount, 'result.selection.selectedCount');
  assertExactKeys(
    value.summary,
    ['succeededCount', 'partialCount', 'failedCount'],
    'result.summary',
  );
  for (const key of ['succeededCount', 'partialCount', 'failedCount'] as const) {
    assertCount(value.summary[key], `result.summary.${key}`);
  }
  if (!Array.isArray(value.workspaces) || !Array.isArray(value.externalReferenceCorrelations)) {
    throw new TypeError('result arrays are required');
  }
  const workspaceHashes = new Map<string, string>();
  let previousWorkspaceId = '';
  for (const [index, workspace] of value.workspaces.entries()) {
    assertWorkspaceEntry(workspace, index);
    if (workspace.source.sourceId.localeCompare(previousWorkspaceId) < 0) {
      throw new TypeError('result.workspaces must be sorted by source ID');
    }
    previousWorkspaceId = workspace.source.sourceId;
    if (workspace.artifact !== null)
      workspaceHashes.set(workspace.source.sourceId, workspace.artifact.manifestSha256);
  }
  const actualSummary = {
    succeededCount: value.workspaces.filter(
      ({ status: workspaceStatus }) => workspaceStatus === 'success',
    ).length,
    partialCount: value.workspaces.filter(
      ({ status: workspaceStatus }) => workspaceStatus === 'partial',
    ).length,
    failedCount: value.workspaces.filter(
      ({ status: workspaceStatus }) => workspaceStatus === 'failed',
    ).length,
  };
  if (value.selection.selectedCount !== value.workspaces.length) {
    throw new TypeError('result.selection.selectedCount must match workspace rows');
  }
  for (const key of ['succeededCount', 'partialCount', 'failedCount'] as const) {
    if (value.summary[key] !== actualSummary[key]) {
      throw new TypeError(`result.summary.${key} must match workspace rows`);
    }
  }
  let expectedStatus: 'success' | 'partial' | 'failed' = 'success';
  if (actualSummary.failedCount === value.workspaces.length && value.workspaces.length > 0) {
    expectedStatus = 'failed';
  } else if (actualSummary.failedCount > 0 || actualSummary.partialCount > 0) {
    expectedStatus = 'partial';
  }
  if (status !== undefined && status !== expectedStatus) {
    throw new TypeError('envelope status must match workspace rows');
  }
  assertCorrelations(value.externalReferenceCorrelations, workspaceHashes);
  if (value.externalReferenceCorrelations.length > 0) {
    if (provenance === undefined)
      throw new TypeError('export correlations require envelope provenance');
    if (provenance.producer !== 'sf-plugin-cms' || provenance.exportSetId === undefined) {
      throw new TypeError('export correlation provenance binding is incomplete');
    }
  }
}

function assertWorkspaceEntry(
  value: unknown,
  index: number,
): asserts value is WorkspaceExportSetEntry {
  const label = `result.workspaces[${index}]`;
  assertExactKeys(value, ['source', 'status', 'artifact', 'diagnostics'], label);
  assertExactKeys(value.source, ['kind', 'sourceId', 'name', 'workspaceType'], `${label}.source`);
  if (value.source.kind !== 'cms.workspace') throw new TypeError(`${label}.source.kind is invalid`);
  assertIdentifier(value.source.sourceId, `${label}.source.sourceId`);
  assertNonemptyString(value.source.name, `${label}.source.name`);
  if (value.source.workspaceType !== 'Marketing' && value.source.workspaceType !== 'Content') {
    throw new TypeError(`${label}.source.workspaceType is invalid`);
  }
  if (!['success', 'partial', 'failed'].includes(value.status as string))
    throw new TypeError(`${label}.status is invalid`);
  assertDiagnostics(value.diagnostics, `${label}.diagnostics`);
  if (value.artifact === null) {
    if (value.status !== 'failed') throw new TypeError(`${label}.artifact is required`);
    return;
  }
  assertExactKeys(
    value.artifact,
    ['path', 'manifestPath', 'manifestContract', 'manifestContractVersion', 'manifestSha256'],
    `${label}.artifact`,
  );
  assertRelativePosixPath(value.artifact.path, `${label}.artifact.path`);
  assertRelativePosixPath(value.artifact.manifestPath, `${label}.artifact.manifestPath`);
  if (value.artifact.manifestPath !== `${value.artifact.path}/manifest.json`) {
    throw new TypeError(`${label}.artifact.manifestPath is inconsistent`);
  }
  if (
    value.artifact.manifestContract !== WORKSPACE_EXPORT_MANIFEST_CONTRACT ||
    value.artifact.manifestContractVersion !== '1.0.0'
  ) {
    throw new TypeError(`${label}.artifact manifest contract/version is invalid`);
  }
  assertSha256(value.artifact.manifestSha256, `${label}.artifact.manifestSha256`);
}

function assertCorrelations(rows: unknown[], workspaceHashes: ReadonlyMap<string, string>): void {
  let previous = '';
  const sourceKeys = new Map<string, string>();
  const referenceIds = new Map<string, string>();
  for (const [index, row] of rows.entries()) {
    const label = `result.externalReferenceCorrelations[${index}]`;
    assertExactKeys(
      row,
      [
        'sourceWorkspaceId',
        'sourceReference',
        'referenceKind',
        'referenceId',
        'packageManifestSha256',
      ],
      label,
    );
    assertIdentifier(row.sourceWorkspaceId, `${label}.sourceWorkspaceId`);
    assertNonemptyString(row.sourceReference, `${label}.sourceReference`);
    assertIdentifier(row.referenceKind, `${label}.referenceKind`);
    if (row.referenceKind !== 'cms.content')
      throw new TypeError(`${label}.referenceKind is unsupported`);
    if (typeof row.referenceId !== 'string' || !/^ref:[a-f\d]{64}$/u.test(row.referenceId)) {
      throw new TypeError(`${label}.referenceId is invalid`);
    }
    assertSha256(row.packageManifestSha256, `${label}.packageManifestSha256`);
    if (workspaceHashes.get(row.sourceWorkspaceId) !== row.packageManifestSha256) {
      throw new TypeError(`${label} is not bound to its workspace package`);
    }
    const sortKey = [
      row.sourceWorkspaceId,
      row.sourceReference,
      row.referenceKind,
      row.referenceId,
      row.packageManifestSha256,
    ].join('\u0000');
    if (sortKey.localeCompare(previous) < 0) throw new TypeError('correlation rows must be sorted');
    previous = sortKey;
    const sourceKey = `${row.sourceWorkspaceId}\u0000${row.sourceReference}`;
    const sourceValue = `${row.referenceKind}\u0000${row.referenceId}\u0000${row.packageManifestSha256}`;
    if (sourceKeys.has(sourceKey))
      throw new TypeError(`duplicate or conflicting correlation source: ${sourceKey}`);
    sourceKeys.set(sourceKey, sourceValue);
    const referenceValue = `${row.sourceWorkspaceId}\u0000${row.sourceReference}\u0000${row.referenceKind}\u0000${row.packageManifestSha256}`;
    const prior = referenceIds.get(row.referenceId);
    if (prior !== undefined && prior !== referenceValue)
      throw new TypeError(`conflicting reference ID: ${row.referenceId}`);
    referenceIds.set(row.referenceId, referenceValue);
  }
}

function assertCount(value: unknown, label: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a nonnegative integer`);
  }
}
