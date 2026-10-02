import { assertExactKeys, assertNonemptyString, assertSha256, type CmsStatus } from './shared.js';

export const CONTENT_PUBLISH_CONTRACT = 'sf-cms-content-publish' as const;

export type ContentPublishTarget = {
  workspaceId: string;
  apiName: string;
  language: string;
  contentId: string;
  variantId: string;
};

export type ContentPublishInventoryEntry = {
  contentId: string;
  hash: string;
  isPublished: boolean;
  language: string;
  status: string;
  variantId: string;
};

export type ContentPublishSibling = {
  hash: string;
  language: string;
  isPublished: boolean;
  status: string;
  variantId: string;
};

export type ContentPublishResult =
  | {
      mode: 'dry-run';
      outcome: 'ready';
      target: ContentPublishTarget;
      evidence: {
        selectorScope: 'variant';
        includeContentReferences: false;
        noSendAcknowledgementRequired: true;
        baselineHash: string;
        inventory: readonly ContentPublishInventoryEntry[];
        siblingInventory: readonly ContentPublishSibling[];
      };
      blockers: readonly [];
    }
  | {
      mode: 'apply';
      outcome: 'completed';
      target: ContentPublishTarget;
      evidence: {
        selectorScope: 'variant';
        includeContentReferences: false;
        noSendAcknowledged: true;
        baselineHash: string;
        postPublishHash: string;
        deploymentId: string;
        publishDate?: string;
        inventory: readonly ContentPublishInventoryEntry[];
        siblingInventory: readonly ContentPublishSibling[];
      };
      blockers: readonly [];
      reportFile: string;
    }
  | {
      mode: 'apply';
      outcome: 'ownership-uncertain';
      target: ContentPublishTarget;
      evidence: {
        selectorScope: 'variant';
        includeContentReferences: false;
        deploymentId?: string;
      };
      blockers: readonly [{ code: 'EMAIL_PUBLISH_OWNERSHIP_UNCERTAIN'; message: string }];
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
      evidence: { selectorScope: 'variant'; includeContentReferences: false };
      blockers: readonly [
        { code: 'EMAIL_PUBLISH_PREFLIGHT_BLOCKED'; message: string },
        ...Array<{ code: 'EMAIL_PUBLISH_PREFLIGHT_BLOCKED'; message: string }>,
      ];
    };

