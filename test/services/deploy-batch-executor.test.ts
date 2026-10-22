import { expect } from 'chai';
import sinon from 'sinon';
import { Connection as JsforceConnection } from '@jsforce/jsforce-node';
import type { Connection } from '@salesforce/core';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { createHash } from 'node:crypto';
import {
  executeDeployBatch,
  executeDeployBatchDocumentItem,
  executeDeployBatchAudioItem,
  revalidateDeployBatchAudioBoundary,
  reconcileDeployBatchInventory,
  type DeployBatchPersistence,
  type DeployBatchReport,
} from '../../src/services/deploy-batch-executor.js';
import type { NativeInventory } from '../../src/services/retrieve-native-inventory.js';
import { preflightDeployBatch } from '../../src/services/deploy-batch-preflight.js';
import { executeDeployCreate } from '../../src/services/deploy-create-executor.js';
import { executeDeployImage } from '../../src/services/deploy-image-executor.js';
import { DEPLOY_SOURCE_CONTENT_TYPES } from '../../src/services/deploy-source-selection.js';
import {
  buildAudioCreateMultipart,
  buildDocumentCreateMultipart,
} from '../../src/transport/multipart-image-create.js';
import { buildAudioUpdateMultipart } from '../../src/transport/multipart-audio-update.js';
import {
  buildDocumentUpdateMultipart,
  type DocumentUpdateInput,
} from '../../src/transport/multipart-document-update.js';
import {
  rewriteAtomic,
  type WorkspaceImportRunReport,
} from '../../src/services/import-workspace.js';

const workspaceId = '0Zu000000000001AAA';
type Row = Record<string, unknown>;
async function fixture(
  existing = false,
  mixed = false,
  document = false,
  audio = false,
  reporting = true,
) {
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
  if (mixed) {
    definitions[1].identity.type = 'Email Template';
    definitions[1].contentType = 'sfdc_cms__emailTemplate';
    definitions[1].companions.rawHtml = 'Beta.cms-email-template.html';
  }
  const imageBytes = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>');
  let currentImageBytes = imageBytes;
  const imageName = 'Gamma.cms-image.media.svg';
  const files = definitions.map((definition, index) =>
    path.join(
      directory,
      `${definition.identity.apiName}.cms-${mixed && index === 1 ? 'email-template' : 'email'}.json`,
    ),
  );
  for (const [index, definition] of definitions.entries()) {
    if (mixed && index === 2) continue;
    await writeFile(files[index], JSON.stringify(definition));
    await writeFile(path.join(directory, definition.companions.rawHtml), '<p>Desired</p>');
  }
  if (mixed) {
    files[2] = path.join(directory, 'Gamma.cms-image.json');
    await writeFile(
      files[2],
      JSON.stringify({
        contract: 'sf-cms-media-source',
        contractVersion: '1.0.0',
        identity: { ...definitions[2].identity, type: 'Image' },
        contentType: 'sfdc_cms__image',
        language: 'en_US',
        title: 'Gamma',
        folderPath: [],
        media: {
          representation: 'binary',
          mimeType: 'image/svg+xml',
          companion: { role: 'media', path: imageName },
        },
      }),
    );
    await writeFile(path.join(directory, imageName), imageBytes);
    definitions[2].contentType = 'sfdc_cms__image';
  }
  const documentBytes = audio
    ? Buffer.from([0, 255, 128, 13, 10])
    : Buffer.from('Grüße 世界\r\nDocument\n');
  let currentDocumentBytes = documentBytes;
  let partialDocumentResponse = false;
  const documentName = audio ? 'Zulu.cms-audio.media.bin' : 'Zulu.cms-document.media.txt';
  const documentMime = audio ? 'application/x-future-audio' : 'text/plain';
  if (document) {
    definitions.push({
      ...definitions[0],
      identity: { ...definitions[0].identity, type: 'Document', apiName: 'Zulu' },
      contentType: 'sfdc_cms__document',
      title: 'Zulu',
    });
    files.push(path.join(directory, 'Zulu.cms-document.json'));
    await writeFile(
      files[3],
      JSON.stringify({
        contract: 'sf-cms-media-source',
        contractVersion: '1.0.0',
        identity: definitions[3].identity,
        contentType: 'sfdc_cms__document',
        language: 'en_US',
        title: 'Zulu',
        folderPath: [],
        media: {
          representation: 'binary',
          mimeType: 'text/plain',
          companion: { role: 'media', path: documentName },
        },
      }),
    );
    await writeFile(path.join(directory, documentName), documentBytes);
  }
  const mediaBody = (index: number) => {
    const bytes = index === 3 ? currentDocumentBytes : imageBytes;
    const mimeType = index === 3 ? documentMime : 'image/svg+xml';
    const name = index === 3 ? documentName : imageName;
    return {
      'sfdc_cms:media': {
        source: { type: 'file', size: bytes.length, mimeType },
        url: `/cms/media/MCKEY${index + 1}?version=1&fileHash=${createHash('md5').update(bytes).digest('hex')}&fileName=${name}`,
      },
    };
  };
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
      contentType: { fullyQualifiedName: definition.contentType },
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
      ContentTypeFullyQualifiedName: definition.contentType,
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
    add(1, {
      ...definitions[1].contentBody,
      rawHtml: mixed ? '&lt;p&gt;Desired&lt;/p&gt;' : '&lt;p&gt;Original&lt;/p&gt;',
    });
    add(
      2,
      mixed
        ? {
            'sfdc_cms:media': {
              source: { type: 'file', size: imageBytes.length, mimeType: 'image/svg+xml' },
              url: `/cms/media/MCKEY3?version=1&fileHash=${createHash('md5').update(imageBytes).digest('hex')}&fileName=${imageName}`,
            },
          }
        : { ...definitions[2].contentBody, rawHtml: '&lt;p&gt;Desired&lt;/p&gt;' },
    );
  }
  if (existing && document) add(3, mediaBody(3));
  const mutations: string[] = [];
  let puts = 0;
  let invalidFinalReadbackVersion = false;
  const requests: string[] = [];
  let failName: string | undefined;
  let lostUpdateResponseName: string | undefined;
  let onRead: (() => Promise<void>) | undefined;
  const request = function (
    input: { method: string; url: string; body?: string | Buffer },
    options?: { retry?: { maxRetries: number } },
  ) {
    requests.push(input.url);
    const result = (async () => {
      const url = new URL(input.url, 'https://example.invalid');
      if (input.method !== 'GET') {
        expect(options?.retry?.maxRetries).to.equal(0);
        const binary = Buffer.isBuffer(input.body);
        const body = JSON.parse(
          binary
            ? input.body!.toString().split('\r\n\r\n')[1].split('\r\n--')[0]
            : String(input.body),
        ) as Row;
        const name = String(
          body.apiName ??
            (binary ? details.get(url.pathname.split('/').at(-1)!)?.apiName : undefined),
        );
        mutations.push(name);
        let journal: WorkspaceImportRunReport | undefined;
        if (reporting) {
          const batch = JSON.parse(await readFile(reportFile, 'utf8')) as DeployBatchReport;
          const item = batch.items.find((entry) => entry.source.targetIdentity.apiName === name)!;
          journal = JSON.parse(
            await readFile(item.reportFile!, 'utf8'),
          ) as WorkspaceImportRunReport;
          expect(journal.operations[0].state).to.equal('pending');
        }
        if (name === failName) throw new Error('Authorization: Bearer secret-token');
        if (input.method === 'POST') {
          const index = definitions.findIndex((definition) => definition.identity.apiName === name);
          if (binary && index === 3) {
            expect((input.body as Buffer).includes(documentBytes)).to.equal(true);
            expect(
              (input.body as Buffer).includes(Buffer.from(`Content-Type: ${documentMime}\r\n`)),
            ).to.equal(true);
            expect(body).not.to.have.property('contentKey');
            const boundary = input.body!.toString('ascii').split('\r\n')[0].slice(2);
            const build = audio ? buildAudioCreateMultipart : buildDocumentCreateMultipart;
            const expected = build(
              {
                apiName: String(body.apiName),
                title: String(body.title),
                contentSpaceOrFolderId: String(body.contentSpaceOrFolderId),
              },
              documentName,
              documentBytes,
              { boundaryFactory: () => boundary, mimeType: documentMime },
            );
            expect((input.body as Buffer).equals(expected.body)).to.equal(true);
          }
          const detail = add(index, binary ? mediaBody(index) : (body.contentBody as Row));
          if (binary && audio && partialDocumentResponse)
            return { managedContentId: detail.managedContentId };
          if (binary)
            return {
              managedContentId: detail.managedContentId,
              managedContentVariantId: detail.managedContentVariantId,
              contentKey: detail.contentKey,
            };
          return {
            id: detail.managedContentId,
            contentKey: detail.contentKey,
            primaryVariantId: detail.managedContentVariantId,
          };
        }
        expect(input.method).to.equal('PUT');
        puts += 1;
        const detail = details.get(url.pathname.split('/').at(-1)!)!;
        if (binary && name === 'Zulu') {
          const desired = await readFile(path.join(directory, documentName));
          const boundary = input.body!.toString('ascii').split('\r\n')[0].slice(2);
          const framing = { boundaryFactory: () => boundary, mimeType: documentMime };
          const expected = audio
            ? buildAudioUpdateMultipart(
                { title: String(body.title) },
                documentName,
                desired,
                framing,
              )
            : buildDocumentUpdateMultipart(
                body as DocumentUpdateInput,
                documentName,
                desired,
                framing,
              );
          expect((input.body as Buffer).equals(expected.body)).to.equal(true);
          if (reporting) expect(journal!.createdParents).to.deep.equal([]);
          currentDocumentBytes = desired;
          detail.contentBody = mediaBody(3);
        } else if (binary && name === 'Gamma') {
          currentImageBytes = await readFile(path.join(directory, imageName));
          detail.contentBody = {
            'sfdc_cms:media': {
              source: { type: 'file', size: currentImageBytes.length, mimeType: 'image/svg+xml' },
              url: `/cms/media/MCKEY3?version=2&fileHash=${createHash('md5').update(currentImageBytes).digest('hex')}&fileName=${imageName}`,
            },
          };
        } else {
          detail.contentBody = {
            ...(body.contentBody as Row),
            rawHtml: '&lt;p&gt;Desired&lt;/p&gt;',
          };
        }
        detail.managedContentVersionId = 'after';
        if (name === lostUpdateResponseName) throw new Error('UPDATE response lost');
        if (binary && name === 'Zulu' && partialDocumentResponse)
          return { managedContentId: detail.managedContentId };
        return detail;
      }
      if (onRead) await onRead();
      if (url.pathname.endsWith(`/spaces/${workspaceId}`)) return workspace;
      if (url.pathname.endsWith('/query')) {
        const soql = url.searchParams.get('q')!;
        const parentId = /ManagedContentId = '([^']+)'/u.exec(soql)?.[1];
        const types = /ContentTypeFullyQualifiedName IN \(([^)]+)\)/u.exec(soql)?.[1];
        const selected = records.filter(
          (row) =>
            (parentId === undefined || row.ManagedContentId === parentId) &&
            (types === undefined ||
              types.includes(`'${String(row.ContentTypeFullyQualifiedName)}'`)),
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
  if (mixed)
    sinon.stub(globalThis, 'fetch').callsFake(async (input) => {
      const isDocument = String(input).includes('MCKEY4');
      return new Response(isDocument ? currentDocumentBytes : currentImageBytes, {
        headers: { 'content-type': isDocument ? documentMime : 'image/svg+xml' },
      });
    });
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
    connection,
    preflight: () => preflightDeployBatch(connection, input),
    files,
    definitions,
    mutations,
    puts: () => puts,
    partialDocumentResponse: () => {
      partialDocumentResponse = true;
    },
    invalidateFinalReadbackVersion: () => {
      invalidFinalReadbackVersion = true;
    },
    details,
    records,
    workspace,
    directory,
    fail: (name: string) => {
      failName = name;
    },
    loseUpdateResponse: (name: string) => {
      lostUpdateResponseName = name;
    },
    onRead: (callback: () => Promise<void>) => {
      onRead = callback;
    },
    run: (persistence?: DeployBatchPersistence, options = {}) =>
      executeDeployBatch(
        connection,
        { ...input, reportFile: reporting ? reportFile : undefined },
        options,
        persistence,
      ),
    journal: async () => JSON.parse(await readFile(reportFile, 'utf8')) as DeployBatchReport,
  };
}

