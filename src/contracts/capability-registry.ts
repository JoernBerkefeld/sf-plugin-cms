import { createHash } from 'node:crypto';
import { getPluginVersion } from '../runtime-version.js';

export const METADATA_CAPABILITY_CONTRACT = 'sf-metadata-capability-v1' as const;
export const METADATA_CAPABILITY_VERSION = '1.0.0' as const;
export const METADATA_CAPABILITY_FIXTURE_SHA256 =
  '557e9007ddaeea4c58807d9fc246fc62be646148591123d4398d5d00fa7f6f1b' as const;

export type JsonScalar = boolean | number | string | null;
export type JsonValue = JsonScalar | JsonValue[] | { [key: string]: JsonValue };

export type PortableIdentity = {
  family: string;
  type: string;
  apiName: string;
  namespace?: string;
  context?: Record<string, JsonValue>;
};

export type ServerIdentity = {
  kind: 'salesforce-id' | 'metadata-full-name' | 'developer-name' | 'content-key' | 'exact-scope';
  value: string;
  scope?: Record<string, JsonValue>;
};

export type DependencyDescriptor = {
  kind: string;
  source: PortableIdentity;
  target: PortableIdentity;
  required: boolean;
  resolution: 'package' | 'target' | 'either';
  originPath?: string;
  evidence?: { serverIdentity: ServerIdentity };
};

export type RetrievalStrategy = 'targeted' | 'batched' | 'filtered' | 'retrieve-all';

export type StrategyDeclaration = {
  strategy: RetrievalStrategy;
  completionProof: string;
  hardBounds: {
    maxCalls: number;
    maxItems: number;
    maxPages: number;
  };
};

export type CapabilityDeclaration = {
  identity: {
    provider: string;
    family: string;
    type: string;
    profile: string;
  };
  providerContract: {
    name: string;
    minVersion: string;
    maxVersion: string;
  };
  nativeScope: {
    kind: string;
    root: string;
  };
  retrieval: StrategyDeclaration;
  preflight: StrategyDeclaration;
  operations: Array<'retrieve' | 'resolve'>;
  dependencyExtractorVersion: string;
};

export type CapabilityRegistryFixture = {
  contract: typeof METADATA_CAPABILITY_CONTRACT;
  version: typeof METADATA_CAPABILITY_VERSION;
  declarations: CapabilityDeclaration[];
};

export type PortableLeakScanOptions = {
  allowedStructuralIdPaths?: string[];
};

