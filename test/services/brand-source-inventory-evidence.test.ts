import { expect } from 'chai';
import type { WorkspaceExportManifest } from '../../src/contracts/workspace-export.js';
import { normalizeBrand } from '../../src/services/brand.js';
import { projectSourceDefinitions } from '../../src/services/source-definition.js';
import {
  BRAND_SOURCE_INVENTORY_KIND,
  BRAND_SOURCE_INVENTORY_PATH,
  replayBrandSourceInventoryEvidence,
  serializeBrandSourceInventoryEvidence,
  type BrandSourceInventoryEvidence,
} from '../../src/services/brand-source-inventory-evidence.js';
import { brandDetail } from '../fixtures/brand.js';

const workspaceId = '0Zuaj000007dgL8CAI';
const parentId = '20Yaj00000EpKvtEAF';
const variantId = '9Psaj00000IF7YHCA1';
const orgId = '00Daj00000bRQabEAG';
const rawItemPath = `items/${variantId}.json`;
const reportPath = `reports/brands/${variantId}.json`;
const rawSha256 = 'a'.repeat(64);
const reportSha256 = 'b'.repeat(64);

function setup() {
  // Captured native Brand body fixture and actual parent/variant/workspace relation IDs.
  const raw: Record<string, unknown> & {
    title: string;
    urlName: string;
    contentKey: string;
    apiName: string;
    contentBody: Record<string, unknown>;
    contentType: { fullyQualifiedName: string };
    folder: { id: string; resourceUrl: string };
  } = {
    ...(brandDetail(variantId, 'Phase_5_Discovery_Brand', workspaceId) as Record<
      string,
      unknown
    > & {
      title: string;
      urlName: string;
      contentKey: string;
      apiName: string;
      contentBody: Record<string, unknown>;
      contentType: { fullyQualifiedName: string };
    }),
    managedContentId: parentId,
    folder: {
      id: '9Puaj000007smuyCAA',
      resourceUrl: '/services/data/v67.0/connect/cms/folders/9Puaj000007smuyCAA',
    },
  };
  const parent = { ...structuredClone(raw), contentVersion: 1, variantVersion: '1.1' };
  parent.folder.resourceUrl = '/services/data/v67.0/connect/cms/folders/9Puaj000007smuy';
  // SOQL native selected-field shape, including standard nested relationship attributes.
  const row = {
    attributes: {
      type: 'ManagedContentVariant',
      url: `/services/data/v67.0/sobjects/ManagedContentVariant/${variantId}`,
    },
    Id: variantId,
    ManagedContentId: parentId,
    Language: 'en_US',
    IsPublished: false,
    ManagedContentVariantStatus: 'Draft',
    IsPrimary: true,
    Name: raw.title,
    UrlName: raw.urlName,
    ManagedContentKey: raw.contentKey,
    ManagedContent: {
      attributes: {
        type: 'ManagedContent',
        url: `/services/data/v67.0/sobjects/ManagedContent/${parentId}`,
      },
      AuthoredManagedContentSpaceId: workspaceId,
      ApiName: raw.apiName,
    },
  };
  const predicate = `ManagedContentId = '${parentId}' AND ManagedContent.AuthoredManagedContentSpaceId = '${workspaceId}'`;
  const query = `SELECT Id, ManagedContentId, Language, IsPublished, ManagedContentVariantStatus, IsPrimary, Name, UrlName, ManagedContentKey, ManagedContent.AuthoredManagedContentSpaceId, ManagedContent.ApiName FROM ManagedContentVariant WHERE ${predicate} ORDER BY Id LIMIT 2000`;
  const countQuery = `SELECT ManagedContentId, COUNT(Id) siblingCount FROM ManagedContentVariant WHERE ${predicate} GROUP BY ManagedContentId LIMIT 1`;
  const pages: {
    afterId: string | null;
    response: { totalSize: number; done: boolean; records: (typeof row)[] };
  }[] = [
    { afterId: null, response: { totalSize: 1, done: true, records: [row] } },
    { afterId: variantId, response: { totalSize: 0, done: true, records: [] } },
  ];
  const countResponse = {
    totalSize: 1,
    done: true,
    records: [
      { attributes: { type: 'AggregateResult' }, ManagedContentId: parentId, siblingCount: 1 },
    ],
  };
  const evidence = {
    contract: 'sf-cms-brand-source-inventory' as const,
    contractVersion: '1.0.0' as const,
    source: { orgId, apiVersion: '67.0', acquiredAt: '2026-10-05T09:40:00.000Z' },
    workspace: {
      id: workspaceId,
      name: 'Content Workspace for Marketing Cloud',
      apiName: 'Default_Content_Workspace',
      rootFolderId: '9Puaj000007smuyCAA',
    },
    selections: [
      {
        rawItemPath,
        rawSha256,
        reportPath,
        reportSha256,
        parent,
        inventory: {
          parentId,
          workspaceId,
          query,
          pages,
          countQuery,
          countResponse,
          recheck: { pages: structuredClone(pages), countResponse: structuredClone(countResponse) },
        },
      },
    ],
  };
  const report = {
    format: 'sf-cms-brand-read-report@1',
    workspaceId,
    apiName: raw.apiName,
    variantId,
    rawItemPath,
    normalization: normalizeBrand(raw)!,
  };
  const manifest: WorkspaceExportManifest = {
    schemaVersion: 1,
    mode: 'experimental-best-effort',
    workspaceId,
    search: {
      contentSpaceOrFolderIds: [workspaceId],
      languages: ['All'],
      pageSize: 250,
      queryTerm: '*',
    },
    expectedCount: 1,
    foundCount: 1,
    exportedCount: 1,
    pagesRequested: 1,
    entries: [{ file: rawItemPath, variantId }],
    rejectedVariantIds: [],
    failedVariantIds: [],
    warnings: [
      {
        code: 'UNSUPPORTED_WILDCARD',
        message: 'Wildcard search is unsupported and this export is experimental best-effort.',
      },
    ],
    contract: 'sf-cms-workspace-export',
    contractVersion: '1.0.0',
    provenance: {
      producer: 'sf-plugin-cms',
      sourceOrgId: orgId,
      sourceWorkspaceId: workspaceId,
      pluginVersion: '0.9.0',
      generatedAt: '2026-10-05T09:40:00Z',
    },
    completeness: 'complete',
    dependencies: [],
    externalReferences: [],
    brandReports: [
      {
        path: reportPath,
        rawItemPath,
        workspaceId,
        variantId,
        apiName: raw.apiName,
        contentType: 'sfdc_cms__brand',
        format: 'sf-cms-brand-read-report@1',
      },
    ],
    items: [
      { path: rawItemPath, sha256: rawSha256, kind: 'cms.content' },
      { path: reportPath, sha256: reportSha256, kind: 'cms.brand.read-report' },
      {
        path: BRAND_SOURCE_INVENTORY_PATH,
        sha256: 'c'.repeat(64),
        kind: BRAND_SOURCE_INVENTORY_KIND,
      },
    ],
  };
  const rawItems = new Map<string, Readonly<Record<string, unknown>>>([[rawItemPath, raw]]);
  const reports = new Map<string, Readonly<Record<string, unknown>>>([[reportPath, report]]);
  return { evidence, manifest, rawItems, reports, raw, report };
}
type Fixture = ReturnType<typeof setup>;
function replay(fixture: Fixture) {
  return replayBrandSourceInventoryEvidence(
    fixture.evidence,
    fixture.manifest,
    fixture.rawItems,
    fixture.reports,
  );
}
function reject(change: (fixture: Fixture) => void): void {
  const fixture = setup();
  change(fixture);
  expect(() => replay(fixture)).to.throw();
}

