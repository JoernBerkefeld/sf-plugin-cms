import type { Connection } from '@salesforce/core';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { JsonRequestOptions } from '../transport/json-request.js';
import { redactSecrets } from '../transport/redact-secrets.js';
import { prepareDeployDestination } from './deploy-destination-preparation.js';
import { selectDeploySources } from './deploy-source-selection.js';
import { getContent, getVariant, getWorkspace } from './read.js';
import { decodeNativeHtml } from './import-identities.js';
import { updateVariant, type UpdateVariantInput } from './lifecycle-foundation.js';
import {
  pendingOperation,
  persistOperationResult,
  rewriteAtomic,
  writeExclusive,
  type WorkspaceImportReportPersistence,
  type WorkspaceImportRunReport,
} from './import-workspace.js';

type UpdateConnection = Pick<Connection, 'request' | 'getApiVersion'>;
export type ExecuteDeployUpdateInput = {
  definitionFile: string;
  workspaceId: string;
  language: string;
  destinationOrgId: string;
  reportFile: string;
};
export type ExecuteDeployUpdateResult = {
  qualification: 'unqualified';
  outcome: 'updated' | 'unchanged';
  target: { contentId: string; variantId: string };
  reportFile?: string;
  report?: WorkspaceImportRunReport;
};

