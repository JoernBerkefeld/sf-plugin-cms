import { createHash } from 'node:crypto';
import {
  assertDependencyDescriptor,
  assertPortableIdentity,
  CMS_CAPABILITY_DECLARATIONS,
  METADATA_CAPABILITY_CONTRACT,
  METADATA_CAPABILITY_FIXTURE_SHA256,
  METADATA_CAPABILITY_VERSION,
  type DependencyDescriptor,
  type PortableIdentity,
  type ServerIdentity,
} from '../contracts/capability-registry.js';
import {
  assertCmsResolutionCacheScope,
  createCmsResolutionCacheEntry,
  hashCanonical,
  type CmsResolutionCacheScope,
} from '../contracts/resolution-cache.js';
import {
  PORTABLE_EXPORT_METADATA_CONTRACT,
  PORTABLE_EXPORT_METADATA_VERSION,
  serializePortableExportMetadata,
  type PortableExportMetadata,
} from './portable-export-metadata.js';
import { assertStrategyUsage, type StrategyUsage } from './capability-registry.js';

export const CMS_DEPLOY_PREFLIGHT_CONTRACT = 'sf-cms-deploy-preflight-v1' as const;
export const CMS_DEPLOY_PREFLIGHT_VERSION = '1.0.0' as const;

export type CmsDeployTargetEvidence = {
  readonly portableIdentity: PortableIdentity;
  readonly targetEvidence: {
    readonly workspace: ServerIdentity;
    readonly content: ServerIdentity;
    readonly variant: ServerIdentity;
    readonly contentKey: ServerIdentity;
    readonly folder?: ServerIdentity;
  };
  readonly workspaceApiName: string;
  readonly sourceHash: string;
  readonly scope: CmsResolutionCacheScope;
  readonly complete: boolean;
  readonly ownershipCertain: boolean;
  readonly observedAt?: string;
};

export type CmsDeployPackageNode = CmsDeployTargetEvidence & {
  readonly dependencies: readonly DependencyDescriptor[];
};

export type CmsDeployMapping = CmsDeployTargetEvidence;

export type CmsDeployPreflightInput = {
  readonly metadata: PortableExportMetadata;
  readonly sidecarSha256: string;
  readonly manifest: {
    readonly items: ReadonlyArray<{ readonly path: string; readonly sha256: string }>;
  };
  readonly manifestSha256: string;
  readonly manifestBytes: string;
  readonly packageFiles: ReadonlyArray<{ readonly path: string; readonly bytes: string }>;
  readonly packageNodes: readonly CmsDeployPackageNode[];
  readonly packageHash: string;
  readonly targetEvidence: readonly CmsDeployTargetEvidence[];
  readonly mappings?: readonly CmsDeployMapping[];
  readonly evidenceHash: string;
  readonly sourceHash: string;
  readonly requestHash: string;
  readonly source: unknown;
  readonly request: unknown;
  readonly targetWorkspaceApiName: string;
  readonly targetWorkspace: ServerIdentity;
  readonly sourceOrg: ServerIdentity;
  readonly targetOrg: ServerIdentity;
  readonly providerVersion: string;
  readonly apiVersion: string;
  readonly registryContract: typeof METADATA_CAPABILITY_CONTRACT;
  readonly registryVersion: typeof METADATA_CAPABILITY_VERSION;
  readonly registryFixtureSha256: typeof METADATA_CAPABILITY_FIXTURE_SHA256;
  readonly dependencyExtractorVersions: Readonly<Record<string, string>>;
  readonly usageByType: Readonly<Record<string, StrategyUsage>>;
  readonly now: string;
  readonly maxEvidenceAgeMs: number;
};

export type CmsDeployResolution = {
  readonly portableIdentity: PortableIdentity;
  readonly targetEvidence: CmsDeployTargetEvidence['targetEvidence'];
  readonly provenance: 'package' | 'mapping' | 'target';
  readonly evidenceHash: string;
};

export type CmsDeployOperationIntent = {
  readonly action: 'upsert';
  readonly portableIdentity: PortableIdentity;
  readonly target: ServerIdentity;
};

export type CmsDeployMutationWriters = {
  readonly createContent: (...arguments_: never[]) => unknown;
  readonly createVariant: (...arguments_: never[]) => unknown;
  readonly updateContent?: (...arguments_: never[]) => unknown;
};