describe('pure canonical Brand source inventory evidence', () => {
  it('replays captured native shapes with explicit count/empty terminators and detached originals', () => {
    const fixture = setup();
    const original = structuredClone(fixture.evidence);
    const warnings = structuredClone(fixture.manifest.warnings);
    const result = replay(fixture);
    expect(
      projectSourceDefinitions(result).items[0].definition.identity.context.workspaceApiName,
    ).to.equal('Default_Content_Workspace');
    expect(result[0].folderPath).to.deep.equal([]);
    expect(fixture.evidence).to.deep.equal(original);
    expect(fixture.manifest.warnings).to.deep.equal(warnings);
    fixture.raw.title = 'Changed';
    fixture.evidence.selections[0].parent.title = 'Changed';
    expect(result[0].raw.title).to.equal('Phase 5 Discovery Brand');
    expect(result[0].parent.title).to.equal('Phase 5 Discovery Brand');
    expect(result[0].siblings.variants[0]).to.deep.equal(result[0].raw);
  });

  it('uses the API identity and path even when the distinct display name is path-safe', () => {
    const fixture = setup();
    fixture.evidence.workspace.name = 'Distinct_Display_Name';
    const result = replay(fixture);
    const projected = projectSourceDefinitions(result).items[0];
    expect(result[0].workspaceApiName).to.equal('Default_Content_Workspace');
    expect(projected.definition.identity.context.workspaceApiName).to.equal(
      'Default_Content_Workspace',
    );
    expect(projected.definitionPath).to.equal(
      'cms/Default_Content_Workspace/brand/Phase_5_Discovery_Brand.cms-brand.json',
    );
    expect(fixture.evidence.workspace.name).to.equal('Distinct_Display_Name');
  });

  it('fails closed for absent or unsafe workspace API names without display fallback', () => {
    for (const apiName of [
      undefined,
      null,
      '',
      42,
      true,
      {},
      [],
      '..',
      '../escape',
      'workspace/child',
      String.raw`workspace\child`,
      ' Default_Content_Workspace',
      'Default_Content_Workspace ',
      'Content Workspace',
      '\t',
      'CON',
      'nul',
      'COM1',
      'LPT9',
    ]) {
      reject((fixture) => {
        fixture.evidence.workspace.name = 'Safe_Display_Name';
        Object.assign(fixture.evidence.workspace, { apiName });
      });
    }
    reject((fixture) => {
      fixture.evidence.workspace.name = 'Safe_Display_Name';
      Reflect.deleteProperty(fixture.evidence.workspace, 'apiName');
    });
  });

  it('serializes ordered deterministic LF/no-BOM JSON retaining complete native workspace fields', () => {
    const fixture = setup();
    Object.assign(fixture.evidence.workspace, { nativeFields: { z: [2, 1], a: true } });
    const before = structuredClone(fixture.evidence);
    const bytes = serializeBrandSourceInventoryEvidence(fixture.evidence);
    expect(JSON.parse(bytes)).to.deep.equal(before);
    expect(
      serializeBrandSourceInventoryEvidence(
        Object.fromEntries(
          Object.entries(before).toReversed(),
        ) as unknown as BrandSourceInventoryEvidence,
      ),
    ).to.equal(bytes);
    expect(bytes.endsWith('\n')).to.equal(true);
    expect(bytes).not.to.include('\r');
    expect(bytes.codePointAt(0)).not.to.equal(65_279);
    expect(fixture.evidence).to.deep.equal(before);
  });

  it('pins deterministic parent/workspace queries without locale/publication filters or arbitrary authority', () => {
    const { evidence } = setup();
    const inventory = evidence.selections[0].inventory;
    expect(inventory.query).to.include(
      `ManagedContentId = '${parentId}' AND ManagedContent.AuthoredManagedContentSpaceId = '${workspaceId}' ORDER BY Id LIMIT 2000`,
    );
    expect(inventory.countQuery).to.include('GROUP BY ManagedContentId LIMIT 1');
    expect(inventory.pages.map((page) => page.afterId)).to.deep.equal([null, variantId]);
    expect(inventory.pages[1].response).to.deep.equal({ totalSize: 0, done: true, records: [] });
    reject((f) => {
      f.evidence.selections[0].inventory.query += " AND Language = 'en_US'";
    });
    reject((f) => {
      f.evidence.selections[0].inventory.countQuery = 'SELECT COUNT() FROM ManagedContentVariant';
    });
  });

  it('rejects schema additions, missing fields, malformed provenance, non-JSON and unsafe paths', () => {
    for (const patch of [
      { contractVersion: '2.0.0' },
      { extra: true },
      { source: undefined },
      { selections: [] },
    ]) {
      const { evidence } = setup();
      expect(() =>
        serializeBrandSourceInventoryEvidence({
          ...evidence,
          ...patch,
        } as BrandSourceInventoryEvidence),
      ).to.throw();
    }
    for (const value of [
      undefined,
      Number.NaN,
      Infinity,
      1n,
      new Date(),
      () => 1,
      Array.from({ length: 1 }),
    ]) {
      const { evidence } = setup();
      Object.assign(evidence.workspace, { value });
      expect(() => serializeBrandSourceInventoryEvidence(evidence)).to.throw();
    }
    reject((f) => {
      f.evidence.source.orgId = 'org';
    });
    reject((f) => {
      f.evidence.source.apiVersion = '67.0?q=bad';
    });
    reject((f) => {
      f.evidence.source.acquiredAt = 'yesterday';
    });
    reject((f) => {
      f.evidence.selections[0].rawItemPath = '../escape';
    });
    reject((f) => {
      Object.assign(f.evidence.selections[0].inventory.recheck, { bypass: true });
    });
  });

  it('rejects truncated, extra, duplicate, cursor, query-response and grouped-count drift', () => {
    reject((f) => {
      f.evidence.selections[0].inventory.pages.pop();
    });
    reject((f) => {
      f.evidence.selections[0].inventory.pages.push(
        structuredClone(f.evidence.selections[0].inventory.pages[1]),
      );
    });
    reject((f) => {
      f.evidence.selections[0].inventory.pages[1].afterId = null;
    });
    reject((f) => {
      f.evidence.selections[0].inventory.pages[0].response.done = false;
    });
    reject((f) => {
      f.evidence.selections[0].inventory.pages[0].response.totalSize = 2;
    });
    reject((f) => {
      Object.assign(f.evidence.selections[0].inventory.pages[0].response, {
        nextRecordsUrl: '/query/cursor',
      });
    });
    reject((f) => {
      f.evidence.selections[0].inventory.pages[0].response.records.push(
        structuredClone(f.evidence.selections[0].inventory.pages[0].response.records[0]),
      );
      f.evidence.selections[0].inventory.pages[0].response.totalSize = 2;
    });
    reject((f) => {
      f.evidence.selections[0].inventory.countResponse.records[0].siblingCount = 2;
    });
    reject((f) => {
      f.evidence.selections[0].inventory.countResponse.records[0].ManagedContentId =
        '20Yaj00000OtherEAF';
    });
    reject((f) => {
      f.evidence.selections[0].inventory.recheck.countResponse.done = false;
    });
    reject((f) => {
      f.evidence.selections[0].inventory.recheck.pages[0].response.records[0].Language = 'de_DE';
    });
    reject((f) => {
      f.evidence.selections[0].inventory.pages = Array.from({ length: 1001 }, () =>
        structuredClone(f.evidence.selections[0].inventory.pages[0]),
      );
    });
  });

  it('rejects extra/nonprimary/published siblings and parent/workspace/API/key/type/language/body drift', () => {
    for (const patch of [
      { IsPrimary: false },
      { IsPublished: true },
      { ManagedContentVariantStatus: 'Published' },
      { ManagedContentId: '20Yaj00000OtherEAF' },
      { Id: '9Psaj00000OtherCA1' },
      { Language: 'de_DE' },
      { ManagedContentKey: 'other' },
      { Name: 'Changed' },
      { UrlName: 'changed' },
    ]) {
      reject((f) => {
        Object.assign(f.evidence.selections[0].inventory.pages[0].response.records[0], patch);
        Object.assign(
          f.evidence.selections[0].inventory.recheck.pages[0].response.records[0],
          patch,
        );
      });
    }
    reject((f) => {
      f.evidence.selections[0].inventory.pages[0].response.records[0].ManagedContent.ApiName =
        'other';
    });
    reject((f) => {
      f.evidence.selections[0].inventory.pages[0].response.records[0].ManagedContent.AuthoredManagedContentSpaceId =
        '0Zuaj00000OtherCAI';
    });
    reject((f) => {
      f.evidence.selections[0].parent.contentKey = 'changed';
    });
    reject((f) => {
      f.evidence.selections[0].parent.contentBody = {};
    });
    reject((f) => {
      f.raw.contentType = { fullyQualifiedName: 'sfdc_cms__email' };
    });
    reject((f) => {
      f.raw.contentBody['lightning:dataProviders'] = [{ unsupported: true }];
    });
    reject((f) => {
      f.raw.folder.id = workspaceId;
    });
    reject((f) => {
      f.evidence.selections[0].parent.folder.resourceUrl += '?forged=1';
    });
  });

  it('requires original byte-verified path/hash/report bindings and immutable sole exact warning', () => {
    reject((f) => {
      f.rawItems.clear();
    });
    reject((f) => {
      f.reports.clear();
    });
    reject((f) => {
      f.rawItems.set('extra', {});
    });
    reject((f) => {
      f.manifest.items[0].sha256 = 'd'.repeat(64);
    });
    reject((f) => {
      f.manifest.items[1].sha256 = 'd'.repeat(64);
    });
    reject((f) => {
      f.manifest.items.pop();
    });
    reject((f) => {
      f.manifest.items.push({
        path: 'items/extra.json',
        kind: 'cms.content',
        sha256: 'd'.repeat(64),
      });
    });
    reject((f) => {
      f.manifest.brandReports = [];
    });
    reject((f) => {
      Object.assign(f.report.normalization.semantic, { body: {} });
    });
    reject((f) => {
      Object.assign(f.report.normalization.provenance, { managedContentId: 'other' });
    });
    reject((f) => {
      f.manifest.provenance.sourceOrgId = '00Daj00000OtherEAF';
    });
    reject((f) => {
      f.manifest.completeness = 'partial';
    });
    reject((f) => {
      f.manifest.rejectedVariantIds.push(variantId);
    });
    reject((f) => {
      f.manifest.failedVariantIds.push(variantId);
    });
    reject((f) => {
      f.manifest.expectedCount = 2;
    });
    reject((f) => {
      f.manifest.dependencies.push('dependency');
    });
    reject((f) => {
      f.manifest.warnings = [];
    });
    reject((f) => {
      f.manifest.warnings[0].message += ' Changed';
    });
    reject((f) => {
      f.manifest.warnings[0].variantIds = [variantId];
    });
    reject((f) => {
      f.manifest.warnings.push(structuredClone(f.manifest.warnings[0]));
    });
    reject((f) => {
      f.manifest.warnings = [{ code: 'COUNT_MISMATCH', message: 'Other warning' }];
    });
  });
});
