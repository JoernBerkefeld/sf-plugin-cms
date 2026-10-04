import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  assertCmsResolutionCacheFile,
  createCmsResolutionCacheEntry,
  hashCanonical,
  hashCmsResolutionCacheScope,
  serializeCmsResolutionCache,
  CMS_RESOLUTION_CACHE_CONTRACT,
  CMS_RESOLUTION_CACHE_VERSION,
  type CmsResolutionCacheEntry,
  type CmsResolutionCacheFile,
  type CmsResolutionCacheScope,
} from '../contracts/resolution-cache.js';
import { assertPortableIdentity, type PortableIdentity } from '../contracts/capability-registry.js';
import type { PortableResolutionResult } from './portable-resolution.js';
import { replaceFileByAtomicRename } from './atomic-publish.js';

export type CmsResolutionCacheHit = {
  readonly entry: CmsResolutionCacheEntry;
  readonly sourceHash: string;
  readonly observedAt: string;
};

export type CmsResolutionObservation = {
  readonly result: PortableResolutionResult;
  readonly sourceEvidence: unknown;
  readonly complete: boolean;
  readonly ownershipCertain: boolean;
};

export type CmsResolutionCacheRefresh = {
  readonly cacheRoot: string;
  readonly scope: CmsResolutionCacheScope;
  readonly resolve: () => Promise<CmsResolutionObservation>;
  readonly observedAt?: string;
  /** Exact changed or invalidated root; never inferred from partial inventory absence. */
  readonly invalidatedPortableIdentity?: PortableIdentity;
};

export function resolutionCachePath(cacheRoot: string, scope: CmsResolutionCacheScope): string {
  const resolvedRoot = path.resolve(cacheRoot);
  const resolved = path.resolve(resolvedRoot, `${hashCmsResolutionCacheScope(scope)}.json`);
  if (path.dirname(resolved) !== resolvedRoot)
    throw new Error('Resolution cache path escaped root');
  return resolved;
}

export async function readCmsResolutionCache(
  cacheRoot: string,
  scope: CmsResolutionCacheScope,
): Promise<CmsResolutionCacheFile | undefined> {
  const cachePath = resolutionCachePath(cacheRoot, scope);
  let bytes: string;
  try {
    bytes = await readFile(cachePath, 'utf8');
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return undefined;
    throw error;
  }
  const parsed: unknown = JSON.parse(bytes);
  assertCmsResolutionCacheFile(parsed, scope);
  return parsed;
}

export async function lookupCmsResolutionByPortable(
  cacheRoot: string,
  scope: CmsResolutionCacheScope,
  portableIdentity: PortableIdentity,
): Promise<CmsResolutionCacheHit | undefined> {
  assertPortableIdentity(portableIdentity);
  const cache = await readCmsResolutionCache(cacheRoot, scope);
  if (cache === undefined) return undefined;
  const portableHash = hashCanonical(portableIdentity);
  const entry = cache.entries.find((candidate) => candidate.portableHash === portableHash);
  return entry === undefined ? undefined : hit(cache, entry);
}

export async function lookupCmsResolutionByServerEvidence(
  cacheRoot: string,
  scope: CmsResolutionCacheScope,
  evidence: CmsResolutionCacheEntry['targetEvidence'],
): Promise<CmsResolutionCacheHit | undefined> {
  const cache = await readCmsResolutionCache(cacheRoot, scope);
  if (cache === undefined) return undefined;
  const evidenceHash = hashCanonical(evidence);
  const entry = cache.entries.find((candidate) => candidate.evidenceHash === evidenceHash);
  return entry === undefined ? undefined : hit(cache, entry);
}

export async function refreshCmsResolutionCache(
  request: CmsResolutionCacheRefresh,
): Promise<CmsResolutionCacheHit | undefined> {
  if (request.invalidatedPortableIdentity !== undefined) {
    assertPortableIdentity(request.invalidatedPortableIdentity);
    const portableHash = hashCanonical(request.invalidatedPortableIdentity);
    const existing = await readCmsResolutionCache(request.cacheRoot, request.scope);
    if (existing?.entries.some((candidate) => candidate.portableHash === portableHash)) {
      const entries = existing.entries.filter(
        (candidate) => candidate.portableHash !== portableHash,
      );
      const retainedMappings = new Set(entries.map((candidate) => candidate.mappingHash));
      await publishCache(request.cacheRoot, request.scope, {
        ...existing,
        entries,
        observations: existing.observations.filter((candidate) =>
          retainedMappings.has(candidate.mappingHash),
        ),
      });
    }
  }
  const observation = await request.resolve();
  if (!observation.complete || !observation.ownershipCertain || !observation.result.available) {
    return undefined;
  }
  const entry = createCmsResolutionCacheEntry(
    observation.result.portableIdentity,
    observation.result.evidence,
  );
  const existing = await readCmsResolutionCache(request.cacheRoot, request.scope);
  const entries = (existing?.entries ?? []).filter(
    (candidate) =>
      candidate.portableHash !== entry.portableHash &&
      candidate.evidenceHash !== entry.evidenceHash,
  );
  entries.push(entry);
  entries.sort((left, right) => left.portableHash.localeCompare(right.portableHash));
  const observations = entries.map((candidate) => {
    if (candidate.mappingHash === entry.mappingHash) {
      return {
        mappingHash: entry.mappingHash,
        sourceHash: hashCanonical(observation.sourceEvidence),
        observedAt: request.observedAt ?? new Date().toISOString(),
      };
    }
    const previous = existing?.observations.find(
      (candidateObservation) => candidateObservation.mappingHash === candidate.mappingHash,
    );
    if (previous === undefined) throw new Error('Existing cache observation is incomplete');
    return previous;
  });
  const cache: CmsResolutionCacheFile = {
    contract: CMS_RESOLUTION_CACHE_CONTRACT,
    version: CMS_RESOLUTION_CACHE_VERSION,
    scope: request.scope,
    scopeHash: hashCmsResolutionCacheScope(request.scope),
    entries,
    observations,
  };
  await publishCache(request.cacheRoot, request.scope, cache);
  return hit(cache, entry);
}

async function publishCache(
  cacheRoot: string,
  scope: CmsResolutionCacheScope,
  cache: CmsResolutionCacheFile,
): Promise<void> {
  const destination = resolutionCachePath(cacheRoot, scope);
  await mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await writeFile(temporary, serializeCmsResolutionCache(cache), { encoding: 'utf8', flag: 'wx' });
  await replaceFileByAtomicRename(temporary, destination);
}

function hit(cache: CmsResolutionCacheFile, entry: CmsResolutionCacheEntry): CmsResolutionCacheHit {
  const observation = cache.observations.find(
    (candidate) => candidate.mappingHash === entry.mappingHash,
  );
  if (observation === undefined) throw new Error('Cache observation is missing');
  return { entry, sourceHash: observation.sourceHash, observedAt: observation.observedAt };
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String(error.code)
    : undefined;
}
