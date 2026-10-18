import type { Connection } from '@salesforce/core';
import { createHash, randomUUID } from 'node:crypto';
import { buildDocumentUpdateMultipart } from '../transport/multipart-document-update.js';
import { sendVariantUpdateMultipart } from '../transport/multipart-image-update.js';
import { getVariant, getWorkspace } from './read.js';
import { acquireEditableMediaSource } from './retrieve-media-source.js';
import { enumerateNativeWorkspace } from './retrieve-native-inventory.js';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { JsonRequestOptions } from '../transport/json-request.js';
import { redactSecrets } from '../transport/redact-secrets.js';
import {
  preflightDeployDocumentUpdate,
  type DeployDocumentUpdatePreflightInput,
} from './deploy-document-update-preflight.js';
import {
  pendingOperation,
  persistOperationResult,
  rewriteAtomic,
  writeExclusive,
  type WorkspaceImportRunReport,
  type WorkspaceImportReportPersistence,
} from './import-workspace.js';

type DocumentConnection = Pick<Connection, 'request' | 'getApiVersion'> &
  Partial<Pick<Connection, 'accessToken' | 'instanceUrl' | 'version'>>;
export type ExecuteDeployDocumentUpdateInput = DeployDocumentUpdatePreflightInput & {
  destinationOrgId: string;
  /** Absent journal in an existing caller-owned directory; never resume or overwrite. */
  reportFile: string;
};
type Preflight = Awaited<ReturnType<typeof preflightDeployDocumentUpdate>>;

// Fresh preparation is pending-only; never accepts a prior proof or existing journal.
export const prepareDeployDocumentUpdateIntent = (
  ...args: [
    DocumentConnection,
    ExecuteDeployDocumentUpdateInput,
    JsonRequestOptions?,
    WorkspaceImportReportPersistence?,
    (() => Promise<void>)?,
  ]
) => runDocumentUpdate(...args);

// Private one-shot entry: all admission and durable intent run within this invocation.
export const executeDeployDocumentUpdate = (
  connection: DocumentConnection,
  input: ExecuteDeployDocumentUpdateInput,
  options: JsonRequestOptions = {},
  persistence?: WorkspaceImportReportPersistence,
  beforeMutation?: () => Promise<void>,
) => runDocumentUpdate(connection, input, options, persistence, beforeMutation, true);

function journalEvidence(preflight: Preflight) {
  const { source, destination, ...binding } = preflight;
  if (source.source.representation !== 'binary')
    throw new TypeError('Document UPDATE requires binary source');
  return {
    ...binding,
    desired: {
      definition: source.definition,
      fileName: source.source.binary.fileName,
      mimeType: source.source.binary.mimeType,
      bytesBase64: source.source.binary.bytes.toString('base64'),
    },
    destination: {
      workspace: destination.workspace,
      inventory: destination.inventory,
      variant: destination.variant,
      mediaSha256: destination.mediaSha256,
      definition: destination.acquisition.projection.definition,
      evidence: destination.acquisition.evidence,
      companions: destination.acquisition.projection.companions.map(({ bytes, ...companion }) => ({
        ...companion,
        bytesBase64: bytes.toString('base64'),
      })),
    },
  };
}

/**
 * Prepare fresh durable intent and optionally execute one private Document replacement.
 * Returned observations confer neither reusable mutation permission nor atomic conflict protection.
 * UPDATE never records created-parent ownership; journals must never be replayed.
 * @param {DocumentConnection} connection - Explicit destination connection.
 * @param {ExecuteDeployDocumentUpdateInput} input - Local source, scope and absent journal.
 * @param {JsonRequestOptions} options - Bounded reads and cancellation controls.
 * @param {WorkspaceImportReportPersistence} persistence - Internal persistence failure injection.
 * @param {Function} beforeMutation - Awaited boundary followed by independent revalidation.
 * @param {boolean} execute - Execute only within this fresh invocation after guarded preparation.
 * @returns {Promise<object>} Pending preparation or independently verified durable completion.
 */
