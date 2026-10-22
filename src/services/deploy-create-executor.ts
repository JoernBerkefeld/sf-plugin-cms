import type { Connection } from '@salesforce/core';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { JsonRequestOptions } from '../transport/json-request.js';
import { redactSecrets } from '../transport/redact-secrets.js';
import {
  preflightDeployCreate,
  type DeployCreatePreflightInput,
} from './deploy-create-preflight.js';
import { selectDeploySources } from './deploy-source-selection.js';
import {
  pendingOperation,
  persistOperationResult,
  rewriteAtomic,
  validateParentResponse,
  verifyNativeCopy,
  writeExclusive,
  type WorkspaceImportRunReport,
  type WorkspaceImportReportPersistence,
} from './import-workspace.js';
import { enumerateNativeWorkspace } from './retrieve-native-inventory.js';
import { getContent, getVariant } from './read.js';
import { createContent } from './write.js';

type CreateConnection = Pick<Connection, 'request' | 'getApiVersion'>;
export type ExecuteDeployCreateInput = DeployCreatePreflightInput & {
  destinationOrgId: string;
  /** Optional new file in a caller-owned directory; existing reports are never resumed. */
  reportFile?: string;
};

/**
 * Internal, single-parent CREATE experiment. Not whole-selection or live-qualified apply authority.
 * Reacquires all admission and absence evidence; accepts no caller payload or preflight proof.
 * @param {CreateConnection} connection - Explicit destination connection.
 * @param {ExecuteDeployCreateInput} input - Local source, destination and exclusive journal path.
 * @param {JsonRequestOptions} options - Bounded timeout/cancellation options.
 * @param {WorkspaceImportReportPersistence} persistence - Internal failure-injection seam.
 * @param {Function} beforeExecute - Internal batch boundary check; cannot replace executor proof.
 * @param {Function} onReport - Internal synchronous assignment-only evidence handoff.
 * @returns {Promise<object>} Unqualified completion and in-memory evidence, optionally persisted.
 */
