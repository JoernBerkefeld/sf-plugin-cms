import { TestContext } from '@salesforce/core/testSetup';
import { expect } from 'chai';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sinon from 'sinon';
import { writeEditableRawHtml } from '../../src/services/editable-raw-html-export.js';
import { exportWorkspace } from '../../src/services/export-workspace.js';
import type { WorkspaceImportResult } from '../../src/contracts/workspace-import.js';
import { formDetail } from '../fixtures/form.js';
import { formHandlerDetail } from '../fixtures/form-handler.js';
import { loadWorkspaceExport } from '../../src/services/import-workspace.js';

function v1Result(result: Awaited<ReturnType<ImportWorkspace['run']>>): WorkspaceImportResult {
  return result.result as WorkspaceImportResult;
}
import ImportWorkspace from '../../src/commands/cms/import/workspace.js';

const SOURCE_IMAGE_CONTENT_KEY = 'MCAAAAAAAAAAAAAAAAAAAAAAAAAA';
const FRESH_IMAGE_CONTENT_KEY = 'MCBBBBBBBBBBBBBBBBBBBBBBBBBB';

type FakeRequest<T> = Promise<T> & { stream(): { destroy(): void } };

function fakeRequest<T>(value: T): FakeRequest<T> {
  return Object.assign(Promise.resolve(value), { stream: () => ({ destroy: () => {} }) });
}

function missingRequest(): FakeRequest<never> {
  return Object.assign(Promise.reject(Object.assign(new Error('not found'), { statusCode: 404 })), {
    stream: () => ({ destroy: () => {} }),
  });
}

async function writeFormHandlerCommandSource(
  root: string,
): Promise<{ mapFile: string; source: string }> {
  const source = path.join(root, 'form-handler-source');
  const request = sinon.stub().callsFake(({ method, url }: { method: string; url: string }) => {
    if (method !== 'GET') return missingRequest();
    if (url.startsWith('/connect/cms/items/search')) {
      return fakeRequest({
        items: [
          {
            id: 'variant-form-handler-id',
            managedContentSpaceId: 'source-space',
            type: 'ManagedContentVariantSearchResultRepresentation',
          },
        ],
        total: 1,
      });
    }
    return fakeRequest(formHandlerDetail('variant'));
  });
  await exportWorkspace({ request }, 'source-space', source, {
    selection: {
      contentType: 'sfdc_cms__formHandler',
      apiNames: ['source_form_handler_api'],
      formHandlerReports: true,
    },
  });
  const manifestFile = path.join(source, 'manifest.json');
  const strictManifest = JSON.parse(await readFile(manifestFile, 'utf8')) as {
    warnings: unknown[];
  };
  strictManifest.warnings = [];
  await writeFile(manifestFile, `${JSON.stringify(strictManifest)}\n`);
  const mapFile = path.join(root, 'form-handler-map.json');
  await writeFile(
    mapFile,
    `${JSON.stringify([
      {
        source: { family: 'cms', type: 'formHandler', apiName: 'source_form_handler_api' },
        target: {
          apiName: 'target_form_handler_api',
          title: 'Target form handler',
          urlName: 'target-form-handler',
        },
      },
    ])}\n`,
  );
  return { mapFile, source };
}

async function writeFormCommandSource(root: string): Promise<{ mapFile: string; source: string }> {
  const source = path.join(root, 'form-source');
  const request = sinon.stub().callsFake(({ method, url }: { method: string; url: string }) => {
    if (method !== 'GET') return missingRequest();
    if (url.startsWith('/connect/cms/items/search')) {
      return fakeRequest({
        items: [
          {
            id: 'variant-form-id',
            managedContentSpaceId: 'source-space',
            type: 'ManagedContentVariantSearchResultRepresentation',
          },
        ],
        total: 1,
      });
    }
    return fakeRequest(formDetail('variant'));
  });
  await exportWorkspace({ request }, 'source-space', source, {
    selection: {
      contentType: 'sfdc_cms__form',
      apiNames: ['source_form_api'],
      formReports: true,
    },
  });
  const manifestFile = path.join(source, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestFile, 'utf8')) as Record<string, unknown>;
  manifest.completeness = 'partial';
  await writeFile(manifestFile, `${JSON.stringify(manifest)}\n`);
  const mapFile = path.join(root, 'form-map.json');
  await writeFile(
    mapFile,
    `${JSON.stringify([
      {
        source: { family: 'cms', type: 'form', apiName: 'source_form_api' },
        target: { apiName: 'target_form_api', title: 'Target form', urlName: 'target-form' },
      },
    ])}\n`,
  );
  return { mapFile, source };
}

async function writeSource(root: string, named = true, native = false): Promise<string> {
  const source = path.join(root, 'source');
  await mkdir(path.join(source, 'items'), { recursive: true });
  const exported = {
    ...(named ? { apiName: 'command_api', urlName: 'command-url' } : {}),
    contentBody: native
      ? {
          'sfdc_cms:title': 'Command title',
          subjectLine: 'Subject',
          messagePurpose: 'promotional',
          rawHtml: '<p>Command body</p>',
        }
      : { body: 'command body' },
    contentKey: 'command-key',
    contentSpace: { id: 'source-space' },
    contentType: native ? 'sfdc_cms__email' : 'sfdc_cms__news',
    id: 'source-variant',
    language: 'en',
    title: 'Command title',
  };
  const itemBytes = `${JSON.stringify(exported)}\n`;
  await writeFile(path.join(source, 'items', 'source-variant.json'), itemBytes);
  const referenceId = `ref:${createHash('sha256')
    .update(
      JSON.stringify({
        kind: 'cms.content',
        sourceId: 'command-key',
        workspaceId: 'source-space',
      }),
    )
    .digest('hex')}`;
  await writeFile(
    path.join(source, 'manifest.json'),
    `${JSON.stringify({
      entries: [{ file: 'items/source-variant.json', variantId: 'source-variant' }],
      expectedCount: 1,
      exportedCount: 1,
      failedVariantIds: [],
      foundCount: 1,
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
      externalReferences: [
        {
          referenceId,
          owner: 'cms',
          kind: 'cms.content',
          source: { workspaceId: 'source-space', sourceId: 'command-key' },
          portableKey: { scheme: 'cms-opaque-v1', value: 'command-key' },
          required: true,
          resolution: 'included',
        },
      ],
      items: [
        {
          path: 'items/source-variant.json',
          sha256: createHash('sha256').update(itemBytes).digest('hex'),
          kind: 'cms.content',
          referenceId,
        },
      ],
    })}\n`,
  );
  return source;
}

