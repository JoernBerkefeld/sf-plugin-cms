import { assertExactKeys, assertNonemptyString, assertSha256, type CmsStatus } from './shared.js';

export const CONTENT_UPDATE_CONTRACT = 'sf-cms-content-update' as const;

export type ContentUpdateTarget = {
  workspaceId: string;
  apiName: string;
  language: string;
  contentId: string;
  variantId: string;
};

export type ContentUpdateSibling = {
  hash: string;
  language: string;
  lifecycle: { isPublished: false; status: 'Draft' };
  variantId: string;
};

export type PreparedContentUpdateEvidence = {
  baselineHash: string;
  payloadHash: string;
  changedFields: readonly ['contentBody.rawHtml'];
  siblingInventory: readonly ContentUpdateSibling[];
};

type Reconciliation = {
  contentId: string;
  payloadHash: string;
  variantId: string;
  workspaceId: string;
};

type PreflightBlockedBlocker = {
  code: 'EMAIL_TEMPLATE_UPDATE_PREFLIGHT_BLOCKED' | 'EMAIL_UPDATE_PREFLIGHT_BLOCKED';
  message: string;
};

type OwnershipUncertainBlocker = {
  code: 'EMAIL_TEMPLATE_UPDATE_OWNERSHIP_UNCERTAIN' | 'EMAIL_UPDATE_OWNERSHIP_UNCERTAIN';
  message: string;
};

export type ContentUpdateResult =
  | {
      mode: 'dry-run';
      outcome: 'ready';
      target: ContentUpdateTarget;
      evidence: PreparedContentUpdateEvidence;
      blockers: readonly [];
      contentType?: 'sfdc_cms__emailTemplate';
    }
  | {
      mode: 'apply';
      outcome: 'completed';
      target: ContentUpdateTarget;
      evidence: PreparedContentUpdateEvidence & { postUpdateHash: string };
      blockers: readonly [];
      reportFile: string;
      contentType?: 'sfdc_cms__emailTemplate';
    }
  | {
      mode: 'apply';
      outcome: 'ownership-uncertain';
      target: ContentUpdateTarget;
      evidence: {
        changedFields: readonly ['contentBody.rawHtml'];
        payloadHash: string;
      };
      blockers: readonly [OwnershipUncertainBlocker];
      reportFile: string;
      reconciliation: Reconciliation;
      contentType?: 'sfdc_cms__emailTemplate';
    }
  | {
      mode: 'apply' | 'dry-run';
      outcome: 'blocked';
      target: { workspaceId: string; apiName: string; language: string };
      evidence: { changedFields: readonly [] };
      blockers: readonly [PreflightBlockedBlocker, ...PreflightBlockedBlocker[]];
      contentType?: 'sfdc_cms__emailTemplate';
    };

export function assertContentUpdateResult(
  value: unknown,
  _provenance?: unknown,
  status?: CmsStatus,
): asserts value is ContentUpdateResult {
  assertExactKeys(value, keysForOutcome(value), 'result');
  if (value.mode !== 'apply' && value.mode !== 'dry-run') {
    throw new TypeError('result.mode is invalid');
  }
  if (!['blocked', 'completed', 'ownership-uncertain', 'ready'].includes(String(value.outcome))) {
    throw new TypeError('result.outcome is invalid');
  }

  assertContentType(value);
  if (value.outcome === 'blocked') {
    assertBlocked(value, status);
    return;
  }
  if (value.outcome === 'ready') {
    if (value.mode !== 'dry-run' || (status !== undefined && status !== 'success')) {
      throw new TypeError('ready content update result requires dry-run success');
    }
    assertTarget(value.target, 'result.target');
    assertPreparedEvidence(value.evidence, false);
    assertEmptyBlockers(value.blockers);
    return;
  }
  if (value.outcome === 'completed') {
    if (value.mode !== 'apply' || (status !== undefined && status !== 'success')) {
      throw new TypeError('completed content update result requires apply success');
    }
    assertTarget(value.target, 'result.target');
    assertPreparedEvidence(value.evidence, true);
    assertEmptyBlockers(value.blockers);
    assertNonemptyString(value.reportFile, 'result.reportFile');
    return;
  }

  if (value.mode !== 'apply' || (status !== undefined && status !== 'failed')) {
    throw new TypeError('ownership-uncertain content update result requires failed apply');
  }
  assertTarget(value.target, 'result.target');
  assertExactKeys(value.evidence, ['changedFields', 'payloadHash'], 'result.evidence');
  assertChangedFields(value.evidence.changedFields, true);
  assertSha256(value.evidence.payloadHash, 'result.evidence.payloadHash');
  assertBlockers(value.blockers, true);
  if (
    value.blockers.length !== 1 ||
    !['EMAIL_TEMPLATE_UPDATE_OWNERSHIP_UNCERTAIN', 'EMAIL_UPDATE_OWNERSHIP_UNCERTAIN'].includes(
      value.blockers[0].code,
    )
  ) {
    throw new TypeError('ownership-uncertain result requires exactly one update blocker');
  }
  assertNonemptyString(value.reportFile, 'result.reportFile');
  assertReconciliation(value.reconciliation);
  if (
    value.reconciliation.contentId !== value.target.contentId ||
    value.reconciliation.variantId !== value.target.variantId ||
    value.reconciliation.workspaceId !== value.target.workspaceId ||
    value.reconciliation.payloadHash !== value.evidence.payloadHash
  ) {
    throw new TypeError('result.reconciliation must match target and evidence');
  }
}

