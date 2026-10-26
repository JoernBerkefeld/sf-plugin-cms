import type { Connection } from '@salesforce/core';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { JsonRequestOptions } from '../transport/json-request.js';
import { redactSecrets } from '../transport/redact-secrets.js';
import {
  prepareEmailFragmentCreate,
  type EmailFragmentCreatePreparation,
} from './deploy-email-fragment-create-preflight.js';
import {
  pendingOperation,
  persistOperationResult,
  rewriteAtomic,
  validateParentResponse,
  writeExclusive,
  type WorkspaceImportReportPersistence,
  type WorkspaceImportRunReport,
} from './import-workspace.js';
import { acquireEditableEmailFragmentSource } from './retrieve-item-source.js';
import { resolveEmailFragmentDeployDestination } from './deploy-email-fragment-destination.js';
import { createContent } from './write.js';
import { loadEditableEmailFragmentSource } from './editable-item-source.js';

type FragmentConnection = Pick<Connection, 'request' | 'getApiVersion' | 'getAuthInfoFields'>;
export type ExecuteEmailFragmentCreateInput = {
  definitionFile: string;
  workspaceId: string;
  /** Optional exclusive new journal in an existing caller-owned directory. Never resumed. */
  reportFile?: string;
};
export type EmailFragmentCreateResult = {
  qualification: 'unqualified';
  outcome: 'created' | 'unchanged';
  evidence: { contentId: string; variantId: string };
  report?: WorkspaceImportRunReport;
  reportFile?: string;
};

/**
 * Execute an internal root Fragment CREATE or independently proven zero-write unchanged result.
 * No caller-supplied preparation grants mutation authority; errors never replay the POST.
 * @param {FragmentConnection} connection - Exact destination org and selected API transport.
 * @param {ExecuteEmailFragmentCreateInput} input - Standalone definition, destination and new journal.
 * @param {JsonRequestOptions} options - Bounded timeout and cancellation options.
 * @param {WorkspaceImportReportPersistence} persistence - Existing journal persistence seam.
 * @param {Function} onReport - Assignment-only live reconciliation evidence handoff.
 * @returns {Promise<EmailFragmentCreateResult>} Unqualified independent readback evidence.
 */
