import type { Connection } from '@salesforce/core';
import { readFile } from 'node:fs/promises';
import PublishContent from '../../src/commands/cms/publish/content.js';
import UnpublishContent from '../../src/commands/cms/unpublish/content.js';
import { runLifecycleMetadataBatch } from '../../src/services/lifecycle-batch.js';
import { normalizeLifecycleMetadata } from '../../src/services/lifecycle-selection.js';
import { rewriteAtomic } from '../../src/services/import-workspace.js';
import { Connection as JsforceConnection } from '@jsforce/jsforce-node';
import { PassThrough } from 'node:stream';
import { expect } from 'chai';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { createRunOwnedTemp } from '../../src/filesystem/runOwnedTemp.js';
import {
  acquireLifecycleNativeIdentitySnapshot,
  acquireLifecycleNativeSnapshot,
} from '../../src/services/lifecycle-native-snapshot.js';
import sinon from 'sinon';
import {
  acquireNativePublishCheckpoint,
  refreshPreparedDraftEmailPublish,
  prepareDraftEmailPublish,
  previewDraftEmailPublish,
  executePreparedDraftEmailPublish,
  applyDraftEmailPublishWithReport,
} from '../../src/services/email-publish.js';
import {
  preparePublishedEmailUnpublish,
  previewPublishedEmailUnpublish,
  refreshPreparedPublishedEmailUnpublish,
  executePreparedPublishedEmailUnpublish,
  applyPublishedEmailUnpublishWithReport,
} from '../../src/services/email-unpublish.js';
import type { QualifiedNativePublishType } from '../../src/contracts/content-publish.js';
import type { NativeInventoryRow } from '../../src/services/retrieve-native-inventory.js';

const workspaceId = '0Zuaj000007dgL8CAI';
const contentId = '20Yaj00000FaO1aEAF';
const variantId = '9Psaj00000J5oxJCAR';
const selector = {
  workspaceId,
  contentType: 'sfdc_cms__emailTemplate',
  apiName: 'Native_Template',
  language: 'en_US',
};
function fixture(contentType = selector.contentType) {
  const selection = { ...selector, contentType };
  const row: NativeInventoryRow = {
    Id: variantId,
    ManagedContentId: contentId,
    ContentTypeFullyQualifiedName: contentType,
    Language: 'en_US',
    IsPublished: false,
    ManagedContentVariantStatus: 'Draft',
    IsPrimary: true,
    Name: 'Native template',
    UrlName: null,
    ManagedContentKey: 'MCNATIVE',
    ManagedContent: { AuthoredManagedContentSpaceId: workspaceId, ApiName: selection.apiName },
  };
  const variant: Record<string, unknown> = {
    managedContentId: contentId,
    managedContentVariantId: variantId,
    contentType: { fullyQualifiedName: contentType },
    contentSpace: { id: workspaceId },
    contentKey: row.ManagedContentKey,
    apiName: selection.apiName,
    language: selection.language,
    contentBody: { rawHtml: '&lt;p&gt;Native&lt;/p&gt;' },
    title: 'Native template',
    urlName: 'native',
    isPublished: false,
    status: { label: 'Draft label', status: 'Draft' },
  };
  const parent = structuredClone(variant);
  const rows = [row];
  const siblings = [structuredClone(row)];
  const calls: string[] = [];
  const workspace = { id: workspaceId, apiName: 'Marketing', defaultLanguage: 'en_US' };
  const connection = {
    accessToken: 'test-token',
    instanceUrl: 'https://source.example',
    getApiVersion: () => '67.0',
    request({ url, method }: { url: string; method?: string }) {
      expect(method).to.equal('GET');
      calls.push(url);
      let result: unknown;
      if (url.includes('/query?q=')) {
        const query = decodeURIComponent(url.split('?q=')[1]);
        const inventory = query.includes(`ManagedContentId = '${contentId}'`) ? siblings : rows;
        let records: unknown[] = inventory;
        if (query.includes('COUNT(Id)'))
          records =
            inventory.length === 0
              ? []
              : [...new Set(inventory.map((entry) => entry.ManagedContentId))].map((id) => ({
                  ManagedContentId: id,
                  siblingCount: inventory.filter((entry) => entry.ManagedContentId === id).length,
                }));
        else if (query.includes('AND Id >')) records = [];
        result = { done: true, totalSize: records.length, records };
      } else if (url.includes('/spaces/')) result = workspace;
      else if (url.endsWith(`/variants/${variantId}`)) result = variant;
      else if (url.endsWith(`/contents/${contentId}`)) result = parent;
      else throw new Error(`Unexpected read ${url}`);
      return Promise.resolve(result);
    },
  } as unknown as Pick<Connection, 'request' | 'getApiVersion'>;
  return { selection, row, rows, siblings, variant, parent, calls, connection, workspace };
}
async function fails(current: ReturnType<typeof fixture>, message: string): Promise<void> {
  let failure: unknown;
  try {
    await acquireLifecycleNativeIdentitySnapshot(current.connection, current.selection);
  } catch (error) {
    failure = error;
  }
  expect(failure).to.be.instanceOf(TypeError);
  expect((failure as Error).message).to.include(message);
}

function staticFixture() {
  const current = fixture();
  const body = {
    'sfdc_cms:title': 'Native',
    messagePurpose: 'Marketing',
    rawHtml: '&lt;p&gt;Native&lt;/p&gt;',
  };
  current.variant.contentBody = structuredClone(body);
  current.parent.contentBody = structuredClone(body);
  return current;
}
function mediaFixture(contentType = 'sfdc_cms__image') {
  const current = fixture(contentType);
  const bytes = Buffer.from('Exact native bytes');
  const mimeType = contentType === 'sfdc_cms__audio' ? 'audio/x-wav' : 'image/png';
  const media = {
    source: { type: 'file', size: bytes.length, fileSize: bytes.length, mimeType },
    url: `/cms/media/MCNATIVE?version=1.0&fileHash=${createHash('md5').update(bytes).digest('hex')}&fileName=native.png`,
  };
  for (const detail of [current.variant, current.parent]) {
    detail.contentBody = { 'sfdc_cms:media': structuredClone(media) };
    detail.folder = null;
  }
  current.row.UrlName = 'native';
  current.siblings[0].UrlName = 'native';
  return { ...current, bytes, mimeType };
}
async function integrityFailure(current: ReturnType<typeof fixture>, pattern: RegExp) {
  try {
    await acquireLifecycleNativeSnapshot(current.connection, current.selection);
  } catch (error) {
    expect((error as Error).message).to.match(pattern);
    return;
  }
  throw new Error('Expected integrity rejection');
}
const selection = (current: ReturnType<typeof fixture>) => ({
  ...current.selection,
  contentType: current.selection.contentType as QualifiedNativePublishType,
});
const checkpoint = (current: ReturnType<typeof fixture>) =>
  acquireNativePublishCheckpoint(current.connection, selection(current), 'Draft');
async function rejected(operation: Promise<unknown>, pattern: RegExp): Promise<void> {
  try {
    await operation;
  } catch (error) {
    expect(error).to.be.instanceOf(TypeError);
    expect((error as Error).message).to.match(pattern);
    return;
  }
  throw new Error('Expected native publish checkpoint rejection');
}

const input = (current: ReturnType<typeof fixture>) => ({ selector: selection(current) });
const batchResponse = (value: unknown) =>
  Object.assign(Promise.resolve(structuredClone(value)), { stream: () => new PassThrough() });