export async function executeDeployCreate(
  connection: CreateConnection,
  input: ExecuteDeployCreateInput,
  options: JsonRequestOptions = {},
  persistence?: WorkspaceImportReportPersistence,
  beforeExecute?: () => Promise<void>,
  onReport?: (report: WorkspaceImportRunReport) => void,
): Promise<{
  qualification: 'unqualified';
  reportFile?: string;
  report: WorkspaceImportRunReport;
}> {
  const selected = structuredClone(input);
  const requestOptions = { ...options };
  if (!/^00D[A-Za-z0-9]{12}[A-Z0-5]{3}$/u.test(selected.destinationOrgId))
    throw new TypeError('CREATE requires exact destination org ID');
  const reportFile =
    selected.reportFile === undefined ? undefined : path.resolve(selected.reportFile);
  const preflight = await preflightDeployCreate(connection, selected, requestOptions);
  const load = async () => selectDeploySources({ 'source-dir': [preflight.definitionFile] });
  const source = await load();
  const report: WorkspaceImportRunReport = {
    createdParents: [],
    destinationOrgId: selected.destinationOrgId,
    destinationWorkspaceId: selected.workspaceId,
    operations: [],
    runId: randomUUID(),
    sourceDirectory: path.dirname(preflight.definitionFile),
    sourceManifestSha256: createHash('sha256').update(JSON.stringify(source)).digest('hex'),
    state: 'applying',
  };
  const operation = pendingOperation(
    report,
    'create-parent',
    preflight.payload.apiName!,
    selected.language,
    preflight.payload,
  );
  report.operations.push(operation);
  // Hand off the live evidence before persistence or any possible remote mutation.
  onReport?.(report);
  // When requested, exclusive allocation records pending intent before dispatch.
  if (reportFile !== undefined) await writeExclusive(reportFile, report);
  const rewrite = persistence?.rewrite ?? rewriteAtomic;
  let mutationStarted = false;
  try {
    if (reportFile !== undefined) await rewrite(reportFile, report);
    // Reacquire complete absence, root/default language and local files after pending intent.
    const fresh = await preflightDeployCreate(connection, selected, requestOptions);
    if (!isDeepStrictEqual(fresh, preflight) || !isDeepStrictEqual(await load(), source))
      throw new TypeError('CREATE local or destination binding drifted before write');
    await beforeExecute?.();
    if (
      reportFile !== undefined &&
      !isDeepStrictEqual(JSON.parse(await readFile(reportFile, 'utf8')), report)
    )
      throw new TypeError('CREATE durable intent changed before write');
    if (requestOptions.signal?.aborted) throw new TypeError('CREATE cancelled before write');
    // Shadow refresh replay even on caller-supplied test/custom connections.
    const receiver = Object.create(connection) as CreateConnection;
    Object.defineProperty(receiver, '_refreshDelegate', { value: undefined });
    mutationStarted = true;
    const response = await createContent(receiver, fresh.payload, requestOptions);
    // Capture all returned identities BEFORE interpreting whether they are valid or owned.
    operation.result = {
      contentId: [response.managedContentId, response.id, response.contentId].find(
        (value): value is string => typeof value === 'string',
      ),
      contentKey: typeof response.contentKey === 'string' ? response.contentKey : undefined,
      primaryVariantId: [
        response.managedContentVariantId,
        response.primaryVariantId,
        response.variantId,
      ].find((value): value is string => typeof value === 'string'),
    };
    report.state = 'ownership-uncertain';
    if (reportFile !== undefined)
      await persistOperationResult(reportFile, report, operation, rewrite);
    const created = validateParentResponse(response, operation.result?.contentKey ?? '');
    if (
      !/^20Y[A-Za-z0-9]{12}[A-Z0-5]{3}$/u.test(created.contentId) ||
      !/^9Ps[A-Za-z0-9]{12}[A-Z0-5]{3}$/u.test(created.primaryVariantId)
    )
      throw new TypeError('CREATE returned invalid native identities');
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
      row.ContentTypeFullyQualifiedName !== fresh.payload.contentType ||
      row.Name !== fresh.payload.title ||
      (row.UrlName ?? undefined) !== fresh.payload.urlName ||
      row.Language !== selected.language ||
      row.IsPrimary !== true ||
      row.IsPublished !== false ||
      row.ManagedContentVariantStatus !== 'Draft' ||
      inventory.records.some((candidate) => !candidate.ManagedContent.ApiName)
    )
      throw new TypeError('CREATE native inventory readback mismatch');
    const parent = await getContent(connection, created.contentKey, {}, requestOptions);
    const detail = await getVariant(connection, created.primaryVariantId, requestOptions);
    for (const record of [parent, detail]) {
      verifyNativeCopy(record, fresh.payload, created, selected.language, {
        id: selected.workspaceId,
        rootFolderId: fresh.rootFolderId,
        defaultLanguage: selected.language,
      });
      if (
        !isDeepStrictEqual(
          Object.keys(record.contentBody as object).toSorted(),
          Object.keys(fresh.payload.contentBody).toSorted(),
        )
      )
        throw new TypeError('CREATE readback body has unexpected fields');
    }
    if ((detail.managedContentVariantId ?? detail.id) !== created.primaryVariantId)
      throw new TypeError('CREATE variant readback identity mismatch');
    report.createdParents.push(created);
    operation.state = 'succeeded';
    report.state = 'completed';
    onReport?.(report);
    // Captured identities, persisted when requested, must survive completion failure.
    if (reportFile !== undefined) await rewrite(reportFile, report);
    return { qualification: 'unqualified', reportFile, report };
  } catch (error) {
    operation.state = mutationStarted ? 'pending' : 'failed';
    report.state = mutationStarted ? 'ownership-uncertain' : 'failed';
    operation.error = redactSecrets(error instanceof Error ? error.message : String(error));
    try {
      if (reportFile !== undefined) await rewrite(reportFile, report);
    } catch {
      // Preserve the exclusive pending intent if persistence itself is unavailable.
    }
    throw error;
  }
}
