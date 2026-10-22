import path from 'node:path';
import { notifyMutationOutcome, type MutationOutcomeObserver } from '../mutation-outcome.js';
import { isDeepStrictEqual } from 'node:util';
import { resolveWorkspace } from './resolve-workspace.js';
import {
  assertLifecycleLocalSynchronizationEligible,
  inspectLifecycleLocalSource,
  synchronizeLifecycleLocalSource,
  type LifecycleLocalSourceInspection,
} from './lifecycle-local-source.js';
import type { Connection } from '@salesforce/core';
import {
  assertContentLifecycleBatchResult,
  type ContentLifecycleBatchItem,
  type ContentLifecycleBatchResult,
  type ExactLifecycleSelector,
  type LifecycleBinding,
  type LifecycleContentType,
  type LifecycleInventoryEntry,
  type LifecycleOperation,
  type LifecycleTarget,
} from '../contracts/content-lifecycle-batch.js';
import type { CmsStatus } from '../contracts/shared.js';
import type { JsonRequestOptions } from '../transport/json-request.js';
import {
  prepareDraftEmailPublish,
  executePreparedDraftEmailPublish,
  EmailPublishOutcomeUnknownError,
  type PreparedEmailPublish,
  type EmailPublishCompletedEvidence,
} from './email-publish.js';
import {
  preparePublishedEmailUnpublish,
  executePreparedPublishedEmailUnpublish,
  EmailUnpublishOutcomeUnknownError,
  type PreparedEmailUnpublish,
  type EmailUnpublishCompletedEvidence,
} from './email-unpublish.js';
import { rewriteAtomic } from './import-workspace.js';
import { allocateLifecycleBatchReport } from './lifecycle-batch-report.js';
import type { ContentPublishResult } from '../contracts/content-publish.js';
import type { ContentUnpublishResult } from '../contracts/content-unpublish.js';
import { normalizeLifecycleMetadata } from './lifecycle-selection.js';

type RequestConnection = Pick<Connection, 'request'> &
  Partial<Pick<Connection, 'accessToken' | 'instanceUrl' | 'version'>>;
export type LifecycleMetadataBatchInput = {
  readonly operation: LifecycleOperation;
  readonly selectors: readonly ExactLifecycleSelector[];
  readonly workspaceId: string;
  readonly language?: string;
  readonly useDefaultLanguage?: true;
  readonly requestOptions?: JsonRequestOptions;
};
export type PreparedLifecycleBatchItem = {
  readonly index: number;
  readonly binding: LifecycleBinding;
} & (
  | { readonly operation: 'publish'; readonly prepared: PreparedEmailPublish }
  | { readonly operation: 'unpublish'; readonly prepared: PreparedEmailUnpublish }
);
export type LifecycleExpectedInventory = {
  readonly contentType: LifecycleContentType;
  readonly workspaceId: string;
  readonly org: string;
  readonly apiVersion: string;
  readonly expectedInventory: readonly LifecycleInventoryEntry[];
};
export type PreparedLifecycleMetadataBatch = {
  readonly status: Extract<CmsStatus, 'success' | 'blocked'>;
  readonly result: ContentLifecycleBatchResult;
  // Positional slots retain successful resolution even beyond a blocked stop.
  readonly preparations: readonly (PreparedLifecycleBatchItem | undefined)[];
  readonly inventories: readonly LifecycleExpectedInventory[];
};

/**
 * Resolve the whole selection without dispatching mutations or claiming reports.
 * The later runner must require success, persist intent, and use the prepared
 * execution seams with these bindings and a verified-transition-only ledger.
 * @param {RequestConnection} connection - Read-only preparation connection.
 * @param {LifecycleMetadataBatchInput} input - Ordered exact selection and language scope.
 * @returns {Promise<PreparedLifecycleMetadataBatch>} Validated dry-run and reusable preparations.
 */