// Real batch/CLI fixture: native queries retain family and independent parent scope.
function batchFixture(operation: 'publish' | 'unpublish', families: string[]) {
  const entries = families.map((family, index) => {
    const current =
      family === 'sfdc_cms__emailTemplate' || family === 'sfdc_cms__email'
        ? staticFixture()
        : mediaFixture(family);
    const suffix = String(index).padStart(3, '0');
    const parentId = `20Yaj00000Fa${suffix}EAF`;
    const id = `9Psaj00000J5${suffix}CAR`;
    const apiName = `Native_${index}`;
    const published = operation === 'unpublish';
    for (const row of [current.row, current.siblings[0]])
      Object.assign(row, {
        Id: id,
        ManagedContentId: parentId,
        ContentTypeFullyQualifiedName: family,
        IsPublished: published,
        ManagedContentVariantStatus: published ? 'Published' : 'Draft',
        ManagedContent: { AuthoredManagedContentSpaceId: workspaceId, ApiName: apiName },
      });
    for (const detail of [current.variant, current.parent])
      Object.assign(detail, {
        managedContentId: parentId,
        managedContentVariantId: id,
        apiName,
        contentType: { fullyQualifiedName: family },
        isPublished: published,
        status: {
          label: published ? 'Published' : 'Draft',
          status: published ? 'Published' : 'Draft',
        },
      });
    return current;
  });
  const dispatched: string[] = [];
  const connection = {
    accessToken: 'token',
    instanceUrl: 'https://source.example',
    version: '67.0',
    getApiVersion: () => '67.0',
    request: sinon.stub().callsFake(({ url, method }: { url: string; method?: string }) => {
      expect(method ?? 'GET').to.equal('GET');
      if (url.includes('/spaces/'))
        return batchResponse({ id: workspaceId, apiName: 'Marketing', defaultLanguage: 'en_US' });
      if (url.includes('/query?q=')) {
        const query = decodeURIComponent(url.split('?q=')[1]);
        const rows = entries
          .map((entry) => entry.row)
          .filter((row) =>
            query.includes('ManagedContentId =')
              ? query.includes(`ManagedContentId = '${row.ManagedContentId}'`)
              : query.includes(`'${row.ContentTypeFullyQualifiedName}'`),
          );
        let records: unknown[] = rows;
        if (query.includes('COUNT(Id)'))
          records = rows.map((row) => ({
            ManagedContentId: row.ManagedContentId,
            siblingCount: 1,
          }));
        else if (query.includes('AND Id >')) records = [];
        return batchResponse({ done: true, totalSize: records.length, records });
      }
      if (url.includes('/items/search'))
        return batchResponse({
          total: entries.filter(
            (entry) => entry.row.ContentTypeFullyQualifiedName === 'sfdc_cms__email',
          ).length,
          items: entries
            .filter((entry) => entry.row.ContentTypeFullyQualifiedName === 'sfdc_cms__email')
            .map((entry) => ({
              id: entry.row.Id,
              managedContentSpaceId: workspaceId,
              type: 'ManagedContentVariantSearchResultRepresentation',
            })),
        });
      const selected = entries.find(
        (entry) =>
          url.endsWith(`/variants/${entry.row.Id}`) ||
          url.endsWith(`/contents/${entry.row.ManagedContentId}`),
      );
      if (!selected) throw new Error(`Unexpected batch read ${url}`);
      return batchResponse(url.includes('/variants/') ? selected.variant : selected.parent);
    }),
  };
  const mutation = sinon.stub(JsforceConnection.prototype, 'request').callsFake((request) => {
    const payload = JSON.parse((request as { body: string }).body);
    const entry = entries.find(
      (value) =>
        (payload.variantIds ?? payload.contentIds)[0] ===
        (operation === 'publish' ? value.row.Id : value.row.ManagedContentId),
    )!;
    dispatched.push(entry.row.ManagedContent.ApiName!);
    expect(payload).to.deep.equal(
      operation === 'publish'
        ? {
            variantIds: [entry.row.Id],
            contextContentSpaceId: workspaceId,
            includeContentReferences: false,
          }
        : { contentIds: [entry.row.ManagedContentId] },
    );
    for (const row of [entry.row, entry.siblings[0]])
      Object.assign(row, {
        IsPublished: operation === 'publish',
        ManagedContentVariantStatus: operation === 'publish' ? 'Published' : 'Draft',
      });
    for (const detail of [entry.variant, entry.parent])
      Object.assign(detail, {
        isPublished: operation === 'publish',
        status: {
          label: operation === 'publish' ? 'Published' : 'Draft',
          status: operation === 'publish' ? 'Published' : 'Draft',
        },
      });
    return batchResponse({ deploymentId: `deployment-${dispatched.length}` });
  });
  sinon.stub(globalThis, 'fetch').callsFake(
    async () =>
      new Response(Buffer.from('Exact native bytes'), {
        headers: { 'content-type': 'image/png' },
      }),
  );
  // Keep the mixed-fixture download and authoring MIME receipt identical.
  for (const entry of entries)
    if (entry.row.ContentTypeFullyQualifiedName === 'sfdc_cms__audio')
      for (const detail of [entry.parent, entry.variant])
        (
          (detail.contentBody as Record<string, unknown>)['sfdc_cms:media'] as {
            source: { mimeType: string };
          }
        ).source.mimeType = 'image/png';
  return {
    connection,
    entries,
    dispatched,
    mutation,
    input: {
      operation,
      workspaceId,
      language: 'en_US',
      selectors: normalizeLifecycleMetadata(
        entries.map(
          (entry) =>
            `${entry.row.ContentTypeFullyQualifiedName}:${entry.row.ManagedContent.ApiName}`,
        ),
      ),
    },
  };
}

