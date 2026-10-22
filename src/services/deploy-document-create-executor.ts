import type { Connection } from '@salesforce/core';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { JsonRequestOptions } from '../transport/json-request.js';
import { createDocumentContent } from '../transport/multipart-image-create.js';
import { redactSecrets } from '../transport/redact-secrets.js';
import {
  preflightDeployDocumentCreate,
  type DeployDocumentCreatePreflightInput,
} from './deploy-document-create-preflight.js';
import {
  pendingOperation,
  persistOperationResult,
  rewriteAtomic,
  writeExclusive,
  type WorkspaceImportRunReport,
  type WorkspaceImportReportPersistence,
} from './import-workspace.js';

import { getVariant, getWorkspace } from './read.js';
import { acquireEditableMediaSource } from './retrieve-media-source.js';
import { enumerateNativeWorkspace } from './retrieve-native-inventory.js';

type DocumentConnection = Pick<Connection, 'request' | 'getApiVersion'> &
  Partial<Pick<Connection, 'accessToken' | 'instanceUrl' | 'version'>>;
export type ExecuteDeployDocumentCreateInput = DeployDocumentCreatePreflightInput & {
  destinationOrgId: string;
  /** New journal in an existing caller-owned directory; never resume or overwrite. */
  reportFile?: string;
};

/**
 * Execute one unqualified Document CREATE with optional durable intent and native readback.
 * Safe native MIME and opaque nonempty bytes retain identity and integrity checks.
 * @param {DocumentConnection} connection - Explicit destination connection.
 * @param {ExecuteDeployDocumentCreateInput} input - Local source, destination and new journal.
 * @param {JsonRequestOptions} options - Cancellation and bounded request options.
 * @param {WorkspaceImportReportPersistence} persistence - Internal persistence failure injection.
 * @param {Function} beforeMutation - Awaited boundary, followed by independent revalidation.
 * @param {Function} onReport - Internal synchronous assignment-only live evidence handoff.
 * @returns {Promise<object>} Completion only after independently verified ownership.
 */
