import {
  assertExactKeys,
  assertIdentifier,
  assertNonemptyString,
  assertReferenceId,
  assertSha256,
} from './shared.js';

export const WORKSPACE_IMPORT_CONTRACT = 'sf-cms-workspace-import' as const;
export const WORKSPACE_IMPORT_OPERATIONS = ['created', 'matched', 'updated', 'unchanged'] as const;
export const WORKSPACE_IMPORT_MAPPING_STATUSES = [
  'resolved',
  'unresolved',
  'ambiguous',
  'failed',
] as const;
export const WORKSPACE_IMPORT_REFERENCE_STATUSES = [
  ...WORKSPACE_IMPORT_MAPPING_STATUSES,
  'unsupported',
] as const;

export type WorkspaceImportMapping = {
  referenceId: string;
  kind: string;
  source: {
    sourceId: string;
    portableKey: {
      scheme: 'cms-opaque-v1';
      value: string;
    };
  };
  target: {
    targetId: string;
    targetReference: string;
  };
  operation: (typeof WORKSPACE_IMPORT_OPERATIONS)[number];
  status: (typeof WORKSPACE_IMPORT_MAPPING_STATUSES)[number];
  cmsReferencesRewritten: boolean;
};

export type WorkspaceImportReference = {
  referenceId: string;
  kind: string;
  status: (typeof WORKSPACE_IMPORT_REFERENCE_STATUSES)[number];
};

export type WorkspaceImportResult = {
  sourcePackage: {
    manifestSha256: string;
    workspaceId: string;
  };
  target: {
    orgId: string;
    workspaceId: string;
  };
  integrity: {
    listedItemCount: number;
    verifiedItemCount: number;
    unlistedFileCount: number;
    verified: boolean;
  };
  mappings: WorkspaceImportMapping[];
  references: WorkspaceImportReference[];
};

export function assertWorkspaceImportResult(
  value: unknown,
): asserts value is WorkspaceImportResult {
  assertExactKeys(
    value,
    ['sourcePackage', 'target', 'integrity', 'mappings', 'references'],
    'result',
  );
  assertExactKeys(value.sourcePackage, ['manifestSha256', 'workspaceId'], 'result.sourcePackage');
  assertSha256(value.sourcePackage.manifestSha256, 'result.sourcePackage.manifestSha256');
  assertIdentifier(value.sourcePackage.workspaceId, 'result.sourcePackage.workspaceId');
  assertExactKeys(value.target, ['orgId', 'workspaceId'], 'result.target');
  assertIdentifier(value.target.orgId, 'result.target.orgId');
  assertIdentifier(value.target.workspaceId, 'result.target.workspaceId');
  assertExactKeys(
    value.integrity,
    ['listedItemCount', 'verifiedItemCount', 'unlistedFileCount', 'verified'],
    'result.integrity',
  );
  for (const key of ['listedItemCount', 'verifiedItemCount', 'unlistedFileCount'] as const) {
    assertCount(value.integrity[key], `result.integrity.${key}`);
  }
  if (typeof value.integrity.verified !== 'boolean')
    throw new TypeError('result.integrity.verified must be boolean');
  if (
    value.integrity.verified &&
    value.integrity.listedItemCount !== value.integrity.verifiedItemCount
  ) {
    throw new TypeError('verified integrity requires all listed items to be verified');
  }
  if (!Array.isArray(value.mappings) || !Array.isArray(value.references)) {
    throw new TypeError('result mappings/references arrays are required');
  }
  assertMappings(value.mappings);
  assertReferences(value.references);
}

function assertMappings(values: unknown[]): void {
  const references = new Map<string, string>();
  const targets = new Map<string, string>();
  let previous = '';
  for (const [index, value] of values.entries()) {
    const label = `result.mappings[${index}]`;
    assertExactKeys(
      value,
      ['referenceId', 'kind', 'source', 'target', 'operation', 'status', 'cmsReferencesRewritten'],
      label,
    );
    assertReferenceId(value.referenceId, `${label}.referenceId`);
    assertIdentifier(value.kind, `${label}.kind`);
    assertExactKeys(value.source, ['sourceId', 'portableKey'], `${label}.source`);
    assertIdentifier(value.source.sourceId, `${label}.source.sourceId`);
    assertExactKeys(value.source.portableKey, ['scheme', 'value'], `${label}.source.portableKey`);
    if (value.source.portableKey.scheme !== 'cms-opaque-v1')
      throw new TypeError(`${label}.source.portableKey.scheme is unsupported`);
    assertNonemptyString(value.source.portableKey.value, `${label}.source.portableKey.value`);
    assertExactKeys(value.target, ['targetId', 'targetReference'], `${label}.target`);
    assertIdentifier(value.target.targetId, `${label}.target.targetId`);
    assertNonemptyString(value.target.targetReference, `${label}.target.targetReference`);
    if (
      !WORKSPACE_IMPORT_OPERATIONS.includes(value.operation as WorkspaceImportMapping['operation'])
    ) {
      throw new TypeError(`${label}.operation is unsupported`);
    }
    if (
      !WORKSPACE_IMPORT_MAPPING_STATUSES.includes(value.status as WorkspaceImportMapping['status'])
    ) {
      throw new TypeError(`${label}.status is unsupported`);
    }
    if (typeof value.cmsReferencesRewritten !== 'boolean')
      throw new TypeError(`${label}.cmsReferencesRewritten must be boolean`);
    if (value.status === 'resolved' && value.cmsReferencesRewritten !== true) {
      throw new TypeError(`${label} cannot be resolved before CMS references are rewritten`);
    }
    const sortKey = `${value.kind}\u0000${value.referenceId}`;
    if (sortKey.localeCompare(previous) < 0) throw new TypeError('result.mappings must be sorted');
    previous = sortKey;
    const mappingValue = `${value.kind}\u0000${value.source.sourceId}\u0000${value.source.portableKey.value}\u0000${value.target.targetId}\u0000${value.target.targetReference}`;
    if (references.has(value.referenceId))
      throw new TypeError(`duplicate mapping reference: ${value.referenceId}`);
    references.set(value.referenceId, mappingValue);
    const targetKey = `${value.kind}\u0000${value.target.targetReference}`;
    const priorTarget = targets.get(targetKey);
    if (priorTarget !== undefined && priorTarget !== value.referenceId) {
      throw new TypeError(`conflicting target reference: ${value.target.targetReference}`);
    }
    targets.set(targetKey, value.referenceId);
  }
}

function assertReferences(values: unknown[]): void {
  const seen = new Set<string>();
  let previous = '';
  for (const [index, value] of values.entries()) {
    const label = `result.references[${index}]`;
    assertExactKeys(value, ['referenceId', 'kind', 'status'], label);
    assertReferenceId(value.referenceId, `${label}.referenceId`);
    assertIdentifier(value.kind, `${label}.kind`);
    if (
      !WORKSPACE_IMPORT_REFERENCE_STATUSES.includes(
        value.status as WorkspaceImportReference['status'],
      )
    ) {
      throw new TypeError(`${label}.status is unsupported`);
    }
    const key = `${value.kind}\u0000${value.referenceId}`;
    if (key.localeCompare(previous) < 0) throw new TypeError('result.references must be sorted');
    if (seen.has(key)) throw new TypeError(`duplicate reference: ${key}`);
    seen.add(key);
    previous = key;
  }
}

function assertCount(value: unknown, label: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a nonnegative integer`);
  }
}
