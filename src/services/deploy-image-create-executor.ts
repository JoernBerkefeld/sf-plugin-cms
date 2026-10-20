import type { Connection } from '@salesforce/core';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { JsonRequestOptions } from '../transport/json-request.js';
import { createImageContent } from '../transport/multipart-image-create.js';
import { redactSecrets } from '../transport/redact-secrets.js';
import {
  preflightDeployImageCreate,
  type DeployImageCreatePreflightInput,
} from './deploy-image-create-preflight.js';
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

type ImageConnection = Pick<Connection, 'request' | 'getApiVersion'> &
  Partial<Pick<Connection, 'accessToken' | 'instanceUrl' | 'version'>>;
export type ExecuteDeployImageCreateInput = DeployImageCreatePreflightInput & {
  destinationOrgId: string;
  /** Optional new journal in a caller-owned directory. No resume or overwrite. */
  reportFile?: string;
};

/**
 * Execute one unqualified binary Image CREATE with optional durable intent and native readback.
 * Malformed responses remain uncertain; capture any returned identities before strict parsing.
 * @param {ImageConnection} connection - Explicit authenticated destination.
 * @param {ExecuteDeployImageCreateInput} input - Local source, exact scope and new journal.
 * @param {JsonRequestOptions} options - Request cancellation and timeout options.
 * @param {WorkspaceImportReportPersistence} persistence - Internal journal failure injection.
 * @param {Function} beforeMutation - Internal batch boundary; never replaces Image proof.
 * @param {Function} onReport - Internal synchronous assignment-only live evidence handoff.
 * @returns {Promise<object>} Completion only after independent native and binary readback.
 */
export async function executeDeployImageCreate(
  connection: ImageConnection,
  input: ExecuteDeployImageCreateInput,
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
    throw new TypeError('Image CREATE requires exact destination org ID');
  const reportFile =
    selected.reportFile === undefined ? undefined : path.resolve(selected.reportFile);
  const preflight = await preflightDeployImageCreate(connection, selected, requestOptions);
  if (preflight.source.source.representation !== 'binary')
    throw new TypeError('Image CREATE requires binary source');
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
  // Bind exact desired source bytes and filename as well as native metadata in durable intent.
  const operation = pendingOperation(
    report,
    'create-parent',
    preflight.payload.apiName!,
    selected.language,
    {
      ...preflight.payload,
      contentType: 'sfdc_cms__image',
      contentBody: {
        'sfdc_cms:media': { source: { type: 'file' } },
        binary: {
          fileName: binary.fileName,
          mimeType: binary.mimeType,
          sourceSha256: preflight.sourceSha256,
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
    const fresh = await preflightDeployImageCreate(connection, selected, requestOptions);
    if (!isDeepStrictEqual(fresh, preflight))
      throw new TypeError('Image CREATE local or destination binding drifted before write');
    if (beforeMutation) {
      await beforeMutation();
      if (
        !isDeepStrictEqual(
          await preflightDeployImageCreate(connection, selected, requestOptions),
          preflight,
        )
      )
        throw new TypeError('Image CREATE binding drifted during batch boundary');
    }
    if (
      reportFile !== undefined &&
      !isDeepStrictEqual(JSON.parse(await readFile(reportFile, 'utf8')), report)
    )
      throw new TypeError('Image CREATE durable intent changed before write');
    if (requestOptions.signal?.aborted) throw new TypeError('Image CREATE cancelled before write');
    const receiver = Object.create(connection) as ImageConnection;
    Object.defineProperty(receiver, '_refreshDelegate', { value: undefined });
    mutationStarted = true;
    const response = await createImageContent(
      receiver,
      fresh.payload,
      binary.fileName,
      binary.bytes,
      { ...requestOptions, mimeType: binary.mimeType },
      async (raw) => {
        const record = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
        operation.result = {
          ...(typeof record.managedContentId === 'string'
            ? { contentId: record.managedContentId }
            : {}),
          ...(typeof record.managedContentVariantId === 'string'
            ? { primaryVariantId: record.managedContentVariantId }
            : {}),
          ...(typeof record.contentKey === 'string' ? { contentKey: record.contentKey } : {}),
        };
        report.state = 'ownership-uncertain';
        if (reportFile !== undefined)
          await persistOperationResult(reportFile, report, operation, rewrite);
      },
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
      throw new TypeError('Image CREATE returned invalid native identities');
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
      row.ContentTypeFullyQualifiedName !== 'sfdc_cms__image' ||
      row.Name !== fresh.payload.title ||
      (row.UrlName ?? undefined) !== fresh.payload.urlName ||
      row.Language !== selected.language ||
      row.IsPrimary !== true ||
      row.IsPublished !== false ||
      row.ManagedContentVariantStatus !== 'Draft' ||
      inventory.records.some((candidate) => !candidate.ManagedContent.ApiName)
    )
      throw new TypeError('Image CREATE native inventory readback mismatch');
    const beforeReadback = await getVariant(connection, created.primaryVariantId, requestOptions);
    if (
      beforeReadback.isPublished !== false ||
      (beforeReadback.status as { status?: string } | undefined)?.status !== 'Draft'
    )
      throw new TypeError('Image CREATE Draft readback mismatch');
    const acquired = await acquireEditableMediaSource(
      connection,
      {
        workspaceId: selected.workspaceId,
        apiName: fresh.payload.apiName!,
        language: selected.language,
        contentType: 'sfdc_cms__image',
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
      throw new TypeError('Image CREATE independent media readback mismatch');
    // Acquisition normalizes companion names; independently bind the original native filename.
    const detail = await getVariant(connection, created.primaryVariantId, requestOptions);
    const media = (detail.contentBody as Record<string, { url?: string }> | undefined)?.[
      'sfdc_cms:media'
    ];
    if (
      !isDeepStrictEqual(detail, beforeReadback) ||
      detail.managedContentId !== created.contentId ||
      detail.managedContentVariantId !== created.primaryVariantId ||
      detail.contentKey !== created.contentKey ||
      new URL(media?.url ?? '', connection.instanceUrl ?? 'https://local.invalid').searchParams.get(
        'fileName',
      ) !== binary.fileName
    )
      throw new TypeError('Image CREATE native filename/identity readback mismatch');
    const workspace = await getWorkspace(connection, selected.workspaceId, requestOptions);
    if (
      workspace.id !== selected.workspaceId ||
      workspace.rootFolderId !== fresh.rootFolderId ||
      workspace.defaultLanguage !== selected.language
    )
      throw new TypeError('Image CREATE destination workspace drifted during readback');
    report.createdParents.push({ ...created, childVariantIds: [] });
    operation.state = 'succeeded';
    report.state = 'completed';
    if (reportFile !== undefined) await rewrite(reportFile, report);
    return { qualification: 'unqualified', reportFile, report };
  } catch (error) {
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
