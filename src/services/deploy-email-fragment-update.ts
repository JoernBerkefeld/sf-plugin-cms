import type { Connection } from '@salesforce/core';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { JsonRequestOptions } from '../transport/json-request.js';
import { redactSecrets } from '../transport/redact-secrets.js';
import {
  prepareEmailFragmentUpdate,
  type EmailFragmentUpdatePreparation,
} from './deploy-email-fragment-update-preflight.js';
import { loadEditableEmailFragmentSource } from './editable-item-source.js';
import { updateVariant } from './lifecycle-foundation.js';
import {
  pendingOperation,
  persistOperationResult,
  rewriteAtomic,
  writeExclusive,
  type WorkspaceImportReportPersistence,
  type WorkspaceImportRunReport,
} from './import-workspace.js';

type FragmentConnection = Pick<Connection, 'request' | 'getApiVersion' | 'getAuthInfoFields'>;
export type ExecuteEmailFragmentUpdateInput = {
  definitionFile: string;
  workspaceId: string;
  /** Exclusive new intent journal; never resumed or overwritten for replay. */
  reportFile?: string;
};
export type EmailFragmentUpdateResult = {
  qualification: 'unqualified';
  outcome: 'updated' | 'unchanged';
  evidence: { contentId: string; variantId: string };
  report?: WorkspaceImportRunReport;
  reportFile?: string;
};
const sha = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');

/**
 * Execute one internal full-body Fragment UPDATE with independent same-ID Draft readback.
 * @param {FragmentConnection} connection - Exact destination transport and identity.
 * @param {ExecuteEmailFragmentUpdateInput} input - Standalone definition, workspace and new journal.
 * @param {JsonRequestOptions} options - Bounded timeout and cancellation options.
 * @param {WorkspaceImportReportPersistence} persistence - Existing journal persistence seam.
 * @param {Function} onReport - Assignment-only reconciliation evidence handoff.
 * @param {Function} beforeExecute - Awaited whole-selection revalidation before dispatch or unchanged completion.
 * @returns {Promise<EmailFragmentUpdateResult>} Unqualified independently verified result.
 */