export async function prepareLifecycleMetadataBatch(
  connection: RequestConnection,
  input: LifecycleMetadataBatchInput,
): Promise<PreparedLifecycleMetadataBatch> {
  if (input.operation !== 'publish' && input.operation !== 'unpublish')
    throw new TypeError('Lifecycle batch operation must be publish or unpublish');
  const operation = input.operation;
  const selectors = normalizeLifecycleMetadata(
    input.selectors.map((selector) => `${selector.contentType}:${selector.apiName}`),
  );
  // Capture caller-owned selection/options before any asynchronous reads.
  const scope = {
    workspaceId: input.workspaceId,
    language: input.language,
    useDefaultLanguage: input.useDefaultLanguage,
  };
  const requestOptions =
    input.requestOptions === undefined ? undefined : { ...input.requestOptions };
  const preparations: Array<PreparedLifecycleBatchItem | undefined> = [];
  const inventories: LifecycleExpectedInventory[] = [];
  const variants = new Set<string>();
  const parents = new Set<string>();
  const items: ContentLifecycleBatchItem[] = [];
  let stop: ContentLifecycleBatchResult['stop'];
  for (const [index, selector] of selectors.entries()) {
    let preparation: PreparedLifecycleBatchItem | undefined;
    let target: LifecycleTarget | undefined;
    try {
      // Exact five-family vocabulary is gated by each service's qualified preparation.
      const serviceInput = {
        selector: { ...scope, apiName: selector.apiName, contentType: selector.contentType },
        requestOptions,
      };
      const prepared =
        operation === 'publish'
          ? await prepareDraftEmailPublish(connection, serviceInput)
          : await preparePublishedEmailUnpublish(connection, serviceInput);
      const { evidence } = prepared;
      target = {
        ...selector,
        workspaceId: evidence.workspaceId,
        language: evidence.language,
        contentId: evidence.contentId,
        variantId: evidence.variantId,
      };
      const binding: LifecycleBinding = {
        ...target,
        org: evidence.org,
        apiVersion: evidence.apiVersion,
        baselineHash: evidence.baselineHash,
      };
      preparation =
        operation === 'publish'
          ? { index, operation, binding, prepared: prepared as PreparedEmailPublish }
          : { index, operation, binding, prepared: prepared as PreparedEmailUnpublish };
      const first = inventories[0];
      if (first && (first.org !== binding.org || first.apiVersion !== binding.apiVersion))
        throw new TypeError('Lifecycle selection org or API version changed');
      const baseline = inventories.find(
        (entry) =>
          entry.contentType === selector.contentType && entry.workspaceId === binding.workspaceId,
      );
      if (baseline && !isDeepStrictEqual(baseline.expectedInventory, prepared.inventoryBaseline))
        throw new TypeError('Lifecycle selection initial family inventory changed');
      if (!baseline)
        inventories.push({
          contentType: selector.contentType,
          workspaceId: binding.workspaceId,
          org: binding.org,
          apiVersion: binding.apiVersion,
          expectedInventory: structuredClone(prepared.inventoryBaseline),
        });
      const variant = JSON.stringify([binding.org, binding.workspaceId, binding.variantId]);
      const parent = JSON.stringify([binding.org, binding.workspaceId, binding.contentId]);
      if (operation === 'unpublish' && parents.has(parent))
        throw new TypeError('Duplicate resolved unpublish parent');
      if (variants.has(variant)) throw new TypeError('Duplicate resolved lifecycle variant');
      variants.add(variant);
      parents.add(parent);
      const singleTarget = {
        apiName: target.apiName,
        workspaceId: target.workspaceId,
        language: target.language,
        contentId: target.contentId,
        variantId: target.variantId,
      };
      const common = {
        baselineHash: evidence.baselineHash,
        ...(evidence.nativeEvidence === undefined
          ? {}
          : { nativeEvidence: evidence.nativeEvidence }),
        inventory: evidence.inventory,
        siblingInventory: evidence.siblingInventory,
      };
      const result =
        operation === 'publish'
          ? {
              mode: 'dry-run' as const,
              outcome: 'ready' as const,
              target: singleTarget,
              evidence: {
                ...common,
                selectorScope: 'variant' as const,
                includeContentReferences: false as const,
                noSendAcknowledgementRequired: true as const,
              },
              blockers: [] as const,
            }
          : {
              mode: 'dry-run' as const,
              outcome: 'ready' as const,
              target: singleTarget,
              evidence: {
                ...common,
                selectorScope: 'parent' as const,
                includeContentReferencesOmitted: true as const,
                activeUseStopsAcknowledgementRequired: true as const,
              },
              blockers: [] as const,
            };
      items.push(
        stop === undefined
          ? { index, selector, target, outcome: 'ready', blockers: [], result }
          : { index, selector, target, outcome: 'unattempted', blockers: [] },
      );
    } catch (error) {
      const resolved = target === undefined ? {} : { target };
      if (stop === undefined) {
        stop = { index, outcome: 'blocked' };
        items.push({
          index,
          selector,
          ...resolved,
          outcome: 'blocked',
          blockers: [
            {
              code: 'LIFECYCLE_BATCH_PREFLIGHT_BLOCKED',
              message: error instanceof Error ? error.message : 'Lifecycle preparation failed',
            },
          ],
        });
      } else items.push({ index, selector, ...resolved, outcome: 'unattempted', blockers: [] });
    }
    preparations.push(preparation);
  }
  const status = stop === undefined ? 'success' : 'blocked';
  const result: ContentLifecycleBatchResult = {
    selection: 'metadata',
    operation,
    mode: 'dry-run',
    outcome: stop === undefined ? 'ready' : 'blocked',
    items,
    ...(stop === undefined ? {} : { stop }),
  };
  assertContentLifecycleBatchResult(result, undefined, status);
  return { status, result, preparations, inventories };
}

