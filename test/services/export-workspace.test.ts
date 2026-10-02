import { createHash } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { expect } from 'chai';
import sinon from 'sinon';
import { cleanupOwnedPath, publishDirectoryNoClobber } from '../../src/services/atomic-publish.js';
import { bindLandingPageTemplatePairs } from '../../src/services/landing-page-pair-export.js';
import type { CmsRecord } from '../../src/services/read.js';
import { brandDetail } from '../fixtures/brand.js';
import { formHandlerDetail } from '../fixtures/form-handler.js';
import {
  defaultWorkspaceDestination,
  exportWorkspace,
  safeWorkspaceDirectoryName,
} from '../../src/services/export-workspace.js';

type FakeRequest<T> = Promise<T> & { stream(): PassThrough };

function fakeRequest<T>(value: T): FakeRequest<T> {
  return Object.assign(Promise.resolve(value), { stream: () => new PassThrough() });
}

function failedRequest(message = 'detail failed'): FakeRequest<never> {
  return Object.assign(Promise.reject(new Error(message)), { stream: () => new PassThrough() });
}

function row(id: string, managedContentSpaceId = 'space') {
  return { id, managedContentSpaceId, type: 'ManagedContentVariantSearchResultRepresentation' };
}

function acceptedVariantAliases(variantId: string): CmsRecord[] {
  return [
    { id: variantId },
    { managedContentVariantId: variantId },
    { id: variantId, managedContentVariantId: variantId },
  ];
}

function rejectedVariantAliases(variantId: string): CmsRecord[] {
  return [
    { id: variantId, managedContentVariantId: `different-${variantId}` },
    {},
    { id: `different-${variantId}`, managedContentVariantId: `different-${variantId}` },
  ];
}

function withVariantAliases(record: CmsRecord, fields: CmsRecord): CmsRecord {
  const copy = { ...record };
  delete copy.id;
  delete copy.managedContentVariantId;
  return { ...copy, ...fields };
}

function detail(id: string, workspaceId = 'space', overrides = {}) {
  return { contentSpace: { id: workspaceId }, id, value: `value-${id}`, ...overrides };
}

function pageNumber(url: string): number {
  return Number(new URL(url, 'https://example.test').searchParams.get('page'));
}

function preferencePageDetail(id: string, apiName: string, workspaceId = 'space'): CmsRecord {
  return {
    apiName,
    contentType: { fullyQualifiedName: 'sfdc_cms__preferencePage' },
    managedContentId: `content-${id}`,
    managedContentVariantId: id,
    id,
    contentKey: `key-${id}`,
    contentSpace: { id: workspaceId, resourceUrl: `/connect/cms/spaces/${workspaceId}` },
    contentBody: {
      'lightning:dataProviders': [],
      'sfdc_cms:title': `Title ${apiName}`,
      'sfdc_cms:description': `Description ${apiName}`,
      'sfdc_cms:block': {
        id: '10000000-0000-4000-8000-000000000001',
        type: 'block',
        definition: 'sfdc_cms/rootContentBlock',
        children: [
          {
            id: '10000000-0000-4000-8000-000000000002',
            type: 'block',
            definition: 'sfdc_cms/preferencePageSubscriptionsBlock',
            attributes: {
              subscriptionConfig: {
                engChannelTypeId: `channel-${id}`,
                commSubChannelTypeIds: [`subchannel-b-${id}`, `subchannel-a-${id}`],
              },
            },
            children: [],
          },
          {
            id: '10000000-0000-4000-8000-000000000003',
            type: 'block',
            definition: 'sfdc_cms/preferencePageSubmitBlock',
            attributes: { label: 'Save' },
            children: [],
          },
        ],
      },
    },
    contentFqn: null,
    createdBy: {},
    createdDate: '2026-10-01T00:00:00.000Z',
    externalId: null,
    folder: null,
    isPublished: false,
    language: 'en_US',
    lastModifiedBy: {},
    lastModifiedDate: '2026-10-01T00:00:00.000Z',
    managedContentVersionId: `version-${id}`,
    status: { label: 'Draft', status: 'Draft' },
    title: `Title ${apiName}`,
    urlName: `url-${id}`,
  };
}

