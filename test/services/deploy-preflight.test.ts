import { getPluginVersion } from '../../src/runtime-version.js';
import { expect } from 'chai';
import sinon from 'sinon';
import {
  CMS_CAPABILITY_DECLARATIONS,
  METADATA_CAPABILITY_CONTRACT,
  METADATA_CAPABILITY_FIXTURE_SHA256,
  METADATA_CAPABILITY_VERSION,
  type DependencyDescriptor,
  type PortableIdentity,
  type ServerIdentity,
} from '../../src/contracts/capability-registry.js';
import { hashCanonical } from '../../src/contracts/resolution-cache.js';
import {
  preflightCmsDeploy,
  type CmsDeployPackageNode,
  type CmsDeployPreflightInput,
  type CmsDeployTargetEvidence,
} from '../../src/services/deploy-preflight.js';
import {
  PORTABLE_EXPORT_METADATA_CONTRACT,
  PORTABLE_EXPORT_METADATA_VERSION,
  serializePortableExportMetadata,
  type PortableExportMetadata,
} from '../../src/services/portable-export-metadata.js';
import { createHash } from 'node:crypto';

const workspace: ServerIdentity = { kind: 'salesforce-id', value: '20Y000000000001AAA' };
const brand = CMS_CAPABILITY_DECLARATIONS.find(({ identity }) => identity.type === 'Brand')!;
const image = CMS_CAPABILITY_DECLARATIONS.find(
  ({ identity }) => identity.type === 'Landing Page Template',
)!;

function identity(type: string, apiName: string): PortableIdentity {
  return { family: 'cms', type, apiName, context: { workspaceApiName: 'marketing' } };
}

function descriptor(
  source: PortableIdentity,
  target: PortableIdentity,
  resolution: DependencyDescriptor['resolution'] = 'either',
): DependencyDescriptor {
  return { kind: 'cms-image', source, target, required: true, resolution };
}

function evidence(
  portableIdentity: PortableIdentity,
  suffix: string,
  overrides: Partial<CmsDeployTargetEvidence> = {},
): CmsDeployTargetEvidence {
  return {
    portableIdentity,
    targetEvidence: {
      workspace,
      content: { kind: 'salesforce-id', value: `20Y0000000000${suffix}AAA` },
      variant: { kind: 'salesforce-id', value: `20Y0000000001${suffix}AAA` },
      contentKey: { kind: 'content-key', value: `${portableIdentity.apiName}-${suffix}` },
    },
    workspaceApiName: 'marketing',
    sourceHash: hashCanonical({ source: 'fixture' }),
    scope: {
      sourceOrg: { kind: 'exact-scope', value: 'source.example' },
      targetOrg: { kind: 'exact-scope', value: 'target.example' },
      provider: 'sf-plugin-cms',
      apiVersion: '67.0',
      capabilityContract: METADATA_CAPABILITY_CONTRACT,
      capabilityFixtureSha256: METADATA_CAPABILITY_FIXTURE_SHA256,
      declaration: CMS_CAPABILITY_DECLARATIONS.find(
        ({ identity: candidate }) => candidate.type === portableIdentity.type,
      )!.identity,
      nativeWorkspace: {
        ...CMS_CAPABILITY_DECLARATIONS.find(
          ({ identity: candidate }) => candidate.type === portableIdentity.type,
        )!.nativeScope,
        workspaceApiName: 'marketing',
      },
    },
    complete: true,
    ownershipCertain: true,
    observedAt: '2026-10-02T12:00:00.000Z',
    ...overrides,
  };
}

