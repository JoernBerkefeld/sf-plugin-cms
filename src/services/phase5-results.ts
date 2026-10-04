import { hashCanonical } from '../contracts/resolution-cache.js';
import type { CmsDeployPreflightReport } from './deploy-preflight.js';
import type { PortableExportMetadata } from './portable-export-metadata.js';

export const CMS_PHASE5_RESULT_CONTRACT = 'sf-cms-phase5-result-v1' as const;
export const CMS_PHASE5_RESULT_VERSION = '1.0.0' as const;

export type CmsPhase5Result = {
  contract: typeof CMS_PHASE5_RESULT_CONTRACT;
  version: typeof CMS_PHASE5_RESULT_VERSION;
  kind: 'portable-export' | 'deploy-preflight';
  resultHash: string;
  metrics: Record<string, number>;
  warnings: string[];
  reportHash: string;
};

export type CmsExportObservations = {
  inventoryPages: number;
  detailItems: number;
  cacheHits: number;
  cacheMisses: number;
  cacheRefreshes: number;
};

/**
 * Report only inventory observations and completed cache actions, not inferred transport calls.
 * @param {PortableExportMetadata} metadata - Selected unchanged portable sidecar.
 * @param {CmsExportObservations} observations - Recorded inventory and cache actions.
 * @returns {CmsPhase5Result} Independently versioned bound observations.
 */
export function cmsPortableExportResult(
  metadata: PortableExportMetadata,
  observations: CmsExportObservations,
): CmsPhase5Result {
  const metrics = { ...observations, roots: metadata.roots.length };
  for (const value of Object.values(metrics)) count(value);
  if (
    metrics.cacheHits + metrics.cacheMisses > metrics.roots ||
    metrics.cacheRefreshes > metrics.cacheMisses ||
    metrics.detailItems < metrics.roots
  )
    throw new TypeError('Inconsistent CMS portable export metrics');
  return finalize('portable-export', metadata, metrics, [
    'Portable metadata is a legacy package sidecar, not a decomposed CMS definition.',
    'Inventory pages and detail items do not measure total transport calls or cache call savings.',
  ]);
}

/**
 * Summarize resolution records without treating blocked preflight evidence as deployable.
 * @param {CmsDeployPreflightReport} report - Selected zero-mutation preflight result.
 * @returns {CmsPhase5Result} Bound counts and concrete blocking warnings.
 */
export function cmsDeployPreflightResult(report: CmsDeployPreflightReport): CmsPhase5Result {
  return finalize(
    'deploy-preflight',
    report,
    {
      resolutionRecords: report.resolutions.length,
      plannedOperations: report.operations.length,
      blockingReasons: report.blockedReasons.length,
    },
    report.blockedReasons,
  );
}

/**
 * Strictly validate a report against independently reconstructed observations for the selected result.
 * @param {unknown} value - Untrusted decoded JSON report.
 * @param {CmsPhase5Result} expected - Independently reconstructed report for the selected result.
 */
export function assertCmsPhase5Result(
  value: unknown,
  expected: CmsPhase5Result,
): asserts value is CmsPhase5Result {
  const report = strict(value, [
    'contract',
    'version',
    'kind',
    'resultHash',
    'metrics',
    'warnings',
    'reportHash',
  ]);
  if (
    report.contract !== CMS_PHASE5_RESULT_CONTRACT ||
    report.version !== CMS_PHASE5_RESULT_VERSION
  )
    throw new TypeError('Unsupported CMS Phase 5 result contract/version');
  let keys: string[] | undefined;
  if (report.kind === 'portable-export')
    keys = ['inventoryPages', 'detailItems', 'cacheHits', 'cacheMisses', 'cacheRefreshes', 'roots'];
  if (report.kind === 'deploy-preflight')
    keys = ['resolutionRecords', 'plannedOperations', 'blockingReasons'];
  if (keys === undefined) throw new TypeError('Unsupported CMS Phase 5 result kind');
  const metrics = strict(report.metrics, keys);
  const { reportHash, ...body } = report;
  if (
    reportHash !== hashCanonical(body) ||
    typeof report.resultHash !== 'string' ||
    !/^[a-f\d]{64}$/u.test(report.resultHash)
  )
    throw new TypeError('Invalid CMS Phase 5 report hash');
  for (const metric of Object.values(metrics)) count(metric);
  const counts = metrics as Record<string, number>;
  if (
    report.kind === 'portable-export' &&
    (counts.cacheHits + counts.cacheMisses > counts.roots ||
      counts.cacheRefreshes > counts.cacheMisses ||
      counts.detailItems < counts.roots)
  )
    throw new TypeError('Inconsistent CMS portable export metrics');
  if (
    !Array.isArray(report.warnings) ||
    report.warnings.some((warning) => typeof warning !== 'string' || !warning.trim())
  )
    throw new TypeError('Invalid CMS Phase 5 warnings');
  if (hashCanonical(value) !== hashCanonical(expected))
    throw new TypeError('CMS Phase 5 result binding or metrics mismatch');
}

function finalize(
  kind: CmsPhase5Result['kind'],
  result: unknown,
  metrics: Record<string, number>,
  warnings: readonly string[],
): CmsPhase5Result {
  const body = {
    contract: CMS_PHASE5_RESULT_CONTRACT,
    version: CMS_PHASE5_RESULT_VERSION,
    kind,
    resultHash: hashCanonical(result),
    metrics,
    warnings: [...new Set(warnings)].toSorted(),
  };
  return { ...body, reportHash: hashCanonical(body) };
}

function count(value: unknown): void {
  if (!Number.isSafeInteger(value) || (value as number) < 0)
    throw new TypeError('Invalid CMS Phase 5 metric');
}

function strict(value: unknown, keys: string[]): Record<string, unknown> {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).toSorted().join('\0') !== keys.toSorted().join('\0')
  )
    throw new TypeError('Unknown or missing CMS Phase 5 result fields');
  return value as Record<string, unknown>;
}
