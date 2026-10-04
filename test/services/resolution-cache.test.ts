import { mkdtemp, readFile, readdir, rmdir, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect } from 'chai';
import {
  CMS_CAPABILITY_DECLARATIONS,
  METADATA_CAPABILITY_CONTRACT,
  METADATA_CAPABILITY_FIXTURE_SHA256,
  type ServerIdentity,
} from '../../src/contracts/capability-registry.js';
import {
  CMS_RESOLUTION_CACHE_CONTRACT,
  hashCanonical,
  serializeCmsResolutionCache,
  type CmsResolutionCacheScope,
} from '../../src/contracts/resolution-cache.js';
import {
  lookupCmsResolutionByPortable,
  lookupCmsResolutionByServerEvidence,
  readCmsResolutionCache,
  refreshCmsResolutionCache,
  resolutionCachePath,
} from '../../src/services/resolution-cache.js';
import {
  resolveCmsPortableIdentity,
  type PortableResolutionRequest,
} from '../../src/services/portable-resolution.js';

import { buildPortableExportMetadata } from '../../src/services/portable-export-metadata.js';
import type { CmsRecord } from '../../src/services/read.js';

const brand = CMS_CAPABILITY_DECLARATIONS.find(({ identity }) => identity.type === 'Brand')!;
const sourceOrg: ServerIdentity = { kind: 'exact-scope', value: 'source.example' };
const targetOrg: ServerIdentity = { kind: 'exact-scope', value: 'target.example' };

function scope(overrides: Partial<CmsResolutionCacheScope> = {}): CmsResolutionCacheScope {
  return {
    sourceOrg,
    targetOrg,
    provider: 'sf-plugin-cms',
    apiVersion: '67.0',
    capabilityContract: METADATA_CAPABILITY_CONTRACT,
    capabilityFixtureSha256: METADATA_CAPABILITY_FIXTURE_SHA256,
    declaration: brand.identity,
    nativeWorkspace: {
      kind: brand.nativeScope.kind,
      root: brand.nativeScope.root,
      workspaceApiName: 'marketing',
    },
    ...overrides,
  };
}

function resolution(apiName = 'main_brand', contentSuffix = '2'): PortableResolutionRequest {
  return {
    profile: brand.identity,
    workspace: { workspaceApiName: 'marketing' },
    family: 'cms',
    type: 'Brand',
    apiName,
    usage: { strategy: 'filtered', calls: 1, items: 1, pages: 1 },
    candidates: [
      {
        workspaceId: '20Y000000000001AAA',
        workspaceApiName: 'marketing',
        family: 'cms',
        type: 'Brand',
        apiName,
        contentId: `20Y00000000000${contentSuffix}AAA`,
        variantId: `20Y00000000001${contentSuffix}AAA`,
        contentKey: `${apiName}-content-key`,
      },
    ],
  };
}

async function removeFixture(root: string): Promise<void> {
  for (const name of await readdir(root)) await unlink(path.join(root, name));
  await rmdir(root);
}