export type CmsDeployPreflightReport = {
  readonly contract: typeof CMS_DEPLOY_PREFLIGHT_CONTRACT;
  readonly version: typeof CMS_DEPLOY_PREFLIGHT_VERSION;
  readonly ready: boolean;
  readonly hashes: {
    readonly package: string;
    readonly manifest: string;
    readonly evidence: string;
    readonly source: string;
    readonly request: string;
  };
  readonly resolutions: readonly CmsDeployResolution[];
  readonly operations: readonly CmsDeployOperationIntent[];
  readonly blockedReasons: readonly string[];
  readonly planHash: string;
};

type ResolutionIndex = Map<string, CmsDeployTargetEvidence[]>;

function sha256(bytes: string): string {
  return createHash('sha256').update(bytes, 'utf8').digest('hex');
}

function key(identity: PortableIdentity): string {
  return hashCanonical(identity);
}

function add(index: ResolutionIndex, evidence: CmsDeployTargetEvidence): void {
  const identityKey = key(evidence.portableIdentity);
  index.set(identityKey, [...(index.get(identityKey) ?? []), evidence]);
}

function indexEvidence(values: readonly CmsDeployTargetEvidence[]): ResolutionIndex {
  const index: ResolutionIndex = new Map();
  for (const value of values) add(index, value);
  return index;
}