describe('qualified native metadata batch integration', () => {
  afterEach(() => {
    sinon.restore();
    process.exitCode = undefined;
  });
  for (const operation of ['publish', 'unpublish'] as const) {
    const families = [
      'sfdc_cms__email',
      'sfdc_cms__emailTemplate',
      'sfdc_cms__image',
      'sfdc_cms__document',
      'sfdc_cms__audio',
      'sfdc_cms__emailTemplate',
    ];
    for (const problem of [
      'none',
      'preflight',
      'pending',
      'completion',
      'progress',
      'drift',
    ] as const) {
      it(`${operation}: mixed five-family batch preserves ledger and report truth: ${problem}`, async () => {
        const current = batchFixture(operation, families);
        const run = await createRunOwnedTemp('cms-native-batch-');
        const writes: string[] = [];
        if (problem === 'preflight') current.entries[4].variant.contentKey = 'WRONG';
        const result = await runLifecycleMetadataBatch(current.connection, current.input, {
          mode: 'apply',
          reportDirectory: path.join(run.root, 'reports'),
          rewriteReport: async (file, data) => {
            const value = data as { state: string; completedPrefix?: number };
            if (
              (problem === 'pending' &&
                file.endsWith('target-000003.json') &&
                value.state === 'pending') ||
              (problem === 'completion' &&
                file.endsWith('target-000003.json') &&
                value.state === 'completed') ||
              (problem === 'progress' && value.completedPrefix === 3)
            )
              throw new Error('storage failed');
            if (value.state === 'pending' && file.includes('target-'))
              expect(current.dispatched).to.have.length(writes.length);
            await rewriteAtomic(file, data);
            if (value.state === 'completed' && file.includes('target-')) writes.push(file);
            if (problem === 'drift' && value.completedPrefix === 2)
              current.entries[2].variant.title = 'Changed';
          },
        });
        if (problem === 'none') {
          expect(result.status, JSON.stringify(result.result)).to.equal('success');
          expect(current.dispatched).to.deep.equal(families.map((_, index) => `Native_${index}`));
          for (const item of result.result.items.slice(1)) {
            if (item.result?.outcome !== 'completed') throw new Error('Expected completion');
            expect(item.result.evidence.nativeEvidence?.contentType).to.equal(
              item.selector.contentType,
            );
            const persisted = JSON.parse(await readFile(item.reportFile!, 'utf8'));
            expect(persisted.evidence.nativeEvidence.contentType).to.equal(
              item.selector.contentType,
            );
          }
          const aggregate = JSON.parse(await readFile(result.result.reportFile!, 'utf8'));
          expect(aggregate.completedPrefix).to.equal(6);
        } else if (problem === 'preflight') {
          expect(result.status).to.equal('blocked');
          expect(current.dispatched).to.deep.equal([]);
          expect(writes).to.deep.equal([]);
          expect(result.result).not.to.have.property('reportFile');
        } else {
          expect(result.status, JSON.stringify(result.result)).to.equal('partial');
          expect(result.result.items.map((item) => item.outcome)).to.deep.equal([
            'completed',
            'completed',
            ['pending', 'drift'].includes(problem) ? 'blocked' : 'ownership-uncertain',
            'unattempted',
            'unattempted',
            'unattempted',
          ]);
          expect(current.dispatched).to.have.length(['pending', 'drift'].includes(problem) ? 2 : 3);
          expect(
            JSON.parse(await readFile(result.result.reportFile!, 'utf8')).completedPrefix,
          ).to.equal(2);
        }
      });
    }
    for (const apply of [false, true]) {
      it(`${operation}: real metadata CLI adapter retains native evidence apply=${String(apply)}`, async () => {
        const current = batchFixture(operation, ['sfdc_cms__emailTemplate']);
        const run = await createRunOwnedTemp('cms-native-adapter-');
        const Command = operation === 'publish' ? PublishContent : UnpublishContent;
        const command = Object.create(Command.prototype) as PublishContent | UnpublishContent;
        Object.assign(command, {
          parse: async () => ({
            flags: {
              'target-org': { getUsername: () => 'org' },
              'api-version': '67.0',
              'workspace-id': workspaceId,
              metadata: ['emailTemplate:Native_0'],
              language: 'en_US',
              apply,
              'acknowledge-no-send': apply,
              'acknowledge-active-use-stops': apply,
              'report-dir': apply ? path.join(run.root, 'reports') : undefined,
            },
          }),
          getOrgContext: async () => ({ connection: current.connection, orgId: 'org' }),
          jsonEnabled: () => true,
        });
        const result = await command.run();
        expect(result.status, JSON.stringify(result.result)).to.equal('success');
        if (!result.result || !('selection' in result.result))
          throw new Error('Expected metadata batch');
        const nested = result.result.items[0].result;
        if (nested?.outcome !== 'ready' && nested?.outcome !== 'completed')
          throw new Error('Expected qualified native result');
        expect(nested.outcome).to.equal(apply ? 'completed' : 'ready');
        expect(nested.evidence.nativeEvidence?.contentType).to.equal('sfdc_cms__emailTemplate');
        expect(current.mutation.called).to.equal(apply);
      });
    }
  }
});

describe('native publish preparation routing and family ledger', () => {
  afterEach(() => sinon.restore());
  it('routes default-locale Template preparation to native checkpoints, never Email search', async () => {
    const current = staticFixture();
    const prepared = await prepareDraftEmailPublish(current.connection, {
      selector: { ...selection(current), language: undefined, useDefaultLanguage: true },
    });
    expect(prepared.evidence.nativeEvidence?.contentType).to.equal(selector.contentType);
    expect(prepared.inventoryBaseline[0].hash).to.equal(prepared.evidence.baselineHash);
    expect(prepared.evidence.apiVersion).to.equal('67.0');
    expect(current.calls.some((url) => url.includes('search'))).to.equal(false);
    const preview = await previewDraftEmailPublish(current.connection, input(current));
    expect(preview.status).to.equal('ready');
    for (const operation of [
      () => applyDraftEmailPublishWithReport(current.connection, input(current), 'not-created'),
    ]) {
      try {
        await operation();
        throw new Error('Expected closed execution');
      } catch (error) {
        expect((error as Error).message).to.include('execution admission is not enabled');
      }
    }
  });
  for (const contentType of ['sfdc_cms__image', 'sfdc_cms__document', 'sfdc_cms__audio']) {
    it(`prepares ${contentType} with its real binary receipt`, async () => {
      const current = mediaFixture(contentType);
      sinon
        .stub(globalThis, 'fetch')
        .callsFake(
          async () =>
            new Response(current.bytes, { headers: { 'content-type': current.mimeType } }),
        );
      const prepared = await prepareDraftEmailPublish(current.connection, input(current));
      expect(prepared.evidence.nativeEvidence?.mediaReceipt?.size).to.equal(current.bytes.length);
    });
  }
  for (const problem of ['none', 'authoring drift', 'identity', 'lifecycle', 'row drift']) {
    it(`binds unselected foreign-locale Published family detail: ${problem}`, async () => {
      const current = staticFixture();
      const otherId = '9Psaj00000J5oxKCAR';
      const otherParent = '20Yaj00000FaO1bEAF';
      const otherRow = {
        ...structuredClone(current.row),
        Id: otherId,
        ManagedContentId: otherParent,
        Language: 'de',
        IsPublished: true,
        ManagedContentVariantStatus: 'Published',
        ManagedContentKey: 'MCOTHER',
        ManagedContent: { ...current.row.ManagedContent, ApiName: 'Other_Template' },
      };
      current.rows.push(otherRow);
      const detail = {
        ...structuredClone(current.variant),
        managedContentId: otherParent,
        managedContentVariantId: otherId,
        apiName: 'Other_Template',
        language: 'de',
        contentKey: 'MCOTHER',
        isPublished: true,
        status: { label: 'Published', status: 'Published' },
      };
      let reads = 0;
      const request = current.connection.request.bind(current.connection);
      sinon.stub(current.connection, 'request').callsFake(((
        ...args: Parameters<typeof request>
      ) => {
        const url = (args[0] as { url: string }).url;
        if (!url.endsWith(`/variants/${otherId}`)) return request(...args);
        reads += 1;
        const result = structuredClone(detail);
        if (problem === 'authoring drift' && reads > 1) result.title = 'Changed body';
        if (problem === 'identity') result.contentKey = 'foreign';
        if (problem === 'lifecycle') result.isPublished = false;
        if (problem === 'row drift' && reads === 1) otherRow.Name = 'Changed summary';
        return Promise.resolve(result);
      }) as typeof request);
      const result = await previewDraftEmailPublish(current.connection, input(current));
      expect(result.status).to.equal(problem === 'none' ? 'ready' : 'blocked');
      if (result.status === 'ready') {
        expect(result.evidence.inventory).to.have.length(2);
        expect(result.evidence.inventory[1]).to.include({
          variantId: otherId,
          language: 'de',
          isPublished: true,
        });
        expect(result.evidence.inventory[1].hash).not.to.equal(result.evidence.baselineHash);
        expect(result.evidence.siblingInventory).to.have.length(1);
        const prepared = await prepareDraftEmailPublish(current.connection, input(current));
        const context = contextFor(prepared);
        detail.title = 'later';
        try {
          await refreshPreparedDraftEmailPublish(current.connection, prepared, context);
          throw new Error('Expected unselected detail drift');
        } catch (error) {
          expect((error as Error).name).to.equal('EmailPublishPreflightBlockedError');
        }
        const serialized = JSON.stringify(result.evidence);
        expect(JSON.parse(serialized)).to.deep.equal(result.evidence);
      }
    });
  }
});