// Retained internal family-engine evidence, not the public retrieve/deploy inventory.
// Offline info exposes these only under its explicit internal-engine-only scope.
export const CMS_CAPABILITY_DECLARATIONS: CapabilityDeclaration[] = [
  cmsDeclaration(
    'Brand',
    'dependency-free',
    'brand',
    'cms-brand-dependencies@1',
    'exact workspace and API-name match',
    4,
    1,
    'complete bounded family inventory',
    20,
    500,
    'targeted',
    'filtered',
  ),
  cmsDeclaration(
    'Consent Banner',
    'dependency-free',
    'consent-banner',
    'cms-consent-banner-dependencies@1',
    'exact workspace and API-name match',
    4,
    1,
    'complete bounded family inventory',
    20,
    500,
    'targeted',
    'filtered',
  ),
  cmsDeclaration(
    'Email',
    'dependency-free',
    'email',
    'cms-email-dependencies@1',
    'exact workspace, API-name, and language match',
    5,
    1,
    'complete bounded family inventory',
    20,
    500,
    'targeted',
    'filtered',
  ),
  cmsDeclaration(
    'Email Fragment',
    'dependency-free',
    'email-fragment',
    'cms-email-fragment-dependencies@1',
    'exact workspace, API-name, and language match',
    5,
    1,
    'complete bounded family inventory',
    20,
    500,
    'targeted',
    'filtered',
  ),
  cmsDeclaration(
    'Email Template',
    'dependency-free',
    'email-template',
    'cms-email-template-dependencies@1',
    'exact workspace, API-name, and language match',
    5,
    1,
    'complete bounded family inventory',
    20,
    500,
    'targeted',
    'filtered',
  ),
  cmsDeclaration(
    'Form Handler',
    'strict-empty-root',
    'form-handler',
    'cms-form-handler-dependencies@1',
    'exact workspace, API-name, and language match',
    5,
    1,
    'complete bounded family inventory',
    20,
    500,
    'targeted',
    'filtered',
  ),
  cmsDeclaration(
    'Landing Page',
    'strict-paired-template',
    'landing-page',
    'cms-landing-page-dependencies@1',
    'exact page and paired-template resolution',
    12,
    4,
    'complete bounded page and dependency inventory',
    30,
    500,
    'batched',
    'filtered',
    2,
  ),
  cmsDeclaration(
    'Landing Page Template',
    'strict-image-data-graph',
    'landing-page-template',
    'cms-landing-page-template-dependencies@1',
    'exact template, image, and Data Graph resolution',
    16,
    20,
    'complete bounded template and dependency inventory',
    30,
    500,
    'batched',
    'filtered',
    2,
  ),
  cmsDeclaration(
    'Preference Page',
    'strict-channel-subchannel-optional-brand',
    'preference-page',
    'cms-preference-page-dependencies@1',
    'exact channel, subchannel, and optional Brand resolution',
    12,
    10,
    'complete bounded preference-page inventory',
    30,
    500,
    'batched',
    'filtered',
    2,
  ),
  cmsDeclaration(
    'Web Fragment',
    'strict-data-graph',
    'web-fragment',
    'cms-web-fragment-dependencies@1',
    'exact fragment and Data Graph resolution',
    10,
    10,
    'complete bounded fragment inventory',
    30,
    500,
    'batched',
    'filtered',
    2,
  ),
];

const salesforceIdPattern = /^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/;
const prohibitedPortableKeyPattern =
  /(?:org|workspace|content|variant|ruleset|deployment|source|target).*id$/i;
const locatorKeyPattern =
  /(?:serverIdentity|serverId|recordId|contentKey|fullName|developerName|url)$/i;

export class MetadataCapabilityContractError extends Error {}

// Validate a complete capability registry fixture.
export function assertCapabilityRegistryFixture(
  value: unknown,
): asserts value is CapabilityRegistryFixture {
  const record = strictRecord(value, ['contract', 'version', 'declarations'], 'fixture');
  exact(record.contract, METADATA_CAPABILITY_CONTRACT, 'contract');
  exact(record.version, METADATA_CAPABILITY_VERSION, 'version');
  const declarations = array(record.declarations, 'declarations');
  if (declarations.length === 0) throw contractError('declarations must not be empty');
  for (const declaration of declarations) assertCapabilityDeclaration(declaration);
  const profiles = declarations.map((declaration) => {
    const typed = declaration as CapabilityDeclaration;
    return `${typed.identity.provider}\0${typed.identity.family}\0${typed.identity.type}\0${typed.identity.profile}`;
  });
  if (new Set(profiles).size !== profiles.length)
    throw contractError('declaration profiles must be unique');
  requireCanonicalOrder(profiles, 'declarations');
}

// Validate one strict capability declaration.
export function assertCapabilityDeclaration(
  value: unknown,
): asserts value is CapabilityDeclaration {
  const record = strictRecord(
    value,
    [
      'identity',
      'providerContract',
      'nativeScope',
      'retrieval',
      'preflight',
      'operations',
      'dependencyExtractorVersion',
    ],
    'declaration',
  );
  const identity = strictRecord(
    record.identity,
    ['provider', 'family', 'type', 'profile'],
    'declaration identity',
  );
  for (const key of ['provider', 'family', 'type', 'profile'] as const)
    nonempty(identity[key], `identity.${key}`);
  const provider = strictRecord(
    record.providerContract,
    ['name', 'minVersion', 'maxVersion'],
    'provider contract',
  );
  nonempty(provider.name, 'provider contract name');
  semanticVersion(provider.minVersion, 'provider minimum version');
  semanticVersion(provider.maxVersion, 'provider maximum version');
  const scope = strictRecord(record.nativeScope, ['kind', 'root'], 'native scope');
  nonempty(scope.kind, 'native scope kind');
  nonempty(scope.root, 'native scope root');
  assertStrategyDeclaration(record.retrieval, 'retrieval');
  assertStrategyDeclaration(record.preflight, 'preflight');
  const operations = array(record.operations, 'operations');
  if (operations.length === 0) throw contractError('operations must not be empty');
  for (const operation of operations)
    oneOf(operation, ['retrieve', 'resolve'] as const, 'operation');
  nonempty(record.dependencyExtractorVersion, 'dependency extractor version');
}