export async function executeEmailFragmentCreate(
  connection: FragmentConnection,
  input: ExecuteEmailFragmentCreateInput,
  options: JsonRequestOptions = {},
  persistence?: WorkspaceImportReportPersistence,
  onReport?: (report: WorkspaceImportRunReport) => void,
): Promise<EmailFragmentCreateResult> {
  const selected = structuredClone(input);
  const requestOptions = { ...options };
  const preflight = await prepareEmailFragmentCreate(connection, selected, requestOptions);
  const assertBinding = (fresh: EmailFragmentCreatePreparation): void => {
    if (
      !isDeepStrictEqual(fresh, preflight) ||
      connection.getAuthInfoFields().orgId !== preflight.orgId ||
      connection.getApiVersion() !== preflight.apiVersion ||
      requestOptions.signal?.aborted
    )
      throw new TypeError('Fragment source, destination or provider binding drifted before write');
  };
  if (preflight.proposed === 'unchanged') {
    assertBinding(await prepareEmailFragmentCreate(connection, selected, requestOptions));
    return {
      qualification: 'unqualified',
      outcome: 'unchanged',
      evidence: structuredClone(preflight.destination.existing!.evidence),
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
    sourceManifestSha256: createHash('sha256')
      .update(JSON.stringify(preflight.destination.source))
      .digest('hex'),
    state: 'applying',
  };
  const operation = pendingOperation(
    report,
    'create-parent',
    preflight.payload.apiName!,
    preflight.destination.workspace.defaultLanguage,
    preflight.payload,
  );
  report.operations.push(operation);
  // Callers receive reconciliation evidence before durable intent or remote dispatch.
  onReport?.(report);
  if (reportFile !== undefined) await writeExclusive(reportFile, report);
  const rewrite = persistence?.rewrite ?? rewriteAtomic;
  let dispatched = false;
  try {
    if (reportFile !== undefined) await rewrite(reportFile, report);
    assertBinding(await prepareEmailFragmentCreate(connection, selected, requestOptions));
    if (
      reportFile !== undefined &&
      !isDeepStrictEqual(JSON.parse(await readFile(reportFile, 'utf8')), report)
    )
      throw new TypeError('Fragment durable intent changed before write');
    if (
      !isDeepStrictEqual(
        await loadEditableEmailFragmentSource(selected.definitionFile),
        preflight.destination.source,
      ) ||
      connection.getAuthInfoFields().orgId !== preflight.orgId ||
      connection.getApiVersion() !== preflight.apiVersion ||
      requestOptions.signal?.aborted
    )
      throw new TypeError('Fragment source or connection changed at mutation boundary');
    const receiver = Object.create(connection) as FragmentConnection;
    Object.defineProperty(receiver, '_refreshDelegate', { value: undefined });
    dispatched = true;
    const response = await createContent(
      receiver,
      structuredClone(preflight.payload),
      requestOptions,
    );
    operation.result = {
      contentId: [response.managedContentId, response.contentId, response.id].find(
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
    const created = validateParentResponse(response, operation.result.contentKey ?? '');
    if (
      !/^20Y[A-Za-z0-9]{12}[A-Z0-5]{3}$/u.test(created.contentId) ||
      !/^9Ps[A-Za-z0-9]{12}[A-Z0-5]{3}$/u.test(created.primaryVariantId)
    )
      throw new TypeError('Fragment CREATE returned invalid native identities');
    // Never accept the POST echo as proof. Acquisition independently reads parent,
    // variant and complete actual siblings, retaining full authored body/defaults.
    const acquired = await acquireEditableEmailFragmentSource(
      connection,
      {
        workspaceId: selected.workspaceId,
        apiName: preflight.payload.apiName!,
        language: preflight.destination.workspace.defaultLanguage,
      },
      requestOptions,
    );
    const destination = await resolveEmailFragmentDeployDestination(
      connection,
      selected,
      requestOptions,
    );
    const expected = {
      ...preflight.destination.source.definition,
      identity: {
        ...preflight.destination.source.definition.identity,
        context: { workspaceApiName: preflight.destination.workspace.apiName },
      },
    };
    const related = destination.inventory.records.filter(
      (row) =>
        row.ManagedContentId === created.contentId ||
        row.ManagedContentKey === created.contentKey ||
        row.ManagedContent.ApiName === preflight.payload.apiName ||
        row.Name === preflight.payload.title ||
        row.UrlName === preflight.payload.urlName,
    );
    const row = related[0];
    if (
      connection.getAuthInfoFields().orgId !== preflight.orgId ||
      connection.getApiVersion() !== preflight.apiVersion ||
      !isDeepStrictEqual(destination.workspace, preflight.destination.workspace) ||
      !isDeepStrictEqual(destination.source, preflight.destination.source) ||
      !isDeepStrictEqual(acquired.projection.definition, expected) ||
      !isDeepStrictEqual(destination.existing, acquired) ||
      acquired.evidence.contentId !== created.contentId ||
      acquired.evidence.variantId !== created.primaryVariantId ||
      related.length !== 1 ||
      row.ManagedContentKey !== created.contentKey ||
      row.ManagedContentId !== created.contentId ||
      row.Id !== created.primaryVariantId ||
      row.IsPublished !== false ||
      row.ManagedContentVariantStatus !== 'Draft' ||
      destination.inventory.records.some((candidate) => !candidate.ManagedContent.ApiName)
    )
      throw new TypeError('Fragment independent Draft readback mismatch');
    report.createdParents.push(created);
    operation.state = 'succeeded';
    report.state = 'completed';
    if (reportFile !== undefined) await rewrite(reportFile, report);
    return {
      qualification: 'unqualified',
      outcome: 'created',
      evidence: acquired.evidence,
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
      // Retain exclusive pending intent and in-memory returned IDs for reconciliation.
    }
    throw error;
  }
}