const contextFor = (prepared: Awaited<ReturnType<typeof prepareDraftEmailPublish>>) => {
  const { inventory, siblingInventory, nativeEvidence, lifecycle, ...binding } = prepared.evidence;
  void siblingInventory;
  void nativeEvidence;
  void lifecycle;
  return { binding, expectedInventory: structuredClone(inventory) };
};

function publishedFixture(contentType = selector.contentType) {
  const current =
    contentType === selector.contentType ? staticFixture() : mediaFixture(contentType);
  for (const row of [current.row, current.siblings[0]]) {
    row.IsPublished = true;
    row.ManagedContentVariantStatus = 'Published';
  }
  for (const detail of [current.parent, current.variant]) {
    detail.isPublished = true;
    detail.status = { label: 'Published', status: 'Published' };
  }
  return current;
}

describe('native unpublish preparation and closed standalone execution', () => {
  afterEach(() => sinon.restore());
  for (const problem of ['none', 'authoring', 'identity', 'lifecycle', 'summary']) {
    it(`binds unselected native unpublish family detail: ${problem}`, async () => {
      const current = publishedFixture();
      const otherId = '9Psaj00000J5oxKCAR';
      const otherRow = {
        ...structuredClone(current.row),
        Id: otherId,
        ManagedContentId: '20Yaj00000FaO1bEAF',
        Language: 'de',
        ManagedContentKey: 'MCOTHER',
        ManagedContent: { ...current.row.ManagedContent, ApiName: 'Other_Template' },
      };
      current.rows.push(otherRow);
      const detail = {
        ...structuredClone(current.variant),
        managedContentId: otherRow.ManagedContentId,
        managedContentVariantId: otherId,
        apiName: 'Other_Template',
        language: 'de',
        contentKey: 'MCOTHER',
      };
      let reads = 0;
      const request = current.connection.request.bind(current.connection);
      sinon.stub(current.connection, 'request').callsFake(((
        ...args: Parameters<typeof request>
      ) => {
        if (!(args[0] as { url: string }).url.endsWith(`/variants/${otherId}`))
          return request(...args);
        reads += 1;
        const result = structuredClone(detail);
        if (problem === 'authoring' && reads > 1) result.title = 'changed';
        if (problem === 'identity') result.contentKey = 'wrong';
        if (problem === 'lifecycle') result.isPublished = false;
        if (problem === 'summary' && reads === 1) otherRow.Name = 'changed';
        return Promise.resolve(result);
      }) as typeof request);
      const preview = await previewPublishedEmailUnpublish(current.connection, input(current));
      expect(preview.status).to.equal(problem === 'none' ? 'ready' : 'blocked');
      if (problem === 'none') {
        const prepared = await preparePublishedEmailUnpublish(current.connection, input(current));
        const context = contextFor(prepared);
        const expected = structuredClone(context.expectedInventory);
        detail.title = 'later foreign-locale drift';
        try {
          await refreshPreparedPublishedEmailUnpublish(current.connection, prepared, context);
          throw new Error('Expected foreign detail rejection');
        } catch (error) {
          expect((error as Error).name).to.equal('EmailUnpublishPreflightBlockedError');
        }
        expect(context.expectedInventory).to.deep.equal(expected);
      }
    });
  }
  for (const family of [
    selector.contentType,
    'sfdc_cms__image',
    'sfdc_cms__document',
    'sfdc_cms__audio',
  ]) {
    it(`prepares and refreshes Published ${family}, with standalone execution closed`, async () => {
      const current = publishedFixture(family);
      if ('bytes' in current)
        sinon
          .stub(globalThis, 'fetch')
          .callsFake(
            async () =>
              new Response(current.bytes, { headers: { 'content-type': current.mimeType } }),
          );
      const request = {
        selector: { ...selection(current), language: undefined, useDefaultLanguage: true as const },
      };
      const prepared = await preparePublishedEmailUnpublish(current.connection, request);
      expect(prepared.evidence.nativeEvidence?.parentLifecycle.status.status).to.equal('Published');
      expect(prepared.evidence.siblingInventory).to.have.length(1);
      expect(prepared.evidence.apiVersion).to.equal('67.0');
      const context = contextFor(prepared);
      const refreshed = await refreshPreparedPublishedEmailUnpublish(
        current.connection,
        prepared,
        context,
      );
      expect(refreshed.evidence).to.deep.equal(prepared.evidence);
      const preview = await previewPublishedEmailUnpublish(current.connection, request);
      expect(preview.status).to.equal('ready');
      const writes = sinon.stub().resolves();
      const reads = current.calls.length;
      for (const operation of [
        () =>
          applyPublishedEmailUnpublishWithReport(current.connection, request, 'not-created', {
            rewriteReport: writes,
          }),
      ]) {
        try {
          await operation();
          throw new Error('Expected closed execution');
        } catch (error) {
          expect((error as Error).message).to.include('execution admission is not enabled');
        }
      }
      expect(writes.called).to.equal(false);
      expect(current.calls.length).to.equal(reads);
      expect(current.calls.some((url) => url.includes('search'))).to.equal(false);
    });
  }
  for (const problem of [
    'parent phase',
    'variant phase',
    'siblings',
    'references',
    'unsupported',
  ]) {
    it(`blocks native preparation: ${problem}`, async () => {
      const current = publishedFixture();
      if (problem === 'parent phase') current.parent.isPublished = false;
      if (problem === 'variant phase') current.variant.status = { label: 'Draft', status: 'Draft' };
      if (problem === 'siblings')
        current.siblings.push({ ...current.row, Id: '9Psaj00000J5oxKCAR' });
      if (problem === 'references') {
        const body = { rawHtml: '&lt;img src=&quot;https://foreign.example/image&quot;&gt;' };
        current.parent.contentBody = body;
        current.variant.contentBody = structuredClone(body);
      }
      if (problem === 'unsupported') current.selection.contentType = 'sfdc_cms__video';
      const preview = await previewPublishedEmailUnpublish(current.connection, input(current));
      expect(preview.status).to.equal('blocked');
    });
  }
  for (const problem of ['binding', 'ledger', 'body', 'receipt', 'caller mutation']) {
    it(`refresh preserves detached expectations: ${problem}`, async () => {
      const current = publishedFixture();
      const prepared = await preparePublishedEmailUnpublish(current.connection, input(current));
      const context = contextFor(prepared);
      if (problem === 'binding') context.binding.org = 'https://other.example';
      if (problem === 'ledger') context.expectedInventory[0].hash = 'wrong';
      if (problem === 'body') {
        current.parent.title = 'changed';
        current.variant.title = 'changed';
      }
      if (problem === 'receipt')
        Object.assign(prepared.evidence.nativeEvidence!, { references: [] });
      if (problem === 'caller mutation') {
        const request = current.connection.request.bind(current.connection);
        sinon.stub(current.connection, 'request').callsFake(((
          ...args: Parameters<typeof request>
        ) => {
          context.binding.org = 'https://mutated.example';
          context.expectedInventory[0].hash = 'mutated';
          return request(...args);
        }) as typeof request);
        await refreshPreparedPublishedEmailUnpublish(current.connection, prepared, context);
      } else {
        try {
          await refreshPreparedPublishedEmailUnpublish(current.connection, prepared, context);
          throw new Error('Expected drift rejection');
        } catch (error) {
          expect((error as Error).name).to.equal('EmailUnpublishPreflightBlockedError');
        }
      }
    });
  }
});

