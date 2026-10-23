import { expect } from 'chai';
import type { Connection } from '@salesforce/core';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { executeDeployCreate } from '../../src/services/deploy-create-executor.js';
import { executeDeployBatchBrandItem } from '../../src/services/deploy-batch-executor.js';
import { brandBody, brandDetail } from '../fixtures/brand.js';
import {
  rewriteAtomic,
  type WorkspaceImportRunReport,
} from '../../src/services/import-workspace.js';

const workspaceId = '0Zu000000000001AAA';
const contentId = '20Y000000000001AAA';
const variantId = '9Ps000000000001AAA';
type Row = Record<string, unknown>;
async function fixture(reporting = true, brand = false) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'cms-create-executor-'));
  const definitionFile = path.join(
    directory,
    brand ? 'Welcome.cms-brand.json' : 'Welcome.cms-email.json',
  );
  const reportFile = path.join(directory, 'run.json');
  let evidence: WorkspaceImportRunReport | undefined;
  const currentReport = async () =>
    reporting
      ? (JSON.parse(await readFile(reportFile, 'utf8')) as WorkspaceImportRunReport)
      : evidence!;
  const body = brand
    ? brandBody('Welcome')
    : {
        'sfdc_cms:title': 'Welcome',
        'sfdc_cms:urlName': 'welcome',
        subjectLine: 'Hello',
        messagePurpose: 'Transactional',
        textContent: 'Résumé 世界\n',
        'lightning:dataProviders': [],
      };
  const definition = {
    contract: 'sf-cms-source-definition',
    contractVersion: '1.0.0',
    identity: {
      family: 'cms',
      type: brand ? 'Brand' : 'Email',
      apiName: 'Welcome',
      context: { workspaceApiName: 'Source' },
    },
    contentType: brand ? 'sfdc_cms__brand' : 'sfdc_cms__email',
    language: 'en_US',
    title: 'Welcome',
    urlName: 'welcome',
    folderPath: [],
    contentBody: body,
    companions: brand ? {} : { rawHtml: 'Welcome.cms-email.html' },
  };
  await writeFile(definitionFile, JSON.stringify(definition));
  await writeFile(path.join(directory, 'Welcome.cms-email.html'), '<p>Literal &amp; 世界</p>\n');
  const row: Row = {
    Id: variantId,
    ManagedContentId: contentId,
    ContentTypeFullyQualifiedName: brand ? 'sfdc_cms__brand' : 'sfdc_cms__email',
    Language: 'en_US',
    IsPublished: false,
    ManagedContentVariantStatus: 'Draft',
    IsPrimary: true,
    Name: 'Welcome',
    UrlName: 'welcome',
    ManagedContentKey: 'MCGENERATED',
    ManagedContent: { AuthoredManagedContentSpaceId: workspaceId, ApiName: 'Welcome' },
  };
  const detail: Row = {
    managedContentId: contentId,
    managedContentVariantId: variantId,
    contentKey: 'MCGENERATED',
    apiName: 'Welcome',
    urlName: 'welcome',
    language: 'en_US',
    title: 'Welcome',
    contentType: brand ? 'sfdc_cms__brand' : 'sfdc_cms__email',
    contentSpace: { id: workspaceId },
    folder: { id: 'root' },
    isPublished: false,
    status: { status: 'Draft' },
    contentBody: { ...body, rawHtml: '<p>Literal &amp; 世界</p>\n' },
  };
  if (brand)
    Object.assign(detail, brandDetail(variantId, 'Welcome', workspaceId), {
      title: 'Welcome',
      urlName: 'welcome',
      contentKey: 'MCGENERATED',
      managedContentId: contentId,
      folder: { id: 'root' },
      contentBody: body,
    });
  const response: Row = { id: contentId, contentKey: 'MCGENERATED', primaryVariantId: variantId };
  let posts = 0;
  let collision = false;
  let postError: Error | undefined;
  const requests: string[] = [];
  const workspace: Row = {
    id: workspaceId,
    apiName: 'Destination',
    defaultLanguage: 'en_US',
    rootFolderId: 'root',
    spaceType: { apiName: 'Marketing' },
  };
  const connection = {
    _refreshDelegate: () => {
      throw new Error('Refresh replay forbidden');
    },
    getApiVersion: () => '67.0',
    request(
      this: { _refreshDelegate?: unknown },
      input: { method: string; url: string; body?: string },
      options: { retry: { maxRetries: number } },
    ) {
      requests.push(`${input.method} ${input.url}`);
      const result = (async () => {
        if (options.retry) expect(options.retry.maxRetries).to.equal(0);
        const url = new URL(input.url, 'https://example.invalid');
        if (input.method === 'POST') {
          expect(this._refreshDelegate).to.equal(undefined);
          posts += 1;
          const journal = await currentReport();
          expect(journal.operations[0].state).to.equal('pending');
          expect(journal.operations[0].result).to.equal(undefined);
          expect(JSON.parse(input.body!).contentKey).to.equal(undefined);
          if (postError) throw postError;
          return structuredClone(response);
        }
        expect(input.method).to.equal('GET');
        if (url.pathname.endsWith(`/spaces/${workspaceId}`)) return structuredClone(workspace);
        if (url.pathname.endsWith('/query')) {
          const soql = url.searchParams.get('q')!;
          const rows = posts > 0 || collision ? [row] : [];
          let records = soql.includes('Id >') ? [] : rows;
          if (soql.includes('COUNT(Id)'))
            records = rows.map((record) => ({
              ManagedContentId: record.ManagedContentId,
              siblingCount: 1,
            }));
          return { records: structuredClone(records), done: true, totalSize: records.length };
        }
        if (brand && posts === 0) return structuredClone(detail);
        const journal = await currentReport();
        expect(journal.operations[0].result?.contentId).to.equal(contentId);
        expect(journal.state).to.equal('ownership-uncertain');
        return structuredClone(detail);
      })();
      return Object.assign(result, { stream: () => new PassThrough() });
    },
  } as unknown as Pick<Connection, 'request' | 'getApiVersion'>;
  const input = {
    definitionFile,
    workspaceId,
    language: 'en_US',
    destinationOrgId: '00D000000000001AAA',
    reportFile,
  };
  return {
    input,
    connection,
    row,
    detail,
    response,
    workspace,
    requests,
    definition,
    posts: () => posts,
    collide: () => {
      collision = true;
    },
    failPost: () => {
      postError = new Error('Lost response');
    },
    journal: async () => JSON.parse(await readFile(reportFile, 'utf8')) as WorkspaceImportRunReport,
    save: () => writeFile(definitionFile, JSON.stringify(definition)),
    evidence: () => evidence,
    files: () => readdir(directory),
    run: (rewrite = rewriteAtomic, beforeExecute?: () => Promise<void>) =>
      executeDeployCreate(
        connection,
        { ...input, reportFile: reporting ? reportFile : undefined },
        {},
        { rewrite },
        beforeExecute,
        (report) => {
          evidence = report;
        },
      ),
  };
}
async function failure(promise: Promise<unknown>, pattern: RegExp) {
  try {
    await promise;
  } catch (error) {
    expect((error as Error).message).to.match(pattern);
    return;
  }
  throw new Error('Expected rejection');
}

