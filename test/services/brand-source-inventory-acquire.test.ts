import sinon from 'sinon';
import { runWithInvocationLogging } from '../../src/logging.js';
import type { Connection } from '@salesforce/core';
import { expect } from 'chai';
import type { WorkspaceExportManifest } from '../../src/contracts/workspace-export.js';
import { acquireBrandSourceInventoryEvidence } from '../../src/services/brand-source-inventory-acquire.js';
import { normalizeBrand } from '../../src/services/brand.js';
import { brandDetail } from '../fixtures/brand.js';

const workspaceId = '0Zuaj000007dgL8CAI';
const parentId = '20Yaj00000EpKvtEAF';
const variantId = '9Psaj00000IF7YHCA1';
const orgId = '00Daj00000bRQabEAG';
const rawPath = `items/${variantId}.json`;
const reportPath = `reports/brands/${variantId}.json`;
const acquiredAt = '2026-10-05T10:30:00.000Z';
type Native = Record<string, unknown>;

function setup() {
  const raw: Native = {
    ...brandDetail(variantId, 'Phase_5_Discovery_Brand', workspaceId),
    managedContentId: parentId,
    folder: null,
  };
  const parent: Native = { ...structuredClone(raw), contentVersion: 1, variantVersion: '1.1' };
  const row = {
    attributes: {
      type: 'ManagedContentVariant',
      url: `/services/data/v67.0/sobjects/ManagedContentVariant/${variantId}`,
    },
    Id: variantId,
    ManagedContentId: parentId,
    Language: raw.language,
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
  const full = { totalSize: 1, done: true, records: [row] };
  const empty = { totalSize: 0, done: true, records: [] };
  const count = {
    totalSize: 1,
    done: true,
    records: [
      { attributes: { type: 'AggregateResult' }, ManagedContentId: parentId, siblingCount: 1 },
    ],
  };
  const workspace = {
    id: workspaceId,
    name: 'Content Workspace for Marketing Cloud',
    apiName: 'Default_Content_Workspace',
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
    entries: [{ file: rawPath, variantId }],
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
      generatedAt: acquiredAt,
    },
    completeness: 'complete',
    dependencies: [],
    externalReferences: [],
    brandReports: [
      {
        path: reportPath,
        rawItemPath: rawPath,
        workspaceId,
        variantId,
        apiName: raw.apiName as string,
        contentType: 'sfdc_cms__brand',
        format: 'sf-cms-brand-read-report@1',
      },
    ],
    items: [
      { path: rawPath, sha256: 'a'.repeat(64), kind: 'cms.content' },
      { path: reportPath, sha256: 'b'.repeat(64), kind: 'cms.brand.read-report' },
    ],
  };
  const report = {
    format: 'sf-cms-brand-read-report@1',
    workspaceId,
    apiName: raw.apiName,
    variantId,
    rawItemPath: rawPath,
    normalization: normalizeBrand(raw)!,
  };
  const responses: unknown[] = [
    workspace,
    full,
    empty,
    count,
    parent,
    raw,
    structuredClone(full),
    structuredClone(empty),
    structuredClone(count),
  ];
  const calls: { request: { method: string; url: string }; options: unknown; refresh: unknown }[] =
    [];
  const refreshDelegate = {};
  const connection = {
    _refreshDelegate: refreshDelegate,
    getAuthInfoFields: () => ({ orgId }),
    getApiVersion: () => '67.0',
    request(
      this: { _refreshDelegate?: unknown },
      request: { method: string; url: string },
      options: unknown,
    ) {
      calls.push({ request, options, refresh: this._refreshDelegate });
      const response = responses.shift();
      if (response instanceof Error) return Promise.reject(response);
      return Promise.resolve(structuredClone(response));
    },
  };
  const acquire = () =>
    acquireBrandSourceInventoryEvidence(
      connection as unknown as Pick<Connection, 'request' | 'getApiVersion' | 'getAuthInfoFields'>,
      manifest,
      new Map([[rawPath, raw]]),
      new Map([[reportPath, report]]),
      { acquiredAt },
    );
  return {
    raw,
    parent,
    row,
    manifest,
    report,
    responses,
    calls,
    connection,
    refreshDelegate,
    acquire,
  };
}
async function rejects(change: (fixture: ReturnType<typeof setup>) => void): Promise<void> {
  const fixture = setup();
  change(fixture);
  let failure: unknown;
  try {
    await fixture.acquire();
  } catch (error) {
    failure = error;
  }
  expect(failure).to.be.instanceOf(TypeError);
  expect(fixture.calls.every((call) => call.request.method === 'GET')).to.equal(true);
}