describe('native unpublish caller-ledger execution', () => {
  afterEach(() => sinon.restore());
  for (const problem of [
    'none',
    'image',
    'document',
    'audio',
    'delayed',
    'exhausted',
    'read error',
    'body',
    'identity',
    'references',
    'media',
    'binding',
    'unselected drift',
    'pending write',
    'completed write',
    'uncertain write',
    'dispatch error',
    'ledger',
    'fresh drift',
    'siblings',
    'mixed phase',
    'caller mutation',
  ]) {
    it(`preserves native unpublish ledger and uncertainty: ${problem}`, async () => {
      const mediaFamily = ['image', 'document', 'audio', 'media'].includes(problem);
      const family = mediaFamily
        ? `sfdc_cms__${problem === 'media' ? 'image' : problem}`
        : selector.contentType;
      const current = publishedFixture(family);
      let mediaChanged = false;
      if ('bytes' in current)
        sinon.stub(globalThis, 'fetch').callsFake(
          async () =>
            new Response(mediaChanged ? Buffer.from('wrong bytes') : current.bytes, {
              headers: { 'content-type': current.mimeType },
            }),
        );
      const otherId = '9Psaj00000J5oxKCAR';
      const otherRow = {
        ...structuredClone(current.row),
        Id: otherId,
        ManagedContentId: '20Yaj00000FaO1bEAF',
        Language: 'de',
        ManagedContentKey: 'MCOTHER',
        ManagedContent: { ...current.row.ManagedContent, ApiName: 'Other_Template' },
      };
      current.rows.push(otherRow);
      const otherDetail = {
        ...structuredClone(current.variant),
        managedContentVariantId: otherId,
        managedContentId: otherRow.ManagedContentId,
        language: 'de',
        apiName: 'Other_Template',
        contentKey: 'MCOTHER',
      };
      const originalRequest = current.connection.request.bind(current.connection);
      const details = sinon.stub(current.connection, 'request').callsFake(((
        ...args: Parameters<typeof originalRequest>
      ) => {
        if ((args[0] as { url: string }).url.endsWith(`/variants/${otherId}`))
          return Promise.resolve(otherDetail);
        return originalRequest(...args);
      }) as typeof originalRequest);
      const prepared = await preparePublishedEmailUnpublish(current.connection, input(current));
      details.restore();
      const context = contextFor(prepared);
      const callerLedger = structuredClone(context.expectedInventory);
      const run = await createRunOwnedTemp('cms-native-unpublish-');
      const writes: Array<Record<string, unknown>> = [];
      let mutations = 0;
      let postReads = 0;
      const draft = () => {
        for (const row of [current.row, current.siblings[0]]) {
          row.IsPublished = false;
          row.ManagedContentVariantStatus = 'Draft';
        }
        for (const detail of [current.parent, current.variant]) {
          detail.isPublished = false;
          detail.status = { label: 'Draft', status: 'Draft' };
        }
      };
      const request = current.connection.request.bind(current.connection);
      sinon.stub(current.connection, 'request').callsFake(((
        ...args: Parameters<typeof request>
      ) => {
        const { url, method, body } = args[0] as { url: string; method?: string; body?: string };
        if (method === 'POST') {
          mutations += 1;
          expect(writes[0].state).to.equal('pending');
          expect(JSON.parse(body!)).to.deep.equal({ contentIds: [contentId] });
          if (problem === 'dispatch error') throw new Error('ambiguous dispatch');
          if (!['delayed', 'exhausted'].includes(problem)) draft();
          if (problem === 'body') current.variant.title = current.parent.title = 'Changed';
          if (problem === 'identity') current.variant.contentKey = 'WRONG';
          if (problem === 'references')
            current.variant.contentBody = {
              rawHtml: '&lt;img src=&quot;https://foreign.example/a&quot;&gt;',
            };
          if (problem === 'media') mediaChanged = true;
          if (problem === 'unselected drift') otherDetail.title = 'Changed';
          if (problem === 'binding')
            Object.assign(current.connection, { instanceUrl: 'https://foreign.example' });
          if (problem === 'mixed phase') current.parent.isPublished = true;
          return Promise.resolve({ deploymentId: 'native-unpublish' });
        }
        if (
          mutations &&
          url.includes('/query?q=') &&
          decodeURIComponent(url).includes('COUNT(Id)') &&
          !decodeURIComponent(url).includes(`ManagedContentId = '${contentId}'`)
        ) {
          postReads += 1;
          if (['read error', 'uncertain write'].includes(problem)) throw new Error('read failed');
        }
        if (url.endsWith(`/variants/${otherId}`)) {
          const response = structuredClone(otherDetail);
          if (mutations && problem === 'delayed') draft();
          return Promise.resolve(response);
        }
        return request(...args);
      }) as typeof request);
      sinon.stub(JsforceConnection.prototype, 'request').callsFake((requestInput) =>
        Object.assign(current.connection.request(requestInput), {
          stream: () => new PassThrough(),
        }),
      );
      if (problem === 'ledger') context.expectedInventory = [];
      let result: Awaited<ReturnType<typeof executePreparedPublishedEmailUnpublish>> | undefined;
      let failure: unknown;
      try {
        result = await executePreparedPublishedEmailUnpublish(current.connection, prepared, {
          ...context,
          reportFile: path.join(run.root, 'unpublish.json'),
          rewriteReport: async (_file, report) => {
            const value = report as Record<string, unknown>;
            if (
              (problem === 'pending write' && value.state === 'pending') ||
              (problem === 'completed write' && value.state === 'completed') ||
              (problem === 'uncertain write' && value.state === 'ownership-uncertain')
            )
              throw new Error('persistence failed');
            writes.push(structuredClone(value));
            if (value.state === 'pending') {
              if (problem === 'fresh drift') current.variant.title = 'Changed';
              if (problem === 'siblings') current.siblings.push({ ...current.row, Id: otherId });
              if (problem === 'caller mutation') {
                context.binding.org = 'https://mutated.example';
                context.expectedInventory[0].hash = 'mutated';
              }
            }
          },
        });
      } catch (error) {
        failure = error;
      }
      expect(contextFor(prepared).expectedInventory).to.deep.equal(callerLedger);
      const preflight = ['pending write', 'ledger', 'fresh drift', 'siblings'].includes(problem);
      expect(mutations, String(failure)).to.equal(preflight ? 0 : 1);
      if (['none', 'image', 'document', 'audio', 'delayed', 'caller mutation'].includes(problem)) {
        expect(failure, String((failure as Error | undefined)?.cause)).to.equal(undefined);
        expect(result?.lifecycle).to.deep.equal({ isPublished: false, status: 'Draft' });
        expect(result?.nativeEvidence?.parentLifecycle.isPublished).to.equal(false);
        expect(result?.inventory).to.deep.equal(
          callerLedger.map((entry) => ({
            ...entry,
            ...(entry.variantId === variantId ? { isPublished: false, status: 'Draft' } : {}),
          })),
        );
        expect(writes.at(-1)?.state).to.equal('completed');
      } else {
        expect((failure as Error).name).to.equal(
          preflight ? 'EmailUnpublishPreflightBlockedError' : 'EmailUnpublishOutcomeUnknownError',
        );
        if (mutations) {
          expect(writes.at(-1)?.state).to.equal(
            problem === 'uncertain write' ? 'pending' : 'ownership-uncertain',
          );
          if (problem !== 'dispatch error')
            expect((failure as { deploymentId: string }).deploymentId).to.equal('native-unpublish');
        }
      }
      if (problem === 'exhausted') expect(postReads).to.equal(10);
      try {
        await executePreparedPublishedEmailUnpublish(current.connection, prepared, {
          ...context,
          reportFile: path.join(run.root, 'retry.json'),
        });
        throw new Error('Expected consumed preparation');
      } catch (error) {
        expect((error as Error).message).to.include('already been attempted');
      }
    });
  }
});

