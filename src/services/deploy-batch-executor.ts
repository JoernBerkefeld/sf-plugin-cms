import type { Connection } from '@salesforce/core';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { JsonRequestOptions } from '../transport/json-request.js';
import { redactSecrets } from '../transport/redact-secrets.js';
import { preflightDeployBatch, type DeployBatchPreflightInput } from './deploy-batch-preflight.js';
import { executeDeployCreate } from './deploy-create-executor.js';
import { preflightDeployCreate } from './deploy-create-preflight.js';
import { executeDeployUpdate, preflightDeployUpdate } from './deploy-update-executor.js';
import { selectDeploySources, type DeployLocalSelection } from './deploy-source-selection.js';
import {
  rewriteAtomic,
  writeExclusive,
  type WorkspaceImportReportPersistence,
  type WorkspaceImportRunReport,
} from './import-workspace.js';

export type ExecuteDeployBatchInput = DeployBatchPreflightInput & {
  destinationOrgId: string;
  /** Exclusive new batch journal, in an existing caller-owned directory. Never resumed. */
  reportFile: string;
};
export type DeployBatchReport = {
  qualification: 'unqualified';
  runId: string;
  destinationOrgId: string;
  workspaceId: string;
  language: string;
  selection: DeployLocalSelection;
  state: 'applying' | 'completed' | 'blocked' | 'partial';
  blockedReasons: string[];
  items: Array<{
    source: DeployLocalSelection['items'][number];
    proposed: 'create' | 'update' | 'unchanged' | 'blocked';
    reportFile: string;
    outcome: 'unattempted' | 'created' | 'updated' | 'unchanged' | 'failed' | 'uncertain';
    target?: { contentId: string; variantId: string };
    error?: string;
  }>;
  summary: {
    selected: number;
    created: number;
    updated: number;
    unchanged: number;
    completed: number;
    failed: number;
    uncertain: number;
    unattempted: number;
  };
};
export type DeployBatchPersistence = {
  rewrite: (file: string, report: DeployBatchReport) => Promise<void>;
  item?: WorkspaceImportReportPersistence;
};

/**
 * Execute a frozen whole-selection intent sequentially, stopping on the first failure.
 * Internal/unqualified only: no retry, resume, rollback, or public apply authority.
 * @param {Connection} connection - Explicit destination connection; UPDATE needs token/instance URL.
 * @param {ExecuteDeployBatchInput} input - Local selectors, exact destination and exclusive batch journal.
 * @param {JsonRequestOptions} options - Timeout/cancellation options only.
 * @param {DeployBatchPersistence} persistence - Internal persistence failure-injection seam.
 * @returns {Promise<object>} Unqualified report; item journals remain reconciliation authority.
 */
