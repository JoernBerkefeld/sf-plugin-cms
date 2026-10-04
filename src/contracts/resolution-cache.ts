import { createHash } from 'node:crypto';
import {
  assertPortableIdentity,
  assertServerIdentity,
  CMS_CAPABILITY_DECLARATIONS,
  METADATA_CAPABILITY_CONTRACT,
  METADATA_CAPABILITY_FIXTURE_SHA256,
  type PortableIdentity,
  type ServerIdentity,
} from './capability-registry.js';

export const CMS_RESOLUTION_CACHE_CONTRACT = 'sf-cms-targeted-resolution-cache-v1' as const;
export const CMS_RESOLUTION_CACHE_VERSION = '1.0.0' as const;
export const CMS_RESOLUTION_CACHE_MAX_ENTRIES = 500;

export type CmsResolutionCacheScope = {
  sourceOrg: ServerIdentity;
  targetOrg: ServerIdentity;
  provider: string;
  apiVersion: string;
  capabilityContract: typeof METADATA_CAPABILITY_CONTRACT;
  capabilityFixtureSha256: typeof METADATA_CAPABILITY_FIXTURE_SHA256;
  declaration: {
    provider: string;
    family: string;
    type: string;
    profile: string;
  };
  nativeWorkspace: {
    kind: string;
    root: string;
    workspaceApiName: string;
  };
};

export type CmsResolutionCacheEntry = {
  portableIdentity: PortableIdentity;
  targetEvidence: {
    workspace: ServerIdentity;
    content: ServerIdentity;
    variant: ServerIdentity;
    contentKey: ServerIdentity;
    folder?: ServerIdentity;
  };
  portableHash: string;
  evidenceHash: string;
  mappingHash: string;
};

export type CmsResolutionCacheObservation = {
  mappingHash: string;
  sourceHash: string;
  observedAt: string;
};

export type CmsResolutionCacheFile = {
  contract: typeof CMS_RESOLUTION_CACHE_CONTRACT;
  version: typeof CMS_RESOLUTION_CACHE_VERSION;
  scope: CmsResolutionCacheScope;
  scopeHash: string;
  entries: CmsResolutionCacheEntry[];
  observations: CmsResolutionCacheObservation[];
};

export class CmsResolutionCacheContractError extends Error {}