function build(
  dependencies: readonly DependencyDescriptor[],
  packageNodes: readonly CmsDeployPackageNode[],
  targetEvidence: readonly CmsDeployTargetEvidence[] = [],
  mappings: readonly CmsDeployTargetEvidence[] = [],
): CmsDeployPreflightInput {
  const root = identity('Brand', 'root');
  const metadata: PortableExportMetadata = {
    contract: PORTABLE_EXPORT_METADATA_CONTRACT,
    version: PORTABLE_EXPORT_METADATA_VERSION,
    requestHash: hashCanonical({ contentType: 'sfdc_cms__brand', apiNames: ['root'] }),
    sourceHash: hashCanonical({ source: 'fixture' }),
    roots: [{ identity: root, identityHash: hashCanonical(root), dependencies }],
  };
  const sidecarSha256 = createHash('sha256')
    .update(serializePortableExportMetadata(metadata), 'utf8')
    .digest('hex');
  const manifest = {
    items: [{ path: 'phase5/portable-metadata.v1.json', sha256: sidecarSha256 }],
  };
  const manifestBytes = `${JSON.stringify(manifest, undefined, 2)}\n`;
  const packageFiles = [
    { path: 'phase5/portable-metadata.v1.json', bytes: serializePortableExportMetadata(metadata) },
  ];
  return {
    metadata,
    sidecarSha256,
    manifest,
    manifestBytes,
    manifestSha256: createHash('sha256').update(manifestBytes).digest('hex'),
    packageFiles,
    packageNodes,
    packageHash: hashCanonical({ nodes: packageNodes, files: packageFiles }),
    targetEvidence,
    mappings,
    evidenceHash: hashCanonical({ targetEvidence, mappings }),
    sourceHash: hashCanonical({ source: 'fixture' }),
    requestHash: hashCanonical({ contentType: 'sfdc_cms__brand', apiNames: ['root'] }),
    source: { source: 'fixture' },
    request: { contentType: 'sfdc_cms__brand', apiNames: ['root'] },
    targetWorkspaceApiName: 'marketing',
    targetWorkspace: workspace,
    sourceOrg: { kind: 'exact-scope', value: 'source.example' },
    targetOrg: { kind: 'exact-scope', value: 'target.example' },
    providerVersion: getPluginVersion(),
    apiVersion: '67.0',
    registryContract: METADATA_CAPABILITY_CONTRACT,
    registryVersion: METADATA_CAPABILITY_VERSION,
    registryFixtureSha256: METADATA_CAPABILITY_FIXTURE_SHA256,
    dependencyExtractorVersions: Object.fromEntries(
      CMS_CAPABILITY_DECLARATIONS.map((declaration) => [
        declaration.identity.type,
        declaration.dependencyExtractorVersion,
      ]),
    ),
    usageByType: Object.fromEntries(
      CMS_CAPABILITY_DECLARATIONS.map((declaration) => [
        declaration.identity.type,
        { strategy: declaration.preflight.strategy, calls: 1, items: 1, pages: 1 },
      ]),
    ),
    now: '2026-10-02T12:05:00.000Z',
    maxEvidenceAgeMs: 600_000,
  };
}

function rootNode(dependencies: readonly DependencyDescriptor[]): CmsDeployPackageNode {
  return { ...evidence(identity('Brand', 'root'), '10'), dependencies };
}

