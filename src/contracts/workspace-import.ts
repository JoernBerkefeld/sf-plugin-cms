import {
  assertExactKeys,
  assertIdentifier,
  assertNonemptyString,
  assertReferenceId,
  assertSha256,
} from './shared.js';

export const WORKSPACE_IMPORT_CONTRACT = 'sf-cms-workspace-import' as const;
export const WORKSPACE_IMPORT_CONTRACT_V2 = 'sf-cms-workspace-import@2' as const;
export const WORKSPACE_IMPORT_OPERATIONS = ['created', 'matched', 'updated', 'unchanged'] as const;
export const IMAGE_IMPORT_IDENTITY_FIELDS = ['contentKey', 'apiName', 'title', 'urlName'] as const;
export const IMAGE_IMPORT_STRATEGIES = ['preserve', 'fresh', 'generated'] as const;

export type ComponentStableIdentity = {
  family: 'cms';
  type: string;
  apiName: string;
  title?: string;
  workspaceId?: string;
  language?: string;
  serverId?: string;
  version?: string;
};

export type ComponentResolutionEvidence = {
  method: 'explicit-map' | 'api-name' | 'title-fallback';
  target: ComponentStableIdentity;
};

export type ImageImportIdentityField = (typeof IMAGE_IMPORT_IDENTITY_FIELDS)[number];
export type ImageImportStrategy = (typeof IMAGE_IMPORT_STRATEGIES)[number];
export type ImageImportFieldPlan = {
  strategy: ImageImportStrategy;
  source?: string;
  submitted?: string;
  returned?: string;
};

export type WorkspaceImageImportAssetResult = {
  source: ComponentStableIdentity;
  resolution?: ComponentResolutionEvidence;
  mutation?: {
    requestSha256: string;
    contentId: string;
    variantId: string;
  };
  identities: Record<ImageImportIdentityField, ImageImportFieldPlan>;
  binary: {
    path: string;
    sha256: string;
    md5: string;
    bytes: number;
    mimeType: string;
  };
  metadataReadback: 'not-attempted' | 'passed' | 'failed';
  byteProof: 'passed' | 'unavailable' | 'failed';
  operationStatus: 'planned' | 'succeeded' | 'failed';
  reportStatus: 'not-created' | 'recorded' | 'failed';
};

export type WorkspaceImageImportResultV2 = {
  sourcePackage: { manifestSha256: string; workspaceId: string; manifestVersion: 2 };
  target: { orgId: string; workspaceId: string };
  status: 'planned' | 'completed' | 'failed';
  assets: WorkspaceImageImportAssetResult[];
};

export class InvalidImageImportMapError extends TypeError {
  public readonly code = 'INVALID_IMAGE_IMPORT_MAP' as const;

  public constructor(message: string) {
    super(message);
    this.name = 'InvalidImageImportMapError';
  }
}

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

function assertComponentIdentity(
  value: unknown,
  label: string,
): asserts value is ComponentStableIdentity {
  const identity = value as Partial<ComponentStableIdentity>;
  assertExactKeys(
    value,
    [
      'family',
      'type',
      'apiName',
      ...(identity.title === undefined ? [] : ['title']),
      ...(identity.workspaceId === undefined ? [] : ['workspaceId']),
      ...(identity.language === undefined ? [] : ['language']),
      ...(identity.serverId === undefined ? [] : ['serverId']),
      ...(identity.version === undefined ? [] : ['version']),
    ],
    label,
  );
  if (identity.family !== 'cms') throw new TypeError(`${label}.family is unsupported`);
  assertIdentifier(identity.type, `${label}.type`);
  assertNonemptyString(identity.apiName, `${label}.apiName`);
  for (const key of ['title', 'workspaceId', 'language'] as const) {
    if (identity[key] !== undefined) assertNonemptyString(identity[key], `${label}.${key}`);
  }
  if (identity.serverId !== undefined) assertIdentifier(identity.serverId, `${label}.serverId`);
  if (identity.version !== undefined) assertNonemptyString(identity.version, `${label}.version`);
}