export async function executeDeployDocumentCreate(
  connection: DocumentConnection,
  input: ExecuteDeployDocumentCreateInput,
  options: JsonRequestOptions = {},
  persistence?: WorkspaceImportReportPersistence,
  beforeMutation?: () => Promise<void>,
  onReport?: (report: WorkspaceImportRunReport) => void,
): Promise<{
  qualification: 'unqualified';
  reportFile?: string;
  report: WorkspaceImportRunReport;
}> {
  const selected = structuredClone(input);
  const requestOptions = { ...options };
  if (!/^00D[A-Za-z0-9]{12}[A-Z0-5]{3}$/u.test(selected.destinationOrgId))
    throw new TypeError('Document CREATE requires exact destination org ID');
  const reportFile =
    selected.reportFile === undefined ? undefined : path.resolve(selected.reportFile);
  // Detached preflight results supplied by callers are never accepted as mutation authority.
  const preflight = await preflightDeployDocumentCreate(connection, selected, requestOptions);
  if (preflight.source.source.representation !== 'binary')
    throw new TypeError('Document CREATE requires binary source');
  const binary = preflight.source.source.binary;
  const report: WorkspaceImportRunReport = {
    createdParents: [],
    destinationOrgId: selected.destinationOrgId,
    destinationWorkspaceId: selected.workspaceId,
    operations: [],
    runId: randomUUID(),
    sourceDirectory: path.dirname(preflight.definitionFile),
    sourceManifestSha256: preflight.sourceSha256,
    state: 'applying',
  };
  const operation = pendingOperation(
    report,
    'create-parent',
    preflight.payload.apiName!,
    selected.language,
    {
      ...preflight.payload,
      contentType: 'sfdc_cms__document',
      contentBody: {
        'sfdc_cms:media': { source: { type: 'file' } },
        binary: {
          fileName: binary.fileName,
          mimeType: binary.mimeType,
          sourceSha256: preflight.sourceSha256,
          mediaSha256: preflight.mediaSha256,
        },
      },
    },
  );
  report.operations.push(operation);
  // Synchronous assignment-only handoff retains live evidence even when execution throws.
  onReport?.(report);
  if (reportFile !== undefined) await writeExclusive(reportFile, report);
  const rewrite = persistence?.rewrite ?? rewriteAtomic;
  let mutationStarted = false;
  try {
    if (reportFile !== undefined) await rewrite(reportFile, report);
    if (beforeMutation) await beforeMutation();
    const fresh = await preflightDeployDocumentCreate(connection, selected, requestOptions);
    if (!isDeepStrictEqual(fresh, preflight))
      throw new TypeError('Document CREATE local or destination binding drifted before write');
    if (
      reportFile !== undefined &&
      !isDeepStrictEqual(JSON.parse(await readFile(reportFile, 'utf8')), report)
    )
      throw new TypeError('Document CREATE durable intent changed before write');
    if (requestOptions.signal?.aborted)
      throw new TypeError('Document CREATE cancelled before write');
    const receiver = Object.create(connection) as DocumentConnection;
    Object.defineProperty(receiver, '_refreshDelegate', { value: undefined });
    // Capture even partial raw identities before the shared transport validates its envelope.
    // This facade deliberately exposes no credentials: request runs on the no-refresh receiver.
    const transport = {
      request: (...args: Parameters<Connection['request']>) => {
        mutationStarted = true;
        const request = receiver.request<unknown>(...args);
        const captured = request.then(async (raw) => {
          if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
            const value = raw as Record<string, unknown>;
            operation.result = {
              ...(typeof value.managedContentId === 'string'
                ? { contentId: value.managedContentId }
                : {}),
              ...(typeof value.contentKey === 'string' ? { contentKey: value.contentKey } : {}),
              ...(typeof value.managedContentVariantId === 'string'
                ? { primaryVariantId: value.managedContentVariantId }
                : {}),
            };
            report.state = 'ownership-uncertain';
            if (reportFile !== undefined)
              await persistOperationResult(reportFile, report, operation, rewrite);
          }
          return raw;
        });
        return Object.assign(captured, { stream: () => request.stream() });
      },
    } as Pick<Connection, 'request'>;
    const response = await createDocumentContent(
      transport,
      fresh.payload,
      binary.fileName,
      binary.bytes,
      { ...requestOptions, mimeType: binary.mimeType },
    );
    const created = {
      contentId: response.managedContentId,
      contentKey: response.contentKey,
      primaryVariantId: response.managedContentVariantId,
    };
    if (
      !/^20Y[A-Za-z0-9]{12}[A-Z0-5]{3}$/u.test(created.contentId) ||
      !/^9Ps[A-Za-z0-9]{12}[A-Z0-5]{3}$/u.test(created.primaryVariantId)
    )
      throw new TypeError('Document CREATE returned invalid native identities');
    const inventory = await enumerateNativeWorkspace(
      connection,
      selected.workspaceId,
      requestOptions,
    );
    const owned = inventory.records.filter(
      (row) =>
        row.ManagedContentId === created.contentId ||
        row.ManagedContentKey === created.contentKey ||
        row.ManagedContent.ApiName === fresh.payload.apiName ||
        row.Name === fresh.payload.title ||
        (fresh.payload.urlName !== undefined && row.UrlName === fresh.payload.urlName),
    );
    const row = owned[0];
    if (
      inventory.apiVersion !== fresh.apiVersion ||
      owned.length !== 1 ||
      row.Id !== created.primaryVariantId ||
      row.ManagedContentId !== created.contentId ||
      row.ManagedContentKey !== created.contentKey ||
      row.ManagedContent.ApiName !== fresh.payload.apiName ||
      row.ContentTypeFullyQualifiedName !== 'sfdc_cms__document' ||
      row.Name !== fresh.payload.title ||
      (row.UrlName ?? undefined) !== fresh.payload.urlName ||
      row.Language !== selected.language ||
      row.IsPrimary !== true ||
      row.IsPublished !== false ||
      row.ManagedContentVariantStatus !== 'Draft' ||
      inventory.records.some((candidate) => !candidate.ManagedContent.ApiName)
    )
      throw new TypeError('Document CREATE native inventory readback mismatch');
    const before = await getVariant(connection, created.primaryVariantId, requestOptions);
    if (
      before.isPublished !== false ||
      (before.status as { status?: string } | undefined)?.status !== 'Draft'
    )
      throw new TypeError('Document CREATE Draft readback mismatch');
    const acquired = await acquireEditableMediaSource(
      connection,
      {
        workspaceId: selected.workspaceId,
        apiName: fresh.payload.apiName!,
        language: selected.language,
        contentType: 'sfdc_cms__document',
      },
      requestOptions,
    );
    const desired = preflight.source.definition;
    const actual = acquired.projection.definition;
    if (
      acquired.evidence.contentId !== created.contentId ||
      acquired.evidence.variantId !== created.primaryVariantId ||
      actual.title !== desired.title ||
      actual.urlName !== desired.urlName ||
      actual.media.representation !== 'binary' ||
      actual.media.mimeType !== binary.mimeType ||
      acquired.projection.companions.length !== 1 ||
      !acquired.projection.companions[0].bytes.equals(binary.bytes)
    )
      throw new TypeError('Document CREATE independent media readback mismatch');
    // Portable acquisition normalizes names; separately bind the original native filename.
    const detail = await getVariant(connection, created.primaryVariantId, requestOptions);
    const media = (detail.contentBody as Record<string, { url?: string }> | undefined)?.[
      'sfdc_cms:media'
    ];
    if (
      !isDeepStrictEqual(detail, before) ||
      detail.managedContentId !== created.contentId ||
      detail.managedContentVariantId !== created.primaryVariantId ||
      detail.contentKey !== created.contentKey ||
      new URL(media?.url ?? '', connection.instanceUrl ?? 'https://local.invalid').searchParams.get(
        'fileName',
      ) !== binary.fileName
    )
      throw new TypeError('Document CREATE native filename/identity readback mismatch');
    if (
      !isDeepStrictEqual(
        await getWorkspace(connection, selected.workspaceId, requestOptions),
        fresh.observations.workspace,
      )
    )
      throw new TypeError('Document CREATE destination workspace drifted during readback');
    report.createdParents.push({ ...created, childVariantIds: [] });
    operation.state = 'succeeded';
    report.state = 'completed';
    onReport?.(report);
    if (reportFile !== undefined) await rewrite(reportFile, report);
    return { qualification: 'unqualified', reportFile, report };
  } catch (error) {
    // Retain independently verified ownership evidence if final completion persistence fails.
    // Pending/ownership-uncertain state still forbids treating this run as completed.
    operation.state = mutationStarted ? 'pending' : 'failed';
    report.state = mutationStarted ? 'ownership-uncertain' : 'failed';
    operation.error = redactSecrets(error instanceof Error ? error.message : String(error));
    try {
      if (reportFile !== undefined) await rewrite(reportFile, report);
    } catch {
      /* Preserve exclusive pending intent when persistence is unavailable. */
    }
    throw error;
  }
}