export function hashCanonical(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

export function hashCmsResolutionCacheScope(scope: CmsResolutionCacheScope): string {
  assertCmsResolutionCacheScope(scope);
  return hashCanonical(scope);
}

export function createCmsResolutionCacheEntry(
  portableIdentity: PortableIdentity,
  targetEvidence: CmsResolutionCacheEntry['targetEvidence'],
): CmsResolutionCacheEntry {
  assertPortableIdentity(portableIdentity);
  assertTargetEvidence(targetEvidence, portableIdentity);
  const portableHash = hashCanonical(portableIdentity);
  const evidenceHash = hashCanonical(targetEvidence);
  return {
    portableIdentity,
    targetEvidence,
    portableHash,
    evidenceHash,
    mappingHash: hashCanonical({ portableHash, evidenceHash }),
  };
}

export function serializeCmsResolutionCache(value: CmsResolutionCacheFile): string {
  assertCmsResolutionCacheFile(value, value.scope);
  return `${JSON.stringify(sortJson(value), undefined, 2)}\n`;
}

export function assertCmsResolutionCacheFile(
  value: unknown,
  expectedScope: CmsResolutionCacheScope,
): asserts value is CmsResolutionCacheFile {
  const record = strictRecord(value, [
    'contract',
    'version',
    'scope',
    'scopeHash',
    'entries',
    'observations',
  ]);
  exact(record.contract, CMS_RESOLUTION_CACHE_CONTRACT, 'contract');
  exact(record.version, CMS_RESOLUTION_CACHE_VERSION, 'version');
  assertCmsResolutionCacheScope(record.scope);
  const scope = record.scope as CmsResolutionCacheScope;
  if (hashCanonical(scope) !== hashCanonical(expectedScope)) fail('scope does not match');
  exact(record.scopeHash, hashCmsResolutionCacheScope(scope), 'scopeHash');
  if (!Array.isArray(record.entries) || record.entries.length > CMS_RESOLUTION_CACHE_MAX_ENTRIES) {
    fail('entries exceed bounds');
  }
  if (!Array.isArray(record.observations) || record.observations.length !== record.entries.length) {
    fail('observations must match entries');
  }
  const portableHashes = new Set<string>();
  const evidenceHashes = new Set<string>();
  const mappingHashes = new Set<string>();
  for (const valueEntry of record.entries) {
    const entry = assertEntry(valueEntry);
    if (portableHashes.has(entry.portableHash) || evidenceHashes.has(entry.evidenceHash)) {
      fail('duplicate or conflicting mapping');
    }
    portableHashes.add(entry.portableHash);
    evidenceHashes.add(entry.evidenceHash);
    if (mappingHashes.has(entry.mappingHash)) fail('duplicate mapping');
    mappingHashes.add(entry.mappingHash);
  }
  const observationMappings = new Set<string>();
  for (const valueObservation of record.observations) {
    const observation = strictRecord(valueObservation, ['mappingHash', 'sourceHash', 'observedAt']);
    sha256(observation.mappingHash, 'observation mappingHash');
    sha256(observation.sourceHash, 'observation sourceHash');
    if (
      typeof observation.observedAt !== 'string' ||
      Number.isNaN(Date.parse(observation.observedAt))
    ) {
      fail('observedAt must be an ISO date');
    }
    const mappingHash = observation.mappingHash as string;
    if (!mappingHashes.has(mappingHash) || observationMappings.has(mappingHash)) {
      fail('observation mapping is invalid');
    }
    observationMappings.add(mappingHash);
  }
}

export function assertCmsResolutionCacheScope(
  value: unknown,
): asserts value is CmsResolutionCacheScope {
  const record = strictRecord(value, [
    'sourceOrg',
    'targetOrg',
    'provider',
    'apiVersion',
    'capabilityContract',
    'capabilityFixtureSha256',
    'declaration',
    'nativeWorkspace',
  ]);
  assertServerIdentity(record.sourceOrg);
  assertServerIdentity(record.targetOrg);
  nonempty(record.provider, 'provider');
  nonempty(record.apiVersion, 'apiVersion');
  exact(record.capabilityContract, METADATA_CAPABILITY_CONTRACT, 'capabilityContract');
  exact(
    record.capabilityFixtureSha256,
    METADATA_CAPABILITY_FIXTURE_SHA256,
    'capabilityFixtureSha256',
  );
  const declaration = strictRecord(record.declaration, ['provider', 'family', 'type', 'profile']);
  for (const key of ['provider', 'family', 'type', 'profile'] as const) {
    nonempty(declaration[key], `declaration.${key}`);
  }
  const canonicalDeclaration = CMS_CAPABILITY_DECLARATIONS.find(
    ({ identity }) =>
      identity.provider === declaration.provider &&
      identity.family === declaration.family &&
      identity.type === declaration.type &&
      identity.profile === declaration.profile,
  );
  if (canonicalDeclaration === undefined) fail('declaration is not canonical');
  if (record.provider !== canonicalDeclaration.providerContract.name) {
    fail('provider does not match declaration');
  }
  const workspace = strictRecord(record.nativeWorkspace, ['kind', 'root', 'workspaceApiName']);
  for (const key of ['kind', 'root', 'workspaceApiName'] as const) {
    nonempty(workspace[key], `nativeWorkspace.${key}`);
  }
  if (
    workspace.kind !== canonicalDeclaration.nativeScope.kind ||
    workspace.root !== canonicalDeclaration.nativeScope.root
  ) {
    fail('native workspace does not match declaration');
  }
}

function assertEntry(value: unknown): CmsResolutionCacheEntry {
  const record = strictRecord(value, [
    'portableIdentity',
    'targetEvidence',
    'portableHash',
    'evidenceHash',
    'mappingHash',
  ]);
  assertPortableIdentity(record.portableIdentity);
  assertTargetEvidence(record.targetEvidence, record.portableIdentity);
  const expected = createCmsResolutionCacheEntry(
    record.portableIdentity,
    record.targetEvidence as CmsResolutionCacheEntry['targetEvidence'],
  );
  for (const key of ['portableHash', 'evidenceHash', 'mappingHash'] as const) {
    sha256(record[key], key);
    exact(record[key], expected[key], key);
  }
  return record as CmsResolutionCacheEntry;
}

function assertTargetEvidence(value: unknown, portableIdentity: PortableIdentity): void {
  const record = strictRecord(
    value,
    ['workspace', 'content', 'variant', 'contentKey', 'folder'],
    ['workspace', 'content', 'variant', 'contentKey'],
  );
  for (const key of ['workspace', 'content', 'variant', 'contentKey'] as const) {
    assertServerIdentity(record[key]);
  }
  if (record.folder !== undefined) assertServerIdentity(record.folder);
  const needsFolder = portableIdentity.context?.folderApiName !== undefined;
  if (needsFolder !== (record.folder !== undefined))
    fail('folder evidence does not match identity');
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => sortJson(item));
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .toSorted()
      .map((key) => [key, sortJson(value[key])]),
  );
}

function strictRecord(
  value: unknown,
  keys: string[],
  requiredKeys: string[] = keys,
): Record<string, unknown> {
  if (!isRecord(value)) fail('value must be an object');
  const actual = Object.keys(value);
  if (
    actual.some((key) => !keys.includes(key)) ||
    requiredKeys.some((key) => !actual.includes(key))
  ) {
    fail('unknown or missing fields');
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonempty(value: unknown, label: string): void {
  if (typeof value !== 'string' || value.length === 0) fail(`${label} must not be empty`);
}

function sha256(value: unknown, label: string): void {
  if (typeof value !== 'string' || !/^[a-f\d]{64}$/u.test(value)) fail(`${label} is invalid`);
}

function exact(value: unknown, expected: string, label: string): void {
  if (value !== expected) fail(`${label} must be ${expected}`);
}

function fail(message: string): never {
  throw new CmsResolutionCacheContractError(`Invalid CMS resolution cache: ${message}`);
}
