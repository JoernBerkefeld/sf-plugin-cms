import { createHash } from 'node:crypto';
import type { OpaqueCmsReference } from '../contracts/shared.js';
import type { CmsRecord } from './read.js';
import { variantIdentity } from './variant-identity.js';

export type ExportReferenceWarning = {
  code: 'REFERENCE_UNRESOLVED' | 'REFERENCE_UNSUPPORTED';
  message: string;
  variantIds: string[];
};

export type ExportReferenceInventory = {
  dependencies: string[];
  externalReferences: OpaqueCmsReference[];
  itemReferenceIds: ReadonlyMap<string, string>;
  warnings: ExportReferenceWarning[];
};

type ReferenceCandidate = {
  contentId?: string;
  contentKey: string;
  variantId: string;
};

function nonemptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function referenceId(workspaceId: string, kind: string, sourceId: string): string {
  const identity = JSON.stringify({ kind, sourceId, workspaceId });
  return `ref:${createHash('sha256').update(identity).digest('hex')}`;
}

function containsCmsContentBodyReference(value: unknown): boolean {
  if (Array.isArray(value)) return value.some((item_) => containsCmsContentBodyReference(item_));
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  if (
    typeof record.ref === 'object' &&
    record.ref !== null &&
    nonemptyString((record.ref as Record<string, unknown>).contentKey)
  ) {
    return true;
  }
  return Object.values(record).some((item_) => containsCmsContentBodyReference(item_));
}

function compareReferences(left: OpaqueCmsReference, right: OpaqueCmsReference): number {
  return [left.kind, left.referenceId, left.portableKey.value]
    .join('\u0000')
    .localeCompare([right.kind, right.referenceId, right.portableKey.value].join('\u0000'));
}

/**
 * Inventories only the CMS content identity fields retained in exported variant payloads.
 * Unknown payload fields are deliberately not interpreted as relationships.
 * @param {string} workspaceId - Canonical source CMS workspace identifier.
 * @param {ReadonlyMap<string, CmsRecord>} details - Exported variants keyed by variant ID.
 * @returns {ExportReferenceInventory} Deterministic included and unresolved reference evidence.
 */
export function inventoryExportReferences(
  workspaceId: string,
  details: ReadonlyMap<string, CmsRecord>,
): ExportReferenceInventory {
  const candidates: ReferenceCandidate[] = [];
  const externalReferences: OpaqueCmsReference[] = [];
  const itemReferenceIds = new Map<string, string>();
  const warnings: ExportReferenceWarning[] = [];
  const includedById = new Map<string, OpaqueCmsReference>();
  for (const [variantId, detail] of details) {
    if (
      'references' in detail ||
      'referencesList' in detail ||
      containsCmsContentBodyReference(detail.contentBody)
    ) {
      const id = referenceId(workspaceId, 'cms.relationship', variantId);
      externalReferences.push({
        referenceId: id,
        owner: 'cms',
        kind: 'cms.relationship',
        source: { workspaceId, sourceId: variantId },
        portableKey: { scheme: 'cms-opaque-v1', value: variantId },
        required: true,
        resolution: 'unsupported',
      });
      warnings.push({
        code: 'REFERENCE_UNSUPPORTED',
        message:
          'The exported CMS payload contains a relationship class without an evidenced portable resolver.',
        variantIds: [variantId],
      });
    }
    const identity = variantIdentity(detail, variantId);
    if (!nonemptyString(detail.contentKey)) continue;
    candidates.push({
      contentId: identity.contentId,
      contentKey: detail.contentKey,
      variantId,
    });
  }

  const idsByKey = new Map<string, Set<string>>();
  const keysById = new Map<string, Set<string>>();
  const incompleteKeys = new Set<string>();
  for (const candidate of candidates) {
    if (candidate.contentId === undefined) {
      incompleteKeys.add(candidate.contentKey);
      continue;
    }
    const ids = idsByKey.get(candidate.contentKey) ?? new Set<string>();
    ids.add(candidate.contentId);
    idsByKey.set(candidate.contentKey, ids);
    const keys = keysById.get(candidate.contentId) ?? new Set<string>();
    keys.add(candidate.contentKey);
    keysById.set(candidate.contentId, keys);
  }

  for (const candidate of candidates.toSorted((left, right) =>
    left.variantId.localeCompare(right.variantId),
  )) {
    const conflicting =
      candidate.contentId !== undefined &&
      ((idsByKey.get(candidate.contentKey)?.size ?? 0) > 1 ||
        incompleteKeys.has(candidate.contentKey) ||
        (keysById.get(candidate.contentId)?.size ?? 0) > 1);
    if (conflicting) {
      const id = referenceId(workspaceId, 'cms.unknown', candidate.variantId);
      externalReferences.push({
        referenceId: id,
        owner: 'cms',
        kind: 'cms.unknown',
        source: { workspaceId, sourceId: candidate.variantId },
        portableKey: { scheme: 'cms-opaque-v1', value: candidate.contentKey },
        required: true,
        resolution: 'unsupported',
      });
      warnings.push({
        code: 'REFERENCE_UNSUPPORTED',
        message: 'A CMS content reference has conflicting retained identity evidence.',
        variantIds: [candidate.variantId],
      });
      continue;
    }

    if (candidate.contentId === undefined) {
      const id = referenceId(workspaceId, 'cms.unknown', candidate.variantId);
      externalReferences.push({
        referenceId: id,
        owner: 'cms',
        kind: 'cms.unknown',
        source: { workspaceId, sourceId: candidate.variantId },
        portableKey: { scheme: 'cms-opaque-v1', value: candidate.contentKey },
        required: true,
        resolution: 'unresolved',
      });
      warnings.push({
        code: 'REFERENCE_UNRESOLVED',
        message: 'A CMS content reference lacks retained canonical content identity.',
        variantIds: [candidate.variantId],
      });
      continue;
    }

    const id = referenceId(workspaceId, 'cms.content', candidate.contentId);
    itemReferenceIds.set(candidate.variantId, id);
    if (!includedById.has(candidate.contentId)) {
      includedById.set(candidate.contentId, {
        referenceId: id,
        owner: 'cms',
        kind: 'cms.content',
        source: { workspaceId, sourceId: candidate.contentId },
        portableKey: { scheme: 'cms-opaque-v1', value: candidate.contentKey },
        required: true,
        resolution: 'included',
      });
    }
  }

  externalReferences.push(...includedById.values());
  externalReferences.sort(compareReferences);
  warnings.sort((left, right) =>
    [left.code, left.variantIds.join('\u0000')]
      .join('\u0000')
      .localeCompare([right.code, right.variantIds.join('\u0000')].join('\u0000')),
  );

  return {
    dependencies: [],
    externalReferences,
    itemReferenceIds,
    warnings,
  };
}