// Validate a portable identity and reject server locator leakage.
export function assertPortableIdentity(value: unknown): asserts value is PortableIdentity {
  const record = strictRecord(
    value,
    ['family', 'type', 'apiName', 'namespace', 'context'],
    'portable identity',
    true,
    ['family', 'type', 'apiName'],
  );
  nonempty(record.family, 'portable family');
  nonempty(record.type, 'portable type');
  nonempty(record.apiName, 'portable apiName');
  if (record.namespace !== undefined) nonempty(record.namespace, 'portable namespace');
  if (record.context !== undefined && !isRecord(record.context))
    throw contractError('portable context must be an object');
  assertPortablePayload(record);
}

// Validate a dependency descriptor and its evidence path.
export function assertDependencyDescriptor(value: unknown): asserts value is DependencyDescriptor {
  const record = strictRecord(
    value,
    ['kind', 'source', 'target', 'required', 'resolution', 'originPath', 'evidence'],
    'dependency descriptor',
    true,
    ['kind', 'source', 'target', 'required', 'resolution'],
  );
  nonempty(record.kind, 'dependency kind');
  assertPortableIdentity(record.source);
  assertPortableIdentity(record.target);
  if (typeof record.required !== 'boolean')
    throw contractError('dependency required must be boolean');
  oneOf(record.resolution, ['package', 'target', 'either'] as const, 'dependency resolution');
  if (record.originPath !== undefined) nonempty(record.originPath, 'dependency originPath');
  if (record.evidence !== undefined) {
    const evidence = strictRecord(record.evidence, ['serverIdentity'], 'dependency evidence');
    assertServerIdentity(evidence.serverIdentity);
  }
}

// Reject locator keys and Salesforce IDs from portable payloads.
export function assertPortablePayload(value: unknown, options: PortableLeakScanOptions = {}): void {
  const allowed = new Set(options.allowedStructuralIdPaths);
  scanPortable(value, '$', allowed);
}

// Serialize registry data with canonical ordering and one LF.
export function serializeCapabilityRegistryFixture(value: unknown): string {
  assertCapabilityRegistryFixture(value);
  return `${JSON.stringify(sortJson(value), undefined, 2)}\n`;
}

// Return the SHA-256 of canonical registry bytes.
export function hashCapabilityRegistryFixture(value: unknown): string {
  return createHash('sha256')
    .update(serializeCapabilityRegistryFixture(value), 'utf8')
    .digest('hex');
}

function cmsDeclaration(
  type: string,
  profile: string,
  root: string,
  dependencyExtractorVersion: string,
  preflightProof: string,
  preflightCalls: number,
  preflightItems: number,
  retrievalProof: string,
  retrievalCalls: number,
  retrievalItems: number,
  preflightStrategy: RetrievalStrategy,
  retrievalStrategy: RetrievalStrategy,
  preflightPages = 1,
): CapabilityDeclaration {
  return {
    dependencyExtractorVersion,
    identity: { provider: 'sf-plugin-cms', family: 'cms', type, profile },
    nativeScope: { kind: 'marketing-workspace', root },
    operations: ['retrieve'],
    preflight: {
      completionProof: preflightProof,
      hardBounds: { maxCalls: preflightCalls, maxItems: preflightItems, maxPages: preflightPages },
      strategy: preflightStrategy,
    },
    providerContract: {
      // Package compatibility is independent of the metadata contract major.
      maxVersion: getPluginVersion(),
      minVersion: '0.10.0',
      name: 'sf-plugin-cms',
    },
    retrieval: {
      completionProof: retrievalProof,
      hardBounds: { maxCalls: retrievalCalls, maxItems: retrievalItems, maxPages: 10 },
      strategy: retrievalStrategy,
    },
  };
}

