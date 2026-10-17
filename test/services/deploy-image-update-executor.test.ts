import { Connection as JsforceConnection } from '@jsforce/jsforce-node';
import { expect } from 'chai';
import type { Connection } from '@salesforce/core';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import sinon from 'sinon';
import { executeDeployImageUpdate } from '../../src/services/deploy-image-update-executor.js';
import { executeDeployImage } from '../../src/services/deploy-image-executor.js';
import { executeDeployBatch } from '../../src/services/deploy-batch-executor.js';
const TEST_IMAGE_SCOPE = {
  orgId: '00D000000000071AAA',
  workspaceId: '0Zu000000000071AAA',
  rootFolderId: '9Pu000000000071AAA',
  apiNames: ['Test_Image_A', 'Test_Image_B'],
};
import {
  rewriteAtomic,
  type WorkspaceImportRunReport,
} from '../../src/services/import-workspace.js';

type Row = Record<string, unknown>;
const noAction = () => {};
const workspaceId = '0Zu000000000001AAA';
const contentId = '20Y000000000001AAA';
const variantId = '9Ps000000000001AAA';
async function fixture(apiName = 'Hero', withCreate = false, createType = 'Image') {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'cms-image-update-executor-'));
  const definitionFile = path.join(directory, `${apiName}.cms-image.json`);
  const reportFile = path.join(directory, 'run.json');
  const fileName = `${apiName}.cms-image.media.png`;
  const companion = path.join(directory, fileName);
  const original = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1]);
  const bytes = Buffer.concat([original.subarray(0, 8), Buffer.from([2, 3])]);
  const definition = {
    contract: 'sf-cms-media-source',
    contractVersion: '1.0.0',
    identity: {
      family: 'cms',
      type: 'Image',
      apiName: 'Hero',
      context: { workspaceApiName: 'Source' },
    },
    contentType: 'sfdc_cms__image',
    language: 'en_US',
    folderPath: [],
    title: 'Hero image',
    urlName: 'hero-image',
    media: {
      representation: 'binary',
      mimeType: 'image/png',
      companion: { role: 'media', path: fileName },
    },
  };
  await writeFile(definitionFile, JSON.stringify(definition));
  await writeFile(companion, bytes);
  const workspace: Row = {
    id: workspaceId,
    apiName: 'Destination',
    defaultLanguage: 'en_US',
    rootFolderId: 'root',
    spaceType: { apiName: 'Marketing' },
  };
  const row: Row = {
    Id: variantId,
    ManagedContentId: contentId,
    ContentTypeFullyQualifiedName: 'sfdc_cms__image',
    Language: 'en_US',
    IsPublished: false,
    ManagedContentVariantStatus: 'Draft',
    IsPrimary: true,
    Name: 'Hero image',
    UrlName: 'hero-image',
    ManagedContentKey: 'MCGENERATED',
    ManagedContent: { AuthoredManagedContentSpaceId: workspaceId, ApiName: 'Hero' },
  };
  const detail: Row = {
    managedContentId: contentId,
    managedContentVariantId: variantId,
    contentKey: 'MCGENERATED',
    apiName: 'Hero',
    title: 'Hero image',
    urlName: 'hero-image',
    contentType: { fullyQualifiedName: 'sfdc_cms__image' },
    contentSpace: { id: workspaceId },
    language: 'en_US',
    folder: { id: 'root' },
    isPublished: false,
    status: { status: 'Draft' },
  };
  const response: Row = {
    managedContentId: contentId,
    managedContentVariantId: variantId,
    contentKey: 'MCGENERATED',
    language: 'en_US',
    isPublished: false,
    contentBody: {},
  };
  let posts = 0;
  let driftRootAfterAdmission = false;
  let unrelated = false;
  const createdContentType = {
    Image: 'sfdc_cms__image',
    Email: 'sfdc_cms__email',
    'Email Template': 'sfdc_cms__emailTemplate',
  }[createType];
  const createdBody = {
    'sfdc_cms:title': 'Qualification A',
    messagePurpose: 'Transactional',
    ...(createType === 'Email' ? { subjectLine: 'Hi' } : {}),
    rawHtml: '<p>Created</p>',
  };
  const createdRow = {
    ...structuredClone(row),
    ContentTypeFullyQualifiedName: createdContentType,
    Id: '9Ps000000000003AAA',
    ManagedContentId: '20Y000000000003AAA',
    Name: 'Qualification A',
    UrlName: 'qualification-a',
    ManagedContentKey: 'MCNEW',
    ManagedContent: {
      AuthoredManagedContentSpaceId: TEST_IMAGE_SCOPE.workspaceId,
      ApiName: createType === 'Image' ? TEST_IMAGE_SCOPE.apiNames[0] : 'Alpha',
    },
  };
  const createdFileName = `${TEST_IMAGE_SCOPE.apiNames[0]}.cms-image.media.png`;
  const createdDetail = () => ({
    ...detail,
    managedContentId: createdRow.ManagedContentId,
    managedContentVariantId: createdRow.Id,
    contentKey: 'MCNEW',
    apiName: createdRow.ManagedContent.ApiName,
    title: createdRow.Name,
    urlName: createdRow.UrlName,
    contentType: { fullyQualifiedName: createdContentType },
    contentBody:
      createType === 'Image'
        ? {
            'sfdc_cms:media': {
              source: { type: 'file', size: bytes.length, mimeType: 'image/png' },
              url: `/cms/media/MCNEW?version=1&fileHash=${createHash('md5').update(bytes).digest('hex')}&fileName=${createdFileName}`,
            },
          }
        : createdBody,
  });
  let puts = 0;
  let lose = false;
  let afterPut: () => void = noAction;
  let nativeName = fileName;
  let nativeMime = 'image/png';
  let remote = original;
  let downloadOverride: Buffer | undefined;
  let extra = false;
  let failRead = false;
  const journal = async () =>
    JSON.parse(await readFile(input.reportFile, 'utf8')) as WorkspaceImportRunReport;
  const fetcher = sinon.stub(globalThis, 'fetch').callsFake(
    async (address) =>
      new Response(String(address).includes('/MCNEW?') ? bytes : (downloadOverride ?? remote), {
        headers: { 'content-type': nativeMime },
      }),
  );
  const nativeDetail = () => ({
    ...detail,
    contentBody: {
      'sfdc_cms:media': {
        source: { type: 'file', size: remote.length, mimeType: nativeMime },
        url: `/cms/media/MCGENERATED?version=${puts ? '2' : '1'}&fileHash=${createHash('md5').update(remote).digest('hex')}&fileName=${nativeName}`,
      },
    },
  });
  const connection = {
    _refreshDelegate: () => {
      throw new Error('Replay forbidden');
    },
    getApiVersion: () => '67.0',
    request(
      this: { _refreshDelegate?: unknown },
      input: { method: string; url: string; body?: Buffer },
      options: { retry?: { maxRetries: number } },
    ) {
      const result = (async () => {
        const url = new URL(input.url, 'https://example.invalid');
        if (input.method === 'POST' && withCreate) {
          posts += 1;
          const intent = await journal();
          expect(intent.operations[0].state).to.equal('pending');
          return {
            managedContentId: createdRow.ManagedContentId,
            managedContentVariantId: createdRow.Id,
            contentKey: 'MCNEW',
          };
        }
        if (input.method === 'PUT') {
          expect(this._refreshDelegate).to.equal(undefined);
          expect(options.retry?.maxRetries).to.equal(0);
          expect(url.pathname).to.match(
            new RegExp(`/connect/cms/contents/variants/${variantId}$`, 'u'),
          );
          puts += 1;
          const intent = await journal();
          expect(intent.operations[0].state).to.equal('pending');
          expect(intent.operations[0].operationKind).to.equal('update-variant');
          expect(intent.operations[0].requestIdentity)
            .to.include(bytes.toString('base64'))
            .and.include(original.toString('base64'));
          expect(input.body!.includes(bytes)).to.equal(true);
          const jsonPart = input.body!.toString('utf8').split('\r\n\r\n')[1].split('\r\n--')[0];
          expect(JSON.parse(jsonPart)).to.deep.equal({
            title: detail.title,
            contentBody: { 'sfdc_cms:media': { source: { type: 'file' } } },
          });
          expect(detail.title).not.to.equal(detail.apiName);
          expect(intent.operations[0].requestIdentity).to.include(
            JSON.stringify({ title: detail.title }),
          );
          expect(input.body!.toString()).not.to.include('"apiName"');
          remote = bytes;
          afterPut();
          if (lose) throw new Error('Lost response');
          return structuredClone(response);
        }
        expect(input.method).to.equal('GET');
        if (puts) {
          if (failRead) throw new Error('Read failed');
          const recorded = await journal();
          expect(recorded.operations[0].result?.contentId).to.equal(contentId);
        }
        if (url.pathname.includes('/spaces/')) {
          const observed = structuredClone(workspace);
          if (driftRootAfterAdmission) {
            workspace.rootFolderId = '9Pu000000000002AAA';
            detail.folder = { id: workspace.rootFolderId };
          }
          return observed;
        }
        if (url.pathname.endsWith('/query')) {
          const q = url.searchParams.get('q')!;
          const rows = [
            row,
            ...(posts ? [createdRow] : []),
            ...(extra ? [{ ...row, Id: '9Ps000000000002AAA' }] : []),
            ...(unrelated
              ? [
                  {
                    ...createdRow,
                    Id: '9Ps000000000004AAA',
                    ManagedContentId: '20Y000000000004AAA',
                    ManagedContent: { ...createdRow.ManagedContent, ApiName: 'Unrelated' },
                  },
                ]
              : []),
          ];
          let scopedRows = rows;
          if (q.includes(`ManagedContentId = '${contentId}'`))
            scopedRows = rows.filter((r) => r.ManagedContentId === contentId);
          else if (q.includes(`ManagedContentId = '${createdRow.ManagedContentId}'`))
            scopedRows = rows.filter((r) => r.ManagedContentId === createdRow.ManagedContentId);
          if (q.includes('ContentTypeFullyQualifiedName IN'))
            scopedRows = scopedRows.filter((r) =>
              q.includes(`'${r.ContentTypeFullyQualifiedName}'`),
            );
          let records: Row[] = q.includes('Id >') ? [] : scopedRows;
          if (q.includes('COUNT(Id)'))
            records = [...new Set(scopedRows.map((r) => r.ManagedContentId))].map((id) => ({
              ManagedContentId: id,
              siblingCount: scopedRows.filter((r) => r.ManagedContentId === id).length,
            }));
          return { records: structuredClone(records), totalSize: records.length, done: true };
        }
        return structuredClone(
          withCreate &&
            (url.pathname.endsWith(createdRow.Id) ||
              url.pathname.endsWith(createdRow.ManagedContentId) ||
              url.pathname.endsWith('MCNEW'))
            ? createdDetail()
            : nativeDetail(),
        );
      })();
      return Object.assign(result, { stream: () => new PassThrough() });
    },
  } as unknown as Pick<Connection, 'request' | 'getApiVersion'> &
    Partial<Pick<Connection, 'accessToken' | 'instanceUrl'>>;
  // Native download authenticates; the fresh token-only transport still uses a local request double.
  Object.assign(connection, { accessToken: 'test-token', instanceUrl: 'https://example.invalid' });
  sinon.stub(JsforceConnection.prototype, 'request').callsFake(function (
    this: JsforceConnection,
    request,
    options,
  ) {
    return connection.request.call(this, request, options as Parameters<Connection['request']>[1]);
  });
  const input = {
    definitionFile,
    reportFile,
    workspaceId,
    language: 'en_US',
    destinationOrgId: '00D000000000001AAA',
  };
  return {
    connection,
    input,
    bytes,
    original,
    companion,
    workspace,
    row,
    detail,
    response,
    journal,
    fetcher,
    puts: () => puts,
    posts: () => posts,
    driftRootAfterAdmission: () => {
      driftRootAfterAdmission = true;
    },
    unrelated: () => {
      unrelated = true;
    },
    changeCreated: () => {
      createdRow.Name = 'Changed prefix title';
    },
    afterPut: (action: () => void) => {
      afterPut = action;
    },
    lose: () => {
      lose = true;
    },
    duplicate: () => {
      extra = true;
    },
    changeName: () => {
      nativeName = 'Other.png';
    },
    changeMime: () => {
      nativeMime = 'image/jpeg';
    },
    badBytes: () => {
      downloadOverride = original;
    },
    failRead: () => {
      failRead = true;
    },
    run: (
      rewrite: (file: string, report: WorkspaceImportRunReport) => Promise<void> = rewriteAtomic,
      options = {},
    ) => executeDeployImageUpdate(connection, input, options, { rewrite }),
  };
}
async function failure(operation: Promise<unknown>, pattern = /./u) {
  try {
    await operation;
  } catch (error) {
    expect((error as Error).message).to.match(pattern);
    return;
  }
  throw new Error('Expected rejection');
}

