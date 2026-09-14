import { expect } from 'chai';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertCmsInfoResult, type CmsInfoResult } from '../../src/contracts/info.js';
import {
  CMS_CONTRACT_VERSION,
  finalizeCmsEnvelope,
  sanitizeDiagnostics,
  serializeCmsEnvelope,
  type CmsEnvelope,
} from '../../src/contracts/shared.js';
import {
  assertWorkspaceExportManifest,
  assertWorkspaceExportSetResult,
  type WorkspaceExportSetResult,
} from '../../src/contracts/workspace-export.js';
import {
  assertWorkspaceImportResult,
  type WorkspaceImportResult,
} from '../../src/contracts/workspace-import.js';

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

async function loadFixture<T>(name: string): Promise<{ bytes: Buffer; value: CmsEnvelope<T> }> {
  const bytes = await readFile(path.join(fixtures, name));
  return { bytes, value: JSON.parse(bytes.toString('utf8')) as CmsEnvelope<T> };
}

describe('CMS contract foundation', () => {
  for (const [name, validator] of [
    ['success-info.json', assertCmsInfoResult],
    ['partial-export.json', assertWorkspaceExportSetResult],
    ['failed-import.json', assertWorkspaceImportResult],
    ['blocked-export.json', assertWorkspaceExportSetResult],
  ] as const) {
    it(`validates and deterministically serializes ${name}`, async () => {
      const { bytes, value } = await loadFixture(name);
      expect(bytes[0]).not.to.equal(239);
      expect(bytes.includes(Buffer.from('\r'))).to.equal(false);
      expect(bytes.at(-1)).to.equal(10);
      expect(serializeCmsEnvelope(value, validator)).to.equal(bytes.toString('utf8'));
    });
  }

  it('emits before setting deterministic success/partial/failure exits', async () => {
    for (const [name, validator, expectedExit] of [
      ['success-info.json', assertCmsInfoResult, 0],
      ['partial-export.json', assertWorkspaceExportSetResult, 2],
      ['failed-import.json', assertWorkspaceImportResult, 1],
      ['blocked-export.json', assertWorkspaceExportSetResult, 1],
    ] as const) {
      const { value } = await loadFixture(name);
      const events: string[] = [];
      finalizeCmsEnvelope(value, validator, {
        emit: () => events.push('emit'),
        setExitCode: (exitCode) => events.push(`exit:${exitCode}`),
      });
      expect(events).to.deep.equal(['emit', `exit:${expectedExit}`]);
    }
  });

  it('rejects unsupported versions, extra keys, unsafe paths and invalid hashes', async () => {
    const { value } = await loadFixture<WorkspaceExportSetResult>('partial-export.json');
    expect(() =>
      serializeCmsEnvelope(
        { ...value, contractVersion: '2.0.0' as typeof CMS_CONTRACT_VERSION },
        assertWorkspaceExportSetResult,
      ),
    ).to.throw('contractVersion');
    expect(() => assertWorkspaceExportSetResult({ ...value.result, extra: true })).to.throw(
      'exactly',
    );
    const result = structuredClone(value.result) as WorkspaceExportSetResult;
    result.workspaces[0].artifact!.path = '../escape';
    expect(() => assertWorkspaceExportSetResult(result, value.provenance)).to.throw('traversal');
    result.workspaces[0].artifact!.path = 'Marketing Workspace';
    result.workspaces[0].artifact!.manifestSha256 = 'ABC';
    expect(() => assertWorkspaceExportSetResult(result, value.provenance)).to.throw('SHA-256');
  });

  it('binds aggregate counts and status to authoritative workspace rows', async () => {
    const { value } = await loadFixture<WorkspaceExportSetResult>('partial-export.json');
    const cases = [
      { selection: { ...value.result!.selection, selectedCount: 2 } },
      { summary: { ...value.result!.summary, succeededCount: 1 } },
      { summary: { ...value.result!.summary, partialCount: 0 } },
      { summary: { ...value.result!.summary, failedCount: 1 } },
    ];
    for (const override of cases) {
      expect(() =>
        serializeCmsEnvelope(
          { ...value, result: { ...value.result!, ...override } },
          assertWorkspaceExportSetResult,
        ),
      ).to.throw('must match workspace rows');
    }
    expect(() =>
      serializeCmsEnvelope({ ...value, status: 'success' }, assertWorkspaceExportSetResult),
    ).to.throw('status must match workspace rows');
  });

  it('enforces exact five-field correlations, sorting, bindings, duplicates, and conflicts', async () => {
    const { value } = await loadFixture<WorkspaceExportSetResult>('partial-export.json');
    const result = structuredClone(value.result) as WorkspaceExportSetResult;
    const row = result.externalReferenceCorrelations[0];
    expect(Object.keys(row)).to.deep.equal([
      'sourceWorkspaceId',
      'sourceReference',
      'referenceKind',
      'referenceId',
      'packageManifestSha256',
    ]);
    expect(row.sourceReference).to.equal('  Opaque/Value%2FCase  ');
    result.externalReferenceCorrelations.push({ ...row });
    expect(() => assertWorkspaceExportSetResult(result, value.provenance)).to.throw('duplicate');
    result.externalReferenceCorrelations = [
      {
        ...row,
        packageManifestSha256: 'c'.repeat(64),
      },
    ];
    expect(() => assertWorkspaceExportSetResult(result, value.provenance)).to.throw('bound');
  });

  it('bounds and redacts diagnostics', () => {
    expect(
      sanitizeDiagnostics(
        [{ code: 'AUTH', message: 'Authorization: Bearer secret-token' }],
        'warnings',
      ),
    ).to.deep.equal([{ code: 'AUTH', message: 'Authorization: [REDACTED]' }]);
    expect(() =>
      sanitizeDiagnostics(
        Array.from({ length: 101 }, () => ({ code: 'MANY', message: 'bounded' })),
        'warnings',
      ),
    ).to.throw('exceeds 100');
    expect(() =>
      sanitizeDiagnostics([{ code: 'LONG', message: 'x'.repeat(1025) }], 'warnings'),
    ).to.throw('1024');
  });

  it('validates independently versioned manifest items', () => {
    const manifest = {
      schemaVersion: 1,
      mode: 'experimental-best-effort',
      workspaceId: '0ZuSource',
      search: {
        contentSpaceOrFolderIds: ['0ZuSource'],
        languages: ['All'],
        pageSize: 250,
        queryTerm: '*',
      },
      expectedCount: 1,
      foundCount: 1,
      exportedCount: 1,
      pagesRequested: 1,
      entries: [{ file: 'items/20Y.json', variantId: '20Y' }],
      rejectedVariantIds: [],
      failedVariantIds: [],
      warnings: [{ code: 'UNSUPPORTED_WILDCARD', message: 'Best-effort export.' }],
      contract: 'sf-cms-workspace-export',
      contractVersion: '1.0.0',
      provenance: {
        producer: 'sf-plugin-cms',
        sourceOrgId: '00DSource',
        sourceWorkspaceId: '0ZuSource',
        pluginVersion: '0.3.0',
        generatedAt: '2026-09-13T18:00:00.000Z',
      },
      completeness: 'partial',
      dependencies: [],
      externalReferences: [],
      items: [{ path: 'items/20Y.json', sha256: 'a'.repeat(64), kind: 'cms.content' }],
    };
    expect(() => assertWorkspaceExportManifest(manifest)).not.to.throw();
    const completeManifest = { ...manifest, completeness: 'complete' };
    expect(() => assertWorkspaceExportManifest(completeManifest)).not.to.throw();
    for (const contradictory of [
      { failedVariantIds: ['20Y'] },
      { rejectedVariantIds: ['20Y'] },
      { expectedCount: 2 },
      { foundCount: 2 },
      { exportedCount: 2 },
      { entries: [] },
      { items: [] },
      { warnings: [{ code: 'COUNT_MISMATCH', message: 'incomplete' }] },
    ]) {
      expect(() =>
        assertWorkspaceExportManifest({ ...completeManifest, ...contradictory }),
      ).to.throw('contradicts authoritative incompleteness evidence');
    }
    expect(Object.keys(manifest)).to.include.members([
      'schemaVersion',
      'mode',
      'workspaceId',
      'search',
      'expectedCount',
      'foundCount',
      'exportedCount',
      'pagesRequested',
      'entries',
      'rejectedVariantIds',
      'failedVariantIds',
      'warnings',
    ]);
    expect(() =>
      assertWorkspaceExportManifest({ ...manifest, items: [...manifest.items, manifest.items[0]] }),
    ).to.throw('duplicate');
    const referenceId = `ref:${'b'.repeat(64)}`;
    const referencedManifest = {
      ...manifest,
      dependencies: [],
      externalReferences: [
        {
          referenceId,
          owner: 'cms' as const,
          kind: 'cms.content',
          source: { workspaceId: '0ZuSource', sourceId: '20YContent' },
          portableKey: { scheme: 'cms-opaque-v1' as const, value: 'Exact Opaque Value' },
          required: true,
          resolution: 'included' as const,
        },
      ],
      items: [{ ...manifest.items[0], referenceId }],
    };
    expect(() => assertWorkspaceExportManifest(referencedManifest)).not.to.throw();
    for (const resolution of ['unresolved', 'unsupported'] as const) {
      expect(() =>
        assertWorkspaceExportManifest({
          ...referencedManifest,
          completeness: 'complete',
          externalReferences: [{ ...referencedManifest.externalReferences[0], resolution }],
        }),
      ).to.throw('contradicts authoritative incompleteness evidence');
    }
    expect(() =>
      assertWorkspaceExportManifest({
        ...referencedManifest,
        dependencies: [`ref:${'c'.repeat(64)}`],
      }),
    ).to.throw('must be empty');
    expect(() =>
      assertWorkspaceExportManifest({
        ...manifest,
        provenance: { ...manifest.provenance, sourceWorkspaceId: '0ZuOther' },
      }),
    ).to.throw('must match workspaceId');
    expect(() =>
      assertWorkspaceExportManifest({
        ...referencedManifest,
        externalReferences: [
          {
            ...referencedManifest.externalReferences[0],
            source: { ...referencedManifest.externalReferences[0].source, workspaceId: '0ZuOther' },
          },
        ],
      }),
    ).to.throw('workspaceId must match manifest');
    const missingLegacyField = { ...manifest } as Partial<typeof manifest>;
    delete missingLegacyField.warnings;
    expect(() => assertWorkspaceExportManifest(missingLegacyField)).to.throw('exactly');
  });

  it('rejects duplicate and conflicting import mappings', () => {
    const result: WorkspaceImportResult = {
      sourcePackage: { manifestSha256: 'c'.repeat(64), workspaceId: '0ZuSource' },
      target: { orgId: '00DTarget', workspaceId: '0ZuTarget' },
      integrity: {
        listedItemCount: 1,
        verifiedItemCount: 1,
        unlistedFileCount: 0,
        verified: true,
      },
      mappings: [],
      references: [],
    };
    const mapping = {
      referenceId: `ref:${'a'.repeat(64)}`,
      kind: 'cms.content',
      source: {
        sourceId: '20YSource',
        portableKey: { scheme: 'cms-opaque-v1' as const, value: 'opaque' },
      },
      target: { targetId: '20YTarget', targetReference: 'target-ref' },
      operation: 'created' as const,
      status: 'resolved' as const,
      cmsReferencesRewritten: true,
    };
    result.mappings = [mapping, { ...mapping }];
    expect(() => assertWorkspaceImportResult(result)).to.throw('duplicate');
    result.mappings = [mapping, { ...mapping, referenceId: `ref:${'b'.repeat(64)}` }];
    expect(() => assertWorkspaceImportResult(result)).to.throw('conflicting target');
  });

  it('freezes the exact info result contract', async () => {
    const { value } = await loadFixture<CmsInfoResult>('success-info.json');
    expect(value.result!.contracts.embeddedResults.externalReferenceCorrelations).to.deep.equal([
      'sf-cms-external-reference-correlations@1',
    ]);
    expect(value.result!.capabilities).to.deep.equal([
      {
        id: 'workspace.export.bulk',
        state: 'implemented',
        transport: 'cli-json',
        contract: 'sf-cms-workspace-export-set@1',
      },
      {
        id: 'workspace.export.dependency-closure',
        state: 'unavailable',
        transport: 'cli-json',
        contract: 'unavailable',
      },
      {
        id: 'workspace.export.external-reference-correlation',
        state: 'experimental',
        transport: 'cli-json',
        contract: 'sf-cms-external-reference-correlations@1',
      },
      {
        id: 'workspace.import.mapping',
        state: 'experimental',
        transport: 'cli-json',
        contract: 'sf-cms-workspace-import@1',
      },
    ]);
  });
});