describe('canonical Brand source inventory acquisition', () => {
  it('logs both direct Brand queries and shared JSON reads in the same invocation', async () => {
    const fixture = setup();
    const log = sinon.spy();
    await runWithInvocationLogging(
      { filePath: 'unused', log, close: async () => {} },
      () => fixture.acquire(),
      true,
    );
    const starts = log.args.filter(([, phase]) => phase === 'CMS JSON request');
    const ends = log.args.filter(([, phase]) => phase === 'CMS JSON response');
    expect(starts).to.have.length(fixture.calls.length);
    expect(ends).to.have.length(starts.length);
    expect(starts.some((call) => call[2].operationKey === 'inventory.brand')).to.equal(true);
    expect(ends.map((call) => call[2].requestId)).to.deep.equal(
      starts.map((call) => call[2].requestId),
    );
  });
  it('requests exact unfiltered keysets and grouped counts around actual parent/detail GETs', async () => {
    const fixture = setup();
    const original = structuredClone(fixture.manifest);
    const result = await fixture.acquire();
    expect(result.evidence.source).to.deep.equal({ orgId, apiVersion: '67.0', acquiredAt });
    expect(JSON.parse(result.bytes)).to.deep.equal(result.evidence);
    expect(result.bytes.endsWith('\n')).to.equal(true);
    expect(result.items).to.have.length(1);
    expect(result.evidence.workspace).to.include({
      name: 'Content Workspace for Marketing Cloud',
      apiName: 'Default_Content_Workspace',
    });
    expect(result.items[0].workspaceApiName).to.equal('Default_Content_Workspace');
    expect(fixture.manifest).to.deep.equal(original);
    expect(fixture.connection._refreshDelegate).to.equal(fixture.refreshDelegate);
    expect(fixture.calls).to.have.length(9);
    for (const call of fixture.calls) {
      expect(call.request.method).to.equal('GET');
      expect(call.refresh).to.equal(undefined);
      expect(call.options).to.deep.equal({ retry: { maxRetries: 0 }, timeout: 30_000 });
    }
    const queries = fixture.calls
      .filter((call) => call.request.url.includes('/query?'))
      .map((call) => decodeURIComponent(call.request.url.split('?q=')[1]));
    expect(queries[0]).to.equal(result.evidence.selections[0].inventory.query);
    expect(queries[1]).to.equal(
      queries[0].replace(' ORDER BY Id', ` AND Id > '${variantId}' ORDER BY Id`),
    );
    expect(queries[2]).to.equal(result.evidence.selections[0].inventory.countQuery);
    expect(queries.slice(3)).to.deep.equal(queries.slice(0, 3));
    expect(queries[0]).to.include(
      `ManagedContentId = '${parentId}' AND ManagedContent.AuthoredManagedContentSpaceId = '${workspaceId}'`,
    );
    expect(queries[0]).not.to.match(/(?:Language|IsPublished|ManagedContentVariantStatus) =/u);
    expect(fixture.calls[4].request.url).to.include(parentId);
    expect(fixture.calls[5].request.url).to.include(variantId);
    fixture.raw.title = 'changed';
    expect(result.items[0].raw.title).to.equal('Phase 5 Discovery Brand');
  });
  it('is deterministic with pinned acquisition time', async () => {
    const first = await setup().acquire();
    const second = await setup().acquire();
    expect(first.bytes).to.equal(second.bytes);
  });
  it('rejects wrong authenticated org and query injection before transport', async () => {
    await rejects((fixture) => {
      fixture.manifest.provenance.sourceOrgId = '00Dfj00000bRQabEAG';
    });
    const fixture = setup();
    fixture.manifest.entries[0].variantId = "9Ps' OR Id != null";
    let failure: unknown;
    try {
      await fixture.acquire();
    } catch (error) {
      failure = error;
    }
    expect(failure).to.be.instanceOf(TypeError);
    expect(fixture.calls).to.have.length(0);
  });
  it('rejects incomplete, miscounted, oversized and wrong-workspace pages', async () => {
    await rejects((fixture) => {
      (fixture.responses[1] as Native).done = false;
    });
    await rejects((fixture) => {
      (fixture.responses[1] as Native).totalSize = 2;
    });
    await rejects((fixture) => {
      fixture.row.ManagedContent.AuthoredManagedContentSpaceId = '0Zufj000006rx4wCAA';
    });
    await rejects((fixture) => {
      fixture.responses[1] = {
        done: true,
        totalSize: 2001,
        records: Array.from({ length: 2001 }, () => fixture.row),
      };
    });
    await rejects((fixture) => {
      fixture.responses[2] = structuredClone(fixture.responses[1]);
    });
  });
  it('rejects count/status/primary discrepancies and mutations between canonical reads', async () => {
    await rejects((fixture) => {
      ((fixture.responses[3] as Native).records as Native[])[0].siblingCount = 2;
    });
    await rejects((fixture) => {
      fixture.row.IsPrimary = false;
    });
    await rejects((fixture) => {
      fixture.row.ManagedContentVariantStatus = 'Published';
    });
    await rejects((fixture) => {
      ((fixture.responses[6] as Native).records as Native[])[0].Name = 'Changed';
    });
    await rejects((fixture) => {
      fixture.responses[6] = { totalSize: 0, done: true, records: [] };
    });
    await rejects((fixture) => {
      ((fixture.responses[8] as Native).records as Native[])[0].siblingCount = 2;
    });
  });
  it('rejects native parent/detail/body/report/root disagreements without publishing anything', async () => {
    await rejects((fixture) => {
      fixture.parent.apiName = 'Wrong';
    });
    await rejects((fixture) => {
      fixture.parent.contentBody = {
        ...(fixture.raw.contentBody as Native),
        baseFontSize: { value: 17, unit: 'px' },
      };
    });
    await rejects((fixture) => {
      fixture.responses[5] = { ...fixture.raw, title: 'Changed' };
    });
    await rejects((fixture) => {
      fixture.report.normalization = normalizeBrand({ ...fixture.raw, contentBody: {} })!;
    });
    await rejects((fixture) => {
      fixture.parent.folder = { id: workspaceId } as unknown as null;
    });
    await rejects((fixture) => {
      fixture.manifest.warnings.push({ code: 'COUNT_MISMATCH', message: 'bad' });
    });
    await rejects((fixture) => {
      fixture.manifest.completeness = 'partial';
    });
  });
  it('rejects pre-cancelled/invalid timeout reads before transport', async () => {
    for (const options of [{ signal: AbortSignal.abort() }, { timeoutMs: 0 }]) {
      const fixture = setup();
      let failure: unknown;
      try {
        await acquireBrandSourceInventoryEvidence(
          fixture.connection as unknown as Pick<
            Connection,
            'request' | 'getApiVersion' | 'getAuthInfoFields'
          >,
          fixture.manifest,
          new Map([[rawPath, fixture.raw]]),
          new Map([[reportPath, fixture.report]]),
          options,
        );
      } catch (error) {
        failure = error;
      }
      expect(failure).to.be.instanceOf(Error);
      expect(fixture.calls).to.have.length(0);
    }
  });
  it('does not retry a failing GET and redacts secrets', async () => {
    const fixture = setup();
    fixture.responses[1] = new Error('Authorization: Bearer secret-token');
    let message = '';
    try {
      await fixture.acquire();
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).not.to.include('secret-token');
    expect(fixture.calls).to.have.length(2);
  });
});
