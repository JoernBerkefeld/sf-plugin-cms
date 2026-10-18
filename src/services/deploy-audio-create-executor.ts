import type { Connection } from '@salesforce/core';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { getCmsApiSelection } from '../api-policy.js';
import type { JsonRequestOptions } from '../transport/json-request.js';
import { createAudioContent } from '../transport/multipart-image-create.js';
import { redactSecrets } from '../transport/redact-secrets.js';
import {
  preflightDeployAudioCreate,
  type DeployAudioCreatePreflightInput,
} from './deploy-audio-create-preflight.js';
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
export type ExecuteDeployAudioCreateInput = DeployAudioCreatePreflightInput & {
  destinationOrgId: string;
  /** New journal in an existing caller-owned directory; never resume or overwrite. */
  reportFile: string;
};

/**
 * Journal one private unqualified Audio CREATE with independent native byte readback.
 * Opaque local bytes and explicit MIME are framing evidence, not platform qualification.
 * @param {AudioConnection} connection - Explicit destination connection.
 * @param {ExecuteDeployAudioCreateInput} input - Source, destination scope and exclusive journal.
 * @param {JsonRequestOptions} options - Cancellation and bounded read options.
 * @param {WorkspaceImportReportPersistence} persistence - Internal persistence failure injection.
 * @param {Function} beforeMutation - Awaited boundary before independent revalidation.
 * @returns {Promise<object>} Completion only after verified ownership and resolved persistence.
 */
export async function executeDeployAudioCreate(
  connection: AudioConnection,
  input: ExecuteDeployAudioCreateInput,
  options: JsonRequestOptions = {},
  persistence?: WorkspaceImportReportPersistence,
  beforeMutation?: () => Promise<void>,
): Promise<{ qualification: 'unqualified'; reportFile: string; report: WorkspaceImportRunReport }> {
  const selected = structuredClone(input);
  const requestOptions = { ...options };
  if (!/^00D[A-Za-z0-9]{12}[A-Z0-5]{3}$/u.test(selected.destinationOrgId))
    throw new TypeError('Audio CREATE requires exact destination org ID');
  const reportFile = path.resolve(selected.reportFile);
  const preflight = await preflightDeployAudioCreate(connection, selected, requestOptions);
  if (preflight.source.source.representation !== 'binary')
    throw new TypeError('Audio CREATE requires binary source');
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
      contentType: 'sfdc_cms__audio',
      contentBody: {
        'sfdc_cms:media': { source: { type: 'file' } },
        binary: {
          fileName: binary.fileName,
          mimeType: binary.mimeType,
          sourceSha256: preflight.sourceSha256,
          mediaSha256: preflight.mediaSha256,
        },
        binding: {
          definition: preflight.source.definition,
          apiVersion: preflight.apiVersion,
          workspace: preflight.observations.workspace,
          inventory: preflight.observations.inventory,
        },
      },
    },
  );
  report.operations.push(operation);
  await writeExclusive(reportFile, report);
  const rewrite = persistence?.rewrite ?? rewriteAtomic;
  let mutationStarted = false;
  try {
    await rewrite(reportFile, report);
    if (beforeMutation) await beforeMutation();
    const fresh = await preflightDeployAudioCreate(connection, selected, requestOptions);
    if (!isDeepStrictEqual(fresh, preflight))
      throw new TypeError('Audio CREATE local or destination binding drifted before write');
    if (!isDeepStrictEqual(JSON.parse(await readFile(reportFile, 'utf8')), report))
      throw new TypeError('Audio CREATE durable intent changed before write');
    if (requestOptions.signal?.aborted) throw new TypeError('Audio CREATE cancelled before write');
    if (fresh.source.source.representation !== 'binary')
      throw new TypeError('Audio CREATE requires fresh binary source');
    const freshBinary = fresh.source.source.binary;
    const receiver = Object.create(connection) as AudioConnection;
    Object.defineProperty(receiver, '_refreshDelegate', { value: undefined });
    // Capture partial identities before strict transport validation; never expose refresh credentials.
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
            await persistOperationResult(reportFile, report, operation, rewrite);
          }
          return raw;
        });
        return Object.assign(captured, { stream: () => request.stream() });
      },
    } as Pick<Connection, 'request'>;
    const response = await createAudioContent(
      transport,
      fresh.payload,
      freshBinary.fileName,
      freshBinary.bytes,
      {
        ...requestOptions,
        mimeType: freshBinary.mimeType,
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
      throw new TypeError('Audio CREATE returned invalid native identities');
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
      row.ContentTypeFullyQualifiedName !== 'sfdc_cms__audio' ||
      row.Name !== fresh.payload.title ||
      (row.UrlName ?? undefined) !== fresh.payload.urlName ||
      row.Language !== selected.language ||
      row.IsPrimary !== true ||
      row.IsPublished !== false ||
      row.ManagedContentVariantStatus !== 'Draft' ||
      inventory.records.some((candidate) => !candidate.ManagedContent.ApiName)
    )
      throw new TypeError('Audio CREATE native inventory readback mismatch');
    const before = await getVariant(connection, created.primaryVariantId, requestOptions);
    if (
      before.isPublished !== false ||
      (before.status as { status?: string } | undefined)?.status !== 'Draft'
    )
      throw new TypeError('Audio CREATE Draft readback mismatch');
    const acquired = await acquireEditableMediaSource(
      connection,
      {
        workspaceId: selected.workspaceId,
        apiName: fresh.payload.apiName!,
        language: selected.language,
        contentType: 'sfdc_cms__audio',
      },
      requestOptions,
    );
    const desired = fresh.source.definition;
    const actual = acquired.projection.definition;
    if (
      acquired.evidence.contentId !== created.contentId ||
      acquired.evidence.variantId !== created.primaryVariantId ||
      actual.title !== desired.title ||
      actual.urlName !== desired.urlName ||
      actual.media.representation !== 'binary' ||
      actual.media.mimeType !== freshBinary.mimeType ||
      acquired.projection.companions.length !== 1 ||
      !acquired.projection.companions[0].bytes.equals(freshBinary.bytes)
    )
      throw new TypeError('Audio CREATE independent media readback mismatch');
    // Portable names are normalized; bind the original native filename independently.
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
      ) !== freshBinary.fileName
    )
      throw new TypeError('Audio CREATE native filename/identity readback mismatch');
    if (
      !isDeepStrictEqual(
        await getWorkspace(connection, selected.workspaceId, requestOptions),
        fresh.observations.workspace,
      ) ||
      getCmsApiSelection(connection).effectiveApiVersion !== fresh.apiVersion
    )
      throw new TypeError('Audio CREATE destination workspace/version drifted during readback');
    report.createdParents.push({ ...created, childVariantIds: [] });
    operation.state = 'succeeded';
    report.state = 'completed';
    await rewrite(reportFile, report);
    return { qualification: 'unqualified', reportFile, report };
  } catch (error) {
    // Failed completion persistence retains verified ownership but cannot claim durable completion.
    operation.state = mutationStarted ? 'pending' : 'failed';
    report.state = mutationStarted ? 'ownership-uncertain' : 'failed';
    operation.error = redactSecrets(error instanceof Error ? error.message : String(error));
    try {
      await rewrite(reportFile, report);
    } catch {
      /* Exclusive pending intent remains the only durable claim if persistence is unavailable. */
    }
    throw error;
  }
}