describe('native publish caller-ledger execution', () => {
  afterEach(() => sinon.restore());
  for (const problem of [
    'none',
    'delayed',
    'exhausted',
    'read error',
    'body',
    'binding',
    'pending write',
    'completed write',
    'uncertain write',
    'dispatch error',
    'unselected drift',
    'ledger',
  ]) {
    it(`preserves bounded single-attempt and persistence semantics: ${problem}`, async () => {
      const current = staticFixture();
      const otherId = '9Psaj00000J5oxKCAR';
      const otherRow = {
        ...structuredClone(current.row),
        Id: otherId,
        ManagedContentId: '20Yaj00000FaO1bEAF',
        Language: 'de',
        IsPublished: true,
        ManagedContentVariantStatus: 'Published',
        ManagedContentKey: 'MCOTHER',
        ManagedContent: { ...current.row.ManagedContent, ApiName: 'Other_Template' },
      };
      current.rows.push(otherRow);
      const otherDetail = {
        ...structuredClone(current.variant),
        managedContentVariantId: otherId,
        managedContentId: otherRow.ManagedContentId,
        language: 'de',
        apiName: 'Other_Template',
        contentKey: 'MCOTHER',
        isPublished: true,
        status: { label: 'Published', status: 'Published' },
      };
      const originalRequest = current.connection.request.bind(current.connection);
      const detailRequest = sinon.stub(current.connection, 'request').callsFake(((
        ...args: Parameters<typeof originalRequest>
      ) => {
        if ((args[0] as { url: string }).url.endsWith(`/variants/${otherId}`))
          return Promise.resolve(otherDetail);
        return originalRequest(...args);
      }) as typeof originalRequest);
      const prepared = await prepareDraftEmailPublish(current.connection, input(current));
      detailRequest.restore();
      const context = contextFor(prepared);
      const callerLedger = structuredClone(context.expectedInventory);
      const run = await createRunOwnedTemp('cms-native-publish-');
      let mutations = 0;
      let postReads = 0;
      const writes: Array<Record<string, unknown>> = [];
      const published = () => {
        for (const row of [current.row, current.siblings[0]]) {
          row.IsPublished = true;
          row.ManagedContentVariantStatus = 'Published';
        }
        for (const detail of [current.parent, current.variant]) {
          detail.isPublished = true;
          detail.status = { label: 'Published', status: 'Published' };
        }
      };
      const request = current.connection.request.bind(current.connection);
      sinon.stub(current.connection, 'request').callsFake(((
        ...args: Parameters<typeof request>
      ) => {
        const { url, method, body } = args[0] as { url: string; method?: string; body?: string };
        if (method === 'POST') {
          mutations += 1;
          expect(writes[0].state).to.equal('pending');
          expect(JSON.parse(body!)).to.deep.equal({
            variantIds: [variantId],
            contextContentSpaceId: workspaceId,
            includeContentReferences: false,
          });
          if (problem === 'dispatch error') throw new Error('ambiguous write');
          if (problem !== 'delayed' && problem !== 'exhausted') published();
          if (problem === 'body') current.variant.title = current.parent.title = 'Changed';
          if (problem === 'unselected drift') otherDetail.title = 'Changed unselected';
          if (problem === 'binding')
            Object.assign(current.connection, { instanceUrl: 'https://foreign.example' });
          return Promise.resolve({ deploymentId: 'native-deployment' });
        }
        if (
          mutations &&
          url.includes('/query?q=') &&
          decodeURIComponent(url).includes('COUNT(Id)') &&
          !decodeURIComponent(url).includes(`ManagedContentId = '${contentId}'`)
        ) {
          postReads += 1;
          if (problem === 'read error' || problem === 'uncertain write')
            throw new Error('read failed');
        }
        if (url.endsWith(`/variants/${otherId}`)) {
          const response = structuredClone(otherDetail);
          if (mutations && problem === 'delayed') published();
          return Promise.resolve(response);
        }
        return request(...args);
      }) as typeof request);
      sinon.stub(JsforceConnection.prototype, 'request').callsFake((requestInput) =>
        Object.assign(current.connection.request(requestInput), {
          stream: () => new PassThrough(),
        }),
      );
      if (problem === 'ledger') context.expectedInventory = [];
      let result: Awaited<ReturnType<typeof executePreparedDraftEmailPublish>> | undefined;
      let failure: unknown;
      try {
        result = await executePreparedDraftEmailPublish(current.connection, prepared, {
          ...context,
          reportFile: path.join(run.root, 'publish.json'),
          rewriteReport: async (_file, report) => {
            const value = report as Record<string, unknown>;
            if (
              (problem === 'pending write' && value.state === 'pending') ||
              (problem === 'completed write' && value.state === 'completed') ||
              (problem === 'uncertain write' && value.state === 'ownership-uncertain')
            )
              throw new Error('persistence failed');
            writes.push(structuredClone(value));
          },
        });
      } catch (error) {
        failure = error;
      }
      expect(contextFor(prepared).expectedInventory).to.deep.equal(callerLedger);
      expect(mutations, String(failure)).to.equal(
        ['pending write', 'ledger'].includes(problem) ? 0 : 1,
      );
      if (problem === 'none' || problem === 'delayed') {
        expect(failure, String((failure as Error | undefined)?.cause)).to.equal(undefined);
        expect(result?.lifecycle).to.deep.equal({ isPublished: true, status: 'Published' });
        expect(result?.nativeEvidence?.variantLifecycle.isPublished).to.equal(true);
        expect(result?.inventory).to.deep.equal(
          callerLedger.map((entry) => ({
            ...entry,
            ...(entry.variantId === variantId ? { isPublished: true, status: 'Published' } : {}),
          })),
        );
        expect(writes.at(-1)?.state).to.equal('completed');
      } else {
        expect((failure as Error).name).to.equal(
          ['pending write', 'ledger'].includes(problem)
            ? 'EmailPublishPreflightBlockedError'
            : 'EmailPublishOutcomeUnknownError',
        );
        if (mutations)
          expect(writes.at(-1)?.state).to.equal(
            problem === 'uncertain write' ? 'pending' : 'ownership-uncertain',
          );
      }
      if (problem === 'exhausted') expect(postReads).to.equal(10);
      try {
        await executePreparedDraftEmailPublish(current.connection, prepared, {
          ...context,
          reportFile: path.join(run.root, 'retry.json'),
        });
        throw new Error('Expected consumed preparation');
      } catch (error) {
        expect((error as Error).message).to.include('already been attempted');
      }
    });
  }
});