async function audioBoundaryFixture(
  operation: 'create' | 'unchanged' | 'update',
  reporting = true,
) {
  const f = await fixture(operation !== 'create', true, true, true, reporting);
  const companion = path.join(f.directory, 'Zulu.cms-audio.media.bin');
  const current = Buffer.from([0, 255, 128, 13, 10]);
  const desired = operation === 'update' ? Buffer.from([255, 0, 129]) : current;
  const definition = {
    contract: 'sf-cms-media-source',
    contractVersion: '1.0.0',
    identity: { ...f.definitions[3].identity, type: 'Audio' },
    contentType: 'sfdc_cms__audio',
    language: 'en_US',
    title: 'Zulu',
    folderPath: [],
    media: {
      representation: 'binary',
      mimeType: 'application/x-future-audio',
      companion: { role: 'media', path: path.basename(companion) },
    },
  };
  const audioFile = path.join(f.directory, 'Zulu.cms-audio.json');
  await writeFile(audioFile, JSON.stringify(definition));
  await writeFile(companion, desired);
  // Explicit files select Audio instead of the fixture's original Document definition.
  Object.assign(f.input, { sources: { 'source-dir': [f.files[0], audioFile] } });
  const detail = f.details.get('MCKEY4');
  if (detail) {
    Object.assign(detail, {
      contentType: { fullyQualifiedName: 'sfdc_cms__audio' },
      contentBody: {
        'sfdc_cms:media': {
          source: { type: 'file', size: current.length, mimeType: definition.media.mimeType },
          url: `/cms/media/MCKEY4?version=1&fileHash=${createHash('md5').update(current).digest('hex')}&fileName=${path.basename(companion)}`,
        },
      },
    });
    f.records.find((row) => row.ManagedContentKey === 'MCKEY4')!.ContentTypeFullyQualifiedName =
      'sfdc_cms__audio';
  }
  f.definitions[3].contentType = 'sfdc_cms__audio';
  f.definitions[3].identity.type = 'Audio';
  return { ...f, companion, audioFile, definition };
}

describe('batch live outcomes', () => {
  afterEach(() => sinon.restore());
  for (const reporting of [false, true]) {
    it(`emits a settled prefix before later dispatch and an untouched suffix, reporting ${reporting}`, async () => {
      const f = await fixture(false, false, false, false, reporting);
      f.fail('Beta');
      const events: Array<{ state: string; ordinal: number }> = [];
      f.onRead(async () => {
        if (f.mutations.includes('Beta'))
          expect(events[0]).to.include({ state: 'created', ordinal: 1 });
      });
      const result = await executeDeployBatch(f.connection, {
        ...f.input,
        reportFile: reporting ? f.input.reportFile : undefined,
        onOutcome: (event) => {
          events.push(event);
          if (event.ordinal === 1) expect(f.mutations).to.deep.equal(['Alpha']);
          throw new Error('Broken diagnostic sink');
        },
      });
      expect(events.map(({ state }) => state)).to.deep.equal([
        'created',
        'uncertain',
        'unattempted',
      ]);
      expect(events.map(({ ordinal }) => ordinal)).to.deep.equal([1, 2, 3]);
      expect(result.report.items.map(({ outcome }) => outcome)).to.deep.equal([
        'created',
        'uncertain',
        'unattempted',
      ]);
      expect(f.mutations).to.deep.equal(['Alpha', 'Beta']);
    });
  }
  it('reports an untouched selection when the first durable batch write fails', async () => {
    const f = await fixture();
    const events: string[] = [];
    await executeDeployBatch(
      f.connection,
      { ...f.input, onOutcome: (event) => events.push(event.state) },
      {},
      {
        rewrite: async () => {
          throw new Error('Initial batch persistence unavailable');
        },
      },
    );
    expect(events).to.deep.equal(['unattempted', 'unattempted', 'unattempted']);
    expect(f.mutations).to.deep.equal([]);
  });
  it('retains verified remote success when final item persistence fails without changing JSON classification', async () => {
    const f = await fixture();
    const events: string[] = [];
    const result = await executeDeployBatch(
      f.connection,
      {
        ...f.input,
        onOutcome: (event) => events.push(event.state),
      },
      {},
      {
        rewrite: rewriteAtomic,
        item: {
          rewrite: async (file, report) => {
            if (report.state === 'completed') throw new Error('Completion persistence failed');
            await rewriteAtomic(file, report);
          },
        },
      },
    );
    expect(events).to.deep.equal(['remote-completed-report-blocked', 'unattempted', 'unattempted']);
    expect(result.report.items[0].outcome).to.equal('uncertain');
    expect(f.mutations).to.deep.equal(['Alpha']);
  });
  for (const family of ['rawHtml', 'Image', 'Document', 'Audio'] as const) {
    for (const operation of ['create', 'update'] as const) {
      it(`retains ${family} ${operation} verification across final persistence failure`, async () => {
        const existing = operation === 'update';
        const f =
          family === 'Audio'
            ? await audioBoundaryFixture(operation)
            : await fixture(existing, family !== 'rawHtml', family === 'Document');
        const index = { rawHtml: 1, Image: 2, Document: 3, Audio: 1 }[family];
        if (existing && family === 'Image')
          await writeFile(
            path.join(f.directory, 'Gamma.cms-image.media.svg'),
            '<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"/>',
          );
        if (existing && family === 'Document') {
          const definition = JSON.parse(await readFile(f.files[3], 'utf8')) as Row;
          definition.urlName = 'zulu';
          await writeFile(f.files[3], JSON.stringify(definition));
          f.records[2].UrlName = 'zulu';
          f.details.get('MCKEY4')!.urlName = 'zulu';
          await writeFile(path.join(f.directory, 'Zulu.cms-document.media.txt'), 'Changed bytes');
        }
        const events: Array<{ ordinal: number; state: string }> = [];
        const result = await executeDeployBatch(
          f.connection,
          { ...f.input, onOutcome: (event) => events.push(event) },
          {},
          {
            rewrite: rewriteAtomic,
            item: {
              rewrite: async (file, report) => {
                if (report.state === 'completed' && file.endsWith(`.${index + 1}.json`))
                  throw new Error('Final completion persistence unavailable');
                await rewriteAtomic(file, report);
              },
            },
          },
        );
        expect(events[index], result.report.blockedReasons.join('; ')).to.include({
          ordinal: index + 1,
          state: 'remote-completed-report-blocked',
        });
        expect(result.report.items[index].outcome).to.equal('uncertain');
        expect(events).to.have.length(result.report.items.length);
      });
    }
  }
  it('emits the completed item and untouched suffix when batch summary persistence fails', async () => {
    const f = await fixture();
    const events: string[] = [];
    await executeDeployBatch(
      f.connection,
      { ...f.input, onOutcome: (event) => events.push(event.state) },
      {},
      {
        rewrite: async (file, report) => {
          if (report.summary.completed) throw new Error('Summary unavailable');
          await rewriteAtomic(file, report);
        },
      },
    );
    expect(events).to.deep.equal(['remote-completed-report-blocked', 'unattempted', 'unattempted']);
    expect(f.mutations).to.deep.equal(['Alpha']);
  });
});