export function assertServerIdentity(value: unknown): asserts value is ServerIdentity {
  const record = strictRecord(value, ['kind', 'value', 'scope'], 'server identity', true, [
    'kind',
    'value',
  ]);
  oneOf(
    record.kind,
    [
      'salesforce-id',
      'metadata-full-name',
      'developer-name',
      'content-key',
      'exact-scope',
    ] as const,
    'server identity kind',
  );
  nonempty(record.value, 'server identity value');
  if (record.scope !== undefined && !isRecord(record.scope))
    throw contractError('server identity scope must be an object');
}

function assertStrategyDeclaration(value: unknown, label: string): void {
  const record = strictRecord(value, ['strategy', 'completionProof', 'hardBounds'], label);
  oneOf(
    record.strategy,
    ['targeted', 'batched', 'filtered', 'retrieve-all'] as const,
    `${label} strategy`,
  );
  nonempty(record.completionProof, `${label} completion proof`);
  const bounds = strictRecord(
    record.hardBounds,
    ['maxCalls', 'maxItems', 'maxPages'],
    `${label} hard bounds`,
  );
  for (const key of ['maxCalls', 'maxItems', 'maxPages'] as const)
    positiveInteger(bounds[key], `${label}.${key}`);
}

function scanPortable(value: unknown, path: string, allowedStructuralIdPaths: Set<string>): void {
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries())
      scanPortable(item, `${path}[${index}]`, allowedStructuralIdPaths);
    return;
  }
  if (!isRecord(value)) {
    if (
      typeof value === 'string' &&
      salesforceIdPattern.test(value) &&
      !allowedStructuralIdPaths.has(path)
    ) {
      throw contractError(`portable Salesforce ID leak at ${path}`);
    }
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    const childPath = `${path}.${key}`;
    if (
      (prohibitedPortableKeyPattern.test(key) || locatorKeyPattern.test(key)) &&
      !allowedStructuralIdPaths.has(childPath)
    ) {
      throw contractError(`portable locator key leak at ${childPath}`);
    }
    scanPortable(item, childPath, allowedStructuralIdPaths);
  }
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
  label: string,
  optional = false,
  requiredKeys = keys,
): Record<string, unknown> {
  if (!isRecord(value)) throw contractError(`${label} must be an object`);
  const actual = Object.keys(value).toSorted();
  const allowed = [...keys].toSorted();
  if (
    actual.some((key) => !allowed.includes(key)) ||
    requiredKeys.some((key) => !actual.includes(key))
  ) {
    throw contractError(`${label} fields are invalid`);
  }
  if (!optional && actual.length !== allowed.length)
    throw contractError(`${label} fields are invalid`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw contractError(`${label} must be an array`);
  return value;
}

function nonempty(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0)
    throw contractError(`${label} must not be empty`);
  return value;
}

function semanticVersion(value: unknown, label: string): string {
  const result = nonempty(value, label);
  if (!/^\d+\.\d+\.\d+$/.test(result)) throw contractError(`${label} must be semantic version`);
  return result;
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0)
    throw contractError(`${label} must be a positive integer`);
  return value as number;
}

function exact(value: unknown, expected: string, label: string): void {
  if (value !== expected) throw contractError(`${label} must be ${expected}`);
}

function oneOf<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
  label: string,
): T[number] {
  if (typeof value !== 'string' || !allowed.includes(value))
    throw contractError(`${label} is invalid`);
  return value as T[number];
}

function requireCanonicalOrder(values: string[], label: string): void {
  const sorted = values.toSorted();
  if (values.some((value, index) => value !== sorted[index]))
    throw contractError(`${label} must be canonically ordered`);
}

function contractError(message: string): MetadataCapabilityContractError {
  return new MetadataCapabilityContractError(`Invalid metadata capability contract: ${message}`);
}