export async function executeDeployBatch(
  connection: Pick<Connection, 'request' | 'getApiVersion'>,
  input: ExecuteDeployBatchInput,
  options: JsonRequestOptions = {},
  persistence?: DeployBatchPersistence,
): Promise<{ qualification: 'unqualified'; reportFile: string; report: DeployBatchReport }> {
  const selected = structuredClone(input);
  const requestOptions = { ...options };
  if (!/^00D[A-Za-z0-9]{12}[A-Z0-5]{3}$/u.test(selected.destinationOrgId))
    throw new TypeError('Batch requires exact destination org ID');
  // Never accept a caller's eligibility, payload, or operation-specific proof.
  const baseline = await preflightDeployBatch(connection, selected, requestOptions);
  const reportFile = path.resolve(selected.reportFile);
  const runId = randomUUID();
  const report: DeployBatchReport = {
    qualification: 'unqualified',
    runId,
    destinationOrgId: selected.destinationOrgId,
    workspaceId: selected.workspaceId,
    language: selected.language,
    selection: baseline.selection,
    state: baseline.eligible ? 'applying' : 'blocked',
    blockedReasons: [
      ...baseline.blockedReasons,
      ...baseline.items.flatMap((item) => item.blockedReasons),
    ],
    items: baseline.items.map((item, index) => ({
      source: baseline.selection.items[index],
      proposed: item.proposed,
      reportFile: `${reportFile}.${runId}.${index + 1}.json`,
      outcome: 'unattempted',
    })),
    summary: {
      selected: baseline.items.length,
      created: 0,
      updated: 0,
      unchanged: 0,
      completed: 0,
      failed: 0,
      uncertain: 0,
      unattempted: baseline.items.length,
    },
  };
  await writeExclusive(reportFile, report);
  const rewrite = persistence?.rewrite ?? rewriteAtomic;
  const recount = () => {
    for (const outcome of [
      'created',
      'updated',
      'unchanged',
      'failed',
      'uncertain',
      'unattempted',
    ] as const)
      report.summary[outcome] = report.items.filter((item) => item.outcome === outcome).length;
    report.summary.completed =
      report.summary.created + report.summary.updated + report.summary.unchanged;
  };
  let active: DeployBatchReport['items'][number] | undefined;
  try {
    if (!baseline.eligible) return { qualification: 'unqualified', reportFile, report };
    await rewrite(reportFile, report);
    for (const [index, item] of report.items.entries()) {
      active = undefined;
      const scope = {
        definitionFile: item.source.definitionPath,
        workspaceId: selected.workspaceId,
        language: selected.language,
      };
      const boundary = async () => {
        if (requestOptions.signal?.aborted) throw new TypeError('Batch cancelled before execution');
        if (!isDeepStrictEqual(await selectDeploySources(selected.sources), baseline.selection))
          throw new TypeError('Batch selection changed before execution');
        if (
          JSON.stringify(JSON.parse(await readFile(reportFile, 'utf8'))) !== JSON.stringify(report)
        )
          throw new TypeError('Batch durable intent changed before execution');
        const proof = baseline.items[index];
        const fresh =
          item.proposed === 'create'
            ? await preflightDeployCreate(connection, scope, requestOptions)
            : await preflightDeployUpdate(connection, scope, requestOptions);
        // Earlier verified CREATEs legitimately change the workspace-wide record count,
        // not this item's parent/detail/sibling/workspace binding.
        const comparable = (value: typeof fresh) => {
          if ('prepared' in value)
            return { ...value, prepared: { ...value.prepared, inventory: undefined } };
          return value;
        };
        if (!isDeepStrictEqual(comparable(fresh), comparable((proof.create ?? proof.update)!)))
          throw new TypeError('Batch operation intent changed before execution');
        if (!isDeepStrictEqual(await selectDeploySources(selected.sources), baseline.selection))
          throw new TypeError('Batch selection changed at execution boundary');
        if (requestOptions.signal?.aborted)
          throw new TypeError('Batch cancelled at execution boundary');
        if (
          JSON.stringify(JSON.parse(await readFile(reportFile, 'utf8'))) !== JSON.stringify(report)
        )
          throw new TypeError('Batch durable intent changed at execution boundary');
      };
      await boundary();
      active = item;
      const itemInput = {
        ...scope,
        destinationOrgId: selected.destinationOrgId,
        reportFile: item.reportFile,
      };
      if (item.proposed === 'create') {
        const result = await executeDeployCreate(
          connection,
          itemInput,
          requestOptions,
          persistence?.item,
          boundary,
        );
        const created = result.report.createdParents[0];
        item.target = { contentId: created.contentId, variantId: created.primaryVariantId };
        item.outcome = 'created';
      } else {
        const result = await executeDeployUpdate(
          connection,
          itemInput,
          requestOptions,
          persistence?.item,
          boundary,
        );
        item.target = result.target;
        item.outcome = result.outcome;
      }
      // Mark verified outcomes before summary persistence: failures must not erase the prefix.
      active = undefined;
      recount();
      await rewrite(reportFile, report);
    }
    report.state = 'completed';
    await rewrite(reportFile, report);
  } catch (error) {
    const message = redactSecrets(
      error instanceof Error ? error.message : 'Batch execution failed',
    );
    report.blockedReasons.push(message);
    if (active) {
      active.error = message;
      // Missing/unreadable/pending journals cannot establish that no mutation occurred.
      active.outcome = 'uncertain';
      try {
        const journal = JSON.parse(
          await readFile(active.reportFile, 'utf8'),
        ) as WorkspaceImportRunReport;
        if (
          journal.runId &&
          journal.state === 'failed' &&
          journal.operations.every((operation) => operation.state === 'failed')
        )
          active.outcome = 'failed';
      } catch {
        // Preserve uncertainty and the exact exclusive item path for manual reconciliation.
      }
    }
    recount();
    report.state = report.summary.completed > 0 ? 'partial' : 'blocked';
    try {
      await rewrite(reportFile, report);
    } catch {
      report.blockedReasons.push(
        'Batch summary persistence failed; inspect per-item journals before any new run',
      );
    }
  }
  return { qualification: 'unqualified', reportFile, report };
}
