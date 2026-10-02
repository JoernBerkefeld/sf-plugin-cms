import { assertExactKeys, assertNonemptyString, assertSha256, type CmsStatus } from './shared.js';

export const CONTENT_DELETE_CONTRACT = 'sf-cms-content-delete' as const;

export type ContentDeleteTarget = {
  workspaceId: string;
  apiName: string;
  language: string;
  contentId: string;
  variantId: string;
};

export type ContentDeleteMutationError = {
  classification: 'definite-pre-mutation-rejection' | 'ownership-uncertain';
  errorCode?: string;
  httpStatus?: number;
  requestId?: string;
  requestSelector?: string;
  salesforceMessage?: string;
};

export type ContentDeleteResult =
  | {
      mode: 'dry-run';
      outcome: 'ready';
      target: ContentDeleteTarget;
      evidence: {
        acknowledgementRequired: true;
        baselineHash: string;
        currentHash: string;
        ownershipReport: string;
        ownershipRequestSha256: string;
        inventoryVariantCount: number;
        siblingVariantCount: 1;
        contentType?: 'sfdc_cms__emailTemplate';
      };
      blockers: readonly [];
    }
  | {
      mode: 'apply';
      outcome: 'completed';
      target: ContentDeleteTarget;
      evidence: {
        acknowledgedPermanentDelete: true;
        baselineHash: string;
        ownershipReport: string;
        ownershipRequestSha256: string;
        selectedInventoryMatches: 0;
        exactVariantAbsent: true;
        parentBehavior: 'not-found' | 'present';
        parentIdentityPreserved?: true;
        remainingEmailVariantCount?: number;
        contentType?: 'sfdc_cms__emailTemplate';
        remainingFamilyVariantCount?: number;
      };
      blockers: readonly [];
      reportFile: string;
    }
  | {
      mode: 'apply';
      outcome: 'ownership-uncertain' | 'rejected-before-mutation';
      target: ContentDeleteTarget;
      evidence: {
        mutationError: ContentDeleteMutationError;
      };
      blockers: readonly [
        {
          code:
            | 'EMAIL_DELETE_OWNERSHIP_UNCERTAIN'
            | 'EMAIL_DELETE_REJECTED_BEFORE_MUTATION'
            | 'EMAIL_TEMPLATE_DELETE_OWNERSHIP_UNCERTAIN'
            | 'EMAIL_TEMPLATE_DELETE_REJECTED_BEFORE_MUTATION';
          message: string;
        },
      ];
      reportFile: string;
      reconciliation: { workspaceId: string; contentId: string; variantId: string };
    }
  | {
      mode: 'apply' | 'dry-run';
      outcome: 'blocked';
      target: { workspaceId: string; apiName: string; language: string };
      evidence: { ownershipReport?: string };
      blockers: readonly [
        {
          code: 'EMAIL_DELETE_PREFLIGHT_BLOCKED' | 'EMAIL_TEMPLATE_DELETE_PREFLIGHT_BLOCKED';
          message: string;
        },
        ...Array<{
          code: 'EMAIL_DELETE_PREFLIGHT_BLOCKED' | 'EMAIL_TEMPLATE_DELETE_PREFLIGHT_BLOCKED';
          message: string;
        }>,
      ];
    };