describe('internal journaled portable CREATE executor', () => {
  it('creates an internal Brand once and reacquires strict native evidence before completion', async () => {
    const f = await fixture(true, true);
    const result = await executeDeployBatchBrandItem(f.connection, f.input);
    expect(result.outcome).to.equal('created');
    expect(f.posts()).to.equal(1);
    const report = await f.journal();
    expect(report.state).to.equal('completed');
    expect(report.operations[0].state).to.equal('succeeded');
  });
  it('returns exact Brand unchanged without mutation or journal allocation', async () => {
    const f = await fixture(true, true);
    f.collide();
    const files = await f.files();
    const result = await executeDeployBatchBrandItem(f.connection, f.input);
    expect(result.outcome).to.equal('unchanged');
    expect(f.posts()).to.equal(0);
    expect(await f.files()).to.deep.equal(files);
  });
  it('keeps public CREATE closed and rejects Brand differences and lifecycle changes without writes', async () => {
    const publicSource = await fixture(true, true);
    await failure(
      executeDeployCreate(publicSource.connection, publicSource.input),
      /Unsupported|supported|not publicly/u,
    );
    expect(publicSource.requests).to.have.length(0);
    for (const change of ['body', 'lifecycle'] as const) {
      const f = await fixture(true, true);
      f.collide();
      if (change === 'body') f.detail.contentBody = brandBody('Changed');
      else f.row.IsPublished = true;
      await failure(executeDeployBatchBrandItem(f.connection, f.input), /blocked/u);
      expect(f.posts()).to.equal(0);
    }
  });
  it('rejects Brand source drift after durable intent before any POST', async () => {
    const f = await fixture(true, true);
    const rewrite: typeof rewriteAtomic = async (file, report) => {
      await rewriteAtomic(file, report);
      f.definition.title = 'Changed';
      await f.save();
    };
    await failure(
      executeDeployBatchBrandItem(f.connection, f.input, {}, { rewrite }),
      /title|binding|Brand|drift/u,
    );
    expect(f.posts()).to.equal(0);
    expect(await readFile(f.input.reportFile, 'utf8')).to.include('failed');
  });
  it('rejects Brand unknown parent absence and retains uncertain lost-response evidence', async () => {
    const collision = await fixture(true, true);
    collision.collide();
    collision.row.ManagedContent = { AuthoredManagedContentSpaceId: workspaceId, ApiName: null };
    await failure(executeDeployBatchBrandItem(collision.connection, collision.input), /blocked/u);
    expect(collision.posts()).to.equal(0);
    const lost = await fixture(true, true);
    lost.failPost();
    await failure(executeDeployBatchBrandItem(lost.connection, lost.input), /Lost response/u);
    expect(lost.posts()).to.equal(1);
    const report = await lost.journal();
    expect(report.state).to.equal('ownership-uncertain');
    expect(report.operations[0].state).to.equal('pending');
  });
  it('retains uncertain Brand CREATE identity when fresh acquisition rejects unsupported envelopes', async () => {
    const f = await fixture(true, true);
    f.detail.unexpected = true;
    await failure(
      executeDeployBatchBrandItem(f.connection, f.input),
      /Brand|unsupported|envelope/u,
    );
    expect(f.posts()).to.equal(1);
    const report = await f.journal();
    expect(report.state).to.equal('ownership-uncertain');
    expect(report.operations[0].result?.contentId).to.equal(contentId);
    expect(report.createdParents).to.have.length(0);
  });
  for (const scenario of ['success', 'boundary', 'lost-response', 'readback'] as const)
    it(`keeps journal-free CREATE ${scenario} evidence without persistence or replacement files`, async () => {
      const f = await fixture(false);
      const files = await f.files();
      let rewrites = 0;
      const rewrite: typeof rewriteAtomic = async () => {
        rewrites += 1;
        throw new Error('Unexpected persistence');
      };
      if (scenario === 'lost-response') f.failPost();
      if (scenario === 'readback') f.detail.isPublished = true;
      const run = f.run(rewrite, async () => {
        expect(f.evidence()?.operations[0].state).to.equal('pending');
        if (scenario === 'boundary') throw new Error('Boundary drift');
      });
      if (scenario === 'success') {
        const result = await run;
        expect(result.reportFile).to.equal(undefined);
        expect(result.report).to.equal(f.evidence());
        expect(result.report.state).to.equal('completed');
      } else await failure(run, /Boundary drift|Lost response|readback/u);
      expect(f.posts()).to.equal(scenario === 'boundary' ? 0 : 1);
      let expectedState = 'ownership-uncertain';
      if (scenario === 'success') expectedState = 'completed';
      if (scenario === 'boundary') expectedState = 'failed';
      expect(f.evidence()?.state).to.equal(expectedState);
      if (scenario === 'readback')
        expect(f.evidence()?.operations[0].result?.contentId).to.equal(contentId);
      expect(rewrites).to.equal(0);
      expect(await f.files()).to.deep.equal(files);
    });
  it('creates once after durable intent and independently verifies inventory/parent/detail', async () => {
    const f = await fixture();
    const result = await f.run();
    expect(result.qualification).to.equal('unqualified');
    expect(f.posts()).to.equal(1);
    expect(result.report.state).to.equal('completed');
    expect(result.report.operations[0].state).to.equal('succeeded');
    expect(result.report.createdParents[0].contentId).to.equal(contentId);
    expect(f.requests.filter((request) => request.includes('/query')).length).to.be.greaterThan(8);
    expect(await f.journal()).to.deep.equal(structuredClone(result.report));
    await failure(f.run(), /collision/u);
    expect(f.posts()).to.equal(1);
  });
  it('does not overwrite an existing journal', async () => {
    const f = await fixture();
    await writeFile(f.input.reportFile, 'existing');
    await failure(f.run(), /EEXIST/u);
    expect(await readFile(f.input.reportFile, 'utf8')).to.equal('existing');
    expect(f.posts()).to.equal(0);
  });
  it('never writes remotely after journal failure', async () => {
    const f = await fixture();
    await failure(
      f.run(async () => {
        throw new Error('Journal unavailable');
      }),
      /Journal unavailable/u,
    );
    expect(f.posts()).to.equal(0);
    const journal = await f.journal();
    expect(journal.operations[0].state).to.equal('pending');
  });
  it('rechecks cross-family collision after intent', async () => {
    const f = await fixture();
    await failure(
      f.run(async (file, report) => {
        await rewriteAtomic(file, report);
        f.row.ContentTypeFullyQualifiedName = 'sfdc_cms__image';
        f.collide();
      }),
      /collision/u,
    );
    expect(f.posts()).to.equal(0);
    const journal = await f.journal();
    expect(journal.state).to.equal('failed');
  });
  for (const drift of ['local', 'root'] as const)
    it(`rejects ${drift} drift after intent`, async () => {
      const f = await fixture();
      await failure(
        f.run(async (file, report) => {
          await rewriteAtomic(file, report);
          if (drift === 'local') {
            f.definition.contentBody.textContent = 'Changed';
            await f.save();
          } else f.workspace.rootFolderId = 'other-root';
        }),
        /drifted/u,
      );
      expect(f.posts()).to.equal(0);
    });
  for (const mismatch of ['body', 'published', 'inventory', 'variant', 'extra'] as const)
    it(`retains returned identities on ${mismatch} mismatch without further mutation`, async () => {
      const f = await fixture();
      if (mismatch === 'body') f.detail.contentBody = { rawHtml: 'wrong' };
      if (mismatch === 'published') f.detail.isPublished = true;
      if (mismatch === 'inventory') f.row.ManagedContentVariantStatus = 'Published';
      if (mismatch === 'variant') f.detail.managedContentVariantId = '9Ps000000000002AAA';
      if (mismatch === 'extra') (f.detail.contentBody as Row).unexpected = 'value';
      await failure(f.run(), /readback/u);
      expect(f.posts()).to.equal(1);
      const journal = await f.journal();
      expect(journal.state).to.equal('ownership-uncertain');
      expect(journal.operations[0].state).to.equal('pending');
      expect(journal.operations[0].result?.contentId).to.equal(contentId);
    });
  it('records malformed returned identities before semantic rejection', async () => {
    const f = await fixture();
    f.response.id = 'invalid';
    await failure(f.run(), /invalid native identities/u);
    const journal = await f.journal();
    expect(journal.operations[0].result?.contentId).to.equal('invalid');
    expect(f.posts()).to.equal(1);
  });
  it('leaves uncertain transport outcomes pending and never replays', async () => {
    const f = await fixture();
    f.failPost();
    await failure(f.run(), /Lost response/u);
    expect(f.posts()).to.equal(1);
    const journal = await f.journal();
    expect(journal.state).to.equal('ownership-uncertain');
    expect(journal.operations[0].state).to.equal('pending');
    expect(journal.operations[0].result).to.equal(undefined);
  });
  it('preserves already durable identities if completion persistence fails', async () => {
    const f = await fixture();
    await failure(
      f.run(async (file, report) => {
        if ((report as WorkspaceImportRunReport).state === 'completed')
          throw new Error('Cannot persist completion');
        await rewriteAtomic(file, report);
      }),
      /Cannot persist completion/u,
    );
    expect(f.posts()).to.equal(1);
    const journal = await f.journal();
    expect(journal.state).to.equal('ownership-uncertain');
    expect(journal.operations[0].state).to.equal('pending');
    expect(journal.operations[0].result).to.deep.equal({
      contentId,
      contentKey: 'MCGENERATED',
      primaryVariantId: variantId,
    });
  });
  it('rejects companion drift after durable intent', async () => {
    const f = await fixture();
    await failure(
      f.run(async (file, report) => {
        await rewriteAtomic(file, report);
        await writeFile(
          path.join(path.dirname(f.input.definitionFile), 'Welcome.cms-email.html'),
          'changed',
        );
      }),
      /drifted/u,
    );
    expect(f.posts()).to.equal(0);
  });
  it('rejects tampered durable intent immediately before mutation', async () => {
    const f = await fixture();
    await failure(
      f.run(async (file, report) => {
        await rewriteAtomic(file, { ...(report as WorkspaceImportRunReport), runId: 'tampered' });
      }),
      /durable intent changed/u,
    );
    expect(f.posts()).to.equal(0);
    const journal = await f.journal();
    expect(journal.state).to.equal('failed');
  });
  for (const mismatch of [false, true])
    it(`retains CREATE response evidence after one result write failure (mismatch: ${mismatch})`, async () => {
      const f = await fixture();
      if (mismatch) f.response.id = 'unexpected-parent';
      let failed = false;
      await failure(
        f.run(async (file, report) => {
          if (!failed && (report as WorkspaceImportRunReport).operations[0].result) {
            failed = true;
            throw new Error('First result write failed');
          }
          await rewriteAtomic(file, report);
        }),
        /may have succeeded/u,
      );
      expect(f.posts()).to.equal(1);
      const journal = await f.journal();
      expect(journal.state).to.equal('ownership-uncertain');
      expect(journal.operations[0].state).to.equal('pending');
      expect(journal.operations[0].result).to.deep.equal({
        contentId: mismatch ? 'unexpected-parent' : contentId,
        contentKey: 'MCGENERATED',
        primaryVariantId: variantId,
      });
    });
  it('uses importer uncertain-result persistence handling', async () => {
    const f = await fixture();
    await failure(
      f.run(async (file, report) => {
        if ((report as WorkspaceImportRunReport).operations[0].result)
          throw new Error('Cannot persist returned identity');
        await rewriteAtomic(file, report);
      }),
      /may have succeeded/u,
    );
    expect(f.posts()).to.equal(1);
    const journal = await f.journal();
    // Both evidence writes fail: only the original durable pending intent survives.
    expect(journal.state).to.equal('applying');
    expect(journal.operations[0].state).to.equal('pending');
    expect(journal.operations[0].result).to.equal(undefined);
  });
});
