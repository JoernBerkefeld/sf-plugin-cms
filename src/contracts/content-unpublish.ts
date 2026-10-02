import { assertExactKeys, assertNonemptyString, assertSha256, type CmsStatus } from './shared.js';

export const CONTENT_UNPUBLISH_CONTRACT = 'sf-cms-content-unpublish' as const;
export type ContentUnpublishTarget = {
  workspaceId: string;
  apiName: string;
  language: string;
  contentId: string;
  variantId: string;
};
export type ContentUnpublishInventoryEntry = {
  contentId: string;
  hash: string;
  isPublished: boolean;
  language: string;
  status: string;
  variantId: string;
};
export type ContentUnpublishSibling = {
  hash: string;
  language: string;
  isPublished: boolean;
  status: string;
  variantId: string;
};
export type ContentUnpublishResult =
  | {
      mode: 'dry-run';
      outcome: 'ready';
      target: ContentUnpublishTarget;
      evidence: {
        selectorScope: 'parent';
        includeContentReferencesOmitted: true;
        activeUseStopsAcknowledgementRequired: true;
        baselineHash: string;
        inventory: readonly ContentUnpublishInventoryEntry[];
        siblingInventory: readonly ContentUnpublishSibling[];
      };
      blockers: readonly [];
    }
  | {
      mode: 'apply';
      outcome: 'completed';
      target: ContentUnpublishTarget;
      evidence: {
        selectorScope: 'parent';
        includeContentReferencesOmitted: true;
        activeUseStopsAcknowledged: true;
        baselineHash: string;
        postUnpublishHash: string;
        deploymentId: string;
        unpublishDate?: string;
        inventory: readonly ContentUnpublishInventoryEntry[];
        siblingInventory: readonly ContentUnpublishSibling[];
      };
      blockers: readonly [];
      reportFile: string;
    }
  | {
      mode: 'apply';
      outcome: 'ownership-uncertain' | 'rejected-before-mutation';
      target: ContentUnpublishTarget;
      evidence: {
        selectorScope: 'parent';
        includeContentReferencesOmitted: true;
        deploymentId?: string;
        mutationError: {
          classification: 'definite-pre-mutation-rejection' | 'ownership-uncertain';
          errorCode?: string;
          httpStatus?: number;
          requestBodySha256?: string;
          requestId?: string;
          requestSelector?: string;
          salesforceMessage?: string;
        };
      };
      blockers: readonly [
        {
          code: 'EMAIL_UNPUBLISH_OWNERSHIP_UNCERTAIN' | 'EMAIL_UNPUBLISH_REJECTED_BEFORE_MUTATION';
          message: string;
        },
      ];
      reportFile: string;
      reconciliation: {
        workspaceId: string;
        contentId: string;
        variantId: string;
        deploymentId?: string;
      };
    }
  | {
      mode: 'apply' | 'dry-run';
      outcome: 'blocked';
      target: { workspaceId: string; apiName: string; language: string };
      evidence: { selectorScope: 'parent'; includeContentReferencesOmitted: true };
      blockers: readonly [
        { code: 'EMAIL_UNPUBLISH_PREFLIGHT_BLOCKED'; message: string },
        ...Array<{ code: 'EMAIL_UNPUBLISH_PREFLIGHT_BLOCKED'; message: string }>,
      ];
    };

