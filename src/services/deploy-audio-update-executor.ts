import type { Connection } from '@salesforce/core';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { getCmsApiSelection } from '../api-policy.js';
import type { JsonRequestOptions } from '../transport/json-request.js';
import { buildAudioUpdateMultipart } from '../transport/multipart-audio-update.js';
import { sendVariantUpdateMultipart } from '../transport/multipart-image-update.js';
import { redactSecrets } from '../transport/redact-secrets.js';
import {
  preflightDeployAudioUpdate,
  type DeployAudioUpdatePreflightInput,
} from './deploy-audio-update-preflight.js';
import { loadEditableMediaSource } from './editable-media-source.js';
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

type AudioConnection = Pick<Connection, 'request' | 'getApiVersion'> &
  Partial<Pick<Connection, 'accessToken' | 'instanceUrl' | 'version'>>;
export type ExecuteDeployAudioUpdateInput = DeployAudioUpdatePreflightInput & {
  destinationOrgId: string;
  /** Absent journal in an existing caller-owned directory; never resume or overwrite. */
  reportFile?: string;
};
type Preflight = Awaited<ReturnType<typeof preflightDeployAudioUpdate>>;

function journalEvidence(preflight: Preflight) {
  const { source, destination, ...binding } = preflight;
  if (source.source.representation !== 'binary')
    throw new TypeError('Audio UPDATE requires binary source');
  // JSON-normalize optional fields so the evidence compares exactly with its durable form.
  // eslint-disable-next-line unicorn/prefer-structured-clone -- Durable JSON evidence must omit undefined fields, not retain them as structuredClone does.
  return JSON.parse(
    JSON.stringify({
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
        companions: destination.acquisition.projection.companions.map(
          ({ bytes, ...companion }) => ({
            ...companion,
            bytesBase64: bytes.toString('base64'),
          }),
        ),
      },
    }),
  ) as Record<string, unknown>;
}

/**
 * Execute one private unqualified Audio replacement with optional, non-replayable persistence.
 * Local candidate framing is not evidence of native Audio UPDATE acceptance.
 * @param {AudioConnection} connection - Explicit destination connection.
 * @param {ExecuteDeployAudioUpdateInput} input - Source, scope and absent journal.
 * @param {JsonRequestOptions} options - Bounded reads and cancellation controls.
 * @param {WorkspaceImportReportPersistence} persistence - Internal persistence failure injection.
 * @param {Function} beforeMutation - Awaited boundary followed by fresh independent preflight.
 * @param {Function} onReport - Internal synchronous assignment-only live evidence handoff.
 * @returns {Promise<object>} Independently verified completion after resolved persistence.
 */
