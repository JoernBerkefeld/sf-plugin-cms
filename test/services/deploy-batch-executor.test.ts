import { expect } from 'chai';
import sinon from 'sinon';
import { Connection as JsforceConnection } from '@jsforce/jsforce-node';
import type { Connection } from '@salesforce/core';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import {
  executeDeployBatch,
  type DeployBatchPersistence,
  type DeployBatchReport,
} from '../../src/services/deploy-batch-executor.js';
import {
  rewriteAtomic,
  type WorkspaceImportRunReport,
} from '../../src/services/import-workspace.js';

const workspaceId = '0Zu000000000001AAA';
type Row = Record<string, unknown>;
async function fixture(existing = false) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'cms-batch-executor-'));
  const reportFile = path.join(directory, 'batch.json');
  const definitions = ['Alpha', 'Beta', 'Gamma'].map((apiName) => ({
    contract: 'sf-cms-source-definition',
    contractVersion: '1.0.0',
    identity: { family: 'cms', type: 'Email', apiName, context: { workspaceApiName: 'Source' } },
    contentType: 'sfdc_cms__email',
    language: 'en_US',
    title: apiName,
    folderPath: [],
    contentBody: { 'sfdc_cms:title': apiName, messagePurpose: 'Transactional', subjectLine: 'Hi' },
    companions: { rawHtml: `${apiName}.cms-email.html` },
  }));
  const files = definitions.map((definition) =>
    path.join(directory, `${definition.identity.apiName}.cms-email.json`),
  );
  for (const [index, definition] of definitions.entries()) {
    await writeFile(files[index], JSON.stringify(definition));
    await writeFile(path.join(directory, definition.companions.rawHtml), '<p>Desired</p>');
  }
  const records: Row[] = [];
  const details = new Map<string, Row>();
  const workspace = {
    id: workspaceId,
    apiName: 'Destination',
    defaultLanguage: 'en_US',
    rootFolderId: 'root',
    spaceType: { apiName: 'Marketing' },
  };
  const add = (index: number, body: Row) => {
    const definition = definitions[index];
    const number = index + 1;
    const contentId = `20Y00000000000${number}AAA`;
    const variantId = `9Ps00000000000${number}AAA`;
    const detail = {
      managedContentId: contentId,
      managedContentVariantId: variantId,
      contentKey: `MCKEY${number}`,
      apiName: definition.identity.apiName,
      title: definition.title,
      language: 'en_US',
      contentType: { fullyQualifiedName: 'sfdc_cms__email' },
      contentSpace: { id: workspaceId },
      folder: { id: 'root' },
      isPublished: false,
      status: { status: 'Draft' },
      contentBody: body,
      managedContentVersionId: 'before',
    };
    details.set(contentId, detail);
    details.set(variantId, detail);
    details.set(detail.contentKey, detail);
    records.push({
      Id: variantId,
      ManagedContentId: contentId,
      ManagedContentKey: detail.contentKey,
      ContentTypeFullyQualifiedName: 'sfdc_cms__email',
      Language: 'en_US',
      IsPublished: false,
      ManagedContentVariantStatus: 'Draft',
      IsPrimary: true,
      Name: definition.title,
      UrlName: null,
      ManagedContent: {
        AuthoredManagedContentSpaceId: workspaceId,
        ApiName: definition.identity.apiName,
      },
    });
    return detail;
  };
  if (existing) {
    add(1, { ...definitions[1].contentBody, rawHtml: '&lt;p&gt;Original&lt;/p&gt;' });
    add(2, { ...definitions[2].contentBody, rawHtml: '&lt;p&gt;Desired&lt;/p&gt;' });
  }
  const mutations: string[] = [];
  let puts = 0;
  let invalidFinalReadbackVersion = false;
  const requests: string[] = [];
  let failName: string | undefined;
  let onRead: (() => Promise<void>) | undefined;
  const request = function (
    input: { method: string; url: string; body?: string },
    options?: { retry?: { maxRetries: number } },
  ) {
    requests.push(input.url);
    const result = (async () => {
      const url = new URL(input.url, 'https://example.invalid');
      if (input.method !== 'GET') {
        expect(options?.retry?.maxRetries).to.equal(0);
        const body = JSON.parse(input.body!) as Row;
        const name = String(body.apiName);
        mutations.push(name);
        const batch = JSON.parse(await readFile(reportFile, 'utf8')) as DeployBatchReport;
        const item = batch.items.find((entry) => entry.source.targetIdentity.apiName === name)!;
        const journal = JSON.parse(
          await readFile(item.reportFile, 'utf8'),
        ) as WorkspaceImportRunReport;
        expect(journal.operations[0].state).to.equal('pending');
        if (name === failName) throw new Error('Authorization: Bearer secret-token');
        if (input.method === 'POST') {
          const detail = add(
            definitions.findIndex((definition) => definition.identity.apiName === name),
            body.contentBody as Row,
          );
          return {
            id: detail.managedContentId,
            contentKey: detail.contentKey,
            primaryVariantId: detail.managedContentVariantId,
          };
        }
        expect(input.method).to.equal('PUT');
        puts += 1;
        const detail = details.get(url.pathname.split('/').at(-1)!)!;
        detail.contentBody = {
          ...(body.contentBody as Row),
          rawHtml: '&lt;p&gt;Desired&lt;/p&gt;',
        };
        detail.managedContentVersionId = 'after';
        return detail;
      }
      if (onRead) await onRead();
      if (url.pathname.endsWith(`/spaces/${workspaceId}`)) return workspace;
      if (url.pathname.endsWith('/query')) {
        const soql = url.searchParams.get('q')!;
        const parentId = /ManagedContentId = '([^']+)'/u.exec(soql)?.[1];
        const selected = records.filter(
          (row) => parentId === undefined || row.ManagedContentId === parentId,
        );
        let rows = soql.includes('Id >')
          ? []
          : selected.toSorted((a, b) => String(a.Id).localeCompare(String(b.Id)));
        if (soql.includes('COUNT(Id)'))
          rows = selected.map((row) => ({
            ManagedContentId: row.ManagedContentId,
            siblingCount: 1,
          }));
        return { records: rows, totalSize: rows.length, done: true };
      }
      const detail = details.get(url.pathname.split('/').at(-1)!);
      if (detail) {
        if (invalidFinalReadbackVersion && puts > 0) {
          // Keep preparation coherent; invalidate only the executor's final detail read.
          if (
            url.pathname.includes('/variants/') &&
            requests.at(-3)?.endsWith(`/spaces/${workspaceId}`)
          )
            return { ...detail, managedContentVersionId: '' };
          if (requests.at(-2)?.endsWith(`/spaces/${workspaceId}`)) {
            const parent = { ...detail };
            delete (parent as Row).managedContentVersionId;
            return parent;
          }
        }
        return detail;
      }
      throw new Error('Unexpected request');
    })().then((value) => structuredClone(value));
    return Object.assign(result, { stream: () => new PassThrough() });
  };
  sinon.stub(JsforceConnection.prototype, 'request').callsFake(request as never);
  const connection = {
    accessToken: 'test-token',
    instanceUrl: 'https://example.invalid',
    version: '67.0',
    getApiVersion: () => '67.0',
    request,
  } as unknown as Pick<Connection, 'request' | 'getApiVersion'>;
  const input = {
    sources: { 'source-dir': [directory] },
    workspaceId,
    language: 'en_US',
    destinationOrgId: '00D000000000001AAA',
    reportFile,
  };
  return {
    input,
    files,
    definitions,
    mutations,
    puts: () => puts,
    invalidateFinalReadbackVersion: () => {
      invalidFinalReadbackVersion = true;
    },
    details,
    directory,
    fail: (name: string) => {
      failName = name;
    },
    onRead: (callback: () => Promise<void>) => {
      onRead = callback;
    },
    run: (persistence?: DeployBatchPersistence) =>
      executeDeployBatch(connection, input, {}, persistence),
    journal: async () => JSON.parse(await readFile(reportFile, 'utf8')) as DeployBatchReport,
  };
}