export function assertContentPublishResult(
  value: unknown,
  _provenance?: unknown,
  status?: CmsStatus,
): asserts value is ContentPublishResult {
  if (!record(value)) throw new TypeError('result must be an object');
  let extra: string[] = [];
  if (value.outcome === 'completed') extra = ['reportFile'];
  if (value.outcome === 'ownership-uncertain') extra = ['reportFile', 'reconciliation'];
  assertExactKeys(value, ['mode', 'outcome', 'target', 'evidence', 'blockers', ...extra], 'result');
  if (value.mode !== 'apply' && value.mode !== 'dry-run')
    throw new TypeError('result.mode is invalid');
  if (value.outcome === 'blocked') {
    if (status !== undefined && status !== 'blocked')
      throw new TypeError('blocked publish requires blocked status');
    assertSelectorTarget(value.target, false);
    assertBaseEvidence(value.evidence);
    assertBlockers(value.blockers, 'EMAIL_PUBLISH_PREFLIGHT_BLOCKED');
    return;
  }
  assertSelectorTarget(value.target, true);
  if (value.outcome === 'ready') {
    if (value.mode !== 'dry-run' || (status !== undefined && status !== 'success'))
      throw new TypeError('ready publish requires dry-run success');
    assertExactKeys(
      value.evidence,
      [
        'selectorScope',
        'includeContentReferences',
        'noSendAcknowledgementRequired',
        'baselineHash',
        'inventory',
        'siblingInventory',
      ],
      'result.evidence',
    );
    assertBaseEvidence(value.evidence);
    if (value.evidence.noSendAcknowledgementRequired !== true)
      throw new TypeError('publish acknowledgement requirement is invalid');
    assertSha256(value.evidence.baselineHash, 'result.evidence.baselineHash');
    assertInventory(value.evidence.inventory, value.target, false);
    assertSiblings(value.evidence.siblingInventory);
    assertSiblingProjection(
      value.evidence.inventory,
      value.evidence.siblingInventory,
      value.target,
    );
    assertTargetSibling(
      value.target,
      value.evidence.siblingInventory,
      value.evidence.baselineHash,
      false,
    );
    assertEmpty(value.blockers);
    return;
  }
  if (value.outcome === 'completed') {
    if (value.mode !== 'apply' || (status !== undefined && status !== 'success'))
      throw new TypeError('completed publish requires apply success');
    if (!record(value.evidence)) throw new TypeError('result.evidence must be an object');
    assertExactKeys(
      value.evidence,
      [
        'selectorScope',
        'includeContentReferences',
        'noSendAcknowledged',
        'baselineHash',
        'postPublishHash',
        'deploymentId',
        ...(value.evidence.publishDate === undefined ? [] : ['publishDate']),
        'inventory',
        'siblingInventory',
      ],
      'result.evidence',
    );
    assertBaseEvidence(value.evidence);
    if (value.evidence.noSendAcknowledged !== true)
      throw new TypeError('publish acknowledgement is invalid');
    assertSha256(value.evidence.baselineHash, 'result.evidence.baselineHash');
    assertSha256(value.evidence.postPublishHash, 'result.evidence.postPublishHash');
    assertNonemptyString(value.evidence.deploymentId, 'result.evidence.deploymentId');
    if (value.evidence.publishDate !== undefined)
      assertNonemptyString(value.evidence.publishDate, 'result.evidence.publishDate');
    assertInventory(value.evidence.inventory, value.target, true);
    assertSiblings(value.evidence.siblingInventory);
    assertSiblingProjection(
      value.evidence.inventory,
      value.evidence.siblingInventory,
      value.target,
    );
    assertTargetSibling(
      value.target,
      value.evidence.siblingInventory,
      value.evidence.postPublishHash,
      true,
    );
    assertNonemptyString(value.reportFile, 'result.reportFile');
    assertEmpty(value.blockers);
    return;
  }
  if (
    value.outcome !== 'ownership-uncertain' ||
    value.mode !== 'apply' ||
    (status !== undefined && status !== 'failed')
  )
    throw new TypeError('publish outcome is invalid');
  if (!record(value.evidence) || !record(value.reconciliation))
    throw new TypeError('publish reconciliation is invalid');
  assertExactKeys(
    value.evidence,
    [
      'selectorScope',
      'includeContentReferences',
      ...(value.evidence.deploymentId === undefined ? [] : ['deploymentId']),
    ],
    'result.evidence',
  );
  assertBaseEvidence(value.evidence);
  if (value.evidence.deploymentId !== undefined)
    assertNonemptyString(value.evidence.deploymentId, 'result.evidence.deploymentId');
  assertBlockers(value.blockers, 'EMAIL_PUBLISH_OWNERSHIP_UNCERTAIN');
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
  ) {
    throw new TypeError('result.reconciliation must match target and evidence');
  }
  if (value.reconciliation.deploymentId !== undefined)
    assertNonemptyString(value.reconciliation.deploymentId, 'result.reconciliation.deploymentId');
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function assertBaseEvidence(value: unknown): asserts value is Record<string, unknown> {
  if (
    !record(value) ||
    value.selectorScope !== 'variant' ||
    value.includeContentReferences !== false
  )
    throw new TypeError('result.evidence publish scope is invalid');
}
function assertSelectorTarget(
  value: unknown,
  resolved: boolean,
): asserts value is Record<string, unknown> {
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
    const variantId = item.variantId as string;
    if (ids.has(variantId))
      throw new TypeError('result.evidence.inventory contains duplicate variants');
    ids.add(variantId);
  }
  const selected = value.filter((item) => item.variantId === target.variantId);
  if (
    selected.length !== 1 ||
    selected[0].contentId !== target.contentId ||
    selected[0].language !== target.language ||
    selected[0].isPublished !== published ||
    selected[0].status !== (published ? 'Published' : 'Draft')
  ) {
    throw new TypeError('result target inventory lifecycle or identity is inconsistent');
  }
}
function assertSiblings(value: unknown): void {
  if (!Array.isArray(value) || value.length === 0)
    throw new TypeError('result.evidence.siblingInventory is invalid');
  for (const [index, sibling] of value.entries()) {
    const label = `result.evidence.siblingInventory[${index}]`;
    assertExactKeys(sibling, ['hash', 'language', 'isPublished', 'status', 'variantId'], label);
    assertSha256(sibling.hash, `${label}.hash`);
    assertNonemptyString(sibling.language, `${label}.language`);
    assertNonemptyString(sibling.status, `${label}.status`);
    assertNonemptyString(sibling.variantId, `${label}.variantId`);
    if (typeof sibling.isPublished !== 'boolean')
      throw new TypeError(`${label}.isPublished is invalid`);
  }
}
function assertSiblingProjection(
  inventory: unknown,
  siblings: unknown,
  target: Record<string, unknown>,
): void {
  const expected = (inventory as ContentPublishInventoryEntry[])
    .filter((item) => item.contentId === target.contentId)
    .map((item) => ({
      hash: item.hash,
      language: item.language,
      isPublished: item.isPublished,
      status: item.status,
      variantId: item.variantId,
    }))
    .toSorted((left, right) =>
      `${left.variantId}\0${left.language}`.localeCompare(`${right.variantId}\0${right.language}`),
    );
  const actual = [...(siblings as ContentPublishSibling[])].toSorted((left, right) =>
    `${left.variantId}\0${left.language}`.localeCompare(`${right.variantId}\0${right.language}`),
  );
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new TypeError(
      'result sibling inventory must match the target parent inventory projection',
    );
}
function assertTargetSibling(
  target: Record<string, unknown>,
  value: unknown,
  expectedHash: unknown,
  published: boolean,
): void {
  const matches = (value as Array<Record<string, unknown>>).filter(
    (sibling) => sibling.variantId === target.variantId,
  );
  if (
    matches.length !== 1 ||
    matches[0].language !== target.language ||
    matches[0].hash !== expectedHash ||
    matches[0].isPublished !== published ||
    matches[0].status !== (published ? 'Published' : 'Draft')
  ) {
    throw new TypeError('result target sibling lifecycle or identity is inconsistent');
  }
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