export function assertWorkspaceImageImportResultV2(
  value: unknown,
): asserts value is WorkspaceImageImportResultV2 {
  assertExactKeys(value, ['sourcePackage', 'target', 'status', 'assets'], 'result');
  assertExactKeys(
    value.sourcePackage,
    ['manifestSha256', 'workspaceId', 'manifestVersion'],
    'result.sourcePackage',
  );
  assertSha256(value.sourcePackage.manifestSha256, 'result.sourcePackage.manifestSha256');
  assertIdentifier(value.sourcePackage.workspaceId, 'result.sourcePackage.workspaceId');
  if (value.sourcePackage.manifestVersion !== 2)
    throw new TypeError('result.sourcePackage.manifestVersion must be 2');
  assertExactKeys(value.target, ['orgId', 'workspaceId'], 'result.target');
  assertIdentifier(value.target.orgId, 'result.target.orgId');
  assertIdentifier(value.target.workspaceId, 'result.target.workspaceId');
  if (!['planned', 'completed', 'failed'].includes(value.status as string))
    throw new TypeError('result.status is invalid');
  if (!Array.isArray(value.assets) || value.assets.length === 0)
    throw new TypeError('result.assets must be a nonempty array');
  let previous = '';
  const sources = new Set<string>();
  for (const [index, asset] of value.assets.entries()) {
    const label = `result.assets[${index}]`;
    assertExactKeys(
      asset,
      [
        'source',
        ...(asset.resolution === undefined ? [] : ['resolution']),
        ...(asset.mutation === undefined ? [] : ['mutation']),
        'identities',
        'binary',
        'metadataReadback',
        'byteProof',
        'operationStatus',
        'reportStatus',
      ],
      label,
    );
    assertComponentIdentity(asset.source, `${label}.source`);
    if (asset.resolution !== undefined) {
      assertExactKeys(asset.resolution, ['method', 'target'], `${label}.resolution`);
      if (
        !['explicit-map', 'api-name', 'title-fallback'].includes(asset.resolution.method as string)
      ) {
        throw new TypeError(`${label}.resolution.method is invalid`);
      }
      assertComponentIdentity(asset.resolution.target, `${label}.resolution.target`);
    }
    if (asset.mutation !== undefined) {
      assertExactKeys(
        asset.mutation,
        ['requestSha256', 'contentId', 'variantId'],
        `${label}.mutation`,
      );
      assertSha256(asset.mutation.requestSha256, `${label}.mutation.requestSha256`);
      assertIdentifier(asset.mutation.contentId, `${label}.mutation.contentId`);
      assertIdentifier(asset.mutation.variantId, `${label}.mutation.variantId`);
    }
    const sourceKey = `${asset.source.family}\0${asset.source.type}\0${asset.source.apiName}`;
    if (sourceKey.localeCompare(previous) < 0)
      throw new TypeError('result.assets must be sorted by typed source identity');
    if (sources.has(sourceKey)) throw new TypeError('duplicate result asset source');
    previous = sourceKey;
    sources.add(sourceKey);
    assertExactKeys(asset.identities, IMAGE_IMPORT_IDENTITY_FIELDS, `${label}.identities`);
    for (const field of IMAGE_IMPORT_IDENTITY_FIELDS) {
      const plan = asset.identities[field] as Partial<ImageImportFieldPlan>;
      const planLabel = `${label}.identities.${field}`;
      assertExactKeys(
        plan,
        [
          'strategy',
          ...(plan.source === undefined ? [] : ['source']),
          ...(plan.submitted === undefined ? [] : ['submitted']),
          ...(plan.returned === undefined ? [] : ['returned']),
        ],
        planLabel,
      );
      if (!IMAGE_IMPORT_STRATEGIES.includes(plan.strategy as ImageImportStrategy))
        throw new TypeError(`${planLabel}.strategy is invalid`);
      for (const key of ['source', 'submitted', 'returned'] as const) {
        if (plan[key] !== undefined) assertNonemptyString(plan[key], `${planLabel}.${key}`);
      }
    }
    assertExactKeys(
      asset.binary,
      ['path', 'sha256', 'md5', 'bytes', 'mimeType'],
      `${label}.binary`,
    );
    assertNonemptyString(asset.binary.path, `${label}.binary.path`);
    assertSha256(asset.binary.sha256, `${label}.binary.sha256`);
    if (typeof asset.binary.md5 !== 'string' || !/^[a-f\d]{32}$/u.test(asset.binary.md5))
      throw new TypeError(`${label}.binary.md5 is invalid`);
    assertCount(asset.binary.bytes, `${label}.binary.bytes`);
    assertNonemptyString(asset.binary.mimeType, `${label}.binary.mimeType`);
    if (!['not-attempted', 'passed', 'failed'].includes(asset.metadataReadback as string))
      throw new TypeError(`${label}.metadataReadback is invalid`);
    if (!['passed', 'unavailable', 'failed'].includes(asset.byteProof as string))
      throw new TypeError(`${label}.byteProof is invalid`);
    if (!['planned', 'succeeded', 'failed'].includes(asset.operationStatus as string))
      throw new TypeError(`${label}.operationStatus is invalid`);
    if (!['not-created', 'recorded', 'failed'].includes(asset.reportStatus as string))
      throw new TypeError(`${label}.reportStatus is invalid`);
  }
}

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
