import { Connection as JsforceConnection } from '@jsforce/jsforce-node';
import { expect } from 'chai';
import { PassThrough } from 'node:stream';
import type { Connection } from '@salesforce/core';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sinon from 'sinon';
import {
  prepareDeployDocumentUpdateIntent,
  executeDeployDocumentUpdate,
} from '../../src/services/deploy-document-update-executor.js';
import { buildDocumentUpdateMultipart } from '../../src/transport/multipart-document-update.js';
import {
  rewriteAtomic,
  type WorkspaceImportRunReport,
} from '../../src/services/import-workspace.js';

async function fixture(execute = false, fault = '') {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'cms-document-update-intent-'));
  const definitionFile = path.join(directory, 'Guide.cms-document.json');
  const fileName = 'Guide.cms-document.media.txt';
  const companion = path.join(directory, fileName);
  const current = Buffer.from('Current — café.\r\n');
  const bytes = Buffer.from('Replacement — 世界.\n');
  const workspaceId = '0Zu000000000001AAA';
  const contentId = '20Y000000000001AAA';
  const variantId = '9Ps000000000001AAA';
  const definition = {
    contract: 'sf-cms-media-source',
    contractVersion: '1.0.0',
    identity: {
      family: 'cms',
      type: 'Document',
      apiName: 'Guide',
      context: { workspaceApiName: 'Source' },
    },
    contentType: 'sfdc_cms__document',
    language: 'en_US',
    folderPath: [],
    title: 'Guide document',
    urlName: 'guide-document',
    media: {
      representation: 'binary',
      mimeType: 'text/plain',
      companion: { role: 'media', path: fileName },
    },
  };
  await writeFile(definitionFile, JSON.stringify(definition));
  await writeFile(companion, bytes);
  const workspace = {
    id: workspaceId,
    apiName: 'Destination',
    defaultLanguage: 'en_US',
    rootFolderId: 'root',
    spaceType: { apiName: 'Marketing' },
  };
  const row = {
    Id: variantId,
    ManagedContentId: contentId,
    ManagedContentKey: 'MCGENERATED',
    ContentTypeFullyQualifiedName: 'sfdc_cms__document',
    Language: 'en_US',
    IsPublished: false,
    ManagedContentVariantStatus: 'Draft',
    IsPrimary: true,
    Name: definition.title,
    UrlName: definition.urlName,
    ManagedContent: { AuthoredManagedContentSpaceId: workspaceId, ApiName: 'Guide' },
  };
  const detail = {
    managedContentId: contentId,
    managedContentVariantId: variantId,
    contentKey: 'MCGENERATED',
    apiName: 'Guide',
    title: definition.title,
    urlName: definition.urlName,
    contentType: { fullyQualifiedName: 'sfdc_cms__document' },
    contentSpace: { id: workspaceId },
    language: 'en_US',
    folder: { id: 'root' },
    isPublished: false,
    status: { status: 'Draft' },
    contentBody: {
      'sfdc_cms:media': {
        source: { type: 'file', size: current.length, mimeType: 'text/plain' },
        url: `/cms/media/MCGENERATED?version=1&fileHash=${createHash('md5').update(current).digest('hex')}&fileName=${fileName}`,
      },
    },
  };
  const methods: string[] = [];
  let remote = current;
  const response: Record<string, unknown> = {
    managedContentId: contentId,
    managedContentVariantId: variantId,
    contentKey: 'MCGENERATED',
    language: 'en_US',
    isPublished: false,
    contentBody: {},
  };
  const connection = {
    accessToken: 'test-token',
    instanceUrl: 'https://example.invalid',
    getApiVersion: () => '67.0',
    request(
      this: { _refreshDelegate?: unknown },
      input: { method: string; url: string; body?: Buffer; headers?: Record<string, string> },
      options: { retry?: { maxRetries: number } },
    ) {
      const result = (async () => {
        methods.push(input.method);
        if (input.method === 'PUT' && execute) {
          expect(this._refreshDelegate).to.equal(undefined);
          expect(options.retry?.maxRetries).to.equal(0);
          expect(new URL(input.url, 'https://example.invalid').pathname).to.match(
            new RegExp(`/connect/cms/contents/variants/${variantId}$`, 'u'),
          );
          const pending = await journal();
          expect(pending.operations[0].state).to.equal('pending');
          expect(pending.createdParents).to.deep.equal([]);
          const evidence = JSON.parse(
            pending.operations[0].requestIdentity.split('\u0000')[3],
          ).contentBody;
          const boundary = input.body!.toString('ascii').split('\r\n')[0].slice(2);
          const expected = buildDocumentUpdateMultipart(evidence.payload, fileName, bytes, {
            boundaryFactory: () => boundary,
          });
          expect(input.body!.equals(expected.body)).to.equal(true);
          expect(input.headers?.['content-length']).to.equal(String(expected.body.length));
          remote = bytes;
          detail.contentBody['sfdc_cms:media'].source.size = bytes.length;
          detail.contentBody['sfdc_cms:media'].url =
            `/cms/media/MCGENERATED?version=2&fileHash=${createHash('md5').update(bytes).digest('hex')}&fileName=${fileName}`;
          if (fault === 'lost') throw new Error('Lost response');
          if (fault === 'partial') delete response.managedContentVariantId;
          if (fault === 'parent') response.managedContentId = '20Y000000000002AAA';
          if (fault === 'variant') response.managedContentVariantId = '9Ps000000000002AAA';
          if (fault === 'key') response.contentKey = 'OTHER';
          if (fault === 'shape') delete response.contentBody;
          if (fault === 'inventory') row.Name = 'Changed';
          if (fault === 'published') row.IsPublished = true;
          if (fault === 'primary') row.IsPrimary = false;
          if (fault === 'status') row.ManagedContentVariantStatus = 'Archived';
          if (fault === 'language') row.Language = 'de_DE';
          if (fault === 'metadata') detail.title = 'Changed';
          if (fault === 'folder') detail.folder.id = 'elsewhere';
          if (fault === 'filename') detail.contentBody['sfdc_cms:media'].url += 'Other';
          if (fault === 'mime') detail.contentBody['sfdc_cms:media'].source.mimeType = 'image/png';
          if (fault === 'workspace') workspace.rootFolderId = 'elsewhere';
          return structuredClone(response);
        }
        expect(input.method).to.equal('GET');
        if (methods.includes('PUT')) {
          if (fault === 'read') throw new Error('Read failed');
          expect(await journal().then((r) => r.operations[0].result?.contentId)).to.equal(
            contentId,
          );
        }
        const url = new URL(input.url, 'https://example.invalid');
        if (url.pathname.includes('/spaces/')) return structuredClone(workspace);
        if (url.pathname.endsWith('/query')) {
          const q = url.searchParams.get('q')!;
          const rows = [row];
          if (methods.includes('PUT') && ['sibling', 'unrelated'].includes(fault))
            rows.push({
              ...row,
              Id: '9Ps000000000002AAA',
              ManagedContentId: fault === 'sibling' ? contentId : '20Y000000000002AAA',
              ManagedContent: {
                ...row.ManagedContent,
                ApiName: fault === 'sibling' ? 'Guide' : 'Other',
              },
            });
          let records: Record<string, unknown>[] = q.includes('Id >') ? [] : rows;
          if (q.includes('COUNT(Id)')) records = [{ ManagedContentId: contentId, siblingCount: 1 }];
          return { records: structuredClone(records), totalSize: records.length, done: true };
        }
        return structuredClone(detail);
      })();
      return Object.assign(result, { stream: () => new PassThrough() });
    },
  } as unknown as Pick<Connection, 'request' | 'getApiVersion'>;
  sinon.stub(globalThis, 'fetch').callsFake(
    async () =>
      new Response(fault === 'bytes' && methods.includes('PUT') ? current : remote, {
        headers: { 'content-type': 'text/plain' },
      }),
  );
  if (execute)
    sinon.stub(JsforceConnection.prototype, 'request').callsFake(function (
      this: JsforceConnection,
      request,
      options,
    ) {
      return connection.request.call(
        this,
        request,
        options as Parameters<Connection['request']>[1],
      );
    });
  const input = {
    definitionFile,
    workspaceId,
    language: 'en_US',
    expectedRootFolderId: 'root',
    destinationOrgId: '00D000000000001AAA',
    reportFile: path.join(directory, 'run.json'),
  };
  const journal = async () =>
    JSON.parse(await readFile(input.reportFile, 'utf8')) as WorkspaceImportRunReport;
  return { connection, input, journal, current, bytes, companion, workspace, row, detail, methods };
}
async function rejects(operation: Promise<unknown>, pattern = /./u) {
  try {
    await operation;
  } catch (error) {
    expect((error as Error).message).to.match(pattern);
    return;
  }
  throw new Error('Expected rejection');
}