export function assertContentDeleteResult(
  value: unknown,
  _provenance?: unknown,
  status?: CmsStatus,
): asserts value is ContentDeleteResult {
  if (!record(value)) throw new TypeError('result must be an object');
  const outcome = value.outcome;
  let extra: string[] = [];
  if (outcome === 'completed') extra = ['reportFile'];
  if (outcome === 'ownership-uncertain' || outcome === 'rejected-before-mutation')
    extra = ['reportFile', 'reconciliation'];
  assertExactKeys(value, ['mode', 'outcome', 'target', 'evidence', 'blockers', ...extra], 'result');
  if (value.mode !== 'apply' && value.mode !== 'dry-run')
    throw new TypeError('result.mode is invalid');
  if (outcome === 'blocked') {
    if (status !== undefined && status !== 'blocked')
      throw new TypeError('blocked delete requires blocked status');
    assertTarget(value.target, false);
    if (!record(value.evidence)) throw new TypeError('result.evidence is invalid');
    assertExactKeys(
      value.evidence,
      value.evidence.ownershipReport === undefined ? [] : ['ownershipReport'],
      'result.evidence',
    );
    if (value.evidence.ownershipReport !== undefined)
      assertNonemptyString(value.evidence.ownershipReport, 'result.evidence.ownershipReport');
    assertBlockers(
      value.blockers,
      (value.blockers as Array<{ code?: unknown }>)[0]?.code ===
        'EMAIL_TEMPLATE_DELETE_PREFLIGHT_BLOCKED'
        ? 'EMAIL_TEMPLATE_DELETE_PREFLIGHT_BLOCKED'
        : 'EMAIL_DELETE_PREFLIGHT_BLOCKED',
    );
    return;
  }
  assertTarget(value.target, true);
  if (outcome === 'ready') {
    if (value.mode !== 'dry-run' || (status !== undefined && status !== 'success'))
      throw new TypeError('ready delete requires dry-run success');
    if (!record(value.evidence)) throw new TypeError('result.evidence is invalid');
    assertExactKeys(
      value.evidence,
      [
        'acknowledgementRequired',
        'baselineHash',
        'currentHash',
        'ownershipReport',
        'ownershipRequestSha256',
        'inventoryVariantCount',
        'siblingVariantCount',
        ...(value.evidence.contentType === undefined ? [] : ['contentType']),
      ],
      'result.evidence',
    );
    if (!record(value.evidence) || value.evidence.acknowledgementRequired !== true)
      throw new TypeError('delete acknowledgement requirement is invalid');
    assertSha256(value.evidence.baselineHash, 'result.evidence.baselineHash');
    assertSha256(value.evidence.currentHash, 'result.evidence.currentHash');
    if (value.evidence.baselineHash !== value.evidence.currentHash)
      throw new TypeError('delete baseline hash must match current hash');
    assertOwnershipEvidence(value.evidence);
    if (
      typeof value.evidence.inventoryVariantCount !== 'number' ||
      !Number.isInteger(value.evidence.inventoryVariantCount) ||
      value.evidence.inventoryVariantCount < 1
    )
      throw new TypeError('result.evidence.inventoryVariantCount is invalid');
    if (value.evidence.siblingVariantCount !== 1)
      throw new TypeError('result.evidence.siblingVariantCount is invalid');
    if (
      value.evidence.contentType !== undefined &&
      value.evidence.contentType !== 'sfdc_cms__emailTemplate'
    )
      throw new TypeError('result.evidence.contentType is invalid');
    assertEmpty(value.blockers);
    return;
  }
  if (outcome === 'completed') {
    if (value.mode !== 'apply' || (status !== undefined && status !== 'success'))
      throw new TypeError('completed delete requires apply success');
    if (!record(value.evidence)) throw new TypeError('result.evidence is invalid');
    assertExactKeys(
      value.evidence,
      [
        'acknowledgedPermanentDelete',
        'baselineHash',
        'ownershipReport',
        'ownershipRequestSha256',
        'selectedInventoryMatches',
        'exactVariantAbsent',
        'parentBehavior',
        ...(value.evidence.parentIdentityPreserved === undefined
          ? []
          : ['parentIdentityPreserved']),
        ...(value.evidence.remainingEmailVariantCount === undefined
          ? []
          : ['remainingEmailVariantCount']),
        ...(value.evidence.contentType === undefined ? [] : ['contentType']),
        ...(value.evidence.remainingFamilyVariantCount === undefined
          ? []
          : ['remainingFamilyVariantCount']),
      ],
      'result.evidence',
    );
    if (
      value.evidence.acknowledgedPermanentDelete !== true ||
      value.evidence.selectedInventoryMatches !== 0 ||
      value.evidence.exactVariantAbsent !== true ||
      (value.evidence.parentBehavior !== 'present' &&
        value.evidence.parentBehavior !== 'not-found') ||
      (value.evidence.parentBehavior === 'present' &&
        value.evidence.parentIdentityPreserved !== true) ||
      (value.evidence.contentType === undefined
        ? typeof value.evidence.remainingEmailVariantCount !== 'number' ||
          !Number.isInteger(value.evidence.remainingEmailVariantCount) ||
          value.evidence.remainingEmailVariantCount < 0 ||
          value.evidence.remainingFamilyVariantCount !== undefined
        : value.evidence.contentType !== 'sfdc_cms__emailTemplate' ||
          value.evidence.remainingEmailVariantCount !== undefined ||
          typeof value.evidence.remainingFamilyVariantCount !== 'number' ||
          !Number.isInteger(value.evidence.remainingFamilyVariantCount) ||
          value.evidence.remainingFamilyVariantCount < 0)
    )
      throw new TypeError('completed delete evidence is invalid');
    assertSha256(value.evidence.baselineHash, 'result.evidence.baselineHash');
    assertOwnershipEvidence(value.evidence);
    assertNonemptyString(value.reportFile, 'result.reportFile');
    assertEmpty(value.blockers);
    return;
  }
  if (
    (outcome !== 'ownership-uncertain' && outcome !== 'rejected-before-mutation') ||
    value.mode !== 'apply' ||
    (status !== undefined && status !== 'failed')
  )
    throw new TypeError('delete outcome is invalid');
  if (
    !record(value.evidence) ||
    !record(value.evidence.mutationError) ||
    !record(value.reconciliation)
  )
    throw new TypeError('delete reconciliation is invalid');
  assertExactKeys(value.evidence, ['mutationError'], 'result.evidence');
  assertMutationError(value.evidence.mutationError, outcome);
  const observedCode = (value.blockers as Array<{ code?: unknown }>)[0]?.code;
  const template =
    observedCode === 'EMAIL_TEMPLATE_DELETE_REJECTED_BEFORE_MUTATION' ||
    observedCode === 'EMAIL_TEMPLATE_DELETE_OWNERSHIP_UNCERTAIN';
  let expectedBlockerCode: string;
  if (template) {
    expectedBlockerCode =
      outcome === 'rejected-before-mutation'
        ? 'EMAIL_TEMPLATE_DELETE_REJECTED_BEFORE_MUTATION'
        : 'EMAIL_TEMPLATE_DELETE_OWNERSHIP_UNCERTAIN';
  } else {
    expectedBlockerCode =
      outcome === 'rejected-before-mutation'
        ? 'EMAIL_DELETE_REJECTED_BEFORE_MUTATION'
        : 'EMAIL_DELETE_OWNERSHIP_UNCERTAIN';
  }
  assertBlockers(value.blockers, expectedBlockerCode);
  assertNonemptyString(value.reportFile, 'result.reportFile');
  assertExactKeys(
    value.reconciliation,
    ['workspaceId', 'contentId', 'variantId'],
    'result.reconciliation',
  );
  for (const key of ['workspaceId', 'contentId', 'variantId'] as const)
    assertNonemptyString(value.reconciliation[key], `result.reconciliation.${key}`);
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertTarget(value: unknown, resolved: boolean): asserts value is Record<string, unknown> {
  const keys = [
    'workspaceId',
    'apiName',
    'language',
    ...(resolved ? ['contentId', 'variantId'] : []),
  ];
  assertExactKeys(value, keys, 'result.target');
  for (const key of keys)
    assertNonemptyString((value as Record<string, unknown>)[key], `result.target.${key}`);
}

function assertOwnershipEvidence(value: Record<string, unknown>): void {
  assertNonemptyString(value.ownershipReport, 'result.evidence.ownershipReport');
  assertSha256(value.ownershipRequestSha256, 'result.evidence.ownershipRequestSha256');
}

function assertMutationError(
  value: Record<string, unknown>,
  outcome: 'ownership-uncertain' | 'rejected-before-mutation',
): void {
  const optional = ['errorCode', 'httpStatus', 'requestId', 'requestSelector', 'salesforceMessage'];
  assertExactKeys(
    value,
    ['classification', ...optional.filter((key) => value[key] !== undefined)],
    'result.evidence.mutationError',
  );
  const expected =
    outcome === 'rejected-before-mutation'
      ? 'definite-pre-mutation-rejection'
      : 'ownership-uncertain';
  if (value.classification !== expected)
    throw new TypeError('result.evidence.mutationError.classification is invalid');
  for (const key of ['errorCode', 'requestId', 'requestSelector', 'salesforceMessage'] as const)
    if (value[key] !== undefined)
      assertNonemptyString(value[key], `result.evidence.mutationError.${key}`);
  if (
    value.httpStatus !== undefined &&
    (typeof value.httpStatus !== 'number' ||
      !Number.isInteger(value.httpStatus) ||
      value.httpStatus < 400)
  )
    throw new TypeError('result.evidence.mutationError.httpStatus is invalid');
}

function assertBlockers(value: unknown, code: string): void {
  if (!Array.isArray(value) || value.length !== 1)
    throw new TypeError('result.blockers is invalid');
  assertExactKeys(value[0], ['code', 'message'], 'result.blockers[0]');
  if (value[0].code !== code) throw new TypeError('result.blockers[0].code is invalid');
  assertNonemptyString(value[0].message, 'result.blockers[0].message');
}

function assertEmpty(value: unknown): void {
  if (!Array.isArray(value) || value.length > 0)
    throw new TypeError('result.blockers must be empty');
}
