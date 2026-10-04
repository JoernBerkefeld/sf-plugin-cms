import {
  assertPortableIdentity,
  type PortableIdentity,
  type ServerIdentity,
} from '../contracts/capability-registry.js';
import {
  assertStrategyUsage,
  lookupCmsCapability,
  qualifyCmsDependencyFreeProfile,
  type CapabilityProfileIdentity,
  type StrategyUsage,
} from './capability-registry.js';

export type PortableWorkspaceContext = {
  readonly workspaceApiName: string;
};

export type PortableResolutionRequest = {
  readonly profile: CapabilityProfileIdentity;
  readonly workspace: PortableWorkspaceContext;
  readonly family: string;
  readonly type: string;
  readonly apiName: string;
  readonly folderApiName?: string;
  readonly language?: string;
  readonly usage: StrategyUsage;
  readonly candidates: readonly PortableResolutionCandidate[];
};

export type PortableResolutionCandidate = {
  readonly workspaceId: string;
  readonly workspaceApiName: string;
  readonly family: string;
  readonly type: string;
  readonly apiName: string;
  readonly folderId?: string;
  readonly folderApiName?: string;
  readonly language?: string;
  readonly contentId: string;
  readonly variantId: string;
  readonly contentKey: string;
  readonly detail?: unknown;
};

export type PortableResolutionEvidence = {
  readonly workspace: ServerIdentity;
  readonly content: ServerIdentity;
  readonly variant: ServerIdentity;
  readonly contentKey: ServerIdentity;
  readonly folder?: ServerIdentity;
};

export type PortableResolutionResult =
  | {
      readonly available: false;
      readonly reason:
        'unknown-profile' | 'operation-blocked' | 'incomplete-context' | 'ambiguous-identity';
    }
  | {
      readonly available: true;
      readonly portableIdentity: PortableIdentity;
      readonly evidence: PortableResolutionEvidence;
    };

const languageTypes = new Set(['Email', 'Email Fragment', 'Email Template', 'Form Handler']);

function qualifiedDetailMatches(candidate: PortableResolutionCandidate): boolean {
  const detail = candidate.detail as Record<string, unknown> | undefined;
  if (detail === undefined) return false;
  const space = detail.contentSpace as Record<string, unknown> | undefined;
  const folder = detail.folder as Record<string, unknown> | undefined;
  if (
    (candidate.folderApiName !== undefined || candidate.folderId !== undefined) &&
    (folder?.id !== candidate.folderId || folder?.apiName !== candidate.folderApiName)
  )
    return false;
  return (
    detail.apiName === candidate.apiName &&
    detail.language === candidate.language &&
    detail.contentKey === candidate.contentKey &&
    (detail.managedContentId ?? detail.contentId) === candidate.contentId &&
    (detail.managedContentVariantId ?? detail.id) === candidate.variantId &&
    space?.id === candidate.workspaceId
  );
}

function nonempty(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/**
 * Resolve one exact evidenced CMS item to portable identity before persistence.
 * @param {PortableResolutionRequest} request - Exact portable context, profile, usage, and server candidates.
 * @returns {PortableResolutionResult} Portable identity separated from typed server evidence.
 */
export function resolveCmsPortableIdentity(
  request: PortableResolutionRequest,
): PortableResolutionResult {
  const capability = lookupCmsCapability(request.profile, 'retrieve');
  if (!capability.available) return capability;
  assertStrategyUsage(capability.declaration.retrieval, request.usage);

  if (
    request.profile.family !== request.family ||
    request.profile.type !== request.type ||
    !nonempty(request.workspace.workspaceApiName) ||
    !nonempty(request.apiName) ||
    (languageTypes.has(request.type) && !nonempty(request.language))
  ) {
    return { available: false, reason: 'incomplete-context' };
  }

  const identityMatches = request.candidates.filter(
    (candidate) =>
      candidate.workspaceApiName === request.workspace.workspaceApiName &&
      candidate.family === request.family &&
      candidate.type === request.type &&
      candidate.apiName === request.apiName,
  );
  if (
    (request.folderApiName === undefined &&
      identityMatches.some((candidate) => candidate.folderApiName !== undefined)) ||
    (request.language === undefined &&
      identityMatches.some((candidate) => candidate.language !== undefined))
  ) {
    return { available: false, reason: 'incomplete-context' };
  }
  const matches = identityMatches.filter(
    (candidate) =>
      (request.folderApiName === undefined || candidate.folderApiName === request.folderApiName) &&
      (request.language === undefined || candidate.language === request.language),
  );
  if (matches.length !== 1) return { available: false, reason: 'ambiguous-identity' };
  const match = matches[0];
  if (
    ['Email Template', 'Form Handler'].includes(request.type) &&
    (!qualifyCmsDependencyFreeProfile(request.profile, match.detail) ||
      !qualifiedDetailMatches(match))
  )
    return { available: false, reason: 'unknown-profile' };
  if (
    !nonempty(match.workspaceId) ||
    !nonempty(match.contentId) ||
    !nonempty(match.variantId) ||
    !nonempty(match.contentKey) ||
    (request.folderApiName !== undefined && !nonempty(match.folderId))
  ) {
    return { available: false, reason: 'incomplete-context' };
  }

  const context = {
    workspaceApiName: request.workspace.workspaceApiName,
    ...(request.folderApiName === undefined ? {} : { folderApiName: request.folderApiName }),
    ...(request.language === undefined ? {} : { language: request.language }),
  };
  const portableIdentity: PortableIdentity = {
    family: request.family,
    type: request.type,
    apiName: request.apiName,
    context,
  };
  assertPortableIdentity(portableIdentity);
  return {
    available: true,
    portableIdentity,
    evidence: {
      workspace: { kind: 'salesforce-id', value: match.workspaceId },
      content: { kind: 'salesforce-id', value: match.contentId },
      variant: { kind: 'salesforce-id', value: match.variantId },
      contentKey: { kind: 'content-key', value: match.contentKey },
      ...(match.folderId === undefined
        ? {}
        : { folder: { kind: 'salesforce-id' as const, value: match.folderId } }),
    },
  };
}
