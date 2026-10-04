import {
  assertDependencyDescriptor,
  assertPortableIdentity,
  assertPortablePayload,
  CMS_CAPABILITY_DECLARATIONS,
  METADATA_CAPABILITY_FIXTURE_SHA256,
  type DependencyDescriptor,
  type PortableIdentity,
  type ServerIdentity,
} from '../contracts/capability-registry.js';
import { hashCanonical, type CmsResolutionCacheScope } from '../contracts/resolution-cache.js';
import type { CmsRecord } from './read.js';
import { cmsPortableExportResult, type CmsPhase5Result } from './phase5-results.js';
import {
  lookupCmsResolutionByServerEvidence,
  refreshCmsResolutionCache,
} from './resolution-cache.js';
import {
  resolveCmsPortableIdentity,
  type PortableResolutionCandidate,
} from './portable-resolution.js';

export const PORTABLE_EXPORT_METADATA_CONTRACT = 'sf-cms-portable-export-metadata-v1' as const;
export const PORTABLE_EXPORT_METADATA_VERSION = '1.0.0' as const;

export type PortableExportCacheOptions = {
  readonly root: string;
  readonly sourceOrg: ServerIdentity;
  readonly targetOrg: ServerIdentity;
  readonly apiVersion: string;
  readonly observedAt?: string;
};

export type PortableExportMetadataOptions = {
  readonly workspaceApiName: string;
  readonly cache?: PortableExportCacheOptions;
};

export type PortableExportMetadata = {
  readonly contract: typeof PORTABLE_EXPORT_METADATA_CONTRACT;
  readonly version: typeof PORTABLE_EXPORT_METADATA_VERSION;
  readonly requestHash: string;
  readonly sourceHash: string;
  readonly roots: ReadonlyArray<{
    readonly identity: PortableIdentity;
    readonly identityHash: string;
    readonly dependencies: readonly DependencyDescriptor[];
  }>;
};

type BuildInput = {
  readonly workspaceId: string;
  readonly details: ReadonlyMap<string, CmsRecord>;
  readonly contentType: string;
  readonly apiNames: readonly string[];
  readonly pagesRequested: number;
  readonly options: PortableExportMetadataOptions;
  readonly landingPagePairs?: ReadonlyArray<{
    readonly page: { readonly apiName: string };
    readonly template: { readonly apiName: string };
  }>;
};