function keysForOutcome(value: unknown): readonly string[] {
  const contentType = has(value, 'contentType') ? ['contentType'] : [];
  if (!has(value, 'outcome'))
    return ['mode', 'outcome', 'target', 'evidence', 'blockers', ...contentType];
  if (value.outcome === 'completed') {
    return ['mode', 'outcome', 'target', 'evidence', 'blockers', 'reportFile', ...contentType];
  }
  if (value.outcome === 'ownership-uncertain') {
    return [
      'mode',
      'outcome',
      'target',
      'evidence',
      'blockers',
      'reportFile',
      'reconciliation',
      ...contentType,
    ];
  }
  return ['mode', 'outcome', 'target', 'evidence', 'blockers', ...contentType];
}

function assertBlocked(value: Record<string, unknown>, status?: CmsStatus): void {
  if (status !== undefined && status !== 'blocked') {
    throw new TypeError('blocked content update result requires blocked status');
  }
  assertExactKeys(value.target, ['workspaceId', 'apiName', 'language'], 'result.target');
  assertNonemptyString(value.target.workspaceId, 'result.target.workspaceId');
  assertNonemptyString(value.target.apiName, 'result.target.apiName');
  assertNonemptyString(value.target.language, 'result.target.language');
  assertExactKeys(value.evidence, ['changedFields'], 'result.evidence');
  assertChangedFields(value.evidence.changedFields, false);
  assertBlockers(value.blockers, true);
  if (
    value.blockers.some(
      (blocker) =>
        blocker.code !== 'EMAIL_UPDATE_PREFLIGHT_BLOCKED' &&
        blocker.code !== 'EMAIL_TEMPLATE_UPDATE_PREFLIGHT_BLOCKED',
    )
  ) {
    throw new TypeError('blocked result requires an update preflight blocker');
  }
}

function assertTarget(value: unknown, label: string): asserts value is ContentUpdateTarget {
  assertExactKeys(value, ['workspaceId', 'apiName', 'language', 'contentId', 'variantId'], label);
  for (const key of ['workspaceId', 'apiName', 'language', 'contentId', 'variantId'] as const) {
    assertNonemptyString(value[key], `${label}.${key}`);
  }
}

function assertPreparedEvidence(
  value: unknown,
  completed: boolean,
): asserts value is PreparedContentUpdateEvidence {
  assertExactKeys(
    value,
    [
      'baselineHash',
      'payloadHash',
      'changedFields',
      'siblingInventory',
      ...(completed ? ['postUpdateHash'] : []),
    ],
    'result.evidence',
  );
  assertSha256(value.baselineHash, 'result.evidence.baselineHash');
  assertSha256(value.payloadHash, 'result.evidence.payloadHash');
  assertChangedFields(value.changedFields, true);
  if (completed) assertSha256(value.postUpdateHash, 'result.evidence.postUpdateHash');
  if (!Array.isArray(value.siblingInventory)) {
    throw new TypeError('result.evidence.siblingInventory is invalid');
  }
  for (const [index, sibling] of value.siblingInventory.entries()) {
    const label = `result.evidence.siblingInventory[${index}]`;
    assertExactKeys(sibling, ['hash', 'language', 'lifecycle', 'variantId'], label);
    assertSha256(sibling.hash, `${label}.hash`);
    assertNonemptyString(sibling.language, `${label}.language`);
    assertNonemptyString(sibling.variantId, `${label}.variantId`);
    assertExactKeys(sibling.lifecycle, ['isPublished', 'status'], `${label}.lifecycle`);
    if (sibling.lifecycle.isPublished !== false || sibling.lifecycle.status !== 'Draft') {
      throw new TypeError(`${label}.lifecycle must be unpublished Draft`);
    }
  }
}

function assertChangedFields(value: unknown, changed: boolean): void {
  if (!Array.isArray(value)) throw new TypeError('result.evidence.changedFields is invalid');
  const expected = changed ? ['contentBody.rawHtml'] : [];
  if (JSON.stringify(value) !== JSON.stringify(expected)) {
    throw new TypeError('result.evidence.changedFields is invalid');
  }
}

function assertEmptyBlockers(value: unknown): void {
  if (!Array.isArray(value) || value.length > 0) {
    throw new TypeError('result.blockers must be empty');
  }
}

function assertBlockers(
  value: unknown,
  required: boolean,
): asserts value is Array<PreflightBlockedBlocker | OwnershipUncertainBlocker> {
  if (!Array.isArray(value) || (required && value.length === 0)) {
    throw new TypeError('result.blockers is invalid');
  }
  for (const [index, blocker] of value.entries()) {
    assertExactKeys(blocker, ['code', 'message'], `result.blockers[${index}]`);
    assertNonemptyString(blocker.code, `result.blockers[${index}].code`);
    assertNonemptyString(blocker.message, `result.blockers[${index}].message`);
  }
}

function assertReconciliation(value: unknown): asserts value is Reconciliation {
  assertExactKeys(
    value,
    ['contentId', 'payloadHash', 'variantId', 'workspaceId'],
    'result.reconciliation',
  );
  assertNonemptyString(value.contentId, 'result.reconciliation.contentId');
  assertSha256(value.payloadHash, 'result.reconciliation.payloadHash');
  assertNonemptyString(value.variantId, 'result.reconciliation.variantId');
  assertNonemptyString(value.workspaceId, 'result.reconciliation.workspaceId');
}

function assertContentType(value: Record<string, unknown>): void {
  if (value.contentType !== undefined && value.contentType !== 'sfdc_cms__emailTemplate') {
    throw new TypeError('result.contentType is invalid');
  }
}

function has(value: unknown, key: string): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && key in value;
}