describe('batch live and disk evidence routing', () => {
  afterEach(() => sinon.restore());
  for (const reporting of [false, true]) {
    it(`keeps unattempted suffix after cancellation with reporting ${reporting}`, async () => {
      const f = await fixture(false, false, false, false, reporting);
      const controller = new AbortController();
      f.onRead(async () => {
        if (f.records.length === 1) controller.abort();
      });
      const result = await f.run(undefined, { signal: controller.signal });
      expect(f.mutations).to.deep.equal(['Alpha']);
      expect(result.report.items[0].outcome).to.equal('uncertain');
      expect(result.report.items.slice(1).map((item) => item.outcome)).to.deep.equal([
        'unattempted',
        'unattempted',
      ]);
      expect(result.report.items[1].returned).to.equal(undefined);
    });
  }
  for (const drift of ['org', 'workspace', 'language', 'empty', 'pending'] as const) {
    it(`rejects completed UPDATE disk evidence with ${drift} binding drift`, async () => {
      const f = await fixture(true);
      const result = await f.run({
        rewrite: rewriteAtomic,
        item: {
          rewrite: async (file, report) => {
            await rewriteAtomic(file, report);
            if (
              report.state === 'completed' &&
              report.operations[0].operationKind === 'update-variant'
            ) {
              const changed = structuredClone(report);
              if (drift === 'org')
                Object.assign(changed, { destinationOrgId: '00D000000000002AAA' });
              if (drift === 'workspace')
                Object.assign(changed, { destinationWorkspaceId: '0Zu000000000002AAA' });
              if (drift === 'language') Object.assign(changed.operations[0], { language: 'de_DE' });
              if (drift === 'empty') changed.operations.length = 0;
              if (drift === 'pending') changed.operations[0].state = 'pending';
              await rewriteAtomic(file, changed);
            }
          },
        },
      });
      expect(result.report.items.map((item) => item.outcome)).to.deep.equal([
        'created',
        'uncertain',
        'unattempted',
      ]);
      expect(result.report.blockedReasons.join(';')).to.include(
        'Verified UPDATE journal binding missing',
      );
      expect(f.mutations).to.deep.equal(['Alpha', 'Beta']);
    });
  }
  for (const reporting of [false, true]) {
    for (const family of ['rawHtml', 'Image', 'Document', 'Audio'] as const) {
      for (const operation of ['create', 'update'] as const) {
        it(`routes ${family} ${operation} with reporting ${reporting}`, async () => {
          const existing = operation === 'update';
          const f =
            family === 'Audio'
              ? await audioBoundaryFixture(operation, reporting)
              : await fixture(
                  existing,
                  family !== 'rawHtml',
                  family === 'Document',
                  false,
                  reporting,
                );
          if (existing && family === 'Document') {
            const definition = JSON.parse(await readFile(f.files[3], 'utf8')) as Row;
            definition.urlName = 'zulu';
            await writeFile(f.files[3], JSON.stringify(definition));
            f.records[2].UrlName = 'zulu';
            f.details.get('MCKEY4')!.urlName = 'zulu';
            await writeFile(path.join(f.directory, 'Zulu.cms-document.media.txt'), 'Changed bytes');
          }
          if (existing && family === 'Image') {
            await writeFile(
              path.join(f.directory, 'Gamma.cms-image.media.svg'),
              '<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"/>',
            );
          }
          const before = await readdir(f.directory);
          const persistence = {
            rewrite: async (file: string, report: DeployBatchReport) => {
              expect(reporting).to.equal(true);
              await rewriteAtomic(file, report);
            },
            item: {
              rewrite: async (file: string, report: WorkspaceImportRunReport) => {
                expect(reporting).to.equal(true);
                await rewriteAtomic(file, report);
              },
            },
          };
          const result = await f.run(persistence);
          expect(result.report.blockedReasons).to.deep.equal([]);
          expect(result.report.state).to.equal('completed');
          expect(result.report.items.every((item) => item.target)).to.equal(true);
          expect(result.reportFile === undefined).to.equal(!reporting);
          expect(result.report.items.every((item) => item.reportFile === undefined)).to.equal(
            !reporting,
          );
          if (reporting) {
            expect(await f.journal()).to.deep.equal(result.report);
          } else {
            expect(await readdir(f.directory)).to.deep.equal(before);
          }
        });
      }
      it(`preserves ${family} UPDATE target after lost response with reporting ${reporting}`, async () => {
        const f =
          family === 'Audio'
            ? await audioBoundaryFixture('update', reporting)
            : await fixture(true, family !== 'rawHtml', family === 'Document', false, reporting);
        const index = { rawHtml: 1, Image: 2, Document: 3, Audio: 3 }[family];
        const name = { rawHtml: 'Beta', Image: 'Gamma', Document: 'Zulu', Audio: 'Zulu' }[family];
        if (family === 'Image')
          await writeFile(
            path.join(f.directory, 'Gamma.cms-image.media.svg'),
            '<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"/>',
          );
        if (family === 'Document') {
          const definition = JSON.parse(await readFile(f.files[3], 'utf8')) as Row;
          definition.urlName = 'zulu';
          await writeFile(f.files[3], JSON.stringify(definition));
          f.records[2].UrlName = 'zulu';
          f.details.get('MCKEY4')!.urlName = 'zulu';
          await writeFile(path.join(f.directory, 'Zulu.cms-document.media.txt'), 'Changed bytes');
        }
        // Add a real selected suffix even when the uncertain media item normally sorts last.
        const suffix = path.join(f.directory, 'Zzz.cms-email.json');
        await writeFile(
          suffix,
          JSON.stringify({
            ...f.definitions[0],
            identity: { ...f.definitions[0].identity, apiName: 'Zzz' },
            title: 'Zzz',
            contentBody: { ...f.definitions[0].contentBody, 'sfdc_cms:title': 'Zzz' },
            companions: { rawHtml: 'Zzz.cms-email.html' },
          }),
        );
        await writeFile(path.join(f.directory, 'Zzz.cms-email.html'), '<p>Desired</p>');
        if (family === 'Audio') f.input.sources['source-dir'].push(suffix);
        f.loseUpdateResponse(name);
        const before = await readdir(f.directory);
        const result = await f.run();
        const activeIndex = result.report.items.findIndex(
          (item) => item.source.targetIdentity.apiName === name,
        );
        const active = result.report.items[activeIndex];
        expect(active.proposed).to.equal('update');
        expect(active.outcome, result.report.blockedReasons.join('; ')).to.equal('uncertain');
        expect(active.target).to.deep.equal({
          contentId: `20Y00000000000${index + 1}AAA`,
          variantId: `9Ps00000000000${index + 1}AAA`,
        });
        expect(active.returned).to.equal(undefined);
        expect(result.report.state).to.equal('partial');
        expect(
          result.report.items
            .slice(0, activeIndex)
            .every((item) => ['created', 'updated', 'unchanged'].includes(item.outcome)),
        ).to.equal(true);
        expect(result.report.items.slice(activeIndex + 1).map((item) => item.outcome))
          .to.have.length.greaterThan(0)
          .and.satisfy((outcomes: string[]) =>
            outcomes.every((outcome) => outcome === 'unattempted'),
          );
        expect(result.report.summary.completed).to.equal(activeIndex);
        expect(result.report.summary.uncertain).to.equal(1);
        expect(f.mutations.filter((mutation) => mutation === name)).to.have.length(1);
        expect(f.mutations.at(-1)).to.equal(name);
        expect(f.puts()).to.equal(1);
        expect(f.details.get(`MCKEY${index + 1}`)!.managedContentVersionId).to.equal('after');
        if (reporting) expect(await f.journal()).to.deep.equal(result.report);
        else expect(await readdir(f.directory)).to.deep.equal(before);
      });
      it(`preserves ${family} lost-response uncertainty with reporting ${reporting}`, async () => {
        const f =
          family === 'Audio'
            ? await audioBoundaryFixture('create', reporting)
            : await fixture(false, family !== 'rawHtml', family === 'Document', false, reporting);
        const names = { rawHtml: 'Beta', Image: 'Gamma', Document: 'Zulu', Audio: 'Zulu' };
        const name = names[family];
        f.fail(name);
        const before = await readdir(f.directory);
        const result = await f.run();
        const item = result.report.items.find(
          (entry) => entry.source.targetIdentity.apiName === name,
        )!;
        expect(item.outcome).to.equal('uncertain');
        expect(result.report.state).to.equal('partial');
        expect(f.mutations.at(-1)).to.equal(name);
        expect(result.report.summary.uncertain).to.equal(1);
        expect(JSON.stringify(result)).not.to.include('secret-token');
        if (!reporting) expect(await readdir(f.directory)).to.deep.equal(before);
      });
    }
    for (const family of ['rawHtml', 'Image', 'Document', 'Audio'] as const) {
      it(`hands off live ${family} evidence before predispatch failure with reporting ${reporting}`, async () => {
        const f =
          family === 'Audio'
            ? await audioBoundaryFixture('create', reporting)
            : await fixture(false, family !== 'rawHtml', family === 'Document', false, reporting);
        const indices = { rawHtml: 0, Image: 2, Document: 3, Audio: 3 };
        const index = indices[family];
        const definitionFile =
          family === 'Audio' ? f.input.sources['source-dir'][1] : f.files[index];
        const input = {
          definitionFile,
          workspaceId,
          language: 'en_US',
          destinationOrgId: f.input.destinationOrgId,
          reportFile: reporting ? path.join(f.directory, 'adapter.json') : undefined,
        };
        let live: WorkspaceImportRunReport | undefined;
        const observe = (report: WorkspaceImportRunReport) => {
          live = report;
        };
        const boundary = async () => {
          if (live) {
            expect(live.operations[0].state).to.equal('pending');
            throw new Error('Stop before dispatch');
          }
        };
        let caught = false;
        try {
          switch (family) {
            case 'Document': {
              await executeDeployBatchDocumentItem(
                f.connection,
                input,
                'create',
                boundary,
                {},
                undefined,
                observe,
              );
              break;
            }
            case 'Audio': {
              await executeDeployBatchAudioItem(
                f.connection,
                input,
                'create',
                boundary,
                {},
                undefined,
                observe,
              );
              break;
            }
            case 'Image': {
              await executeDeployImage(
                f.connection,
                { ...input, operation: 'create' },
                {},
                undefined,
                boundary,
                observe,
              );
              break;
            }
            default: {
              await executeDeployCreate(f.connection, input, {}, undefined, boundary, observe);
            }
          }
        } catch (error) {
          caught = true;
          expect((error as Error).message).to.equal('Stop before dispatch');
        }
        expect(caught).to.equal(true);
        expect(live?.state).to.equal('failed');
        expect(live?.operations[0].state).to.equal('failed');
        expect(f.mutations).to.deep.equal([]);
      });
    }
    for (const operation of ['create', 'update'] as const) {
      it(`retains partial Audio ${operation} returned identity with reporting ${reporting}`, async () => {
        const f = await audioBoundaryFixture(operation, reporting);
        f.partialDocumentResponse();
        const result = await f.run();
        expect(result.report.items[1].outcome).to.equal('uncertain');
        expect(result.report.items[1].returned?.contentId).to.equal('20Y000000000004AAA');
        expect(f.mutations).to.deep.equal(['Alpha', 'Zulu']);
      });
    }
  }
});