async function addPreferencePageReadReport(source: string): Promise<void> {
  const manifestFile = path.join(source, 'manifest.json');
  const value = JSON.parse(await readFile(manifestFile, 'utf8')) as {
    completeness: string;
    entries: Array<{ file: string; variantId: string }>;
    items: Array<{ path: string; sha256: string; kind: string; referenceId?: string }>;
    preferencePageReports?: unknown[];
    workspaceId: string;
  };
  const variantId = value.entries[0].variantId;
  const reportPath = `reports/preference-pages/${variantId}.json`;
  const reportBytes = '{"format":"sf-cms-preference-page-read-report@1"}\n';
  await mkdir(path.join(source, 'reports', 'preference-pages'), { recursive: true });
  await writeFile(path.join(source, ...reportPath.split('/')), reportBytes);
  value.completeness = 'partial';
  value.preferencePageReports = [
    {
      path: reportPath,
      rawItemPath: `items/${variantId}.json`,
      workspaceId: value.workspaceId,
      contentType: 'sfdc_cms__preferencePage',
      variantId,
      apiName: 'PreferencePage',
      format: 'sf-cms-preference-page-read-report@1',
    },
  ];
  value.items.push({
    path: reportPath,
    sha256: createHash('sha256').update(reportBytes).digest('hex'),
    kind: 'cms.preference-page.read-report',
  });
  await writeFile(manifestFile, `${JSON.stringify(value)}\n`);
}

async function addBrandReadReport(source: string): Promise<void> {
  const manifestFile = path.join(source, 'manifest.json');
  const value = JSON.parse(await readFile(manifestFile, 'utf8')) as {
    entries: Array<{ file: string; variantId: string }>;
    items: Array<{ path: string; sha256: string; kind: string; referenceId?: string }>;
    brandReports?: unknown[];
    workspaceId: string;
  };
  const variantId = value.entries[0].variantId;
  const reportPath = `reports/brands/${variantId}.json`;
  const reportBytes = '{"format":"sf-cms-brand-read-report@1"}\n';
  await mkdir(path.join(source, 'reports', 'brands'), { recursive: true });
  await writeFile(path.join(source, ...reportPath.split('/')), reportBytes);
  value.brandReports = [
    {
      path: reportPath,
      rawItemPath: `items/${variantId}.json`,
      workspaceId: value.workspaceId,
      contentType: 'sfdc_cms__brand',
      variantId,
      apiName: 'Brand',
      format: 'sf-cms-brand-read-report@1',
    },
  ];
  value.items.push({
    path: reportPath,
    sha256: createHash('sha256').update(reportBytes).digest('hex'),
    kind: 'cms.brand.read-report',
  });
  await writeFile(manifestFile, `${JSON.stringify(value)}\n`);
}

async function writeImageSource(root: string): Promise<{ mapFile: string; source: string }> {
  const source = path.join(root, 'image-source');
  await mkdir(path.join(source, 'items'), { recursive: true });
  await mkdir(path.join(source, 'media'), { recursive: true });
  const image = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const item = {
    apiName: 'source_image',
    contentBody: { 'sfdc_cms:media': { source: { type: 'file' } } },
    contentKey: SOURCE_IMAGE_CONTENT_KEY,
    contentSpace: { id: 'source-space' },
    contentType: 'sfdc_cms__image',
    id: 'source-image-variant',
    language: 'en',
    title: 'Source image',
  };
  const itemBytes = Buffer.from(`${JSON.stringify(item)}\n`);
  await writeFile(path.join(source, 'items/source-image-variant.json'), itemBytes);
  await writeFile(path.join(source, 'media/source-image-variant.png'), image);
  const media = {
    variantId: item.id,
    contentKey: item.contentKey,
    path: 'media/source-image-variant.png',
    sha256: createHash('sha256').update(image).digest('hex'),
    md5: createHash('md5').update(image).digest('hex'),
    bytes: image.length,
    mimeType: 'image/png',
    fileName: 'source-image-variant.png',
    sourceStatus: 'Draft',
    sourceModifiedAt: '2026-01-01T00:00:00.000Z',
    sourceVersion: '1',
    sourceUrl: '/cms/media/source-image-key',
    transport: 'experimental-undocumented-authoring-media',
  };
  await writeFile(
    path.join(source, 'manifest.json'),
    `${JSON.stringify({
      schemaVersion: 2,
      mode: 'experimental-best-effort',
      workspaceId: 'source-space',
      search: {
        contentSpaceOrFolderIds: ['source-space'],
        languages: ['All'],
        pageSize: 250,
        queryTerm: '*',
      },
      expectedCount: 1,
      foundCount: 1,
      exportedCount: 1,
      pagesRequested: 1,
      entries: [{ file: 'items/source-image-variant.json', variantId: item.id }],
      rejectedVariantIds: [],
      failedVariantIds: [],
      warnings: [{ code: 'UNSUPPORTED_WILDCARD', message: 'provenance only' }],
      contract: 'sf-cms-workspace-export',
      contractVersion: '2.0.0',
      media: [media],
      provenance: {
        producer: 'sf-plugin-cms',
        sourceOrgId: '00D-source',
        sourceWorkspaceId: 'source-space',
        pluginVersion: '0.4.0',
        generatedAt: '2026-09-13T18:00:00.000Z',
      },
      completeness: 'complete',
      dependencies: [],
      externalReferences: [],
      items: [
        {
          path: 'items/source-image-variant.json',
          sha256: createHash('sha256').update(itemBytes).digest('hex'),
          kind: 'cms.content',
        },
        { path: media.path, sha256: media.sha256, kind: 'cms.media' },
      ],
    })}\n`,
  );
  const mapFile = path.join(root, 'image-map.json');
  await writeFile(
    mapFile,
    JSON.stringify([
      {
        source: { family: 'cms', type: 'image', apiName: item.apiName },
        contentKey: { strategy: 'fresh', value: FRESH_IMAGE_CONTENT_KEY },
        apiName: { strategy: 'fresh', value: 'fresh_image' },
        title: { strategy: 'fresh', value: 'Fresh image' },
        urlName: { strategy: 'generated' },
      },
    ]),
  );
  return { mapFile, source };
}