function semver(value: string): readonly [number, number, number] | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)$/u.exec(value);
  return match === null ? undefined : [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compare(left: readonly number[], right: readonly number[]): number {
  for (const [index, value] of left.entries()) {
    if (value !== right[index]) return value - right[index];
  }
  return 0;
}

function exactOne(
  index: ResolutionIndex,
  identity: PortableIdentity,
): CmsDeployTargetEvidence | undefined {
  const matches = index.get(key(identity)) ?? [];
  return matches.length === 1 ? matches[0] : undefined;
}

function validateEvidence(
  value: CmsDeployTargetEvidence,
  input: CmsDeployPreflightInput,
  label: string,
  reasons: string[],
): void {
  try {
    assertPortableIdentity(value.portableIdentity);
    createCmsResolutionCacheEntry(value.portableIdentity, value.targetEvidence);
    assertCmsResolutionCacheScope(value.scope);
    for (const name of ['workspace', 'content', 'variant', 'contentKey'] as const) {
      const expectedKind = name === 'contentKey' ? 'content-key' : 'salesforce-id';
      if (value.targetEvidence[name].kind !== expectedKind) {
        reasons.push(`${label}: incorrect server identity kind`);
      }
    }
    if (
      hashCanonical(value.targetEvidence.workspace) !== hashCanonical(input.targetWorkspace) ||
      hashCanonical(value.scope.sourceOrg) !== hashCanonical(input.sourceOrg) ||
      hashCanonical(value.scope.targetOrg) !== hashCanonical(input.targetOrg) ||
      value.scope.apiVersion !== input.apiVersion ||
      value.scope.nativeWorkspace.workspaceApiName !== input.targetWorkspaceApiName ||
      value.scope.declaration.family !== value.portableIdentity.family ||
      value.scope.declaration.type !== value.portableIdentity.type
    ) {
      reasons.push(`${label}: exact scoped evidence binding mismatch`);
    }
  } catch {
    reasons.push(`${label}: invalid or partial exact identity evidence`);
  }
  if (value.workspaceApiName !== input.targetWorkspaceApiName) {
    reasons.push(`${label}: target workspace scope mismatch`);
  }
  if (value.sourceHash !== input.sourceHash) reasons.push(`${label}: source binding mismatch`);
  if (!value.complete || !value.ownershipCertain)
    reasons.push(`${label}: partial or ownership-uncertain evidence`);
}

function validateDescriptor(
  descriptor: DependencyDescriptor,
  input: CmsDeployPreflightInput,
  reasons: string[],
): void {
  try {
    assertDependencyDescriptor(descriptor);
  } catch {
    reasons.push('dependency descriptor is invalid or unsupported');
    return;
  }
  const declaration = CMS_CAPABILITY_DECLARATIONS.find(
    ({ identity }) =>
      identity.provider === 'sf-plugin-cms' &&
      identity.family === descriptor.target.family &&
      identity.type === descriptor.target.type,
  );
  if (declaration === undefined) {
    reasons.push(
      `unsupported dependency declaration: ${descriptor.target.family}/${descriptor.target.type}`,
    );
    return;
  }
  const extractor = input.dependencyExtractorVersions[descriptor.target.type];
  if (extractor !== declaration.dependencyExtractorVersion) {
    reasons.push(`dependency extractor version mismatch: ${descriptor.target.type}`);
  }
}

function validateEvidenceAge(
  value: CmsDeployTargetEvidence,
  input: CmsDeployPreflightInput,
  label: string,
  reasons: string[],
): void {
  const observedAt = value.observedAt === undefined ? Number.NaN : Date.parse(value.observedAt);
  const now = Date.parse(input.now);
  if (Number.isNaN(observedAt) || observedAt > now || now - observedAt > input.maxEvidenceAgeMs) {
    reasons.push(`${label}: stale evidence for ${value.portableIdentity.apiName}`);
  }
}

function validateRequiredPackageCycles(
  roots: PortableExportMetadata['roots'],
  index: ResolutionIndex,
  reasons: string[],
): void {
  const visited = new Set<string>();
  const active: PortableIdentity[] = [];
  function visit(identity: PortableIdentity): void {
    const identityKey = key(identity);
    const cycleStart = active.findIndex((candidate) => key(candidate) === identityKey);
    if (cycleStart !== -1) {
      const cycle = [...active.slice(cycleStart), identity];
      reasons.push(
        `required package dependency cycle: ${cycle.map((item) => `${item.type}/${item.apiName}`).join(' -> ')}`,
      );
      return;
    }
    if (visited.has(identityKey)) return;
    visited.add(identityKey);
    const node = exactOne(index, identity) as CmsDeployPackageNode | undefined;
    if (node === undefined) return;
    active.push(identity);
    for (const edge of node.dependencies) {
      if (edge.required && exactOne(index, edge.target) !== undefined) visit(edge.target);
    }
    active.pop();
  }
  for (const root of roots) visit(root.identity);
}

function uniqueReasons(values: readonly string[]): string[] {
  return [...new Set(values)].toSorted();
}

/**
 * Build a deterministic, zero-mutation CMS deploy preflight report.
 * @param {CmsDeployPreflightInput} input - Selected package, bindings, and exact target evidence.
 * @param {CmsDeployMutationWriters} [writers] - Mutation writers accepted only for zero-call proof.
 * @returns {CmsDeployPreflightReport} A ready dry-run plan or a complete blocked report.
 */
export function preflightCmsDeploy(
  input: CmsDeployPreflightInput,
  writers?: CmsDeployMutationWriters,
): CmsDeployPreflightReport {
  void writers;
  const reasons: string[] = [];
  const resolutions: CmsDeployResolution[] = [];
  const operations: CmsDeployOperationIntent[] = [];

  if (
    input.metadata.contract !== PORTABLE_EXPORT_METADATA_CONTRACT ||
    input.metadata.version !== PORTABLE_EXPORT_METADATA_VERSION
  ) {
    reasons.push('portable sidecar contract or version is unsupported');
  }
  try {
    for (const root of input.metadata.roots) {
      assertPortableIdentity(root.identity);
      if (root.identityHash !== key(root.identity))
        reasons.push('portable root identity hash mismatch');
      for (const descriptor of root.dependencies) {
        if (key(descriptor.source) !== key(root.identity))
          reasons.push('dependency source binding mismatch');
        validateDescriptor(descriptor, input, reasons);
      }
    }
  } catch {
    reasons.push('portable sidecar is invalid or partial');
  }

  try {
    const computedSidecarHash = sha256(serializePortableExportMetadata(input.metadata));
    if (computedSidecarHash !== input.sidecarSha256) reasons.push('portable sidecar hash mismatch');
  } catch {
    reasons.push('portable sidecar payload is invalid');
  }
  const selectedSidecars = input.manifest.items.filter(
    ({ path }) => path === 'phase5/portable-metadata.v1.json',
  );
  if (selectedSidecars.length !== 1 || selectedSidecars[0].sha256 !== input.sidecarSha256) {
    reasons.push('selected manifest is not bound to the portable sidecar');
  }
  if (sha256(input.manifestBytes) !== input.manifestSha256) reasons.push('manifest hash mismatch');
  try {
    if (hashCanonical(JSON.parse(input.manifestBytes)) !== hashCanonical(input.manifest))
      reasons.push('selected manifest content mismatch');
  } catch {
    reasons.push('selected manifest bytes are invalid');
  }
  const filePaths = input.packageFiles.map(({ path }) => path);
  if (
    new Set(filePaths).size !== filePaths.length ||
    input.manifest.items.length !== filePaths.length
  )
    reasons.push('package files are duplicate, partial, or unlisted');
  for (const item of input.manifest.items) {
    const files = input.packageFiles.filter(({ path }) => path === item.path);
    if (files.length !== 1 || sha256(files[0].bytes) !== item.sha256)
      reasons.push(`package file hash mismatch: ${item.path}`);
  }
  if (hashCanonical({ nodes: input.packageNodes, files: input.packageFiles }) !== input.packageHash)
    reasons.push('package hash mismatch');
  if (
    hashCanonical({ targetEvidence: input.targetEvidence, mappings: input.mappings ?? [] }) !==
    input.evidenceHash
  ) {
    reasons.push('evidence hash mismatch');
  }
  if (input.metadata.sourceHash !== input.sourceHash) reasons.push('source hash mismatch');
  if (
    input.metadata.requestHash !== input.requestHash ||
    hashCanonical(input.request) !== input.requestHash
  )
    reasons.push('request hash mismatch');
  if (hashCanonical(input.source) !== input.sourceHash)
    reasons.push('source payload hash mismatch');
  if (
    input.registryContract !== METADATA_CAPABILITY_CONTRACT ||
    input.registryVersion !== METADATA_CAPABILITY_VERSION ||
    input.registryFixtureSha256 !== METADATA_CAPABILITY_FIXTURE_SHA256
  ) {
    reasons.push('capability registry binding mismatch');
  }

  const provider = semver(input.providerVersion);
  const now = Date.parse(input.now);
  if (
    provider === undefined ||
    Number.isNaN(now) ||
    input.apiVersion !== '67.0' ||
    !Number.isSafeInteger(input.maxEvidenceAgeMs) ||
    input.maxEvidenceAgeMs < 0 ||
    input.targetWorkspaceApiName.length === 0
  ) {
    reasons.push('provider, API, or clock version is invalid');
  }

  const packageIndex = indexEvidence(input.packageNodes);
  const targetIndex = indexEvidence(input.targetEvidence);
  const mappingIndex = indexEvidence(input.mappings ?? []);
  for (const [label, values] of [
    ['package', input.packageNodes],
    ['target', input.targetEvidence],
    ['mapping', input.mappings ?? []],
  ] as const) {
    for (const value of values) validateEvidence(value, input, label, reasons);
    const grouped = indexEvidence(values);
    for (const matches of grouped.values()) {
      if (matches.length !== 1) reasons.push(`${label}: duplicate or conflicting exact identity`);
    }
  }
  const rootKeys = new Set(input.metadata.roots.map(({ identity }) => key(identity)));
  if (rootKeys.size === 0 || rootKeys.size !== input.metadata.roots.length) {
    reasons.push('portable roots are missing or duplicate');
  }
  for (const node of input.packageNodes) {
    const matchingRoot = input.metadata.roots.find(
      ({ identity }) => key(identity) === key(node.portableIdentity),
    );
    if (
      matchingRoot !== undefined &&
      hashCanonical(matchingRoot.dependencies) !== hashCanonical(node.dependencies)
    ) {
      reasons.push('package root descriptors conflict with sidecar');
    }
    for (const edge of node.dependencies) {
      if (key(edge.source) !== key(node.portableIdentity))
        reasons.push('dependency source binding mismatch');
      validateDescriptor(edge, input, reasons);
    }
  }
  for (const root of input.metadata.roots) {
    validateDescriptor(
      {
        kind: 'root',
        source: root.identity,
        target: root.identity,
        required: true,
        resolution: 'package',
      },
      input,
      reasons,
    );
    const declaration = CMS_CAPABILITY_DECLARATIONS.find(
      ({ identity }) =>
        identity.family === root.identity.family && identity.type === root.identity.type,
    );
    if (declaration !== undefined) {
      const usage = input.usageByType[root.identity.type];
      try {
        if (usage === undefined) throw new TypeError('Missing usage');
        assertStrategyUsage(declaration.preflight, usage);
      } catch {
        reasons.push(`preflight strategy or bounds mismatch: ${root.identity.type}`);
      }
      if (
        provider !== undefined &&
        (compare(provider, semver(declaration.providerContract.minVersion)!) < 0 ||
          compare(provider, semver(declaration.providerContract.maxVersion)!) > 0)
      ) {
        reasons.push(`provider version is incompatible with ${root.identity.type}`);
      }
    }
  }
  const packageNodeKeys = new Set(
    input.packageNodes.map(({ portableIdentity }) => key(portableIdentity)),
  );
  for (const rootKey of rootKeys) {
    if (!packageNodeKeys.has(rootKey)) reasons.push('selected package is missing a portable root');
  }

  validateRequiredPackageCycles(input.metadata.roots, packageIndex, reasons);
  const pending = input.metadata.roots.flatMap(({ dependencies }) => dependencies);
  const visited = new Set<string>();
  while (pending.length > 0) {
    const descriptor = pending.shift() as DependencyDescriptor;
    validateDescriptor(descriptor, input, reasons);
    const descriptorKey = hashCanonical(descriptor);
    if (visited.has(descriptorKey)) continue;
    visited.add(descriptorKey);

    const declaration = CMS_CAPABILITY_DECLARATIONS.find(
      ({ identity }) =>
        identity.provider === 'sf-plugin-cms' &&
        identity.family === descriptor.target.family &&
        identity.type === descriptor.target.type,
    );
    if (declaration !== undefined) {
      const minimum = semver(declaration.providerContract.minVersion)!;
      const maximum = semver(declaration.providerContract.maxVersion)!;
      if (
        provider !== undefined &&
        (compare(provider, minimum) < 0 || compare(provider, maximum) > 0)
      ) {
        reasons.push(`provider version is incompatible with ${descriptor.target.type}`);
      }
      const usage = input.usageByType[descriptor.target.type];
      if (usage === undefined) {
        reasons.push(`preflight strategy usage is missing: ${descriptor.target.type}`);
      } else {
        try {
          assertStrategyUsage(declaration.preflight, usage);
        } catch {
          reasons.push(`preflight strategy or bounds mismatch: ${descriptor.target.type}`);
        }
      }
    }

    let selected: CmsDeployTargetEvidence | undefined;
    let provenance: CmsDeployResolution['provenance'] | undefined;
    const packageMatches = packageIndex.get(key(descriptor.target)) ?? [];
    if (packageMatches.length === 1) {
      selected = packageMatches[0];
      provenance = 'package';
    } else if (packageMatches.length > 1) {
      reasons.push(`ambiguous package dependency: ${descriptor.target.apiName}`);
    } else if (descriptor.resolution === 'package') {
      reasons.push(`missing package dependency: ${descriptor.target.apiName}`);
    } else {
      const mappingMatches = mappingIndex.get(key(descriptor.target)) ?? [];
      if (mappingMatches.length === 1) {
        selected = mappingMatches[0];
        provenance = 'mapping';
      } else if (mappingMatches.length > 1) {
        reasons.push(`ambiguous explicit mapping: ${descriptor.target.apiName}`);
      } else {
        const targetMatches = targetIndex.get(key(descriptor.target)) ?? [];
        if (targetMatches.length === 1) {
          selected = targetMatches[0];
          provenance = 'target';
        } else {
          reasons.push(
            `${targetMatches.length === 0 ? 'missing' : 'ambiguous'} target dependency: ${descriptor.target.apiName}`,
          );
        }
      }
    }

    if (selected !== undefined && provenance !== undefined) {
      validateEvidenceAge(selected, input, provenance, reasons);
      if (provenance === 'package' && !rootKeys.has(key(descriptor.target))) {
        reasons.push(`unsupported non-root package dependency: ${descriptor.target.apiName}`);
      }
      resolutions.push({
        portableIdentity: descriptor.target,
        targetEvidence: selected.targetEvidence,
        provenance,
        evidenceHash: hashCanonical(selected.targetEvidence),
      });
      const node = exactOne(packageIndex, descriptor.target) as CmsDeployPackageNode | undefined;
      if (node !== undefined) {
        for (const transitive of node.dependencies) pending.push(transitive);
      }
    }
  }

  for (const root of input.metadata.roots) {
    const node = exactOne(packageIndex, root.identity);
    if (node !== undefined) {
      validateEvidenceAge(node, input, 'package', reasons);
      operations.push({
        action: 'upsert',
        portableIdentity: root.identity,
        target: node.targetEvidence.content,
      });
    }
  }

  const blockedReasons = uniqueReasons(reasons);
  const stable = {
    contract: CMS_DEPLOY_PREFLIGHT_CONTRACT,
    version: CMS_DEPLOY_PREFLIGHT_VERSION,
    ready: blockedReasons.length === 0,
    hashes: {
      package: input.packageHash,
      manifest: input.manifestSha256,
      evidence: input.evidenceHash,
      source: input.sourceHash,
      request: input.requestHash,
    },
    resolutions: resolutions.toSorted((left, right) =>
      key(left.portableIdentity).localeCompare(key(right.portableIdentity)),
    ),
    operations:
      blockedReasons.length === 0
        ? operations.toSorted((left, right) =>
            key(left.portableIdentity).localeCompare(key(right.portableIdentity)),
          )
        : [],
    blockedReasons,
  };
  return { ...stable, planHash: hashCanonical(stable) };
}