describe('private Document UPDATE guarded intent and one-shot executor', () => {
  afterEach(() => sinon.restore());
  it('dispatches exact Document multipart once and durably proves independent replacement', async () => {
    const f = await fixture(true);
    let boundary = false;
    const result = await executeDeployDocumentUpdate(
      f.connection,
      f.input,
      {},
      undefined,
      async () => {
        expect(f.methods).not.to.include('PUT');
        expect(await f.journal().then((r) => r.operations[0].state)).to.equal('pending');
        await Promise.resolve();
        boundary = true;
      },
    );
    expect(boundary).to.equal(true);
    expect(result.qualification).to.equal('unqualified');
    expect(result.report.state).to.equal('completed');
    expect(result.report.operations[0].state).to.equal('succeeded');
    expect(result.report.createdParents).to.deep.equal([]);
    expect(f.methods.filter((method) => method === 'PUT')).to.have.length(1);
    expect(await f.journal()).to.deep.equal(result.report);
    await rejects(executeDeployDocumentUpdate(f.connection, f.input));
    expect(f.methods.filter((method) => method === 'PUT')).to.have.length(1);
  });
  for (const fault of [
    'lost',
    'partial',
    'parent',
    'variant',
    'key',
    'shape',
    'inventory',
    'sibling',
    'unrelated',
    'published',
    'primary',
    'status',
    'language',
    'metadata',
    'folder',
    'filename',
    'mime',
    'bytes',
    'read',
    'workspace',
  ])
    it(`retains pending uncertainty after ${fault} without retry or created ownership`, async () => {
      const f = await fixture(true, fault);
      await rejects(executeDeployDocumentUpdate(f.connection, f.input));
      expect(f.methods.filter((method) => method === 'PUT')).to.have.length(1);
      const report = await f.journal();
      expect(report.state).to.equal('ownership-uncertain');
      expect(report.operations[0].state).to.equal('pending');
      expect(report.createdParents).to.deep.equal([]);
      if (fault === 'lost') expect(report.operations[0].result).to.equal(undefined);
      if (fault === 'partial')
        expect(report.operations[0].result).to.deep.equal({
          contentId: '20Y000000000001AAA',
          contentKey: 'MCGENERATED',
        });
    });
  for (const fault of ['result', 'completion'])
    it(`never reports success when ${fault} persistence fails`, async () => {
      const f = await fixture(true);
      await rejects(
        executeDeployDocumentUpdate(
          f.connection,
          f.input,
          {},
          {
            rewrite: async (file, report) => {
              if (fault === 'result' && report.operations[0].result)
                throw new Error('Result unavailable');
              if (fault === 'completion' && report.state === 'completed')
                throw new Error('Completion unavailable');
              await rewriteAtomic(file, report);
            },
          },
        ),
      );
      expect(f.methods.filter((method) => method === 'PUT')).to.have.length(1);
      const report = await f.journal();
      expect(report.operations[0].state).to.equal('pending');
      expect(report.state).not.to.equal('completed');
    });
  it('persists partial raw identity before strict response validation', async () => {
    const f = await fixture(true, 'shape');
    let observed = false;
    await rejects(
      executeDeployDocumentUpdate(
        f.connection,
        f.input,
        {},
        {
          rewrite: async (file, report) => {
            if (report.operations[0].result) {
              await Promise.resolve();
              observed = true;
            }
            await rewriteAtomic(file, report);
          },
        },
      ),
      /response shape/u,
    );
    expect(observed).to.equal(true);
    expect(await f.journal().then((r) => r.operations[0].result?.variantId)).to.equal(
      '9Ps000000000001AAA',
    );
  });
  for (const kind of ['bytes', 'journal', 'cancel', 'reject'])
    it(`blocks actual executor ${kind} boundary changes before dispatch`, async () => {
      const f = await fixture(true);
      const controller = new AbortController();
      await rejects(
        executeDeployDocumentUpdate(
          f.connection,
          f.input,
          { signal: controller.signal },
          undefined,
          async () => {
            await Promise.resolve();
            if (kind === 'bytes') await writeFile(f.companion, Buffer.from('Changed again'));
            if (kind === 'journal') await writeFile(f.input.reportFile, '{}');
            if (kind === 'cancel') controller.abort();
            if (kind === 'reject') throw new Error('Boundary rejected');
          },
        ),
      );
      expect(f.methods).not.to.include('PUT');
      expect(await f.journal().then((r) => r.state)).to.equal('failed');
    });
  it('persists old/new bytes and hashes before awaited boundary, retaining pending only', async () => {
    const f = await fixture();
    let boundary = false;
    const result = await prepareDeployDocumentUpdateIntent(
      f.connection,
      f.input,
      {},
      undefined,
      async () => {
        const intent = await f.journal();
        expect(intent.operations[0].state).to.equal('pending');
        expect(intent.operations[0].operationKind).to.equal('update-variant');
        const identity = intent.operations[0].requestIdentity;
        expect(identity)
          .to.include(f.current.toString('base64'))
          .and.include(f.bytes.toString('base64'));
        expect(identity).to.include('mediaSha256').and.include('sourceSha256');
        expect(intent.operations[0].requestSha256).to.equal(
          createHash('sha256').update(identity).digest('hex'),
        );
        await Promise.resolve();
        boundary = true;
      },
    );
    expect(boundary).to.equal(true);
    expect(result.qualification).to.equal('unqualified');
    expect(result.report.state).to.equal('applying');
    expect(result.report.operations[0].state).to.equal('pending');
    expect(result.report.operations[0].result).to.equal(undefined);
    expect(result.report.createdParents).to.deep.equal([]);
    expect(await f.journal()).to.deep.equal(result.report);
    expect(f.methods.every((method) => method === 'GET')).to.equal(true);
    await rejects(prepareDeployDocumentUpdateIntent(f.connection, f.input), /EEXIST/u);
  });
  for (const kind of ['bytes', 'workspace', 'inventory', 'native', 'journal', 'cancel', 'reject'])
    it(`rejects ${kind} boundary drift without mutation or completion`, async () => {
      const f = await fixture();
      const controller = new AbortController();
      await rejects(
        prepareDeployDocumentUpdateIntent(
          f.connection,
          f.input,
          { signal: controller.signal },
          undefined,
          async () => {
            if (kind === 'bytes') await writeFile(f.companion, Buffer.from('Changed again'));
            if (kind === 'workspace') f.workspace.apiName = 'Changed';
            if (kind === 'inventory') f.row.Name = 'Changed';
            if (kind === 'native') f.detail.title = 'Changed';
            if (kind === 'journal') await writeFile(f.input.reportFile, '{}');
            if (kind === 'cancel') controller.abort();
            if (kind === 'reject') throw new Error('Boundary rejected');
          },
        ),
      );
      const report = await f.journal();
      expect(report.state).to.equal('failed');
      expect(report.operations[0].state).to.equal('failed');
      expect(report.createdParents).to.deep.equal([]);
      expect(f.methods.every((method) => method === 'GET')).to.equal(true);
    });
  it('preserves exclusive pending intent when persistence fails and never invokes boundary', async () => {
    const f = await fixture();
    const boundary = sinon.spy();
    await rejects(
      prepareDeployDocumentUpdateIntent(
        f.connection,
        f.input,
        {},
        {
          rewrite: async () => {
            throw new Error('Disk unavailable');
          },
        },
        boundary,
      ),
      /Disk unavailable/u,
    );
    expect(boundary.called).to.equal(false);
    expect(await f.journal().then((report) => report.operations[0].state)).to.equal('pending');
  });
  it('rejects invalid org before reads or journal creation', async () => {
    const f = await fixture();
    f.input.destinationOrgId = 'wrong';
    await rejects(prepareDeployDocumentUpdateIntent(f.connection, f.input), /org ID/u);
    expect(f.methods).to.deep.equal([]);
    await rejects(f.journal(), /ENOENT/u);
  });
  it('rejects drift introduced by initial persistence before boundary', async () => {
    const f = await fixture();
    const boundary = sinon.spy();
    await rejects(
      prepareDeployDocumentUpdateIntent(
        f.connection,
        f.input,
        {},
        {
          rewrite: async (file, report) => {
            await rewriteAtomic(file, report);
            f.workspace.apiName = 'Changed';
          },
        },
        boundary,
      ),
      /drifted/u,
    );
    expect(boundary.called).to.equal(false);
    expect(await f.journal().then((report) => report.state)).to.equal('failed');
  });
});