describe('CMS targeted resolution cache', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'sf-plugin-cms-resolution-cache-'));
  });

  afterEach(async () => removeFixture(root));

  it('re-resolves and refreshes exact export roots on API-name or language drift with unchanged IDs', async () => {
    const original: CmsRecord = {
      apiName: 'original_email',
      language: 'en_US',
      contentType: 'sfdc_cms__email',
      managedContentId: '20Y000000000002AAA',
      managedContentVariantId: '20Y000000000012AAA',
      contentKey: 'stable-content-key',
    };
    const buildExport = async (detail: CmsRecord) =>
      buildPortableExportMetadata({
        workspaceId: '20Y000000000001AAA',
        details: new Map([['detail', detail]]),
        contentType: 'sfdc_cms__email',
        apiNames: [String(detail.apiName)],
        pagesRequested: 1,
        options: {
          workspaceApiName: 'marketing',
          cache: {
            root,
            sourceOrg,
            targetOrg,
            apiVersion: '67.0',
            observedAt: '2026-10-02T12:00:00.000Z',
          },
        },
      });
    const initial = await buildExport(original);
    expect(initial).not.to.equal(undefined);
    const initialReport = await initial!.refreshCache();
    expect(initialReport.metrics.cacheRefreshes).to.equal(1);
    const repeated = await buildExport(original);
    const repeatedReport = await repeated!.refreshCache();
    expect(repeatedReport.metrics.cacheHits).to.equal(1);
    const changedDetails: CmsRecord[] = [
      { ...original, apiName: 'renamed_email' },
      { ...original, apiName: 'renamed_email', language: 'de_DE' },
    ];
    for (const detail of changedDetails) {
      const changed = await buildExport(detail);
      expect(changed?.metadata.roots[0].identity.apiName).to.equal(detail.apiName);
      expect(changed?.metadata.roots[0].identity.context?.language).to.equal(detail.language);
      const { metrics } = await changed!.refreshCache();
      expect(metrics.cacheHits).to.equal(0);
      expect(metrics.cacheMisses).to.equal(1);
      expect(metrics.cacheRefreshes).to.equal(1);
      const refreshed = await buildExport(detail);
      const refreshedReport = await refreshed!.refreshCache();
      expect(refreshedReport.metrics.cacheHits).to.equal(1);
      const cache = await readCmsResolutionCache(
        root,
        scope({
          declaration: CMS_CAPABILITY_DECLARATIONS.find(
            ({ identity }) => identity.type === 'Email',
          )!.identity,
          nativeWorkspace: {
            ...CMS_CAPABILITY_DECLARATIONS.find(({ identity }) => identity.type === 'Email')!
              .nativeScope,
            workspaceApiName: 'marketing',
          },
        }),
      );
      expect(cache?.entries).to.have.length(1);
      expect(cache?.entries[0].portableIdentity).to.deep.equal(changed?.metadata.roots[0].identity);
      expect(cache?.observations[0].sourceHash).to.equal(
        hashCanonical({
          contentType: 'sfdc_cms__email',
          details: [detail],
        }),
      );
    }
    const incomplete = await buildExport({ ...original, apiName: 'renamed_email', language: '' });
    expect(incomplete).to.equal(undefined);
  });

  it('round-trips deterministic bytes and supports bidirectional exact lookup', async () => {
    const result = resolveCmsPortableIdentity(resolution());
    expect(result.available).to.equal(true);
    if (!result.available) return;
    await refreshCmsResolutionCache({
      cacheRoot: root,
      scope: scope(),
      observedAt: '2026-10-02T10:00:00.000Z',
      resolve: async () => ({
        result,
        sourceEvidence: { roots: ['main_brand'], inventoryHash: 'fixture-a' },
        complete: true,
        ownershipCertain: true,
      }),
    });
    const portableHit = await lookupCmsResolutionByPortable(root, scope(), result.portableIdentity);
    const serverHit = await lookupCmsResolutionByServerEvidence(root, scope(), result.evidence);
    expect(portableHit).to.deep.equal(serverHit);
    expect(portableHit?.entry.portableIdentity).to.deep.equal(result.portableIdentity);
    const cache = await readCmsResolutionCache(root, scope());
    expect(cache).not.to.equal(undefined);
    if (cache === undefined) return;
    expect(await readFile(resolutionCachePath(root, scope()), 'utf8')).to.equal(
      serializeCmsResolutionCache(cache),
    );
    expect(cache.entries[0].mappingHash).to.equal(
      hashCanonical({
        portableHash: cache.entries[0].portableHash,
        evidenceHash: cache.entries[0].evidenceHash,
      }),
    );
  });

  it('orders entries deterministically and keeps volatile observations separate', async () => {
    for (const [apiName, suffix, observedAt] of [
      ['z_brand', '3', '2026-10-02T10:01:00.000Z'],
      ['a_brand', '4', '2026-10-02T10:02:00.000Z'],
    ] as const) {
      const result = resolveCmsPortableIdentity(resolution(apiName, suffix));
      await refreshCmsResolutionCache({
        cacheRoot: root,
        scope: scope(),
        observedAt,
        resolve: async () => ({
          result,
          sourceEvidence: { apiName },
          complete: true,
          ownershipCertain: true,
        }),
      });
    }
    const cache = await readCmsResolutionCache(root, scope());
    expect(cache?.entries.map(({ portableHash }) => portableHash)).to.deep.equal(
      cache?.entries.map(({ portableHash }) => portableHash).toSorted(),
    );
    expect(JSON.stringify(cache?.entries)).not.to.include('observedAt');
  });

  it('strictly scopes cache files by org, API, declaration, fixture, and workspace', async () => {
    const result = resolveCmsPortableIdentity(resolution());
    await refreshCmsResolutionCache({
      cacheRoot: root,
      scope: scope(),
      resolve: async () => ({ result, sourceEvidence: {}, complete: true, ownershipCertain: true }),
    });
    for (const changed of [
      scope({ targetOrg: { kind: 'exact-scope', value: 'other.example' } }),
      scope({ apiVersion: '66.0' }),
      scope({ nativeWorkspace: { ...scope().nativeWorkspace, workspaceApiName: 'other' } }),
    ]) {
      expect(await readCmsResolutionCache(root, changed)).to.equal(undefined);
    }
  });

  it('atomically replaces only the exact refreshed mapping and preserves other roots', async () => {
    for (const [apiName, suffix] of [
      ['first_brand', '3'],
      ['second_brand', '4'],
    ] as const) {
      await refreshCmsResolutionCache({
        cacheRoot: root,
        scope: scope(),
        resolve: async () => ({
          result: resolveCmsPortableIdentity(resolution(apiName, suffix)),
          sourceEvidence: { apiName, suffix },
          complete: true,
          ownershipCertain: true,
        }),
      });
    }
    const unchanged = await readCmsResolutionCache(root, scope());
    await refreshCmsResolutionCache({
      cacheRoot: root,
      scope: scope(),
      resolve: async () => ({
        result: resolveCmsPortableIdentity(resolution('first_brand', '5')),
        sourceEvidence: { apiName: 'first_brand', suffix: '5' },
        complete: true,
        ownershipCertain: true,
      }),
    });
    const changed = await readCmsResolutionCache(root, scope());
    expect(changed?.entries).to.have.length(2);
    expect(
      changed?.entries.find(({ portableIdentity }) => portableIdentity.apiName === 'second_brand'),
    ).to.deep.equal(
      unchanged?.entries.find(
        ({ portableIdentity }) => portableIdentity.apiName === 'second_brand',
      ),
    );
    const publishedFiles = await readdir(root);
    expect(publishedFiles.filter((name) => name.endsWith('.tmp'))).to.deep.equal([]);
  });

  it('uses exact cache hits to reduce resolver calls and refreshes one changed root', async () => {
    let calls = 0;
    const retrieve = async (apiName: string, suffix: string) => {
      const portable = {
        family: 'cms',
        type: 'Brand',
        apiName,
        context: { workspaceApiName: 'marketing' },
      };
      const cached = await lookupCmsResolutionByPortable(root, scope(), portable);
      if (cached !== undefined) return cached;
      calls += 1;
      return refreshCmsResolutionCache({
        cacheRoot: root,
        scope: scope(),
        resolve: async () => ({
          result: resolveCmsPortableIdentity(resolution(apiName, suffix)),
          sourceEvidence: { apiName, suffix },
          complete: true,
          ownershipCertain: true,
        }),
      });
    };
    await retrieve('first_brand', '3');
    await retrieve('second_brand', '4');
    await retrieve('first_brand', '3');
    await retrieve('second_brand', '4');
    expect(calls).to.equal(2);
    await refreshCmsResolutionCache({
      cacheRoot: root,
      scope: scope(),
      resolve: async () => ({
        result: resolveCmsPortableIdentity(resolution('first_brand', '5')),
        sourceEvidence: { apiName: 'first_brand', suffix: '5' },
        complete: true,
        ownershipCertain: true,
      }),
    });
    const cache = await readCmsResolutionCache(root, scope());
    expect(cache?.entries).to.have.length(2);
    expect(
      cache?.entries.some(({ targetEvidence }) => targetEvidence.content.value.endsWith('3AAA')),
    ).to.equal(false);
  });

  it('does not persist partial, ambiguous, unavailable, or ownership-uncertain observations', async () => {
    const cases = [
      { result: resolveCmsPortableIdentity(resolution()), complete: false, ownershipCertain: true },
      { result: resolveCmsPortableIdentity(resolution()), complete: true, ownershipCertain: false },
      {
        result: resolveCmsPortableIdentity({
          ...resolution(),
          candidates: [resolution().candidates[0], resolution().candidates[0]],
        }),
        complete: true,
        ownershipCertain: true,
      },
    ];
    for (const candidate of cases) {
      expect(
        await refreshCmsResolutionCache({
          cacheRoot: root,
          scope: scope(),
          resolve: async () => ({ ...candidate, sourceEvidence: {} }),
        }),
      ).to.equal(undefined);
    }
    expect(await readdir(root)).to.deep.equal([]);
  });

  it('retains prior positive facts when partial inventory omits unchanged roots', async () => {
    const result = resolveCmsPortableIdentity(resolution());
    if (!result.available) throw new Error('Expected positive fixture');
    await refreshCmsResolutionCache({
      cacheRoot: root,
      scope: scope(),
      resolve: async () => ({ result, sourceEvidence: {}, complete: true, ownershipCertain: true }),
    });
    const before = await readFile(resolutionCachePath(root, scope()), 'utf8');
    const unavailable = resolveCmsPortableIdentity({ ...resolution(), candidates: [] });
    for (const observation of [
      { result: unavailable, complete: false, ownershipCertain: true },
      { result: unavailable, complete: true, ownershipCertain: true },
      { result, complete: true, ownershipCertain: false },
      {
        result: resolveCmsPortableIdentity({
          ...resolution(),
          candidates: [resolution().candidates[0], resolution().candidates[0]],
        }),
        complete: true,
        ownershipCertain: true,
      },
    ]) {
      expect(
        await refreshCmsResolutionCache({
          cacheRoot: root,
          scope: scope(),
          resolve: async () => ({ ...observation, sourceEvidence: { roots: [] } }),
        }),
      ).to.equal(undefined);
      expect(
        await lookupCmsResolutionByPortable(root, scope(), result.portableIdentity),
      ).not.to.equal(undefined);
      expect(await readFile(resolutionCachePath(root, scope()), 'utf8')).to.equal(before);
    }
  });

  it('invalidates only the explicitly changed root when revalidation fails', async () => {
    const first = resolveCmsPortableIdentity(resolution('first_brand', '3'));
    const second = resolveCmsPortableIdentity(resolution('second_brand', '4'));
    if (!first.available || !second.available) throw new Error('Expected positive fixtures');
    const unavailable = resolveCmsPortableIdentity({
      ...resolution('first_brand', '3'),
      candidates: [],
    });
    for (const failed of [
      { result: unavailable, complete: true, ownershipCertain: true },
      { result: first, complete: false, ownershipCertain: true },
      { result: first, complete: true, ownershipCertain: false },
      {
        result: resolveCmsPortableIdentity({
          ...resolution('first_brand', '3'),
          candidates: [
            resolution('first_brand', '3').candidates[0],
            resolution('first_brand', '3').candidates[0],
          ],
        }),
        complete: true,
        ownershipCertain: true,
      },
    ]) {
      for (const result of [first, second]) {
        await refreshCmsResolutionCache({
          cacheRoot: root,
          scope: scope(),
          observedAt: '2026-10-02T10:00:00.000Z',
          resolve: async () => ({
            result,
            sourceEvidence: {},
            complete: true,
            ownershipCertain: true,
          }),
        });
      }
      const retained = await lookupCmsResolutionByPortable(root, scope(), second.portableIdentity);
      expect(
        await refreshCmsResolutionCache({
          cacheRoot: root,
          scope: scope(),
          invalidatedPortableIdentity: first.portableIdentity,
          resolve: async () => ({ ...failed, sourceEvidence: { roots: [] } }),
        }),
      ).to.equal(undefined);
      expect(await lookupCmsResolutionByPortable(root, scope(), first.portableIdentity)).to.equal(
        undefined,
      );
      expect(await lookupCmsResolutionByServerEvidence(root, scope(), first.evidence)).to.equal(
        undefined,
      );
      expect(
        await lookupCmsResolutionByPortable(root, scope(), second.portableIdentity),
      ).to.deep.equal(retained);
      const cache = await readCmsResolutionCache(root, scope());
      if (cache === undefined) throw new Error('Expected retained positive cache');
      expect(cache.entries).to.have.length(1);
      expect(cache.observations).to.have.length(1);
      expect(await readFile(resolutionCachePath(root, scope()), 'utf8')).to.equal(
        serializeCmsResolutionCache(cache),
      );
      expect(JSON.stringify(cache.entries)).not.to.include('observedAt');
      const publishedFiles = await readdir(root);
      expect(publishedFiles.filter((name) => name.endsWith('.tmp'))).to.deep.equal([]);
    }
  });

  it('persists a strictly valid empty positive cache before a changed-root resolver throws', async () => {
    const result = resolveCmsPortableIdentity(resolution());
    if (!result.available) throw new Error('Expected positive fixture');
    await refreshCmsResolutionCache({
      cacheRoot: root,
      scope: scope(),
      resolve: async () => ({ result, sourceEvidence: {}, complete: true, ownershipCertain: true }),
    });
    const failure = new Error('Revalidation failed');
    let caught: unknown;
    try {
      await refreshCmsResolutionCache({
        cacheRoot: root,
        scope: scope(),
        invalidatedPortableIdentity: result.portableIdentity,
        resolve: async () => {
          throw failure;
        },
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).to.equal(failure);
    expect(await lookupCmsResolutionByPortable(root, scope(), result.portableIdentity)).to.equal(
      undefined,
    );
    expect(await lookupCmsResolutionByServerEvidence(root, scope(), result.evidence)).to.equal(
      undefined,
    );
    const cache = await readCmsResolutionCache(root, scope());
    if (cache === undefined) throw new Error('Expected empty positive cache');
    expect(cache.entries).to.deep.equal([]);
    expect(cache.observations).to.deep.equal([]);
    expect(await readFile(resolutionCachePath(root, scope()), 'utf8')).to.equal(
      serializeCmsResolutionCache(cache),
    );
    expect(Object.keys(cache).toSorted()).to.deep.equal([
      'contract',
      'entries',
      'observations',
      'scope',
      'scopeHash',
      'version',
    ]);
  });

  it('rejects unknown keys, mismatched hashes, leaks, conflicts, and wrong scope on read', async () => {
    const result = resolveCmsPortableIdentity(resolution());
    await refreshCmsResolutionCache({
      cacheRoot: root,
      scope: scope(),
      resolve: async () => ({ result, sourceEvidence: {}, complete: true, ownershipCertain: true }),
    });
    const cachePath = resolutionCachePath(root, scope());
    const original = JSON.parse(await readFile(cachePath, 'utf8')) as Record<string, unknown>;
    for (const mutate of [
      (value: Record<string, unknown>) => Object.assign(value, { unknown: true }),
      (value: Record<string, unknown>) => Object.assign(value, { scopeHash: '0'.repeat(64) }),
      (value: Record<string, unknown>) => {
        const entries = value.entries as Array<Record<string, unknown>>;
        entries.push(entries[0]);
      },
      (value: Record<string, unknown>) => Object.assign(value, { contract: 'wrong' }),
    ]) {
      const changed = structuredClone(original);
      mutate(changed);
      await writeFile(cachePath, JSON.stringify(changed));
      let rejected = false;
      try {
        await readCmsResolutionCache(root, scope());
      } catch {
        rejected = true;
      }
      expect(rejected).to.equal(true);
    }
    await writeFile(cachePath, JSON.stringify(original));
    const wrongScope = scope({ apiVersion: '66.0' });
    await writeFile(resolutionCachePath(root, wrongScope), JSON.stringify(original));
    let wrongScopeRejected = false;
    try {
      await readCmsResolutionCache(root, wrongScope);
    } catch {
      wrongScopeRejected = true;
    }
    expect(wrongScopeRejected).to.equal(true);
    await unlink(resolutionCachePath(root, wrongScope));
    expect(original.contract).to.equal(CMS_RESOLUTION_CACHE_CONTRACT);
  });
});
