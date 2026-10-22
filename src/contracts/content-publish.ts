import {
  assertExactKeys,
  assertNonemptyString,
  assertOpaqueCmsReference,
  assertSha256,
  type CmsStatus,
  type OpaqueCmsReference,
} from './shared.js';

export type QualifiedNativePublishType =
  'sfdc_cms__emailTemplate' | 'sfdc_cms__image' | 'sfdc_cms__document' | 'sfdc_cms__audio';
type NativePublishObservation = {
  isPublished: boolean;
  status: { label: string; status: string };
};
export type ContentPublishNativeEvidence = {
  contentType: QualifiedNativePublishType;
  identity: ContentPublishTarget & { contentType: QualifiedNativePublishType; contentKey: string };
  canonicalAuthoringHash: string;
  parentLifecycle: NativePublishObservation;
  variantLifecycle: NativePublishObservation;
  references: readonly OpaqueCmsReference[];
  mediaReceipt?: { sha256: string; size: number; mimeType: string };
};

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

export type ContentLifecycleLocalOutcome =
  | { outcome: 'noop'; reason: 'missing-copy' | 'retrieval-equivalent' }
  | { outcome: 'blocked'; message: string };

export type ContentPublishResult =
  | {
      mode: 'apply';
      outcome: 'remote-completed-local-blocked';
      target: ContentPublishTarget;
      evidence: Extract<ContentPublishResult, { outcome: 'completed' }>['evidence'];
      blockers: readonly [{ code: 'EMAIL_PUBLISH_LOCAL_BLOCKED'; message: string }];
      reportFile: string;
      localSource: Extract<ContentLifecycleLocalOutcome, { outcome: 'blocked' }>;
      localReportFile?: string;
    }
  | {
      mode: 'dry-run';
      outcome: 'ready';
      target: ContentPublishTarget;
      evidence: {
        selectorScope: 'variant';
        includeContentReferences: false;
        noSendAcknowledgementRequired: true;
        baselineHash: string;
        nativeEvidence?: ContentPublishNativeEvidence;
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
        nativeEvidence?: ContentPublishNativeEvidence;
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
  if (value.outcome === 'remote-completed-local-blocked') {
    assertExactKeys(
      value,
      [
        'mode',
        'outcome',
        'target',
        'evidence',
        'blockers',
        'reportFile',
        'localSource',
        ...(Object.hasOwn(value, 'localReportFile') ? ['localReportFile'] : []),
      ],
      'result',
    );
    if (status !== undefined && status !== 'partial')
      throw new TypeError('Local blocked publish requires partial status');
    assertExactKeys(value.localSource, ['outcome', 'message'], 'result.localSource');
    const local = value.localSource as Record<string, unknown>;
    if (local.outcome !== 'blocked') throw new TypeError('Local publish outcome must be blocked');
    assertNonemptyString(local.message, 'result.localSource.message');
    assertBlockers(value.blockers, 'EMAIL_PUBLISH_LOCAL_BLOCKED');
    if ((value.blockers as Array<{ message: string }>)[0].message !== local.message)
      throw new TypeError('Local publish blocker must match outcome');
    if (Object.hasOwn(value, 'localReportFile'))
      assertNonemptyString(value.localReportFile, 'result.localReportFile');
    assertContentPublishResult(
      {
        mode: value.mode,
        outcome: 'completed',
        target: value.target,
        evidence: value.evidence,
        blockers: [],
        reportFile: value.reportFile,
      },
      undefined,
      'success',
    );
    return;
  }
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
        ...(record(value.evidence) && 'nativeEvidence' in value.evidence ? ['nativeEvidence'] : []),
        'inventory',
        'siblingInventory',
      ],
      'result.evidence',
    );
    assertBaseEvidence(value.evidence);
    if (value.evidence.noSendAcknowledgementRequired !== true)
      throw new TypeError('publish acknowledgement requirement is invalid');
    assertSha256(value.evidence.baselineHash, 'result.evidence.baselineHash');
    if ('nativeEvidence' in value.evidence)
      assertNativePublishEvidence(
        value.evidence.nativeEvidence,
        value.target,
        value.evidence.baselineHash,
        false,
      );
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
        ...(record(value.evidence) && 'nativeEvidence' in value.evidence ? ['nativeEvidence'] : []),
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
    if ('nativeEvidence' in value.evidence)
      assertNativePublishEvidence(
        value.evidence.nativeEvidence,
        value.target,
        value.evidence.baselineHash,
        value.outcome === 'completed',
      );
    assertSha256(value.evidence.postPublishHash, 'result.evidence.postPublishHash');
    if (
      'nativeEvidence' in value.evidence &&
      value.evidence.postPublishHash !== value.evidence.baselineHash
    )
      throw new TypeError('Native publish must preserve the authoring hash');
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