describe('private journaled bytes-only Image UPDATE executor', () => {
  afterEach(() => sinon.restore());
  for (const drift of [
    'none',
    'batch-intent',
    'create-update',
    'unrelated',
    'root-between-baseline-execution',
    'root-after-admission',
  ])
    it(`routes ordinary batch UPDATE with boundary ${drift}`, async () => {
      const withCreate = drift === 'create-update' || drift === 'unrelated';
      const f = await fixture(TEST_IMAGE_SCOPE.apiNames[1], withCreate);
      const definition = JSON.parse(await readFile(f.input.definitionFile, 'utf8'));
      definition.identity.apiName = TEST_IMAGE_SCOPE.apiNames[1];
      await writeFile(f.input.definitionFile, JSON.stringify(definition));
      f.input.workspaceId = TEST_IMAGE_SCOPE.workspaceId;
      f.input.destinationOrgId = TEST_IMAGE_SCOPE.orgId;
      f.workspace.id = TEST_IMAGE_SCOPE.workspaceId;
      f.workspace.rootFolderId = TEST_IMAGE_SCOPE.rootFolderId;
      f.row.ManagedContent = {
        AuthoredManagedContentSpaceId: TEST_IMAGE_SCOPE.workspaceId,
        ApiName: TEST_IMAGE_SCOPE.apiNames[1],
      };
      f.detail.apiName = TEST_IMAGE_SCOPE.apiNames[1];
      f.detail.contentSpace = { id: TEST_IMAGE_SCOPE.workspaceId };
      f.detail.folder = { id: TEST_IMAGE_SCOPE.rootFolderId };
      if (drift === 'root-after-admission') f.driftRootAfterAdmission();
      const definitions = [f.input.definitionFile];
      if (withCreate) {
        const create = structuredClone(definition);
        create.identity.apiName = TEST_IMAGE_SCOPE.apiNames[0];
        create.title = 'Qualification A';
        create.urlName = 'qualification-a';
        create.media.companion.path = `${TEST_IMAGE_SCOPE.apiNames[0]}.cms-image.media.png`;
        const file = path.join(
          path.dirname(f.input.definitionFile),
          `${TEST_IMAGE_SCOPE.apiNames[0]}.cms-image.json`,
        );
        await writeFile(file, JSON.stringify(create));
        await writeFile(path.join(path.dirname(file), create.media.companion.path), f.bytes);
        definitions.unshift(file);
      }
      const result = await executeDeployBatch(
        f.connection,
        {
          ...f.input,
          reportFile: path.join(path.dirname(f.input.reportFile), 'batch.json'),
          sources: { 'definition-file': definitions },
        },
        {},
        {
          rewrite: async (file, report) => {
            await rewriteAtomic(file, report);
            if (drift === 'unrelated' && report.summary.created === 1) f.unrelated();
            if (drift === 'root-between-baseline-execution' && report.state === 'applying') {
              f.workspace.rootFolderId = '9Pu000000000072AAA';
              f.detail.folder = { id: f.workspace.rootFolderId };
            }
          },
          item: {
            rewrite: async (file, report) => {
              f.input.reportFile = file;
              await rewriteAtomic(file, report);
              if (drift === 'batch-intent' && report.state === 'applying')
                await writeFile(path.join(path.dirname(file), 'batch.json'), '{}');
            },
          },
        },
      );
      let expectedState = 'completed';
      if (drift === 'batch-intent' || drift.startsWith('root-')) expectedState = 'blocked';
      if (drift === 'unrelated') expectedState = 'partial';
      expect(result.report.state, result.report.blockedReasons.join(';')).to.equal(expectedState);
      const blocked = ['batch-intent', 'unrelated'].includes(drift) || drift.startsWith('root-');
      expect(result.report.summary.updated).to.equal(blocked ? 0 : 1);
      if (!blocked)
        expect(result.report.items.at(-1)!.target).to.deep.equal({ contentId, variantId });
      expect(f.puts()).to.equal(blocked ? 0 : 1);
      expect(f.posts()).to.equal(withCreate ? 1 : 0);
      if (drift.startsWith('root-')) {
        expect(result.report.summary.completed).to.equal(0);
        expect(result.report.blockedReasons.join(';')).to.match(/workspace.*root/u);
      }
    });
  for (const createType of ['Email', 'Email Template'])
    for (const drift of ['none', 'changed-prefix', 'unrelated'])
      it(`completes mixed ${createType} CREATE then Image UPDATE only without ${drift} drift`, async () => {
        const f = await fixture('Hero', true, createType);
        f.input.workspaceId = TEST_IMAGE_SCOPE.workspaceId;
        f.workspace.id = TEST_IMAGE_SCOPE.workspaceId;
        f.row.ManagedContent = {
          AuthoredManagedContentSpaceId: TEST_IMAGE_SCOPE.workspaceId,
          ApiName: 'Hero',
        };
        f.detail.contentSpace = { id: TEST_IMAGE_SCOPE.workspaceId };
        const extension = createType === 'Email' ? 'email' : 'email-template';
        const directory = path.dirname(f.input.definitionFile);
        const createFile = path.join(directory, `Alpha.cms-${extension}.json`);
        await writeFile(
          createFile,
          JSON.stringify({
            contract: 'sf-cms-source-definition',
            contractVersion: '1.0.0',
            identity: {
              family: 'cms',
              type: createType,
              apiName: 'Alpha',
              context: { workspaceApiName: 'Source' },
            },
            contentType: createType === 'Email' ? 'sfdc_cms__email' : 'sfdc_cms__emailTemplate',
            language: 'en_US',
            title: 'Qualification A',
            urlName: 'qualification-a',
            folderPath: [],
            contentBody: {
              'sfdc_cms:title': 'Qualification A',
              messagePurpose: 'Transactional',
              ...(createType === 'Email' ? { subjectLine: 'Hi' } : {}),
            },
            companions: { rawHtml: `Alpha.cms-${extension}.html` },
          }),
        );
        await writeFile(path.join(directory, `Alpha.cms-${extension}.html`), '<p>Created</p>');
        const result = await executeDeployBatch(
          f.connection,
          {
            ...f.input,
            reportFile: path.join(directory, 'batch.json'),
            sources: { 'definition-file': [createFile, f.input.definitionFile] },
          },
          {},
          {
            rewrite: async (file, report) => {
              await rewriteAtomic(file, report);
              if (report.summary.created === 1) {
                if (drift === 'changed-prefix') f.changeCreated();
                if (drift === 'unrelated') f.unrelated();
              }
            },
            item: {
              rewrite: async (file, report) => {
                f.input.reportFile = file;
                await rewriteAtomic(file, report);
              },
            },
          },
        );
        const completed = drift === 'none';
        expect(result.report.state, result.report.blockedReasons.join(';')).to.equal(
          completed ? 'completed' : 'partial',
        );
        expect(result.report.items.map((item) => item.proposed)).to.deep.equal([
          'create',
          'update',
        ]);
        expect(result.report.items.map((item) => item.outcome)).to.deep.equal([
          'created',
          completed ? 'updated' : 'unattempted',
        ]);
        expect(result.report.summary.created).to.equal(1);
        expect(result.report.summary.updated).to.equal(completed ? 1 : 0);
        expect(f.posts()).to.equal(1);
        expect(f.puts()).to.equal(completed ? 1 : 0);
        if (!completed)
          expect(result.report.blockedReasons.join(';')).to.match(
            drift === 'changed-prefix'
              ? /Earlier verified CREATE inventory changed/u
              : /Batch Image UPDATE intent changed/u,
          );
      });
  it('routes explicit private UPDATE through the journaled engine', async () => {
    const f = await fixture();
    const rewrite = sinon.spy(rewriteAtomic);
    const result = await executeDeployImage(
      f.connection,
      { ...f.input, operation: 'update' },
      {},
      { rewrite },
    );
    if (!('report' in result)) throw new Error('Expected UPDATE journal result');
    expect(result.qualification).to.equal('unqualified');
    expect(result.report.state).to.equal('completed');
    expect(f.puts()).to.equal(1);
    expect(rewrite.called).to.equal(true);
    expect(await f.journal()).to.deep.equal(result.report);
  });
  it('awaits the dispatched batch boundary after durable intent and before PUT', async () => {
    const f = await fixture();
    const boundary = sinon.spy(async () => {
      expect(f.puts()).to.equal(0);
      const intent = await f.journal();
      expect(intent.operations[0].state).to.equal('pending');
      await Promise.resolve();
    });
    await executeDeployImage(
      f.connection,
      { ...f.input, operation: 'update' },
      {},
      undefined,
      boundary,
    );
    expect(boundary.calledOnce).to.equal(true);
    expect(f.puts()).to.equal(1);
  });
  for (const change of ['reject', 'bytes', 'journal', 'cancel'])
    it(`blocks UPDATE transport when the dispatched boundary causes ${change}`, async () => {
      const f = await fixture();
      const controller = new AbortController();
      await failure(
        executeDeployImage(
          f.connection,
          { ...f.input, operation: 'update' },
          { signal: controller.signal },
          undefined,
          async () => {
            expect(f.puts()).to.equal(0);
            const intent = await f.journal();
            expect(intent.operations[0].state).to.equal('pending');
            if (change === 'reject') throw new Error('Batch selection drift');
            if (change === 'bytes')
              await writeFile(f.companion, Buffer.concat([f.bytes, Buffer.from([3])]));
            if (change === 'journal') await writeFile(f.input.reportFile, '{}');
            if (change === 'cancel') controller.abort();
          },
        ),
        /Batch selection drift|drifted|intent changed|cancelled|abort/iu,
      );
      expect(f.puts()).to.equal(0);
      const report = await f.journal();
      expect(report.state).to.equal('failed');
    });
  it('journals desired and observed bytes, writes once and independently verifies preserved identity and replacement', async () => {
    const f = await fixture();
    const result = await f.run();
    expect(result.qualification).to.equal('unqualified');
    expect(result.report.state).to.equal('completed');
    expect(result.report.operations[0].state).to.equal('succeeded');
    expect(result.report.operations[0].result).to.deep.equal({
      contentId,
      variantId,
      contentKey: 'MCGENERATED',
    });
    expect(result.report.createdParents).to.have.length(0);
    expect(await f.journal().then((report) => report)).to.deep.equal(result.report);
    expect(f.puts()).to.equal(1);
    expect(f.fetcher.callCount).to.equal(3);
    const identity = result.report.operations[0].requestIdentity;
    const serializedIdentity = JSON.stringify(identity);
    expect(JSON.parse(serializedIdentity)).to.equal(identity);
    expect(identity).to.include('bytesBase64').and.include('mediaSha256');
  });
  it('rejects invalid org before journaling or mutation', async () => {
    const f = await fixture();
    f.input.destinationOrgId = 'wrong';
    await failure(f.run(), /org ID/u);
    expect(f.puts()).to.equal(0);
  });
  it('never overwrites existing intent', async () => {
    const f = await fixture();
    await writeFile(f.input.reportFile, 'existing');
    await failure(f.run(), /EEXIST/u);
    expect(f.puts()).to.equal(0);
    expect(await readFile(f.input.reportFile, 'utf8')).to.equal('existing');
  });
  it('does not mutate after persistence failure', async () => {
    const f = await fixture();
    await failure(
      f.run(async () => {
        throw new Error('Disk failed');
      }),
      /Disk failed/u,
    );
    expect(f.puts()).to.equal(0);
  });
  for (const kind of ['bytes', 'workspace', 'inventory', 'detail', 'journal', 'cancel'])
    it(`blocks ${kind} drift after durable intent without PUT`, async () => {
      const f = await fixture();
      const controller = new AbortController();
      let changed = false;
      await failure(
        f.run(
          async (file, report) => {
            await rewriteAtomic(file, report);
            if (changed) return;
            changed = true;
            if (kind === 'bytes')
              await writeFile(f.companion, Buffer.concat([f.bytes, Buffer.from([4])]));
            if (kind === 'workspace') f.workspace.apiName = 'Changed';
            if (kind === 'inventory') f.row.Name = 'Changed';
            if (kind === 'detail') f.detail.lastModifiedDate = 'changed';
            if (kind === 'journal') await writeFile(file, '{}');
            if (kind === 'cancel') controller.abort();
          },
          { signal: controller.signal },
        ),
      );
      expect(f.puts()).to.equal(0);
      expect(await f.journal().then((report) => report.state)).to.equal('failed');
    });
  for (const kind of [
    'lost',
    'partial',
    'parent',
    'variant',
    'key',
    'inventory',
    'sibling',
    'metadata',
    'folder',
    'filename',
    'mime',
    'bytes',
    'read',
    'workspace',
  ])
    it(`retains uncertain outcome after ${kind} with no retry`, async () => {
      const f = await fixture();
      if (kind === 'lost') f.lose();
      if (kind === 'partial') {
        delete f.response.managedContentVariantId;
        delete f.response.contentBody;
      }
      if (kind === 'parent') f.response.managedContentId = '20Y000000000002AAA';
      if (kind === 'variant') f.response.managedContentVariantId = '9Ps000000000002AAA';
      if (kind === 'key') f.response.contentKey = 'OTHER';
      f.afterPut(() => {
        if (kind === 'inventory') f.row.IsPublished = true;
        if (kind === 'sibling') f.duplicate();
        if (kind === 'metadata') f.detail.title = 'Changed';
        if (kind === 'folder') f.detail.folder = { id: 'elsewhere' };
        if (kind === 'filename') f.changeName();
        if (kind === 'mime') f.changeMime();
        if (kind === 'bytes') f.badBytes();
        if (kind === 'read') f.failRead();
        if (kind === 'workspace') f.workspace.rootFolderId = 'elsewhere';
      });
      await failure(f.run());
      expect(f.puts()).to.equal(1);
      const report = await f.journal();
      expect(report.state).to.equal('ownership-uncertain');
      expect(report.operations[0].state).to.equal('pending');
      expect(report.createdParents).to.have.length(0);
      if (kind === 'lost') expect(report.operations[0].result).to.equal(undefined);
      else expect(report.operations[0].result?.contentId).to.equal(f.response.managedContentId);
      if (kind === 'partial') expect(report.operations[0].result?.variantId).to.equal(undefined);
    });
  it('awaits raw partial identity persistence before transport validation', async () => {
    const f = await fixture();
    delete f.response.contentBody;
    let observed = false;
    await failure(
      f.run(async (file, report) => {
        if (report.operations[0].result) {
          await Promise.resolve();
          observed = true;
        }
        await rewriteAtomic(file, report);
      }),
      /response shape/u,
    );
    expect(observed).to.equal(true);
    expect(await f.journal().then((report) => report.operations[0].result?.variantId)).to.equal(
      variantId,
    );
  });
  it('stops before readback if response persistence fails', async () => {
    const f = await fixture();
    await failure(
      f.run(async (file, report) => {
        if (report.operations[0].result) throw new Error('Result unavailable');
        await rewriteAtomic(file, report);
      }),
      /could not be persisted/u,
    );
    expect(f.puts()).to.equal(1);
    expect(f.fetcher.callCount).to.equal(2);
    expect(await f.journal().then((report) => report.operations[0].state)).to.equal('pending');
  });
  it('does not claim completion when completion persistence fails', async () => {
    const f = await fixture();
    await failure(
      f.run(async (file, report) => {
        if (report.state === 'completed') throw new Error('Completion unavailable');
        await rewriteAtomic(file, report);
      }),
      /Completion unavailable/u,
    );
    expect(f.puts()).to.equal(1);
    expect(await f.journal().then((report) => report.state)).to.equal('ownership-uncertain');
  });
});