export async function executeDeployAudioUpdate(
  connection: AudioConnection,
  input: ExecuteDeployAudioUpdateInput,
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
  const checkCancellation = (): void => {
    if (requestOptions.signal?.aborted) throw new TypeError('Audio UPDATE cancelled');
  };
  if (!/^00D[A-Za-z0-9]{12}[A-Z0-5]{3}$/u.test(selected.destinationOrgId))
    throw new TypeError('Audio UPDATE requires exact destination org ID');
  const reportFile =
    selected.reportFile === undefined ? undefined : path.resolve(selected.reportFile);
  const preflight = await preflightDeployAudioUpdate(connection, selected, requestOptions);
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
  let dispatched = false;
  try {
    if (reportFile !== undefined) await rewrite(reportFile, report);
    checkCancellation();
    if (beforeMutation) await beforeMutation();
    checkCancellation();
    const fresh = await preflightDeployAudioUpdate(connection, selected, requestOptions);
    if (!isDeepStrictEqual(journalEvidence(fresh), evidence))
      throw new TypeError('Audio UPDATE binding drifted during boundary');
    if (
      reportFile !== undefined &&
      !isDeepStrictEqual(JSON.parse(await readFile(reportFile, 'utf8')), report)
    )
      throw new TypeError('Audio UPDATE durable intent changed before write');
    checkCancellation();
    if (fresh.source.source.representation !== 'binary')
      throw new TypeError('Audio UPDATE requires fresh binary source');
    const binary = fresh.source.source.binary;
    const desired = fresh.source.definition;
    // Reconstruct the narrow authoring input, never pass expanded preflight contentBody/apiName.
    const multipart = buildAudioUpdateMultipart(
      {
        title: desired.title!,
        ...(desired.urlName === undefined ? {} : { urlName: desired.urlName }),
      },
      binary.fileName,
      binary.bytes,
      { mimeType: binary.mimeType },
    );
    const receiver = Object.create(connection) as AudioConnection;
    Object.defineProperty(receiver, '_refreshDelegate', { value: undefined });
    const response = await sendVariantUpdateMultipart(
      receiver,
      fresh.variantId,
      multipart,
      requestOptions,
      async (raw) => {
        const value = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
        operation.result = {
          ...(typeof value.managedContentId === 'string'
            ? { contentId: value.managedContentId }
            : {}),
          ...(typeof value.managedContentVariantId === 'string'
            ? { variantId: value.managedContentVariantId }
            : {}),
          ...(typeof value.contentKey === 'string' ? { contentKey: value.contentKey } : {}),
        };
        report.state = 'ownership-uncertain';
        if (reportFile !== undefined)
          await persistOperationResult(reportFile, report, operation, rewrite);
      },
      () => {
        dispatched = true;
      },
    );
    checkCancellation();
    if (
      response.managedContentId !== fresh.contentId ||
      response.managedContentVariantId !== fresh.variantId ||
      response.language !== selected.language ||
      response.isPublished !== false ||
      (operation.result?.contentKey !== undefined &&
        operation.result.contentKey !== fresh.contentKey)
    )
      throw new TypeError('Audio UPDATE response identity/lifecycle mismatch');
    const inventory = await enumerateNativeWorkspace(
      connection,
      selected.workspaceId,
      requestOptions,
    );
    checkCancellation();
    if (!isDeepStrictEqual(inventory, fresh.destination.inventory))
      throw new TypeError('Audio UPDATE native inventory readback mismatch');
    const before = await getVariant(connection, fresh.variantId, requestOptions);
    checkCancellation();
    if (
      before.isPublished !== false ||
      (before.status as { status?: string } | undefined)?.status !== 'Draft'
    )
      throw new TypeError('Audio UPDATE Draft readback mismatch');
    const acquired = await acquireEditableMediaSource(
      connection,
      {
        workspaceId: selected.workspaceId,
        apiName: desired.identity.apiName,
        language: selected.language,
        contentType: 'sfdc_cms__audio',
      },
      requestOptions,
    );
    checkCancellation();
    const actual = acquired.projection.definition;
    if (
      acquired.evidence.contentId !== fresh.contentId ||
      acquired.evidence.variantId !== fresh.variantId ||
      !isDeepStrictEqual(actual, fresh.destination.acquisition.projection.definition) ||
      actual.media.representation !== 'binary' ||
      actual.media.mimeType !== binary.mimeType ||
      acquired.projection.companions.length !== 1 ||
      !acquired.projection.companions[0].bytes.equals(binary.bytes) ||
      createHash('sha256').update(acquired.projection.companions[0].bytes).digest('hex') !==
        fresh.mediaSha256
    )
      throw new TypeError('Audio UPDATE independent replacement readback mismatch');
    // Compare postwrite brackets, not the old native URL/size/hash which replacement may change.
    const after = await getVariant(connection, fresh.variantId, requestOptions);
    checkCancellation();
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
      throw new TypeError('Audio UPDATE native filename/identity readback mismatch');
    const workspace = await getWorkspace(connection, selected.workspaceId, requestOptions);
    checkCancellation();
    const finalInventory = await enumerateNativeWorkspace(
      connection,
      selected.workspaceId,
      requestOptions,
    );
    checkCancellation();
    const finalSource = await loadEditableMediaSource(selected.definitionFile);
    checkCancellation();
    if (
      !isDeepStrictEqual(workspace, fresh.destination.workspace) ||
      !isDeepStrictEqual(finalInventory, inventory) ||
      !isDeepStrictEqual(finalSource, fresh.source) ||
      getCmsApiSelection(connection).effectiveApiVersion !== fresh.apiVersion
    )
      throw new TypeError('Audio UPDATE local/destination/version drifted during readback');
    checkCancellation();
    operation.state = 'succeeded';
    report.state = 'completed';
    onReport?.(report);
    if (reportFile !== undefined) await rewrite(reportFile, report);
    return { qualification: 'unqualified', reportFile, report };
  } catch (error) {
    operation.state = dispatched ? 'pending' : 'failed';
    report.state = dispatched ? 'ownership-uncertain' : 'failed';
    operation.error = redactSecrets(error instanceof Error ? error.message : String(error));
    try {
      if (reportFile !== undefined) await rewrite(reportFile, report);
    } catch {
      /* Preserve exclusive pending intent when persistence is unavailable; never claim completion. */
    }
    throw error;
  }
}