/**
 * Run an ordered qualified five-family metadata selection without replay or rollback.
 * @param {RequestConnection} connection - Selected org/API connection.
 * @param {LifecycleMetadataBatchInput} input - Exact ordered selection.
 * @param {object} options - Execution mode and durable reporting destination.
 * @param {string} options.mode - Preview or execute the selection.
 * @param {string} [options.projectRoot] - Explicit portable-source root enabling local admission and sync.
 * @param {string} [options.reportDirectory] - Fresh apply report directory.
 * @param {typeof rewriteAtomic} [options.rewriteReport] - Atomic persistence seam.
 * @param {MutationOutcomeObserver} [options.onOutcome] - Best-effort settled item diagnostics.
 * @returns {Promise<object>} Validated batch result and envelope status.
 */
export async function runLifecycleMetadataBatch(
  connection: RequestConnection,
  input: LifecycleMetadataBatchInput,
  options: {
    mode: 'dry-run' | 'apply';
    projectRoot?: string;
    reportDirectory?: string;
    rewriteReport?: typeof rewriteAtomic;
    onOutcome?: MutationOutcomeObserver;
  },
): Promise<{ status: CmsStatus; result: ContentLifecycleBatchResult }> {
  const { mode, reportDirectory, rewriteReport = rewriteAtomic } = options;
  const observed = new Set<number>();
  const observe = (items: readonly ContentLifecycleBatchItem[]): void => {
    if (mode !== 'apply') return;
    for (const item of items) {
      if (observed.has(item.index)) continue;
      observed.add(item.index);
      const evidence = item.result?.evidence;
      const remoteState = item.outcome === 'ready' ? 'unattempted' : item.outcome;
      notifyMutationOutcome(options.onOutcome, {
        operation: input.operation,
        ordinal: item.index + 1,
        label: item.selector.apiName,
        language: item.target?.language,
        state:
          item.localSource?.outcome === 'blocked' ? 'remote-completed-local-blocked' : remoteState,
        target:
          item.target === undefined
            ? undefined
            : {
                workspaceId: item.target.workspaceId,
                contentId: item.target.contentId,
                variantId: item.target.variantId,
              },
        deploymentId: evidence && 'deploymentId' in evidence ? evidence.deploymentId : undefined,
        reportFile: item.reportFile,
        diagnostics:
          item.localSource?.outcome === 'blocked'
            ? [...item.blockers, { code: 'LOCAL_BLOCKED', message: item.localSource.message }]
            : item.blockers,
      });
    }
  };
  if (mode !== 'dry-run' && mode !== 'apply') throw new TypeError('Invalid lifecycle batch mode');
  const projectRoot =
    options.projectRoot === undefined ? undefined : path.resolve(options.projectRoot);
  const batch = await prepareLifecycleMetadataBatch(connection, input);
  const inspections: LifecycleLocalSourceInspection[] = [];
  if (projectRoot !== undefined && batch.status === 'success') {
    let index = 0;
    try {
      const workspace = await resolveWorkspace(
        connection,
        { workspaceId: batch.preparations[0]!.binding.workspaceId },
        batch.preparations[0]!.prepared.requestOptions,
      );
      const workspaceApiName = workspace.workspace.apiName;
      if (typeof workspaceApiName !== 'string' || !workspaceApiName.trim())
        throw new TypeError(
          'Workspace API name unavailable; local source identity cannot be proven',
        );
      for (const item of batch.preparations) {
        index = item!.index;
        inspections.push(
          await inspectLifecycleLocalSource(projectRoot, {
            workspaceApiName,
            contentType: item!.binding.contentType,
            apiName: item!.binding.apiName,
            language: item!.binding.language,
          }),
        );
      }
      // Inspect the entire selection before testing admission, before any report allocation.
      for (const [position, inspection] of inspections.entries()) {
        index = position;
        assertLifecycleLocalSynchronizationEligible(inspection);
      }
    } catch (error) {
      const items = batch.result.items.map((item, position) => {
        if (position < index) return item;
        if (position === index) return blockedBatchItem(item, error);
        return {
          index: item.index,
          selector: item.selector,
          target: item.target,
          outcome: 'unattempted' as const,
          blockers: [],
        };
      });
      const result: ContentLifecycleBatchResult = {
        ...batch.result,
        mode,
        outcome: 'blocked',
        items,
        stop: { index, outcome: 'blocked' },
      };
      assertContentLifecycleBatchResult(result, undefined, 'blocked');
      observe(result.items);
      return { status: 'blocked', result };
    }
  }
  if (mode === 'dry-run') return { status: batch.status, result: batch.result };
  if (batch.status !== 'success') {
    const result = { ...batch.result, mode };
    assertContentLifecycleBatchResult(result, undefined, batch.status);
    observe(result.items);
    return { status: batch.status, result };
  }
  const items: ContentLifecycleBatchItem[] = batch.result.items.map(
    ({ index, selector, target }) => ({
      index,
      selector,
      target,
      outcome: 'unattempted',
      blockers: [],
    }),
  );
  let report: Awaited<ReturnType<typeof allocateLifecycleBatchReport>>;
  try {
    if (!reportDirectory) throw new TypeError('Lifecycle batch report directory is required');
    report = await allocateLifecycleBatchReport(batch, reportDirectory, rewriteReport);
  } catch (error) {
    items[0] = blockedBatchItem(items[0], error);
    const result: ContentLifecycleBatchResult = {
      ...batch.result,
      mode,
      outcome: 'blocked',
      items,
      stop: { index: 0, outcome: 'blocked' },
    };
    assertContentLifecycleBatchResult(result, undefined, 'blocked');
    observe(result.items);
    return { status: 'blocked', result };
  }
  const ledgers = batch.inventories.map((entry) => ({
    ...entry,
    expectedInventory: structuredClone(entry.expectedInventory),
  }));
  let completedPrefix = 0;
  const aggregate = (result: ContentLifecycleBatchResult) => ({
    contract: `sf-cms-content-${report.operation}-batch-run`,
    contractVersion: '2.0.0',
    ...report,
    state: result.outcome,
    completedPrefix,
    result,
  });
  const finish = (stop?: ContentLifecycleBatchResult['stop']) => {
    let status: CmsStatus = 'success';
    let outcome: ContentLifecycleBatchResult['outcome'] = 'completed';
    if (stop !== undefined) {
      status = stop.outcome === 'blocked' ? 'blocked' : 'failed';
      outcome = stop.outcome === 'remote-completed-local-blocked' ? 'partial' : stop.outcome;
      if (completedPrefix > 0 || stop.outcome === 'remote-completed-local-blocked') {
        status = 'partial';
        outcome = 'partial';
      }
    }
    const result: ContentLifecycleBatchResult = {
      selection: 'metadata',
      operation: report.operation,
      mode,
      items: structuredClone(items),
      outcome,
      reportFile: report.reportFile,
      ...(stop === undefined ? {} : { stop }),
    };
    assertContentLifecycleBatchResult(result, undefined, status);
    return { status, result };
  };
  for (const entry of batch.preparations) {
    // Successful whole-selection preparation and allocator validation guarantee every slot.
    const item = entry!;
    const targetReport = report.targets[item.index];
    const ledger = ledgers.find(
      (value) =>
        value.contentType === item.binding.contentType &&
        value.workspaceId === item.binding.workspaceId &&
        value.org === item.binding.org &&
        value.apiVersion === item.binding.apiVersion,
    )!;
    let completed: EmailPublishCompletedEvidence | EmailUnpublishCompletedEvidence | undefined;
    try {
      const context = {
        binding: targetReport.binding,
        expectedInventory: ledger.expectedInventory,
        reportFile: targetReport.reportFile,
        rewriteReport,
      };
      completed =
        item.operation === 'publish'
          ? await executePreparedDraftEmailPublish(connection, item.prepared, context)
          : await executePreparedPublishedEmailUnpublish(connection, item.prepared, context);
      items[item.index] = completedBatchItem(
        items[item.index],
        item.operation,
        completed,
        targetReport.reportFile,
      );
      // Do not claim this target as completed until aggregate progress is durable too.
      if (projectRoot === undefined)
        await rewriteReport(report.reportFile, {
          contract: `sf-cms-content-${report.operation}-batch-run`,
          contractVersion: '2.0.0',
          ...report,
          state: item.index === items.length - 1 ? 'completed' : 'pending',
          completedPrefix: completedPrefix + 1,
          items: structuredClone(items),
        });
      completedPrefix += 1;
      ledger.expectedInventory = ledger.expectedInventory.map((value) =>
        value.variantId === item.binding.variantId
          ? {
              ...value,
              isPublished: item.operation === 'publish',
              status: item.operation === 'publish' ? 'Published' : 'Draft',
            }
          : value,
      );
    } catch (error) {
      const uncertain =
        completed !== undefined ||
        error instanceof EmailPublishOutcomeUnknownError ||
        error instanceof EmailUnpublishOutcomeUnknownError;
      items[item.index] = uncertain
        ? stoppedMutationBatchItem(
            items[item.index],
            item.operation,
            error,
            targetReport.reportFile,
            completed?.deploymentId,
          )
        : blockedBatchItem(items[item.index], error);
      const stopped = finish({
        index: item.index,
        outcome: items[item.index].outcome as
          'blocked' | 'ownership-uncertain' | 'rejected-before-mutation',
      });
      try {
        await rewriteReport(report.reportFile, aggregate(stopped.result));
      } catch {
        // Preserve the earlier durable manifest and target evidence; never redispatch.
      }
      observe(stopped.result.items);
      return stopped;
    }
    if (projectRoot !== undefined) {
      // The executor has independently confirmed and persisted the remote transition.
      // Nothing below may reclassify it as uncertain or redispatch it.
      const inspection = inspections[item.index];
      const local = await synchronizeLifecycleLocalSource(projectRoot, inspection, {
        outcome: item.operation === 'publish' ? 'published' : 'unpublished',
        identity: inspection.identity,
      });
      let localSource: NonNullable<ContentLifecycleBatchItem['localSource']> =
        local.outcome === 'blocked'
          ? { outcome: 'blocked', message: local.message ?? 'Local synchronization blocked' }
          : {
              outcome: 'noop',
              reason: local.reason === 'missing-copy' ? 'missing-copy' : 'retrieval-equivalent',
            };
      items[item.index] = { ...items[item.index], localSource };
      try {
        await rewriteReport(`${targetReport.reportFile}.local.json`, {
          contract: 'sf-cms-lifecycle-local-outcome',
          contractVersion: '1.0.0',
          binding: targetReport.binding,
          remoteOutcome: 'completed',
          localSource,
        });
        const current =
          localSource.outcome === 'blocked'
            ? finish({ index: item.index, outcome: 'remote-completed-local-blocked' })
            : undefined;
        await rewriteReport(
          report.reportFile,
          current
            ? aggregate(current.result)
            : {
                contract: `sf-cms-content-${report.operation}-batch-run`,
                contractVersion: '2.0.0',
                ...report,
                state: item.index === items.length - 1 ? 'completed' : 'pending',
                completedPrefix,
                items: structuredClone(items),
              },
        );
        if (current) {
          observe(current.result.items);
          return current;
        }
      } catch (error) {
        localSource = {
          outcome: 'blocked',
          message: `Remote completed; local outcome persistence failed: ${error instanceof Error ? error.message : 'unknown persistence failure'}`,
        };
        items[item.index] = { ...items[item.index], localSource };
        const stopped = finish({ index: item.index, outcome: 'remote-completed-local-blocked' });
        try {
          await rewriteReport(report.reportFile, aggregate(stopped.result));
        } catch {
          // Earlier executor completion remains durable; do not claim the failed local write succeeded.
        }
        observe(stopped.result.items);
        return stopped;
      }
    }
    observe([items[item.index]]);
  }
  return finish();
}

