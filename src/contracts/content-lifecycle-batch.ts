import { assertContentPublishResult, type ContentPublishResult } from './content-publish.js';
import { assertContentUnpublishResult, type ContentUnpublishResult } from './content-unpublish.js';
import { assertExactKeys, assertNonemptyString, type CmsStatus } from './shared.js';

export type LifecycleOperation = 'publish' | 'unpublish';

export type LifecycleContentType =
  | 'sfdc_cms__email'
  | 'sfdc_cms__emailTemplate'
  | 'sfdc_cms__image'
  | 'sfdc_cms__document'
  | 'sfdc_cms__audio';

export type ExactLifecycleSelector = {
  contentType: LifecycleContentType;
  apiName: string;
};

export type LifecycleTarget = ExactLifecycleSelector & {
  workspaceId: string;
  language: string;
  contentId: string;
  variantId: string;
};

export type LifecycleInventoryEntry = {
  contentId: string;
  variantId: string;
  language: string;
  hash: string;
  isPublished: boolean;
  status: string;
};

export type LifecycleBinding = LifecycleTarget & {
  org: string;
  apiVersion: string;
  baselineHash: string;
};

export type LifecycleReconciliation = {
  workspaceId: string;
  contentId: string;
  variantId: string;
  deploymentId?: string;
};

export type LifecycleStopOutcome = 'blocked' | 'rejected-before-mutation' | 'ownership-uncertain';
export type LifecycleLocalOutcome =
  | { outcome: 'noop'; reason: 'missing-copy' | 'retrieval-equivalent' }
  | { outcome: 'blocked'; message: string };
export type LifecycleBatchStopOutcome = LifecycleStopOutcome | 'remote-completed-local-blocked';

export type ContentLifecycleBatchItem = {
  index: number;
  selector: ExactLifecycleSelector;
  target?: LifecycleTarget;
  outcome: 'ready' | 'completed' | LifecycleStopOutcome | 'unattempted';
  blockers: readonly { code: string; message: string }[];
  result?: ContentPublishResult | ContentUnpublishResult;
  reportFile?: string;
  reconciliation?: LifecycleReconciliation;
  localSource?: LifecycleLocalOutcome;
};

export type ContentLifecycleBatchResult = {
  selection: 'metadata';
  operation: LifecycleOperation;
  mode: 'dry-run' | 'apply';
  outcome: 'ready' | 'completed' | LifecycleStopOutcome | 'partial';
  items: readonly ContentLifecycleBatchItem[];
  reportFile?: string;
  stop?: { index: number; outcome: LifecycleBatchStopOutcome };
};

/**
 * Validate ordered metadata lifecycle evidence without admitting any native operation.
 * @param {unknown} value - Batch result to validate.
 * @param {unknown} [_provenance] - Provenance validated by the envelope boundary.
 * @param {CmsStatus} [status] - Expected aggregate envelope status.
 */