describe('Audio execution-boundary observations and private item routing', () => {
  beforeEach(() => {
    (DEPLOY_SOURCE_CONTENT_TYPES as unknown as string[]).push('sfdc_cms__audio');
  });
  afterEach(() => {
    (DEPLOY_SOURCE_CONTENT_TYPES as unknown as string[]).pop();
    sinon.restore();
  });
  for (const operation of ['create', 'unchanged', 'update'] as const) {
    it(`reacquires real Audio ${operation} without mutation authority`, async () => {
      const f = await audioBoundaryFixture(operation);
      const baseline = await f.preflight();
      expect(baseline.eligible).to.equal(true);
      expect(baseline.items[1].proposed).to.equal(operation);
      await revalidateDeployBatchAudioBoundary(f.connection, f.input, baseline, 1, []);
      expect(f.mutations).to.deep.equal([]);
      expect(f.puts()).to.equal(0);
    });
    it(`accounts for completed Audio ${operation} before the next item boundary`, async () => {
      const f = await audioBoundaryFixture(operation);
      const definition = {
        ...f.definitions[0],
        identity: { ...f.definitions[0].identity, apiName: 'Zzz' },
        title: 'Zzz',
        contentBody: { ...f.definitions[0].contentBody, 'sfdc_cms:title': 'Zzz' },
        companions: { rawHtml: 'Zzz.cms-email.html' },
      };
      const file = path.join(f.directory, 'Zzz.cms-email.json');
      await writeFile(file, JSON.stringify(definition));
      await writeFile(path.join(f.directory, 'Zzz.cms-email.html'), '<p>Desired</p>');
      f.definitions.push(definition);
      Object.assign(f.input, { sources: { 'source-dir': [f.audioFile, file] } });
      const result = await f.run();
      expect(result.report.blockedReasons).to.deep.equal([]);
      expect(result.report.state).to.equal('completed');
      expect(result.report.summary.completed).to.equal(2);
      expect(f.mutations).to.deep.equal(operation === 'unchanged' ? ['Zzz'] : ['Zulu', 'Zzz']);
    });
    for (const drift of [
      'bytes',
      'definition',
      'inventory',
      'root',
      'language',
      'proof',
      'prepared',
      'cancel',
    ]) {
      it(`blocks Audio ${operation} ${drift} at the boundary`, async () => {
        const f = await audioBoundaryFixture(operation);
        const baseline = await f.preflight();
        const controller = new AbortController();
        if (drift === 'bytes') await writeFile(f.companion, 'changed');
        if (drift === 'definition') {
          f.definition.title = 'Changed';
          await writeFile(f.audioFile, JSON.stringify(f.definition));
        }
        if (drift === 'inventory') f.records.push({ ...f.records[0], Id: '9Ps000000000009AAA' });
        if (drift === 'root') f.workspace.rootFolderId = 'changed';
        if (drift === 'language') f.workspace.defaultLanguage = 'de_DE';
        if (drift === 'proof') {
          delete baseline.items[1].audioCreate;
          delete baseline.items[1].audioUnchanged;
          delete baseline.items[1].audioUpdate;
        }
        if (drift === 'prepared') baseline.preparation.items[1].source.mediaSha256 = 'changed';
        if (drift === 'cancel') controller.abort();
        let rejected = false;
        try {
          await revalidateDeployBatchAudioBoundary(f.connection, f.input, baseline, 1, [], {
            signal: controller.signal,
          });
        } catch {
          rejected = true;
        }
        expect(rejected).to.equal(true);
        expect(f.mutations).to.deep.equal([]);
        expect(f.puts()).to.equal(0);
      });
    }
    it(`rejects late Audio ${operation} drift before earlier Email mutation`, async () => {
      const f = await audioBoundaryFixture(operation);
      const result = await f.run({
        rewrite: async (file, report) => {
          await rewriteAtomic(file, report);
          await writeFile(f.companion, 'late drift');
        },
      });
      expect(result.report.state).to.equal('blocked');
      expect(result.report.items.every((item) => item.outcome === 'unattempted')).to.equal(true);
      expect(f.mutations).to.deep.equal([]);
      expect(f.puts()).to.equal(0);
    });
    it(`executes private Audio ${operation} after a verified Email prefix`, async () => {
      const f = await audioBoundaryFixture(operation);
      const result = await f.run();
      const outcomes = { create: 'created', update: 'updated', unchanged: 'unchanged' };
      const outcome = outcomes[operation];
      expect(result.report.blockedReasons).to.deep.equal([]);
      expect(result.report.state).to.equal('completed');
      expect(result.report.items.map((item) => item.outcome)).to.deep.equal(['created', outcome]);
      expect(result.report.items[1].target).to.deep.equal({
        contentId: '20Y000000000004AAA',
        variantId: '9Ps000000000004AAA',
      });
      expect(result.report.summary.completed).to.equal(2);
      expect(f.mutations).to.deep.equal(operation === 'unchanged' ? ['Alpha'] : ['Alpha', 'Zulu']);
      expect(f.puts()).to.equal(operation === 'update' ? 1 : 0);
      if (operation !== 'unchanged') {
        const journal = JSON.parse(
          await readFile(result.report.items[1].reportFile, 'utf8'),
        ) as WorkspaceImportRunReport;
        expect(journal.state).to.equal('completed');
        expect(journal.operations[0].state).to.equal('succeeded');
        expect(journal.operations[0].operationKind).to.equal(
          operation === 'create' ? 'create-parent' : 'update-variant',
        );
        expect(journal.createdParents).to.have.length(operation === 'create' ? 1 : 0);
      }
    });
  }
  for (const operation of ['create', 'update'] as const) {
    for (const failure of ['intent', 'boundary', 'response', 'partial', 'completion'] as const) {
      it(`preserves Audio ${operation} accounting after ${failure} failure`, async () => {
        const f = await audioBoundaryFixture(operation);
        if (failure === 'response') f.fail('Zulu');
        if (failure === 'partial') f.partialDocumentResponse();
        const result = await f.run({
          rewrite: rewriteAtomic,
          item: {
            rewrite: async (file, report) => {
              const audio =
                path.basename(report.sourceDirectory) === path.basename(f.directory) &&
                file.endsWith('.2.json');
              if (audio && failure === 'intent' && report.state === 'applying')
                throw new Error('Audio intent unavailable');
              await rewriteAtomic(file, report);
              if (audio && failure === 'boundary' && report.state === 'applying')
                await writeFile(f.companion, 'changed at durable item boundary');
              if (audio && failure === 'completion' && report.state === 'completed')
                throw new Error('Audio completion unavailable');
            },
          },
        });
        const dispatched = !['intent', 'boundary'].includes(failure);
        expect(result.report.state).to.equal('partial');
        expect(result.report.items[0].outcome).to.equal('created');
        expect(result.report.items[1].outcome).to.equal(dispatched ? 'uncertain' : 'failed');
        expect(result.report.summary.completed).to.equal(1);
        expect(f.mutations).to.deep.equal(dispatched ? ['Alpha', 'Zulu'] : ['Alpha']);
        expect(f.puts()).to.equal(
          dispatched && operation === 'update' && failure !== 'response' ? 1 : 0,
        );
        expect(result.report.blockedReasons.join('; ')).not.to.include('secret-token');
        const journal = JSON.parse(
          await readFile(result.report.items[1].reportFile, 'utf8'),
        ) as WorkspaceImportRunReport;
        expect(journal.state).to.equal(dispatched ? 'ownership-uncertain' : 'failed');
      });
    }
  }
  for (const drift of [
    'version',
    'download',
    'late-source',
    'late-cancel',
    'expected-selection',
    'expected-root',
    'prepared-id',
    'verified-prefix',
  ]) {
    it(`rejects independent Audio UPDATE ${drift} observation drift`, async () => {
      const f = await audioBoundaryFixture('update');
      const baseline = await f.preflight();
      const controller = new AbortController();
      const input = {
        ...f.input,
        expectedSelection: baseline.selection,
        expectedRootFolderId: baseline.rootFolderId,
      };
      if (drift === 'version') f.details.get('MCKEY4')!.managedContentVersionId = 'new-version';
      if (drift === 'download')
        (globalThis.fetch as sinon.SinonStub).callsFake(
          async () =>
            new Response('changed', { headers: { 'content-type': 'application/x-future-audio' } }),
        );
      let changed = false;
      if (drift === 'late-source' || drift === 'late-cancel')
        f.onRead(async () => {
          if (changed) return;
          changed = true;
          if (drift === 'late-source') await writeFile(f.companion, 'changed during GET');
          else controller.abort();
        });
      if (drift === 'expected-selection')
        input.expectedSelection = { ...baseline.selection, items: [] };
      if (drift === 'expected-root') input.expectedRootFolderId = 'wrong-root';
      if (drift === 'prepared-id')
        baseline.preparation.items[1].existing!.variantId = '9Ps000000000009AAA';
      const prefix =
        drift === 'verified-prefix'
          ? [baseline.preparation.items[1].audioInventory!.records[0]]
          : [];
      let rejected = false;
      try {
        await revalidateDeployBatchAudioBoundary(f.connection, input, baseline, 1, prefix, {
          signal: controller.signal,
        });
      } catch {
        rejected = true;
      }
      expect(rejected).to.equal(true);
      expect(f.mutations).to.deep.equal([]);
      expect(f.puts()).to.equal(0);
    });
  }
});