function sha(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

/**
 * Reacquire full read-only UPDATE/unchanged eligibility, never a reusable write capability.
 * @param {UpdateConnection} connection - Explicit destination connection.
 * @param {object} input - Exact local definition and destination workspace/language.
 * @param {JsonRequestOptions} options - Read timeout/cancellation options.
 * @returns {Promise<object>} Detached local and destination snapshots for drift comparison.
 */
export async function preflightDeployUpdate(
  connection: UpdateConnection,
  input: Pick<ExecuteDeployUpdateInput, 'definitionFile' | 'workspaceId' | 'language'>,
  options: JsonRequestOptions = {},
) {
  input = structuredClone(input);
  options = { ...options };
  const load = async () => selectDeploySources({ 'definition-file': [input.definitionFile] });
  const source = await load();
  const prepared = await prepareDeployDestination(
    connection,
    { selection: source, workspaceId: input.workspaceId, language: input.language },
    options,
  );
  const item = prepared.items[0];
  if (
    prepared.blockedReasons.length > 0 ||
    !item?.existing ||
    item.blockedReasons.length > 0 ||
    !['update', 'unchanged'].includes(item.proposed)
  )
    throw new TypeError(
      'UPDATE blocked: ' + [...prepared.blockedReasons, ...(item?.blockedReasons ?? [])].join('; '),
    );
  const target = { contentId: item.existing.contentId, variantId: item.existing.variantId };
  const workspace = await getWorkspace(connection, input.workspaceId, options);
  const parent = await getContent(connection, target.contentId, {}, options);
  const detail = await getVariant(connection, target.variantId, options);
  // Preparation already binds all native siblings, the parent, and decoded content. These
  // original envelopes additionally retain version and root metadata for prewrite drift.
  if (
    workspace.id !== input.workspaceId ||
    (parent.managedContentId ?? parent.id) !== target.contentId ||
    detail.apiName !== item.source.targetIdentity.apiName ||
    detail.language !== input.language ||
    detail.title !== item.existing.title ||
    detail.urlName !== item.existing.urlName ||
    (detail.contentSpace as Record<string, unknown> | undefined)?.id !== input.workspaceId ||
    (parent.contentSpace as Record<string, unknown> | undefined)?.id !== input.workspaceId ||
    typeof detail.contentKey !== 'string' ||
    detail.contentKey.length === 0 ||
    ![detail, parent].every((record) => {
      const type = record.contentType as Record<string, unknown> | string | undefined;
      const folder = record.folder as Record<string, unknown> | null | undefined;
      return (
        (typeof type === 'object' ? type?.fullyQualifiedName : type) ===
          item.source.targetIdentity.contentType &&
        (folder === null ||
          (typeof workspace.rootFolderId === 'string' && folder?.id === workspace.rootFolderId))
      );
    }) ||
    (parent.managedContentVersionId !== undefined &&
      parent.managedContentVersionId !== detail.managedContentVersionId) ||
    !['contentBody', 'contentKey', 'apiName', 'title', 'urlName', 'language'].every(
      (key) => !(key in parent) || isDeepStrictEqual(parent[key], detail[key]),
    ) ||
    !isDeepStrictEqual(
      {
        ...(detail.contentBody as object),
        rawHtml: decodeNativeHtml(
          (detail.contentBody as Record<string, unknown>).rawHtml as string,
        ),
      },
      item.existing.contentBody,
    ) ||
    (detail.managedContentId ?? detail.contentId) !== target.contentId ||
    (detail.managedContentVariantId ?? detail.id) !== target.variantId ||
    detail.isPublished !== false ||
    (detail.status as Record<string, unknown> | undefined)?.status !== 'Draft' ||
    !isDeepStrictEqual(await load(), source)
  )
    throw new TypeError('UPDATE local or destination snapshot drifted');
  return { source, prepared, item, target, workspace, parent, detail };
}

/**
 * Execute one internal portable rawHtml UPDATE, or truthfully return unchanged without mutation.
 * Neither this internal experiment nor its observations authorize public/batch apply.
 * @param {UpdateConnection} connection - Explicit destination connection.
 * @param {ExecuteDeployUpdateInput} input - Local files, exact destination and exclusive journal.
 * @param {JsonRequestOptions} options - Timeout/cancellation options only.
 * @param {WorkspaceImportReportPersistence} persistence - Internal journal failure-injection seam.
 * @param {Function} beforeExecute - Internal batch boundary check; cannot replace executor proof.
 * @returns {Promise<ExecuteDeployUpdateResult>} Unqualified outcome and destination identities.
 */
export async function executeDeployUpdate(
  connection: UpdateConnection,
  input: ExecuteDeployUpdateInput,
  options: JsonRequestOptions = {},
  persistence?: WorkspaceImportReportPersistence,
  beforeExecute?: () => Promise<void>,
): Promise<ExecuteDeployUpdateResult> {
  const selected = structuredClone(input);
  const requestOptions = { ...options };
  if (!/^00D[A-Za-z0-9]{12}[A-Z0-5]{3}$/u.test(selected.destinationOrgId))
    throw new TypeError('UPDATE requires exact destination org ID');
  const baseline = await preflightDeployUpdate(connection, selected, requestOptions);
  const payload: UpdateVariantInput = {
    apiName: baseline.item.source.targetIdentity.apiName,
    contentBody: baseline.item.desired.contentBody,
    ...(baseline.item.existing!.title === undefined
      ? {}
      : { title: baseline.item.existing!.title }),
    ...(baseline.item.existing!.urlName === undefined
      ? {}
      : { urlName: baseline.item.existing!.urlName }),
  };
  if (baseline.item.proposed === 'unchanged') {
    const fresh = await preflightDeployUpdate(connection, selected, requestOptions);
    if (!isDeepStrictEqual(fresh, baseline)) throw new TypeError('Unchanged destination drifted');
    await beforeExecute?.();
    return { qualification: 'unqualified', outcome: 'unchanged', target: baseline.target };
  }
  const reportFile = path.resolve(selected.reportFile);
  const report: WorkspaceImportRunReport = {
    createdParents: [],
    destinationOrgId: selected.destinationOrgId,
    destinationWorkspaceId: selected.workspaceId,
    operations: [],
    runId: randomUUID(),
    sourceDirectory: path.dirname(baseline.item.source.definitionPath),
    sourceManifestSha256: sha(baseline.source),
    state: 'applying',
  };
  const operation = {
    ...pendingOperation(
      report,
      'update-variant',
      String(baseline.detail.contentKey),
      selected.language,
      payload,
    ),
    target: baseline.target,
    baselineSha256: sha(baseline),
  };
  report.operations.push(operation);
  await writeExclusive(reportFile, report);
  const rewrite = persistence?.rewrite ?? rewriteAtomic;
  let mutationStarted = false;
  try {
    await rewrite(reportFile, report);
    const fresh = await preflightDeployUpdate(connection, selected, requestOptions);
    if (!isDeepStrictEqual(fresh, baseline))
      throw new TypeError('UPDATE prewrite snapshot drifted');
    await beforeExecute?.();
    if (!isDeepStrictEqual(JSON.parse(await readFile(reportFile, 'utf8')), report))
      throw new TypeError('UPDATE durable intent changed before write');
    if (requestOptions.signal?.aborted) throw new TypeError('UPDATE cancelled before write');
    mutationStarted = true;
    const returned = await updateVariant(
      connection,
      baseline.target.variantId,
      payload,
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
        await persistOperationResult(reportFile, report, operation, rewrite);
      },
    );
    if (
      returned.managedContentId !== baseline.target.contentId ||
      returned.managedContentVariantId !== baseline.target.variantId ||
      returned.language !== selected.language ||
      returned.isPublished !== false
    )
      throw new TypeError('UPDATE returned identity/lifecycle mismatch');
    // Independent full native/detail/parent/sibling reacquisition, not the PUT response.
    const post = await preflightDeployUpdate(connection, selected, requestOptions);
    // Fixed labels only: never include remote envelopes, content, or identifier values.
    const failedChecks = [
      ...(post.item.proposed === 'unchanged' ? [] : ['content-unchanged']),
      ...(isDeepStrictEqual(post.source, baseline.source) ? [] : ['source-equal']),
      ...(isDeepStrictEqual(post.target, baseline.target) ? [] : ['target-equal']),
      ...(isDeepStrictEqual(post.workspace, baseline.workspace) ? [] : ['workspace-equal']),
      ...(post.prepared.apiVersion === baseline.prepared.apiVersion ? [] : ['api-version-equal']),
      ...(post.detail.contentKey === baseline.detail.contentKey ? [] : ['content-key-equal']),
      ...(isDeepStrictEqual(post.detail.folder, baseline.detail.folder)
        ? []
        : ['detail-folder-equal']),
      ...(isDeepStrictEqual(post.parent.folder, baseline.parent.folder)
        ? []
        : ['parent-folder-equal']),
      ...(baseline.detail.managedContentVersionId !== undefined &&
      (typeof post.detail.managedContentVersionId !== 'string' ||
        post.detail.managedContentVersionId.length === 0)
        ? ['version-present']
        : []),
    ];
    if (failedChecks.length > 0)
      throw new TypeError(
        'UPDATE independent readback identity/content/version mismatch; failed checks: ' +
          failedChecks.join(', '),
      );
    operation.state = 'succeeded';
    report.state = 'completed';
    await rewrite(reportFile, report);
    return {
      qualification: 'unqualified',
      outcome: 'updated',
      target: baseline.target,
      reportFile,
      report,
    };
  } catch (error) {
    operation.state = mutationStarted ? 'pending' : 'failed';
    report.state = mutationStarted ? 'ownership-uncertain' : 'failed';
    operation.error = redactSecrets(error instanceof Error ? error.message : String(error));
    try {
      await rewrite(reportFile, report);
    } catch {
      // Exclusive pending intent remains the reconciliation authority; never replay.
    }
    throw error;
  }
}
