import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import {
  assertContentLifecycleBatchResult,
  type LifecycleBinding,
  type LifecycleOperation,
} from '../contracts/content-lifecycle-batch.js';
import { rewriteAtomic } from './import-workspace.js';
import type { PreparedLifecycleMetadataBatch } from './lifecycle-batch.js';
import { allocateMutationReportDirectory } from './mutation-report-directory.js';

export type LifecycleBatchReportTarget = {
  readonly index: number;
  readonly binding: LifecycleBinding;
  readonly reportFile: string;
};
export type LifecycleBatchReport = {
  readonly runId: string;
  readonly operation: LifecycleOperation;
  readonly reportFile: string;
  readonly targets: readonly LifecycleBatchReportTarget[];
};

/**
 * Claim one fresh batch directory and durably bind every target before execution.
 * Target pending/completion records remain exclusively owned by execution seams.
 * A failed manifest write leaves the claimed directory untouched and rejects.
 * @param {PreparedLifecycleMetadataBatch} prepared - Successful whole-selection preflight.
 * @param {string} directory - Explicit fresh report destination.
 * @param {typeof rewriteAtomic} [rewriteReport] - Atomic persistence seam.
 * @returns {Promise<LifecycleBatchReport>} Detached ordered target paths and aggregate identity.
 */
export async function allocateLifecycleBatchReport(
  prepared: PreparedLifecycleMetadataBatch,
  directory: string,
  rewriteReport: typeof rewriteAtomic = rewriteAtomic,
): Promise<LifecycleBatchReport> {
  assertContentLifecycleBatchResult(prepared.result, undefined, prepared.status);
  if (prepared.status !== 'success' || prepared.result.mode !== 'dry-run')
    throw new TypeError('Batch reporting requires successful whole-selection preflight');
  const operation = prepared.result.operation;
  if (prepared.preparations.length !== prepared.result.items.length)
    throw new TypeError('Batch reporting requires every ordered preparation');
  // Capture all caller-owned bindings before asynchronous directory allocation.
  const bindings = prepared.preparations.map((item, index) => {
    if (item === undefined || item.index !== index || item.operation !== operation)
      throw new TypeError('Batch reporting requires matching ordered preparations');
    const { org, apiVersion, baselineHash, ...target } = item.binding;
    if (
      !isDeepStrictEqual(target, prepared.result.items[index].target) ||
      typeof org !== 'string' ||
      org.length === 0 ||
      typeof apiVersion !== 'string' ||
      apiVersion.length === 0 ||
      Object.entries(item.binding).some(
        ([key, value]) =>
          item.prepared.evidence[key as keyof typeof item.prepared.evidence] !== value,
      ) ||
      !/^[\da-f]{64}$/u.test(baselineHash)
    )
      throw new TypeError('Batch reporting binding disagrees with preflight');
    return structuredClone(item.binding);
  });
  const allocated = await allocateMutationReportDirectory(false, directory, process.cwd());
  if (allocated === undefined) throw new TypeError('Batch report directory is required');
  const report: LifecycleBatchReport = {
    runId: randomUUID(),
    operation,
    reportFile: path.join(allocated, `content-${operation}-batch-run.json`),
    targets: bindings.map((binding, index) => ({
      index,
      binding,
      reportFile: path.join(allocated, `target-${String(index + 1).padStart(6, '0')}.json`),
    })),
  };
  await rewriteReport(report.reportFile, {
    contract: `sf-cms-content-${operation}-batch-run`,
    contractVersion: '2.0.0',
    ...structuredClone(report),
    state: 'pending',
    completedPrefix: 0,
  });
  return report;
}