export function assertContentLifecycleBatchResult(
  value: unknown,
  _provenance?: unknown,
  status?: CmsStatus,
): asserts value is ContentLifecycleBatchResult {
  assertExactKeys(
    value,
    [
      'selection',
      'operation',
      'mode',
      'outcome',
      'items',
      ...present(value, ['reportFile', 'stop']),
    ],
    'result',
  );
  if (value.selection !== 'metadata' || !['publish', 'unpublish'].includes(String(value.operation)))
    throw new TypeError('Invalid lifecycle metadata operation');
  if (value.mode !== 'dry-run' && value.mode !== 'apply')
    throw new TypeError('Invalid lifecycle batch mode');
  if (!Array.isArray(value.items) || value.items.length === 0)
    throw new TypeError('Lifecycle batch items must not be empty');
  if (value.reportFile !== undefined) assertNonemptyString(value.reportFile, 'result.reportFile');
  const batch = value as unknown as ContentLifecycleBatchResult;
  const identities = new Set<string>();
  for (const [index, item] of batch.items.entries()) {
    assertItem(item, batch.operation, index);
    const preflightEvidence =
      batch.outcome === 'blocked' &&
      !batch.items.some((entry) => entry.outcome === 'completed') &&
      (item.outcome === 'ready' || item.outcome === 'blocked');
    if (
      item.result !== undefined &&
      item.result.mode !== batch.mode &&
      !(batch.mode === 'apply' && preflightEvidence && item.result.mode === 'dry-run')
    )
      throw new TypeError('Lifecycle item result mode disagrees with batch');
    if (item.target !== undefined && (item.outcome === 'ready' || item.outcome === 'completed')) {
      const identity = JSON.stringify([
        item.target.workspaceId,
        item.target.contentId,
        ...(batch.operation === 'publish' ? [item.target.variantId] : []),
      ]);
      if (identities.has(identity)) throw new TypeError('Duplicate resolved lifecycle target');
      identities.add(identity);
    }
  }
  let expected: CmsStatus;
  if (batch.stop === undefined) {
    const outcome = batch.mode === 'dry-run' ? 'ready' : 'completed';
    if (batch.outcome !== outcome || batch.items.some((item) => item.outcome !== outcome))
      throw new TypeError('Full batch must agree with its mode and item outcomes');
    expected = 'success';
  } else {
    assertExactKeys(batch.stop, ['index', 'outcome'], 'result.stop');
    if (
      !Number.isInteger(batch.stop.index) ||
      batch.stop.index < 0 ||
      batch.stop.index >= batch.items.length ||
      ![
        'blocked',
        'rejected-before-mutation',
        'ownership-uncertain',
        'remote-completed-local-blocked',
      ].includes(batch.stop.outcome)
    )
      throw new TypeError('Invalid lifecycle batch stop');
    const stopped = batch.items[batch.stop.index];
    const prefix = batch.items.slice(0, batch.stop.index);
    const localStop = batch.stop.outcome === 'remote-completed-local-blocked';
    const preflight =
      batch.stop.outcome === 'blocked' && prefix.every((item) => item.outcome === 'ready');
    if (prefix.some((item) => item.localSource?.outcome === 'blocked'))
      throw new TypeError('Lifecycle prefix cannot continue after local failure');
    if (
      (localStop
        ? stopped.outcome !== 'completed' || stopped.localSource?.outcome !== 'blocked'
        : stopped.outcome !== batch.stop.outcome) ||
      batch.items.slice(batch.stop.index + 1).some((item) => item.outcome !== 'unattempted') ||
      (!preflight &&
        (batch.mode !== 'apply' || prefix.some((item) => item.outcome !== 'completed')))
    )
      throw new TypeError(
        'Lifecycle batch must contain a valid prefix, stop and unattempted suffix',
      );
    const partial = localStop || (!preflight && prefix.length > 0);
    const outcome = partial ? 'partial' : batch.stop.outcome;
    if (batch.outcome !== outcome) throw new TypeError('Lifecycle aggregate outcome disagrees');
    expected = batch.stop.outcome === 'blocked' ? 'blocked' : 'failed';
    if (partial) expected = 'partial';
  }
  if (
    batch.items.some(
      (item, index) =>
        item.localSource?.outcome === 'blocked' &&
        (batch.stop?.index !== index || batch.stop.outcome !== 'remote-completed-local-blocked'),
    )
  )
    throw new TypeError('Blocked local synchronization requires its exact completed stop');
  if (batch.items.some((item) => item.outcome === 'completed' || isMutationStop(item.outcome)))
    assertNonemptyString(batch.reportFile, 'result.reportFile');
  if (batch.mode === 'dry-run' && batch.reportFile !== undefined)
    throw new TypeError('Dry-run batch must not have a report');
  if (status !== undefined && status !== expected)
    throw new TypeError('Lifecycle batch envelope status disagrees with outcome');
}