export async function executeEmailFragmentUpdate(
  connection: FragmentConnection,
  input: ExecuteEmailFragmentUpdateInput,
  options: JsonRequestOptions = {},
  persistence?: WorkspaceImportReportPersistence,
  onReport?: (report: WorkspaceImportRunReport) => void,
  beforeExecute?: () => Promise<void>,
): Promise<EmailFragmentUpdateResult> {
  const selected = structuredClone(input);
  const requestOptions = { ...options };
  const preflight = await prepareEmailFragmentUpdate(connection, selected, requestOptions);
  const target = preflight.destination.existing.evidence;
  const assertBinding = (fresh: EmailFragmentUpdatePreparation): void => {
    if (
      !isDeepStrictEqual(fresh, preflight) ||
      connection.getAuthInfoFields().orgId !== preflight.orgId ||
      connection.getApiVersion() !== preflight.apiVersion ||
      requestOptions.signal?.aborted
    )
      throw new TypeError(
        'Fragment UPDATE source, destination or provider binding drifted before write',
      );
  };
  if (preflight.proposed === 'unchanged') {
    await beforeExecute?.();
    assertBinding(await prepareEmailFragmentUpdate(connection, selected, requestOptions));
    return {
      qualification: 'unqualified',
      outcome: 'unchanged',
      evidence: structuredClone(target),
    };
  }
  const reportFile =
    selected.reportFile === undefined ? undefined : path.resolve(selected.reportFile);
  const report: WorkspaceImportRunReport = {
    createdParents: [],
    destinationOrgId: preflight.orgId,
    destinationWorkspaceId: selected.workspaceId,
    dataGraphPrerequisites: structuredClone(preflight.dataGraphs),
    operations: [],
    runId: randomUUID(),
    sourceDirectory: path.dirname(path.resolve(selected.definitionFile)),
    sourceManifestSha256: sha(preflight.destination.source),
    state: 'applying',
  };
  const operation = {
    ...pendingOperation(
      report,
      'update-variant',
      String(preflight.baseline.variant.contentKey),
      preflight.destination.workspace.defaultLanguage,
      preflight.payload,
    ),
    target: structuredClone(target),
    baselineSha256: sha(preflight),
  };
  report.operations.push(operation);
  onReport?.(report);
  if (reportFile !== undefined) await writeExclusive(reportFile, report);
  const rewrite = persistence?.rewrite ?? rewriteAtomic;
  let dispatched = false;
  try {
    if (reportFile !== undefined) await rewrite(reportFile, report);
    if (
      reportFile !== undefined &&
      !isDeepStrictEqual(JSON.parse(await readFile(reportFile, 'utf8')), report)
    )
      throw new TypeError('Fragment UPDATE durable intent changed before write');
    // Reacquire complete exact raw baseline, actual siblings, source and providers after durable intent.
    await beforeExecute?.();
    assertBinding(await prepareEmailFragmentUpdate(connection, selected, requestOptions));
    if (
      reportFile !== undefined &&
      !isDeepStrictEqual(JSON.parse(await readFile(reportFile, 'utf8')), report)
    )
      throw new TypeError('Fragment UPDATE durable intent changed at mutation boundary');
    if (
      !isDeepStrictEqual(
        await loadEditableEmailFragmentSource(selected.definitionFile),
        preflight.destination.source,
      ) ||
      connection.getAuthInfoFields().orgId !== preflight.orgId ||
      connection.getApiVersion() !== preflight.apiVersion ||
      requestOptions.signal?.aborted
    )
      throw new TypeError('Fragment UPDATE source or connection changed at mutation boundary');
    const receiver = Object.create(connection) as FragmentConnection;
    Object.defineProperty(receiver, '_refreshDelegate', { value: undefined });
    dispatched = true;
    const returned = await updateVariant(
      receiver,
      target.variantId,
      structuredClone(preflight.payload),
      requestOptions,
      async (data) => {
        const raw = data as Record<string, unknown> | null;
        operation.result = {
          ...(typeof raw?.managedContentId === 'string' ? { contentId: raw.managedContentId } : {}),
          ...(typeof raw?.managedContentVariantId === 'string'
            ? { variantId: raw.managedContentVariantId }
            : {}),
        };
        report.state = 'ownership-uncertain';
        if (reportFile !== undefined)
          await persistOperationResult(reportFile, report, operation, rewrite);
      },
    );
    if (
      returned.managedContentId !== target.contentId ||
      returned.managedContentVariantId !== target.variantId ||
      returned.language !== preflight.destination.workspace.defaultLanguage ||
      returned.isPublished !== false
    )
      throw new TypeError('Fragment UPDATE returned identity/lifecycle mismatch');
    // The mutation response is not proof: fresh preparation independently reads parent, variant and complete siblings.
    const post = await prepareEmailFragmentUpdate(connection, selected, requestOptions);
    if (
      post.proposed !== 'unchanged' ||
      !isDeepStrictEqual(post.destination.existing.projection.definition, preflight.expected) ||
      post.orgId !== preflight.orgId ||
      post.apiVersion !== preflight.apiVersion ||
      !isDeepStrictEqual(post.destination.existing.evidence, target) ||
      !isDeepStrictEqual(post.destination.source, preflight.destination.source) ||
      !isDeepStrictEqual(post.destination.workspace, preflight.destination.workspace) ||
      !isDeepStrictEqual(post.dataGraphs, preflight.dataGraphs) ||
      post.baseline.variant.contentKey !== preflight.baseline.variant.contentKey ||
      post.baseline.parent.contentKey !== preflight.baseline.parent.contentKey
    )
      throw new TypeError('Fragment UPDATE independent Draft readback mismatch');
    operation.state = 'succeeded';
    report.state = 'completed';
    if (reportFile !== undefined) await rewrite(reportFile, report);
    return {
      qualification: 'unqualified',
      outcome: 'updated',
      evidence: structuredClone(target),
      report,
      reportFile,
    };
  } catch (error) {
    operation.state = dispatched ? 'pending' : 'failed';
    report.state = dispatched ? 'ownership-uncertain' : 'failed';
    operation.error = redactSecrets(error instanceof Error ? error.message : String(error));
    try {
      if (reportFile !== undefined) await rewrite(reportFile, report);
    } catch {
      // Retain durable pending intent and in-memory native IDs; never replay uncertain UPDATE.
    }
    throw error;
  }
}