describe('internal sequential batch executor', () => {
  afterEach(() => sinon.restore());
  it('journals and verifies multiple CREATEs in deterministic order', async () => {
    const f = await fixture();
    const result = await f.run();
    expect(result.report.state).to.equal('completed');
    expect(result.qualification).to.equal('unqualified');
    expect(f.mutations).to.deep.equal(['Alpha', 'Beta', 'Gamma']);
    expect(result.report.summary).to.include({ created: 3, completed: 3, unattempted: 0 });
    expect(new Set(result.report.items.map((item) => item.reportFile)).size).to.equal(3);
    for (const item of result.report.items) {
      const journal = JSON.parse(
        await readFile(item.reportFile, 'utf8'),
      ) as WorkspaceImportRunReport;
      expect(journal.state).to.equal('completed');
      expect(journal.operations[0].result?.contentId).to.equal(item.target?.contentId);
    }
    expect(await f.journal()).to.deep.equal(result.report);
  });
  it('supports CREATE then UPDATE then unchanged without mutating unchanged', async () => {
    const f = await fixture(true);
    const result = await f.run();
    expect(result.report.blockedReasons).to.deep.equal([]);
    expect(result.report.state).to.equal('completed');
    expect(f.mutations).to.deep.equal(['Alpha', 'Beta']);
    expect(result.report.summary).to.include({
      created: 1,
      updated: 1,
      unchanged: 1,
      completed: 3,
    });
  });
  it('persists precise UPDATE readback diagnostics and stops without replay', async () => {
    const f = await fixture(true);
    let changed = false;
    const result = await f.run({
      rewrite: rewriteAtomic,
      item: {
        rewrite: async (file, report) => {
          await rewriteAtomic(file, report);
          if (
            !changed &&
            report.operations[0].operationKind === 'update-variant' &&
            report.operations[0].result
          ) {
            changed = true;
            f.invalidateFinalReadbackVersion();
          }
        },
      },
    });
    const expected =
      'UPDATE independent readback identity/content/version mismatch; failed checks: version-present';
    expect(f.mutations).to.deep.equal(['Alpha', 'Beta']);
    expect(f.puts()).to.equal(1);
    expect(result.report.state).to.equal('partial');
    expect(result.report.summary).to.include({ completed: 1, uncertain: 1, unattempted: 1 });
    expect(result.report.items.map((item) => item.outcome)).to.deep.equal([
      'created',
      'uncertain',
      'unattempted',
    ]);
    expect(result.report.items[1].error).to.equal(expected);
    expect(result.report.blockedReasons).to.deep.equal([expected]);
    const journal = JSON.parse(
      await readFile(result.report.items[1].reportFile, 'utf8'),
    ) as WorkspaceImportRunReport;
    expect(journal.state).to.equal('ownership-uncertain');
    expect(journal.operations[0].state).to.equal('pending');
    expect(journal.operations[0].error).to.equal(expected);
    expect(await f.journal()).to.deep.equal(result.report);
  });
  it('blocks every mutation when a later preflight item is ineligible', async () => {
    const f = await fixture();
    Object.assign(f.definitions[2], { urlName: 'BAD' });
    await writeFile(f.files[2], JSON.stringify(f.definitions[2]));
    const result = await f.run();
    expect(result.report.state).to.equal('blocked');
    expect(result.report.summary.unattempted).to.equal(3);
    expect(f.mutations).to.deep.equal([]);
  });
  it('retains verified prefix, uncertain item and all unattempted paths after lost response', async () => {
    const f = await fixture();
    f.fail('Beta');
    const result = await f.run();
    expect(result.report.state).to.equal('partial');
    expect(f.mutations).to.deep.equal(['Alpha', 'Beta']);
    expect(result.report.items.map((item) => item.outcome)).to.deep.equal([
      'created',
      'uncertain',
      'unattempted',
    ]);
    expect(result.report.items[2].source.definitionPath).to.equal(f.files[2]);
    expect(result.report.items[2].source.companionPaths).to.have.length(1);
    expect(JSON.stringify(result)).not.to.include('secret-token');
    const journal = JSON.parse(
      await readFile(result.report.items[1].reportFile, 'utf8'),
    ) as WorkspaceImportRunReport;
    expect(journal.state).to.equal('ownership-uncertain');
  });
  it('blocks when the first mutation is uncertain without any verified completion', async () => {
    const f = await fixture();
    f.fail('Alpha');
    const result = await f.run();
    expect(result.report.state).to.equal('blocked');
    expect(result.report.summary).to.include({ completed: 0, uncertain: 1, unattempted: 2 });
    expect(result.report.items.map((item) => item.outcome)).to.deep.equal([
      'uncertain',
      'unattempted',
      'unattempted',
    ]);
    expect(f.mutations).to.deep.equal(['Alpha']);
    const journal = JSON.parse(
      await readFile(result.report.items[0].reportFile, 'utf8'),
    ) as WorkspaceImportRunReport;
    expect(journal.state).to.equal('ownership-uncertain');
    expect(await f.journal()).to.deep.equal(result.report);
  });
  it('never overwrites an existing batch journal', async () => {
    const f = await fixture();
    await writeFile(f.input.reportFile, 'retain');
    try {
      await f.run();
      throw new Error('Expected exclusive failure');
    } catch (error) {
      expect((error as Error).message).to.include('EEXIST');
    }
    expect(await readFile(f.input.reportFile, 'utf8')).to.equal('retain');
    expect(f.mutations).to.have.length(0);
  });
  it('detects reconstructed content drift inside single-item prewrite', async () => {
    const f = await fixture();
    let changed = false;
    const result = await f.run({
      rewrite: rewriteAtomic,
      item: {
        rewrite: async (file, report) => {
          await rewriteAtomic(file, report);
          if (!changed) {
            changed = true;
            await writeFile(
              path.join(f.directory, f.definitions[2].companions.rawHtml),
              'Different',
            );
          }
        },
      },
    });
    expect(f.mutations).to.have.length(0);
    expect(result.report.state).to.equal('blocked');
    expect(result.report.items[0].outcome).to.equal('failed');
  });
  it('detects directory additions between verified items and preserves prefix', async () => {
    const f = await fixture();
    const result = await f.run({
      rewrite: async (file, report) => {
        await rewriteAtomic(file, report);
        if (report.summary.completed === 1) {
          const added = structuredClone(f.definitions[0]);
          added.identity.apiName = 'Extra';
          await writeFile(path.join(f.directory, 'Extra.cms-email.json'), JSON.stringify(added));
        }
      },
    });
    expect(f.mutations).to.deep.equal(['Alpha']);
    expect(result.report.items.map((item) => item.outcome)).to.deep.equal([
      'created',
      'unattempted',
      'unattempted',
    ]);
    expect(result.report.state).to.equal('partial');
  });
  it('stops if destination intent changes after planning', async () => {
    const f = await fixture(true);
    let changed = false;
    const result = await f.run({
      rewrite: async (file, report) => {
        await rewriteAtomic(file, report);
        if (!changed) {
          changed = true;
          f.details.get('20Y000000000002AAA')!.managedContentVersionId = 'drifted';
        }
      },
    });
    expect(result.report.items[1].outcome).to.equal('unattempted');
    expect(f.mutations).to.deep.equal(['Alpha']);
  });
  it('fails closed if durable batch intent is changed during item proof reads', async () => {
    const f = await fixture();
    let armed = false;
    f.onRead(async () => {
      if (armed) {
        armed = false;
        await writeFile(f.input.reportFile, '{}');
      }
    });
    const result = await f.run({
      rewrite: rewriteAtomic,
      item: {
        rewrite: async (file, report) => {
          await rewriteAtomic(file, report);
          if (report.state === 'applying') armed = true;
        },
      },
    });
    expect(f.mutations).to.have.length(0);
    expect(result.report.state).to.equal('blocked');
    expect(result.report.items[0].outcome).to.equal('failed');
  });
  it('retains a per-item durable-intent check after the final batch boundary', async () => {
    const f = await fixture();
    let itemFile: string | undefined;
    f.onRead(async () => {
      if (itemFile) await writeFile(itemFile, '{}');
    });
    const result = await f.run({
      rewrite: rewriteAtomic,
      item: {
        rewrite: async (file, report) => {
          await rewriteAtomic(file, report);
          if (report.state === 'applying') itemFile = file;
        },
      },
    });
    expect(f.mutations).to.have.length(0);
    expect(result.report.items[0].outcome).to.equal('failed');
    expect(result.report.items[0].error).to.include('durable intent changed');
  });
  it('stops after per-item result persistence failure without replay', async () => {
    const f = await fixture();
    let failed = false;
    const result = await f.run({
      rewrite: rewriteAtomic,
      item: {
        rewrite: async (file, report) => {
          if (!failed && report.operations[0].result) {
            failed = true;
            throw new Error('Result persistence failed');
          }
          await rewriteAtomic(file, report);
        },
      },
    });
    expect(f.mutations).to.deep.equal(['Alpha']);
    expect(result.report.items.map((item) => item.outcome)).to.deep.equal([
      'uncertain',
      'unattempted',
      'unattempted',
    ]);
    expect(result.report.state).to.equal('blocked');
    expect(result.report.summary).to.include({ completed: 0, uncertain: 1, unattempted: 2 });
    const journal = JSON.parse(
      await readFile(result.report.items[0].reportFile, 'utf8'),
    ) as WorkspaceImportRunReport;
    expect(journal.state).to.equal('ownership-uncertain');
    expect(journal.operations[0].state).to.equal('pending');
  });
  it('blocks before any executor if initial batch summary persistence fails', async () => {
    const f = await fixture();
    const result = await f.run({
      rewrite: async () => {
        throw new Error('Summary unavailable');
      },
    });
    expect(f.mutations).to.have.length(0);
    expect(result.report.state).to.equal('blocked');
    expect(result.report.summary.unattempted).to.equal(3);
  });
  it('summary persistence failure never erases verified per-item identities', async () => {
    const f = await fixture();
    const result = await f.run({
      rewrite: async (file, report) => {
        if (report.summary.completed > 0) throw new Error('Summary unavailable');
        await rewriteAtomic(file, report);
      },
    });
    expect(result.report.state).to.equal('partial');
    expect(result.report.summary).to.include({ completed: 1, unattempted: 2, uncertain: 0 });
    expect(f.mutations).to.deep.equal(['Alpha']);
    expect(result.report.blockedReasons.join(';')).to.include('summary persistence failed');
    const journal = JSON.parse(
      await readFile(result.report.items[0].reportFile, 'utf8'),
    ) as WorkspaceImportRunReport;
    expect(journal.state).to.equal('completed');
    expect(journal.operations[0].result?.contentId).to.equal('20Y000000000001AAA');
  });
});
