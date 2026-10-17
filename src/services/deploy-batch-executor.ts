import type { Connection } from '@salesforce/core';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { JsonRequestOptions } from '../transport/json-request.js';
import { redactSecrets } from '../transport/redact-secrets.js';
import { preflightDeployBatch, type DeployBatchPreflightInput } from './deploy-batch-preflight.js';
import { executeDeployCreate } from './deploy-create-executor.js';
import { executeDeployImage } from './deploy-image-executor.js';
import { preflightDeployImageCreate } from './deploy-image-create-preflight.js';
import { preflightDeployImageUpdate } from './deploy-image-update-preflight.js';
import { admitDeployImageUnchanged } from './deploy-image-unchanged.js';
import { enumerateNativeWorkspace, type NativeInventoryRow } from './retrieve-native-inventory.js';
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
 * Capability acceptance remains unqualified; no retry, resume, rollback or publication.
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
  const verifiedCreatedRows: NativeInventoryRow[] = [];
  const reselect = () => selectDeploySources(selected.sources);
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
        expectedRootFolderId: baseline.rootFolderId,
      };
      const boundary = async () => {
        if (requestOptions.signal?.aborted) throw new TypeError('Batch cancelled before execution');
        if (!isDeepStrictEqual(await reselect(), baseline.selection))
          throw new TypeError('Batch selection changed before execution');
        if (
          JSON.stringify(JSON.parse(await readFile(reportFile, 'utf8'))) !== JSON.stringify(report)
        )
          throw new TypeError('Batch durable intent changed before execution');
        const proof = baseline.items[index];
        if (item.source.definition.contract === 'sf-cms-media-source') {
          if (item.proposed === 'create') {
            const fresh = await preflightDeployImageCreate(connection, scope, requestOptions);
            if (!isDeepStrictEqual(fresh, proof.imageCreate))
              throw new TypeError('Batch Image CREATE intent changed');
          } else if (item.proposed === 'update') {
            const fresh = await preflightDeployImageUpdate(connection, scope, requestOptions);
            for (const row of verifiedCreatedRows) {
              if (
                !isDeepStrictEqual(
                  fresh.destination.inventory.records.find((candidate) => candidate.Id === row.Id),
                  row,
                )
              )
                throw new TypeError('Earlier verified CREATE inventory changed');
            }
            const normalized = {
              ...fresh,
              destination: { ...fresh.destination, inventory: { ...fresh.destination.inventory } },
            };
            normalized.destination.inventory.records =
              normalized.destination.inventory.records.filter(
                (row) => !verifiedCreatedRows.some((created) => created.Id === row.Id),
              );
            // Page request counts can grow at pagination boundaries; complete records remain bound.
            if (proof.imageUpdate)
              normalized.destination.inventory.pagesRequested =
                proof.imageUpdate.destination.inventory.pagesRequested;
            if (!isDeepStrictEqual(normalized, proof.imageUpdate))
              throw new TypeError('Batch Image UPDATE intent changed');
          } else {
            const fresh = await admitDeployImageUnchanged(connection, scope, requestOptions);
            if (!isDeepStrictEqual(fresh, proof.imageUnchanged))
              throw new TypeError('Batch Image unchanged intent changed');
          }
        } else {
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
        }
        if (!isDeepStrictEqual(await reselect(), baseline.selection))
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
      if (item.source.definition.contract === 'sf-cms-media-source') {
        if (item.proposed === 'blocked') throw new TypeError('Blocked Image operation');
        const result = await executeDeployImage(
          connection,
          { ...itemInput, operation: item.proposed },
          requestOptions,
          persistence?.item,
          boundary,
        );
        if ('report' in result) {
          if (result.report.state !== 'completed') throw new TypeError('Image journal incomplete');
          if (item.proposed === 'create') {
            const created = result.report.createdParents[0];
            item.target = { contentId: created.contentId, variantId: created.primaryVariantId };
            item.outcome = 'created';
          } else {
            const updated = result.report.operations[0].result!;
            item.target = { contentId: updated.contentId!, variantId: updated.variantId! };
            item.outcome = 'updated';
          }
        } else {
          await boundary();
          item.target = { contentId: result.contentId, variantId: result.variantId };
          item.outcome = 'unchanged';
        }
      } else if (item.proposed === 'create') {
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
      if (item.outcome === 'created') {
        const inventory = await enumerateNativeWorkspace(
          connection,
          selected.workspaceId,
          requestOptions,
        );
        const row = inventory.records.find((candidate) => candidate.Id === item.target!.variantId);
        if (
          !row ||
          row.ManagedContentId !== item.target!.contentId ||
          row.ManagedContent.ApiName !== item.source.targetIdentity.apiName
        )
          throw new TypeError('Verified CREATE inventory binding missing');
        verifiedCreatedRows.push(structuredClone(row));
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
      active.outcome = active.proposed === 'unchanged' ? 'failed' : 'uncertain';
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
