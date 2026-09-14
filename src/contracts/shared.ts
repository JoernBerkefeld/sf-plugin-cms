import { redactSecrets } from '../transport/redact-secrets.js';

export const CMS_CONTRACT_MAJOR = 1 as const;
export const CMS_CONTRACT_VERSION = '1.0.0' as const;
export const CMS_PLUGIN_NAME = 'sf-plugin-cms' as const;
export const CMS_STATUSES = ['success', 'partial', 'failed', 'blocked'] as const;
export const CMS_OPERATIONS = ['cms.info', 'workspace.export.bulk', 'workspace.import'] as const;
export const CMS_REFERENCE_RESOLUTIONS = [
  'included',
  'unresolved',
  'unsupported',
  'external',
] as const;
export const MAX_DIAGNOSTICS_PER_KIND = 100;
export const MAX_DIAGNOSTIC_MESSAGE_LENGTH = 1024;

export type CmsStatus = (typeof CMS_STATUSES)[number];
export type CmsOperation = (typeof CMS_OPERATIONS)[number];
export type CmsReferenceResolution = (typeof CMS_REFERENCE_RESOLUTIONS)[number];

export type CmsDiagnostic = {
  code: string;
  message: string;
  scope?: string;
  reference?: string;
  retryable?: boolean;
};

export type CmsWarning = CmsDiagnostic;
export type CmsError = CmsDiagnostic;

export type CmsDiagnostics = {
  warnings: CmsWarning[];
  errors: CmsError[];
};

export type OpaqueCmsReference = {
  referenceId: string;
  owner: 'cms';
  kind: string;
  source: {
    workspaceId: string;
    sourceId: string;
  };
  portableKey: {
    scheme: 'cms-opaque-v1';
    value: string;
  };
  required: boolean;
  resolution: CmsReferenceResolution;
};

export type CmsMetadata = {
  operation: CmsOperation;
  plugin: {
    name: typeof CMS_PLUGIN_NAME;
    version: string;
  };
  apiVersion: string | null;
};

export type CmsProvenance = {
  producer: typeof CMS_PLUGIN_NAME;
  sourceOrgId: string;
  pluginVersion: string;
  exportSetId?: string;
  command: string;
  generatedAt: string;
};

export type CmsEnvelope<T> = {
  contract: string;
  contractVersion: typeof CMS_CONTRACT_VERSION;
  status: CmsStatus;
  metadata: CmsMetadata;
  diagnostics: CmsDiagnostics;
  provenance: CmsProvenance;
  result: T | null;
};

export type CmsEnvelopeFinalizer = {
  emit: (envelope: CmsEnvelope<unknown>) => void;
  setExitCode?: (exitCode: 0 | 1 | 2) => void;
};

export function assertSupportedMajor(
  version: unknown,
  label = 'contractVersion',
): asserts version is 1 {
  if (version !== CMS_CONTRACT_MAJOR) throw new TypeError(`${label} must be supported major 1`);
}

export function assertExactKeys(
  value: unknown,
  keys: readonly string[],
  label: string,
): asserts value is Record<string, unknown> {
  if (!isRecord(value)) throw new TypeError(`${label} must be an object`);
  const actual = Object.keys(value).toSorted();
  const expected = [...keys].toSorted();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new TypeError(`${label} must contain exactly: ${expected.join(', ')}`);
  }
}