async function mixedAudioFixture(operation: 'create' | 'unchanged' | 'update') {
  const f = await audioBoundaryFixture(operation);
  const definition = {
    ...f.definitions[0],
    identity: { ...f.definitions[0].identity, apiName: 'Zzz' },
    title: 'Zzz',
    contentBody: { ...f.definitions[0].contentBody, 'sfdc_cms:title': 'Zzz' },
    companions: { rawHtml: 'Zzz.cms-email.html' },
  };
  const file = path.join(f.directory, 'Zzz.cms-email.json');
  await writeFile(file, JSON.stringify(definition));
  await writeFile(path.join(f.directory, definition.companions.rawHtml), '<p>Desired</p>');
  f.definitions.push(definition);
  Object.assign(f.input, {
    sources: { 'source-dir': [...f.files.slice(0, 3), f.audioFile, file] },
  });
  if (operation !== 'create')
    f.details.get('MCKEY2')!.contentBody = {
      ...f.definitions[1].contentBody,
      rawHtml: '&lt;p&gt;Original&lt;/p&gt;',
    };
  return f;
}

describe('public Audio mixed-family batch regressions', () => {
  afterEach(() => sinon.restore());

  for (const operation of ['create', 'unchanged', 'update'] as const) {
    it(`verifies public Audio ${operation} between mixed-family prefix and following Email CREATE`, async () => {
      const f = await mixedAudioFixture(operation);
      const planned = await f.preflight();
      expect(planned.eligible).to.equal(true);
      expect(planned.items[3].proposed).to.equal(operation);
      if (operation === 'update') {
        const proof = planned.items[3].audioUpdate!;
        expect(proof.mediaSha256).not.to.equal(proof.destination.mediaSha256);
        expect(planned.preparation.items[3].changedFields).to.deep.equal(['media']);
      }
      const result = await f.run();
      expect(result.report.blockedReasons).to.deep.equal([]);
      expect(result.report.state).to.equal('completed');
      expect(result.qualification).to.equal('unqualified');
      const audioOutcome = { create: 'created', unchanged: 'unchanged', update: 'updated' };
      expect(result.report.items.map((item) => item.outcome)).to.deep.equal([
        'created',
        operation === 'create' ? 'created' : 'updated',
        operation === 'create' ? 'created' : 'unchanged',
        audioOutcome[operation],
        'created',
      ]);
      const expectedMutations =
        operation === 'create' ? ['Alpha', 'Beta', 'Gamma'] : ['Alpha', 'Beta'];
      if (operation !== 'unchanged') expectedMutations.push('Zulu');
      expect(f.mutations).to.deep.equal([...expectedMutations, 'Zzz']);
      expect(f.puts()).to.equal(Number(operation !== 'create') + Number(operation === 'update'));
      expect(result.report.summary).to.include({ completed: 5, uncertain: 0, unattempted: 0 });
      for (const item of result.report.items.filter((entry) => entry.outcome !== 'unchanged')) {
        const journal = JSON.parse(
          await readFile(item.reportFile, 'utf8'),
        ) as WorkspaceImportRunReport;
        expect(journal.state).to.equal('completed');
        expect(journal.operations[0].state).to.equal('succeeded');
        expect(journal.operations[0].result?.contentId).to.equal(item.target?.contentId);
      }
      expect(await f.journal()).to.deep.equal(result.report);
    });

    it(`blocks stale later public Audio ${operation} before any mixed-family write`, async () => {
      const f = await mixedAudioFixture(operation);
      let injected = false;
      const result = await f.run({
        rewrite: async (file, report) => {
          await rewriteAtomic(file, report);
          if (injected) return;
          injected = true;
          if (operation === 'update') {
            f.details.get('MCKEY4')!.managedContentVersionId = 'stale-after-planning';
          } else {
            await writeFile(f.companion, Buffer.from([1, 2, 3]));
          }
        },
      });
      expect(injected).to.equal(true);
      expect(result.report.state).to.equal('blocked');
      expect(result.report.blockedReasons).not.to.deep.equal([]);
      expect(result.report.items.every((item) => item.outcome === 'unattempted')).to.equal(true);
      expect(result.report.summary).to.include({ completed: 0, unattempted: 5 });
      expect(f.mutations).to.deep.equal([]);
      expect(f.puts()).to.equal(0);
    });
  }

  for (const field of ['title', 'mimeType', 'filename'] as const)
    it(`rejects invalid later Audio UPDATE ${field} before mixed CREATE/UPDATE prefix writes`, async () => {
      const f = await mixedAudioFixture('update');
      const detail = f.details.get('MCKEY4')!;
      const media = (detail.contentBody as Row)['sfdc_cms:media'] as Row;
      if (field === 'title') detail.title = 'Different';
      if (field === 'mimeType') (media.source as Row).mimeType = 'audio/other';
      if (field === 'filename')
        media.url = String(media.url).replace('Zulu.cms-audio.media.bin', 'Other.bin');
      const result = await f.run();
      expect(result.report.state).to.equal('blocked');
      expect(result.report.blockedReasons).not.to.deep.equal([]);
      expect(result.report.items.every((item) => item.outcome === 'unattempted')).to.equal(true);
      expect(result.report.summary).to.include({ completed: 0, unattempted: 5 });
      expect(f.mutations).to.deep.equal([]);
      expect(f.puts()).to.equal(0);
    });
});