describe('CMS package-first deploy preflight', () => {
  it('prefers exact package identities before mappings and target evidence', () => {
    const dependency = identity('Landing Page Template', 'asset');
    const edge = descriptor(identity('Brand', 'root'), dependency);
    const input = build(
      [edge],
      [rootNode([edge]), { ...evidence(dependency, '11'), dependencies: [] }],
      [evidence(dependency, '12')],
      [evidence(dependency, '13')],
    );
    const report = preflightCmsDeploy(input);
    expect(report.ready).to.equal(false);
    expect(report.blockedReasons).to.include('unsupported non-root package dependency: asset');
    expect(report.operations).to.deep.equal([]);
    expect(report.resolutions[0].provenance).to.equal('package');
    expect(report.resolutions[0].targetEvidence.content.value).to.include('11AAA');
  });

  it('uses mappings before permitted exact target fallback', () => {
    const dependency = identity('Landing Page Template', 'asset');
    const edge = descriptor(identity('Brand', 'root'), dependency, 'either');
    const mapped = preflightCmsDeploy(
      build([edge], [rootNode([edge])], [evidence(dependency, '12')], [evidence(dependency, '13')]),
    );
    expect(mapped.resolutions[0].provenance).to.equal('mapping');
    const target = preflightCmsDeploy(
      build([edge], [rootNode([edge])], [evidence(dependency, '12')]),
    );
    expect(target.ready).to.equal(true);
    expect(target.resolutions[0].provenance).to.equal('target');
  });

  it('rejects stale cache evidence and isolates the exact target workspace', () => {
    const dependency = identity('Landing Page Template', 'asset');
    const edge = descriptor(identity('Brand', 'root'), dependency, 'target');
    const input = build(
      [edge],
      [rootNode([edge])],
      [
        evidence(dependency, '12', {
          observedAt: '2026-10-02T10:00:00.000Z',
          workspaceApiName: 'other-workspace',
        }),
      ],
    );
    const report = preflightCmsDeploy(input);
    expect(report.ready).to.equal(false);
    expect(report.blockedReasons.join('\n')).to.include('stale evidence').and.include('workspace');
  });

  it('blocks missing, ambiguous, and package-only dependency resolution', () => {
    const dependency = identity('Landing Page Template', 'asset');
    for (const [resolution, targets, expected] of [
      ['target', [], 'missing target dependency'],
      ['target', [evidence(dependency, '12'), evidence(dependency, '13')], 'ambiguous'],
      ['package', [evidence(dependency, '12')], 'missing package dependency'],
    ] as const) {
      const edge = descriptor(identity('Brand', 'root'), dependency, resolution);
      const report = preflightCmsDeploy(build([edge], [rootNode([edge])], targets));
      expect(report.ready).to.equal(false);
      expect(report.blockedReasons.join('\n')).to.include(expected);
    }
  });

  it('validates transitive closure before producing a ready plan', () => {
    const child = identity('Landing Page Template', 'child');
    const missing = identity('Landing Page Template', 'missing');
    const rootEdge = descriptor(identity('Brand', 'root'), child, 'package');
    const childEdge = descriptor(child, missing, 'target');
    const report = preflightCmsDeploy(
      build(
        [rootEdge],
        [rootNode([rootEdge]), { ...evidence(child, '11'), dependencies: [childEdge] }],
      ),
    );
    expect(report.ready).to.equal(false);
    expect(report.blockedReasons.join('\n')).to.include('missing target dependency: missing');
  });

  it('blocks required package cycles with a concrete closed path', () => {
    const root = identity('Brand', 'root');
    const child = identity('Landing Page Template', 'child');
    for (const [rootEdges, childEdges, expected] of [
      [[descriptor(root, root, 'package')], [], 'Brand/root -> Brand/root'],
      [
        [descriptor(root, child, 'package')],
        [descriptor(child, root, 'package')],
        'Brand/root -> Landing Page Template/child -> Brand/root',
      ],
    ] as const) {
      const report = preflightCmsDeploy(
        build(rootEdges, [
          rootNode(rootEdges),
          { ...evidence(child, '11'), dependencies: childEdges },
        ]),
      );
      expect(report.ready).to.equal(false);
      expect(report.operations).to.deep.equal([]);
      expect(report.blockedReasons.join('\n')).to.include(
        `required package dependency cycle: ${expected}`,
      );
    }
  });

  it('checks selected mapping and package binding age even with valid artifact hashes', () => {
    const dependency = identity('Landing Page Template', 'asset');
    const edge = descriptor(identity('Brand', 'root'), dependency);
    for (const observedAt of [
      undefined,
      'invalid',
      '2026-10-02T13:00:00.000Z',
      '2026-10-02T10:00:00.000Z',
    ]) {
      for (const input of [
        build([], [{ ...rootNode([]), observedAt }]),
        build([edge], [rootNode([edge])], [], [evidence(dependency, '13', { observedAt })]),
        build(
          [edge],
          [rootNode([edge]), { ...evidence(dependency, '11', { observedAt }), dependencies: [] }],
        ),
      ]) {
        const report = preflightCmsDeploy(input);
        expect(report.ready).to.equal(false);
        expect(report.operations).to.deep.equal([]);
        expect(report.blockedReasons.join('\n')).to.include('stale evidence');
        expect(report.blockedReasons.join('\n')).not.to.include('hash mismatch');
      }
    }
  });

  it('does not reject unused stale fallback evidence when a fresh mapping is selected', () => {
    const dependency = identity('Landing Page Template', 'asset');
    const edge = descriptor(identity('Brand', 'root'), dependency);
    const report = preflightCmsDeploy(
      build(
        [edge],
        [rootNode([edge])],
        [evidence(dependency, '12', { observedAt: '2026-10-02T10:00:00.000Z' })],
        [evidence(dependency, '13')],
      ),
    );
    expect(report.ready).to.equal(true);
    expect(report.resolutions[0].provenance).to.equal('mapping');
  });

  it('binds the selected manifest and returns deterministic hashes and plans', () => {
    const input = build([], [rootNode([])]);
    const first = preflightCmsDeploy(input);
    const second = preflightCmsDeploy(structuredClone(input));
    expect(first).to.deep.equal(second);
    expect(first.ready).to.equal(true);
    expect(first.planHash).to.match(/^[a-f\d]{64}$/u);
    const changed = {
      ...input,
      manifest: { items: [{ ...input.manifest.items[0], sha256: '0'.repeat(64) }] },
    };
    const blocked = preflightCmsDeploy(changed);
    expect(blocked.ready).to.equal(false);
    expect(blocked.blockedReasons).to.include(
      'selected manifest is not bound to the portable sidecar',
    );
  });

  it('enforces declaration versions, strategy bounds, and extractor versions', () => {
    const dependency = identity('Landing Page Template', 'asset');
    const edge = descriptor(identity('Brand', 'root'), dependency);
    const input = build(
      [edge],
      [rootNode([edge]), { ...evidence(dependency, '11'), dependencies: [] }],
    );
    const changed = {
      ...input,
      providerVersion: '2.0.0',
      usageByType: {
        ...input.usageByType,
        [image.identity.type]: { strategy: 'filtered' as const, calls: 99, items: 99, pages: 99 },
      },
      dependencyExtractorVersions: {
        ...input.dependencyExtractorVersions,
        [image.identity.type]: 'wrong',
      },
    };
    const report = preflightCmsDeploy(changed);
    expect(report.ready).to.equal(false);
    expect(report.blockedReasons.join('\n'))
      .to.include('provider version')
      .and.include('strategy')
      .and.include('extractor');
    expect(brand.identity.type).to.equal('Brand');
  });

  it('blocks partial ownership, conflicting descriptors, and tampered package bytes', () => {
    const input = build([], [rootNode([])]);
    for (const changed of [
      { ...input, packageNodes: [{ ...input.packageNodes[0], complete: false }] },
      { ...input, packageNodes: [{ ...input.packageNodes[0], ownershipCertain: false }] },
      { ...input, packageFiles: [{ ...input.packageFiles[0], bytes: 'tampered' }] },
      { ...input, source: { source: 'changed' } },
      { ...input, targetWorkspace: { kind: 'salesforce-id' as const, value: 'other-target' } },
      { ...input, apiVersion: '66.0' },
    ]) {
      expect(preflightCmsDeploy(changed).ready).to.equal(false);
    }
  });

  it('accepts current runtime provenance independently of contract v1 and rejects incompatible package lines', () => {
    const input = build([], [rootNode([])]);
    expect(input.registryVersion).to.equal('1.0.0');
    expect(preflightCmsDeploy(input).ready).to.equal(true);
    for (const providerVersion of ['0.10.0', '0.10.999']) {
      expect(preflightCmsDeploy({ ...input, providerVersion }).ready).to.equal(true);
    }
    for (const providerVersion of ['0.9.999', '0.11.0', '1.0.0']) {
      expect(preflightCmsDeploy({ ...input, providerVersion }).blockedReasons.join(' ')).to.include(
        'provider version',
      );
    }
  });

  it('never invokes existing mutation writers for blocked or ready dry-run plans', () => {
    const writers = { createContent: sinon.stub(), createVariant: sinon.stub() };
    const ready = preflightCmsDeploy(build([], [rootNode([])]), writers);
    const blockedInput = build([], [rootNode([])]);
    const blocked = preflightCmsDeploy({ ...blockedInput, requestHash: 'wrong' }, writers);
    expect(ready.ready).to.equal(true);
    expect(blocked.ready).to.equal(false);
    expect(writers.createContent.notCalled).to.equal(true);
    expect(writers.createVariant.notCalled).to.equal(true);
  });
});