export function assertNonemptyString(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${label} must be a nonempty string`);
  }
}

export function assertIdentifier(value: unknown, label: string): asserts value is string {
  assertNonemptyString(value, label);
  if (
    value.includes('/') ||
    value.includes('\\') ||
    [...value].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 31 || codePoint === 127;
    })
  ) {
    throw new TypeError(`${label} is invalid`);
  }
}

export function assertReferenceId(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !/^ref:[a-f\d]{64}$/u.test(value)) {
    throw new TypeError(`${label} must be a canonical reference ID`);
  }
}

export function assertSha256(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !/^[a-f\d]{64}$/u.test(value)) {
    throw new TypeError(`${label} must be a lowercase SHA-256`);
  }
}

export function assertRelativePosixPath(value: unknown, label: string): asserts value is string {
  assertNonemptyString(value, label);
  if (value.includes('\\') || value.startsWith('/') || /^[A-Za-z]:/u.test(value)) {
    throw new TypeError(`${label} must be a relative POSIX path`);
  }
  const portable = value.startsWith('./') ? value.slice(2) : value;
  if (
    portable.length === 0 ||
    portable.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    throw new TypeError(`${label} must not contain empty or traversal segments`);
  }
}

export function sanitizeDiagnostics(
  diagnostics: readonly CmsDiagnostic[],
  label: string,
): CmsDiagnostic[] {
  if (diagnostics.length > MAX_DIAGNOSTICS_PER_KIND) {
    throw new TypeError(`${label} exceeds ${MAX_DIAGNOSTICS_PER_KIND} entries`);
  }
  return diagnostics.map((diagnostic, index) => {
    assertDiagnostic(diagnostic, `${label}[${index}]`);
    const message = redactSecrets(diagnostic.message);
    if (message.length > MAX_DIAGNOSTIC_MESSAGE_LENGTH) {
      throw new TypeError(
        `${label}[${index}].message exceeds ${MAX_DIAGNOSTIC_MESSAGE_LENGTH} characters`,
      );
    }
    return { ...diagnostic, message };
  });
}

export function assertDiagnostics(
  value: unknown,
  label = 'diagnostics',
): asserts value is CmsDiagnostics {
  assertExactKeys(value, ['warnings', 'errors'], label);
  if (!Array.isArray(value.warnings) || !Array.isArray(value.errors)) {
    throw new TypeError(`${label} arrays are required`);
  }
  sanitizeDiagnostics(value.warnings as CmsDiagnostic[], `${label}.warnings`);
  sanitizeDiagnostics(value.errors as CmsDiagnostic[], `${label}.errors`);
  for (const [kind, entries] of [
    ['warnings', value.warnings],
    ['errors', value.errors],
  ] as const) {
    for (const [index, diagnostic] of entries.entries()) {
      if (redactSecrets(diagnostic.message) !== diagnostic.message) {
        throw new TypeError(`${label}.${kind}[${index}].message must already be redacted`);
      }
    }
  }
}

export function assertOpaqueCmsReference(
  value: unknown,
  label = 'reference',
): asserts value is OpaqueCmsReference {
  assertExactKeys(
    value,
    ['referenceId', 'owner', 'kind', 'source', 'portableKey', 'required', 'resolution'],
    label,
  );
  assertReferenceId(value.referenceId, `${label}.referenceId`);
  if (value.owner !== 'cms') throw new TypeError(`${label}.owner must be cms`);
  assertIdentifier(value.kind, `${label}.kind`);
  assertExactKeys(value.source, ['workspaceId', 'sourceId'], `${label}.source`);
  assertIdentifier(value.source.workspaceId, `${label}.source.workspaceId`);
  assertIdentifier(value.source.sourceId, `${label}.source.sourceId`);
  assertExactKeys(value.portableKey, ['scheme', 'value'], `${label}.portableKey`);
  if (value.portableKey.scheme !== 'cms-opaque-v1') {
    throw new TypeError(`${label}.portableKey.scheme is unsupported`);
  }
  assertNonemptyString(value.portableKey.value, `${label}.portableKey.value`);
  if (typeof value.required !== 'boolean') throw new TypeError(`${label}.required must be boolean`);
  if (!CMS_REFERENCE_RESOLUTIONS.includes(value.resolution as CmsReferenceResolution)) {
    throw new TypeError(`${label}.resolution is unsupported`);
  }
}

export function assertCmsEnvelope<T>(
  value: unknown,
  resultValidator: (
    result: unknown,
    provenance?: CmsProvenance,
    status?: CmsStatus,
  ) => asserts result is T,
): asserts value is CmsEnvelope<T> {
  assertExactKeys(
    value,
    ['contract', 'contractVersion', 'status', 'metadata', 'diagnostics', 'provenance', 'result'],
    'envelope',
  );
  assertNonemptyString(value.contract, 'envelope.contract');
  if (value.contractVersion !== CMS_CONTRACT_VERSION) {
    throw new TypeError('envelope.contractVersion must be 1.0.0');
  }
  if (!CMS_STATUSES.includes(value.status as CmsStatus))
    throw new TypeError('envelope.status is invalid');
  assertMetadata(value.metadata);
  const expectedContract = new Map<CmsOperation, string>([
    ['cms.info', 'sf-cms-info'],
    ['workspace.export.bulk', 'sf-cms-workspace-export-set'],
    ['workspace.import', 'sf-cms-workspace-import'],
  ]);
  if (value.contract !== expectedContract.get(value.metadata.operation)) {
    throw new TypeError('envelope.contract does not match metadata.operation');
  }
  assertDiagnostics(value.diagnostics);
  assertProvenance(value.provenance);
  if (value.provenance.pluginVersion !== value.metadata.plugin.version) {
    throw new TypeError('envelope provenance pluginVersion must match metadata.plugin.version');
  }
  if (value.result === null) {
    if (value.status !== 'failed' && value.status !== 'blocked') {
      throw new TypeError('envelope.result may be null only for failed or blocked status');
    }
  } else {
    resultValidator(value.result, value.provenance, value.status as CmsStatus);
  }
}

export function serializeCmsEnvelope<T>(
  envelope: CmsEnvelope<T>,
  resultValidator: (result: unknown, provenance?: CmsProvenance) => asserts result is T,
): string {
  assertCmsEnvelope(envelope, resultValidator);
  return `${JSON.stringify(envelope, null, 2)}\n`;
}

export function finalizeCmsEnvelope<T>(
  envelope: CmsEnvelope<T>,
  resultValidator: (result: unknown, provenance?: CmsProvenance) => asserts result is T,
  finalizer: CmsEnvelopeFinalizer,
): CmsEnvelope<T> {
  assertCmsEnvelope(envelope, resultValidator);
  finalizer.emit(envelope as CmsEnvelope<unknown>);
  finalizer.setExitCode?.(exitCodeForStatus(envelope.status));
  return envelope;
}

function exitCodeForStatus(status: CmsStatus): 0 | 1 | 2 {
  if (status === 'success') return 0;
  if (status === 'partial') return 2;
  return 1;
}

function assertDiagnostic(value: unknown, label: string): asserts value is CmsDiagnostic {
  if (!isRecord(value)) throw new TypeError(`${label} must be an object`);
  const allowed = new Set(['code', 'message', 'scope', 'reference', 'retryable']);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new TypeError(`${label} contains an unknown key`);
  }
  assertNonemptyString(value.code, `${label}.code`);
  assertNonemptyString(value.message, `${label}.message`);
  for (const key of ['scope', 'reference'] as const) {
    if (value[key] !== undefined) assertNonemptyString(value[key], `${label}.${key}`);
  }
  if (value.retryable !== undefined && typeof value.retryable !== 'boolean') {
    throw new TypeError(`${label}.retryable must be boolean`);
  }
}

function assertMetadata(value: unknown): asserts value is CmsMetadata {
  assertExactKeys(value, ['operation', 'plugin', 'apiVersion'], 'envelope.metadata');
  if (!CMS_OPERATIONS.includes(value.operation as CmsOperation)) {
    throw new TypeError('envelope.metadata.operation is invalid');
  }
  assertExactKeys(value.plugin, ['name', 'version'], 'envelope.metadata.plugin');
  if (value.plugin.name !== CMS_PLUGIN_NAME)
    throw new TypeError('envelope.metadata.plugin.name is invalid');
  assertNonemptyString(value.plugin.version, 'envelope.metadata.plugin.version');
  if (value.apiVersion !== null)
    assertNonemptyString(value.apiVersion, 'envelope.metadata.apiVersion');
}

function assertProvenance(value: unknown): asserts value is CmsProvenance {
  if (!isRecord(value)) throw new TypeError('envelope.provenance must be an object');
  const required = ['producer', 'sourceOrgId', 'pluginVersion', 'command', 'generatedAt'];
  const allowed = new Set([...required, 'exportSetId']);
  if (
    required.some((key) => !(key in value)) ||
    Object.keys(value).some((key) => !allowed.has(key))
  ) {
    throw new TypeError('envelope.provenance has invalid keys');
  }
  if (value.producer !== CMS_PLUGIN_NAME)
    throw new TypeError('envelope.provenance.producer is invalid');
  assertIdentifier(value.sourceOrgId, 'envelope.provenance.sourceOrgId');
  assertNonemptyString(value.pluginVersion, 'envelope.provenance.pluginVersion');
  assertNonemptyString(value.command, 'envelope.provenance.command');
  assertNonemptyString(value.generatedAt, 'envelope.provenance.generatedAt');
  if (Number.isNaN(Date.parse(value.generatedAt)))
    throw new TypeError('envelope.provenance.generatedAt is invalid');
  if (
    value.exportSetId !== undefined &&
    !/^export-set:[a-f\d]{64}$/u.test(value.exportSetId as string)
  ) {
    throw new TypeError('envelope.provenance.exportSetId is invalid');
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
