import { expect } from 'chai';
import { createHash } from 'node:crypto';
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import sinon from 'sinon';
import { writeEditableRawHtml } from '../../src/services/editable-raw-html-export.js';
import type { WorkspaceImportRunReport } from '../../src/services/import-workspace.js';
import { planImportIdentities, safeNativeRawHtml } from '../../src/services/import-identities.js';
import { inventoryExportReferences } from '../../src/services/export-references.js';
import {
  executeWorkspaceImport,
  loadWorkspaceExport,
  planWorkspaceImport,
  rewriteAtomic,
  WorkspaceImportOwnershipUncertainError,
  type LoadedWorkspaceExport,
} from '../../src/services/import-workspace.js';

type FakeRequest<T> = Promise<T> & { stream(): PassThrough };

function fakeRequest<T>(value: T): FakeRequest<T> {
  return Object.assign(Promise.resolve(value), { stream: () => new PassThrough() });
}

function failedRequest(statusCode: number, message = 'request failed'): FakeRequest<never> {
  return Object.assign(Promise.reject(Object.assign(new Error(message), { statusCode })), {
    stream: () => new PassThrough(),
  });
}

function item(id: string, language = 'en', contentKey = 'key', overrides = {}) {
  return {
    apiName: 'api_name',
    contentBody: { body: `${language} body` },
    contentKey,
    contentSpace: { id: 'source-space' },
    contentType: 'sfdc_cms__news',
    externalId: 'external-id',
    externalSource: { source: 'migration' },
    id,
    language,
    serverOwned: 'strip-me',
    title: `${language} title`,
    urlName: `${language}-title`,
    ...overrides,
  };
}

function unnamedItem(id: string, language = 'en', contentKey = 'key', overrides = {}) {
  const value = item(id, language, contentKey, overrides);
  return Object.fromEntries(
    Object.entries(value).filter(([key]) => key !== 'apiName' && key !== 'urlName'),
  ) as ReturnType<typeof item>;
}

function referenceId(sourceId: string): string {
  return `ref:${createHash('sha256')
    .update(JSON.stringify({ kind: 'cms.content', sourceId, workspaceId: 'source-space' }))
    .digest('hex')}`;
}

function manifest(
  exportedItems: readonly ReturnType<typeof item>[],
  itemBytes: ReadonlyMap<string, string>,
  overrides = {},
) {
  const ids = exportedItems.map(({ id }) => id);
  const contentReferences = new Map<string, ReturnType<typeof item>>();
  for (const exportedItem of exportedItems)
    contentReferences.set(exportedItem.contentKey, exportedItem);
  const externalReferences = [...contentReferences.values()]
    .map((exportedItem) => ({
      referenceId: referenceId(exportedItem.contentKey),
      owner: 'cms',
      kind: 'cms.content',
      source: { workspaceId: 'source-space', sourceId: exportedItem.contentKey },
      portableKey: { scheme: 'cms-opaque-v1', value: exportedItem.contentKey },
      required: true,
      resolution: 'included',
    }))
    .toSorted((left, right) => left.referenceId.localeCompare(right.referenceId));
  return {
    entries: ids.map((variantId) => ({ file: `items/${variantId}.json`, variantId })),
    expectedCount: ids.length,
    exportedCount: ids.length,
    failedVariantIds: [],
    foundCount: ids.length,
    mode: 'experimental-best-effort',
    pagesRequested: 1,
    rejectedVariantIds: [],
    schemaVersion: 1,
    search: {
      contentSpaceOrFolderIds: ['source-space'],
      languages: ['All'],
      pageSize: 250,
      queryTerm: '*',
    },
    warnings: [{ code: 'UNSUPPORTED_WILDCARD', message: 'provenance only' }],
    workspaceId: 'source-space',
    contract: 'sf-cms-workspace-export',
    contractVersion: '1.0.0',
    provenance: {
      producer: 'sf-plugin-cms',
      sourceOrgId: '00D-source',
      sourceWorkspaceId: 'source-space',
      pluginVersion: '0.3.0',
      generatedAt: '2026-09-13T18:00:00.000Z',
    },
    completeness: 'complete',
    dependencies: [],
    externalReferences,
    items: ids.map((id) => ({
      path: `items/${id}.json`,
      sha256: createHash('sha256')
        .update(itemBytes.get(id) ?? '')
        .digest('hex'),
      kind: 'cms.content',
      referenceId: referenceId(exportedItems.find((value) => value.id === id)!.contentKey),
    })),
    ...overrides,
  };
}

async function writeExport(
  root: string,
  items: readonly ReturnType<typeof item>[],
  manifestOverrides = {},
  rawOverrides = {},
) {
  const source = path.join(root, 'source');
  await mkdir(path.join(source, 'items'), { recursive: true });
  const itemBytes = new Map<string, string>();
  for (const value of items) {
    const bytes = `${JSON.stringify({ ...value, ...rawOverrides })}\n`;
    itemBytes.set(value.id, bytes);
    await writeFile(path.join(source, 'items', `${value.id}.json`), bytes);
  }
  await writeFile(
    path.join(source, 'manifest.json'),
    `${JSON.stringify(manifest(items, itemBytes, manifestOverrides))}\n`,
  );
  return source;
}

function workspace(defaultLanguage = 'en') {
  return { defaultLanguage, id: 'destination-space', rootFolderId: 'root-folder' };
}

async function expectRejected(promise: Promise<unknown>): Promise<void> {
  let failure: unknown;
  try {
    await promise;
  } catch (error) {
    failure = error;
  }
  expect(failure, 'expected rejection').to.be.instanceOf(Error);
}

function requestRouter(
  options: { childFailure?: boolean; conflict?: boolean; lookupStatus?: number } = {},
) {
  let createdParents = 0;
  return sinon.stub().callsFake((request: { body?: string; method: string; url: string }) => {
    const { method, url } = request;
    if (method === 'GET') {
      if (options.conflict)
        return fakeRequest({ contentKey: decodeURIComponent(url.split('/').at(-1) ?? '') });
      return failedRequest(options.lookupStatus ?? 404);
    }
    const body = JSON.parse(request.body ?? '{}') as Record<string, unknown>;
    if (url.endsWith('/variants')) {
      if (options.childFailure) return failedRequest(500, 'child failed');
      return fakeRequest({ id: `child-${String(body.language)}` });
    }
    createdParents += 1;
    return fakeRequest({
      contentKey: body.contentKey,
      id: `content-${createdParents}`,
      primaryVariantId: `primary-${createdParents}`,
    });
  });
}

function nativeItem(type = 'sfdc_cms__email', overrides = {}) {
  return item('source-variant', 'en', 'key', {
    contentType: type,
    externalId: null,
    externalSource: null,
    contentBody: {
      'sfdc_cms:title': 'Body title',
      subjectLine: 'Subject',
      messagePurpose: 'promotional',
      rawHtml: '<p>Static body</p>',
      textContent: 'Static body',
      ...overrides,
    },
  });
}

function liveNativeBody(type: string, rawHtml: string) {
  return {
    'sfdc_cms:title': 'Live body title',
    'sfdc_cms:description': 'Live description',
    subjectLine: 'Live subject',
    preheader: 'Live preheader',
    messagePurpose: 'promotional',
    rawHtml,
    textContent: 'Café & ordinary text',
    backgroundColor: '#ffffff',
    'lightning:dataProviders': [],
    'lightning:expressions': [],
    'sfdc_cms:attachments': [],
    'sfdc_cms:variants': [],
    'lightning:backgroundImage': {
      repeat: 'no-repeat',
      position: 'center center',
      size: 'cover',
    },
    ...(type === 'sfdc_cms__email'
      ? {
          'sfdc_cms:urlName': 'en-title',
          'lightning:brandSource': { defaultBrandOption: 'sfdcBrand' },
        }
      : {}),
  };
}