const PROFILES = new Map([
  ['sfdc_cms__brand', ['Brand', 'dependency-free']],
  ['sfdc_cms__consentBanner', ['Consent Banner', 'dependency-free']],
  ['sfdc_cms__email', ['Email', 'dependency-free']],
  ['sfdc_cms__emailFragment', ['Email Fragment', 'dependency-free']],
  ['sfdc_cms__landingPage', ['Landing Page', 'strict-paired-template']],
  ['sfdc_cms__landingPageTemplate', ['Landing Page Template', 'strict-image-data-graph']],
  ['sfdc_cms__preferencePage', ['Preference Page', 'strict-channel-subchannel-optional-brand']],
  ['sfdc_cms__webFragment', ['Web Fragment', 'strict-data-graph']],
] as const);

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonempty(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function contentType(record_: CmsRecord): string | undefined {
  return record(record_.contentType)
    ? (record_.contentType.fullyQualifiedName as string | undefined)
    : (record_.contentType as string | undefined);
}

function contentId(detail: CmsRecord): string | undefined {
  for (const key of ['managedContentId', 'contentId'] as const) {
    if (nonempty(detail[key])) return detail[key];
  }
  return undefined;
}

function variantId(detail: CmsRecord): string | undefined {
  for (const key of ['managedContentVariantId', 'id'] as const) {
    if (nonempty(detail[key])) return detail[key];
  }
  return undefined;
}

function folderEvidence(detail: CmsRecord): { folderId?: string; folderApiName?: string } {
  if (!record(detail.folder)) return {};
  const folderId = nonempty(detail.folder.id) ? detail.folder.id : undefined;
  const folderApiName = nonempty(detail.folder.apiName) ? detail.folder.apiName : undefined;
  return folderId === undefined || folderApiName === undefined ? {} : { folderId, folderApiName };
}

function candidate(
  workspaceId: string,
  workspaceApiName: string,
  familyType: string,
  detail: CmsRecord,
): PortableResolutionCandidate | undefined {
  const id = contentId(detail);
  const variant = variantId(detail);
  if (
    !nonempty(detail.apiName) ||
    !nonempty(detail.contentKey) ||
    id === undefined ||
    variant === undefined
  ) {
    return undefined;
  }
  return {
    workspaceId,
    workspaceApiName,
    family: 'cms',
    type: familyType,
    apiName: detail.apiName,
    ...(nonempty(detail.language) ? { language: detail.language } : {}),
    ...folderEvidence(detail),
    contentId: id,
    variantId: variant,
    contentKey: detail.contentKey,
  };
}

function serverEvidence(workspaceId: string, detail: CmsRecord) {
  const id = contentId(detail);
  const variant = variantId(detail);
  if (id === undefined || variant === undefined || !nonempty(detail.contentKey)) return;
  const folder = folderEvidence(detail);
  return {
    workspace: { kind: 'salesforce-id' as const, value: workspaceId },
    content: { kind: 'salesforce-id' as const, value: id },
    variant: { kind: 'salesforce-id' as const, value: variant },
    contentKey: { kind: 'content-key' as const, value: detail.contentKey },
    ...(folder.folderId === undefined
      ? {}
      : { folder: { kind: 'salesforce-id' as const, value: folder.folderId } }),
  };
}

function scope(
  cache: PortableExportCacheOptions,
  profile: (typeof CMS_CAPABILITY_DECLARATIONS)[number],
  workspaceApiName: string,
): CmsResolutionCacheScope {
  return {
    sourceOrg: cache.sourceOrg,
    targetOrg: cache.targetOrg,
    provider: profile.providerContract.name,
    apiVersion: cache.apiVersion,
    capabilityContract: 'sf-metadata-capability-v1',
    capabilityFixtureSha256: METADATA_CAPABILITY_FIXTURE_SHA256,
    declaration: profile.identity,
    nativeWorkspace: {
      kind: profile.nativeScope.kind,
      root: profile.nativeScope.root,
      workspaceApiName,
    },
  };
}

function portableTarget(
  family: string,
  type: string,
  apiName: string,
  context?: Record<string, string>,
): PortableIdentity {
  const identity: PortableIdentity = {
    family,
    type,
    apiName,
    ...(context === undefined ? {} : { context }),
  };
  assertPortableIdentity(identity);
  return identity;
}

function dataGraphDependencies(
  source: PortableIdentity,
  detail: CmsRecord,
): DependencyDescriptor[] {
  const body = detail.contentBody;
  if (!record(body) || !Array.isArray(body['lightning:dataProviders'])) {
    throw new TypeError('Portable Data Graph dependency evidence is incomplete');
  }
  return body['lightning:dataProviders'].map((raw, index) => {
    if (
      !record(raw) ||
      raw.definition !== 'sfdc_cms__dataGraphDataProvider' ||
      raw.sfdcExpressionKey !== '$dataGraph' ||
      !record(raw.attributes) ||
      Object.keys(raw.attributes).toSorted().join('\0') !==
        ['dataGraphApiName', 'dataspace'].toSorted().join('\0') ||
      !nonempty(raw.attributes.dataGraphApiName) ||
      !nonempty(raw.attributes.dataspace)
    ) {
      throw new TypeError('Portable Data Graph dependency shape is unsupported');
    }
    return {
      kind: 'data-graph',
      source,
      target: portableTarget('data-cloud', 'Data Graph', raw.attributes.dataGraphApiName, {
        dataSpace: raw.attributes.dataspace,
      }),
      required: true,
      resolution: 'target' as const,
      originPath: `contentBody.lightning:dataProviders[${index}]`,
    };
  });
}

function imageContentKeys(value: unknown, found = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const child of value) imageContentKeys(child, found);
    return found;
  }
  if (!record(value)) return found;
  if ('ref' in value || (typeof value.type === 'string' && value.type.endsWith('Reference'))) {
    if (
      value.type !== 'imageReference' ||
      !record(value.ref) ||
      Object.keys(value.ref).length !== 1 ||
      !nonempty(value.ref.contentKey)
    ) {
      throw new TypeError('Portable CMS dependency shape is unsupported');
    }
    found.add(value.ref.contentKey);
  }
  for (const child of Object.values(value)) imageContentKeys(child, found);
  return found;
}

function imageDependencies(
  source: PortableIdentity,
  detail: CmsRecord,
  details: ReadonlyMap<string, CmsRecord>,
): DependencyDescriptor[] {
  return [...imageContentKeys(detail.contentBody)].toSorted().map((contentKey) => {
    const matches = [...details.values()].filter(
      (candidateDetail) =>
        candidateDetail.contentKey === contentKey &&
        contentType(candidateDetail) === 'sfdc_cms__image' &&
        nonempty(candidateDetail.apiName),
    );
    if (matches.length !== 1)
      throw new TypeError('Portable image dependency evidence is incomplete');
    return {
      kind: 'cms-image',
      source,
      target: portableTarget(
        'cms',
        'Image',
        matches[0].apiName as string,
        source.context as Record<string, string>,
      ),
      required: true,
      resolution: 'either' as const,
    };
  });
}