describe('verified mixed-family inventory prefix reconciliation', () => {
  const types = ['email', 'emailTemplate', 'image', 'document', 'audio'];
  const rows = types.map((type, index) => ({
    Id: `variant-${index}`,
    ManagedContentId: `parent-${index}`,
    ManagedContentKey: `key-${index}`,
    ContentTypeFullyQualifiedName: `sfdc_cms__${type}`,
    Language: 'en_US',
    IsPublished: false,
    ManagedContentVariantStatus: 'Draft',
    IsPrimary: true,
    Name: type,
    UrlName: null,
    ManagedContent: { AuthoredManagedContentSpaceId: workspaceId, ApiName: type },
  }));
  const baseline: NativeInventory = {
    apiVersion: '67.0',
    workspaceId,
    complete: true,
    pagesRequested: 4,
    records: [{ ...rows[0], Id: 'unrelated', ManagedContentId: 'unrelated-parent' }],
  };
  const fresh = () => ({
    ...structuredClone(baseline),
    pagesRequested: 8,
    records: [...structuredClone(baseline.records), ...structuredClone(rows)],
  });
  it('subtracts exactly the verified Email/Template/Image/Document prefix without changing input bytes', () => {
    const inventory = fresh();
    const bytes = JSON.stringify(inventory);
    expect(reconcileDeployBatchInventory(inventory, baseline, rows)).to.deep.equal(baseline);
    expect(JSON.stringify(inventory)).to.equal(bytes);
    expect(reconcileDeployBatchInventory(baseline, baseline, [])).to.deep.equal(baseline);
  });
  for (const [index, type] of types.entries()) {
    for (const drift of ['missing', 'changed', 'duplicate'])
      it(`rejects ${drift} verified ${type} prefix evidence`, () => {
        const inventory = fresh();
        if (drift === 'missing') inventory.records.splice(index + 1, 1);
        if (drift === 'changed') inventory.records[index + 1].ManagedContentKey = 'changed';
        if (drift === 'duplicate') inventory.records.push(structuredClone(rows[index]));
        expect(() => reconcileDeployBatchInventory(inventory, baseline, rows)).to.throw(
          /verified CREATE/u,
        );
      });
  }
  for (const drift of ['unknown', 'unrelated', 'scope', 'version', 'registration'])
    it(`rejects ${drift} drift rather than erasing full inventory evidence`, () => {
      const inventory = fresh();
      if (drift === 'unknown') inventory.records.push({ ...rows[0], Id: 'new-unknown' });
      if (drift === 'unrelated') inventory.records[0].Name = 'changed';
      if (drift === 'scope') inventory.workspaceId = 'different';
      if (drift === 'version') inventory.apiVersion = '68.0';
      expect(() =>
        reconcileDeployBatchInventory(
          inventory,
          baseline,
          drift === 'registration' ? [...rows, rows[0]] : rows,
        ),
      ).to.throw(/inventory changed/u);
    });
});

describe('verified UPDATE inventory accounting', () => {
  const before: NativeInventory['records'][number] = {
    Id: '9Ps000000000001AAA',
    ManagedContentId: '20Y000000000001AAA',
    ManagedContentKey: 'key',
    ContentTypeFullyQualifiedName: 'sfdc_cms__email',
    Language: 'en_US',
    IsPublished: false,
    ManagedContentVariantStatus: 'Draft',
    IsPrimary: true,
    Name: 'Alpha',
    UrlName: null,
    ManagedContent: { AuthoredManagedContentSpaceId: workspaceId, ApiName: 'Alpha' },
  };
  const baseline: NativeInventory = {
    apiVersion: '67.0',
    workspaceId,
    complete: true,
    pagesRequested: 4,
    records: [before],
  };
  it('accounts for observed UPDATE alongside CREATE without altering either baseline', () => {
    const created = { ...structuredClone(before), Id: '9Ps000000000002AAA' };
    const fresh = {
      ...structuredClone(baseline),
      pagesRequested: 8,
      records: [structuredClone(before), created],
    };
    const snapshot = JSON.stringify({ baseline, fresh });
    const normalized = reconcileDeployBatchInventory(
      fresh,
      baseline,
      [created],
      [{ before, after: structuredClone(before) }],
    );
    expect(normalized).to.deep.equal(baseline);
    expect(JSON.stringify({ baseline, fresh })).to.equal(snapshot);
  });
  for (const drift of [
    'missing',
    'changed',
    'old',
    'unknown',
    'duplicate',
    'conflict',
    'title',
    'url',
  ])
    it(`rejects ${drift} UPDATE evidence without granting row mutation permission`, () => {
      const fresh = structuredClone(baseline);
      const transition = { before: structuredClone(before), after: structuredClone(before) };
      if (drift === 'missing') fresh.records = [];
      if (drift === 'changed') fresh.records[0].ManagedContentKey = 'changed';
      if (drift === 'old') transition.before.ManagedContentKey = 'stale';
      if (drift === 'unknown') transition.before.Id = 'unknown';
      if (drift === 'title') {
        fresh.records[0].Name = 'Changed';
        transition.after.Name = 'Changed';
      }
      if (drift === 'url') {
        fresh.records[0].UrlName = 'changed';
        transition.after.UrlName = 'changed';
      }
      expect(() =>
        reconcileDeployBatchInventory(
          fresh,
          baseline,
          drift === 'conflict' ? [before] : [],
          drift === 'duplicate' ? [transition, transition] : [transition],
        ),
      ).to.throw(/inventory changed/u);
    });
});

