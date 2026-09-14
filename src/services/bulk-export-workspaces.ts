import { createHash } from 'node:crypto';
import type { Connection } from '@salesforce/core';
import { mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import {
  assertCmsEnvelope,
  MAX_DIAGNOSTICS_PER_KIND,
  sanitizeDiagnostics,
  type CmsDiagnostic,
  type CmsEnvelope,
  type CmsStatus,
} from '../contracts/shared.js';
import {
  assertWorkspaceExportSetResult,
  WORKSPACE_EXPORT_MANIFEST_CONTRACT,
  WORKSPACE_EXPORT_SET_CONTRACT,
  type ExternalReferenceCorrelation,
  type WorkspaceExportSetEntry,
  type WorkspaceExportSetResult,
} from '../contracts/workspace-export.js';
import type { JsonRequestOptions } from '../transport/json-request.js';
import { redactSecrets } from '../transport/redact-secrets.js';
import { exportWorkspace, safeWorkspaceDirectoryName } from './export-workspace.js';
import { getWorkspace, type CmsRecord } from './read.js';
import { enumerateWorkspaces } from './resolve-workspace.js';

export type CanonicalWorkspaceType = 'Content' | 'Marketing';

export type BulkWorkspaceExportOptions = JsonRequestOptions & {
  apiVersion?: string;
  generatedAt?: string;
  pluginVersion?: string;
  sourceOrgId?: string;
};

type RequestConnection = Pick<Connection, 'request'>;

type PreparedWorkspace = {
  id: string;
  name: string;
  type: CanonicalWorkspaceType;
  destination: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonemptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function folded(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('en-US');
}

function actualWorkspaceType(workspace: CmsRecord): CanonicalWorkspaceType {
  const spaceType = workspace.spaceType;
  if (typeof spaceType === 'string') return normalizeWorkspaceType(spaceType);
  if (isRecord(spaceType) && typeof spaceType.apiName === 'string') {
    return normalizeWorkspaceType(spaceType.apiName);
  }
  return normalizeWorkspaceType();
}

export function normalizeWorkspaceType(value?: unknown): CanonicalWorkspaceType {
  if (typeof value === 'string') {
    const normalized = value.toLocaleLowerCase('en-US');
    if (normalized === 'marketing') return 'Marketing';
    if (normalized === 'content') return 'Content';
  }
  throw new Error('Workspace type must be Marketing or Content.');
}

async function exists(candidate: string): Promise<boolean> {
  try {
    await stat(candidate);
    return true;
  } catch (error) {
    if (isRecord(error) && error.code === 'ENOENT') return false;
    throw error;
  }
}

async function assertParentCompatible(parent: string): Promise<void> {
  let cursor = path.resolve(parent);
  for (;;) {
    try {
      const information = await stat(cursor);
      if (!information.isDirectory()) {
        throw new Error(`Bulk output parent is not a directory: ${cursor}`);
      }
      return;
    } catch (error) {
      if (!isRecord(error) || error.code !== 'ENOENT') throw error;
    }
    const next = path.dirname(cursor);
    if (next === cursor) throw new Error(`Bulk output parent is not usable: ${parent}`);
    cursor = next;
  }
}

function normalizedError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return (
    redactSecrets(message)
      .replaceAll(/[\r\n]+/gu, ' ')
      .trim() || 'Workspace export failed.'
  );
}

function portableOutputPath(value: string): string {
  const portable = value.split(path.sep).join('/');
  if (/^[A-Za-z]:/u.test(portable) || portable.startsWith('/')) return path.basename(value);
  return portable.startsWith('./') ? portable : `./${portable}`;
}

function relativeArtifactPath(outputDirectory: string, destination: string): string {
  return path.relative(outputDirectory, destination).split(path.sep).join('/');
}

function hashExportSet(result: WorkspaceExportSetResult): string {
  return `export-set:${createHash('sha256').update(JSON.stringify(result)).digest('hex')}`;
}

export async function preflightBulkWorkspaceExport(
  connection: RequestConnection,
  outputDirectory: string,
  workspaceType?: CanonicalWorkspaceType,
  options: JsonRequestOptions = {},
): Promise<{ discoveredCount: number; selected: PreparedWorkspace[] }> {
  const listed = await enumerateWorkspaces(connection, options);
  const canonical: PreparedWorkspace[] = [];
  const canonicalNames = new Map<string, string>();

  for (const summary of listed) {
    const workspace = await getWorkspace(connection, summary.id, options);
    if (workspace.id !== summary.id || !nonemptyString(workspace.name)) {
      throw new Error(
        `Canonical workspace ${summary.id} returned a malformed or mismatched ID/name.`,
      );
    }
    const nameKey = folded(workspace.name);
    const existingNameId = canonicalNames.get(nameKey);
    if (existingNameId !== undefined && existingNameId !== summary.id) {
      throw new Error(
        `Workspace names for IDs ${existingNameId} and ${summary.id} differ only by case or Unicode normalization and are ambiguous.`,
      );
    }
    canonicalNames.set(nameKey, summary.id);
    const type = actualWorkspaceType(workspace);
    if (workspaceType !== undefined && type !== workspaceType) continue;
    canonical.push({
      id: summary.id,
      name: workspace.name,
      type,
      destination: path.join(outputDirectory, safeWorkspaceDirectoryName(workspace.name)),
    });
  }

  canonical.sort((left, right) => left.id.localeCompare(right.id, 'en-US'));
  await assertParentCompatible(outputDirectory);
  const destinations = new Map<string, PreparedWorkspace>();
  for (const workspace of canonical) {
    if (await exists(workspace.destination)) {
      throw new Error(`Export destination already exists: ${workspace.destination}`);
    }
    const destinationKey = folded(path.resolve(workspace.destination));
    const existing = destinations.get(destinationKey);
    if (existing !== undefined) {
      throw new Error(
        `Workspace destinations collide after sanitization: ${existing.id} (${existing.name}) and ${workspace.id} (${workspace.name}).`,
      );
    }
    destinations.set(destinationKey, workspace);
  }

  return { discoveredCount: listed.length, selected: canonical };
}

export async function exportAllWorkspaces(
  connection: RequestConnection,
  outputDirectory: string,
  workspaceType: CanonicalWorkspaceType,
  options: BulkWorkspaceExportOptions = {},
): Promise<CmsEnvelope<WorkspaceExportSetResult>> {
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const pluginVersion = options.pluginVersion ?? '0.3.0';
  const sourceOrgId = options.sourceOrgId ?? 'unknown-org';
  const preflight = await preflightBulkWorkspaceExport(
    connection,
    outputDirectory,
    workspaceType,
    options,
  );
  if (preflight.selected.length > 0) await mkdir(outputDirectory, { recursive: true });

  const workspaces: WorkspaceExportSetEntry[] = [];
  const externalReferenceCorrelations: ExternalReferenceCorrelation[] = [];
  for (const workspace of preflight.selected) {
    const artifactPath = relativeArtifactPath(outputDirectory, workspace.destination);
    try {
      const exported = await exportWorkspace(connection, workspace.id, workspace.destination, {
        ...options,
        generatedAt,
        pluginVersion,
        sourceOrgId,
      });
      const partial = exported.manifest.completeness === 'partial';
      for (const reference of exported.manifest.externalReferences) {
        if (reference.resolution !== 'included' || reference.kind !== 'cms.content') continue;
        externalReferenceCorrelations.push({
          sourceWorkspaceId: workspace.id,
          sourceReference: reference.portableKey.value,
          referenceKind: reference.kind,
          referenceId: reference.referenceId,
          packageManifestSha256: exported.manifestSha256,
        });
      }
      const warnings: CmsDiagnostic[] = partial
        ? exported.manifest.warnings.map(({ code, message }) => ({ code, message }))
        : [];
      workspaces.push({
        source: {
          kind: 'cms.workspace',
          sourceId: workspace.id,
          name: workspace.name,
          workspaceType: workspace.type,
        },
        status: partial ? 'partial' : 'success',
        artifact: {
          path: artifactPath,
          manifestPath: `${artifactPath}/manifest.json`,
          manifestContract: WORKSPACE_EXPORT_MANIFEST_CONTRACT,
          manifestContractVersion: '1.0.0',
          manifestSha256: exported.manifestSha256,
        },
        diagnostics: { warnings, errors: [] },
      });
    } catch (error) {
      workspaces.push({
        source: {
          kind: 'cms.workspace',
          sourceId: workspace.id,
          name: workspace.name,
          workspaceType: workspace.type,
        },
        status: 'failed',
        artifact: null,
        diagnostics: {
          warnings: [],
          errors: [{ code: 'WORKSPACE_EXPORT_FAILED', message: normalizedError(error) }],
        },
      });
    }
  }

  externalReferenceCorrelations.sort((left, right) =>
    [
      left.sourceWorkspaceId,
      left.sourceReference,
      left.referenceKind,
      left.referenceId,
      left.packageManifestSha256,
    ]
      .join('\u0000')
      .localeCompare(
        [
          right.sourceWorkspaceId,
          right.sourceReference,
          right.referenceKind,
          right.referenceId,
          right.packageManifestSha256,
        ].join('\u0000'),
      ),
  );
  const result: WorkspaceExportSetResult = {
    workspaceType,
    outputDirectory: portableOutputPath(outputDirectory),
    selection: {
      mode: 'all',
      discoveredCount: preflight.discoveredCount,
      selectedCount: workspaces.length,
    },
    summary: {
      succeededCount: workspaces.filter(({ status }) => status === 'success').length,
      partialCount: workspaces.filter(({ status }) => status === 'partial').length,
      failedCount: workspaces.filter(({ status }) => status === 'failed').length,
    },
    externalReferenceCorrelations,
    workspaces,
  };
  let status: CmsStatus = 'success';
  if (result.summary.failedCount === workspaces.length && workspaces.length > 0) status = 'failed';
  else if (result.summary.failedCount > 0 || result.summary.partialCount > 0) status = 'partial';
  const errors = aggregateDiagnostics(workspaces, 'errors');
  const warnings = aggregateDiagnostics(workspaces, 'warnings');

  const envelope: CmsEnvelope<WorkspaceExportSetResult> = {
    contract: WORKSPACE_EXPORT_SET_CONTRACT,
    contractVersion: '1.0.0',
    status,
    metadata: {
      operation: 'workspace.export.bulk',
      plugin: { name: 'sf-plugin-cms', version: pluginVersion },
      apiVersion: options.apiVersion ?? '67.0',
    },
    diagnostics: { warnings, errors },
    provenance: {
      producer: 'sf-plugin-cms',
      sourceOrgId,
      pluginVersion,
      exportSetId: hashExportSet(result),
      command: 'sf cms export workspace',
      generatedAt,
    },
    result,
  };
  assertCmsEnvelope(envelope, assertWorkspaceExportSetResult);
  return envelope;
}

function aggregateDiagnostics(
  workspaces: readonly WorkspaceExportSetEntry[],
  kind: 'errors' | 'warnings',
): CmsDiagnostic[] {
  const diagnostics = workspaces.flatMap(({ source, diagnostics: workspaceDiagnostics }) =>
    workspaceDiagnostics[kind].map((diagnostic) => ({ ...diagnostic, scope: source.sourceId })),
  );
  if (diagnostics.length <= MAX_DIAGNOSTICS_PER_KIND) {
    return sanitizeDiagnostics(diagnostics, `diagnostics.${kind}`);
  }
  const omitted = diagnostics.length - MAX_DIAGNOSTICS_PER_KIND + 1;
  return sanitizeDiagnostics(
    [
      ...diagnostics.slice(0, MAX_DIAGNOSTICS_PER_KIND - 1),
      {
        code: 'DIAGNOSTICS_TRUNCATED',
        message: `${omitted} additional ${kind} omitted from aggregate diagnostics; per-workspace diagnostics remain complete.`,
        retryable: false,
      },
    ],
    `diagnostics.${kind}`,
  );
}