describe('native publish predispatch refresh', () => {
  afterEach(() => sinon.restore());
  for (const problem of ['none', 'binding', 'ledger', 'body', 'lifecycle', 'receipt']) {
    it(`refreshes against detached full-family dispatch expectations: ${problem}`, async () => {
      const current = staticFixture();
      const prepared = await prepareDraftEmailPublish(current.connection, input(current));
      const context = contextFor(prepared);
      if (problem === 'binding') context.binding.org = 'https://foreign.example';
      if (problem === 'ledger') context.expectedInventory = [];
      if (problem === 'receipt') prepared.evidence.nativeEvidence!.references = [];
      if (problem === 'body') {
        current.parent.title = 'Changed';
        current.variant.title = 'Changed';
      }
      if (problem === 'lifecycle') current.parent.isPublished = true;
      try {
        const fresh = await refreshPreparedDraftEmailPublish(current.connection, prepared, context);
        expect(problem).to.equal('none');
        expect(fresh.evidence).to.deep.equal(prepared.evidence);
      } catch (error) {
        expect(problem).not.to.equal('none');
        expect((error as Error).name).to.equal('EmailPublishPreflightBlockedError');
      }
      expect(current.calls.some((url) => url.includes('search'))).to.equal(false);
    });
  }
  it('does not let caller mutation during fresh reads replace the captured native receipt', async () => {
    const current = staticFixture();
    const prepared = await prepareDraftEmailPublish(current.connection, input(current));
    const context = contextFor(prepared);
    // A forged baseline must remain rejected even if caller code repairs it while reads yield.
    const actual = structuredClone(prepared.evidence.nativeEvidence!);
    prepared.evidence.nativeEvidence!.mediaReceipt = {
      sha256: '0'.repeat(64),
      size: 1,
      mimeType: 'image/png',
    };
    const request = current.connection.request.bind(current.connection);
    sinon.stub(current.connection, 'request').callsFake(((...args: Parameters<typeof request>) => {
      Object.assign(prepared.evidence.nativeEvidence!, actual, { mediaReceipt: undefined });
      context.binding.org = 'https://foreign.example';
      context.expectedInventory = [];
      return request(...args);
    }) as typeof request);
    try {
      await refreshPreparedDraftEmailPublish(current.connection, prepared, context);
      throw new Error('Expected captured receipt rejection');
    } catch (error) {
      expect((error as Error).name).to.equal('EmailPublishPreflightBlockedError');
      expect((error as Error).message).to.include('drifted');
    }
  });
});

describe('read-only native publish checkpoints (execution admission closed)', () => {
  afterEach(() => sinon.restore());
  it('acquires detached static preparation and fresh receipts', async () => {
    const current = staticFixture();
    const baseline = await checkpoint(current);
    const fresh = await acquireNativePublishCheckpoint(
      current.connection,
      selection(current),
      'Draft',
      baseline,
    );
    expect(fresh).to.deep.equal(baseline);
    current.variant.title = 'later';
    expect(fresh.canonicalAuthoringHash).to.equal(baseline.canonicalAuthoringHash);
  });
  for (const location of ['parent', 'variant'] as const) {
    it(`rejects ${location} lifecycle disagreement`, async () => {
      const current = staticFixture();
      current[location].isPublished = true;
      await rejected(checkpoint(current), /lifecycle/u);
    });
  }
  it('rejects authoring drift between otherwise valid checkpoints', async () => {
    const current = staticFixture();
    const baseline = await checkpoint(current);
    current.parent.title = 'changed';
    current.variant.title = 'changed';
    await rejected(
      acquireNativePublishCheckpoint(current.connection, selection(current), 'Draft', baseline),
      /integrity drifted/u,
    );
  });
  it('rejects references introduced after preparation', async () => {
    const current = staticFixture();
    const baseline = await checkpoint(current);
    current.parent.references = ['foreign'];
    await rejected(
      acquireNativePublishCheckpoint(current.connection, selection(current), 'Draft', baseline),
      /self identity reference/u,
    );
  });
  for (const contentType of ['sfdc_cms__image', 'sfdc_cms__document', 'sfdc_cms__audio']) {
    it(`compares ${contentType} binary receipts without taking ledger ownership`, async () => {
      const current = mediaFixture(contentType);
      sinon
        .stub(globalThis, 'fetch')
        .callsFake(
          async () =>
            new Response(current.bytes, { headers: { 'content-type': current.mimeType } }),
        );
      const baseline = await checkpoint(current);
      expect(baseline.mediaReceipt?.sha256).to.equal(
        createHash('sha256').update(current.bytes).digest('hex'),
      );
      const changed = structuredClone(baseline);
      changed.mediaReceipt!.sha256 = '0'.repeat(64);
      await rejected(
        acquireNativePublishCheckpoint(current.connection, selection(current), 'Draft', changed),
        /integrity drifted/u,
      );
      expect(baseline.mediaReceipt?.sha256).not.to.equal(changed.mediaReceipt!.sha256);
    });
  }
});