describe('internal sequential batch executor', () => {
  for (const contentType of ['sfdc_cms__audio', 'sfdc_cms__unknown']) {
    it(`rejects explicit ${contentType} before executor inventory or mutation`, async () => {
      const f = await fixture();
      let reads = 0;
      f.onRead(async () => {
        reads++;
      });
      await writeFile(
        f.files[0],
        JSON.stringify({
          contract: 'sf-cms-media-source',
          contractVersion: '1.0.0',
          identity: {
            ...f.definitions[0].identity,
            type: contentType === 'sfdc_cms__audio' ? 'Audio' : 'Unknown',
          },
          contentType,
          language: 'en_US',
          folderPath: [],
          media: { representation: 'url-only', address: 'https://example.invalid/sound.wav' },
        }),
      );
      try {
        await f.run();
        throw new Error('Expected unsupported source rejection');
      } catch (error) {
        expect((error as Error).message).to.match(
          contentType === 'sfdc_cms__audio'
            ? /Audio deploy selection requires a binary source/u
            : /Unsupported (deploy media content type|media type\/contentType)/u,
        );
      }
      expect(reads).to.equal(0);
      expect(f.mutations).to.deep.equal([]);
      expect(f.puts()).to.equal(0);
    });
  }
  for (const contentType of ['sfdc_cms__audio', 'sfdc_cms__unknown']) {
    it(`blocks fabricated ${contentType} media at the execution boundary without Image transport`, async () => {
      const f = await fixture(false, true);
      let injected = false;
      const result = await f.run({
        rewrite: async (file, report) => {
          if (!injected) {
            injected = true;
            report.items[0].source.definition = {
              ...report.items[2].source.definition,
              contentType,
            };
          }
          await rewriteAtomic(file, report);
        },
      });
      expect(result.report.state).to.equal('blocked');
      expect(result.report.blockedReasons.join('; ')).to.match(
        /Unsupported deploy media content type|Batch selection changed before execution/u,
      );
      expect(f.mutations).to.deep.equal([]);
      expect(f.puts()).to.equal(0);
      expect(result.report.items.every((item) => item.outcome === 'unattempted')).to.equal(true);
    });
  }
  for (const existing of [false, true])
    it(`executes real mixed Email/Template/Image ${existing ? 'CREATE/unchanged' : 'CREATE'} orchestration`, async () => {
      const f = await fixture(existing, true);
      const result = await f.run();
      expect(result.report.blockedReasons).to.deep.equal([]);
      expect(result.report.state).to.equal('completed');
      expect(result.report.items.map((item) => item.outcome)).to.deep.equal(
        existing ? ['created', 'unchanged', 'unchanged'] : ['created', 'created', 'created'],
      );
      expect(f.mutations).to.deep.equal(existing ? ['Alpha'] : ['Alpha', 'Beta', 'Gamma']);
      expect(result.report.summary.uncertain).to.equal(0);
      expect(await f.journal()).to.deep.equal(result.report);
    });
  for (const drift of [
    'source',
    'root',
    'inventory',
    'prefix',
    'summary',
    'item',
    'callback',
    'cancel',
  ])
    it(`preserves mixed-family verified prefix on ${drift} failure`, async () => {
      const f = await fixture(false, true);
      const controller = new AbortController();
      let injected = false;
      const result = await f.run(
        {
          rewrite: async (file, report) => {
            if (drift === 'summary' && report.summary.completed === 2)
              throw new Error('Summary unavailable');
            await rewriteAtomic(file, report);
            if (injected || report.summary.completed !== 2) return;
            injected = true;
            if (drift === 'source') await writeFile(f.files[2], '{}');
            if (drift === 'root') f.workspace.rootFolderId = 'changed';
            if (drift === 'cancel') controller.abort();
            if (drift === 'callback')
              f.onRead(async () => {
                await writeFile(f.input.reportFile, '{}');
              });
            if (drift === 'inventory')
              f.records.push({
                ...f.records[0],
                Id: '9Ps000000000009AAA',
                ManagedContentId: '20Y000000000009AAA',
              });
            if (drift === 'prefix') f.records[0].ManagedContentKey = 'changed';
          },
          item: {
            rewrite: async (file, report) => {
              if (
                drift === 'item' &&
                report.state === 'completed' &&
                report.createdParents[0]?.contentId === '20Y000000000003AAA'
              )
                throw new Error('Item completion unavailable');
              await rewriteAtomic(file, report);
            },
          },
        },
        { signal: controller.signal },
      );
      expect(result.report.state).to.equal('partial');
      expect(result.report.items.slice(0, 2).map((item) => item.outcome)).to.deep.equal([
        'created',
        'created',
      ]);
      expect(result.report.items[2].outcome).to.equal(
        drift === 'item' ? 'uncertain' : 'unattempted',
      );
      expect(f.mutations).to.deep.equal(
        drift === 'item' ? ['Alpha', 'Beta', 'Gamma'] : ['Alpha', 'Beta'],
      );
      for (const item of result.report.items.slice(0, 2)) {
        const journal = JSON.parse(
          await readFile(item.reportFile, 'utf8'),
        ) as WorkspaceImportRunReport;
        expect(journal.state).to.equal('completed');
        expect(journal.createdParents).to.have.length(1);
      }
      if (drift === 'item') {
        const journal = JSON.parse(
          await readFile(result.report.items[2].reportFile, 'utf8'),
        ) as WorkspaceImportRunReport;
        expect(journal.state).to.equal('ownership-uncertain');
        expect(journal.operations[0].state).to.equal('pending');
        expect(journal.operations[0].result?.contentId).to.equal('20Y000000000003AAA');
      }
    });
  for (const existing of [false, true])
    it(`executes actual four-family Document ${existing ? 'unchanged' : 'CREATE'} batch`, async () => {
      const f = await fixture(existing, true, true);
      const result = await f.run();
      expect(result.report.blockedReasons).to.deep.equal([]);
      expect(result.report.state).to.equal('completed');
      expect(result.report.items.map((item) => item.outcome)).to.deep.equal(
        existing
          ? ['created', 'unchanged', 'unchanged', 'unchanged']
          : ['created', 'created', 'created', 'created'],
      );
      expect(f.mutations).to.deep.equal(existing ? ['Alpha'] : ['Alpha', 'Beta', 'Gamma', 'Zulu']);
      expect(f.puts()).to.equal(0);
      const item = result.report.items[3];
      if (existing) {
        let absent = false;
        try {
          await readFile(item.reportFile);
        } catch (error) {
          absent = (error as NodeJS.ErrnoException).code === 'ENOENT';
        }
        expect(absent).to.equal(true);
      } else {
        const journal = JSON.parse(
          await readFile(item.reportFile, 'utf8'),
        ) as WorkspaceImportRunReport;
        expect(journal.state).to.equal('completed');
        expect(journal.createdParents[0].contentId).to.equal('20Y000000000004AAA');
      }
      expect(await f.journal()).to.deep.equal(result.report);
    });
  for (const drift of ['none', 'title', 'url', 'registered', 'summary'])
    it(`verifies real Email UPDATE before mixed Document unchanged with ${drift} accounting drift`, async () => {
      const f = await fixture(true, true, true);
      f.details.get('MCKEY2')!.contentBody = {
        ...f.definitions[1].contentBody,
        rawHtml: '&lt;p&gt;Original&lt;/p&gt;',
      };
      let injected = false;
      const result = await f.run({
        rewrite: async (file, report) => {
          await rewriteAtomic(file, report);
          if (!injected && report.summary.updated === 1) {
            injected = true;
            if (drift === 'registered') f.records[0].Name = 'Late drift';
            if (drift === 'summary') throw new Error('Summary unavailable');
          }
        },
        item: {
          rewrite: async (file, report) => {
            await rewriteAtomic(file, report);
            if (
              report.state === 'completed' &&
              report.operations[0]?.operationKind === 'update-variant'
            ) {
              if (drift === 'title') f.records[0].Name = 'Unrelated title';
              if (drift === 'url') f.records[0].UrlName = 'unrelated-url';
            }
          },
        },
      });
      expect(f.puts()).to.equal(1);
      expect(f.mutations).to.deep.equal(['Alpha', 'Beta']);
      expect(result.report.state).to.equal(drift === 'none' ? 'completed' : 'partial');
      expect(result.report.items[1].outcome).to.equal(
        drift === 'title' || drift === 'url' ? 'uncertain' : 'updated',
      );
      expect(result.report.items[3].outcome).to.equal(
        drift === 'none' ? 'unchanged' : 'unattempted',
      );
      const journal = JSON.parse(
        await readFile(result.report.items[1].reportFile, 'utf8'),
      ) as WorkspaceImportRunReport;
      expect(journal.state).to.equal('completed');
      expect(journal.createdParents).to.deep.equal([]);
      expect(journal.operations[0].state).to.equal('succeeded');
    });
  it('executes mixed Document UPDATE with frozen old/new hashes and complete inventory', async () => {
    const f = await fixture(true, true, true);
    const file = f.files[3];
    const definition = JSON.parse(await readFile(file, 'utf8')) as Row;
    definition.urlName = 'zulu';
    await writeFile(file, JSON.stringify(definition));
    f.records[2].UrlName = 'zulu';
    f.details.get('MCKEY4')!.urlName = 'zulu';
    const desired = Buffer.from('Different UTF-8 café\r\n');
    await writeFile(path.join(f.directory, 'Zulu.cms-document.media.txt'), desired);
    const planned = await f.preflight();
    expect(planned.eligible).to.equal(true);
    expect(planned.items[3].proposed).to.equal('update');
    expect(planned.items[3].blockedReasons).to.deep.equal([]);
    const proof = planned.items[3].documentUpdate!;
    expect(proof.mediaSha256).to.equal(createHash('sha256').update(desired).digest('hex'));
    expect(proof.destination.mediaSha256).not.to.equal(proof.mediaSha256);
    expect(proof.destination.inventory.records).to.have.length(3);
    expect(proof).to.deep.equal(planned.preparation.items[3].documentUpdate);
    expect(planned.preparation.items[3].changedFields).to.deep.equal(['media']);
    const result = await f.run();
    expect(result.report.blockedReasons).to.deep.equal([]);
    expect(result.report.state).to.equal('completed');
    expect(result.report.items.map((item) => item.outcome)).to.deep.equal([
      'created',
      'unchanged',
      'unchanged',
      'updated',
    ]);
    expect(f.mutations).to.deep.equal(['Alpha', 'Zulu']);
    expect(f.puts()).to.equal(1);
    const journal = JSON.parse(
      await readFile(result.report.items[3].reportFile, 'utf8'),
    ) as WorkspaceImportRunReport;
    expect(journal.state).to.equal('completed');
    expect(journal.operations[0].state).to.equal('succeeded');
    expect(journal.createdParents).to.deep.equal([]);
    expect(journal.operations[0].result).to.include({
      contentId: proof.contentId,
      variantId: proof.variantId,
    });
    expect(proof.destination.mediaSha256).not.to.equal(proof.mediaSha256);
  });
  for (const drift of [
    'none',
    'source',
    'root',
    'inventory',
    'language',
    'cancel',
    'callback',
    'boundary',
    'partial',
    'result',
    'item',
    'summary',
  ])
    it(`executes actual Document UPDATE after CREATE and UPDATE prefix with ${drift} failure`, async () => {
      const f = await fixture(true, true, true);
      const definition = JSON.parse(await readFile(f.files[3], 'utf8')) as Row;
      definition.urlName = 'zulu';
      await writeFile(f.files[3], JSON.stringify(definition));
      f.records[2].UrlName = 'zulu';
      f.details.get('MCKEY4')!.urlName = 'zulu';
      f.details.get('MCKEY2')!.contentBody = {
        ...f.definitions[1].contentBody,
        rawHtml: '&lt;p&gt;Original&lt;/p&gt;',
      };
      await writeFile(
        path.join(f.directory, 'Zulu.cms-document.media.txt'),
        'Replacement café\r\n',
      );
      if (drift === 'partial') f.partialDocumentResponse();
      const controller = new AbortController();
      let injected = false;
      const result = await f.run(
        {
          rewrite: async (file, report) => {
            await rewriteAtomic(file, report);
            if (drift === 'summary' && report.summary.updated === 2)
              throw new Error('Summary unavailable');
            if (injected || report.summary.completed !== 3) return;
            injected = true;
            if (drift === 'source')
              await writeFile(path.join(f.directory, 'Zulu.cms-document.media.txt'), 'Drift');
            if (drift === 'root') f.workspace.rootFolderId = 'drift';
            if (drift === 'inventory') f.records[0].Name = 'drift';
            if (drift === 'language') f.workspace.defaultLanguage = 'de_DE';
            if (drift === 'cancel') controller.abort();
          },
          item: {
            rewrite: async (file, report) => {
              const document =
                report.operations[0]?.result?.contentId === '20Y000000000004AAA' ||
                file.endsWith('.4.json');
              if (document && drift === 'callback' && report.state === 'applying')
                throw new Error('Awaited item boundary persistence unavailable');
              if (document && drift === 'boundary' && report.state === 'applying')
                f.workspace.rootFolderId = 'drift-inside-item';
              if (document && drift === 'result' && report.state === 'ownership-uncertain')
                throw new Error('Result persistence unavailable');
              if (document && drift === 'item' && report.state === 'completed')
                throw new Error('Completion persistence unavailable');
              await rewriteAtomic(file, report);
            },
          },
        },
        { signal: controller.signal },
      );
      const dispatched = ['none', 'partial', 'result', 'item', 'summary'].includes(drift);
      expect(f.mutations).to.deep.equal(dispatched ? ['Alpha', 'Beta', 'Zulu'] : ['Alpha', 'Beta']);
      expect(f.puts()).to.equal(dispatched ? 2 : 1);
      expect(result.report.items.slice(0, 3).map((item) => item.outcome)).to.deep.equal([
        'created',
        'updated',
        'unchanged',
      ]);
      expect(result.report.state).to.equal(drift === 'none' ? 'completed' : 'partial');
      let expectedOutcome = 'unattempted';
      if (dispatched) expectedOutcome = 'uncertain';
      if (drift === 'callback' || drift === 'boundary') expectedOutcome = 'failed';
      if (drift === 'none' || drift === 'summary') expectedOutcome = 'updated';
      expect(result.report.items[3].outcome).to.equal(expectedOutcome);
      if (dispatched) {
        const journal = JSON.parse(
          await readFile(result.report.items[3].reportFile, 'utf8'),
        ) as WorkspaceImportRunReport;
        expect(journal.createdParents).to.deep.equal([]);
        let expectedState = 'ownership-uncertain';
        if (drift === 'result') expectedState = 'applying';
        if (drift === 'none' || drift === 'summary') expectedState = 'completed';
        expect(journal.state).to.equal(expectedState);
        expect(journal.operations[0].state).to.equal(
          drift === 'none' || drift === 'summary' ? 'succeeded' : 'pending',
        );
      }
    });
  for (const changed of ['title', 'urlName', 'language', 'mimeType', 'filename', 'type'])
    it(`rejects changed Document ${changed} before any mixed-prefix mutation`, async () => {
      const f = await fixture(true, true, true);
      const definition = JSON.parse(await readFile(f.files[3], 'utf8')) as Row;
      definition.urlName = 'zulu';
      f.records[2].UrlName = 'zulu';
      f.details.get('MCKEY4')!.urlName = 'zulu';
      if (changed === 'title') definition.title = 'Different';
      if (changed === 'urlName') definition.urlName = 'different';
      if (changed === 'language') definition.language = 'de_DE';
      if (changed === 'type') {
        f.records[2].ContentTypeFullyQualifiedName = 'sfdc_cms__image';
      }
      const nativeMedia = (f.details.get('MCKEY4')!.contentBody as Row)['sfdc_cms:media'] as Row;
      if (changed === 'mimeType') (nativeMedia.source as Row).mimeType = 'text/csv';
      if (changed === 'filename')
        nativeMedia.url = String(nativeMedia.url).replace(
          'Zulu.cms-document.media.txt',
          'Other.txt',
        );
      await writeFile(f.files[3], JSON.stringify(definition));
      await writeFile(path.join(f.directory, 'Zulu.cms-document.media.txt'), 'Different bytes');
      const result = await f.run();
      expect(result.report.state).to.equal('blocked');
      expect(result.report.summary.unattempted).to.equal(4);
      expect(result.report.items[3].outcome).to.equal('unattempted');
      expect(f.mutations).to.deep.equal([]);
      expect(f.puts()).to.equal(0);
    });
  it('blocks changed existing Document before any mixed-prefix mutation without Image UPDATE fallback', async () => {
    const f = await fixture(true, true, true);
    await writeFile(path.join(f.directory, 'Zulu.cms-document.media.txt'), 'Changed bytes');
    const result = await f.run();
    expect(result.report.state).to.equal('blocked');
    expect(result.report.summary.unattempted).to.equal(4);
    expect(f.mutations).to.deep.equal([]);
    expect(f.puts()).to.equal(0);
  });
  for (const drift of [
    'source',
    'root',
    'inventory',
    'prefix',
    'callback',
    'cancel',
    'summary',
    'item',
  ])
    it(`preserves actual three-family prefix at Document ${drift} failure`, async () => {
      const f = await fixture(false, true, true);
      const controller = new AbortController();
      let injected = false;
      const result = await f.run(
        {
          rewrite: async (file, report) => {
            if (drift === 'summary' && report.summary.completed === 3)
              throw new Error('Summary unavailable');
            await rewriteAtomic(file, report);
            if (injected || report.summary.completed !== 3) return;
            injected = true;
            if (drift === 'source')
              await writeFile(path.join(f.directory, 'Zulu.cms-document.media.txt'), 'Changed');
            if (drift === 'root') f.workspace.rootFolderId = 'changed';
            if (drift === 'cancel') controller.abort();
            if (drift === 'callback')
              f.onRead(async () => {
                await writeFile(f.input.reportFile, '{}');
              });
            if (drift === 'inventory')
              f.records.push({
                ...f.records[0],
                Id: '9Ps000000000009AAA',
                ManagedContentId: '20Y000000000009AAA',
              });
            if (drift === 'prefix') f.records[0].ManagedContentKey = 'changed';
          },
          item: {
            rewrite: async (file, report) => {
              if (
                drift === 'item' &&
                report.state === 'completed' &&
                report.createdParents[0]?.contentId === '20Y000000000004AAA'
              )
                throw new Error('Document completion unavailable');
              await rewriteAtomic(file, report);
            },
          },
        },
        { signal: controller.signal },
      );
      expect(result.report.state).to.equal('partial');
      expect(result.report.items.slice(0, 3).map((item) => item.outcome)).to.deep.equal([
        'created',
        'created',
        'created',
      ]);
      expect(result.report.items[3].outcome).to.equal(
        drift === 'item' ? 'uncertain' : 'unattempted',
      );
      expect(f.mutations).to.deep.equal(
        drift === 'item' ? ['Alpha', 'Beta', 'Gamma', 'Zulu'] : ['Alpha', 'Beta', 'Gamma'],
      );
      expect(f.puts()).to.equal(0);
      for (const item of result.report.items.slice(0, 3)) {
        const journal = JSON.parse(
          await readFile(item.reportFile, 'utf8'),
        ) as WorkspaceImportRunReport;
        expect(journal.state).to.equal('completed');
        expect(journal.createdParents).to.have.length(1);
      }
      if (drift === 'item') {
        const journal = JSON.parse(
          await readFile(result.report.items[3].reportFile, 'utf8'),
        ) as WorkspaceImportRunReport;
        expect(journal.state).to.equal('ownership-uncertain');
        expect(journal.operations[0].state).to.equal('pending');
        expect(journal.operations[0].result?.contentId).to.equal('20Y000000000004AAA');
        expect(journal.createdParents[0].contentId).to.equal('20Y000000000004AAA');
      }
    });
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
  for (const drift of ['prefix', 'unrelated'])
    it(`stops Email CREATE after ${drift} inventory drift and preserves completed ownership`, async () => {
      const f = await fixture(true);
      const result = await f.run({
        rewrite: async (file, report) => {
          await rewriteAtomic(file, report);
          if (report.summary.completed === 1) {
            const row = f.records.find(
              (candidate) =>
                candidate.Id === (drift === 'prefix' ? '9Ps000000000001AAA' : '9Ps000000000003AAA'),
            )!;
            row.ManagedContentKey = 'DRIFT';
          }
        },
      });
      expect(f.mutations).to.deep.equal(['Alpha']);
      expect(result.report.state).to.equal('partial');
      expect(result.report.items.map((item) => item.outcome)).to.deep.equal([
        'created',
        'unattempted',
        'unattempted',
      ]);
      const journal = JSON.parse(
        await readFile(result.report.items[0].reportFile, 'utf8'),
      ) as WorkspaceImportRunReport;
      expect(journal.state).to.equal('completed');
      expect(journal.createdParents).to.have.length(1);
    });
  it('retains earlier ownership when a later CREATE final persistence is uncertain', async () => {
    const f = await fixture();
    const result = await f.run({
      rewrite: rewriteAtomic,
      item: {
        rewrite: async (file, report) => {
          if (
            report.state === 'completed' &&
            report.createdParents[0]?.contentId === '20Y000000000002AAA'
          )
            throw new Error('Final persistence unavailable');
          await rewriteAtomic(file, report);
        },
      },
    });
    expect(f.mutations).to.deep.equal(['Alpha', 'Beta']);
    expect(result.report.items.map((item) => item.outcome)).to.deep.equal([
      'created',
      'uncertain',
      'unattempted',
    ]);
    expect(result.report.state).to.equal('partial');
    const first = JSON.parse(
      await readFile(result.report.items[0].reportFile, 'utf8'),
    ) as WorkspaceImportRunReport;
    expect(first.state).to.equal('completed');
    expect(first.createdParents).to.have.length(1);
    const second = JSON.parse(
      await readFile(result.report.items[1].reportFile, 'utf8'),
    ) as WorkspaceImportRunReport;
    expect(second.state).to.equal('ownership-uncertain');
    expect(second.operations[0].result?.contentId).to.equal('20Y000000000002AAA');
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