export function assertContentUnpublishResult(
  value: unknown,
  _provenance?: unknown,
  status?: CmsStatus,
): asserts value is ContentUnpublishResult {
  if (!record(value)) throw new TypeError('result must be an object');
  let extra: string[] = [];
  if (value.outcome === 'completed') extra = ['reportFile'];
  if (value.outcome === 'ownership-uncertain' || value.outcome === 'rejected-before-mutation')
    extra = ['reportFile', 'reconciliation'];
  assertExactKeys(value, ['mode', 'outcome', 'target', 'evidence', 'blockers', ...extra], 'result');
  if (value.mode !== 'apply' && value.mode !== 'dry-run')
    throw new TypeError('result.mode is invalid');
  if (value.outcome === 'blocked') {
    if (status !== undefined && status !== 'blocked')
      throw new TypeError('blocked unpublish requires blocked status');
    assertTarget(value.target, false);
    assertBaseEvidence(value.evidence);
    assertBlockers(value.blockers, 'EMAIL_UNPUBLISH_PREFLIGHT_BLOCKED');
    return;
  }
  assertTarget(value.target, true);
  if (value.outcome === 'ready') {
    if (value.mode !== 'dry-run' || (status !== undefined && status !== 'success'))
      throw new TypeError('ready unpublish requires dry-run success');
    assertExactKeys(
      value.evidence,
      [
        'selectorScope',
        'includeContentReferencesOmitted',
        'activeUseStopsAcknowledgementRequired',
        'baselineHash',
        'inventory',
        'siblingInventory',
      ],
      'result.evidence',
    );
    assertBaseEvidence(value.evidence);
    if (value.evidence.activeUseStopsAcknowledgementRequired !== true)
      throw new TypeError('unpublish acknowledgement requirement is invalid');
    assertSha256(value.evidence.baselineHash, 'result.evidence.baselineHash');
    assertInventory(value.evidence.inventory, value.target, true);
    assertSiblings(value.evidence.siblingInventory);
    assertProjection(value.evidence.inventory, value.evidence.siblingInventory, value.target);
    assertSelected(
      value.target,
      value.evidence.siblingInventory,
      value.evidence.baselineHash,
      true,
    );
    assertEmpty(value.blockers);
    return;
  }
  if (value.outcome === 'completed') {
    if (value.mode !== 'apply' || (status !== undefined && status !== 'success'))
      throw new TypeError('completed unpublish requires apply success');
    if (!record(value.evidence)) throw new TypeError('result.evidence must be an object');
    assertExactKeys(
      value.evidence,
      [
        'selectorScope',
        'includeContentReferencesOmitted',
        'activeUseStopsAcknowledged',
        'baselineHash',
        'postUnpublishHash',
        'deploymentId',
        ...(value.evidence.unpublishDate === undefined ? [] : ['unpublishDate']),
        'inventory',
        'siblingInventory',
      ],
      'result.evidence',
    );
    assertBaseEvidence(value.evidence);
    if (value.evidence.activeUseStopsAcknowledged !== true)
      throw new TypeError('unpublish acknowledgement is invalid');
    assertSha256(value.evidence.baselineHash, 'result.evidence.baselineHash');
    assertSha256(value.evidence.postUnpublishHash, 'result.evidence.postUnpublishHash');
    if (value.evidence.postUnpublishHash !== value.evidence.baselineHash)
      throw new TypeError('unpublish must preserve the selected Email body hash');
    assertNonemptyString(value.evidence.deploymentId, 'result.evidence.deploymentId');
    if (value.evidence.unpublishDate !== undefined)
      assertNonemptyString(value.evidence.unpublishDate, 'result.evidence.unpublishDate');
    assertInventory(value.evidence.inventory, value.target, false);
    assertSiblings(value.evidence.siblingInventory);
    assertProjection(value.evidence.inventory, value.evidence.siblingInventory, value.target);
    assertSelected(
      value.target,
      value.evidence.siblingInventory,
      value.evidence.postUnpublishHash,
      false,
    );
    assertNonemptyString(value.reportFile, 'result.reportFile');
    assertEmpty(value.blockers);
    return;
  }
  if (
    (value.outcome !== 'ownership-uncertain' && value.outcome !== 'rejected-before-mutation') ||
    value.mode !== 'apply' ||
    (status !== undefined && status !== 'failed')
  )
    throw new TypeError('unpublish outcome is invalid');
  if (
    !record(value.evidence) ||
    !record(value.evidence.mutationError) ||
    !record(value.reconciliation)
  )
    throw new TypeError('unpublish reconciliation is invalid');
  assertExactKeys(
    value.evidence,
    [
      'selectorScope',
      'includeContentReferencesOmitted',
      ...(value.evidence.deploymentId === undefined ? [] : ['deploymentId']),
      'mutationError',
    ],
    'result.evidence',
  );
  assertBaseEvidence(value.evidence);
  if (value.evidence.deploymentId !== undefined)
    assertNonemptyString(value.evidence.deploymentId, 'result.evidence.deploymentId');
  assertMutationError(value.evidence.mutationError, value.outcome);
  assertBlockers(
    value.blockers,
    value.outcome === 'rejected-before-mutation'
      ? 'EMAIL_UNPUBLISH_REJECTED_BEFORE_MUTATION'
      : 'EMAIL_UNPUBLISH_OWNERSHIP_UNCERTAIN',
  );
  assertNonemptyString(value.reportFile, 'result.reportFile');
  assertExactKeys(
    value.reconciliation,
    [
      'workspaceId',
      'contentId',
      'variantId',
      ...(value.reconciliation.deploymentId === undefined ? [] : ['deploymentId']),
    ],
    'result.reconciliation',
  );
  for (const key of ['workspaceId', 'contentId', 'variantId'] as const)
    assertNonemptyString(value.reconciliation[key], `result.reconciliation.${key}`);
  if (
    value.reconciliation.workspaceId !== value.target.workspaceId ||
    value.reconciliation.contentId !== value.target.contentId ||
    value.reconciliation.variantId !== value.target.variantId ||
    value.reconciliation.deploymentId !== value.evidence.deploymentId
  )
    throw new TypeError('result.reconciliation must match target and evidence');
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function assertBaseEvidence(value: unknown): asserts value is Record<string, unknown> {
  if (
    !record(value) ||
    value.selectorScope !== 'parent' ||
    value.includeContentReferencesOmitted !== true
  )
    throw new TypeError('result.evidence unpublish scope is invalid');
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
function assertInventory(
  value: unknown,
  target: Record<string, unknown>,
  published: boolean,
): void {
  if (!Array.isArray(value) || value.length === 0)
    throw new TypeError('result.evidence.inventory is invalid');
  const ids = new Set<string>();
  for (const [index, item] of value.entries()) {
    const label = `result.evidence.inventory[${index}]`;
    assertExactKeys(
      item,
      ['contentId', 'hash', 'isPublished', 'language', 'status', 'variantId'],
      label,
    );
    for (const key of ['contentId', 'language', 'status', 'variantId'] as const)
      assertNonemptyString(item[key], `${label}.${key}`);
    assertSha256(item.hash, `${label}.hash`);
    if (typeof item.isPublished !== 'boolean')
      throw new TypeError(`${label}.isPublished is invalid`);
    if (ids.has(item.variantId as string))
      throw new TypeError('result.evidence.inventory contains duplicate variants');
    ids.add(item.variantId as string);
  }
  const selected = value.filter((item) => item.variantId === target.variantId);
  if (
    selected.length !== 1 ||
    selected[0].contentId !== target.contentId ||
    selected[0].language !== target.language ||
    selected[0].isPublished !== published ||
    selected[0].status !== (published ? 'Published' : 'Draft')
  )
    throw new TypeError('result target inventory lifecycle or identity is inconsistent');
}
function assertSiblings(value: unknown): void {
  if (!Array.isArray(value) || value.length === 0)
    throw new TypeError('result.evidence.siblingInventory is invalid');
  for (const [index, item] of value.entries()) {
    const label = `result.evidence.siblingInventory[${index}]`;
    assertExactKeys(item, ['hash', 'language', 'isPublished', 'status', 'variantId'], label);
    assertSha256(item.hash, `${label}.hash`);
    for (const key of ['language', 'status', 'variantId'] as const)
      assertNonemptyString(item[key], `${label}.${key}`);
    if (typeof item.isPublished !== 'boolean')
      throw new TypeError(`${label}.isPublished is invalid`);
  }
}
function assertProjection(
  inventory: unknown,
  siblings: unknown,
  target: Record<string, unknown>,
): void {
  const expected = (inventory as ContentUnpublishInventoryEntry[])
    .filter((item) => item.contentId === target.contentId)
    .map(({ hash, language, isPublished, status, variantId }) => ({
      hash,
      language,
      isPublished,
      status,
      variantId,
    }))
    .toSorted((a, b) =>
      `${a.variantId}\0${a.language}`.localeCompare(`${b.variantId}\0${b.language}`),
    );
  const actual = [...(siblings as ContentUnpublishSibling[])].toSorted((a, b) =>
    `${a.variantId}\0${a.language}`.localeCompare(`${b.variantId}\0${b.language}`),
  );
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new TypeError(
      'result sibling inventory must match the target parent inventory projection',
    );
}
function assertSelected(
  target: Record<string, unknown>,
  value: unknown,
  expectedHash: unknown,
  published: boolean,
): void {
  const matches = (value as Array<Record<string, unknown>>).filter(
    (item) => item.variantId === target.variantId,
  );
  if (
    matches.length !== 1 ||
    matches[0].language !== target.language ||
    matches[0].hash !== expectedHash ||
    matches[0].isPublished !== published ||
    matches[0].status !== (published ? 'Published' : 'Draft')
  )
    throw new TypeError('result target sibling lifecycle or identity is inconsistent');
}
function assertMutationError(
  value: Record<string, unknown>,
  outcome: 'ownership-uncertain' | 'rejected-before-mutation',
): void {
  const optional = [
    'errorCode',
    'httpStatus',
    'requestBodySha256',
    'requestId',
    'requestSelector',
    'salesforceMessage',
  ];
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
  for (const key of ['errorCode', 'requestId', 'requestSelector', 'salesforceMessage'] as const) {
    if (value[key] !== undefined)
      assertNonemptyString(value[key], `result.evidence.mutationError.${key}`);
  }
  if (
    value.httpStatus !== undefined &&
    (typeof value.httpStatus !== 'number' ||
      !Number.isInteger(value.httpStatus) ||
      value.httpStatus < 400)
  )
    throw new TypeError('result.evidence.mutationError.httpStatus is invalid');
  if (value.requestBodySha256 !== undefined)
    assertSha256(value.requestBodySha256, 'result.evidence.mutationError.requestBodySha256');
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