describe('native raw-HTML workspace copy', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'cms-native-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const mapping = [
    { sourceContentKey: 'key', language: 'en', apiName: 'fresh_api', urlName: 'fresh-url' },
  ];

  for (const type of ['sfdc_cms__email', 'sfdc_cms__emailTemplate']) {
    it(`dry-runs the exact live-like ${type} shape with benign rawHtml entities`, async () => {
      const rawHtml =
        '<!doctype html><html><body><p>Café &amp; tea &lt;tag&gt; &#169; &#x2603;</p></body></html>';
      const contentBody = liveNativeBody(type, rawHtml);
      const sourceDirectory = await writeExport(root, [nativeItem(type, contentBody)]);
      const request = sinon.stub();

      const result = await executeWorkspaceImport({
        connection: { request },
        destinationOrgId: 'org',
        destinationWorkspace: workspace(),
        dryRun: true,
        sourceDirectory,
        workspaceId: 'destination-space',
        nativeCopyMappings: mapping,
      });

      expect(request.notCalled).to.equal(true);
      expect(result.plan.groups[0].primary.contentBody).to.deep.equal({
        ...contentBody,
        ...(type === 'sfdc_cms__email' ? { 'sfdc_cms:urlName': 'fresh-url' } : {}),
      });
      expect(result.plan.groups[0].primary.contentBody.rawHtml).to.equal(rawHtml);
    });
  }

  for (const [name, rawHtml] of [
    ['numeric-encoded media', '&#60;img src=&#34;bad&#34;&#62;'],
    ['semicolonless decimal-encoded media', '&#60img src=&#34bad&#34&#62'],
    ['semicolonless hexadecimal-encoded media', '&#x3cimg src=&#x22bad&#x22&#x3e'],
    ['entity-encoded dynamic marker', '&#123;&#123;dynamic&#125;&#125;'],
    ['standard named dynamic marker aliases', '&lcub;&lcub;dynamic&rcub;&rcub;'],
    ['semicolonless named dynamic marker', '&lbrace&lbrace dynamic&rbrace&rbrace'],
    ['named-entity encoded CMS URL', 'cms&colon;&sol;&sol;asset'],
    ['semicolonless named CMS URL', 'cms&colon&sol&sol asset'],
    ['nested entity encoding', '&amp;amp;amp;lt;img src=bad&amp;amp;amp;gt;'],
    ['literal media', '<img src="bad">'],
  ] as const) {
    it(`retains scanner rejection for future Phase 8: ${name}`, () => {
      expect(safeNativeRawHtml(rawHtml)).to.equal(false);
    });

    it(`temporarily bypasses scanner for opaque ${name} byte-for-byte in native dry-run`, async () => {
      const sourceDirectory = await writeExport(root, [nativeItem('sfdc_cms__email', { rawHtml })]);
      const request = sinon.stub();

      const result = await executeWorkspaceImport({
        connection: { request },
        destinationOrgId: 'org',
        destinationWorkspace: workspace(),
        dryRun: true,
        sourceDirectory,
        workspaceId: 'destination-space',
        nativeCopyMappings: mapping,
      });

      expect(request.notCalled).to.equal(true);
      expect(result.plan.groups[0].primary.contentBody.rawHtml).to.equal(rawHtml);
    });
  }

  for (const [name, body] of [
    ['metadata entity', { preheader: 'Café &amp; tea' }],
    ['metadata named dynamic marker', { preheader: '&lbrace;&lbrace;dynamic' }],
    ['metadata named CMS URL', { preheader: 'cms&colon;&sol;&sol;asset' }],
    ['unknown key', { unsupportedMetadata: 'value' }],
  ] as const) {
    it(`rejects ${name} through native dry-run planning`, async () => {
      const sourceDirectory = await writeExport(root, [nativeItem('sfdc_cms__email', body)]);
      const request = sinon.stub();

      await expectRejected(
        executeWorkspaceImport({
          connection: { request },
          destinationOrgId: 'org',
          destinationWorkspace: workspace(),
          dryRun: true,
          sourceDirectory,
          workspaceId: 'destination-space',
          nativeCopyMappings: mapping,
        }),
      );

      expect(request.notCalled).to.equal(true);
    });
  }
  for (const [name, body] of [
    ['empty rawHtml', { rawHtml: '' }],
    ['non-string rawHtml', { rawHtml: 42 }],
    ['empty required metadata', { subjectLine: '' }],
    ['non-string required metadata', { messagePurpose: false }],
    ['non-empty provider array', { 'lightning:dataProviders': [{ definition: 'provider' }] }],
    ['non-empty expression array', { 'lightning:expressions': ['expression'] }],
    ['non-empty attachment array', { 'sfdc_cms:attachments': ['attachment'] }],
    ['non-empty variant array', { 'sfdc_cms:variants': ['variant'] }],
    ['unsupported background image', { 'lightning:backgroundImage': { source: '/media' } }],
    ['unsupported brand source', { 'lightning:brandSource': { defaultBrandOption: 'custom' } }],
  ] as const) {
    it(`rejects ${name} through native dry-run planning`, async () => {
      const sourceDirectory = await writeExport(root, [nativeItem('sfdc_cms__email', body)]);
      const request = sinon.stub();

      await expectRejected(
        executeWorkspaceImport({
          connection: { request },
          destinationOrgId: 'org',
          destinationWorkspace: workspace(),
          dryRun: true,
          sourceDirectory,
          workspaceId: 'destination-space',
          nativeCopyMappings: mapping,
        }),
      );

      expect(request.notCalled).to.equal(true);
    });
  }

  for (const html of [
    '&lt;p&gt;literal text&lt;/p&gt;',
    '<p>Edited Grüße</p>\r\n',
    '<p>Static body</p>',
  ]) {
    it(`journals exact literal edited sidecar without decoding again: ${html}`, async () => {
      const items = [nativeItem(), { ...nativeItem(), id: 'other-variant', language: 'fr' }];
      const sourceDirectory = await writeExport(root, items);
      const loadedSource = await loadWorkspaceExport(sourceDirectory);
      const before = JSON.stringify(loadedSource);
      const editableDirectory = path.join(root, 'editable');
      await writeEditableRawHtml(
        items.map((raw) => ({ variantId: raw.id, raw })),
        loadedSource.manifestSha256,
        editableDirectory,
      );
      await writeFile(path.join(editableDirectory, 'items/source-variant.html'), html);
      await writeFile(
        path.join(editableDirectory, 'items/other-variant.html'),
        '<p>Unselected edit</p>',
      );
      const metadataBefore = await readFile(
        path.join(editableDirectory, 'items/source-variant.json'),
      );
      const reportDirectory = path.join(root, 'report');
      let posted: Record<string, unknown> = {};
      let initial: WorkspaceImportRunReport | undefined;
      const request = sinon
        .stub()
        .callsFake(async ({ method, body }: { method: string; body?: string }) => {
          if (method === 'POST') {
            posted = JSON.parse(body!) as Record<string, unknown>;
            const journal = JSON.parse(
              await readFile(path.join(reportDirectory, 'workspace-import-run.json'), 'utf8'),
            ) as WorkspaceImportRunReport;
            expect(journal).to.deep.equal(initial);
            expect(journal.operations).to.have.length(1);
            expect(journal.operations[0].state).to.equal('pending');
            const identity = `create-parent\u0000key\u0000en\u0000${JSON.stringify(posted)}`;
            expect(journal.operations[0].requestIdentity).to.equal(identity);
            expect(journal.operations[0].requestSha256).to.equal(
              createHash('sha256').update(identity).digest('hex'),
            );
            expect(journal.editableSource?.entries).to.have.length(2);
            expect(journal.editableSource?.sourceManifestSha256).to.equal(
              loadedSource.manifestSha256,
            );
            expect(
              journal.editableSource?.entries.every(
                (entry) =>
                  entry.originalHtmlSha256 ===
                  createHash('sha256').update('<p>Static body</p>').digest('hex'),
              ),
            ).to.equal(true);
            expect(
              journal.editableSource?.entries.find((entry) => entry.variantId === 'source-variant'),
            ).to.include({
              currentHtmlSha256: createHash('sha256').update(html).digest('hex'),
              changed: html !== '<p>Static body</p>',
            });
            return {
              contentKey: 'generated',
              managedContentId: 'target-id',
              managedContentVariantId: 'target-variant',
            };
          }
          return {
            ...posted,
            contentKey: 'generated',
            managedContentId: 'target-id',
            contentSpace: { id: 'destination-space' },
            language: 'en',
            isPublished: false,
            status: { status: 'Draft' },
          };
        });
      const options = {
        connection: { request },
        destinationOrgId: 'org',
        destinationWorkspace: workspace(),
        sourceDirectory,
        loadedSource,
        editableDirectory,
        workspaceId: 'destination-space',
        nativeCopyMappings: mapping,
      };
      const dryRun = await executeWorkspaceImport({ ...options, dryRun: true });
      expect(request.notCalled).to.equal(true);
      expect(dryRun.diagnostics[0].message).to.include(
        `${html === '<p>Static body</p>' ? 0 : 1} selected HTML modification(s) planned`,
      );
      const result = await executeWorkspaceImport({
        ...options,
        reportDirectory,
        reportPersistence: {
          rewrite: async (file, report) => {
            if (initial === undefined)
              initial = JSON.parse(await readFile(file, 'utf8')) as WorkspaceImportRunReport;
            await rewriteAtomic(file, report);
          },
        },
      });
      expect(request.getCalls().map((call) => call.args[0].method)).to.deep.equal(['POST', 'GET']);
      expect(posted.contentBody).to.deep.equal({
        ...items[0].contentBody,
        rawHtml: html,
        'sfdc_cms:urlName': 'fresh-url',
      });
      expect(result.diagnostics[0].message).to.include(
        `${html === '<p>Static body</p>' ? 0 : 1} selected HTML modification(s) applied`,
      );
      expect(result.contractResult.integrity.verifiedItemCount).to.equal(2);
      expect(result.contractResult.sourcePackage.manifestSha256).to.equal(
        loadedSource.manifestSha256,
      );
      expect(result.plan.source).to.equal(loadedSource);
      expect(JSON.stringify(loadedSource)).to.equal(before);
      expect(
        await readFile(path.join(editableDirectory, 'items/source-variant.json')),
      ).to.deep.equal(metadataBefore);
      for (const raw of items)
        expect(await readFile(path.join(sourceDirectory, `items/${raw.id}.json`), 'utf8')).to.equal(
          `${JSON.stringify(raw)}\n`,
        );
    });
  }

  for (const failure of ['missing mappings', 'journal write', 'unselected identity']) {
    it(`rejects editable service input without transport: ${failure}`, async () => {
      const items = [nativeItem(), { ...nativeItem(), id: 'other-variant', language: 'fr' }];
      const sourceDirectory = await writeExport(root, items);
      const source = await loadWorkspaceExport(sourceDirectory);
      const editableDirectory = path.join(root, 'editable');
      await writeEditableRawHtml(
        items.map((raw) => ({ variantId: raw.id, raw })),
        source.manifestSha256,
        editableDirectory,
      );
      const request = sinon.stub();
      const reportDirectory = path.join(root, 'report');
      if (failure === 'journal write') await mkdir(reportDirectory);
      await expectRejected(
        executeWorkspaceImport({
          connection: { request },
          destinationOrgId: 'org',
          destinationWorkspace: workspace(),
          sourceDirectory,
          editableDirectory,
          workspaceId: 'destination-space',
          reportDirectory,
          ...(failure === 'missing mappings'
            ? {}
            : {
                nativeCopyMappings:
                  failure === 'unselected identity'
                    ? [{ ...mapping[0], apiName: items[1].apiName }]
                    : mapping,
              }),
        }),
      );
      expect(request.notCalled).to.equal(true);
    });
  }

  for (const [scenario, useEditable] of [
    'unselected',
    'selected',
    'unknown owner',
    'mismatched portable key',
    'unknown kind',
    'contradictory association',
    'unevidenced relationship',
    'full import',
    'tampered unselected item',
  ].flatMap((scenario) => [false, true].map((editable) => [scenario, editable] as const))) {
    it(`preflights native selection with full package integrity: ${scenario}, editable=${useEditable}`, async () => {
      const selected = nativeItem();
      const unselected = item('other-variant', 'fr', 'key', {
        references: [],
        externalId: null,
        externalSource: null,
      });
      const items = [selected, unselected];
      for (const value of items) Object.assign(value, { managedContentId: 'parent-id' });
      if (scenario === 'selected') Object.assign(selected, { references: [] });
      const inventory = inventoryExportReferences(
        'source-space',
        new Map(items.map((value) => [value.id, value])),
      );
      const relationship = inventory.externalReferences.find(
        (reference) => reference.kind === 'cms.relationship',
      )!;
      if (scenario === 'unknown owner') relationship.source.sourceId = 'missing-variant';
      if (scenario === 'mismatched portable key') relationship.portableKey.value = 'wrong-id';
      if (scenario === 'unknown kind') relationship.kind = 'cms.opaque';
      if (scenario === 'unevidenced relationship') Reflect.deleteProperty(unselected, 'references');
      const bytes = new Map(items.map((value) => [value.id, `${JSON.stringify(value)}\n`]));
      const fixture = manifest(items, bytes, {
        completeness: 'partial',
        externalReferences: inventory.externalReferences.toSorted((left, right) =>
          [left.kind, left.referenceId, left.portableKey.value]
            .join('\0')
            .localeCompare([right.kind, right.referenceId, right.portableKey.value].join('\0')),
        ),
        items: items.map((value) => ({
          path: `items/${value.id}.json`,
          kind: 'cms.content',
          sha256: createHash('sha256').update(bytes.get(value.id)!).digest('hex'),
          ...(scenario === 'contradictory association' && value.id === selected.id
            ? { referenceId: relationship.referenceId }
            : {}),
        })),
      });
      const sourceDirectory = await writeExport(root, items, fixture);
      const manifestBefore = await readFile(path.join(sourceDirectory, 'manifest.json'));
      const editableDirectory = path.join(root, 'editable');
      await writeEditableRawHtml(
        items.map((raw) => ({ variantId: raw.id, raw })),
        createHash('sha256').update(manifestBefore).digest('hex'),
        editableDirectory,
      );
      await writeFile(
        path.join(editableDirectory, 'items/source-variant.html'),
        '<p>Edited selection</p>',
      );
      if (scenario === 'tampered unselected item') {
        await writeFile(path.join(sourceDirectory, 'items/other-variant.json'), '{}\n');
      }
      const request = sinon.stub();
      const run = executeWorkspaceImport({
        allowPartial: true,
        connection: { request },
        destinationOrgId: 'org',
        destinationWorkspace: workspace(),
        dryRun: true,
        sourceDirectory,
        workspaceId: 'destination-space',
        ...(scenario === 'full import'
          ? {}
          : { nativeCopyMappings: mapping, ...(useEditable ? { editableDirectory } : {}) }),
      });
      if (scenario === 'unselected') {
        const result = await run;
        expect(result.plan.groups).to.have.length(1);
        expect(result.plan.groups[0].variants).to.have.length(0);
        expect(result.plan.source.manifest).to.deep.equal(fixture);
        expect(result.contractResult.sourcePackage.manifestSha256).to.equal(
          createHash('sha256').update(manifestBefore).digest('hex'),
        );
        expect(result.contractResult.integrity).to.deep.equal({
          listedItemCount: 2,
          verifiedItemCount: 2,
          unlistedFileCount: 0,
          verified: true,
        });
        expect(result.contractResult.references).to.deep.include({
          referenceId: relationship.referenceId,
          kind: 'cms.relationship',
          status: 'unsupported',
        });
        for (const value of items) {
          expect(
            await readFile(path.join(sourceDirectory, `items/${value.id}.json`), 'utf8'),
          ).to.equal(bytes.get(value.id));
        }
      } else {
        let failure: unknown;
        try {
          await run;
        } catch (error) {
          failure = error;
        }
        expect(failure).to.be.instanceOf(TypeError);
        expect((failure as Error).message).to.include(
          scenario === 'tampered unselected item'
            ? 'failed SHA-256 verification'
            : 'Unresolved required package reference',
        );
      }
      expect(request.notCalled).to.equal(true);
      expect(await readFile(path.join(sourceDirectory, 'manifest.json'))).to.deep.equal(
        manifestBefore,
      );
    });
  }
  for (const type of ['sfdc_cms__email', 'sfdc_cms__emailTemplate']) {
    it(`creates ${type} with omitted key, immutable source, durable generated identity before readback`, async () => {
      const sourceDirectory = await writeExport(root, [nativeItem(type)]);
      const before = await readFile(
        path.join(sourceDirectory, 'items/source-variant.json'),
        'utf8',
      );
      const reportDirectory = path.join(root, 'report');
      let posted: Record<string, unknown> = {};
      const request = sinon
        .stub()
        .callsFake(async (request_: { method: string; body?: string }) => {
          if (request_.method === 'POST') {
            posted = JSON.parse(request_.body!) as Record<string, unknown>;
            return {
              contentKey: 'generated',
              managedContentId: 'target-id',
              managedContentVariantId: 'target-variant',
            };
          }
          const journal = JSON.parse(
            await readFile(path.join(reportDirectory, 'workspace-import-run.json'), 'utf8'),
          ) as { operations: { contentKey: string; result: unknown }[] };
          expect(journal.operations[0].contentKey).to.equal('key');
          expect(journal.operations[0].result).to.include({
            contentKey: 'generated',
            contentId: 'target-id',
          });
          return {
            ...posted,
            contentKey: 'generated',
            managedContentId: 'target-id',
            contentSpace: { id: 'destination-space' },
            language: 'en',
            isPublished: false,
            status: { status: 'Draft' },
          };
        });
      const result = await executeWorkspaceImport({
        connection: { request },
        destinationOrgId: 'org',
        destinationWorkspace: workspace(),
        sourceDirectory,
        workspaceId: 'destination-space',
        nativeCopyMappings: mapping,
        reportDirectory,
      });
      expect(
        request.getCalls().map((call) => (call.args[0] as { method: string }).method),
      ).to.deep.equal(['POST', 'GET']);
      expect(posted).to.not.have.any.keys('contentKey', 'externalId', 'externalSource', 'id');
      expect(posted).to.include({
        contentSpaceOrFolderId: 'destination-space',
        apiName: 'fresh_api',
        urlName: 'fresh-url',
      });
      expect(posted.contentBody).to.include({
        rawHtml: '<p>Static body</p>',
        textContent: 'Static body',
      });
      expect(result.report?.state).to.equal('completed');
      expect(result.contractResult.mappings[0].target).to.include({
        targetId: 'target-id',
        targetReference: 'generated',
      });
      expect(
        await readFile(path.join(sourceDirectory, 'items/source-variant.json'), 'utf8'),
      ).to.equal(before);
    });
  }
  it('decodes native GET HTML once and does not treat an existing destination URL as overwrite', async () => {
    const sourceDirectory = await writeExport(root, [
      nativeItem('sfdc_cms__email', { rawHtml: '&lt;p&gt;Static body&lt;/p&gt;' }),
    ]);
    let posted: Record<string, unknown> = {};
    const existing = { contentKey: 'existing-destination', urlName: 'fresh-url' };
    const request = sinon.stub().callsFake((request_: { method: string; body?: string }) => {
      if (request_.method === 'POST') {
        posted = JSON.parse(request_.body!) as Record<string, unknown>;
        expect((posted.contentBody as Record<string, unknown>).rawHtml).to.equal(
          '<p>Static body</p>',
        );
        return fakeRequest({
          contentKey: 'distinct-new',
          managedContentId: 'new-id',
          managedContentVariantId: 'new-variant',
        });
      }
      return fakeRequest({
        ...posted,
        contentKey: 'distinct-new',
        managedContentId: 'new-id',
        contentSpace: { id: 'destination-space' },
        language: 'en',
        isPublished: false,
        status: { status: 'Draft' },
      });
    });
    const result = await executeWorkspaceImport({
      connection: { request },
      destinationOrgId: 'org',
      destinationWorkspace: workspace(),
      sourceDirectory,
      workspaceId: 'destination-space',
      nativeCopyMappings: mapping,
      reportDirectory: path.join(root, 'report'),
    });
    expect(result.report?.createdParents[0].contentKey).not.to.equal(existing.contentKey);
    expect(posted.urlName).to.equal(existing.urlName);
    expect(
      request
        .getCalls()
        .every((call) => ['GET', 'POST'].includes((call.args[0] as { method: string }).method)),
    ).to.equal(true);
  });
  for (const failure of ['DUPLICATE_VALUE: API name exists', 'connection timed out']) {
    it(`retains uncertain intent without retry on ${failure}`, async () => {
      const sourceDirectory = await writeExport(root, [nativeItem()]);
      const reportDirectory = path.join(root, 'report');
      const request = sinon.stub().callsFake(() => failedRequest(400, failure));
      await expectRejected(
        executeWorkspaceImport({
          connection: { request },
          destinationOrgId: 'org',
          destinationWorkspace: workspace(),
          sourceDirectory,
          workspaceId: 'destination-space',
          nativeCopyMappings: mapping,
          reportDirectory,
        }),
      );
      const journal = JSON.parse(
        await readFile(path.join(reportDirectory, 'workspace-import-run.json'), 'utf8'),
      ) as { state: string; operations: { state: string; error: string }[] };
      expect(journal.state).to.equal('ownership-uncertain');
      expect(journal.operations[0]).to.include({ state: 'pending', error: failure });
      expect(request.callCount).to.equal(1);
    });
  }
  for (const body of [
    { 'sfdc_cms:block': { ref: { contentKey: 'foreign' } } },
    { 'lightning:dataProviders': [{ definition: 'provider' }] },
  ]) {
    it(`blocks structured references/media before writes: ${JSON.stringify(body)}`, async () => {
      const sourceDirectory = await writeExport(root, [nativeItem('sfdc_cms__email', body)]);
      const request = sinon.stub();
      await expectRejected(
        executeWorkspaceImport({
          connection: { request },
          destinationOrgId: 'org',
          destinationWorkspace: workspace(),
          sourceDirectory,
          workspaceId: 'destination-space',
          nativeCopyMappings: mapping,
          reportDirectory: path.join(root, 'report'),
        }),
      );
      expect(request.notCalled).to.equal(true);
    });
  }
});

