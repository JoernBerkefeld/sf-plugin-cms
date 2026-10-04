import { expect } from 'chai';
import {
  assertCmsPhase5Result,
  cmsPortableExportResult,
  cmsDeployPreflightResult,
} from '../../src/services/phase5-results.js';
import {
  assertPortableExportMetadata,
  serializePortableExportMetadata,
  type PortableExportMetadata,
} from '../../src/services/portable-export-metadata.js';
import { hashCanonical } from '../../src/contracts/resolution-cache.js';

const identity = { family: 'cms', type: 'Brand', apiName: 'brand' };
const metadata: PortableExportMetadata = {
  contract: 'sf-cms-portable-export-metadata-v1',
  version: '1.0.0',
  requestHash: hashCanonical('request'),
  sourceHash: hashCanonical('source'),
  roots: [{ identity, identityHash: hashCanonical(identity), dependencies: [] }],
};
const observations = {
  inventoryPages: 1,
  detailItems: 1,
  cacheHits: 0,
  cacheMisses: 1,
  cacheRefreshes: 1,
};

describe('strict CMS Phase 5 results', () => {
  it('rejects unknown portable v1 fields and identity/hash drift without changing serialization', () => {
    assertPortableExportMetadata(metadata);
    expect(serializePortableExportMetadata(metadata)).to.equal(
      serializePortableExportMetadata(structuredClone(metadata)),
    );
    for (const bad of [
      { ...metadata, extra: true },
      { ...metadata, version: '2.0.0' },
      { ...metadata, roots: [{ ...metadata.roots[0], extra: true }] },
      { ...metadata, roots: [{ ...metadata.roots[0], identityHash: '0'.repeat(64) }] },
    ])
      expect(() => assertPortableExportMetadata(bad)).to.throw();
  });
  it('binds deterministic observations without changing portable v1', () => {
    const before = JSON.stringify(metadata);
    const report = cmsPortableExportResult(metadata, observations);
    const bytes = JSON.stringify(report);
    assertCmsPhase5Result(JSON.parse(bytes), report);
    expect(report).to.deep.equal(cmsPortableExportResult(metadata, observations));
    expect(report.resultHash).to.equal(hashCanonical(metadata));
    expect(report.warnings.join(' ')).to.include('not measure total transport calls');
    expect(JSON.stringify(metadata)).to.equal(before);
  });

  it('rejects unknown fields, malformed metrics, versions, warnings and binding drift', () => {
    const report = cmsPortableExportResult(metadata, observations);
    for (const bad of [
      null,
      { ...report, extra: true },
      { ...report, version: '2.0.0' },
      { ...report, contract: 'sf-cms-command-result-v1' },
      { ...report, warnings: [null] },
      { ...report, metrics: { ...report.metrics, extra: 0 } },
      { ...report, metrics: { ...report.metrics, cacheHits: -1 } },
      { ...report, metrics: { ...report.metrics, cacheRefreshes: 0 } },
      { ...report, resultHash: '0'.repeat(64) },
    ])
      expect(() => assertCmsPhase5Result(bad, report)).to.throw();
    expect(() => cmsPortableExportResult(metadata, { ...observations, cacheHits: 1 })).to.throw(
      'Inconsistent',
    );
    expect(() =>
      cmsPortableExportResult(metadata, { ...observations, cacheRefreshes: 2 }),
    ).to.throw('Inconsistent');
    expect(() =>
      cmsPortableExportResult(metadata, { ...observations, inventoryPages: 0.5 }),
    ).to.throw('metric');
  });

  it('does not equate blocking reasons with blocked dependency counts', () => {
    const report = cmsDeployPreflightResult({
      contract: 'sf-cms-deploy-preflight-v1',
      version: '1.0.0',
      ready: false,
      hashes: { package: 'a', manifest: 'b', evidence: 'c', source: 'd', request: 'e' },
      resolutions: [],
      operations: [],
      blockedReasons: ['stale evidence', 'missing dependency'],
      planHash: 'f',
    });
    expect(report.metrics).to.deep.equal({
      resolutionRecords: 0,
      plannedOperations: 0,
      blockingReasons: 2,
    });
    expect(report.warnings).to.deep.equal(['missing dependency', 'stale evidence']);
    assertCmsPhase5Result(report, report);
  });
});