function assertItem(value: unknown, operation: LifecycleOperation, index: number): void {
  const label = `result.items[${index}]`;
  assertExactKeys(
    value,
    [
      'index',
      'selector',
      'outcome',
      'blockers',
      ...present(value, ['target', 'result', 'reportFile', 'reconciliation', 'localSource']),
    ],
    label,
  );
  if (value.index !== index) throw new TypeError(`${label}.index must match ordered position`);
  assertExactKeys(value.selector, ['contentType', 'apiName'], `${label}.selector`);
  if (
    ![
      'sfdc_cms__email',
      'sfdc_cms__emailTemplate',
      'sfdc_cms__image',
      'sfdc_cms__document',
      'sfdc_cms__audio',
    ].includes(String(value.selector.contentType))
  )
    throw new TypeError(`${label}.selector.contentType must be canonical`);
  assertNonemptyString(value.selector.apiName, `${label}.selector.apiName`);
  if (value.selector.apiName.trim().length === 0 || value.selector.apiName.includes(':'))
    throw new TypeError(`${label}.selector.apiName must be exact`);
  if (
    ![
      'ready',
      'completed',
      'blocked',
      'rejected-before-mutation',
      'ownership-uncertain',
      'unattempted',
    ].includes(String(value.outcome))
  )
    throw new TypeError(`${label}.outcome is invalid`);
  if (!Array.isArray(value.blockers)) throw new TypeError(`${label}.blockers must be an array`);
  for (const blocker of value.blockers) {
    assertExactKeys(blocker, ['code', 'message'], `${label}.blocker`);
    assertNonemptyString(blocker.code, `${label}.blocker.code`);
    assertNonemptyString(blocker.message, `${label}.blocker.message`);
  }
  const stopped = value.outcome === 'blocked' || isMutationStop(value.outcome);
  if (stopped !== value.blockers.length > 0)
    throw new TypeError(`${label}.blockers disagree with outcome`);
  if (value.target !== undefined) {
    assertExactKeys(
      value.target,
      ['contentType', 'apiName', 'workspaceId', 'language', 'contentId', 'variantId'],
      `${label}.target`,
    );
    for (const key of Object.keys(value.target))
      assertNonemptyString(value.target[key], `${label}.target.${key}`);
    if (
      value.target.contentType !== value.selector.contentType ||
      value.target.apiName !== value.selector.apiName
    )
      throw new TypeError(`${label}.target must match selector`);
  }
  if (value.localSource !== undefined) {
    if (value.outcome !== 'completed')
      throw new TypeError('Local outcome requires completed remote evidence');
    const local = value.localSource;
    if (typeof local !== 'object' || local === null) throw new TypeError('Invalid local outcome');
    if ((local as { outcome?: unknown }).outcome === 'noop') {
      assertExactKeys(local, ['outcome', 'reason'], `${label}.localSource`);
      if (!['missing-copy', 'retrieval-equivalent'].includes(String(local.reason)))
        throw new TypeError('Invalid local noop reason');
    } else {
      assertExactKeys(local, ['outcome', 'message'], `${label}.localSource`);
      if (local.outcome !== 'blocked') throw new TypeError('Invalid local outcome');
      assertNonemptyString(local.message, `${label}.localSource.message`);
    }
  }
  if (value.outcome === 'unattempted') {
    if (present(value, ['result', 'reportFile', 'reconciliation']).length > 0)
      throw new TypeError(`${label} unattempted item must not carry execution evidence`);
    return;
  }
  if (value.outcome !== 'blocked' && (value.result === undefined || value.target === undefined))
    throw new TypeError(`${label} requires resolved target and result evidence`);
  if (operation === 'publish' && value.outcome === 'rejected-before-mutation')
    throw new TypeError('Publish has no proven rejection result');
  if (value.result !== undefined) {
    if (operation === 'publish') assertContentPublishResult(value.result);
    else assertContentUnpublishResult(value.result);
    const result = value.result as ContentPublishResult | ContentUnpublishResult;
    if (result.outcome === 'ready' || result.outcome === 'completed') {
      const native = result.evidence.nativeEvidence;
      if (
        value.selector.contentType === 'sfdc_cms__email'
          ? native !== undefined
          : native === undefined || native.contentType !== value.selector.contentType
      )
        throw new TypeError(`${label}.result native evidence must match selector family`);
    }
    const blockers = value.blockers;
    if (
      result.outcome !== value.outcome ||
      result.blockers.some(
        (blocker, position) =>
          blocker.code !== blockers[position]?.code ||
          blocker.message !== blockers[position]?.message,
      ) ||
      result.blockers.length !== value.blockers.length
    )
      throw new TypeError(`${label}.result must agree with outcome and blockers`);
    if (result.target.apiName !== value.selector.apiName)
      throw new TypeError(`${label}.result must agree with selector`);
    if (value.target !== undefined) {
      for (const [key, identity] of Object.entries(result.target)) {
        if (value.target[key] !== identity) throw new TypeError(`${label}.result target disagrees`);
      }
    }
    if ('reportFile' in result && value.reportFile !== result.reportFile)
      throw new TypeError(`${label}.reportFile must match result`);
    if ('reconciliation' in result) {
      assertExactKeys(
        value.reconciliation,
        Object.keys(result.reconciliation),
        `${label}.reconciliation`,
      );
      for (const [key, identity] of Object.entries(result.reconciliation)) {
        if (value.reconciliation[key] !== identity)
          throw new TypeError(`${label}.reconciliation must match result`);
      }
    }
  }
  if (value.outcome === 'completed' || isMutationStop(value.outcome))
    assertNonemptyString(value.reportFile, `${label}.reportFile`);
  else if (present(value, ['reportFile', 'reconciliation']).length > 0)
    throw new TypeError(`${label} must not carry mutation report evidence`);
  if (value.outcome === 'completed' && value.reconciliation !== undefined)
    throw new TypeError(`${label} completed item must not carry reconciliation`);
}

function isMutationStop(outcome: unknown): boolean {
  return outcome === 'ownership-uncertain' || outcome === 'rejected-before-mutation';
}

function present(value: unknown, keys: readonly string[]): string[] {
  if (typeof value !== 'object' || value === null) return [];
  return keys.filter((key) => (value as Record<string, unknown>)[key] !== undefined);
}
