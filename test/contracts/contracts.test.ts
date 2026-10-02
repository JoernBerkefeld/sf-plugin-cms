import { expect } from 'chai';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertCmsInfoResult, type CmsInfoResult } from '../../src/contracts/info.js';
import { assertContentDeleteResult } from '../../src/contracts/content-delete.js';
import { assertContentPublishResult } from '../../src/contracts/content-publish.js';
import { assertContentUnpublishResult } from '../../src/contracts/content-unpublish.js';
import { assertContentUpdateResult } from '../../src/contracts/content-update.js';
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
  assertWorkspaceImageImportResultV2,
  assertWorkspaceImportResult,
  type WorkspaceImageImportResultV2,
  type WorkspaceImportResult,
} from '../../src/contracts/workspace-import.js';

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

async function loadFixture<T>(name: string): Promise<{ bytes: Buffer; value: CmsEnvelope<T> }> {
  const bytes = await readFile(path.join(fixtures, name));
  return { bytes, value: JSON.parse(bytes.toString('utf8')) as CmsEnvelope<T> };
}

describe('CMS contract foundation', () => {
  it('validates the versioned bounded content delete result', () => {
    expect(() =>
      assertContentDeleteResult(
        {
          mode: 'dry-run',
          outcome: 'ready',
          target: {
            workspaceId: 'space',
            apiName: 'Email',
            language: 'en_US',
            contentId: 'content',
            variantId: 'variant',
          },
          evidence: {
            acknowledgementRequired: true,
            baselineHash: 'a'.repeat(64),
            currentHash: 'a'.repeat(64),
            ownershipReport: 'report/workspace-import-run.json',
            ownershipRequestSha256: 'b'.repeat(64),
            inventoryVariantCount: 1,
            siblingVariantCount: 1,
          },
          blockers: [],
        },
        undefined,
        'success',
      ),
    ).not.to.throw();
  });

  it('validates completed delete evidence when Salesforce removes the empty parent', () => {
    expect(() =>
      assertContentDeleteResult(
        {
          mode: 'apply',
          outcome: 'completed',
          target: {
            workspaceId: 'space',
            apiName: 'Email',
            language: 'en_US',
            contentId: 'content',
            variantId: 'variant',
          },
          evidence: {
            acknowledgedPermanentDelete: true,
            baselineHash: 'a'.repeat(64),
            ownershipReport: 'report/workspace-import-run.json',
            ownershipRequestSha256: 'b'.repeat(64),
            selectedInventoryMatches: 0,
            exactVariantAbsent: true,
            parentBehavior: 'not-found',
            remainingEmailVariantCount: 0,
          },
          blockers: [],
          reportFile: 'report/content-delete-run.json',
        },
        undefined,
        'success',
      ),
    ).not.to.throw();
  });

  it('rejects completed delete evidence without exact absence', () => {
    expect(() =>
      assertContentDeleteResult(
        {
          mode: 'apply',
          outcome: 'completed',
          target: {
            workspaceId: 'space',
            apiName: 'Email',
            language: 'en_US',
            contentId: 'content',
            variantId: 'variant',
          },
          evidence: {
            acknowledgedPermanentDelete: true,
            baselineHash: 'a'.repeat(64),
            ownershipReport: 'report/workspace-import-run.json',
            ownershipRequestSha256: 'b'.repeat(64),
            selectedInventoryMatches: 1,
            exactVariantAbsent: false,
            parentBehavior: 'present',
            parentIdentityPreserved: true,
            remainingEmailVariantCount: 1,
          },
          blockers: [],
          reportFile: 'report/content-delete-run.json',
        },
        undefined,
        'success',
      ),
    ).to.throw('completed delete evidence is invalid');
  });

  it('validates the versioned bounded content publish result', () => {
    expect(() =>
      assertContentPublishResult(
        {
          mode: 'dry-run',
          outcome: 'ready',
          target: {
            workspaceId: 'space',
            apiName: 'Email',
            language: 'en_US',
            contentId: 'content',
            variantId: 'variant',
          },
          evidence: {
            selectorScope: 'variant',
            includeContentReferences: false,
            noSendAcknowledgementRequired: true,
            baselineHash: 'a'.repeat(64),
            inventory: [
              {
                contentId: 'content',
                hash: 'a'.repeat(64),
                language: 'en_US',
                isPublished: false,
                status: 'Draft',
                variantId: 'variant',
              },
            ],
            siblingInventory: [
              {
                hash: 'a'.repeat(64),
                language: 'en_US',
                isPublished: false,
                status: 'Draft',
                variantId: 'variant',
              },
            ],
          },
          blockers: [],
        },
        undefined,
        'success',
      ),
    ).not.to.throw();
  });

  it('rejects contradictory bounded content publish evidence', () => {
    const ready = {
      mode: 'dry-run',
      outcome: 'ready',
      target: {
        workspaceId: 'space',
        apiName: 'Email',
        language: 'en_US',
        contentId: 'content',
        variantId: 'variant',
      },
      evidence: {
        selectorScope: 'variant',
        includeContentReferences: false,
        noSendAcknowledgementRequired: true,
        baselineHash: 'a'.repeat(64),
        inventory: [
          {
            contentId: 'content',
            hash: 'a'.repeat(64),
            language: 'en_US',
            isPublished: false,
            status: 'Draft',
            variantId: 'variant',
          },
        ],
        siblingInventory: [
          {
            hash: 'b'.repeat(64),
            language: 'en_US',
            isPublished: false,
            status: 'Draft',
            variantId: 'variant',
          },
        ],
      },
      blockers: [],
    };
    expect(() => assertContentPublishResult(ready, undefined, 'success')).to.throw();
  });

  it('validates the versioned bounded content unpublish result', () => {
    expect(() =>
      assertContentUnpublishResult(
        {
          mode: 'dry-run',
          outcome: 'ready',
          target: {
            workspaceId: 'space',
            apiName: 'Email',
            language: 'en_US',
            contentId: 'content',
            variantId: 'variant',
          },
          evidence: {
            selectorScope: 'parent',
            includeContentReferencesOmitted: true,
            activeUseStopsAcknowledgementRequired: true,
            baselineHash: 'a'.repeat(64),
            inventory: [
              {
                contentId: 'content',
                hash: 'a'.repeat(64),
                language: 'en_US',
                isPublished: true,
                status: 'Published',
                variantId: 'variant',
              },
            ],
            siblingInventory: [
              {
                hash: 'a'.repeat(64),
                language: 'en_US',
                isPublished: true,
                status: 'Published',
                variantId: 'variant',
              },
            ],
          },
          blockers: [],
        },
        undefined,
        'success',
      ),
    ).not.to.throw();
  });

  it('rejects completed unpublish evidence when the body hash changed', () => {
    const completed = {
      mode: 'apply',
      outcome: 'completed',
      target: {
        workspaceId: 'space',
        apiName: 'Email',
        language: 'en_US',
        contentId: 'content',
        variantId: 'variant',
      },
      evidence: {
        selectorScope: 'parent',
        includeContentReferencesOmitted: true,
        activeUseStopsAcknowledged: true,
        baselineHash: 'a'.repeat(64),
        postUnpublishHash: 'b'.repeat(64),
        deploymentId: 'deployment',
        inventory: [
          {
            contentId: 'content',
            hash: 'b'.repeat(64),
            language: 'en_US',
            isPublished: false,
            status: 'Draft',
            variantId: 'variant',
          },
        ],
        siblingInventory: [
          {
            hash: 'b'.repeat(64),
            language: 'en_US',
            isPublished: false,
            status: 'Draft',
            variantId: 'variant',
          },
        ],
      },
      blockers: [],
      reportFile: 'report/content-unpublish-run.json',
    };

    expect(() => assertContentUnpublishResult(completed, undefined, 'success')).to.throw(
      'unpublish must preserve the selected Email body hash',
    );
  });

  it('validates a definite pre-mutation unpublish rejection', () => {
    expect(() =>
      assertContentUnpublishResult(
        {
          mode: 'apply',
          outcome: 'rejected-before-mutation',
          target: {
            workspaceId: 'space',
            apiName: 'Email',
            language: 'en_US',
            contentId: 'content',
            variantId: 'variant',
          },
          evidence: {
            selectorScope: 'parent',
            includeContentReferencesOmitted: true,
            mutationError: {
              classification: 'definite-pre-mutation-rejection',
              errorCode: 'JSON_PARSER_ERROR',
              httpStatus: 400,
              requestBodySha256: 'a'.repeat(64),
              requestSelector: 'POST /connect/cms/contents/unpublish',
              salesforceMessage: 'Unrecognized field includeContentReferences',
            },
          },
          blockers: [
            {
              code: 'EMAIL_UNPUBLISH_REJECTED_BEFORE_MUTATION',
              message: 'rejected before mutation',
            },
          ],
          reportFile: 'report/content-unpublish-run.json',
          reconciliation: {
            workspaceId: 'space',
            contentId: 'content',
            variantId: 'variant',
          },
        },
        undefined,
        'failed',
      ),
    ).not.to.throw();
  });

  it('rejects contradictory bounded content unpublish evidence', () => {
    const ready = {
      mode: 'dry-run',
      outcome: 'ready',
      target: {
        workspaceId: 'space',
        apiName: 'Email',
        language: 'en_US',
        contentId: 'content',
        variantId: 'variant',
      },
      evidence: {
        selectorScope: 'parent',
        includeContentReferencesOmitted: true,
        activeUseStopsAcknowledgementRequired: true,
        baselineHash: 'a'.repeat(64),
        inventory: [
          {
            contentId: 'content',
            hash: 'a'.repeat(64),
            language: 'en_US',
            isPublished: true,
            status: 'Published',
            variantId: 'variant',
          },
        ],
        siblingInventory: [
          {
            hash: 'b'.repeat(64),
            language: 'en_US',
            isPublished: true,
            status: 'Published',
            variantId: 'variant',
          },
        ],
      },
      blockers: [],
    };
    expect(() => assertContentUnpublishResult(ready, undefined, 'success')).to.throw();
  });

  it('validates the versioned bounded content update result', () => {
    expect(() =>
      assertContentUpdateResult(
        {
          mode: 'dry-run',
          outcome: 'ready',
          target: {
            workspaceId: 'space',
            apiName: 'Email',
            language: 'en_US',
            contentId: 'content',
            variantId: 'variant',
          },
          evidence: {
            baselineHash: 'a'.repeat(64),
            payloadHash: 'b'.repeat(64),
            changedFields: ['contentBody.rawHtml'],
            siblingInventory: [
              {
                hash: 'c'.repeat(64),
                language: 'en_US',
                lifecycle: { isPublished: false, status: 'Draft' },
                variantId: 'variant',
              },
            ],
          },
          blockers: [],
        },
        undefined,
        'success',
      ),
    ).not.to.throw();
  });

  it('rejects outcome-inconsistent content update result shapes', () => {
    const ready = {
      mode: 'dry-run',
      outcome: 'ready',
      target: {
        workspaceId: 'space',
        apiName: 'Email',
        language: 'en_US',
        contentId: 'content',
        variantId: 'variant',
      },
      evidence: {
        baselineHash: 'a'.repeat(64),
        payloadHash: 'b'.repeat(64),
        changedFields: ['contentBody.rawHtml'],
        siblingInventory: [
          {
            hash: 'c'.repeat(64),
            language: 'en_US',
            lifecycle: { isPublished: false, status: 'Draft' },
            variantId: 'variant',
          },
        ],
      },
      blockers: [],
    };
    const uncertain = {
      mode: 'apply',
      outcome: 'ownership-uncertain',
      target: ready.target,
      evidence: { changedFields: ['contentBody.rawHtml'], payloadHash: 'b'.repeat(64) },
      blockers: [{ code: 'EMAIL_UPDATE_OWNERSHIP_UNCERTAIN', message: 'unknown' }],
      reportFile: 'report/content-update-run.json',
      reconciliation: {
        contentId: 'content',
        payloadHash: 'b'.repeat(64),
        variantId: 'variant',
        workspaceId: 'space',
      },
    };
    const blocked = {
      mode: 'apply',
      outcome: 'blocked',
      target: { workspaceId: 'space', apiName: 'Email', language: 'en_US' },
      evidence: { changedFields: [] },
      blockers: [{ code: 'EMAIL_UPDATE_PREFLIGHT_BLOCKED', message: 'blocked' }],
    };
    for (const malformed of [
      { ...ready, mode: 'apply' },
      { ...ready, evidence: { ...ready.evidence, changedFields: [] } },
      {
        ...ready,
        evidence: {
          ...ready.evidence,
          siblingInventory: [{ ...ready.evidence.siblingInventory[0], hash: 'bad' }],
        },
      },
      {
        ...ready,
        evidence: {
          ...ready.evidence,
          siblingInventory: [
            {
              ...ready.evidence.siblingInventory[0],
              lifecycle: { isPublished: true, status: 'Draft' },
            },
          ],
        },
      },
      { ...ready, outcome: 'completed', mode: 'apply', reportFile: 'report.json' },
      { ...uncertain, reconciliation: { ...uncertain.reconciliation, variantId: 'other' } },
      { ...uncertain, blockers: [] },
      {
        ...uncertain,
        blockers: [{ code: 'EMAIL_UPDATE_PREFLIGHT_BLOCKED', message: 'wrong outcome code' }],
      },
      { ...blocked, target: { ...blocked.target, variantId: 'variant' } },
      { ...blocked, reportFile: 'must-not-exist' },
      { ...blocked, evidence: { changedFields: ['contentBody.rawHtml'] } },
      {
        ...blocked,
        blockers: [{ code: 'EMAIL_UPDATE_OWNERSHIP_UNCERTAIN', message: 'wrong outcome code' }],
      },
    ]) {
      expect(() => assertContentUpdateResult(malformed)).to.throw();
    }
  });

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

  it('enforces strict v2 media descriptor and item integrity', () => {
    const sha256 = 'a'.repeat(64);
    const base = {
      schemaVersion: 2,
      mode: 'experimental-best-effort',
      workspaceId: 'space',
      search: {
        contentSpaceOrFolderIds: ['space'],
        languages: ['All'],
        pageSize: 250,
        queryTerm: '*',
      },
      expectedCount: 1,
      foundCount: 1,
      exportedCount: 1,
      pagesRequested: 1,
      entries: [{ file: 'items/variant.json', variantId: 'variant' }],
      rejectedVariantIds: [],
      failedVariantIds: [],
      warnings: [{ code: 'UNSUPPORTED_WILDCARD', message: 'experimental' }],
      contract: 'sf-cms-workspace-export',
      contractVersion: '2.0.0',
      media: [
        {
          variantId: 'variant',
          contentKey: 'key',
          path: 'media/variant.png',
          sha256,
          md5: 'b'.repeat(32),
          bytes: 12,
          mimeType: 'image/png',
          fileName: 'variant.png',
          sourceStatus: 'Draft',
          sourceModifiedAt: '2026-01-01T00:00:00.000Z',
          sourceVersion: '1',
          sourceUrl: '/cms/media/key',
          transport: 'experimental-undocumented-authoring-media',
        },
      ],
      provenance: {
        producer: 'sf-plugin-cms',
        sourceOrgId: 'org',
        sourceWorkspaceId: 'space',
        pluginVersion: '0.4.0',
        generatedAt: '2026-01-01T00:00:00.000Z',
      },
      completeness: 'complete',
      dependencies: [],
      externalReferences: [],
      items: [
        { path: 'items/variant.json', sha256: 'c'.repeat(64), kind: 'cms.content' },
        { path: 'media/variant.png', sha256, kind: 'cms.media' },
      ],
    } as const;
    expect(() => assertWorkspaceExportManifest(structuredClone(base))).not.to.throw();
    type MutableV2Manifest = {
      entries: Array<{ file: string; variantId: string }>;
      items: Array<{ kind: string; path: string; sha256: string }>;
      media: Array<{ path: string; sha256: string; variantId: string }>;
    };
    const mutations: Array<(value: MutableV2Manifest) => void> = [
      (value) => void value.items.pop(),
      (value) => void value.media.pop(),
      (value) => (value.media[0].sha256 = 'd'.repeat(64)),
      (value) => void value.items.push({ ...value.items[1] }),
      (value) => void value.media.push({ ...value.media[0], path: './media/variant.png' }),
      (value) => (value.media[0].variantId = 'orphan'),
      (value) => void value.entries.push({ file: 'items/other.json', variantId: 'variant' }),
    ];
    for (const mutate of mutations) {
      const malformed = structuredClone(base) as unknown as MutableV2Manifest;
      mutate(malformed);
      expect(() => assertWorkspaceExportManifest(malformed)).to.throw();
    }
  });

  it('strictly validates Preference Page report descriptors and raw/report bindings', () => {
    const manifest = {
      schemaVersion: 1,
      mode: 'experimental-best-effort',
      workspaceId: 'space',
      search: {
        contentSpaceOrFolderIds: ['space'],
        languages: ['All'],
        pageSize: 250,
        queryTerm: '*',
      },
      expectedCount: 1,
      foundCount: 1,
      exportedCount: 1,
      pagesRequested: 1,
      entries: [{ file: 'items/variant.json', variantId: 'variant' }],
      rejectedVariantIds: [],
      failedVariantIds: [],
      warnings: [
        { code: 'UNSUPPORTED_WILDCARD', message: 'experimental' },
        {
          code: 'REFERENCE_UNRESOLVED',
          message: 'Preference Page references remain unresolved.',
          variantIds: ['variant'],
        },
      ],
      contract: 'sf-cms-workspace-export',
      contractVersion: '1.0.0',
      provenance: {
        producer: 'sf-plugin-cms',
        sourceOrgId: 'org',
        sourceWorkspaceId: 'space',
        pluginVersion: '0.6.1',
        generatedAt: '2026-09-30T00:00:00.000Z',
      },
      completeness: 'partial',
      dependencies: [],
      preferencePageReports: [
        {
          path: 'reports/preference-pages/variant.json',
          rawItemPath: 'items/variant.json',
          workspaceId: 'space',
          contentType: 'sfdc_cms__preferencePage',
          variantId: 'variant',
          apiName: 'PreferencePage',
          format: 'sf-cms-preference-page-read-report@1',
        },
      ],
      externalReferences: [],
      items: [
        { path: 'items/variant.json', sha256: 'a'.repeat(64), kind: 'cms.content' },
        {
          path: 'reports/preference-pages/variant.json',
          sha256: 'b'.repeat(64),
          kind: 'cms.preference-page.read-report',
        },
      ],
    } as const;
    expect(() => assertWorkspaceExportManifest(structuredClone(manifest))).not.to.throw();
    expect(() =>
      assertWorkspaceExportManifest({ ...structuredClone(manifest), completeness: 'complete' }),
    ).to.throw('contradicts authoritative incompleteness evidence');
    const mutations: Array<(value: Record<string, unknown>) => void> = [
      (value) => {
        const reports = value.preferencePageReports as Array<Record<string, unknown>>;
        reports[0].path = '../report.json';
      },
      (value) => {
        const reports = value.preferencePageReports as Array<Record<string, unknown>>;
        reports[0].rawItemPath = 'items/missing.json';
      },
      (value) => {
        const reports = value.preferencePageReports as Array<Record<string, unknown>>;
        reports[0].variantId = 'other';
      },
      (value) => {
        const reports = value.preferencePageReports as Array<Record<string, unknown>>;
        reports[0].workspaceId = 'other-space';
      },
      (value) => {
        const reports = value.preferencePageReports as Array<Record<string, unknown>>;
        reports[0].contentType = 'sfdc_cms__form';
      },
      (value) => {
        const reports = value.preferencePageReports as Array<Record<string, unknown>>;
        reports.push({ ...reports[0] });
      },
      (value) => {
        const items = value.items as Array<Record<string, unknown>>;
        items.pop();
      },
      (value) => {
        const reports = value.preferencePageReports as Array<Record<string, unknown>>;
        reports.pop();
      },
      (value) => {
        const items = value.items as Array<Record<string, unknown>>;
        items.push({
          path: 'reports/preference-pages/orphan.json',
          sha256: 'c'.repeat(64),
          kind: 'cms.preference-page.read-report',
        });
      },
    ];
    for (const mutate of mutations) {
      const malformed = structuredClone(manifest) as unknown as Record<string, unknown>;
      mutate(malformed);
      expect(() => assertWorkspaceExportManifest(malformed)).to.throw();
    }
  });

  it('strictly validates Brand report descriptors and raw/report bindings', () => {
    const manifest = {
      schemaVersion: 1,
      mode: 'experimental-best-effort',
      workspaceId: 'space',
      search: {
        contentSpaceOrFolderIds: ['space'],
        languages: ['All'],
        pageSize: 250,
        queryTerm: '*',
      },
      expectedCount: 1,
      foundCount: 1,
      exportedCount: 1,
      pagesRequested: 1,
      entries: [{ file: 'items/variant.json', variantId: 'variant' }],
      rejectedVariantIds: [],
      failedVariantIds: [],
      warnings: [{ code: 'UNSUPPORTED_WILDCARD', message: 'experimental' }],
      contract: 'sf-cms-workspace-export',
      contractVersion: '1.0.0',
      provenance: {
        producer: 'sf-plugin-cms',
        sourceOrgId: 'org',
        sourceWorkspaceId: 'space',
        pluginVersion: '0.6.1',
        generatedAt: '2026-09-30T00:00:00.000Z',
      },
      completeness: 'complete',
      dependencies: [],
      brandReports: [
        {
          path: 'reports/brands/variant.json',
          rawItemPath: 'items/variant.json',
          workspaceId: 'space',
          contentType: 'sfdc_cms__brand',
          variantId: 'variant',
          apiName: 'Brand',
          format: 'sf-cms-brand-read-report@1',
        },
      ],
      externalReferences: [],
      items: [
        { path: 'items/variant.json', sha256: 'a'.repeat(64), kind: 'cms.content' },
        {
          path: 'reports/brands/variant.json',
          sha256: 'b'.repeat(64),
          kind: 'cms.brand.read-report',
        },
      ],
    } as const;
    expect(() => assertWorkspaceExportManifest(structuredClone(manifest))).not.to.throw();
    const mutations: Array<(value: Record<string, unknown>) => void> = [
      (value) => {
        const reports = value.brandReports as Array<Record<string, unknown>>;
        reports[0].path = '../report.json';
      },
      (value) => {
        const reports = value.brandReports as Array<Record<string, unknown>>;
        reports[0].rawItemPath = 'items/missing.json';
      },
      (value) => {
        const reports = value.brandReports as Array<Record<string, unknown>>;
        reports[0].variantId = 'other';
      },
      (value) => {
        const reports = value.brandReports as Array<Record<string, unknown>>;
        reports[0].workspaceId = 'other-space';
      },
      (value) => {
        const reports = value.brandReports as Array<Record<string, unknown>>;
        reports[0].contentType = 'sfdc_cms__form';
      },
      (value) => {
        const reports = value.brandReports as Array<Record<string, unknown>>;
        reports.push({ ...reports[0] });
      },
      (value) => {
        const items = value.items as Array<Record<string, unknown>>;
        items.pop();
      },
      (value) => {
        const reports = value.brandReports as Array<Record<string, unknown>>;
        reports.pop();
      },
      (value) => {
        const items = value.items as Array<Record<string, unknown>>;
        items.push({
          path: 'reports/brands/orphan.json',
          sha256: 'c'.repeat(64),
          kind: 'cms.brand.read-report',
        });
      },
    ];
    for (const mutate of mutations) {
      const malformed = structuredClone(manifest) as unknown as Record<string, unknown>;
      mutate(malformed);
      expect(() => assertWorkspaceExportManifest(malformed)).to.throw();
    }
  });

  it('strictly validates Form Handler report descriptors and raw/report bindings', () => {
    const manifest = {
      schemaVersion: 1,
      mode: 'experimental-best-effort',
      workspaceId: 'space',
      search: {
        contentSpaceOrFolderIds: ['space'],
        languages: ['All'],
        pageSize: 250,
        queryTerm: '*',
      },
      expectedCount: 1,
      foundCount: 1,
      exportedCount: 1,
      pagesRequested: 1,
      entries: [{ file: 'items/variant.json', variantId: 'variant' }],
      rejectedVariantIds: [],
      failedVariantIds: [],
      warnings: [],
      contract: 'sf-cms-workspace-export',
      contractVersion: '1.0.0',
      provenance: {
        producer: 'sf-plugin-cms',
        sourceOrgId: 'org',
        sourceWorkspaceId: 'space',
        pluginVersion: '0.6.1',
        generatedAt: '2026-10-01T00:00:00.000Z',
      },
      completeness: 'complete',
      dependencies: [],
      formHandlerReports: [
        {
          path: 'reports/form-handlers/variant.json',
          rawItemPath: 'items/variant.json',
          workspaceId: 'space',
          contentType: 'sfdc_cms__formHandler',
          variantId: 'variant',
          apiName: 'Handler',
          format: 'sf-cms-form-handler-read-report@1',
        },
      ],
      externalReferences: [],
      items: [
        { path: 'items/variant.json', sha256: 'a'.repeat(64), kind: 'cms.content' },
        {
          path: 'reports/form-handlers/variant.json',
          sha256: 'b'.repeat(64),
          kind: 'cms.form-handler.read-report',
        },
      ],
    } as const;
    expect(() => assertWorkspaceExportManifest(structuredClone(manifest))).not.to.throw();
    for (const mutate of [
      (value: Record<string, unknown>) => {
        (value.formHandlerReports as Array<Record<string, unknown>>)[0].path = '../report.json';
      },
      (value: Record<string, unknown>) => {
        (value.formHandlerReports as Array<Record<string, unknown>>)[0].rawItemPath =
          'items/missing.json';
      },
      (value: Record<string, unknown>) => {
        (value.formHandlerReports as Array<Record<string, unknown>>)[0].contentType =
          'sfdc_cms__form';
      },
      (value: Record<string, unknown>) => {
        (value.items as Array<Record<string, unknown>>).pop();
      },
      (value: Record<string, unknown>) => {
        (value.formHandlerReports as Array<Record<string, unknown>>).pop();
      },
    ]) {
      const malformed = structuredClone(manifest) as unknown as Record<string, unknown>;
      mutate(malformed);
      expect(() => assertWorkspaceExportManifest(malformed)).to.throw();
    }
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

  it('validates the import v2 image result contract', () => {
    const result: WorkspaceImageImportResultV2 = {
      sourcePackage: { manifestSha256: 'a'.repeat(64), workspaceId: 'space', manifestVersion: 2 },
      target: { orgId: 'org', workspaceId: 'target-space' },
      status: 'planned',
      assets: [
        {
          source: { family: 'cms', type: 'image', apiName: 'source_api', serverId: 'variant' },
          resolution: {
            method: 'explicit-map',
            target: { family: 'cms', type: 'image', apiName: 'target_api', title: 'Target' },
          },
          mutation: {
            requestSha256: 'b'.repeat(64),
            contentId: 'content-created',
            variantId: 'variant-created',
          },
          identities: {
            contentKey: { strategy: 'preserve', source: 'key', submitted: 'key' },
            apiName: { strategy: 'fresh', source: 'old', submitted: 'new' },
            title: { strategy: 'fresh', source: 'Old', submitted: 'New' },
            urlName: { strategy: 'generated' },
          },
          binary: {
            path: 'media/variant.png',
            sha256: 'b'.repeat(64),
            md5: 'c'.repeat(32),
            bytes: 8,
            mimeType: 'image/png',
          },
          metadataReadback: 'not-attempted',
          byteProof: 'unavailable',
          operationStatus: 'planned',
          reportStatus: 'not-created',
        },
      ],
    };
    expect(() => assertWorkspaceImageImportResultV2(result)).not.to.throw();
    const fallback = structuredClone(result);
    fallback.assets[0].resolution = {
      method: 'title-fallback',
      target: {
        family: 'cms',
        type: 'image',
        apiName: 'resolved_api',
        title: 'Exact title',
        workspaceId: 'target-space',
        language: 'en',
      },
    };
    expect(() => assertWorkspaceImageImportResultV2(fallback)).not.to.throw();
    expect(() =>
      assertWorkspaceImageImportResultV2({
        ...result,
        assets: [...result.assets, result.assets[0]],
      }),
    ).to.throw('duplicate');
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
        id: 'workspace.export.experimental-media',
        state: 'experimental',
        transport: 'cli-json',
        contract: 'sf-cms-workspace-export@2',
      },
      {
        id: 'content.delete.email',
        state: 'experimental',
        transport: 'cli-json',
        contract: 'sf-cms-content-delete@1',
      },
      {
        id: 'content.delete.email-template',
        state: 'experimental',
        transport: 'cli-json',
        contract: 'sf-cms-content-delete@2',
      },
      {
        id: 'content.publish.email',
        state: 'experimental',
        transport: 'cli-json',
        contract: 'sf-cms-content-publish@1',
      },
      {
        id: 'content.unpublish.email',
        state: 'experimental',
        transport: 'cli-json',
        contract: 'sf-cms-content-unpublish@1',
      },
      {
        id: 'content.update.email-raw-html',
        state: 'experimental',
        transport: 'cli-json',
        contract: 'sf-cms-content-update@1',
      },
      {
        id: 'content.update.email-template-raw-html',
        state: 'experimental',
        transport: 'cli-json',
        contract: 'sf-cms-content-update@2',
      },
      {
        id: 'workspace.import.email-fragment-create',
        state: 'experimental',
        transport: 'cli-json',
        contract: 'sf-cms-workspace-import@1',
      },
      {
        id: 'workspace.import.image-create',
        state: 'experimental',
        transport: 'cli-json',
        contract: 'sf-cms-workspace-import@2',
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
