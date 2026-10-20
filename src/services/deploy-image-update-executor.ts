import type { Connection } from '@salesforce/core';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { JsonRequestOptions } from '../transport/json-request.js';
import { updateImageContent } from '../transport/multipart-image-update.js';
import { redactSecrets } from '../transport/redact-secrets.js';
import {
  preflightDeployImageUpdate,
  type DeployImageUpdatePreflightInput,
} from './deploy-image-update-preflight.js';
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
export type ExecuteDeployImageUpdateInput = DeployImageUpdatePreflightInput & {
  destinationOrgId: string;
  /** Optional new journal in a caller-owned directory; no resume or overwrite. */
  reportFile?: string;
};
type Preflight = Awaited<ReturnType<typeof preflightDeployImageUpdate>>;

function journalEvidence(preflight: Preflight) {
  const { source, destination, ...binding } = preflight;
  if (source.source.representation !== 'binary')
    throw new TypeError('Image UPDATE requires binary source');
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
 * Execute one private bytes-only Image UPDATE with optional persistence and native readback.
 * Observed snapshots are not an authoring baseline or atomic conflict protection.
 * @param {ImageConnection} connection - Explicit authenticated destination.
 * @param {ExecuteDeployImageUpdateInput} input - Source, exact scope and absent journal.
 * @param {JsonRequestOptions} options - Request cancellation and timeout controls.
 * @param {WorkspaceImportReportPersistence} persistence - Internal journal failure injection.
 * @param {Function} beforeMutation - Internal batch boundary; never replaces Image proof.
 * @param {Function} onReport - Internal synchronous assignment-only live evidence handoff.
 * @returns {Promise<object>} Completion after independent readback and optional persistence.
 */
export async function executeDeployImageUpdate(
  connection: ImageConnection,
  input: ExecuteDeployImageUpdateInput,
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
    throw new TypeError('Image UPDATE requires exact destination org ID');
  const reportFile =
    selected.reportFile === undefined ? undefined : path.resolve(selected.reportFile);
  const preflight = await preflightDeployImageUpdate(connection, selected, requestOptions);
  if (preflight.source.source.representation !== 'binary')
    throw new TypeError('Image UPDATE requires binary source');
  const binary = preflight.source.source.binary;
  // Explicit base64 retains desired and observed bytes through the journal JSON round-trip.
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
  // Synchronous assignment-only handoff retains live evidence even when execution throws.
  onReport?.(report);
  if (reportFile !== undefined) await writeExclusive(reportFile, report);
  const rewrite = persistence?.rewrite ?? rewriteAtomic;
  let mutationStarted = false;
  try {
    if (reportFile !== undefined) await rewrite(reportFile, report);
    const fresh = await preflightDeployImageUpdate(connection, selected, requestOptions);
    if (!isDeepStrictEqual(journalEvidence(fresh), evidence))
      throw new TypeError('Image UPDATE local or destination binding drifted before write');
    if (beforeMutation) {
      await beforeMutation();
      if (
        !isDeepStrictEqual(
          journalEvidence(await preflightDeployImageUpdate(connection, selected, requestOptions)),
          evidence,
        )
      )
        throw new TypeError('Image UPDATE binding drifted during batch boundary');
    }
    if (
      reportFile !== undefined &&
      !isDeepStrictEqual(JSON.parse(await readFile(reportFile, 'utf8')), report)
    )
      throw new TypeError('Image UPDATE durable intent changed before write');
    if (requestOptions.signal?.aborted) throw new TypeError('Image UPDATE cancelled before write');
    const receiver = Object.create(connection) as ImageConnection;
    Object.defineProperty(receiver, '_refreshDelegate', { value: undefined });
    mutationStarted = true;
    const response = await updateImageContent(
      receiver,
      fresh.variantId,
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
            ? { variantId: record.managedContentVariantId }
            : {}),
          ...(typeof record.contentKey === 'string' ? { contentKey: record.contentKey } : {}),
        };
        report.state = 'ownership-uncertain';
        if (reportFile !== undefined)
          await persistOperationResult(reportFile, report, operation, rewrite);
      },
    );
    if (
      response.managedContentId !== fresh.contentId ||
      response.managedContentVariantId !== fresh.variantId ||
      (operation.result?.contentKey !== undefined &&
        operation.result.contentKey !== fresh.contentKey)
    )
      throw new TypeError('Image UPDATE response identity mismatch');
    const inventory = await enumerateNativeWorkspace(
      connection,
      selected.workspaceId,
      requestOptions,
    );
    if (!isDeepStrictEqual(inventory, fresh.destination.inventory))
      throw new TypeError('Image UPDATE native inventory readback mismatch');
    const before = await getVariant(connection, fresh.variantId, requestOptions);
    const acquired = await acquireEditableMediaSource(
      connection,
      {
        workspaceId: selected.workspaceId,
        apiName: fresh.source.definition.identity.apiName,
        language: selected.language,
        contentType: 'sfdc_cms__image',
      },
      requestOptions,
    );
    const actual = acquired.projection.definition;
    if (
      acquired.evidence.contentId !== fresh.contentId ||
      acquired.evidence.variantId !== fresh.variantId ||
      !isDeepStrictEqual(actual, fresh.destination.acquisition.projection.definition) ||
      actual.media.representation !== 'binary' ||
      actual.media.mimeType !== binary.mimeType ||
      acquired.projection.companions.length !== 1 ||
      !acquired.projection.companions[0].bytes.equals(binary.bytes)
    )
      throw new TypeError('Image UPDATE independent media readback mismatch');
    const after = await getVariant(connection, fresh.variantId, requestOptions);
    const media = (after.contentBody as Record<string, { url?: string }> | undefined)?.[
      'sfdc_cms:media'
    ];
    if (
      !isDeepStrictEqual(before, after) ||
      after.managedContentId !== fresh.contentId ||
      after.managedContentVariantId !== fresh.variantId ||
      after.contentKey !== fresh.contentKey ||
      new URL(media?.url ?? '', connection.instanceUrl ?? 'https://local.invalid').searchParams.get(
        'fileName',
      ) !== binary.fileName
    )
      throw new TypeError('Image UPDATE native filename/identity readback mismatch');
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
      throw new TypeError('Image UPDATE destination drifted during readback');
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