async function runDocumentUpdate(
  connection: DocumentConnection,
  input: ExecuteDeployDocumentUpdateInput,
  options: JsonRequestOptions = {},
  persistence?: WorkspaceImportReportPersistence,
  beforeMutation?: () => Promise<void>,
  execute = false,
) {
  const selected = structuredClone(input);
  const requestOptions = { ...options };
  if (!/^00D[A-Za-z0-9]{12}[A-Z0-5]{3}$/u.test(selected.destinationOrgId))
    throw new TypeError('Document UPDATE requires exact destination org ID');
  const reportFile = path.resolve(selected.reportFile);
  const preflight = await preflightDeployDocumentUpdate(connection, selected, requestOptions);
  const evidence = journalEvidence(preflight);
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
    'update-variant',
    preflight.contentKey,
    selected.language,
    {
      contentBody: evidence,
    },
  );
  report.operations.push(operation);
  await writeExclusive(reportFile, report);
  const rewrite = persistence?.rewrite ?? rewriteAtomic;
  let dispatched = false;
  try {
    await rewrite(reportFile, report);
    if (
      !isDeepStrictEqual(
        journalEvidence(await preflightDeployDocumentUpdate(connection, selected, requestOptions)),
        evidence,
      )
    )
      throw new TypeError('Document UPDATE local or destination binding drifted before write');
    if (beforeMutation) await beforeMutation();
    const fresh = await preflightDeployDocumentUpdate(connection, selected, requestOptions);
    if (!isDeepStrictEqual(journalEvidence(fresh), evidence))
      throw new TypeError('Document UPDATE binding drifted during boundary');
    if (!isDeepStrictEqual(JSON.parse(await readFile(reportFile, 'utf8')), report))
      throw new TypeError('Document UPDATE durable intent changed before write');
    if (requestOptions.signal?.aborted)
      throw new TypeError('Document UPDATE cancelled before write');
    if (execute) {
      if (fresh.source.source.representation !== 'binary')
        throw new TypeError('Document UPDATE requires binary source');
      const binary = fresh.source.source.binary;
      const multipart = buildDocumentUpdateMultipart(fresh.payload, binary.fileName, binary.bytes);
      const receiver = Object.create(connection) as DocumentConnection;
      Object.defineProperty(receiver, '_refreshDelegate', { value: undefined });
      const response = await sendVariantUpdateMultipart(
        receiver,
        fresh.variantId,
        multipart,
        requestOptions,
        async (raw) => {
          const record = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
          operation.result = {
            ...(typeof record.managedContentId === 'string'
              ? { contentId: record.managedContentId }
              : {}),
            ...(typeof record.managedContentVariantId === 'string'
              ? { variantId: record.managedContentVariantId }
              : {}),
            ...(typeof record.contentKey === 'string' ? { contentKey: record.contentKey } : {}),
          };
          report.state = 'ownership-uncertain';
          await persistOperationResult(reportFile, report, operation, rewrite);
        },
        () => {
          dispatched = true;
        },
      );
      if (
        response.managedContentId !== fresh.contentId ||
        response.managedContentVariantId !== fresh.variantId ||
        response.language !== selected.language ||
        response.isPublished !== false ||
        (operation.result?.contentKey !== undefined &&
          operation.result.contentKey !== fresh.contentKey)
      )
        throw new TypeError('Document UPDATE response identity/lifecycle mismatch');
      const inventory = await enumerateNativeWorkspace(
        connection,
        selected.workspaceId,
        requestOptions,
      );
      if (!isDeepStrictEqual(inventory, fresh.destination.inventory))
        throw new TypeError('Document UPDATE native inventory readback mismatch');
      const before = await getVariant(connection, fresh.variantId, requestOptions);
      const acquired = await acquireEditableMediaSource(
        connection,
        {
          workspaceId: selected.workspaceId,
          apiName: fresh.payload.apiName,
          language: selected.language,
          contentType: 'sfdc_cms__document',
        },
        requestOptions,
      );
      const actual = acquired.projection.definition;
      if (
        acquired.evidence.contentId !== fresh.contentId ||
        acquired.evidence.variantId !== fresh.variantId ||
        !isDeepStrictEqual(actual, fresh.destination.acquisition.projection.definition) ||
        actual.media.representation !== 'binary' ||
        actual.media.mimeType !== 'text/plain' ||
        acquired.projection.companions.length !== 1 ||
        !acquired.projection.companions[0].bytes.equals(binary.bytes) ||
        createHash('sha256').update(acquired.projection.companions[0].bytes).digest('hex') !==
          fresh.mediaSha256
      )
        throw new TypeError('Document UPDATE independent replacement readback mismatch');
      const after = await getVariant(connection, fresh.variantId, requestOptions);
      const media = (after.contentBody as Record<string, { url?: string }> | undefined)?.[
        'sfdc_cms:media'
      ];
      if (
        !isDeepStrictEqual(before, after) ||
        after.managedContentId !== fresh.contentId ||
        after.managedContentVariantId !== fresh.variantId ||
        after.contentKey !== fresh.contentKey ||
        new URL(
          media?.url ?? '',
          connection.instanceUrl ?? 'https://local.invalid',
        ).searchParams.get('fileName') !== binary.fileName
      )
        throw new TypeError('Document UPDATE native filename/identity readback mismatch');
      if (
        !isDeepStrictEqual(
          await getWorkspace(connection, selected.workspaceId, requestOptions),
          fresh.destination.workspace,
        ) ||
        !isDeepStrictEqual(
          await enumerateNativeWorkspace(connection, selected.workspaceId, requestOptions),
          inventory,
        )
      )
        throw new TypeError('Document UPDATE destination drifted during readback');
      operation.state = 'succeeded';
      report.state = 'completed';
      await rewrite(reportFile, report);
    }
    return { qualification: 'unqualified' as const, reportFile, report, preflight: fresh };
  } catch (error) {
    operation.state = dispatched ? 'pending' : 'failed';
    report.state = dispatched ? 'ownership-uncertain' : 'failed';
    operation.error = redactSecrets(error instanceof Error ? error.message : String(error));
    try {
      await rewrite(reportFile, report);
    } catch {
      /* Preserve exclusive pending intent when persistence is unavailable. */
    }
    throw error;
  }
}