describe('bounded native lifecycle integrity (no public wiring)', () => {
  afterEach(() => sinon.restore());
  it('accepts safe static Template with exactly its included identity and native status object', async () => {
    const current = staticFixture();
    const result = await acquireLifecycleNativeSnapshot(current.connection, current.selection);
    expect(result.references).to.have.length(1);
    expect(result.references[0]).to.include({
      kind: 'cms.content',
      resolution: 'included',
      required: true,
    });
    expect(result.variantLifecycle.status).to.deep.equal({ label: 'Draft label', status: 'Draft' });
    expect(result).not.to.have.property('mediaReceipt');
    const serialized = JSON.stringify(result);
    expect(JSON.parse(serialized)).to.deep.equal(result);
  });
  for (const key of [
    'lightning:dataProviders',
    'lightning:expressions',
    'sfdc_cms:attachments',
    'sfdc_cms:variants',
  ]) {
    it(`rejects static ${key}`, async () => {
      const current = staticFixture();
      for (const detail of [current.variant, current.parent])
        (detail.contentBody as Record<string, unknown>)[key] = [{}];
      await integrityFailure(current, /Unsupported native body/u);
    });
  }
  for (const rawHtml of [
    '&lt;img src=&quot;x&quot;&gt;',
    '{{expression}}',
    '&amp;#37;&amp;#37;unsafe',
  ]) {
    it(`rejects unsafe raw HTML ${rawHtml}`, async () => {
      const current = staticFixture();
      for (const detail of [current.variant, current.parent])
        (detail.contentBody as Record<string, unknown>).rawHtml = rawHtml;
      await integrityFailure(current, /Unsafe native lifecycle/u);
    });
  }
  for (const field of ['references', 'referencesList', 'externalId', 'externalSource', 'source']) {
    it(`rejects foreign relationships/provider ${field}`, async () => {
      const current = staticFixture();
      current.parent[field] = 'foreign';
      await integrityFailure(current, /self identity reference|External provider/u);
    });
  }
  it('rejects content-body CMS references and foreign identity', async () => {
    const current = staticFixture();
    for (const detail of [current.variant, current.parent])
      (detail.contentBody as Record<string, unknown>).reference = {
        ref: { contentKey: 'foreign' },
      };
    await integrityFailure(current, /self identity reference/u);
    current.variant.contentKey = 'foreign';
    await integrityFailure(current, /identity/u);
  });
  for (const contentType of ['sfdc_cms__image', 'sfdc_cms__document', 'sfdc_cms__audio']) {
    it(`receipts exact ${contentType} bytes as JSON only`, async () => {
      const current = mediaFixture(contentType);
      sinon
        .stub(globalThis, 'fetch')
        .callsFake(
          async () =>
            new Response(current.bytes, { headers: { 'content-type': current.mimeType } }),
        );
      const result = await acquireLifecycleNativeSnapshot(current.connection, current.selection);
      expect(result.mediaReceipt).to.deep.equal({
        sha256: createHash('sha256').update(current.bytes).digest('hex'),
        size: current.bytes.length,
        mimeType: current.mimeType,
      });
      const serialized = JSON.stringify(result);
      expect(JSON.parse(serialized)).to.deep.equal(result);
      expect(JSON.stringify(result)).not.to.include('"type":"Buffer"');
    });
  }
  for (const problem of ['changed bytes', 'size', 'hash', 'missing download', 'URL-only', 'MIME']) {
    it(`rejects media ${problem} even with unchanged parent/variant bodies`, async () => {
      const current = mediaFixture();
      if (problem === 'size' || problem === 'hash' || problem === 'URL-only') {
        for (const detail of [current.variant, current.parent]) {
          const media = (detail.contentBody as Record<string, unknown>)['sfdc_cms:media'] as {
            source: { size: number; fileSize: number };
            url: string;
          };
          if (problem === 'size') {
            media.source.size += 1;
            media.source.fileSize += 1;
          } else if (problem === 'hash')
            media.url = media.url.replace(
              /fileHash=[^&]+/u,
              'fileHash=00000000000000000000000000000000',
            );
          else media.url = 'https://external.example/native.png';
        }
      }
      sinon.stub(globalThis, 'fetch').callsFake(async () => {
        if (problem === 'missing download') throw new Error('missing download');
        return new Response(
          problem === 'changed bytes' ? Buffer.from('Changed same bytes') : current.bytes,
          { headers: { 'content-type': problem === 'MIME' ? 'text/plain' : current.mimeType } },
        );
      });
      await integrityFailure(
        current,
        /byte|size|MD5|hash|download|binary|MIME|mime|content.type/iu,
      );
    });
  }
  it('rejects native snapshot drift during the binary download', async () => {
    const current = mediaFixture();
    sinon.stub(globalThis, 'fetch').callsFake(async () => {
      current.variant.title = 'Changed during download';
      current.parent.title = 'Changed during download';
      return new Response(current.bytes, { headers: { 'content-type': current.mimeType } });
    });
    await integrityFailure(current, /changed during integrity/u);
  });
  for (const problem of ['language', 'primary']) {
    it(`retains Audio ${problem} restrictions`, async () => {
      const current = mediaFixture('sfdc_cms__audio');
      if (problem === 'language') current.workspace.defaultLanguage = 'de';
      else {
        current.row.IsPrimary = false;
        current.siblings[0].IsPrimary = false;
      }
      await integrityFailure(current, /workspace-default language/u);
    });
  }
});

describe('native lifecycle identity groundwork (not authoring admission)', () => {
  it('returns detached identity, native parent/variant status objects and canonical authoring hash', async () => {
    const current = fixture();
    current.parent.status = { label: 'Published label', status: 'Published' };
    current.parent.isPublished = true;
    const result = await acquireLifecycleNativeIdentitySnapshot(
      current.connection,
      current.selection,
    );
    expect(result.identity).to.deep.equal({
      ...selector,
      contentId,
      variantId,
      contentKey: 'MCNATIVE',
    });
    expect(result.parentLifecycle.status.status).to.equal('Published');
    expect(result.variantLifecycle.status).to.deep.equal({ label: 'Draft label', status: 'Draft' });
    const expected = {
      apiName: selector.apiName,
      contentBody: { rawHtml: '&lt;p&gt;Native&lt;/p&gt;' },
      title: 'Native template',
      urlName: 'native',
    };
    expect(result.canonicalAuthoringHash).to.equal(
      createHash('sha256').update(JSON.stringify(expected)).digest('hex'),
    );
    expect(result.family.complete).to.equal(true);
    expect(result.siblings.complete).to.equal(true);
    current.variant.title = 'changed';
    current.row.Name = 'changed';
    expect(result.variant.title).to.equal('Native template');
    expect(result.family.records[0].Name).to.equal('Native template');
    const queries = current.calls
      .filter((url) => url.includes('/query?q='))
      .map((url) => decodeURIComponent(url.split('?q=')[1]));
    const siblingQueries = queries.filter((query) =>
      query.includes(`ManagedContentId = '${contentId}'`),
    );
    expect(siblingQueries).to.have.length(6);
    for (const query of siblingQueries)
      expect(query.split(' WHERE ')[1]).not.to.match(
        /ContentTypeFullyQualifiedName|Language|IsPublished|ManagedContentVariantStatus/u,
      );
  });
  it('rejects hidden foreign-language/type siblings without narrowing native enumeration', async () => {
    const current = fixture();
    current.siblings.push({
      ...current.row,
      Id: '9Psaj00000J5oxKCAR',
      Language: 'de',
      ContentTypeFullyQualifiedName: 'sfdc_cms__other',
    });
    await fails(current, 'single-variant');
  });
  it('does not impose the new single-variant restriction on Email or wire legacy services', async () => {
    const current = fixture('sfdc_cms__email');
    current.siblings.push({ ...current.row, Id: '9Psaj00000J5oxKCAR', Language: 'de' });
    const result = await acquireLifecycleNativeIdentitySnapshot(
      current.connection,
      current.selection,
    );
    expect(result.siblings.records).to.have.length(2);
  });
  for (const field of [
    'managedContentId',
    'managedContentVariantId',
    'apiName',
    'language',
    'contentKey',
  ]) {
    it(`rejects foreign native ${field}`, async () => {
      const current = fixture();
      current.variant[field] = 'foreign';
      await fails(current, 'identity');
    });
  }
  for (const field of ['contentSpace', 'contentType']) {
    it(`rejects foreign ${field}`, async () => {
      const current = fixture();
      current.parent[field] = { id: 'foreign', fullyQualifiedName: 'foreign' };
      await fails(current, 'identity');
    });
  }
  it('rejects summary string statuses and inventory lifecycle disagreement', async () => {
    const current = fixture();
    current.variant.status = 'Draft';
    await fails(current, 'native label/status');
    current.variant.status = { label: 'Published', status: 'Published' };
    await fails(current, 'lifecycle disagrees');
  });
  it('rejects parent authoring drift', async () => {
    const current = fixture();
    current.parent.title = 'changed';
    await fails(current, 'parent authoring');
  });
  it('rejects absent and duplicate selector matches, sibling drift and unsupported families', async () => {
    const absent = fixture();
    absent.selection.apiName = 'Absent';
    await fails(absent, 'selector match');
    const duplicate = fixture();
    duplicate.rows.push({ ...duplicate.row, Id: '9Psaj00000J5oxKCAR' });
    await fails(duplicate, 'selector match');
    const drift = fixture();
    drift.siblings[0].Name = 'drift';
    await fails(drift, 'sibling evidence');
    await fails(fixture('sfdc_cms__other'), 'Unsupported');
  });
});