describe('CMS import workspace command', () => {
  const $$ = new TestContext();
  const temporaryDirectories: string[] = [];

  beforeEach(() => {
    process.exitCode = undefined;
  });

  afterEach(async () => {
    process.exitCode = undefined;
    $$.restore();
    await Promise.all(
      temporaryDirectories
        .splice(0)
        .map((directory) => rm(directory, { force: true, recursive: true })),
    );
  });

  it('defines the requested create-only safety flags', () => {
    expect(Object.keys(ImportWorkspace.flags)).to.have.members([
      'target-org',
      'api-version',
      'contract-version',
      'workspace-id',
      'workspace-name',
      'source-dir',
      'native-copy-map',
      'email-fragment-map',
      'web-fragment-map',
      'landing-page-template-map',
      'landing-page-map',
      'form-map',
      'form-handler-map',
      'consent-banner-map',
      'brand-map',
      'preference-page-map',
      'image-map',
      'editable-dir',
      'apply',
      'allow-partial',
      'report-dir',
    ]);
    expect(ImportWorkspace.flags['target-org'].required).to.equal(true);
    expect(ImportWorkspace.flags['workspace-id'].required).not.to.equal(true);
    expect(ImportWorkspace.flags['workspace-name'].required).not.to.equal(true);
    expect(ImportWorkspace.flags['source-dir'].required).to.equal(true);
    expect(ImportWorkspace.flags.apply.default).to.equal(false);
    expect(ImportWorkspace.flags['report-dir'].dependsOn).to.deep.equal(['apply']);
    expect(ImportWorkspace.flags['editable-dir'].dependsOn).to.deep.equal(['native-copy-map']);
    const familyFlags = [
      'native-copy-map',
      'email-fragment-map',
      'web-fragment-map',
      'landing-page-template-map',
      'landing-page-map',
      'form-map',
      'form-handler-map',
      'consent-banner-map',
      'brand-map',
      'preference-page-map',
      'image-map',
    ];
    const flags = ImportWorkspace.flags as Record<string, { exclusive?: string[] }>;
    for (const flag of familyFlags) {
      for (const other of familyFlags) {
        if (other !== flag) expect(flags[flag].exclusive).to.include(other);
      }
    }
    expect(ImportWorkspace.flags['preference-page-map'].summary).to.match(
      /channel\/subchannel ID mappings/iu,
    );
    expect(ImportWorkspace.flags['landing-page-map'].exclusive).to.include('editable-dir');
    expect(ImportWorkspace.flags['image-map'].exclusive).to.include('editable-dir');
    expect(ImportWorkspace.flags['email-fragment-map'].summary).to.match(
      /exact typed cms\/emailFragment API names/iu,
    );
    expect(ImportWorkspace.summary).to.match(/create-only/iu);
    expect(ImportWorkspace.description).to.match(/destination-default-language Drafts/iu);
  });

  it('executes the explicit native-copy-map file through the public command', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'cms-command-native-'));
    temporaryDirectories.push(root);
    const source = await writeSource(root, true, true);
    const mapFile = path.join(root, 'copy.json');
    await writeFile(
      mapFile,
      JSON.stringify([
        {
          sourceContentKey: 'command-key',
          language: 'en',
          apiName: 'fresh_api',
          urlName: 'fresh-url',
        },
      ]),
    );
    let posted: Record<string, unknown> = {};
    const request = $$.SANDBOX.stub().callsFake(
      ({ method, url, body }: { method: string; url: string; body?: string }) => {
        if (url === '/connect/cms/spaces/space')
          return fakeRequest({ id: 'space', defaultLanguage: 'en', rootFolderId: 'root' });
        if (method === 'POST') {
          posted = JSON.parse(body!) as Record<string, unknown>;
          return fakeRequest({
            contentKey: 'generated',
            managedContentId: 'new-id',
            managedContentVariantId: 'new-variant',
          });
        }
        return fakeRequest({
          ...posted,
          contentKey: 'generated',
          managedContentId: 'new-id',
          language: 'en',
          contentSpace: { id: 'space' },
          isPublished: false,
          status: { status: 'Draft' },
        });
      },
    );
    const command = Object.create(ImportWorkspace.prototype) as ImportWorkspace;
    Object.assign(command, {
      parse: $$.SANDBOX.stub().resolves({
        flags: {
          apply: true,
          'api-version': '66.0',
          'source-dir': source,
          'workspace-id': 'space',
          'native-copy-map': mapFile,
          'report-dir': path.join(root, 'report'),
        },
      }),
      getOrgContext: $$.SANDBOX.stub().resolves({ connection: { request }, orgId: 'org' }),
      jsonEnabled: $$.SANDBOX.stub().returns(true),
    });
    const result = await command.run();
    expect(result.status).to.equal('success');
    expect(posted).not.to.have.property('contentKey');
    expect(v1Result(result).mappings[0].target.targetReference).to.equal('generated');
  });

  for (const failure of [
    'none',
    'missing map',
    'metadata',
    'baseline',
    'missing HTML',
    'default language',
  ]) {
    it(`preflights public editable input and preserves literal POST: ${failure}`, async () => {
      const root = await mkdtemp(path.join(tmpdir(), 'cms-command-editable-'));
      temporaryDirectories.push(root);
      const source = await writeSource(root, true, true);
      const loaded = await loadWorkspaceExport(source);
      const originalFile = path.join(source, 'items/source-variant.json');
      const raw = JSON.parse(await readFile(originalFile, 'utf8')) as Record<string, unknown>;
      const editable = path.join(root, 'editable');
      await writeEditableRawHtml(
        [{ variantId: 'source-variant', raw }],
        loaded.manifestSha256,
        editable,
      );
      const html = '&lt;p&gt;literal edited text&lt;/p&gt;';
      await writeFile(path.join(editable, 'items/source-variant.html'), html);
      if (failure === 'metadata')
        await writeFile(path.join(editable, 'items/source-variant.json'), '{}');
      if (failure === 'baseline') await writeFile(originalFile, '{}');
      if (failure === 'missing HTML') await rm(path.join(editable, 'items/source-variant.html'));
      const mapFile = path.join(root, 'copy.json');
      await writeFile(
        mapFile,
        JSON.stringify([
          {
            sourceContentKey: 'command-key',
            language: 'en',
            apiName: 'fresh_api',
            urlName: 'fresh-url',
          },
        ]),
      );
      let posted: Record<string, unknown> = {};
      const request = $$.SANDBOX.stub().callsFake(
        ({ method, url, body }: { method: string; url: string; body?: string }) => {
          if (url === '/connect/cms/spaces/space')
            return fakeRequest({
              id: 'space',
              defaultLanguage: failure === 'default language' ? 'fr' : 'en',
              rootFolderId: 'root',
            });
          if (method === 'POST') {
            posted = JSON.parse(body!) as Record<string, unknown>;
            return fakeRequest({
              contentKey: 'generated',
              managedContentId: 'new-id',
              managedContentVariantId: 'new-variant',
            });
          }
          return fakeRequest({
            ...posted,
            contentKey: 'generated',
            managedContentId: 'new-id',
            language: 'en',
            contentSpace: { id: 'space' },
            isPublished: false,
            status: { status: 'Draft' },
          });
        },
      );
      const getOrgContext = $$.SANDBOX.stub().resolves({ connection: { request }, orgId: 'org' });
      const command = Object.create(ImportWorkspace.prototype) as ImportWorkspace;
      Object.assign(command, {
        parse: $$.SANDBOX.stub().resolves({
          flags: {
            apply: true,
            'api-version': '66.0',
            'source-dir': source,
            'editable-dir': editable,
            'workspace-id': 'space',
            ...(failure === 'missing map' ? {} : { 'native-copy-map': mapFile }),
            'report-dir': path.join(root, 'report'),
          },
        }),
        getOrgContext,
        jsonEnabled: $$.SANDBOX.stub().returns(true),
      });
      const result = await command.run();
      if (failure === 'none') {
        expect(result.status).to.equal('success');
        expect((posted.contentBody as Record<string, unknown>).rawHtml).to.equal(html);
        expect(request.getCalls().filter((call) => call.args[0].method === 'POST')).to.have.length(
          1,
        );
        expect(result.diagnostics.warnings[0].code).to.equal('EDITABLE_HTML_INPUT');
        expect(v1Result(result).integrity.verifiedItemCount).to.equal(1);
      } else {
        expect(result.result).to.equal(null);
        expect(request.getCalls().filter((call) => call.args[0].method === 'POST')).to.have.length(
          0,
        );
        if (failure !== 'default language') expect(getOrgContext.notCalled).to.equal(true);
      }
    });
  }

  it('blocks a malformed image content key before org context', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'cms-command-image-invalid-key-'));
    temporaryDirectories.push(root);
    const { mapFile, source } = await writeImageSource(root);
    const mappings = JSON.parse(await readFile(mapFile, 'utf8')) as Array<{
      contentKey: { strategy: string; value: string };
    }>;
    mappings[0].contentKey.value = 'fresh-image-key';
    await writeFile(mapFile, JSON.stringify(mappings));
    const getOrgContext = $$.SANDBOX.stub();
    const command = Object.create(ImportWorkspace.prototype) as ImportWorkspace;
    Object.assign(command, {
      parse: $$.SANDBOX.stub().resolves({
        flags: {
          apply: true,
          'api-version': '67.0',
          'contract-version': 2,
          'image-map': mapFile,
          'report-dir': path.join(root, 'report'),
          'source-dir': source,
          'workspace-id': 'space',
        },
      }),
      getOrgContext,
      jsonEnabled: $$.SANDBOX.stub().returns(true),
    });

    const result = await command.run();

    expect(result).to.deep.include({ contractVersion: '2.0.0', status: 'blocked', result: null });
    expect(result.diagnostics.errors[0]).to.include({ code: 'PACKAGE_VALIDATION_FAILED' });
    expect(result.diagnostics.errors[0].message).to.include('must match ^MC[A-Z2-7]{26}$');
    expect(getOrgContext.notCalled).to.equal(true);
    let reportExists = true;
    try {
      await readFile(path.join(root, 'report', 'workspace-import-run.json'));
    } catch (error) {
      reportExists = (error as NodeJS.ErrnoException).code !== 'ENOENT';
    }
    expect(reportExists).to.equal(false);
  });

  it('runs the v2 image profile as dry-run preflight without mutation', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'cms-command-image-'));
    temporaryDirectories.push(root);
    const { mapFile, source } = await writeImageSource(root);
    const request = $$.SANDBOX.stub().callsFake(
      ({ method, url }: { method: string; url: string }) => {
        if (url === '/connect/cms/spaces/space') return fakeRequest({ id: 'space' });
        if (url.startsWith('/connect/cms/items/search'))
          return fakeRequest({ items: [], total: 0 });
        if (url === `/connect/cms/contents/${FRESH_IMAGE_CONTENT_KEY}`) return missingRequest();
        throw new Error(`Unexpected request: ${method} ${url}`);
      },
    );
    const command = Object.create(ImportWorkspace.prototype) as ImportWorkspace;
    Object.assign(command, {
      parse: $$.SANDBOX.stub().resolves({
        flags: {
          apply: false,
          'api-version': '67.0',
          'contract-version': 2,
          'image-map': mapFile,
          'source-dir': source,
          'workspace-id': 'space',
        },
      }),
      getOrgContext: $$.SANDBOX.stub().resolves({ connection: { request }, orgId: '00D-org' }),
      jsonEnabled: $$.SANDBOX.stub().returns(true),
    });

    const result = await command.run();

    expect(result).to.deep.include({
      contract: 'sf-cms-workspace-import@2',
      contractVersion: '2.0.0',
      status: 'success',
    });
    expect(result.result).to.deep.include({ status: 'planned' });
    expect((result.result as { assets: unknown[] }).assets).to.have.length(1);
    expect(request.getCalls().every(({ args }) => args[0].method === 'GET')).to.equal(true);
  });

  it('applies the v2 image profile only with a new report directory', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'cms-command-image-apply-'));
    temporaryDirectories.push(root);
    const { mapFile, source } = await writeImageSource(root);
    const reportDirectory = path.join(root, 'image-report');
    let searches = 0;
    const request = $$.SANDBOX.stub().callsFake(
      ({ method, url }: { method: string; url: string }) => {
        if (url === '/connect/cms/spaces/space') return fakeRequest({ id: 'space' });
        if (url.startsWith('/connect/cms/items/search')) {
          searches += 1;
          return fakeRequest({ items: [], total: 0 });
        }
        if (url === `/connect/cms/contents/${FRESH_IMAGE_CONTENT_KEY}`) return missingRequest();
        if (url === '/connect/cms/contents' && method === 'POST') {
          return fakeRequest({
            contentKey: FRESH_IMAGE_CONTENT_KEY,
            managedContentId: 'image-content',
            managedContentVariantId: 'image-variant',
          });
        }
        if (url === '/connect/cms/contents/variants/image-variant') {
          return fakeRequest({
            managedContentId: 'image-content',
            managedContentVariantId: 'image-variant',
            apiName: 'fresh_image',
            contentKey: FRESH_IMAGE_CONTENT_KEY,
            title: 'Fresh image',
            urlName: 'generated-image-url',
            contentSpace: { id: 'space' },
            contentType: 'sfdc_cms__image',
            isPublished: false,
            status: { status: 'Draft' },
          });
        }
        throw new Error(`Unexpected request: ${method} ${url}`);
      },
    );
    const command = Object.create(ImportWorkspace.prototype) as ImportWorkspace;
    Object.assign(command, {
      parse: $$.SANDBOX.stub().resolves({
        flags: {
          apply: true,
          'api-version': '67.0',
          'contract-version': 2,
          'image-map': mapFile,
          'report-dir': reportDirectory,
          'source-dir': source,
          'workspace-id': 'space',
        },
      }),
      getOrgContext: $$.SANDBOX.stub().resolves({ connection: { request }, orgId: '00D-org' }),
      jsonEnabled: $$.SANDBOX.stub().returns(true),
    });

    const result = await command.run();

    expect(searches).to.equal(2);
    expect(result).to.deep.include({ contractVersion: '2.0.0', status: 'success' });
    expect(result.result).to.deep.include({ status: 'completed' });
    expect(
      JSON.parse(await readFile(path.join(reportDirectory, 'workspace-import-run.json'), 'utf8')),
    ).to.include({ state: 'completed' });
  });

  it('blocks image profile contract mismatch before source or org access', async () => {
    const getOrgContext = $$.SANDBOX.stub();
    const command = Object.create(ImportWorkspace.prototype) as ImportWorkspace;
    Object.assign(command, {
      parse: $$.SANDBOX.stub().resolves({
        flags: {
          apply: false,
          'api-version': '67.0',
          'contract-version': 1,
          'image-map': 'missing-map',
          'source-dir': 'missing-source',
          'workspace-id': 'space',
        },
      }),
      getOrgContext,
      jsonEnabled: $$.SANDBOX.stub().returns(true),
    });

    const result = await command.run();

    expect(result).to.deep.include({ contractVersion: '2.0.0', status: 'blocked', result: null });
    expect(result.diagnostics.errors[0]).to.include({ code: 'UNSUPPORTED_CONTRACT_VERSION' });
    expect(getOrgContext.notCalled).to.equal(true);
  });

  it('requires a report directory for apply before local or remote work', async () => {
    const command = Object.create(ImportWorkspace.prototype) as ImportWorkspace;
    const getOrgContext = $$.SANDBOX.stub();
    Object.assign(command, {
      parse: $$.SANDBOX.stub().resolves({
        flags: {
          'allow-partial': false,
          apply: true,
          'api-version': '67.0',
          'source-dir': 'missing-source',
          'target-org': 'mcnext-sdo',
          'workspace-id': 'space',
        },
      }),
      getOrgContext,
    });

    const result = await command.run();
    expect(result).to.include({ status: 'blocked', result: null });
    expect(result.diagnostics.errors[0]).to.include({ code: 'REPORT_DIRECTORY_REQUIRED' });
    expect(getOrgContext.notCalled).to.equal(true);
  });

  it('blocks unsupported contract major before source or org access', async () => {
    const command = Object.create(ImportWorkspace.prototype) as ImportWorkspace;
    const getOrgContext = $$.SANDBOX.stub();
    Object.assign(command, {
      parse: $$.SANDBOX.stub().resolves({
        flags: {
          'allow-partial': false,
          apply: false,
          'api-version': '67.0',
          'contract-version': 2,
          'source-dir': 'missing-source',
          'target-org': 'mcnext-sdo',
          'workspace-id': 'space',
        },
      }),
      getOrgContext,
      jsonEnabled: $$.SANDBOX.stub().returns(true),
    });

    const result = await command.run();

    expect(result).to.include({ status: 'blocked', result: null });
    expect(result.diagnostics.errors[0]).to.include({ code: 'UNSUPPORTED_CONTRACT_VERSION' });
    expect(getOrgContext.notCalled).to.equal(true);
  });

  for (const allowPartial of [false, true]) {
    it(`blocks typed Preference Page reports before org access or artifacts (allowPartial=${allowPartial})`, async () => {
      const root = await mkdtemp(path.join(tmpdir(), 'sf-plugin-cms-command-preference-'));
      temporaryDirectories.push(root);
      const source = await writeSource(root);
      await addPreferencePageReadReport(source);
      const reportDirectory = path.join(root, 'report');
      const getOrgContext = $$.SANDBOX.stub();
      const command = Object.create(ImportWorkspace.prototype) as ImportWorkspace;
      Object.assign(command, {
        parse: $$.SANDBOX.stub().resolves({
          flags: {
            'allow-partial': allowPartial,
            apply: true,
            'api-version': '67.0',
            'report-dir': reportDirectory,
            'source-dir': source,
            'target-org': 'mcnext-sdo',
            'workspace-id': 'space',
          },
        }),
        getOrgContext,
        jsonEnabled: $$.SANDBOX.stub().returns(true),
      });

      const result = await command.run();

      expect(result).to.include({ status: 'blocked', result: null });
      expect(result.diagnostics.errors[0]).to.include({ code: 'PACKAGE_VALIDATION_FAILED' });
      expect(result.diagnostics.errors[0].message).to.equal(
        'Typed Preference Page reports require the explicit Preference Page import profile.',
      );
      expect(getOrgContext.notCalled).to.equal(true);
      expect(await readdir(root)).to.deep.equal(['source']);
      expect(await readFile(path.join(source, 'manifest.json'), 'utf8')).to.include(
        'cms.preference-page.read-report',
      );
      let reportExists = true;
      try {
        await readFile(path.join(reportDirectory, 'workspace-import-run.json'));
      } catch (error) {
        reportExists = (error as NodeJS.ErrnoException).code !== 'ENOENT';
      }
      expect(reportExists).to.equal(false);
    });
  }

  for (const allowPartial of [false, true]) {
    it(`blocks typed Brand reports before org access or artifacts (allowPartial=${allowPartial})`, async () => {
      const root = await mkdtemp(path.join(tmpdir(), 'sf-plugin-cms-command-brand-'));
      temporaryDirectories.push(root);
      const source = await writeSource(root);
      await addBrandReadReport(source);
      const reportDirectory = path.join(root, 'report');
      const getOrgContext = $$.SANDBOX.stub();
      const command = Object.create(ImportWorkspace.prototype) as ImportWorkspace;
      Object.assign(command, {
        parse: $$.SANDBOX.stub().resolves({
          flags: {
            'allow-partial': allowPartial,
            apply: true,
            'api-version': '67.0',
            'report-dir': reportDirectory,
            'source-dir': source,
            'target-org': 'mcnext-sdo',
            'workspace-id': 'space',
          },
        }),
        getOrgContext,
        jsonEnabled: $$.SANDBOX.stub().returns(true),
      });

      const result = await command.run();

      expect(result).to.include({ status: 'blocked', result: null });
      expect(result.diagnostics.errors[0]).to.include({ code: 'PACKAGE_VALIDATION_FAILED' });
      expect(result.diagnostics.errors[0].message).to.equal(
        'Typed Brand reports require the explicit Brand import profile.',
      );
      expect(getOrgContext.notCalled).to.equal(true);
      expect(await readdir(root)).to.deep.equal(['source']);
      expect(await readFile(path.join(source, 'manifest.json'), 'utf8')).to.include(
        'cms.brand.read-report',
      );
      let reportExists = true;
      try {
        await readFile(path.join(reportDirectory, 'workspace-import-run.json'));
      } catch (error) {
        reportExists = (error as NodeJS.ErrnoException).code !== 'ENOENT';
      }
      expect(reportExists).to.equal(false);
    });
  }

  it('validates the source locally before requesting org context', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'sf-plugin-cms-command-import-'));
    temporaryDirectories.push(root);
    const source = await writeSource(root);
    await writeFile(path.join(source, 'items', 'source-variant.json'), '[]\n');
    const command = Object.create(ImportWorkspace.prototype) as ImportWorkspace;
    const getOrgContext = $$.SANDBOX.stub();
    Object.assign(command, {
      parse: $$.SANDBOX.stub().resolves({
        flags: {
          'allow-partial': false,
          apply: false,
          'api-version': '67.0',
          'source-dir': source,
          'target-org': 'mcnext-sdo',
          'workspace-id': 'space',
        },
      }),
      getOrgContext,
    });

    try {
      await command.run();
      expect.fail('expected local source validation failure');
    } catch (error) {
      expect(error).to.be.instanceOf(Error);
    }
    expect(getOrgContext.notCalled).to.equal(true);
  });

  it('loads a strict v2 package locally before org or workspace access', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'sf-plugin-cms-command-import-v2-'));
    temporaryDirectories.push(root);
    const source = await writeSource(root);
    const manifestFile = path.join(source, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestFile, 'utf8')) as Record<string, unknown>;
    manifest.schemaVersion = 2;
    manifest.contractVersion = '2.0.0';
    manifest.media = [];
    await writeFile(manifestFile, `${JSON.stringify(manifest)}\n`);
    const command = Object.create(ImportWorkspace.prototype) as ImportWorkspace;
    const getOrgContext = $$.SANDBOX.stub();
    Object.assign(command, {
      parse: $$.SANDBOX.stub().resolves({
        flags: {
          'allow-partial': false,
          apply: false,
          'api-version': '67.0',
          'source-dir': source,
          'target-org': 'mcnext-sdo',
          'workspace-id': 'space',
        },
      }),
      getOrgContext,
    });

    try {
      await command.run();
      expect.fail('expected org context to remain unavailable in this isolated command test');
    } catch (error) {
      expect(error).to.be.instanceOf(Error);
    }
    expect(getOrgContext.calledOnce).to.equal(true);
  });

  it('blocks a partial Form package before org access even with allow-partial', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'sf-plugin-cms-command-form-partial-'));
    temporaryDirectories.push(root);
    const { mapFile, source } = await writeFormCommandSource(root);
    const command = Object.create(ImportWorkspace.prototype) as ImportWorkspace;
    const getOrgContext = $$.SANDBOX.stub();
    Object.assign(command, {
      parse: $$.SANDBOX.stub().resolves({
        flags: {
          'allow-partial': true,
          apply: false,
          'api-version': '67.0',
          'form-map': mapFile,
          'source-dir': source,
          'target-org': 'mcnext-sdo',
          'workspace-id': 'space',
        },
      }),
      getOrgContext,
      jsonEnabled: $$.SANDBOX.stub().returns(true),
    });

    const result = await command.run();

    expect(result).to.include({ status: 'blocked', result: null });
    expect(result.diagnostics.errors[0]).to.include({ code: 'PACKAGE_VALIDATION_FAILED' });
    expect(result.diagnostics.errors[0].message).to.equal(
      'Form profile requires a complete workspace export',
    );
    expect(getOrgContext.notCalled).to.equal(true);
  });

  for (const profile of ['form', 'form-handler'] as const) {
    it(`requires canonical structured Marketing evidence for ${profile} import`, async () => {
      const root = await mkdtemp(path.join(tmpdir(), `sf-plugin-cms-command-${profile}-space-`));
      temporaryDirectories.push(root);
      const { mapFile, source } =
        profile === 'form'
          ? await writeFormCommandSource(root)
          : await writeFormHandlerCommandSource(root);
      if (profile === 'form') {
        const manifestFile = path.join(source, 'manifest.json');
        const manifest = JSON.parse(await readFile(manifestFile, 'utf8')) as Record<
          string,
          unknown
        >;
        manifest.completeness = 'complete';
        await writeFile(manifestFile, `${JSON.stringify(manifest)}\n`);
      }
      const request = $$.SANDBOX.stub().callsFake(({ url }: { url: string }) => {
        if (url === '/connect/cms/spaces/space') {
          return fakeRequest({
            defaultLanguage: 'en',
            id: 'space',
            rootFolderId: 'root',
            spaceType: 'Marketing',
          });
        }
        return missingRequest();
      });
      const command = Object.create(ImportWorkspace.prototype) as ImportWorkspace;
      Object.assign(command, {
        parse: $$.SANDBOX.stub().resolves({
          flags: {
            'allow-partial': false,
            apply: false,
            'api-version': '67.0',
            [profile === 'form' ? 'form-map' : 'form-handler-map']: mapFile,
            'source-dir': source,
            'target-org': 'mcnext-sdo',
            'workspace-id': 'space',
          },
        }),
        getOrgContext: $$.SANDBOX.stub().resolves({ connection: { request }, orgId: '00D-org' }),
        jsonEnabled: $$.SANDBOX.stub().returns(true),
      });

      const result = await command.run();
      expect(result).to.include({ status: 'failed', result: null });
      expect(result.diagnostics.errors[0].message).to.include('not canonically Marketing');
      expect(request.calledOnce).to.equal(true);
    });
  }

  it('keeps a pre-mutation Form workspace failure definitive without claiming a journal', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'sf-plugin-cms-command-form-workspace-'));
    temporaryDirectories.push(root);
    const { mapFile, source } = await writeFormCommandSource(root);
    const manifestFile = path.join(source, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestFile, 'utf8')) as Record<string, unknown>;
    manifest.completeness = 'complete';
    await writeFile(manifestFile, `${JSON.stringify(manifest)}\n`);
    const reportDirectory = path.join(root, 'report');
    const request = $$.SANDBOX.stub().returns(
      Object.assign(
        Promise.reject(Object.assign(new Error('workspace unavailable'), { statusCode: 503 })),
        { stream: () => ({ destroy: () => {} }) },
      ),
    );
    const command = Object.create(ImportWorkspace.prototype) as ImportWorkspace;
    Object.assign(command, {
      parse: $$.SANDBOX.stub().resolves({
        flags: {
          'allow-partial': false,
          apply: true,
          'api-version': '67.0',
          'form-map': mapFile,
          'report-dir': reportDirectory,
          'source-dir': source,
          'target-org': 'mcnext-sdo',
          'workspace-id': 'space',
        },
      }),
      getOrgContext: $$.SANDBOX.stub().resolves({ connection: { request }, orgId: '00D-org' }),
      jsonEnabled: $$.SANDBOX.stub().returns(true),
    });

    const result = await command.run();

    expect(result).to.include({ status: 'failed', result: null });
    expect(result.diagnostics.errors[0]).to.include({ code: 'IMPORT_FAILED', retryable: false });
    expect(result.diagnostics.errors[0].message).to.equal('workspace unavailable');
    expect(result.diagnostics.errors[0].message).not.to.include('journal');
    let journalExists = true;
    try {
      await readFile(path.join(reportDirectory, 'workspace-import-run.json'));
    } catch (error) {
      journalExists = (error as NodeJS.ErrnoException).code !== 'ENOENT';
    }
    expect(journalExists).to.equal(false);
  });

  for (const rejection of [
    {
      statusCode: 503,
      expectedCode: 'IMPORT_OWNERSHIP_UNCERTAIN',
      message: 'temporary create failure',
    },
    { statusCode: 400, expectedCode: 'IMPORT_FAILED', message: 'invalid form payload' },
  ]) {
    it(`classifies Form CREATE ${rejection.statusCode} outcomes with reconciliation-safe command diagnostics`, async () => {
      const root = await mkdtemp(path.join(tmpdir(), 'sf-plugin-cms-command-form-create-'));
      temporaryDirectories.push(root);
      const { mapFile, source } = await writeFormCommandSource(root);
      const manifestFile = path.join(source, 'manifest.json');
      const manifest = JSON.parse(await readFile(manifestFile, 'utf8')) as Record<string, unknown>;
      manifest.completeness = 'complete';
      await writeFile(manifestFile, `${JSON.stringify(manifest)}\n`);
      const reportDirectory = path.join(root, 'report');
      const request = $$.SANDBOX.stub().callsFake(
        ({ method, url }: { method: string; url: string }) => {
          if (url === '/connect/cms/spaces/space') {
            return fakeRequest({
              defaultLanguage: 'en_US',
              id: 'space',
              rootFolderId: 'root',
              spaceType: { apiName: 'Marketing' },
            });
          }
          if (method === 'POST') {
            return Object.assign(
              Promise.reject(
                Object.assign(new Error(rejection.message), {
                  statusCode: rejection.statusCode,
                }),
              ),
              { stream: () => ({ destroy: () => {} }) },
            );
          }
          return fakeRequest({ count: 0, items: [], total: 0, totalCount: 0 });
        },
      );
      const log = $$.SANDBOX.stub();
      const command = Object.create(ImportWorkspace.prototype) as ImportWorkspace;
      Object.assign(command, {
        parse: $$.SANDBOX.stub().resolves({
          flags: {
            'allow-partial': false,
            apply: true,
            'api-version': '67.0',
            'form-map': mapFile,
            'report-dir': reportDirectory,
            'source-dir': source,
            'target-org': 'mcnext-sdo',
            'workspace-id': 'space',
          },
        }),
        getOrgContext: $$.SANDBOX.stub().resolves({ connection: { request }, orgId: '00D-org' }),
        jsonEnabled: $$.SANDBOX.stub().returns(false),
        log,
      });

      const result = await command.run();

      expect(result).to.include({ status: 'failed', result: null });
      expect(result.diagnostics.errors[0], result.diagnostics.errors[0].message).to.include({
        code: rejection.expectedCode,
        retryable: false,
      });
      const diagnostic = result.diagnostics.errors[0].message;
      if (rejection.statusCode === 503) {
        const journalFile = path.join(reportDirectory, 'workspace-import-run.json');
        expect(diagnostic).to.include('Ownership is uncertain');
        expect(diagnostic).to.include(journalFile);
        expect(diagnostic).to.include('Reconcile the durable journal');
        expect(log.calledOnceWithExactly(diagnostic)).to.equal(true);
        expect(JSON.parse(await readFile(journalFile, 'utf8'))).to.include({
          state: 'ownership-uncertain',
        });
      } else {
        expect(diagnostic).not.to.include('Ownership is uncertain');
        expect(diagnostic).not.to.include('Reconcile the durable journal');
        expect(log.notCalled).to.equal(true);
        expect(
          JSON.parse(
            await readFile(path.join(reportDirectory, 'workspace-import-run.json'), 'utf8'),
          ),
        ).to.include({ state: 'failed' });
      }
    });
  }

  it('blocks contradictory complete packages before org access even with allow-partial', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'sf-plugin-cms-command-import-'));
    temporaryDirectories.push(root);
    const source = await writeSource(root);
    const manifestFile = path.join(source, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestFile, 'utf8')) as Record<string, unknown>;
    manifest.failedVariantIds = ['source-variant'];
    await writeFile(manifestFile, `${JSON.stringify(manifest)}\n`);
    const command = Object.create(ImportWorkspace.prototype) as ImportWorkspace;
    const getOrgContext = $$.SANDBOX.stub();
    Object.assign(command, {
      parse: $$.SANDBOX.stub().resolves({
        flags: {
          'allow-partial': true,
          apply: false,
          'api-version': '67.0',
          'source-dir': source,
          'target-org': 'mcnext-sdo',
          'workspace-id': 'space',
        },
      }),
      getOrgContext,
    });

    const result = await command.run();

    expect(result).to.include({ status: 'blocked', result: null });
    expect(result.diagnostics.errors[0]).to.include({ code: 'PACKAGE_VALIDATION_FAILED' });
    expect(result.diagnostics.errors[0].message).to.include(
      'contradicts authoritative incompleteness evidence',
    );
    expect(getOrgContext.notCalled).to.equal(true);
  });

  it('validates a sound source before rejecting missing or combined destination selectors', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'sf-plugin-cms-command-import-'));
    temporaryDirectories.push(root);
    const source = await writeSource(root);
    for (const selector of [{}, { 'workspace-id': 'id', 'workspace-name': 'name' }]) {
      const command = Object.create(ImportWorkspace.prototype) as ImportWorkspace;
      const getOrgContext = $$.SANDBOX.stub();
      Object.assign(command, {
        parse: $$.SANDBOX.stub().resolves({
          flags: {
            'allow-partial': false,
            apply: false,
            'api-version': '67.0',
            'source-dir': source,
            'target-org': 'mcnext-sdo',
            ...selector,
          },
        }),
        getOrgContext,
      });
      const result = await command.run();
      expect(result).to.include({ status: 'blocked', result: null });
      expect(result.diagnostics.errors[0]).to.include({ code: 'PACKAGE_VALIDATION_FAILED' });
      expect(result.diagnostics.errors[0].message).to.include('exactly one');
      expect(getOrgContext.notCalled).to.equal(true);
    }
  });

  it('imports by workspace name using the canonical resolved workspace and ID', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'sf-plugin-cms-command-import-'));
    temporaryDirectories.push(root);
    const source = await writeSource(root);
    const request = $$.SANDBOX.stub().callsFake(({ url }: { url: string }) => {
      if (url.startsWith('/connect/cms/spaces?')) {
        const page = Number(new URL(url, 'https://example.test').searchParams.get('page'));
        return fakeRequest({
          currentPage: page,
          pageSize: 250,
          spaces: page === 0 ? [{ id: 'canonical-space', name: 'Destination' }] : [],
          total: 1,
        });
      }
      if (url === '/connect/cms/spaces/canonical-space') {
        return fakeRequest({
          defaultLanguage: 'en',
          id: 'canonical-space',
          name: 'Destination',
          rootFolderId: 'canonical-root',
        });
      }
      return missingRequest();
    });
    const command = Object.create(ImportWorkspace.prototype) as ImportWorkspace;
    Object.assign(command, {
      parse: $$.SANDBOX.stub().resolves({
        flags: {
          'allow-partial': false,
          apply: false,
          'api-version': '67.0',
          'source-dir': source,
          'target-org': 'mcnext-sdo',
          'workspace-name': 'Destination',
        },
      }),
      getOrgContext: $$.SANDBOX.stub().resolves({ connection: { request }, orgId: '00D-org' }),
      jsonEnabled: $$.SANDBOX.stub().returns(true),
    });

    const result = await command.run();

    expect(result.result?.target.workspaceId).to.equal('canonical-space');
    expect(result.status).to.equal('success');
    expect(request.thirdCall.args[0].url).to.equal('/connect/cms/spaces/canonical-space');
  });

  for (const jsonEnabled of [false, true]) {
    it(`defaults to dry-run and ${jsonEnabled ? 'suppresses' : 'shows'} the human plan in JSON=${jsonEnabled} mode`, async () => {
      const root = await mkdtemp(path.join(tmpdir(), 'sf-plugin-cms-command-import-'));
      temporaryDirectories.push(root);
      const source = await writeSource(root);
      const request = $$.SANDBOX.stub().callsFake(({ url }: { url: string }) => {
        if (url === '/connect/cms/spaces/space') {
          return fakeRequest({ defaultLanguage: 'en', id: 'space', rootFolderId: 'root' });
        }
        return missingRequest();
      });
      const log = $$.SANDBOX.stub();
      const command = Object.create(ImportWorkspace.prototype) as ImportWorkspace;
      Object.assign(command, {
        parse: $$.SANDBOX.stub().resolves({
          flags: {
            'allow-partial': false,
            apply: false,
            'api-version': '67.0',
            'source-dir': source,
            'target-org': 'mcnext-sdo',
            'workspace-id': 'space',
          },
        }),
        getOrgContext: $$.SANDBOX.stub().resolves({ connection: { request }, orgId: '00D-org' }),
        jsonEnabled: $$.SANDBOX.stub().returns(jsonEnabled),
        log,
      });

      const result = await command.run();

      expect(result).to.include({ status: 'success' });
      expect(v1Result(result).mappings).to.deep.equal([]);
      expect(request.callCount).to.equal(2);
      expect(request.getCalls().every(({ args }) => args[0].method === 'GET')).to.equal(true);
      expect(jsonEnabled ? log.notCalled : log.callCount > 0).to.equal(true);
      expect(result.diagnostics.warnings.map(({ code }) => code)).to.deep.equal([
        'NAME_AVAILABILITY_UNVERIFIED',
        'SERVER_CONFLICT_CHECK_UNVERIFIED',
        'APPLY_READINESS_UNVERIFIED',
      ]);
      if (!jsonEnabled) {
        expect(
          log.getCalls().some(({ args }) => String(args[0]).includes('No content was created')),
        ).to.equal(true);
        expect(log.lastCall.args[0]).to.include('not deploy readiness');
      }
    });
  }

  it('applies only when explicitly requested and returns the durable report', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'sf-plugin-cms-command-import-'));
    temporaryDirectories.push(root);
    const source = await writeSource(root, false);
    const reportDirectory = path.join(root, 'report');
    const request = $$.SANDBOX.stub().callsFake(
      ({ method, url }: { method: string; url: string }) => {
        if (url === '/connect/cms/spaces/space') {
          return fakeRequest({ defaultLanguage: 'en', id: 'space', rootFolderId: 'root' });
        }
        if (method === 'GET') return missingRequest();
        return fakeRequest({
          contentKey: 'command-key',
          id: 'content-id',
          primaryVariantId: 'variant-id',
        });
      },
    );
    const command = Object.create(ImportWorkspace.prototype) as ImportWorkspace;
    Object.assign(command, {
      parse: $$.SANDBOX.stub().resolves({
        flags: {
          'allow-partial': false,
          apply: true,
          'api-version': '67.0',
          'report-dir': reportDirectory,
          'source-dir': source,
          'target-org': 'mcnext-sdo',
          'workspace-id': 'space',
        },
      }),
      getOrgContext: $$.SANDBOX.stub().resolves({ connection: { request }, orgId: '00D-org' }),
      jsonEnabled: $$.SANDBOX.stub().returns(true),
      log: $$.SANDBOX.stub(),
    });

    process.exitCode = 2;
    const result = await command.run();

    expect(result).to.include({ status: 'success' });
    expect(process.exitCode).to.equal(0);
    expect(v1Result(result).mappings).to.have.length(1);
    expect(v1Result(result).mappings[0]).to.include({
      operation: 'created',
      status: 'resolved',
      cmsReferencesRewritten: true,
    });
    expect(v1Result(result).mappings[0].target).to.deep.equal({
      targetId: 'content-id',
      targetReference: 'command-key',
    });
    expect(request.getCalls().filter(({ args }) => args[0].method === 'POST')).to.have.length(1);
  });
});