describe('workspace import core', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'sf-plugin-cms-import-'));
  });

  afterEach(async () => {
    await rm(root, { force: true, recursive: true });
  });

  it('plans fresh parent identities coherently without changing raw hashes or literal content', async () => {
    const body = {
      source: { type: 'url', url: '/cms/media/key' },
      rawHtml: 'key api_name en-title',
    };
    const source = await writeExport(root, [
      item('one', 'en', 'key', { contentType: 'sfdc_cms__email', contentBody: body }),
      item('two', 'fr'),
    ]);
    // Both variants of one parent must share their content type.
    const loaded = await loadWorkspaceExport(source);
    const coherent = {
      ...loaded,
      items: loaded.items.map((value) => ({ ...value, contentType: 'sfdc_cms__email' })),
    };
    const before = JSON.stringify(coherent);
    const mappings = [
      {
        sourceContentKey: 'key',
        contentKey: 'new-key',
        apiName: 'new_api',
        urlNames: { en: 'new-en', fr: 'new-fr' },
      },
    ];
    const planned = planImportIdentities(coherent, mappings);
    expect(planned.targetContentKeys).to.deep.equal(['new-key']);
    expect(
      planned.items.map(({ contentKey, apiName, urlName }) => ({ contentKey, apiName, urlName })),
    ).to.deep.equal([
      { contentKey: 'new-key', apiName: 'new_api', urlName: 'new-en' },
      { contentKey: 'new-key', apiName: 'new_api', urlName: 'new-fr' },
    ]);
    expect(planned.items[0].contentBody).to.deep.equal({
      ...body,
      'sfdc_cms:urlName': 'new-en',
    });
    expect(JSON.stringify(coherent)).to.equal(before);
    const reloaded = await loadWorkspaceExport(source);
    expect(reloaded.manifestSha256).to.equal(loaded.manifestSha256);
    expect(reloaded.manifest.items).to.deep.equal(loaded.manifest.items);
    expect(
      planWorkspaceImport(loaded, workspace(), 'destination-space').groups[0].contentKey,
    ).to.equal('key');
    expect(() => planImportIdentities(loaded, mappings)).to.throw('conflicting content types');
  });

  for (const hasBodyUrl of [true, false]) {
    it(`maps email-template URL names without injecting absent body metadata (${hasBodyUrl})`, async () => {
      const source = await writeExport(root, [
        item('template', 'en', 'key', {
          contentType: 'sfdc_cms__emailTemplate',
          contentBody: hasBodyUrl ? { 'sfdc_cms:urlName': 'en-title' } : { body: 'template' },
        }),
      ]);
      const loaded = await loadWorkspaceExport(source);
      const before = JSON.stringify(loaded);
      const identityMappings = [
        {
          sourceContentKey: 'key',
          contentKey: 'fresh-key',
          apiName: 'fresh_api',
          urlNames: { en: 'fresh-en' },
        },
      ];
      const planned = planImportIdentities(loaded, identityMappings);
      expect(planned.items[0].urlName).to.equal('fresh-en');
      if (hasBodyUrl) {
        expect(planned.items[0].contentBody['sfdc_cms:urlName']).to.equal('fresh-en');
      } else {
        expect(planned.items[0].contentBody).not.to.have.property('sfdc_cms:urlName');
      }
      const request = requestRouter();
      const result = await executeWorkspaceImport({
        connection: { request },
        destinationOrgId: 'target',
        destinationWorkspace: workspace(),
        dryRun: true,
        identityMappings,
        loadedSource: loaded,
        sourceDirectory: source,
        workspaceId: 'destination-space',
      });
      expect(result.plan.groups[0].primary.contentBody).to.deep.equal(planned.items[0].contentBody);
      expect(result.contractResult.mappings).to.deep.equal([]);
      expect(result.diagnostics.map(({ code }) => code)).to.deep.equal([
        'NAME_AVAILABILITY_UNVERIFIED',
        'SERVER_CONFLICT_CHECK_UNVERIFIED',
        'APPLY_READINESS_UNVERIFIED',
      ]);
      expect(request.callCount).to.equal(1);
      expect(request.firstCall.args[0]).to.include({ method: 'GET' });
      expect(request.firstCall.args[0].url).to.include('/fresh-key');
      expect(JSON.stringify(loaded)).to.equal(before);
      expect(JSON.stringify(await loadWorkspaceExport(source))).to.equal(before);
      expect(await readdir(root)).to.deep.equal(['source']);
    });
  }

  it('rejects incomplete, conflicting and unknown explicit identity mappings', async () => {
    const source = await writeExport(root, [item('one'), item('two', 'fr')]);
    const loaded = await loadWorkspaceExport(source);
    const mapping = {
      sourceContentKey: 'key',
      contentKey: 'new-key',
      apiName: 'new_api',
      urlNames: { en: 'new-en', fr: 'new-fr' },
    };
    for (const input of [
      [],
      [mapping, mapping],
      [{ ...mapping, sourceContentKey: 'unknown' }],
      [{ ...mapping, contentKey: 'key' }],
      [{ ...mapping, apiName: 'api_name' }],
      [{ ...mapping, urlNames: { en: 'new-en' } }],
      [{ ...mapping, urlNames: { en: 'new-en', fr: 'new-en' } }],
      [{ ...mapping, urlNames: { en: 'en-title', fr: 'new-fr' } }],
      [{ ...mapping, operation: 'reuse' }],
    ]) {
      expect(() => planImportIdentities(loaded, input)).to.throw();
    }
    expect(() =>
      planImportIdentities(
        {
          ...loaded,
          integrity: { ...loaded.integrity, verified: false },
        } as unknown as LoadedWorkspaceExport,
        [mapping],
      ),
    ).to.throw('integrity');
  });

  it('rejects missing or ambiguous references and preserves unsupported media diagnostics', async () => {
    const source = await writeExport(root, [item('one')]);
    const loaded = await loadWorkspaceExport(source);
    const mapping = [
      {
        sourceContentKey: 'key',
        contentKey: 'new-key',
        apiName: 'new_api',
        urlNames: { en: 'new-en' },
      },
    ];
    for (const ref of [
      { type: 'imageReference', ref: { contentKey: 'missing' } },
      { ref: { contentKey: 'key' } },
      { type: 'imageReference', ref: { contentKey: 'key', id: 'ambiguous' } },
      { type: 'file', ref: 'file-id' },
    ]) {
      const input = {
        ...loaded,
        items: [{ ...loaded.items[0], contentBody: { source: ref } }],
      } as LoadedWorkspaceExport;
      expect(() => planImportIdentities(input, mapping)).to.throw();
    }
    const imageSource = {
      ...loaded,
      items: [
        {
          ...loaded.items[0],
          contentType: 'sfdc_cms__image',
          contentBody: { source: { type: 'imageReference', ref: { contentKey: 'key' } } },
        },
      ],
    } as LoadedWorkspaceExport;
    expect(planImportIdentities(imageSource, mapping).items[0].contentBody).to.deep.equal({
      source: { type: 'imageReference', ref: { contentKey: 'new-key' } },
    });
    const wrongType = {
      ...imageSource,
      items: imageSource.items.map((value) => ({ ...value, contentType: 'sfdc_cms__news' })),
    };
    expect(() => planImportIdentities(wrongType, mapping)).to.throw('no selected source identity');
    const before = JSON.stringify(loaded.manifest);
    planImportIdentities(loaded, mapping);
    expect(JSON.stringify(loaded.manifest)).to.equal(before);
  });

  it('rejects collisions between different mapped parents', async () => {
    const source = await writeExport(root, [
      item('one'),
      item('two', 'en', 'other', { apiName: 'other_api' }),
    ]);
    const loaded = await loadWorkspaceExport(source);
    const first = {
      sourceContentKey: 'key',
      contentKey: 'new-key',
      apiName: 'new_api',
      urlNames: { en: 'new-en' },
    };
    const second = {
      sourceContentKey: 'other',
      contentKey: 'new-other',
      apiName: 'new_other',
      urlNames: { en: 'new-other-en' },
    };
    for (const duplicate of [
      { contentKey: first.contentKey },
      { apiName: first.apiName },
      { urlNames: first.urlNames },
    ]) {
      expect(() => planImportIdentities(loaded, [first, { ...second, ...duplicate }])).to.throw(
        'unique',
      );
    }
  });

  it('validates mapped identities in the service but blocks unqueryable destination names', async () => {
    const source = await writeExport(root, [item('one'), item('two', 'fr')]);
    const loaded = await loadWorkspaceExport(source);
    const before = JSON.stringify(loaded);
    const request = requestRouter();
    let failure: unknown;
    try {
      await executeWorkspaceImport({
        connection: { request },
        destinationOrgId: 'target',
        destinationWorkspace: workspace(),
        loadedSource: loaded,
        sourceDirectory: source,
        workspaceId: 'destination-space',
        reportDirectory: path.join(root, 'blocked'),
        identityMappings: [
          {
            sourceContentKey: 'key',
            contentKey: 'fresh-key',
            apiName: 'fresh_api',
            urlNames: { en: 'fresh-en', fr: 'fresh-fr' },
          },
        ],
      });
    } catch (error) {
      failure = error;
    }
    expect((failure as Error).message).to.include('uniqueness cannot be verified');
    expect(request.callCount).to.equal(1);
    expect(request.firstCall.args[0].url).to.include('/fresh-key');
    expect(request.firstCall.args[0].method).to.equal('GET');
    expect(JSON.stringify(loaded)).to.equal(before);
    expect(await readdir(root)).to.deep.equal(['source']);
  });

  for (const body of [
    { source: { type: 'imageReference', ref: { contentKey: 'missing' } } },
    { source: { type: 'imageReference' } },
    { source: { type: 'file' } },
    { source: { type: 'file', ref: 'file-fixture' } },
    { source: { ref: { contentKey: 'a' } } },
  ]) {
    it(`blocks late secondary-variant dependency before any create: ${JSON.stringify(body)}`, async () => {
      const source = await writeExport(root, [
        unnamedItem('first', 'en', 'a'),
        unnamedItem('second', 'en', 'z'),
        unnamedItem('last', 'fr', 'z', { contentBody: body }),
      ]);
      const request = requestRouter();
      await expectRejected(
        executeWorkspaceImport({
          connection: { request },
          destinationOrgId: 'target',
          destinationWorkspace: workspace(),
          sourceDirectory: source,
          workspaceId: 'destination-space',
          reportDirectory: path.join(root, 'blocked'),
        }),
      );
      expect(request.notCalled).to.equal(true);
      expect(await readdir(root)).to.deep.equal(['source']);
    });
  }

  for (const overrides of [{ apiName: 'duplicate' }, { urlName: 'duplicate' }]) {
    it(`blocks cross-parent identity conflict before mutation: ${JSON.stringify(overrides)}`, async () => {
      const source = await writeExport(
        root,
        [unnamedItem('first', 'en', 'a', overrides), unnamedItem('last', 'en', 'z', overrides)].map(
          (value) => ({ ...value, ...overrides }),
        ),
      );
      const request = requestRouter();
      await expectRejected(
        executeWorkspaceImport({
          connection: { request },
          destinationOrgId: 'target',
          destinationWorkspace: workspace(),
          sourceDirectory: source,
          workspaceId: 'destination-space',
          reportDirectory: path.join(root, 'blocked'),
        }),
      );
      expect(request.notCalled).to.equal(true);
    });
  }

  it('checks every destination key before creating the first parent', async () => {
    const source = await writeExport(root, [
      unnamedItem('first', 'en', 'a'),
      unnamedItem('last', 'en', 'z'),
    ]);
    const request = requestRouter();
    request.onSecondCall().returns(fakeRequest({ contentKey: 'z' }));
    await expectRejected(
      executeWorkspaceImport({
        connection: { request },
        destinationOrgId: 'target',
        destinationWorkspace: workspace(),
        sourceDirectory: source,
        workspaceId: 'destination-space',
        reportDirectory: path.join(root, 'blocked'),
      }),
    );
    expect(request.callCount).to.equal(2);
    expect(request.getCalls().every((call) => call.args[0].method === 'GET')).to.equal(true);
  });

  it('normalizes the live variant shape without changing raw bytes or component configuration', async () => {
    const contentBody = {
      'sfdc_cms:block': { id: 'block-fixture', children: [{ attributes: { text: 'Fixture' } }] },
      subjectLine: 'Fixture subject',
      preheader: 'Fixture preheader',
      messagePurpose: 'promotional',
      'lightning:expressions': [],
      'sfdc_cms:attachments': [],
      'sfdc_cms:variants': [],
      'lightning:brandSource': { defaultBrandOption: 'fixture' },
      'lightning:dataProviders': [{ definition: 'fixtureProvider' }],
    };
    const source = await writeExport(
      root,
      [item('variant-fixture')],
      {},
      {
        id: undefined,
        managedContentVariantId: 'variant-fixture',
        managedContentId: 'content-fixture',
        contentType: { fullyQualifiedName: 'sfdc_cms__email' },
        externalId: null,
        contentBody,
      },
    );
    const file = path.join(source, 'items/variant-fixture.json');
    const before = await readFile(file, 'utf8');
    const loaded = await loadWorkspaceExport(source);
    expect(loaded.items[0]).to.include({
      id: 'variant-fixture',
      managedContentId: 'content-fixture',
      contentType: 'sfdc_cms__email',
    });
    expect(loaded.items[0]).not.to.have.property('externalId');
    expect(loaded.items[0].contentBody).to.deep.equal(contentBody);
    expect(await readFile(file, 'utf8')).to.equal(before);
    const request = requestRouter();
    const result = await executeWorkspaceImport({
      connection: { request },
      destinationOrgId: 'target-org',
      destinationWorkspace: workspace(),
      dryRun: true,
      sourceDirectory: source,
      workspaceId: 'destination-space',
    });
    expect(result.dryRun).to.equal(true);
    expect(result.plan.groups[0].primary.contentBody).to.deep.equal(contentBody);
    expect(result.diagnostics.map(({ code }) => code)).to.include('NAME_AVAILABILITY_UNVERIFIED');
    expect(result.contractResult.mappings).to.deep.equal([]);
    expect(await readFile(file, 'utf8')).to.equal(before);
    expect(request.getCalls().every((call) => call.args[0].method === 'GET')).to.equal(true);
  });

  for (const overrides of [
    { managedContentVariantId: 'other-variant' },
    { managedContentVariantId: null },
    { managedContentId: 'parent', contentId: 'different-parent' },
    { managedContentId: 'variant-fixture' },
    { managedContentId: null },
    { id: undefined, managedContentId: 'parent' },
    { contentType: { fullyQualifiedName: 'sfdc_cms__email', unsupported: 'sfdc_cms__news' } },
    { contentType: { fullyQualifiedName: null } },
    { contentType: {} },
    { contentType: ['sfdc_cms__email'] },
    { externalId: 42 },
    { externalSource: 42 },
    { apiName: null },
    { urlName: null },
  ]) {
    it(`rejects malformed or ambiguous variant metadata ${JSON.stringify(overrides)}`, async () => {
      const source = await writeExport(root, [item('variant-fixture')], {}, overrides);
      let error: unknown;
      try {
        await loadWorkspaceExport(source);
      } catch (error_) {
        error = error_;
      }
      expect(error).to.be.instanceOf(TypeError);
    });
  }

  it('rejects conflicting parent identities across language variants', async () => {
    const source = await writeExport(root, [
      item('variant-en', 'en', 'key', { managedContentId: 'parent-a' }),
      item('variant-fr', 'fr', 'key', { managedContentId: 'parent-b' }),
    ]);
    let error: unknown;
    try {
      await loadWorkspaceExport(source);
    } catch (error_) {
      error = error_;
    }
    expect(error).to.be.instanceOf(TypeError);
  });

  it('accepts matching retained legacy and documented identities', async () => {
    const source = await writeExport(
      root,
      [item('variant-fixture')],
      {},
      {
        managedContentVariantId: 'variant-fixture',
        managedContentId: 'parent',
        contentId: 'parent',
      },
    );
    const loaded = await loadWorkspaceExport(source);
    expect(loaded.items[0].id).to.equal('variant-fixture');
  });

  it('retries transient Windows atomic replacement errors and cleans the sibling temp file', async () => {
    const destination = path.join(root, 'workspace-import-run.json');
    await writeFile(destination, 'old report\n');
    const transient = Object.assign(new Error('scanner temporarily holds destination'), {
      code: 'EPERM',
    });
    const renamePath = sinon.stub();
    renamePath.onFirstCall().rejects(transient);
    renamePath
      .onSecondCall()
      .rejects(Object.assign(new Error('destination still busy'), { code: 'EBUSY' }));
    renamePath.onThirdCall().callsFake(async (source: string, target: string) => {
      await rename(source, target);
    });
    const wait = sinon.stub().resolves();

    await rewriteAtomic(
      destination,
      { state: 'completed' },
      {
        delay: wait,
        platform: 'win32',
        renamePath,
      },
    );

    expect(wait.args).to.deep.equal([[10], [25]]);
    expect(await readFile(destination, 'utf8')).to.equal('{\n  "state": "completed"\n}\n');
    const remainingFiles = await readdir(root);
    expect(remainingFiles.filter((name) => name.includes('.tmp-'))).to.deep.equal([]);
  });

  it('preserves permanent atomic replacement errors and cleans the sibling temp file', async () => {
    const destination = path.join(root, 'workspace-import-run.json');
    await writeFile(destination, 'old report\n');
    const permanent = Object.assign(new Error('destination remains locked'), { code: 'EPERM' });
    const renamePath = sinon.stub().rejects(permanent);
    const wait = sinon.stub().resolves();

    try {
      await rewriteAtomic(
        destination,
        { state: 'completed' },
        {
          delay: wait,
          platform: 'win32',
          renamePath,
        },
      );
      expect.fail('expected permanent rename failure');
    } catch (error) {
      expect(error).to.equal(permanent);
    }

    expect(renamePath.callCount).to.equal(4);
    expect(wait.args).to.deep.equal([[10], [25], [50]]);
    expect(await readFile(destination, 'utf8')).to.equal('old report\n');
    const remainingFiles = await readdir(root);
    expect(remainingFiles.filter((name) => name.includes('.tmp-'))).to.deep.equal([]);
  });

  it('preserves the original replacement error identity when temp cleanup fails', async () => {
    const destination = path.join(root, 'workspace-import-run.json');
    await writeFile(destination, 'old report\n');
    const publicationError = Object.assign(new Error('replacement failed'), { code: 'EACCES' });
    const cleanupError = Object.assign(new Error('cleanup failed'), { code: 'EPERM' });

    try {
      await rewriteAtomic(
        destination,
        { state: 'completed' },
        {
          platform: 'win32',
          removePath: sinon.stub().rejects(cleanupError),
          renamePath: sinon.stub().rejects(publicationError),
        },
      );
      expect.fail('expected replacement failure');
    } catch (error) {
      expect(error).to.equal(publicationError);
      expect((error as Error & { cleanupError?: unknown }).cleanupError).to.equal(cleanupError);
    }

    expect(await readFile(destination, 'utf8')).to.equal('old report\n');
    const remainingFiles = await readdir(root);
    expect(remainingFiles.some((name) => name.includes('.tmp-'))).to.equal(true);
  });

  it('preserves the primary error when cleanup diagnostics cannot be attached', async () => {
    const destination = path.join(root, 'workspace-import-run.json');
    await writeFile(destination, 'old report\n');
    const publicationError = Object.assign(new Error('replacement failed'), { code: 'EACCES' });
    Object.defineProperty(publicationError, 'cleanupError', {
      configurable: false,
      value: 'existing diagnostic',
    });

    try {
      await rewriteAtomic(
        destination,
        { state: 'completed' },
        {
          removePath: sinon.stub().rejects(new Error('cleanup failed')),
          renamePath: sinon.stub().rejects(publicationError),
        },
      );
      expect.fail('expected replacement failure');
    } catch (error) {
      expect(error).to.equal(publicationError);
      expect((error as Error & { cleanupError?: unknown }).cleanupError).to.equal(
        'existing diagnostic',
      );
    }
  });

  it('does not retry non-Windows or unrelated atomic replacement errors', async () => {
    const cases = [
      { code: 'EPERM', platform: 'linux' as const },
      { code: 'EACCES', platform: 'win32' as const },
    ];
    for (const [index, testCase] of cases.entries()) {
      const destination = path.join(root, `workspace-import-run-${index}.json`);
      await writeFile(destination, 'old report\n');
      const failure = Object.assign(new Error('rename failed'), { code: testCase.code });
      const renamePath = sinon.stub().rejects(failure);
      const wait = sinon.stub().resolves();

      try {
        await rewriteAtomic(
          destination,
          { state: 'completed' },
          {
            delay: wait,
            platform: testCase.platform,
            renamePath,
          },
        );
        expect.fail('expected rename failure');
      } catch (error) {
        expect(error).to.equal(failure);
      }

      expect(renamePath.callCount).to.equal(1);
      expect(wait.callCount).to.equal(0);
      expect(await readFile(destination, 'utf8')).to.equal('old report\n');
    }
    const remainingFiles = await readdir(root);
    expect(remainingFiles.filter((name) => name.includes('.tmp-'))).to.deep.equal([]);
  });

  it('loads a complete export and treats unsupported wildcard alone as non-partial', async () => {
    const source = await writeExport(root, [unnamedItem('primary'), unnamedItem('french', 'fr')]);

    const loaded = await loadWorkspaceExport(source);

    expect(loaded.isPartial).to.equal(false);
    expect(loaded.items.map(({ id }) => id)).to.deep.equal(['primary', 'french']);
    expect(loaded.manifestSha256).to.match(/^[a-f\d]{64}$/u);
    expect(loaded.integrity).to.deep.equal({
      listedItemCount: 2,
      verifiedItemCount: 2,
      unlistedFileCount: 0,
      verified: true,
    });
  });

  for (const [name, overrides] of [
    ['failed IDs', { completeness: 'partial', failedVariantIds: ['failed'] }],
    ['rejected IDs', { completeness: 'partial', rejectedVariantIds: ['rejected'] }],
    ['count mismatch', { completeness: 'partial', expectedCount: 2 }],
    [
      'unresolved reference warning',
      {
        completeness: 'partial',
        warnings: [{ code: 'REFERENCE_UNRESOLVED', message: 'partial' }],
      },
    ],
    [
      'unsupported reference warning',
      {
        completeness: 'partial',
        warnings: [{ code: 'REFERENCE_UNSUPPORTED', message: 'partial' }],
      },
    ],
  ] as const) {
    it(`rejects ${name} by default and accepts it only with allowPartial`, async () => {
      const source = await writeExport(root, [unnamedItem('primary')], overrides);
      try {
        await loadWorkspaceExport(source);
        expect.fail('expected partial rejection');
      } catch (error) {
        expect((error as Error).message).to.include('partial');
      }
      const loaded = await loadWorkspaceExport(source, { allowPartial: true });
      expect(loaded.isPartial).to.equal(true);
    });
  }

  it('rejects contradictory complete manifests even with allowPartial', async () => {
    for (const overrides of [
      { failedVariantIds: ['failed'] },
      { rejectedVariantIds: ['rejected'] },
      { expectedCount: 2 },
      { warnings: [{ code: 'COUNT_MISMATCH', message: 'incomplete' }] },
      {
        provenance: {
          producer: 'sf-plugin-cms',
          sourceOrgId: '00D-source',
          sourceWorkspaceId: 'other-space',
          pluginVersion: '0.3.0',
          generatedAt: '2026-09-13T18:00:00.000Z',
        },
      },
      {
        externalReferences: [
          {
            referenceId: referenceId('key'),
            owner: 'cms',
            kind: 'cms.content',
            source: { workspaceId: 'other-space', sourceId: 'key' },
            portableKey: { scheme: 'cms-opaque-v1', value: 'key' },
            required: true,
            resolution: 'unresolved',
          },
        ],
      },
    ]) {
      const caseRoot = await mkdtemp(path.join(root, 'contradictory-'));
      const source = await writeExport(caseRoot, [unnamedItem('primary')], overrides);
      await expectRejected(loadWorkspaceExport(source));
      await expectRejected(loadWorkspaceExport(source, { allowPartial: true }));
    }
  });

  it('rejects unsafe paths, separator IDs, duplicate mappings, and substituted files', async () => {
    const cases = [
      { entries: [{ file: '../escape.json', variantId: 'primary' }] },
      { entries: [{ file: path.resolve(root, 'escape.json'), variantId: 'primary' }] },
      { entries: [{ file: 'items/bad/id.json', variantId: 'bad/id' }] },
      {
        entries: [
          { file: 'items/primary.json', variantId: 'primary' },
          { file: 'items/primary.json', variantId: 'primary' },
        ],
        exportedCount: 2,
        expectedCount: 2,
      },
      { entries: [{ file: 'items/other.json', variantId: 'primary' }] },
    ];
    for (const overrides of cases) {
      const caseRoot = await mkdtemp(path.join(root, 'case-'));
      const source = await writeExport(caseRoot, [unnamedItem('primary')], overrides);
      try {
        await loadWorkspaceExport(source, { allowPartial: true });
        expect.fail('expected structural rejection');
      } catch (error) {
        expect(error).to.be.instanceOf(Error);
      }
    }
  });

  it('rejects missing, extra, symlinked, and variant-mismatched item files', async () => {
    const missingRoot = await mkdtemp(path.join(root, 'missing-'));
    const missing = await writeExport(missingRoot, [unnamedItem('primary')]);
    await rm(path.join(missing, 'items', 'primary.json'));
    try {
      await loadWorkspaceExport(missing);
      expect.fail('expected missing-file rejection');
    } catch (error) {
      expect(error).to.be.instanceOf(TypeError);
      expect((error as Error).message).to.include('missing');
    }

    const extraRoot = await mkdtemp(path.join(root, 'extra-'));
    const extra = await writeExport(extraRoot, [unnamedItem('primary')]);
    await writeFile(path.join(extra, 'items', 'extra.json'), '{}');
    await expectRejected(loadWorkspaceExport(extra));

    const mismatchRoot = await mkdtemp(path.join(root, 'mismatch-'));
    const mismatch = await writeExport(mismatchRoot, [unnamedItem('primary')]);
    await writeFile(path.join(mismatch, 'items', 'primary.json'), JSON.stringify(item('other')));
    await expectRejected(loadWorkspaceExport(mismatch));

    const linkRoot = await mkdtemp(path.join(root, 'link-'));
    const link = await writeExport(linkRoot, [unnamedItem('primary')]);
    const target = path.join(linkRoot, 'target.json');
    await writeFile(target, JSON.stringify(item('primary')));
    await rm(path.join(link, 'items', 'primary.json'));
    try {
      await symlink(target, path.join(link, 'items', 'primary.json'), 'file');
      await expectRejected(loadWorkspaceExport(link));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error;
    }
  });

  it('rejects workspace, required-field, body, duplicate pair, and apiName relationship failures', async () => {
    const invalidItems = [
      item('one', 'en', 'key', { contentSpace: { id: 'other' } }),
      item('one', 'en', 'key', { title: '' }),
      item('one', 'en', 'key', { contentBody: [] }),
      item('one', 'en', 'key', { contentType: 'news' }),
    ];
    for (const invalid of invalidItems) {
      const caseRoot = await mkdtemp(path.join(root, 'invalid-'));
      const source = await writeExport(caseRoot, [invalid]);
      await expectRejected(loadWorkspaceExport(source));
    }
    const duplicateRoot = await mkdtemp(path.join(root, 'duplicate-'));
    const duplicateSource = await writeExport(duplicateRoot, [item('one'), item('two', 'en')]);
    await expectRejected(loadWorkspaceExport(duplicateSource));
    const apiRoot = await mkdtemp(path.join(root, 'api-'));
    const apiSource = await writeExport(apiRoot, [
      item('one'),
      item('two', 'fr', 'key', { apiName: 'other' }),
    ]);
    await expectRejected(loadWorkspaceExport(apiSource));
  });

  it('performs all local validation before any remote request', async () => {
    const source = await writeExport(root, [item('primary', 'en', 'key', { contentBody: [] })]);
    const request = sinon.stub();

    await expectRejected(
      executeWorkspaceImport({
        connection: { request },
        destinationOrgId: '00D-org-id',
        destinationWorkspace: workspace(),
        dryRun: true,
        sourceDirectory: source,
        workspaceId: 'destination-space',
      }),
    );
    expect(request.callCount).to.equal(0);
  });

  it('rejects exact-byte item hash substitution before org access', async () => {
    const source = await writeExport(root, [unnamedItem('primary')]);
    await writeFile(
      path.join(source, 'items', 'primary.json'),
      `${JSON.stringify(item('primary'))} \n`,
    );
    const request = sinon.stub();

    await expectRejected(
      executeWorkspaceImport({
        connection: { request },
        destinationOrgId: '00D-org-id',
        destinationWorkspace: workspace(),
        dryRun: true,
        sourceDirectory: source,
        workspaceId: 'destination-space',
      }),
    );
    expect(request.notCalled).to.equal(true);
  });

  it('selects only the destination default language and rejects missing or ambiguous primaries', async () => {
    const source = await writeExport(root, [item('english'), item('french', 'fr')]);
    const loaded = await loadWorkspaceExport(source);
    expect(
      planWorkspaceImport(loaded, workspace('fr'), 'destination-space').groups[0].primary.id,
    ).to.equal('french');
    expect(() => planWorkspaceImport(loaded, workspace('de'), 'destination-space')).to.throw(
      'exactly one',
    );
    expect(() => planWorkspaceImport(loaded, workspace('en'), 'other-space')).to.throw(
      'exactly match',
    );
    expect(() =>
      planWorkspaceImport(loaded, { ...workspace('en'), rootFolderId: '' }, 'destination-space'),
    ).to.throw('rootFolderId');

    const unsafe = {
      ...loaded,
      items: [...loaded.items, { ...loaded.items[0], id: 'second-english' }],
    } as LoadedWorkspaceExport;
    expect(() => planWorkspaceImport(unsafe, workspace('en'), 'destination-space')).to.throw(
      'exactly one',
    );
  });

  it('hard-fails existing content and non-not-found lookup errors without mutation', async () => {
    const source = await writeExport(root, [unnamedItem('primary')]);
    for (const request of [
      requestRouter({ conflict: true }),
      requestRouter({ lookupStatus: 500 }),
    ]) {
      await expectRejected(
        executeWorkspaceImport({
          connection: { request },
          destinationOrgId: '00D-org-id',
          destinationWorkspace: workspace(),
          dryRun: true,
          sourceDirectory: source,
          workspaceId: 'destination-space',
        }),
      );
      expect(request.getCalls().every(({ args }) => args[0].method === 'GET')).to.equal(true);
    }
  });

  it('dry-runs named content with key checks but explicitly unverified readiness', async () => {
    const source = await writeExport(root, [
      item('one', 'en', 'a'),
      item('two', 'en', 'b', { apiName: 'second_api', urlName: 'second-url' }),
    ]);
    const request = requestRouter();

    const result = await executeWorkspaceImport({
      connection: { request },
      destinationOrgId: '00D-org-id',
      destinationWorkspace: workspace(),
      dryRun: true,
      sourceDirectory: source,
      workspaceId: 'destination-space',
    });

    expect(result.dryRun).to.equal(true);
    expect(result.contractResult.mappings).to.deep.equal([]);
    expect(result.diagnostics.map(({ code }) => code)).to.deep.equal([
      'NAME_AVAILABILITY_UNVERIFIED',
      'SERVER_CONFLICT_CHECK_UNVERIFIED',
      'APPLY_READINESS_UNVERIFIED',
    ]);
    expect(result.plan.groups[0].primary.apiName).to.equal('api_name');
    expect(await readdir(root)).to.deep.equal(['source']);
    expect(request.callCount).to.equal(2);
    expect(request.getCalls().every(({ args }) => args[0].method === 'GET')).to.equal(true);
  });

  it('rejects required unsupported references even in an allow-partial dry-run', async () => {
    const unsupportedReference = {
      referenceId: `ref:${'a'.repeat(64)}`,
      owner: 'cms',
      kind: 'cms.unknown',
      source: { workspaceId: 'source-space', sourceId: 'unknown-source' },
      portableKey: { scheme: 'cms-opaque-v1', value: 'unknown-key' },
      required: true,
      resolution: 'unsupported',
    };
    const source = await writeExport(root, [unnamedItem('primary')], {
      completeness: 'partial',
      externalReferences: [unsupportedReference],
      dependencies: [],
      items: [
        {
          path: 'items/primary.json',
          sha256: createHash('sha256')
            .update(`${JSON.stringify(unnamedItem('primary'))}\n`)
            .digest('hex'),
          kind: 'cms.content',
        },
      ],
      warnings: [
        {
          code: 'REFERENCE_UNSUPPORTED',
          message: 'unsupported',
          variantIds: ['primary'],
        },
      ],
    });
    const request = requestRouter();
    await expectRejected(
      executeWorkspaceImport({
        allowPartial: true,
        connection: { request },
        destinationOrgId: '00D-org-id',
        destinationWorkspace: workspace(),
        dryRun: true,
        sourceDirectory: source,
        workspaceId: 'destination-space',
      }),
    );
    expect(request.notCalled).to.equal(true);
  });

  it('creates exact direct payloads and binds a durable report to org, workspace, and source', async () => {
    const source = await writeExport(root, [unnamedItem('primary'), unnamedItem('french', 'fr')]);
    const request = requestRouter();
    const reportDirectory = path.join(root, 'report');

    const result = await executeWorkspaceImport({
      connection: { request },
      destinationOrgId: '00D-org-id',
      destinationWorkspace: workspace(),
      reportDirectory,
      sourceDirectory: source,
      workspaceId: 'destination-space',
    });

    const mutationCalls = request.getCalls().filter(({ args }) => args[0].method === 'POST');
    expect(JSON.parse(mutationCalls[0].args[0].body)).to.deep.equal({
      contentBody: { body: 'en body' },
      contentKey: 'key',
      contentSpaceOrFolderId: 'root-folder',
      contentType: 'sfdc_cms__news',
      externalId: 'external-id',
      externalSource: { source: 'migration' },
      title: 'en title',
    });
    expect(JSON.parse(mutationCalls[1].args[0].body)).to.deep.equal({
      contentBody: { body: 'fr body' },
      language: 'fr',
      managedContentKeyOrId: 'key',
      title: 'fr title',
    });
    expect(result.contractResult.mappings).to.have.length(1);
    expect(result.contractResult.mappings[0]).to.deep.include({
      referenceId: referenceId('key'),
      kind: 'cms.content',
      operation: 'created',
      status: 'resolved',
      cmsReferencesRewritten: true,
    });
    expect(result.contractResult.mappings[0].target).to.deep.equal({
      targetId: 'content-1',
      targetReference: 'key',
    });
    const report = JSON.parse(await readFile(result.reportFile!, 'utf8'));
    expect(report).to.include({
      destinationOrgId: '00D-org-id',
      destinationWorkspaceId: 'destination-space',
      sourceDirectory: await realpath(source),
      state: 'completed',
    });
    expect(report.runId).to.be.a('string');
    expect(report.runId).not.to.equal('');
    expect(report.sourceManifestSha256).to.match(/^[a-f\d]{64}$/u);
    expect(report.createdParents).to.deep.equal([
      {
        childVariantIds: ['child-fr'],
        contentId: 'content-1',
        contentKey: 'key',
        primaryVariantId: 'primary-1',
      },
    ]);
    const reportBytes = await readFile(result.reportFile!, 'utf8');
    expect(reportBytes.endsWith('\n')).to.equal(true);
  });

  it('rejects a late unresolved reference before creating an earlier independent parent', async () => {
    const source = await writeExport(root, [
      item('first', 'en', 'first-key', { apiName: 'first-api' }),
      item('second', 'en', 'second-key', {
        apiName: 'second-api',
        contentBody: {
          card: { ref: { contentKey: 'first-key', type: 'imageReference' } },
          unrelated: 'first-key',
        },
        externalSource: { contentKey: 'first-key' },
      }),
    ]);
    const request = requestRouter();

    await expectRejected(
      executeWorkspaceImport({
        connection: { request },
        destinationOrgId: '00D-org-id',
        destinationWorkspace: workspace(),
        reportDirectory: path.join(root, 'rewrite-report'),
        sourceDirectory: source,
        workspaceId: 'destination-space',
      }),
    );
    expect(request.notCalled).to.equal(true);
    expect(await readdir(root)).to.deep.equal(['source']);
  });

  it('rejects unsupported forward references before any org request', async () => {
    const source = await writeExport(root, [
      item('first', 'en', 'first-key', {
        apiName: 'first-api',
        contentBody: { card: { ref: { contentKey: 'second-key', type: 'imageReference' } } },
      }),
      item('second', 'en', 'second-key', { apiName: 'second-api' }),
    ]);
    const request = requestRouter();

    await expectRejected(
      executeWorkspaceImport({
        connection: { request },
        destinationOrgId: '00D-org-id',
        destinationWorkspace: workspace(),
        reportDirectory: path.join(root, 'forward-report'),
        sourceDirectory: source,
        workspaceId: 'destination-space',
      }),
    );
    expect(request.notCalled).to.equal(true);
  });

  it('accepts the live managed-content response identifier fields', async () => {
    const source = await writeExport(root, [unnamedItem('primary')]);
    const request = sinon.stub().callsFake((request_: { method: string; url: string }) => {
      if (request_.method === 'GET') return failedRequest(404);
      return fakeRequest({
        contentKey: 'key',
        managedContentId: 'managed-content-id',
        managedContentVariantId: 'managed-variant-id',
      });
    });
    const result = await executeWorkspaceImport({
      connection: { request },
      destinationOrgId: '00D-org-id',
      destinationWorkspace: workspace(),
      reportDirectory: path.join(root, 'live-shape-report'),
      sourceDirectory: source,
      workspaceId: 'destination-space',
    });

    expect(result.report?.createdParents).to.deep.equal([
      {
        childVariantIds: [],
        contentId: 'managed-content-id',
        contentKey: 'key',
        primaryVariantId: 'managed-variant-id',
      },
    ]);
  });

  it('persists each parent before its child and journals a child mutation failure', async () => {
    const source = await writeExport(root, [unnamedItem('primary'), unnamedItem('french', 'fr')]);
    const request = requestRouter({ childFailure: true });
    const reportDirectory = path.join(root, 'report');

    await expectRejected(
      executeWorkspaceImport({
        connection: { request },
        destinationOrgId: '00D-org-id',
        destinationWorkspace: workspace(),
        reportDirectory,
        sourceDirectory: source,
        workspaceId: 'destination-space',
      }),
    );

    const report = JSON.parse(
      await readFile(path.join(reportDirectory, 'workspace-import-run.json'), 'utf8'),
    );
    expect(report.state).to.equal('failed');
    expect(report.createdParents[0]).to.include({
      contentId: 'content-1',
      primaryVariantId: 'primary-1',
    });
    expect(report.operations[1]).to.include({
      contentKey: 'key',
      destinationOrgId: '00D-org-id',
      destinationWorkspaceId: 'destination-space',
      error: 'child failed',
      language: 'fr',
      operationKind: 'create-child',
      state: 'failed',
    });
    expect(request.getCalls().filter(({ args }) => args[0].method === 'POST')).to.have.length(2);
  });

  it('journals a parent mutation failure without recording created ownership', async () => {
    const source = await writeExport(root, [unnamedItem('primary')]);
    const request = sinon
      .stub()
      .callsFake((request_: { method: string }) =>
        request_.method === 'GET' ? failedRequest(404) : failedRequest(500, 'parent failed'),
      );
    const reportDirectory = path.join(root, 'parent-mutation-failure');

    await expectRejected(
      executeWorkspaceImport({
        connection: { request },
        destinationOrgId: '00D-org-id',
        destinationWorkspace: workspace(),
        reportDirectory,
        sourceDirectory: source,
        workspaceId: 'destination-space',
      }),
    );

    const report = JSON.parse(
      await readFile(path.join(reportDirectory, 'workspace-import-run.json'), 'utf8'),
    );
    expect(report).to.include({ state: 'failed' });
    expect(report.createdParents).to.deep.equal([]);
    expect(report.operations[0]).to.include({
      contentKey: 'key',
      error: 'parent failed',
      language: 'en',
      operationKind: 'create-parent',
      state: 'failed',
    });
  });

  it('makes no mutation when report creation fails', async () => {
    const source = await writeExport(root, [unnamedItem('primary')]);
    const request = requestRouter();
    const reportDirectory = path.join(root, 'existing-report');
    await mkdir(reportDirectory);

    await expectRejected(
      executeWorkspaceImport({
        connection: { request },
        destinationOrgId: '00D-org-id',
        destinationWorkspace: workspace(),
        reportDirectory,
        sourceDirectory: source,
        workspaceId: 'destination-space',
      }),
    );
    expect(request.getCalls().filter(({ args }) => args[0].method === 'POST')).to.have.length(0);
  });

  it('persists parent and child pending intent before each mutation', async () => {
    const source = await writeExport(root, [unnamedItem('primary'), unnamedItem('french', 'fr')]);
    const request = requestRouter();
    const snapshots: unknown[] = [];
    const reportDirectory = path.join(root, 'intent-report');

    await executeWorkspaceImport({
      connection: { request },
      destinationOrgId: '00D-org-id',
      destinationWorkspace: workspace(),
      reportDirectory,
      reportPersistence: {
        rewrite: async (file, report) => {
          snapshots.push(structuredClone(report));
          await writeFile(file, `${JSON.stringify(report, null, 2)}\n`);
        },
      },
      sourceDirectory: source,
      workspaceId: 'destination-space',
    });

    const pending = snapshots
      .flatMap(
        (snapshot) => (snapshot as { operations: Array<Record<string, unknown>> }).operations,
      )
      .filter(({ state }) => state === 'pending');
    expect(pending.map(({ operationKind }) => operationKind)).to.include.members([
      'create-parent',
      'create-child',
    ]);
    for (const operation of pending) {
      expect(operation).to.include({
        contentKey: 'key',
        destinationOrgId: '00D-org-id',
        destinationWorkspaceId: 'destination-space',
      });
      expect(operation.operationId).to.match(/^[a-f\d]{64}$/u);
      expect(operation.requestSha256).to.match(/^[a-f\d]{64}$/u);
      expect(operation.requestIdentity).to.be.a('string').and.not.equal('');
      expect(operation.runId).to.be.a('string').and.not.equal('');
    }
  });

  for (const [name, items, failCall, expectedPosts] of [
    ['parent', [unnamedItem('primary')], 1, 0],
    ['child', [unnamedItem('primary'), unnamedItem('french', 'fr')], 3, 1],
  ] as const) {
    it(`makes no ${name} mutation when its pending journal write fails`, async () => {
      const source = await writeExport(root, items);
      const request = requestRouter();
      let writes = 0;

      await expectRejected(
        executeWorkspaceImport({
          connection: { request },
          destinationOrgId: '00D-org-id',
          destinationWorkspace: workspace(),
          reportDirectory: path.join(root, `${name}-pre-failure`),
          reportPersistence: {
            rewrite: async (file, report) => {
              writes += 1;
              if (writes === failCall) throw new Error('journal unavailable');
              await writeFile(file, `${JSON.stringify(report, null, 2)}\n`);
            },
          },
          sourceDirectory: source,
          workspaceId: 'destination-space',
        }),
      );
      expect(request.getCalls().filter(({ args }) => args[0].method === 'POST')).to.have.length(
        expectedPosts,
      );
    });
  }

  for (const [name, items, failCall, expectedKind, expectedPosts] of [
    ['parent', [unnamedItem('primary')], 2, 'create-parent', 1],
    ['child', [unnamedItem('primary'), unnamedItem('french', 'fr')], 4, 'create-child', 2],
  ] as const) {
    it(`surfaces ownership uncertainty after successful ${name} mutation result persistence fails`, async () => {
      const source = await writeExport(root, items);
      const request = requestRouter();
      const reportDirectory = path.join(root, `${name}-post-failure`);
      let writes = 0;

      try {
        await executeWorkspaceImport({
          connection: { request },
          destinationOrgId: '00D-org-id',
          destinationWorkspace: workspace(),
          reportDirectory,
          reportPersistence: {
            rewrite: async (file, report) => {
              writes += 1;
              if (writes === failCall) throw new Error('result write unavailable');
              await writeFile(file, `${JSON.stringify(report, null, 2)}\n`);
            },
          },
          sourceDirectory: source,
          workspaceId: 'destination-space',
        });
        expect.fail('expected ownership uncertainty');
      } catch (error) {
        expect(error).to.be.instanceOf(WorkspaceImportOwnershipUncertainError);
        expect((error as WorkspaceImportOwnershipUncertainError).state).to.equal(
          'ownership-uncertain',
        );
        expect((error as WorkspaceImportOwnershipUncertainError).operation).to.include({
          contentKey: 'key',
          operationKind: expectedKind,
          state: 'pending',
        });
      }
      expect(request.getCalls().filter(({ args }) => args[0].method === 'POST')).to.have.length(
        expectedPosts,
      );
      const durable = JSON.parse(
        await readFile(path.join(reportDirectory, 'workspace-import-run.json'), 'utf8'),
      );
      expect(durable.state).to.equal('ownership-uncertain');
      expect(durable.operations.at(-1)).to.include({
        operationKind: expectedKind,
        state: 'pending',
      });
    });
  }
});