describe('workspace export service', () => {
  let root: string;

  it('sanitizes default workspace directory names portably', () => {
    expect(safeWorkspaceDirectoryName('Café / Launch:*? ')).to.equal('Café _ Launch___');
    expect(defaultWorkspaceDestination('Main')).to.equal(path.join('.', 'cms', 'Main'));
    for (const name of ['', '.', '..', 'CON', 'lpt1.txt', '...   ']) {
      expect(() => safeWorkspaceDirectoryName(name)).to.throw('--output-dir');
    }
  });

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'sf-plugin-cms-export-'));
  });

  afterEach(async () => {
    await rm(root, { force: true, recursive: true });
  });

  it('preserves a synthetic email fragment body exactly and excludes it from editable HTML output', async () => {
    const body = {
      'sfdc_cms:title': 'Reusable footer',
      backgroundColor: '#ffffff',
      padding: { bottom: '12px', left: '16px', right: '16px', top: '12px' },
      'lightning:brandSource': { defaultBrandOption: 'sfdcBrand' },
      'lightning:dataProviders': [],
      'lightning:expressions': [],
      'sfdc_cms:attachments': [],
      'sfdc_cms:variants': [],
      'sfdc_cms:block': {
        type: 'root',
        children: [
          {
            type: 'section',
            children: [{ type: 'column', children: [] }],
          },
        ],
      },
    };
    const raw = detail('fragment-a', 'space', {
      apiName: 'reusable_footer',
      contentKey: 'fragment-key',
      contentType: 'sfdc_cms__emailFragment',
      language: 'en_US',
      title: 'Reusable footer',
      contentBody: body,
    });
    const request = sinon
      .stub()
      .callsFake(({ url }: { url: string }) =>
        fakeRequest(
          url.startsWith('/connect/cms/items/search')
            ? { items: [row('fragment-a')], total: 1 }
            : raw,
        ),
      );
    const destination = path.join(root, 'fragment-export');
    await exportWorkspace({ request }, 'space', destination);
    expect(
      JSON.parse(await readFile(path.join(destination, 'items/fragment-a.json'), 'utf8')),
    ).to.deep.equal(raw);

    let failure: unknown;
    try {
      await exportWorkspace({ request }, 'space', path.join(root, 'fragment-baseline'), {
        editableDirectory: path.join(root, 'fragment-editable'),
      });
    } catch (error) {
      failure = error;
    }
    expect((failure as Error).message).to.include('No editable native raw-HTML variants');
    expect(await readdir(root)).to.deep.equal(['fragment-baseline', 'fragment-export']);
  });

  it('publishes literal HTML and complete raw metadata without changing default package bytes', async () => {
    const raw = detail('a', 'space', {
      contentType: { fullyQualifiedName: 'sfdc_cms__emailTemplate' },
      externalId: null,
      contentBody: { rawHtml: '&lt;p&gt;Café&lt;/p&gt;', subjectLine: 'keep' },
    });
    const request = sinon
      .stub()
      .callsFake(({ url }: { url: string }) =>
        fakeRequest(
          url.startsWith('/connect/cms/items/search') ? { items: [row('a')], total: 1 } : raw,
        ),
      );
    const options = { generatedAt: '2026-09-15T00:00:00.000Z', pluginVersion: '0.3.1' };
    const baseline = await exportWorkspace(
      { request },
      'space',
      path.join(root, 'baseline'),
      options,
    );
    const editableDirectory = path.join(root, 'new-parent/editable');
    const result = await exportWorkspace({ request }, 'space', path.join(root, 'source'), {
      ...options,
      editableDirectory,
    });
    expect(result.manifestSha256).to.equal(baseline.manifestSha256);
    expect(await readdir(result.destination)).to.deep.equal(['items', 'manifest.json']);
    expect(await readdir(path.join(editableDirectory, 'items'))).to.deep.equal([
      'a.html',
      'a.json',
    ]);
    expect(await readFile(path.join(editableDirectory, 'items/a.html'), 'utf8')).to.equal(
      '<p>Café</p>',
    );
    expect(
      JSON.parse(await readFile(path.join(editableDirectory, 'items/a.json'), 'utf8')),
    ).to.deep.equal({ ...raw, contentBody: { subjectLine: 'keep' } });
    expect(
      JSON.parse(await readFile(path.join(editableDirectory, 'editable.json'), 'utf8'))
        .sourceManifestSha256,
    ).to.equal(result.manifestSha256);
    expect(
      JSON.parse(await readFile(path.join(result.destination, 'items/a.json'), 'utf8')),
    ).to.deep.equal(raw);
  });

  it('rejects existing, unsafe and junction-routed destinations before transport', async () => {
    const existing = path.join(root, 'existing');
    await mkdir(existing);
    await writeFile(path.join(root, 'file'), 'keep');
    await symlink(
      existing,
      path.join(root, 'link'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    const request = sinon.stub();
    for (const editableDirectory of [
      existing,
      path.join(root, 'file/child'),
      path.join(root, 'link/child'),
      `${root}/escape/../editable`,
      `${root}/stream:alias`,
      String.raw`\\?\C:\editable`,
      path.join(root, 'CON'),
      path.join(root, 'alias.'),
    ]) {
      let failure: unknown;
      try {
        await exportWorkspace({ request }, 'space', path.join(root, 'source'), {
          editableDirectory,
        });
      } catch (error) {
        failure = error;
      }
      expect(failure).to.be.instanceOf(Error);
    }
    // The baseline path is subject to exactly the same parent checks.
    let failure: unknown;
    try {
      await exportWorkspace({ request }, 'space', path.join(root, 'link/source'), {
        editableDirectory: path.join(root, 'editable'),
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).to.be.instanceOf(Error);
    expect(request.notCalled).to.equal(true);
    expect(await readdir(root)).to.deep.equal(['existing', 'file', 'link']);
  });

  it('retains the valid baseline when no editable variants exist', async () => {
    const request = sinon.stub().returns(fakeRequest({ items: [], total: 0 }));
    let failure: unknown;
    try {
      await exportWorkspace({ request }, 'space', path.join(root, 'source'), {
        editableDirectory: path.join(root, 'editable'),
      });
    } catch (error) {
      failure = error;
    }
    expect((failure as Error).message)
      .to.include('Baseline export retained')
      .and.include('No editable native raw-HTML variants');
    expect(await readdir(root)).to.deep.equal(['source']);
    expect(
      JSON.parse(await readFile(path.join(root, 'source/manifest.json'), 'utf8')).exportedCount,
    ).to.equal(0);
  });

  it('cleans owned companion staging on a publication collision without clobbering either output', async () => {
    const request = sinon.stub().callsFake(({ url }: { url: string }) =>
      fakeRequest(
        url.startsWith('/connect/cms/items/search')
          ? { items: [row('a')], total: 1 }
          : detail('a', 'space', {
              contentType: 'sfdc_cms__email',
              contentBody: { rawHtml: '<p>safe</p>' },
            }),
      ),
    );
    const editableDirectory = path.join(root, 'editable');
    let failure: unknown;
    try {
      await exportWorkspace({ request }, 'space', path.join(root, 'source'), {
        editableDirectory,
        editablePublish: {
          publishPath: async (_temporary, destination) => {
            await mkdir(destination);
            await writeFile(path.join(destination, 'keep'), 'keep');
            throw Object.assign(new Error('destination appeared'), { code: 'EEXIST' });
          },
        },
      });
    } catch (error) {
      failure = error;
    }
    expect((failure as Error).message).to.include('Baseline export retained');
    expect(await readdir(root)).to.deep.equal(['editable', 'source']);
    expect(await readFile(path.join(editableDirectory, 'keep'), 'utf8')).to.equal('keep');
    expect(
      JSON.parse(await readFile(path.join(root, 'source/manifest.json'), 'utf8')).exportedCount,
    ).to.equal(1);
  });

  it('exports sorted details when the advertised count is satisfied', async () => {
    const request = sinon.stub().callsFake(({ url }: { url: string }) => {
      if (url.startsWith('/connect/cms/items/search'))
        return fakeRequest({ items: [row('b'), row('a')], total: 2 });
      return fakeRequest(detail(decodeURIComponent(url.split('/').at(-1) ?? '')));
    });
    const destination = path.join(root, 'export');

    const result = await exportWorkspace({ request }, 'space', destination);

    expect(result.manifest).to.include({
      expectedCount: 2,
      foundCount: 2,
      exportedCount: 2,
      pagesRequested: 1,
    });
    expect(result.manifest.entries).to.deep.equal([
      { file: 'items/a.json', variantId: 'a' },
      { file: 'items/b.json', variantId: 'b' },
    ]);
    expect(result.manifest.warnings[0].code).to.equal('UNSUPPORTED_WILDCARD');
    expect(result.manifest).to.include({
      schemaVersion: 1,
      contract: 'sf-cms-workspace-export',
      contractVersion: '1.0.0',
      completeness: 'complete',
    });
    expect(result.manifest.items.map(({ path: itemPath }) => itemPath)).to.deep.equal([
      'items/a.json',
      'items/b.json',
    ]);
    expect(result.manifest.items.every(({ sha256 }) => /^[a-f\d]{64}$/u.test(sha256))).to.equal(
      true,
    );
    expect(result.manifestSha256).to.match(/^[a-f\d]{64}$/u);
    expect(await readdir(path.join(destination, 'items'))).to.deep.equal(['a.json', 'b.json']);
  });

  it('exports an exact Email Template package without unrelated workspace warnings', async () => {
    const template = detail('template-en', 'space', {
      apiName: 'WelcomeTemplate',
      contentId: 'template-content',
      contentKey: 'template-key',
      contentType: { fullyQualifiedName: 'sfdc_cms__emailTemplate' },
      language: 'en_US',
      contentBody: { rawHtml: '<p>Welcome</p>' },
    });
    const otherTemplate = detail('template-de', 'space', {
      apiName: 'OtherTemplate',
      contentId: 'other-content',
      contentKey: 'other-key',
      contentType: { fullyQualifiedName: 'sfdc_cms__emailTemplate' },
      language: 'de_DE',
      contentBody: { rawHtml: '<p>Hallo</p>' },
    });
    const request = sinon.stub().callsFake(({ url }: { url: string }) => {
      if (url.startsWith('/connect/cms/items/search')) {
        const query = new URL(url, 'https://example.test').searchParams;
        expect(query.get('contentTypeFQN')).to.equal('sfdc_cms__emailTemplate');
        expect(query.get('queryTerm')).to.equal('*');
        return fakeRequest({ items: [row('template-en'), row('template-de')], total: 2 });
      }
      return fakeRequest(url.endsWith('template-en') ? template : otherTemplate);
    });

    const result = await exportWorkspace({ request }, 'space', path.join(root, 'templates'), {
      selection: { contentType: 'sfdc_cms__emailTemplate', apiNames: ['WelcomeTemplate'] },
      editableDirectory: path.join(root, 'templates-editable'),
    });

    expect(result.manifest.completeness).to.equal('complete');
    expect(result.manifest.expectedCount).to.equal(1);
    expect(result.manifest.foundCount).to.equal(1);
    expect(result.manifest.exportedCount).to.equal(1);
    expect(result.manifest.entries).to.deep.equal([
      { file: 'items/template-en.json', variantId: 'template-en' },
    ]);
    expect(result.manifest.warnings.map(({ code }) => code)).to.deep.equal([
      'UNSUPPORTED_WILDCARD',
    ]);
    expect(result.manifest.externalReferences).to.have.length(1);
    expect(result.manifest.externalReferences[0]).to.deep.include({
      kind: 'cms.content',
      resolution: 'included',
      source: { workspaceId: 'space', sourceId: 'template-content' },
    });
    expect(
      await readFile(path.join(root, 'templates-editable/items/template-en.html'), 'utf8'),
    ).to.equal('<p>Welcome</p>');
  });

  it('proves a multi-page Email Template inventory with page-local counts', async () => {
    const firstPage = Array.from({ length: 250 }, (_, index) => row(`template-${index}`));
    const selectedVariantId = 'template-250';
    const request = sinon.stub().callsFake(({ url }: { url: string }) => {
      if (url.startsWith('/connect/cms/items/search')) {
        const query = new URL(url, 'https://example.test').searchParams;
        const page = Number(query.get('page'));
        return fakeRequest(
          page === 0
            ? { count: firstPage.length, items: firstPage }
            : { count: 1, items: [row(selectedVariantId)] },
        );
      }
      const variantId = decodeURIComponent(url.split('/').at(-1) ?? '');
      return fakeRequest(
        detail(variantId, 'space', {
          apiName: variantId === selectedVariantId ? 'SelectedTemplate' : `Other${variantId}`,
          contentId: `content-${variantId}`,
          contentType: { fullyQualifiedName: 'sfdc_cms__emailTemplate' },
          language: 'en_US',
          contentBody: { rawHtml: `<p>${variantId}</p>` },
        }),
      );
    });

    const result = await exportWorkspace({ request }, 'space', path.join(root, 'templates'), {
      selection: { contentType: 'sfdc_cms__emailTemplate', apiNames: ['SelectedTemplate'] },
    });

    expect(result.manifest.completeness).to.equal('complete');
    expect(result.manifest.pagesRequested).to.equal(2);
    expect(result.manifest.entries).to.deep.equal([
      { file: `items/${selectedVariantId}.json`, variantId: selectedVariantId },
    ]);
    expect(result.manifest.warnings.map(({ code }) => code)).to.deep.equal([
      'UNSUPPORTED_WILDCARD',
    ]);
  });

  it('exports one or many exact web-fragment API names and fails on missing or ambiguous matches', async () => {
    const selectedDetails = {
      one: detail('one', 'space', {
        apiName: 'BlockOne',
        contentType: { fullyQualifiedName: 'sfdc_cms__webFragment' },
      }),
      two: detail('two', 'space', {
        apiName: 'BlockTwo',
        contentType: { fullyQualifiedName: 'sfdc_cms__webFragment' },
      }),
    };
    const request = sinon.stub().callsFake(({ url }: { url: string }) => {
      if (url.startsWith('/connect/cms/items/search')) {
        const query = new URL(url, 'https://example.test').searchParams;
        expect(query.get('contentTypeFQN')).to.equal('sfdc_cms__webFragment');
        if (query.get('queryTerm') !== '*') return fakeRequest({ items: [], total: 0 });
        return fakeRequest({ items: [row('one'), row('two')], total: 2 });
      }
      return fakeRequest(
        selectedDetails[
          decodeURIComponent(url.split('/').at(-1) ?? '') as keyof typeof selectedDetails
        ],
      );
    });
    const destination = path.join(root, 'selected-export');
    const result = await exportWorkspace({ request }, 'space', destination, {
      selection: {
        contentType: 'sfdc_cms__webFragment',
        apiNames: ['BlockOne', 'BlockTwo'],
      },
    });
    expect(result.manifest.entries.map(({ variantId }) => variantId)).to.deep.equal(['one', 'two']);

    for (const details of [
      [selectedDetails.one],
      [selectedDetails.one, { ...selectedDetails.one, id: 'duplicate' }],
    ]) {
      const selectedRequest = sinon
        .stub()
        .callsFake(({ url }: { url: string }) =>
          url.startsWith('/connect/cms/items/search')
            ? fakeRequest({ items: details.map(({ id }) => row(id)), total: details.length })
            : fakeRequest(details.find(({ id }) => url.endsWith(id))),
        );
      let failure: unknown;
      try {
        await exportWorkspace(
          { request: selectedRequest },
          'space',
          path.join(root, `blocked-${details.length}`),
          {
            selection: {
              contentType: 'sfdc_cms__webFragment',
              apiNames: details.length === 1 ? ['Missing'] : ['BlockOne'],
            },
          },
        );
      } catch (error) {
        failure = error;
      }
      expect(failure).to.be.instanceOf(TypeError);
    }
  });

  it('fails closed when exact web-fragment inventory completeness is not proven', async () => {
    const selectedDetail = detail('match', 'space', {
      apiName: 'MCNEXT_P4_Landing_Block_2026_09_27',
      contentType: { fullyQualifiedName: 'sfdc_cms__webFragment' },
    });
    const request = sinon.stub().callsFake(({ url }: { url: string }) => {
      if (url.startsWith('/connect/cms/items/search')) {
        const query = new URL(url, 'https://example.test').searchParams;
        expect(query.get('contentTypeFQN')).to.equal('sfdc_cms__webFragment');
        expect(query.get('queryTerm')).to.equal('*');
        return fakeRequest({ items: [row('match')], total: 2 });
      }
      return fakeRequest(selectedDetail);
    });
    let failure: unknown;
    try {
      await exportWorkspace({ request }, 'space', path.join(root, 'incomplete-web'), {
        selection: {
          contentType: 'sfdc_cms__webFragment',
          apiNames: ['MCNEXT_P4_Landing_Block_2026_09_27'],
        },
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).to.be.instanceOf(TypeError);
    expect((failure as Error).message).to.equal(
      'Exact component API names require a complete sfdc_cms__webFragment inventory for the requested workspace.',
    );
  });

  it('exports exact email-fragment API names deterministically and scopes package references', async () => {
    const selectedDetails = {
      z: detail('z', 'space', {
        apiName: 'FooterBlock',
        contentId: 'footer-content',
        contentKey: 'footer-key',
        contentType: { fullyQualifiedName: 'sfdc_cms__emailFragment' },
      }),
      a: detail('a', 'space', {
        apiName: 'HeaderBlock',
        contentId: 'header-content',
        contentKey: 'header-key',
        contentType: { fullyQualifiedName: 'sfdc_cms__emailFragment' },
      }),
      unrelated: detail('unrelated', 'space', {
        apiName: 'UnrelatedBlock',
        contentBody: { image: { ref: { contentKey: 'image-key' } } },
        contentType: { fullyQualifiedName: 'sfdc_cms__emailFragment' },
        references: [{ id: 'unrelated-reference' }],
      }),
    };
    const makeRequest = () =>
      sinon.stub().callsFake(({ url }: { url: string }) => {
        if (url.startsWith('/connect/cms/items/search')) {
          const query = new URL(url, 'https://example.test').searchParams;
          expect(query.get('contentTypeFQN')).to.equal('sfdc_cms__emailFragment');
          if (query.get('queryTerm') !== '*') return fakeRequest({ items: [], total: 0 });
          return fakeRequest(
            pageNumber(url) === 0
              ? { items: [row('z'), row('unrelated')], total: 3 }
              : { items: [row('a')], total: 3 },
          );
        }
        return fakeRequest(
          selectedDetails[
            decodeURIComponent(url.split('/').at(-1) ?? '') as keyof typeof selectedDetails
          ],
        );
      });

    const multiple = await exportWorkspace(
      { request: makeRequest() },
      'space',
      path.join(root, 'selected-email-fragments'),
      {
        selection: {
          contentType: 'sfdc_cms__emailFragment',
          apiNames: ['FooterBlock', 'HeaderBlock'],
        },
      },
    );
    expect(multiple.manifest.entries.map(({ variantId }) => variantId)).to.deep.equal(['a', 'z']);
    expect(multiple.manifest.items.map(({ path: itemPath }) => itemPath)).to.deep.equal([
      'items/a.json',
      'items/z.json',
    ]);
    expect(multiple.manifest.externalReferences).to.have.length(2);
    expect(multiple.manifest.externalReferences.map(({ source }) => source.sourceId)).to.deep.equal(
      ['header-content', 'footer-content'],
    );
    expect(multiple.manifest.warnings.map(({ code }) => code)).not.to.include(
      'REFERENCE_UNSUPPORTED',
    );

    const singleRequest = sinon
      .stub()
      .callsFake(({ url }: { url: string }) =>
        url.startsWith('/connect/cms/items/search')
          ? fakeRequest({ items: [row('a')], total: 1 })
          : fakeRequest(selectedDetails.a),
      );
    const single = await exportWorkspace(
      { request: singleRequest },
      'space',
      path.join(root, 'selected-email-fragment'),
      {
        selection: { contentType: 'sfdc_cms__emailFragment', apiNames: ['HeaderBlock'] },
      },
    );
    expect(single.manifest.entries).to.deep.equal([{ file: 'items/a.json', variantId: 'a' }]);
  });

  it('exports exact Preference Pages with deterministic reports, raw equality, hashes, and unresolved warnings', async () => {
    const details = {
      z: preferencePageDetail('z', 'PreferenceZ'),
      a: preferencePageDetail('a', 'PreferenceA'),
      unrelated: preferencePageDetail('unrelated', 'Unrelated'),
    };
    const request = sinon.stub().callsFake((request_: { method?: string; url: string }) => {
      expect(request_.method ?? 'GET').to.equal('GET');
      if (request_.url.startsWith('/connect/cms/items/search')) {
        const query = new URL(request_.url, 'https://example.test').searchParams;
        expect(query.get('contentTypeFQN')).to.equal('sfdc_cms__preferencePage');
        expect(query.get('queryTerm')).to.equal('*');
        return fakeRequest({ items: [row('z'), row('unrelated'), row('a')], total: 3 });
      }
      return fakeRequest(
        details[decodeURIComponent(request_.url.split('/').at(-1) ?? '') as keyof typeof details],
      );
    });
    const destination = path.join(root, 'preference-pages');
    const result = await exportWorkspace({ request }, 'space', destination, {
      selection: {
        contentType: 'sfdc_cms__preferencePage',
        apiNames: ['PreferenceZ', 'PreferenceA'],
        preferencePageReports: true,
      },
    });

    expect(result.manifest.entries.map(({ variantId }) => variantId)).to.deep.equal(['a', 'z']);
    expect(result.manifest.completeness).to.equal('partial');
    expect(result.manifest.externalReferences).to.deep.equal([]);
    expect(result.manifest.items.map(({ path: itemPath }) => itemPath)).to.deep.equal([
      'items/a.json',
      'items/z.json',
      'reports/preference-pages/a.json',
      'reports/preference-pages/z.json',
    ]);
    expect(result.manifest.preferencePageReports).to.deep.equal([
      {
        path: 'reports/preference-pages/a.json',
        rawItemPath: 'items/a.json',
        workspaceId: 'space',
        contentType: 'sfdc_cms__preferencePage',
        variantId: 'a',
        apiName: 'PreferenceA',
        format: 'sf-cms-preference-page-read-report@1',
      },
      {
        path: 'reports/preference-pages/z.json',
        rawItemPath: 'items/z.json',
        workspaceId: 'space',
        contentType: 'sfdc_cms__preferencePage',
        variantId: 'z',
        apiName: 'PreferenceZ',
        format: 'sf-cms-preference-page-read-report@1',
      },
    ]);
    expect(result.manifest.warnings.at(-1)).to.deep.equal({
      code: 'REFERENCE_UNRESOLVED',
      message:
        'Preference Page channel and subchannel references remain source-bound and unresolved.',
      variantIds: ['a', 'z'],
    });
    for (const variantId of ['a', 'z'] as const) {
      const rawBytes = await readFile(path.join(destination, `items/${variantId}.json`));
      const reportBytes = await readFile(
        path.join(destination, `reports/preference-pages/${variantId}.json`),
      );
      expect(JSON.parse(rawBytes.toString('utf8'))).to.deep.equal(details[variantId]);
      const report = JSON.parse(reportBytes.toString('utf8')) as {
        normalization: { unresolvedReferences: Array<{ sourceId: string }> };
        rawItemPath: string;
      };
      expect(report.rawItemPath).to.equal(`items/${variantId}.json`);
      expect(
        report.normalization.unresolvedReferences.map(({ sourceId }) => sourceId),
      ).to.deep.equal([
        `channel-${variantId}`,
        `subchannel-b-${variantId}`,
        `subchannel-a-${variantId}`,
      ]);
      expect(
        result.manifest.items.find(
          ({ path: itemPath }) => itemPath === `reports/preference-pages/${variantId}.json`,
        )?.sha256,
      ).to.equal(createHash('sha256').update(reportBytes).digest('hex'));
    }
  });

  it('exports exact Brands with deterministic reports, raw equality, hashes, and no unresolved references', async () => {
    const details = {
      z: brandDetail('z', 'BrandZ'),
      a: brandDetail('a', 'BrandA'),
      unrelated: brandDetail('unrelated', 'Unrelated'),
    };
    const request = sinon.stub().callsFake((request_: { method?: string; url: string }) => {
      expect(request_.method ?? 'GET').to.equal('GET');
      if (request_.url.startsWith('/connect/cms/items/search')) {
        const query = new URL(request_.url, 'https://example.test').searchParams;
        expect(query.get('contentTypeFQN')).to.equal('sfdc_cms__brand');
        expect(query.get('queryTerm')).to.equal('*');
        return fakeRequest({ items: [row('z'), row('unrelated'), row('a')], total: 3 });
      }
      return fakeRequest(
        details[decodeURIComponent(request_.url.split('/').at(-1) ?? '') as keyof typeof details],
      );
    });
    const destination = path.join(root, 'brands');
    const result = await exportWorkspace({ request }, 'space', destination, {
      selection: {
        contentType: 'sfdc_cms__brand',
        apiNames: ['BrandZ', 'BrandA'],
        brandReports: true,
      },
    });

    expect(result.manifest.entries.map(({ variantId }) => variantId)).to.deep.equal(['a', 'z']);
    expect(result.manifest.completeness).to.equal('complete');
    expect(result.manifest.externalReferences).to.deep.equal([]);
    expect(result.manifest.items.map(({ path: itemPath }) => itemPath)).to.deep.equal([
      'items/a.json',
      'items/z.json',
      'reports/brands/a.json',
      'reports/brands/z.json',
    ]);
    expect(result.manifest.brandReports).to.deep.equal([
      {
        path: 'reports/brands/a.json',
        rawItemPath: 'items/a.json',
        workspaceId: 'space',
        contentType: 'sfdc_cms__brand',
        variantId: 'a',
        apiName: 'BrandA',
        format: 'sf-cms-brand-read-report@1',
      },
      {
        path: 'reports/brands/z.json',
        rawItemPath: 'items/z.json',
        workspaceId: 'space',
        contentType: 'sfdc_cms__brand',
        variantId: 'z',
        apiName: 'BrandZ',
        format: 'sf-cms-brand-read-report@1',
      },
    ]);
    expect(result.manifest.warnings.map(({ code }) => code)).not.to.include('REFERENCE_UNRESOLVED');
    for (const variantId of ['a', 'z'] as const) {
      const rawBytes = await readFile(path.join(destination, `items/${variantId}.json`));
      const reportBytes = await readFile(
        path.join(destination, `reports/brands/${variantId}.json`),
      );
      expect(JSON.parse(rawBytes.toString('utf8'))).to.deep.equal(details[variantId]);
      const report = JSON.parse(reportBytes.toString('utf8')) as {
        normalization: { unresolvedReferences: unknown[] };
        rawItemPath: string;
      };
      expect(report.rawItemPath).to.equal(`items/${variantId}.json`);
      expect(report.normalization.unresolvedReferences).to.deep.equal([]);
      expect(
        result.manifest.items.find(
          ({ path: itemPath }) => itemPath === `reports/brands/${variantId}.json`,
        )?.sha256,
      ).to.equal(createHash('sha256').update(reportBytes).digest('hex'));
    }
  });

  it('exports exact Form Handlers with deterministic reports and raw/report binding', async () => {
    const raw = formHandlerDetail('variant', {
      contentSpace: { id: 'space', resourceUrl: '/connect/cms/spaces/space' },
      id: 'handler',
      managedContentVariantId: 'handler',
    });
    const request = sinon
      .stub()
      .callsFake(({ url }: { url: string }) =>
        url.startsWith('/connect/cms/items/search')
          ? fakeRequest({ items: [row('handler')], total: 1 })
          : fakeRequest(raw),
      );
    const destination = path.join(root, 'form-handlers');
    const result = await exportWorkspace({ request }, 'space', destination, {
      selection: {
        contentType: 'sfdc_cms__formHandler',
        apiNames: ['source_form_handler_api'],
        formHandlerReports: true,
      },
    });

    expect(result.manifest.completeness).to.equal('complete');
    expect(result.manifest.formHandlerReports).to.deep.equal([
      {
        path: 'reports/form-handlers/handler.json',
        rawItemPath: 'items/handler.json',
        workspaceId: 'space',
        contentType: 'sfdc_cms__formHandler',
        variantId: 'handler',
        apiName: 'source_form_handler_api',
        format: 'sf-cms-form-handler-read-report@1',
      },
    ]);
    expect(result.manifest.items.map(({ kind }) => kind)).to.deep.equal([
      'cms.content',
      'cms.form-handler.read-report',
    ]);
    const rawBytes = await readFile(path.join(destination, 'items/handler.json'));
    const reportBytes = await readFile(
      path.join(destination, 'reports/form-handlers/handler.json'),
    );
    expect(JSON.parse(rawBytes.toString('utf8'))).to.deep.equal(raw);
    expect(JSON.parse(reportBytes.toString('utf8'))).to.include({
      format: 'sf-cms-form-handler-read-report@1',
      rawItemPath: 'items/handler.json',
    });
    expect(result.manifest.items[1].sha256).to.equal(
      createHash('sha256').update(reportBytes).digest('hex'),
    );
  });

  it('keeps generic Brand export raw-only unless typed reports are explicitly selected', async () => {
    const raw = brandDetail('brand', 'Brand');
    const request = sinon
      .stub()
      .callsFake(({ url }: { url: string }) =>
        url.startsWith('/connect/cms/items/search')
          ? fakeRequest({ items: [row('brand')], total: 1 })
          : fakeRequest(raw),
      );
    const result = await exportWorkspace({ request }, 'space', path.join(root, 'brand-raw-only'));
    expect(result.manifest.brandReports).to.equal(undefined);
    expect(result.manifest.items.map(({ kind }) => kind)).to.deep.equal(['cms.content']);
  });

  it('fails selected Brand export before publication for incomplete or invalid evidence', async () => {
    const valid = brandDetail('brand', 'Brand') as CmsRecord;
    const cases: Array<{
      name: string;
      rows: ReturnType<typeof row>[];
      total: number;
      details: CmsRecord[] | Error;
      apiName?: string;
    }> = [
      { name: 'missing', rows: [row('brand')], total: 1, details: [valid], apiName: 'Missing' },
      {
        name: 'duplicate',
        rows: [row('brand'), row('brand-copy')],
        total: 2,
        details: [valid, brandDetail('brand-copy', 'Brand') as CmsRecord],
      },
      {
        name: 'wrong type',
        rows: [row('brand')],
        total: 1,
        details: [{ ...valid, contentType: { fullyQualifiedName: 'sfdc_cms__form' } }],
      },
      {
        name: 'foreign workspace',
        rows: [row('brand')],
        total: 1,
        details: [brandDetail('brand', 'Brand', 'other-space') as CmsRecord],
      },
      { name: 'detail failure', rows: [row('brand')], total: 1, details: new Error('failed') },
      {
        name: 'normalizer failure',
        rows: [row('brand')],
        total: 1,
        details: [{ ...valid, contentBody: {} }],
      },
      { name: 'incomplete inventory', rows: [row('brand')], total: 2, details: [valid] },
    ];
    for (const [index, testCase] of cases.entries()) {
      const request = sinon.stub().callsFake(({ url }: { url: string }) => {
        if (url.startsWith('/connect/cms/items/search')) {
          return fakeRequest({
            items: pageNumber(url) === 0 ? testCase.rows : [],
            total: testCase.total,
          });
        }
        if (testCase.details instanceof Error) return failedRequest();
        const id = decodeURIComponent(url.split('/').at(-1) ?? '');
        return fakeRequest(
          testCase.details.find(
            (detail_) => detail_.id === id || detail_.managedContentVariantId === id,
          ),
        );
      });
      let failure: unknown;
      try {
        await exportWorkspace({ request }, 'space', path.join(root, `blocked-brand-${index}`), {
          selection: {
            contentType: 'sfdc_cms__brand',
            apiNames: [testCase.apiName ?? 'Brand'],
            brandReports: true,
          },
        });
      } catch (error) {
        failure = error;
      }
      expect(failure, testCase.name).to.be.instanceOf(TypeError);
      expect(await readdir(root)).not.to.include(`blocked-brand-${index}`);
    }
  });

  it('keeps generic Preference Page export raw-only unless typed reports are explicitly selected', async () => {
    const raw = preferencePageDetail('preference', 'Preference');
    const request = sinon
      .stub()
      .callsFake(({ url }: { url: string }) =>
        url.startsWith('/connect/cms/items/search')
          ? fakeRequest({ items: [row('preference')], total: 1 })
          : fakeRequest(raw),
      );
    const result = await exportWorkspace({ request }, 'space', path.join(root, 'raw-only'));
    expect(result.manifest.preferencePageReports).to.equal(undefined);
    expect(result.manifest.items.map(({ kind }) => kind)).to.deep.equal(['cms.content']);
  });

  it('fails selected Preference Page export before publication for incomplete or invalid evidence', async () => {
    const valid = preferencePageDetail('preference', 'Preference');
    const cases: Array<{
      name: string;
      rows: ReturnType<typeof row>[];
      total: number;
      details: CmsRecord[] | Error;
      apiName?: string;
    }> = [
      {
        name: 'missing',
        rows: [row('preference')],
        total: 1,
        details: [valid],
        apiName: 'Missing',
      },
      {
        name: 'duplicate',
        rows: [row('preference'), row('preference-copy')],
        total: 2,
        details: [valid, preferencePageDetail('preference-copy', 'Preference')],
      },
      {
        name: 'wrong type',
        rows: [row('preference')],
        total: 1,
        details: [{ ...valid, contentType: 'sfdc_cms__form' }],
      },
      {
        name: 'foreign workspace',
        rows: [row('preference')],
        total: 1,
        details: [preferencePageDetail('preference', 'Preference', 'other-space')],
      },
      {
        name: 'detail failure',
        rows: [row('preference')],
        total: 1,
        details: new Error('failed'),
      },
      {
        name: 'normalizer failure',
        rows: [row('preference')],
        total: 1,
        details: [{ ...valid, contentBody: {} }],
      },
      {
        name: 'incomplete inventory',
        rows: [row('preference')],
        total: 2,
        details: [valid],
      },
    ];
    for (const [index, testCase] of cases.entries()) {
      const request = sinon.stub().callsFake(({ url }: { url: string }) => {
        if (url.startsWith('/connect/cms/items/search')) {
          return fakeRequest({
            items: pageNumber(url) === 0 ? testCase.rows : [],
            total: testCase.total,
          });
        }
        if (testCase.details instanceof Error) return failedRequest();
        const id = decodeURIComponent(url.split('/').at(-1) ?? '');
        return fakeRequest(
          testCase.details.find(
            (detail_) => detail_.id === id || detail_.managedContentVariantId === id,
          ),
        );
      });
      let failure: unknown;
      try {
        await exportWorkspace(
          { request },
          'space',
          path.join(root, `blocked-preference-${index}`),
          {
            selection: {
              contentType: 'sfdc_cms__preferencePage',
              apiNames: [testCase.apiName ?? 'Preference'],
              preferencePageReports: true,
            },
          },
        );
      } catch (error) {
        failure = error;
      }
      expect(failure, testCase.name).to.be.instanceOf(TypeError);
      expect(await readdir(root)).not.to.include(`blocked-preference-${index}`);
    }
  });

  it('fails closed when exact email-fragment inventory completeness is not proven', async () => {
    const selectedDetail = detail('match', 'space', {
      apiName: 'ReusableBlock',
      contentType: { fullyQualifiedName: 'sfdc_cms__emailFragment' },
    });
    const cases: Array<{
      name: string;
      search: (page: number) => { items: ReturnType<typeof row>[]; total: number };
      detail: (id: string) => FakeRequest<unknown>;
    }> = [
      {
        name: 'bounded page capacity is below the advertised count',
        search: (page) => ({ items: page === 0 ? [row('match')] : [], total: 250_001 }),
        detail: () => fakeRequest(selectedDetail),
      },
      {
        name: 'search terminates on a premature empty page',
        search: (page) => ({ items: page === 0 ? [row('match')] : [], total: 2 }),
        detail: () => fakeRequest(selectedDetail),
      },
      {
        name: 'search makes no progress below the advertised count',
        search: (page) => ({
          items: page === 0 ? [row('match')] : [row('match'), row('match')],
          total: 2,
        }),
        detail: () => fakeRequest(selectedDetail),
      },
      {
        name: 'a rejected foreign search row is fatal even when valid local counts match',
        search: () => ({
          items: [row('match'), row('second-match'), row('foreign', 'other-space')],
          total: 2,
        }),
        detail: () => fakeRequest(selectedDetail),
      },
      {
        name: 'a detail request fails',
        search: () => ({ items: [row('match'), row('unavailable')], total: 2 }),
        detail: (id) => (id === 'match' ? fakeRequest(selectedDetail) : failedRequest()),
      },
      {
        name: 'a detail belongs to a different workspace',
        search: () => ({ items: [row('match'), row('foreign')], total: 2 }),
        detail: (id) =>
          fakeRequest(id === 'match' ? selectedDetail : detail('foreign', 'other-space')),
      },
    ];

    for (const [index, testCase] of cases.entries()) {
      const request = sinon.stub().callsFake(({ url }: { url: string }) => {
        if (url.startsWith('/connect/cms/items/search')) {
          return fakeRequest(testCase.search(pageNumber(url)));
        }
        return testCase.detail(decodeURIComponent(url.split('/').at(-1) ?? ''));
      });
      let failure: unknown;
      try {
        await exportWorkspace({ request }, 'space', path.join(root, `incomplete-email-${index}`), {
          selection: {
            contentType: 'sfdc_cms__emailFragment',
            apiNames: ['ReusableBlock'],
          },
        });
      } catch (error) {
        failure = error;
      }
      expect(failure, testCase.name).to.be.instanceOf(TypeError);
      expect((failure as Error).message, testCase.name).to.equal(
        'Exact component API names require a complete sfdc_cms__emailFragment inventory for the requested workspace.',
      );
    }
  });

  it('rejects missing, ambiguous, and wrong-type email-fragment export selections', async () => {
    const email = detail('email', 'space', {
      apiName: 'ReusableBlock',
      contentType: { fullyQualifiedName: 'sfdc_cms__emailFragment' },
    });
    const cases = [
      { details: [email], apiName: 'MissingBlock' },
      { details: [email, { ...email, id: 'duplicate' }], apiName: 'ReusableBlock' },
      {
        details: [
          detail('wrong-type', 'space', {
            apiName: 'ReusableBlock',
            contentType: { fullyQualifiedName: 'sfdc_cms__webFragment' },
          }),
        ],
        apiName: 'ReusableBlock',
      },
    ];
    for (const [index, testCase] of cases.entries()) {
      const request = sinon.stub().callsFake(({ url }: { url: string }) =>
        url.startsWith('/connect/cms/items/search')
          ? fakeRequest({
              items: testCase.details.map(({ id }) => row(id)),
              total: testCase.details.length,
            })
          : fakeRequest(testCase.details.find(({ id }) => url.endsWith(id))),
      );
      let failure: unknown;
      try {
        await exportWorkspace({ request }, 'space', path.join(root, `blocked-email-${index}`), {
          selection: {
            contentType: 'sfdc_cms__emailFragment',
            apiNames: [testCase.apiName],
          },
        });
      } catch (error) {
        failure = error;
      }
      expect(failure).to.be.instanceOf(TypeError);
      expect((failure as Error).message).to.include('sfdc_cms__emailFragment');
    }
  });

  it('rejects empty or combined landing-page pair selection before transport', async () => {
    const request = sinon.stub();
    for (const options of [
      { landingPagePairs: [] },
      {
        landingPagePairs: [{ page: { apiName: 'Page' }, template: { title: 'Template' } }],
        selection: { contentType: 'sfdc_cms__landingPage', apiNames: ['Page'] },
      },
    ]) {
      let failure: unknown;
      try {
        await exportWorkspace(
          { request },
          'space',
          path.join(root, `invalid-${request.callCount}`),
          options,
        );
      } catch (error) {
        failure = error;
      }
      expect(failure).to.be.instanceOf(TypeError);
    }
    expect(request.notCalled).to.equal(true);
  });

  it('exports exact landing pages with title-resolved declared templates and deterministic pair integrity', async () => {
    const page = detail('page-variant', 'space', {
      apiName: 'LandingPageOne',
      contentId: 'page-content',
      contentKey: 'page-key',
      contentType: { fullyQualifiedName: 'sfdc_cms__landingPage' },
      references: [
        {
          apiName: 'opaque-unreadable-value',
          contentType: { fullyQualifiedName: 'sfdc_cms__landingPageTemplate' },
        },
      ],
      title: 'Page One',
    });
    const template = detail('template-variant', 'space', {
      apiName: 'CanonicalTemplateApi',
      contentId: 'template-content',
      contentKey: 'template-key',
      contentType: { fullyQualifiedName: 'sfdc_cms__landingPageTemplate' },
      title: 'Human Template Label',
    });
    const request = sinon.stub().callsFake(({ url }: { url: string }) => {
      if (url.startsWith('/connect/cms/items/search')) {
        const type = new URL(url, 'https://example.test').searchParams.get('contentTypeFQN');
        return fakeRequest(
          type === 'sfdc_cms__landingPage'
            ? { items: [row('page-variant')], total: 1 }
            : { items: [row('template-variant')], total: 1 },
        );
      }
      return fakeRequest(url.endsWith('page-variant') ? page : template);
    });
    const result = await exportWorkspace({ request }, 'space', path.join(root, 'paired'), {
      landingPagePairs: [
        { page: { apiName: 'LandingPageOne' }, template: { title: 'Human Template Label' } },
      ],
      generatedAt: '2026-09-30T00:00:00.000Z',
    });

    expect(result.manifest.entries.map(({ variantId }) => variantId)).to.deep.equal([
      'page-variant',
      'template-variant',
    ]);
    expect(result.manifest.landingPageTemplatePairs).to.deep.equal([
      {
        page: {
          apiName: 'LandingPageOne',
          contentKey: 'page-key',
          variantId: 'page-variant',
        },
        template: {
          requestedTitle: 'Human Template Label',
          apiName: 'CanonicalTemplateApi',
          contentKey: 'template-key',
          variantId: 'template-variant',
        },
        compatibility: {
          basis: 'declared-source-pair',
          relationship: 'opaque-structural-match',
        },
      },
    ]);
    expect(result.manifest.warnings.map(({ code }) => code)).to.include('REFERENCE_UNSUPPORTED');
    expect(
      result.manifest.externalReferences.some(({ kind }) => kind === 'cms.relationship'),
    ).to.equal(true);
    expect(result.manifestSha256).to.equal(
      createHash('sha256')
        .update(await readFile(path.join(root, 'paired/manifest.json')))
        .digest('hex'),
    );
  });

  it('normalizes strict Managed Content variant aliases in landing-page pair details', () => {
    const pageBase = detail('page-variant', 'space', {
      apiName: 'LandingPageOne',
      contentKey: 'page-key',
      contentType: { fullyQualifiedName: 'sfdc_cms__landingPage' },
      references: [{ contentTypeFQN: 'sfdc_cms__landingPageTemplate' }],
      title: 'Page One',
    });
    const template = detail('template-variant', 'space', {
      apiName: 'CanonicalTemplateApi',
      contentKey: 'template-key',
      contentType: { fullyQualifiedName: 'sfdc_cms__landingPageTemplate' },
      title: 'Human Template Label',
    });
    const selectors = [
      { page: { apiName: 'LandingPageOne' }, template: { title: 'Human Template Label' } },
    ];
    for (const fields of acceptedVariantAliases('page-variant')) {
      const pairs = bindLandingPageTemplatePairs(
        selectors,
        new Map<string, CmsRecord>([
          ['page-variant', withVariantAliases(pageBase, fields)],
          ['template-variant', template],
        ]),
      );
      expect(pairs[0].page.variantId).to.equal('page-variant');
    }
    for (const fields of acceptedVariantAliases('template-variant')) {
      const pairs = bindLandingPageTemplatePairs(
        selectors,
        new Map<string, CmsRecord>([
          ['page-variant', pageBase],
          ['template-variant', withVariantAliases(template, fields)],
        ]),
      );
      expect(pairs[0].template.variantId).to.equal('template-variant');
    }
    for (const fields of rejectedVariantAliases('page-variant')) {
      expect(() =>
        bindLandingPageTemplatePairs(
          selectors,
          new Map<string, CmsRecord>([
            ['page-variant', withVariantAliases(pageBase, fields)],
            ['template-variant', template],
          ]),
        ),
      ).to.throw(TypeError);
    }
    for (const fields of rejectedVariantAliases('template-variant')) {
      expect(() =>
        bindLandingPageTemplatePairs(
          selectors,
          new Map<string, CmsRecord>([
            ['page-variant', pageBase],
            ['template-variant', withVariantAliases(template, fields)],
          ]),
        ),
      ).to.throw(TypeError);
    }
  });

  it('rejects conflicting Managed Content variant aliases in landing-page pair details', async () => {
    const page = detail('page-variant', 'space', {
      apiName: 'LandingPageOne',
      contentKey: 'page-key',
      contentType: { fullyQualifiedName: 'sfdc_cms__landingPage' },
      managedContentVariantId: 'different-page-variant',
      references: [{ contentTypeFQN: 'sfdc_cms__landingPageTemplate' }],
      title: 'Page One',
    });
    const template = detail('template-variant', 'space', {
      apiName: 'CanonicalTemplateApi',
      contentKey: 'template-key',
      contentType: { fullyQualifiedName: 'sfdc_cms__landingPageTemplate' },
      title: 'Human Template Label',
    });
    const request = sinon.stub().callsFake(({ url }: { url: string }) => {
      if (url.startsWith('/connect/cms/items/search')) {
        const type = new URL(url, 'https://example.test').searchParams.get('contentTypeFQN');
        return fakeRequest({
          items: [row(type === 'sfdc_cms__landingPage' ? 'page-variant' : 'template-variant')],
          total: 1,
        });
      }
      return fakeRequest(url.endsWith('page-variant') ? page : template);
    });

    let failure: unknown;
    try {
      await exportWorkspace({ request }, 'space', path.join(root, 'conflicting-pair'), {
        landingPagePairs: [
          { page: { apiName: 'LandingPageOne' }, template: { title: 'Human Template Label' } },
        ],
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).to.be.instanceOf(TypeError);
  });

  it('supports shared templates and fails closed on invalid landing-page pair resolution', async () => {
    const page = (id: string, apiName: string, descriptors = 1, workspace = 'space') =>
      detail(id, workspace, {
        apiName,
        contentKey: `${id}-key`,
        contentType: { fullyQualifiedName: 'sfdc_cms__landingPage' },
        references: Array.from({ length: descriptors }, () => ({
          contentTypeFQN: 'sfdc_cms__landingPageTemplate',
          apiName: 'opaque-value',
        })),
        title: apiName,
      });
    const template = detail('template', 'space', {
      apiName: 'CanonicalTemplate',
      contentKey: 'template-key',
      contentType: { fullyQualifiedName: 'sfdc_cms__landingPageTemplate' },
      title: 'Shared Template',
    });
    const validDetails = [page('page-a', 'PageA'), page('page-b', 'PageB'), template];
    const validRequest = sinon.stub().callsFake(({ url }: { url: string }) => {
      if (url.startsWith('/connect/cms/items/search')) {
        const type = new URL(url, 'https://example.test').searchParams.get('contentTypeFQN');
        const values =
          type === 'sfdc_cms__landingPage' ? validDetails.slice(0, 2) : validDetails.slice(2);
        return fakeRequest({ items: values.map(({ id }) => row(id)), total: values.length });
      }
      return fakeRequest(validDetails.find(({ id }) => url.endsWith(id)));
    });
    const valid = await exportWorkspace(
      { request: validRequest },
      'space',
      path.join(root, 'shared'),
      {
        landingPagePairs: [
          { page: { apiName: 'PageB' }, template: { title: 'Shared Template' } },
          { page: { apiName: 'PageA' }, template: { title: 'Shared Template' } },
        ],
      },
    );
    expect(valid.manifest.entries.map(({ variantId }) => variantId)).to.deep.equal([
      'page-a',
      'page-b',
      'template',
    ]);
    expect(
      valid.manifest.landingPageTemplatePairs?.map(({ page: value }) => value.apiName),
    ).to.deep.equal(['PageA', 'PageB']);

    const cases = [
      {
        name: 'missing page',
        pages: [page('page-a', 'PageA')],
        templates: [template],
        api: 'Missing',
      },
      {
        name: 'duplicate page',
        pages: [page('page-a', 'PageA'), page('page-b', 'PageA')],
        templates: [template],
        api: 'PageA',
      },
      {
        name: 'missing title',
        pages: [page('page-a', 'PageA')],
        templates: [template],
        api: 'PageA',
        title: 'Missing',
      },
      {
        name: 'duplicate title',
        pages: [page('page-a', 'PageA')],
        templates: [template, { ...template, id: 'template-2' }],
        api: 'PageA',
      },
      {
        name: 'structural mismatch',
        pages: [page('page-a', 'PageA', 0)],
        templates: [template],
        api: 'PageA',
      },
      {
        name: 'multiple relationships',
        pages: [page('page-a', 'PageA', 2)],
        templates: [template],
        api: 'PageA',
      },
    ];
    for (const [index, testCase] of cases.entries()) {
      const details = [...testCase.pages, ...testCase.templates];
      const request = sinon.stub().callsFake(({ url }: { url: string }) => {
        if (url.startsWith('/connect/cms/items/search')) {
          const type = new URL(url, 'https://example.test').searchParams.get('contentTypeFQN');
          const values = type === 'sfdc_cms__landingPage' ? testCase.pages : testCase.templates;
          return fakeRequest({ items: values.map(({ id }) => row(id)), total: values.length });
        }
        return fakeRequest(details.find(({ id }) => url.endsWith(id)));
      });
      let failure: unknown;
      try {
        await exportWorkspace({ request }, 'space', path.join(root, `invalid-pair-${index}`), {
          landingPagePairs: [
            {
              page: { apiName: testCase.api },
              template: { title: testCase.title ?? 'Shared Template' },
            },
          ],
        });
      } catch (error) {
        failure = error;
      }
      expect(failure, testCase.name).to.be.instanceOf(TypeError);
    }
  });

  it('inventories evidenced CMS content identity without inspecting unknown payload fields', async () => {
    const request = sinon.stub().callsFake(({ url }: { url: string }) => {
      if (url.startsWith('/connect/cms/items/search')) {
        return fakeRequest({ items: [row('variant-b'), row('variant-a')], total: 2 });
      }
      const id = decodeURIComponent(url.split('/').at(-1) ?? '');
      return fakeRequest(
        detail(id, 'space', {
          contentId: 'content-1',
          contentKey: 'Opaque/Key + Exact',
          nestedUnknown: { linkedContentId: 'do-not-infer' },
        }),
      );
    });

    const { manifest } = await exportWorkspace({ request }, 'space', path.join(root, 'export'));

    expect(manifest.completeness).to.equal('complete');
    expect(manifest.externalReferences).to.have.length(1);
    expect(manifest.externalReferences[0]).to.deep.include({
      kind: 'cms.content',
      source: { workspaceId: 'space', sourceId: 'content-1' },
      portableKey: { scheme: 'cms-opaque-v1', value: 'Opaque/Key + Exact' },
      resolution: 'included',
    });
    expect(manifest.dependencies).to.deep.equal([]);
    expect(manifest.items.map(({ referenceId }) => referenceId)).to.deep.equal([
      manifest.externalReferences[0].referenceId,
      manifest.externalReferences[0].referenceId,
    ]);
    expect(JSON.stringify(manifest)).not.to.include('do-not-infer');
  });

  it('inventories documented parent IDs while preserving the raw live variant shape', async () => {
    const raw = {
      managedContentVariantId: 'variant-fixture',
      managedContentId: 'content-fixture',
      contentKey: 'fixture-key',
      contentType: { fullyQualifiedName: 'sfdc_cms__email' },
      contentSpace: { id: 'space' },
      externalId: null,
      contentBody: { subjectLine: 'Fixture' },
    };
    const request = sinon
      .stub()
      .callsFake(({ url }: { url: string }) =>
        fakeRequest(
          url.startsWith('/connect/cms/items/search')
            ? { items: [row('variant-fixture')], total: 1 }
            : raw,
        ),
      );
    const destination = path.join(root, 'export');
    const { manifest } = await exportWorkspace({ request }, 'space', destination);
    expect(manifest.completeness).to.equal('complete');
    expect(manifest.externalReferences[0].source.sourceId).to.equal('content-fixture');
    expect(manifest.items[0].referenceId).to.equal(manifest.externalReferences[0].referenceId);
    expect(
      JSON.parse(await readFile(path.join(destination, 'items/variant-fixture.json'), 'utf8')),
    ).to.deep.equal(raw);
  });

  for (const overrides of [
    { managedContentId: 'parent', contentId: 'other-parent' },
    { managedContentVariantId: 'other-variant' },
    { managedContentId: 'variant-fixture' },
    { managedContentId: null },
  ]) {
    it(`rejects contradictory export identity before publication ${JSON.stringify(overrides)}`, async () => {
      const request = sinon
        .stub()
        .callsFake(({ url }: { url: string }) =>
          fakeRequest(
            url.startsWith('/connect/cms/items/search')
              ? { items: [row('variant-fixture')], total: 1 }
              : detail('variant-fixture', 'space', { contentKey: 'key', ...overrides }),
          ),
        );
      let error: unknown;
      try {
        await exportWorkspace({ request }, 'space', path.join(root, 'export'));
      } catch (error_) {
        error = error_;
      }
      expect(error).to.be.instanceOf(TypeError);
      expect(await readdir(root)).to.deep.equal([]);
    });
  }

  it('emits unsupported relationships only when relationship fields are encountered', async () => {
    const referenceRoot = await mkdtemp(path.join(tmpdir(), 'sf-plugin-cms-reference-'));
    const request = sinon.stub().callsFake((request_: { url: string }) => {
      if (request_.url.includes('/connect/cms/items/search')) {
        return fakeRequest({ items: [row('with-reference')], total: 1 });
      }
      return fakeRequest(
        detail('with-reference', 'space', {
          contentId: 'content-1',
          contentKey: 'key-1',
          contentBody: {
            bannerImage: { ref: { contentKey: 'key-2', type: 'imageReference' } },
          },
        }),
      );
    });

    const { manifest } = await exportWorkspace(
      { request },
      'space',
      path.join(referenceRoot, 'export'),
    );

    expect(manifest.completeness).to.equal('partial');
    expect(manifest.dependencies).to.deep.equal([]);
    expect(manifest.externalReferences).to.deep.include.members([
      {
        referenceId: manifest.externalReferences.find(({ kind }) => kind === 'cms.relationship')!
          .referenceId,
        owner: 'cms',
        kind: 'cms.relationship',
        resolution: 'unsupported',
        source: { workspaceId: 'space', sourceId: 'with-reference' },
        portableKey: { scheme: 'cms-opaque-v1', value: 'with-reference' },
        required: true,
      },
    ]);
    expect(manifest.warnings.map(({ code }) => code)).to.include('REFERENCE_UNSUPPORTED');
    await rm(referenceRoot, { force: true, recursive: true });
  });

  it('marks ownership-ambiguous and identity-incomplete references explicitly', async () => {
    const request = sinon.stub().callsFake(({ url }: { url: string }) => {
      if (url.startsWith('/connect/cms/items/search')) {
        return fakeRequest({
          items: [row('ambiguous-a'), row('ambiguous-b'), row('unresolved')],
          total: 3,
        });
      }
      const id = decodeURIComponent(url.split('/').at(-1) ?? '');
      if (id === 'unresolved') return fakeRequest(detail(id, 'space', { contentKey: 'key-only' }));
      return fakeRequest(
        detail(id, 'space', {
          contentId: id === 'ambiguous-a' ? 'content-a' : 'content-b',
          contentKey: 'shared-key',
        }),
      );
    });

    const { manifest } = await exportWorkspace({ request }, 'space', path.join(root, 'export'));

    expect(manifest.completeness).to.equal('partial');
    expect(manifest.dependencies).to.deep.equal([]);
    expect(manifest.externalReferences.every(({ kind }) => kind === 'cms.unknown')).to.equal(true);
    expect(
      manifest.externalReferences.filter(({ resolution }) => resolution === 'unsupported'),
    ).to.have.length(2);
    expect(
      manifest.externalReferences.filter(({ resolution }) => resolution === 'unresolved'),
    ).to.have.length(1);
    expect(manifest.warnings.map(({ code }) => code)).to.include.members([
      'REFERENCE_UNRESOLVED',
      'REFERENCE_UNSUPPORTED',
    ]);
    expect(manifest.items.every(({ referenceId }) => referenceId === undefined)).to.equal(true);
  });

  it('reconstructs every multi-page search query and ignores nextPageUri', async () => {
    const searchUrls: string[] = [];
    const request = sinon.stub().callsFake(({ url }: { url: string }) => {
      if (url.startsWith('/connect/cms/items/search')) {
        searchUrls.push(url);
        const page = pageNumber(url);
        return fakeRequest({
          items: page === 0 ? [row('a')] : [row('b')],
          nextPageUri: '/wrong?page=99&token=secret',
          total: 2,
        });
      }
      return fakeRequest(detail(decodeURIComponent(url.split('/').at(-1) ?? '')));
    });

    await exportWorkspace({ request }, 'space', path.join(root, 'export'));

    expect(searchUrls).to.deep.equal([
      '/connect/cms/items/search?contentSpaceOrFolderIds=space&languages=All&page=0&pageSize=250&queryTerm=*',
      '/connect/cms/items/search?contentSpaceOrFolderIds=space&languages=All&page=1&pageSize=250&queryTerm=*',
    ]);
  });

  it('stops on an empty page despite a next link and warns about the mismatch', async () => {
    const request = sinon.stub().callsFake(({ url }: { url: string }) => {
      if (url.startsWith('/connect/cms/items/search')) {
        return fakeRequest(
          pageNumber(url) === 0
            ? { items: [row('a')], total: 3 }
            : { items: [], nextPageUri: '/keep-going', total: 3 },
        );
      }
      return fakeRequest(detail('a'));
    });

    const { manifest } = await exportWorkspace({ request }, 'space', path.join(root, 'export'));

    expect(manifest.pagesRequested).to.equal(2);
    expect(manifest.warnings.map(({ code }) => code)).to.include.members([
      'PREMATURE_EMPTY_PAGE',
      'COUNT_MISMATCH',
    ]);
  });

  it('stops on a duplicate-only nonempty page and aggregates duplicate IDs', async () => {
    const request = sinon.stub().callsFake(({ url }: { url: string }) => {
      if (url.startsWith('/connect/cms/items/search')) {
        return fakeRequest(
          pageNumber(url) === 0
            ? { items: [row('a')], total: 4 }
            : { items: [row('a'), row('a')], total: 4 },
        );
      }
      return fakeRequest(detail('a'));
    });

    const { manifest } = await exportWorkspace({ request }, 'space', path.join(root, 'export'));

    expect(manifest.pagesRequested).to.equal(2);
    expect(
      manifest.warnings.find(({ code }) => code === 'DUPLICATE_VARIANTS')?.variantIds,
    ).to.deep.equal(['a']);
    expect(manifest.warnings.some(({ code }) => code === 'COUNT_MISMATCH')).to.equal(true);
  });

  it('continues after partial duplicates add a new variant', async () => {
    const request = sinon.stub().callsFake(({ url }: { url: string }) => {
      if (url.startsWith('/connect/cms/items/search')) {
        const pages = [[row('a')], [row('a'), row('b')], [row('c')]];
        return fakeRequest({ items: pages[pageNumber(url)], total: 3 });
      }
      return fakeRequest(detail(decodeURIComponent(url.split('/').at(-1) ?? '')));
    });

    const { manifest } = await exportWorkspace({ request }, 'space', path.join(root, 'export'));

    expect(manifest.pagesRequested).to.equal(3);
    expect(manifest.entries.map(({ variantId }) => variantId)).to.deep.equal(['a', 'b', 'c']);
  });

  it('handles an advertised zero count with one search and no details', async () => {
    const request = sinon.stub().returns(fakeRequest({ items: [], total: 0 }));

    const { manifest } = await exportWorkspace({ request }, 'space', path.join(root, 'export'));

    expect(manifest).to.include({
      expectedCount: 0,
      foundCount: 0,
      exportedCount: 0,
      pagesRequested: 1,
    });
    expect(request.callCount).to.equal(1);
  });

  it('rejects malformed search envelopes rather than publishing a complete empty package', async () => {
    for (const [index, response] of [
      null,
      {},
      { items: null, total: 0 },
      { items: [], total: -1 },
      { items: [], total: '0' },
      { items: [] },
    ].entries()) {
      const request = sinon.stub().returns(fakeRequest(response));
      try {
        await exportWorkspace({ request }, 'space', path.join(root, `export-${index}`));
        expect.fail('expected malformed search rejection');
      } catch (error) {
        expect(error).to.be.instanceOf(TypeError);
        expect((error as Error).message).to.include('Workspace variant search response');
      }
      expect(request.calledOnce).to.equal(true);
    }
    expect(await readdir(root)).to.deep.equal([]);
  });

  it('preserves explicit source provenance and accepts all supported count keys', async () => {
    for (const countKey of ['total', 'totalCount', 'count']) {
      const request = sinon.stub().returns(fakeRequest({ items: [], [countKey]: 0 }));
      const result = await exportWorkspace({ request }, 'space', path.join(root, countKey), {
        sourceOrgId: '00DActual',
      });
      expect(result.manifest.completeness).to.equal('complete');
      expect(result.manifest.provenance.sourceOrgId).to.equal('00DActual');
      expect(
        JSON.parse(await readFile(path.join(result.destination, 'manifest.json'), 'utf8')),
      ).to.deep.equal(result.manifest);
    }
  });

  it('rejects search and detail ownership drift', async () => {
    const request = sinon.stub().callsFake(({ url }: { url: string }) => {
      if (url.startsWith('/connect/cms/items/search'))
        return fakeRequest({
          items: [row('search-drift', 'other'), row('detail-drift')],
          total: 2,
        });
      return fakeRequest(detail('detail-drift', 'other'));
    });

    const { manifest } = await exportWorkspace({ request }, 'space', path.join(root, 'export'));

    expect(manifest.exportedCount).to.equal(0);
    expect(manifest.rejectedVariantIds).to.deep.equal(['detail-drift', 'search-drift']);
    expect(
      manifest.warnings.find(({ code }) => code === 'OWNERSHIP_MISMATCH')?.variantIds,
    ).to.deep.equal(['detail-drift', 'search-drift']);
  });

  it('records detail failures and publishes successful details', async () => {
    const request = sinon.stub().callsFake(({ url }: { url: string }) => {
      if (url.startsWith('/connect/cms/items/search'))
        return fakeRequest({ items: [row('bad'), row('good')], total: 2 });
      return url.endsWith('/bad') ? failedRequest() : fakeRequest(detail('good'));
    });

    const { manifest } = await exportWorkspace({ request }, 'space', path.join(root, 'export'));

    expect(manifest.failedVariantIds).to.deep.equal(['bad']);
    expect(manifest.completeness).to.equal('partial');
    expect(manifest.entries).to.deep.equal([{ file: 'items/good.json', variantId: 'good' }]);
    expect(manifest.warnings.some(({ code }) => code === 'DETAIL_FAILED')).to.equal(true);
  });

  it('rejects an existing destination before making remote requests or writes', async () => {
    const destination = path.join(root, 'export');
    await writeFile(destination, 'keep', 'utf8');
    const request = sinon.stub();

    try {
      await exportWorkspace({ request }, 'space', destination);
      expect.fail('expected destination rejection');
    } catch (error) {
      expect((error as Error).message).to.include('already exists');
    }
    expect(request.callCount).to.equal(0);
    expect(await readFile(destination, 'utf8')).to.equal('keep');
  });

  it('creates missing destination parents and keeps sibling defaults distinct', async () => {
    const request = sinon.stub().returns(fakeRequest({ items: [], total: 0 }));
    const first = path.join(root, 'cms', safeWorkspaceDirectoryName('One'));
    const second = path.join(root, 'cms', safeWorkspaceDirectoryName('Two'));

    await exportWorkspace({ request }, 'one', first);
    await exportWorkspace({ request }, 'two', second);

    expect(await readdir(path.join(root, 'cms'))).to.deep.equal(['One', 'Two']);
  });

  it('writes stable two-space JSON bytes with a final LF', async () => {
    const request = sinon
      .stub()
      .callsFake(({ url }: { url: string }) =>
        url.startsWith('/connect/cms/items/search')
          ? fakeRequest({ items: [row('a')], total: 1 })
          : fakeRequest(detail('a')),
      );
    const destination = path.join(root, 'export');

    const { manifest } = await exportWorkspace({ request }, 'space', destination);

    expect(await readFile(path.join(destination, 'items', 'a.json'), 'utf8')).to.equal(
      `${JSON.stringify(detail('a'), null, 2)}\n`,
    );
    expect(await readFile(path.join(destination, 'manifest.json'), 'utf8')).to.equal(
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
    expect(JSON.stringify(manifest)).not.to.match(/token|timestamp/iu);
  });

  it('rejects a real destination collision without changing either directory', async () => {
    const temporary = path.join(root, '.export.tmp-real');
    const destination = path.join(root, 'export');
    await mkdir(temporary);
    await mkdir(destination);
    await writeFile(path.join(temporary, 'temporary.txt'), 'temporary', 'utf8');
    await writeFile(path.join(destination, 'destination.txt'), 'destination', 'utf8');

    let publicationError: unknown;
    try {
      await publishDirectoryNoClobber(temporary, destination);
      expect.fail('expected no-clobber collision');
    } catch (error) {
      publicationError = error;
    }

    expect(publicationError).to.be.instanceOf(Error);
    expect(await readFile(path.join(destination, 'destination.txt'), 'utf8')).to.equal(
      'destination',
    );
    expect(await readFile(path.join(temporary, 'temporary.txt'), 'utf8')).to.equal('temporary');

    try {
      await cleanupOwnedPath(temporary, publicationError);
    } catch (error) {
      expect(error).to.equal(publicationError);
    }
    expect(await readdir(root)).to.deep.equal(['export']);
  });

  it('leaves a destination that appears after preflight untouched', async () => {
    const request = sinon.stub().returns(fakeRequest({ items: [], total: 0 }));
    const destination = path.join(root, 'export');
    const collision = Object.assign(new Error('destination appeared'), { code: 'EEXIST' });
    const publishPath = sinon.stub().callsFake(async () => {
      await writeFile(destination, 'keep', 'utf8');
      throw collision;
    });

    try {
      await exportWorkspace({ request }, 'space', destination, {
        atomicPublish: { publishPath },
      });
      expect.fail('expected no-clobber publication failure');
    } catch (error) {
      expect(error).to.equal(collision);
    }

    expect(await readFile(destination, 'utf8')).to.equal('keep');
    const remainingFiles = await readdir(root);
    expect(remainingFiles.filter((name) => name.includes('.tmp-'))).to.deep.equal([]);
  });

  it('does not clean a temp path when uniquely owned temp creation fails', async () => {
    const request = sinon.stub().returns(fakeRequest({ items: [], total: 0 }));
    const destination = path.join(root, 'export');
    const preexisting = path.join(root, '.export.tmp-preexisting');
    await writeFile(preexisting, 'keep', 'utf8');
    const setupError = Object.assign(new Error('temp allocation collision'), { code: 'EEXIST' });
    const removePath = sinon.stub().resolves();

    try {
      await exportWorkspace({ request }, 'space', destination, {
        atomicPublish: {
          makeTemporaryDirectory: sinon.stub().rejects(setupError),
          removePath,
        },
      });
      expect.fail('expected temp allocation failure');
    } catch (error) {
      expect(error).to.equal(setupError);
    }

    expect(removePath.callCount).to.equal(0);
    expect(await readFile(preexisting, 'utf8')).to.equal('keep');
  });

  it('retries transient Windows directory publication errors without deleting the destination', async () => {
    const request = sinon.stub().returns(fakeRequest({ items: [], total: 0 }));
    const destination = path.join(root, 'export');
    const transient = Object.assign(new Error('scanner temporarily holds directory'), {
      code: 'EPERM',
    });
    const renamePath = sinon.stub();
    renamePath.onFirstCall().rejects(transient);
    renamePath
      .onSecondCall()
      .rejects(Object.assign(new Error('directory remains busy'), { code: 'EBUSY' }));
    renamePath.onThirdCall().callsFake(async (source: string, target: string) => {
      await rename(source, target);
    });
    const wait = sinon.stub().resolves();

    const result = await exportWorkspace({ request }, 'space', destination, {
      atomicPublish: { delay: wait, platform: 'win32', renamePath },
    });

    expect(result.manifestSha256).to.match(/^[a-f\d]{64}$/u);
    expect(wait.args).to.deep.equal([[10], [25]]);
    expect(renamePath.alwaysCalledWith(sinon.match.string, destination)).to.equal(true);
    expect(await readdir(root)).to.deep.equal(['export']);
  });

  it('preserves permanent directory publication errors and cleans its sibling temp directory', async () => {
    const request = sinon.stub().returns(fakeRequest({ items: [], total: 0 }));
    const destination = path.join(root, 'export');
    const permanent = Object.assign(new Error('directory remains locked'), { code: 'EPERM' });
    const renamePath = sinon.stub().rejects(permanent);
    const wait = sinon.stub().resolves();

    try {
      await exportWorkspace({ request }, 'space', destination, {
        atomicPublish: { delay: wait, platform: 'win32', renamePath },
      });
      expect.fail('expected permanent rename failure');
    } catch (error) {
      expect(error).to.equal(permanent);
    }

    expect(renamePath.callCount).to.equal(4);
    expect(wait.args).to.deep.equal([[10], [25], [50]]);
    expect(await readdir(root)).to.deep.equal([]);
  });

  it('preserves the original publication error identity when temp cleanup fails', async () => {
    const request = sinon.stub().returns(fakeRequest({ items: [], total: 0 }));
    const destination = path.join(root, 'export');
    const publicationError = Object.assign(new Error('publication failed'), { code: 'EACCES' });
    const cleanupError = Object.assign(new Error('cleanup failed'), { code: 'EPERM' });

    try {
      await exportWorkspace({ request }, 'space', destination, {
        atomicPublish: {
          platform: 'win32',
          publishPath: sinon.stub().rejects(publicationError),
          removePath: sinon.stub().rejects(cleanupError),
        },
      });
      expect.fail('expected publication failure');
    } catch (error) {
      expect(error).to.equal(publicationError);
      expect((error as Error & { cleanupError?: unknown }).cleanupError).to.equal(cleanupError);
    }

    const remainingFiles = await readdir(root);
    expect(remainingFiles.some((name) => name.includes('.tmp-'))).to.equal(true);
  });

  it('does not retry unrelated or non-Windows directory publication errors', async () => {
    const request = sinon.stub().returns(fakeRequest({ items: [], total: 0 }));
    const cases = [
      { code: 'EPERM', platform: 'linux' as const },
      { code: 'EACCES', platform: 'win32' as const },
    ];

    for (const [index, testCase] of cases.entries()) {
      const destination = path.join(root, `export-${index}`);
      const failure = Object.assign(new Error('rename failed'), { code: testCase.code });
      const renamePath = sinon.stub().rejects(failure);
      const wait = sinon.stub().resolves();
      try {
        await exportWorkspace({ request }, 'space', destination, {
          atomicPublish: { delay: wait, platform: testCase.platform, renamePath },
        });
        expect.fail('expected rename failure');
      } catch (error) {
        expect(error).to.equal(failure);
      }
      expect(renamePath.callCount).to.equal(1);
      expect(wait.callCount).to.equal(0);
    }
    expect(await readdir(root)).to.deep.equal([]);
  });

  it('cleans the temporary directory and never publishes after a write failure', async () => {
    const request = sinon
      .stub()
      .callsFake(({ url }: { url: string }) =>
        url.startsWith('/connect/cms/items/search')
          ? fakeRequest({ items: [row('missing/child')], total: 1 })
          : fakeRequest(detail('missing/child')),
      );
    const destination = path.join(root, 'export');

    try {
      await exportWorkspace({ request }, 'space', destination);
      expect.fail('expected write failure');
    } catch (error) {
      expect(error).to.be.instanceOf(Error);
    }
    expect(await readdir(root)).to.deep.equal([]);
  });
});