function dependencies(
  profileType: string,
  source: PortableIdentity,
  detail: CmsRecord,
  input: BuildInput,
): DependencyDescriptor[] {
  if (['Brand', 'Consent Banner', 'Email', 'Email Fragment'].includes(profileType)) return [];
  if (profileType === 'Web Fragment') {
    const graphs = dataGraphDependencies(source, detail);
    if (graphs.length === 0)
      throw new TypeError('Portable Web Fragment Data Graph is not evidenced');
    return graphs;
  }
  if (profileType === 'Landing Page Template') {
    const graphs = dataGraphDependencies(source, detail);
    const images = imageDependencies(source, detail, input.details);
    if (graphs.length === 0 && images.length === 0) {
      throw new TypeError('Portable landing-page-template dependencies are not evidenced');
    }
    return [...images, ...graphs];
  }
  if (profileType === 'Landing Page') {
    const pair = input.landingPagePairs?.filter(({ page }) => page.apiName === detail.apiName);
    if (pair?.length !== 1)
      throw new TypeError('Portable landing-page template evidence is incomplete');
    const images = imageDependencies(source, detail, input.details);
    const graphs = dataGraphDependencies(source, detail);
    if (images.length === 0 || graphs.length === 0) {
      throw new TypeError('Portable landing-page dependencies are not fully evidenced');
    }
    return [
      {
        kind: 'landing-page-template',
        source,
        target: portableTarget(
          'cms',
          'Landing Page Template',
          pair[0].template.apiName,
          source.context as Record<string, string>,
        ),
        required: true,
        resolution: 'package',
      },
      ...images,
      ...graphs,
    ];
  }
  throw new TypeError('Portable Preference Page dependency identities are not fully evidenced');
}

export type PreparedPortableExportMetadata = {
  readonly metadata: PortableExportMetadata;
  readonly refreshCache: () => Promise<CmsPhase5Result>;
};

export async function buildPortableExportMetadata(
  input: BuildInput,
): Promise<PreparedPortableExportMetadata | undefined> {
  const profileShape = PROFILES.get(input.contentType as Parameters<(typeof PROFILES)['get']>[0]);
  if (profileShape === undefined || !nonempty(input.options.workspaceApiName)) return undefined;
  const [profileType, profileName] = profileShape;
  const declaration = CMS_CAPABILITY_DECLARATIONS.find(
    ({ identity }) => identity.type === profileType && identity.profile === profileName,
  );
  if (declaration === undefined) return undefined;
  const typedDetails = [...input.details.values()].filter(
    (detail) => contentType(detail) === input.contentType,
  );
  const candidates = typedDetails.flatMap((detail) => {
    const value = candidate(input.workspaceId, input.options.workspaceApiName, profileType, detail);
    return value === undefined ? [] : [value];
  });
  if (candidates.length !== typedDetails.length) return undefined;
  const sourceEvidence = { contentType: input.contentType, details: typedDetails };
  const sourceEvidenceHash = hashCanonical(sourceEvidence);
  const roots: PortableExportMetadata['roots'][number][] = [];
  const pendingRefreshes: Array<() => Promise<boolean>> = [];
  let cacheHits = 0;
  let cacheMisses = 0;
  for (const apiName of [...input.apiNames].toSorted()) {
    const matches = typedDetails.filter((detail) => detail.apiName === apiName);
    if (matches.length !== 1) return undefined;
    const detail = matches[0];
    const evidence = serverEvidence(input.workspaceId, detail);
    if (evidence === undefined) return undefined;
    const cacheScope =
      input.options.cache === undefined
        ? undefined
        : scope(input.options.cache, declaration, input.options.workspaceApiName);
    const cacheHit =
      cacheScope === undefined
        ? undefined
        : await lookupCmsResolutionByServerEvidence(
            input.options.cache!.root,
            cacheScope,
            evidence,
          );
    const currentCacheHit = cacheHit?.sourceHash === sourceEvidenceHash ? cacheHit : undefined;
    if (cacheScope !== undefined) {
      if (currentCacheHit === undefined) cacheMisses += 1;
      else cacheHits += 1;
    }
    let identity = currentCacheHit?.entry.portableIdentity;
    if (identity === undefined) {
      const folder = folderEvidence(detail);
      const result = resolveCmsPortableIdentity({
        profile: declaration.identity,
        workspace: { workspaceApiName: input.options.workspaceApiName },
        family: 'cms',
        type: profileType,
        apiName,
        ...(folder.folderApiName === undefined ? {} : { folderApiName: folder.folderApiName }),
        ...(nonempty(detail.language) ? { language: detail.language } : {}),
        usage: {
          strategy: declaration.retrieval.strategy,
          calls: input.pagesRequested + input.details.size,
          items: input.details.size,
          pages: input.pagesRequested,
        },
        candidates,
      });
      if (!result.available) return undefined;
      identity = result.portableIdentity;
      if (cacheScope !== undefined) {
        pendingRefreshes.push(async () => {
          const refreshed = await refreshCmsResolutionCache({
            cacheRoot: input.options.cache!.root,
            scope: cacheScope,
            observedAt: input.options.cache!.observedAt,
            resolve: async () => ({
              result,
              sourceEvidence,
              complete: true,
              ownershipCertain: true,
            }),
          });
          return refreshed !== undefined;
        });
      }
    }
    const edges = dependencies(profileType, identity, detail, input).toSorted((left, right) =>
      hashCanonical(left).localeCompare(hashCanonical(right)),
    );
    for (const edge of edges) assertDependencyDescriptor(edge);
    roots.push({ identity, identityHash: hashCanonical(identity), dependencies: edges });
  }
  const metadata: PortableExportMetadata = {
    contract: PORTABLE_EXPORT_METADATA_CONTRACT,
    version: PORTABLE_EXPORT_METADATA_VERSION,
    requestHash: hashCanonical({
      contentType: input.contentType,
      apiNames: [...input.apiNames].toSorted(),
    }),
    sourceHash: hashCanonical(typedDetails),
    roots: roots.toSorted((left, right) => left.identityHash.localeCompare(right.identityHash)),
  };
  assertPortablePayload(metadata);
  return {
    metadata,
    refreshCache: async () => {
      let cacheRefreshes = 0;
      for (const refresh of pendingRefreshes) {
        if (await refresh()) cacheRefreshes += 1;
      }
      return cmsPortableExportResult(metadata, {
        inventoryPages: input.pagesRequested,
        detailItems: input.details.size,
        cacheHits,
        cacheMisses,
        cacheRefreshes,
      });
    },
  };
}

