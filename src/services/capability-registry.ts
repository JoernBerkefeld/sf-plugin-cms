import {
  assertCapabilityDeclaration,
  CMS_CAPABILITY_DECLARATIONS,
  type CapabilityDeclaration,
  type RetrievalStrategy,
  type StrategyDeclaration,
} from '../contracts/capability-registry.js';

import { assertNativeBody, decodeNativeHtml, safeNativeRawHtml } from './import-identities.js';
import { normalizeFormHandler } from './form-handler.js';
import type { WorkspaceImportItem } from './import-workspace.js';

/**
 * Qualify only the evidenced dependency-free Template and empty-root Handler bodies.
 * @param {CapabilityDeclaration['identity']} identity - Exact canonical profile identity.
 * @param {unknown} detail - Candidate CMS detail envelope.
 * @returns {boolean} Whether the evidenced dependency-free profile is satisfied.
 */
export function qualifyCmsDependencyFreeProfile(
  identity: CapabilityDeclaration['identity'],
  detail: unknown,
): boolean {
  if (!lookupCmsCapability(identity).available) return false;
  if (identity.type === 'Form Handler' && identity.profile === 'strict-empty-root')
    return normalizeFormHandler(detail) !== null;
  if (identity.type !== 'Email Template' || identity.profile !== 'dependency-free') return false;
  if (typeof detail !== 'object' || detail === null || Array.isArray(detail)) return false;
  const item = detail as Record<string, unknown>;
  const type =
    typeof item.contentType === 'object' && item.contentType !== null
      ? (item.contentType as Record<string, unknown>).fullyQualifiedName
      : item.contentType;
  if (
    type !== 'sfdc_cms__emailTemplate' ||
    typeof item.contentBody !== 'object' ||
    item.contentBody === null ||
    Array.isArray(item.contentBody)
  )
    return false;
  try {
    const contentBody = structuredClone(item.contentBody) as Record<string, unknown>;
    if (typeof contentBody.rawHtml === 'string')
      contentBody.rawHtml = decodeNativeHtml(contentBody.rawHtml);
    // Phase 5 dependency-free qualification cannot inherit the native-copy opaque HTML bypass.
    if (typeof contentBody.rawHtml !== 'string' || !safeNativeRawHtml(contentBody.rawHtml))
      return false;
    assertNativeBody({ ...item, contentType: type, contentBody } as WorkspaceImportItem);
    return true;
  } catch {
    return false;
  }
}

export type CapabilityProfileIdentity = CapabilityDeclaration['identity'];

export type CapabilityLookupResult =
  | { readonly available: true; readonly declaration: CapabilityDeclaration }
  | {
      readonly available: false;
      readonly reason: 'unknown-profile' | 'operation-blocked';
    };

export type StrategyUsage = {
  readonly strategy: RetrievalStrategy;
  readonly calls: number;
  readonly items: number;
  readonly pages: number;
};

/**
 * Look up one exact CMS capability profile from the canonical declarations.
 * @param {CapabilityProfileIdentity} identity - Exact provider, family, type, and profile identity.
 * @param {'retrieve' | 'resolve'} operation - Operation required by the caller.
 * @returns {CapabilityLookupResult} The declaration or an explicit unavailable result.
 */
export function lookupCmsCapability(
  identity: CapabilityProfileIdentity,
  operation: 'retrieve' | 'resolve' = 'retrieve',
): CapabilityLookupResult {
  const matches = CMS_CAPABILITY_DECLARATIONS.filter(
    ({ identity: candidate }) =>
      candidate.provider === identity.provider &&
      candidate.family === identity.family &&
      candidate.type === identity.type &&
      candidate.profile === identity.profile,
  );
  if (matches.length !== 1) return { available: false, reason: 'unknown-profile' };
  const declaration = matches[0];
  assertCapabilityDeclaration(declaration);
  if (!declaration.operations.includes(operation)) {
    return { available: false, reason: 'operation-blocked' };
  }
  return { available: true, declaration };
}

/**
 * Enforce an exact declared strategy and its hard bounds.
 * @param {StrategyDeclaration} declaration - Canonical strategy declaration.
 * @param {StrategyUsage} usage - Boundary usage claimed by the resolver.
 * @returns {void}
 */
export function assertStrategyUsage(declaration: StrategyDeclaration, usage: StrategyUsage): void {
  if (usage.strategy !== declaration.strategy) {
    throw new TypeError(`Retrieval strategy must be ${declaration.strategy}`);
  }
  const boundedUsage = {
    maxCalls: usage.calls,
    maxItems: usage.items,
    maxPages: usage.pages,
  };
  for (const key of ['maxCalls', 'maxItems', 'maxPages'] as const) {
    const actual = boundedUsage[key];
    const maximum = declaration.hardBounds[key];
    if (!Number.isSafeInteger(actual) || actual < 0 || actual > maximum) {
      throw new TypeError(`Retrieval ${key} exceeds the declared hard bound of ${maximum}`);
    }
  }
}