function blockedBatchItem(
  item: ContentLifecycleBatchItem,
  error: unknown,
): ContentLifecycleBatchItem {
  return {
    index: item.index,
    selector: item.selector,
    target: item.target,
    outcome: 'blocked',
    blockers: [
      {
        code: 'LIFECYCLE_BATCH_EXECUTION_BLOCKED',
        message: error instanceof Error ? error.message : 'Lifecycle execution blocked',
      },
    ],
  };
}
function completedBatchItem(
  item: ContentLifecycleBatchItem,
  operation: LifecycleOperation,
  evidence: EmailPublishCompletedEvidence | EmailUnpublishCompletedEvidence,
  reportFile: string,
): ContentLifecycleBatchItem {
  const { apiName, workspaceId, language, contentId, variantId } = item.target!;
  const target = { apiName, workspaceId, language, contentId, variantId };
  const common = {
    baselineHash: evidence.baselineHash,
    ...(evidence.nativeEvidence === undefined ? {} : { nativeEvidence: evidence.nativeEvidence }),
    deploymentId: evidence.deploymentId,
    inventory: evidence.inventory,
    siblingInventory: evidence.siblingInventory,
  };
  const result: ContentPublishResult | ContentUnpublishResult =
    operation === 'publish'
      ? {
          mode: 'apply',
          outcome: 'completed',
          target,
          blockers: [],
          reportFile,
          evidence: {
            ...common,
            selectorScope: 'variant',
            includeContentReferences: false,
            noSendAcknowledged: true,
            postPublishHash: (evidence as EmailPublishCompletedEvidence).postPublishHash,
            ...((evidence as EmailPublishCompletedEvidence).publishDate === undefined
              ? {}
              : { publishDate: (evidence as EmailPublishCompletedEvidence).publishDate }),
          },
        }
      : {
          mode: 'apply',
          outcome: 'completed',
          target,
          blockers: [],
          reportFile,
          evidence: {
            ...common,
            selectorScope: 'parent',
            includeContentReferencesOmitted: true,
            activeUseStopsAcknowledged: true,
            postUnpublishHash: (evidence as EmailUnpublishCompletedEvidence).postUnpublishHash,
            ...((evidence as EmailUnpublishCompletedEvidence).unpublishDate === undefined
              ? {}
              : { unpublishDate: (evidence as EmailUnpublishCompletedEvidence).unpublishDate }),
          },
        };
  return { ...item, outcome: 'completed', blockers: [], result, reportFile };
}
function stoppedMutationBatchItem(
  item: ContentLifecycleBatchItem,
  operation: LifecycleOperation,
  error: unknown,
  reportFile: string,
  completedDeploymentId?: string,
): ContentLifecycleBatchItem {
  const { apiName, workspaceId, language, contentId, variantId } = item.target!;
  const target = { apiName, workspaceId, language, contentId, variantId };
  const deploymentId =
    completedDeploymentId ??
    (error instanceof EmailPublishOutcomeUnknownError ||
    error instanceof EmailUnpublishOutcomeUnknownError
      ? error.deploymentId
      : undefined);
  const deployment = deploymentId === undefined ? {} : { deploymentId };
  const mutationError =
    error instanceof EmailUnpublishOutcomeUnknownError
      ? error.mutationError
      : { classification: 'ownership-uncertain' as const };
  const rejected =
    operation === 'unpublish' && mutationError.classification === 'definite-pre-mutation-rejection';
  const reconciliation = {
    workspaceId: target.workspaceId,
    contentId: target.contentId,
    variantId: target.variantId,
    ...deployment,
  };
  const message =
    error instanceof Error ? error.message : 'Lifecycle persistence failed after dispatch';
  const result: ContentPublishResult | ContentUnpublishResult =
    operation === 'publish'
      ? {
          mode: 'apply',
          outcome: 'ownership-uncertain',
          target,
          reportFile,
          reconciliation,
          evidence: { selectorScope: 'variant', includeContentReferences: false, ...deployment },
          blockers: [{ code: 'EMAIL_PUBLISH_OWNERSHIP_UNCERTAIN', message }],
        }
      : {
          mode: 'apply',
          outcome: rejected ? 'rejected-before-mutation' : 'ownership-uncertain',
          target,
          reportFile,
          reconciliation,
          evidence: {
            selectorScope: 'parent',
            includeContentReferencesOmitted: true,
            ...deployment,
            mutationError,
          },
          blockers: [
            {
              code: rejected
                ? 'EMAIL_UNPUBLISH_REJECTED_BEFORE_MUTATION'
                : 'EMAIL_UNPUBLISH_OWNERSHIP_UNCERTAIN',
              message,
            },
          ],
        };
  return {
    ...item,
    outcome: result.outcome,
    blockers: result.blockers,
    result,
    reportFile,
    reconciliation,
  };
}