export function assertNativePublishEvidence(
  value: unknown,
  target: Record<string, unknown>,
  baselineHash: unknown,
  published: boolean,
): void {
  if (!record(value)) throw new TypeError('Native publish evidence must be an object');
  const media = value.contentType !== 'sfdc_cms__emailTemplate';
  if (
    ![
      'sfdc_cms__emailTemplate',
      'sfdc_cms__image',
      'sfdc_cms__document',
      'sfdc_cms__audio',
    ].includes(value.contentType as string)
  )
    throw new TypeError('Native publish family is not qualified');
  assertExactKeys(
    value,
    [
      'contentType',
      'identity',
      'canonicalAuthoringHash',
      'parentLifecycle',
      'variantLifecycle',
      'references',
      ...(media ? ['mediaReceipt'] : []),
    ],
    'nativeEvidence',
  );
  assertExactKeys(
    value.identity,
    ['workspaceId', 'apiName', 'language', 'contentId', 'variantId', 'contentType', 'contentKey'],
    'nativeEvidence.identity',
  );
  const identity = value.identity as Record<string, unknown>;
  for (const key of Object.keys(target)) {
    if (identity[key] !== target[key])
      throw new TypeError('Native publish identity must match target');
  }
  assertNonemptyString(identity.contentKey, 'nativeEvidence.identity.contentKey');
  if (identity.contentType !== value.contentType || identity.contentId === identity.variantId)
    throw new TypeError('Native publish identity family or variant is inconsistent');
  assertSha256(value.canonicalAuthoringHash, 'nativeEvidence.canonicalAuthoringHash');
  if (value.canonicalAuthoringHash !== baselineHash)
    throw new TypeError('Native publish authoring hash must match baseline');
  for (const key of ['parentLifecycle', 'variantLifecycle']) {
    const observation = value[key];
    assertExactKeys(observation, ['isPublished', 'status'], `nativeEvidence.${key}`);
    const life = observation as Record<string, unknown>;
    assertExactKeys(life.status, ['label', 'status'], `nativeEvidence.${key}.status`);
    const status = life.status as Record<string, unknown>;
    assertNonemptyString(status.label, `nativeEvidence.${key}.status.label`);
    if (life.isPublished !== published || status.status !== (published ? 'Published' : 'Draft'))
      throw new TypeError('Native publish lifecycle is inconsistent');
  }
  if (!Array.isArray(value.references) || value.references.length !== 1)
    throw new TypeError('Native publish requires one included identity reference');
  const reference: unknown = value.references[0];
  assertOpaqueCmsReference(reference, 'nativeEvidence.references[0]');
  if (
    reference.kind !== 'cms.content' ||
    reference.owner !== 'cms' ||
    reference.resolution !== 'included' ||
    reference.required !== true ||
    reference.source.workspaceId !== target.workspaceId ||
    reference.source.sourceId !== target.contentId ||
    reference.portableKey.scheme !== 'cms-opaque-v1' ||
    reference.portableKey.value !== identity.contentKey
  )
    throw new TypeError('Native publish reference must bind selected identity');
  if (media) {
    assertExactKeys(
      value.mediaReceipt,
      ['sha256', 'size', 'mimeType'],
      'nativeEvidence.mediaReceipt',
    );
    const receipt = value.mediaReceipt as Record<string, unknown>;
    assertSha256(receipt.sha256, 'nativeEvidence.mediaReceipt.sha256');
    assertNonemptyString(receipt.mimeType, 'nativeEvidence.mediaReceipt.mimeType');
    if (!Number.isSafeInteger(receipt.size) || (receipt.size as number) <= 0)
      throw new TypeError('Native publish media size is invalid');
  }
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