export function serializePortableExportMetadata(value: PortableExportMetadata): string {
  assertPortableExportMetadata(value);
  return `${JSON.stringify(sortJson(value), undefined, 2)}\n`;
}

/**
 * Reject unknown portable v1 fields and invalid identity/hash/dependency bindings.
 * @param {unknown} value - Decoded portable metadata.
 */
export function assertPortableExportMetadata(
  value: unknown,
): asserts value is PortableExportMetadata {
  const metadata = exactRecord(value, [
    'contract',
    'version',
    'requestHash',
    'sourceHash',
    'roots',
  ]);
  if (
    metadata.contract !== PORTABLE_EXPORT_METADATA_CONTRACT ||
    metadata.version !== PORTABLE_EXPORT_METADATA_VERSION
  )
    throw new TypeError('Unsupported portable metadata contract/version');
  for (const name of ['requestHash', 'sourceHash']) {
    if (typeof metadata[name] !== 'string' || !/^[a-f\d]{64}$/u.test(metadata[name]))
      throw new TypeError('Invalid portable metadata hash');
  }
  if (!Array.isArray(metadata.roots)) throw new TypeError('Invalid portable roots');
  const hashes = new Set<string>();
  for (const raw of metadata.roots) {
    const root = exactRecord(raw, ['identity', 'identityHash', 'dependencies']);
    assertPortableIdentity(root.identity);
    const hash = hashCanonical(root.identity);
    if (root.identityHash !== hash || hashes.has(hash))
      throw new TypeError('Invalid or duplicate portable root hash');
    hashes.add(hash);
    if (!Array.isArray(root.dependencies)) throw new TypeError('Invalid portable dependencies');
    for (const edge of root.dependencies) {
      assertDependencyDescriptor(edge);
      if (hashCanonical(edge.source) !== hash)
        throw new TypeError('Portable dependency source binding mismatch');
    }
  }
  assertPortablePayload(value);
}

function exactRecord(value: unknown, keys: string[]): Record<string, unknown> {
  if (!record(value) || Object.keys(value).toSorted().join('\0') !== keys.toSorted().join('\0'))
    throw new TypeError('Unknown or missing portable metadata fields');
  return value;
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => sortJson(item));
  if (!record(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .toSorted()
      .map((key) => [key, sortJson(value[key])]),
  );
}
