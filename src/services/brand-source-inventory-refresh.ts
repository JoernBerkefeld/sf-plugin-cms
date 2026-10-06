import type { Connection } from '@salesforce/core';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { JsonRequestOptions } from '../transport/json-request.js';
import { acquireBrandSourceInventoryEvidence } from './brand-source-inventory-acquire.js';
import {
  BRAND_SOURCE_INVENTORY_KIND,
  BRAND_SOURCE_INVENTORY_PATH,
  type BrandSourceInventoryEvidence,
} from './brand-source-inventory-evidence.js';
import {
  getLoadedBrandSourceInventory,
  loadWorkspaceExport,
  readStableRegularFile,
  type LoadedWorkspaceExport,
} from './import-workspace.js';
import { strictSourceJson } from './source-definition-import.js';

export type BrandSourceRefreshOptions = JsonRequestOptions & {
  readonly sourceConnection: Pick<Connection, 'request' | 'getApiVersion' | 'getAuthInfoFields'>;
  readonly sourceOrgId: string;
};
export type BrandSourceRefreshProof = {
  readonly sourceManifestSha256: string;
  readonly historicalArtifactSha256: string;
  readonly sourceOrgId: string;
  readonly sourceApiVersion: string;
  readonly sourceWorkspaceId: string;
  readonly acquiredAt: string;
  readonly refreshedArtifactSha256: string;
};
const withoutTime = (evidence: BrandSourceInventoryEvidence): unknown => ({
  ...evidence,
  source: { orgId: evidence.source.orgId, apiVersion: evidence.source.apiVersion },
});
const refreshProofs = new WeakMap<BrandSourceRefreshProof, string>();
const fingerprint = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');

/**
 * Reauthenticate original Brand identity and refresh canonical inventory without mutating history.
 * @param {LoadedWorkspaceExport} source - Unchanged explicit brand-source integrity load.
 * @param {BrandSourceRefreshOptions} options - Independent source auth, never a target fallback.
 * @returns {Promise<BrandSourceRefreshProof>} Fingerprint-bound GET-only checkpoint; not permission to POST.
 */
export async function refreshBrandSourceInventory(
  source: LoadedWorkspaceExport,
  options: BrandSourceRefreshOptions,
): Promise<BrandSourceRefreshProof> {
  // Reject caller substitution before asynchronous work or any source requests.
  const historical = getLoadedBrandSourceInventory(source);
  const sourceDirectory = source.sourceDirectory;
  const manifestSha256 = source.manifestSha256;
  const connection = options.sourceConnection;
  const orgId = options.sourceOrgId;
  const apiVersion = historical.evidence.source.apiVersion;
  const assertAuth = (): void => {
    if (
      !connection ||
      orgId !== historical.evidence.source.orgId ||
      connection.getAuthInfoFields().orgId !== orgId ||
      connection.getApiVersion() !== apiVersion
    )
      throw new TypeError('Brand refresh requires original authenticated source org/API');
  };
  assertAuth();
  const baseline = await loadWorkspaceExport(sourceDirectory, { profile: 'brand-source' });
  const currentHistorical = getLoadedBrandSourceInventory(baseline);
  if (
    baseline.manifestSha256 !== manifestSha256 ||
    !isDeepStrictEqual(currentHistorical, historical)
  )
    throw new TypeError('Brand historical baseline changed before source refresh');
  const records = async (
    files: readonly string[],
  ): Promise<Map<string, Readonly<Record<string, unknown>>>> => {
    const result = new Map<string, Readonly<Record<string, unknown>>>();
    for (const file of files) {
      const descriptor = baseline.manifest.items.find((item) => item.path === file)!;
      const bytes = await readStableRegularFile(path.join(sourceDirectory, file), 'Brand refresh');
      if (createHash('sha256').update(bytes).digest('hex') !== descriptor.sha256)
        throw new TypeError('Brand refresh original bytes changed');
      const raw = strictSourceJson(bytes, 'Brand refresh original JSON');
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw))
        throw new TypeError('Brand refresh requires original native records');
      result.set(file, raw as Readonly<Record<string, unknown>>);
    }
    return result;
  };
  const rawItems = await records(baseline.manifest.entries.map((entry) => entry.file));
  const reports = await records(baseline.manifest.brandReports!.map((report) => report.path));
  const acquisitionManifest = structuredClone(baseline.manifest);
  // Acquisition creates a new detached proof; the historical manifest and artifact stay intact.
  acquisitionManifest.items = acquisitionManifest.items.filter(
    (item) =>
      item.kind !== BRAND_SOURCE_INVENTORY_KIND && item.path !== BRAND_SOURCE_INVENTORY_PATH,
  );
  assertAuth();
  const refreshed = await acquireBrandSourceInventoryEvidence(
    connection,
    acquisitionManifest,
    rawItems,
    reports,
    { signal: options.signal, timeoutMs: options.timeoutMs },
  );
  if (!isDeepStrictEqual(withoutTime(refreshed.evidence), withoutTime(historical.evidence)))
    throw new TypeError('Brand source canonical inventory/workspace/native parent changed');
  assertAuth();
  const finalBaseline = await loadWorkspaceExport(sourceDirectory, { profile: 'brand-source' });
  if (
    finalBaseline.manifestSha256 !== manifestSha256 ||
    !isDeepStrictEqual(getLoadedBrandSourceInventory(finalBaseline), historical)
  )
    throw new TypeError('Brand historical baseline changed during source refresh');
  const proof: BrandSourceRefreshProof = {
    sourceManifestSha256: manifestSha256,
    historicalArtifactSha256: historical.artifactSha256,
    sourceOrgId: orgId,
    sourceApiVersion: apiVersion,
    sourceWorkspaceId: baseline.manifest.workspaceId,
    acquiredAt: refreshed.evidence.source.acquiredAt,
    refreshedArtifactSha256: createHash('sha256').update(refreshed.bytes).digest('hex'),
  };
  refreshProofs.set(proof, fingerprint(proof));
  return proof;
}

/**
 * Reject detached or modified refresh claims; this check does not establish ongoing freshness.
 * @param {BrandSourceRefreshProof} proof - Actual proof returned by live source refresh.
 */
export function assertBrandSourceRefreshProof(proof: BrandSourceRefreshProof): void {
  if (refreshProofs.get(proof) !== fingerprint(proof))
    throw new TypeError('Brand refresh proof was not acquired here or was modified');
}
