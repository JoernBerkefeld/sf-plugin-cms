import { createHash } from 'node:crypto';
import { access, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { TestContext } from '@salesforce/core/testSetup';
import { expect } from 'chai';
import { brandDetail } from '../fixtures/brand.js';
import { formHandlerDetail } from '../fixtures/form-handler.js';
import ExportWorkspace from '../../src/commands/cms/export/workspace.js';
import type { ExportWorkspaceResult } from '../../src/services/export-workspace.js';

function fakeRequest<T>(value: T): Promise<T> & { stream(): { destroy(): void } } {
  return Object.assign(Promise.resolve(value), { stream: () => ({ destroy: () => {} }) });
}

function preferencePageDetail(id: string, apiName: string): Record<string, unknown> {
  return {
    apiName,
    contentType: { fullyQualifiedName: 'sfdc_cms__preferencePage' },
    managedContentId: `content-${id}`,
    managedContentVariantId: id,
    id,
    contentKey: `key-${id}`,
    contentSpace: { id: 'space', resourceUrl: '/connect/cms/spaces/space' },
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
                commSubChannelTypeIds: [`subchannel-${id}`],
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

describe('CMS export workspace command', () => {
  it('keeps every typed family selector mutually exclusive', () => {
    const flags = ExportWorkspace.flags as Record<string, { exclusive?: string[] }>;
    const familyFlags = [
      'preference-page-map',
      'brand-map',
      'form-map',
      'form-handler-map',
      'consent-banner-map',
    ];
    for (const flag of familyFlags) {
      for (const other of familyFlags) {
        if (other !== flag) expect(flags[flag].exclusive).to.include(other);
      }
    }
  });
  const $$ = new TestContext();
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    process.exitCode = undefined;
    $$.restore();
    await Promise.all(
      temporaryDirectories
        .splice(0)
        .map((directory) => rm(directory, { force: true, recursive: true })),
    );
  });

  it('defines only the required explicit export flags', () => {
    expect(Object.keys(ExportWorkspace.flags)).to.have.members([
      'target-org',
      'api-version',
      'contract-version',
      'all',
      'workspace-id',
      'workspace-name',
      'workspace-type',
      'email-fragment-map',
      'web-fragment-map',
      'landing-page-template-map',
      'landing-page-map',
      'preference-page-map',
      'brand-map',
      'form-map',
      'form-handler-map',
      'consent-banner-map',
      'landing-page-pair-map',
      'experimental-media',
      'output-dir',
      'editable-dir',
    ]);
    expect(ExportWorkspace.flags['target-org'].required).to.equal(true);
    expect(ExportWorkspace.flags['workspace-id'].required).not.to.equal(true);
    expect(ExportWorkspace.flags['workspace-name'].required).not.to.equal(true);
    expect(ExportWorkspace.flags['output-dir'].required).not.to.equal(true);
    expect(ExportWorkspace.flags['contract-version'].default).to.equal(1);
    expect(ExportWorkspace.flags.all.required).not.to.equal(true);
    expect(ExportWorkspace.flags.all.exclusive).to.deep.equal([
      'workspace-id',
      'workspace-name',
      'email-fragment-map',
      'web-fragment-map',
      'landing-page-template-map',
      'landing-page-map',
      'preference-page-map',
      'brand-map',
      'form-map',
      'form-handler-map',
      'consent-banner-map',
      'landing-page-pair-map',
    ]);
    expect(ExportWorkspace.flags['workspace-type'].dependsOn).to.deep.equal(['all']);
    expect(ExportWorkspace.flags['email-fragment-map'].exclusive).to.deep.equal([
      'all',
      'web-fragment-map',
      'landing-page-template-map',
      'landing-page-map',
      'preference-page-map',
      'brand-map',
      'form-map',
      'form-handler-map',
      'consent-banner-map',
      'landing-page-pair-map',
    ]);
    expect(ExportWorkspace.flags['web-fragment-map'].exclusive).to.deep.equal([
      'all',
      'email-fragment-map',
      'landing-page-template-map',
      'landing-page-map',
      'preference-page-map',
      'brand-map',
      'form-map',
      'form-handler-map',
      'consent-banner-map',
      'landing-page-pair-map',
    ]);
    expect(ExportWorkspace.flags['landing-page-template-map'].exclusive).to.deep.equal([
      'all',
      'email-fragment-map',
      'web-fragment-map',
      'landing-page-map',
      'preference-page-map',
      'brand-map',
      'form-map',
      'form-handler-map',
      'consent-banner-map',
      'landing-page-pair-map',
    ]);
    expect(ExportWorkspace.flags['landing-page-map'].exclusive).to.deep.equal([
      'all',
      'email-fragment-map',
      'web-fragment-map',
      'landing-page-template-map',
      'preference-page-map',
      'brand-map',
      'form-map',
      'form-handler-map',
      'consent-banner-map',
      'landing-page-pair-map',
    ]);
    expect(ExportWorkspace.flags['preference-page-map'].exclusive).to.deep.equal([
      'all',
      'email-fragment-map',
      'web-fragment-map',
      'landing-page-template-map',
      'landing-page-map',
      'brand-map',
      'form-map',
      'form-handler-map',
      'consent-banner-map',
      'landing-page-pair-map',
    ]);
    expect(ExportWorkspace.flags['landing-page-pair-map'].exclusive).to.deep.equal([
      'all',
      'email-fragment-map',
      'web-fragment-map',
      'landing-page-template-map',
      'landing-page-map',
      'preference-page-map',
      'brand-map',
      'form-map',
      'form-handler-map',
      'consent-banner-map',
    ]);
    expect(ExportWorkspace.flags['email-fragment-map'].summary).to.match(
      /exact sfdc_cms__emailFragment API names/iu,
    );
    expect(ExportWorkspace.flags['landing-page-template-map'].summary).to.match(
      /exact sfdc_cms__landingPageTemplate API names/iu,
    );
    expect(ExportWorkspace.flags['landing-page-map'].summary).to.match(
      /exact sfdc_cms__landingPage API names/iu,
    );
    expect(ExportWorkspace.flags['preference-page-map'].summary).to.match(
      /exact sfdc_cms__preferencePage API names.*raw items.*typed read reports/iu,
    );
    expect(ExportWorkspace.flags['landing-page-pair-map'].summary).to.match(
      /exact source template title/iu,
    );
    expect(ExportWorkspace.flags['experimental-media'].exclusive).to.deep.equal(['all']);
    expect(ExportWorkspace.flags['experimental-media'].summary).to.match(/single-workspace/iu);
    expect(ExportWorkspace.summary).to.match(/read-only.*best-effort/iu);
    expect(ExportWorkspace.description).to.match(
      /experimental.*not a complete or guaranteed backup/iu,
    );
    expect(
      Object.keys(ExportWorkspace.flags).some((flag) => /preference.*import/iu.test(flag)),
    ).to.equal(false);
  });

  it('wires the email-fragment JSON selection flag to the exact export type', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'cms-email-selection-command-'));
    temporaryDirectories.push(root);
    const selectionFile = path.join(root, 'email-fragments.json');
    await writeFile(selectionFile, '["FooterBlock","HeaderBlock"]\n', 'utf8');
    const destination = path.join(root, 'export');
    const request = $$.SANDBOX.stub().callsFake(({ url }: { url: string }) => {
      if (url === '/connect/cms/spaces/space') return fakeRequest({ id: 'space' });
      if (url.startsWith('/connect/cms/items/search')) {
        const query = new URL(url, 'https://example.test').searchParams;
        expect(query.get('contentTypeFQN')).to.equal('sfdc_cms__emailFragment');
        expect(query.get('queryTerm')).to.equal('*');
        return fakeRequest({
          items: [
            {
              id: 'z',
              managedContentSpaceId: 'space',
              type: 'ManagedContentVariantSearchResultRepresentation',
            },
            {
              id: 'a',
              managedContentSpaceId: 'space',
              type: 'ManagedContentVariantSearchResultRepresentation',
            },
          ],
          total: 2,
        });
      }
      const id = decodeURIComponent(url.split('/').at(-1) ?? '');
      return fakeRequest({
        apiName: id === 'a' ? 'HeaderBlock' : 'FooterBlock',
        contentId: `${id}-content`,
        contentKey: `${id}-key`,
        contentSpace: { id: 'space' },
        contentType: { fullyQualifiedName: 'sfdc_cms__emailFragment' },
        id,
      });
    });
    const command = Object.create(ExportWorkspace.prototype) as ExportWorkspace;
    Object.assign(command, {
      parse: $$.SANDBOX.stub().resolves({
        flags: {
          'workspace-id': 'space',
          'output-dir': destination,
          'email-fragment-map': selectionFile,
        },
      }),
      getOrgContext: $$.SANDBOX.stub().resolves({ connection: { request }, orgId: 'source' }),
      jsonEnabled: $$.SANDBOX.stub().returns(true),
      warn: $$.SANDBOX.stub(),
    });

    const result = (await command.run()) as ExportWorkspaceResult;

    expect(result.manifest.entries.map(({ variantId }) => variantId)).to.deep.equal(['a', 'z']);
    expect(result.manifest.expectedCount).to.equal(2);
    expect(result.manifest.exportedCount).to.equal(2);
  });

  it('wires the web-fragment JSON selection flag through wildcard inventory resolution', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'cms-web-selection-command-'));
    temporaryDirectories.push(root);
    const selectionFile = path.join(root, 'web-fragments.json');
    await writeFile(selectionFile, '["MCNEXT_P4_Landing_Block_2026_09_27"]\n', 'utf8');
    const destination = path.join(root, 'export');
    const request = $$.SANDBOX.stub().callsFake(({ url }: { url: string }) => {
      if (url === '/connect/cms/spaces/space') return fakeRequest({ id: 'space' });
      if (url.startsWith('/connect/cms/items/search')) {
        const query = new URL(url, 'https://example.test').searchParams;
        expect(query.get('contentTypeFQN')).to.equal('sfdc_cms__webFragment');
        if (query.get('queryTerm') !== '*') return fakeRequest({ items: [], total: 0 });
        return fakeRequest({
          items: [
            {
              id: 'web-draft',
              managedContentSpaceId: 'space',
              type: 'ManagedContentVariantSearchResultRepresentation',
            },
          ],
          total: 1,
        });
      }
      return fakeRequest({
        apiName: 'MCNEXT_P4_Landing_Block_2026_09_27',
        contentId: 'web-content',
        contentKey: 'web-key',
        contentSpace: { id: 'space' },
        contentType: { fullyQualifiedName: 'sfdc_cms__webFragment' },
        id: 'web-draft',
        status: 'Draft',
      });
    });
    const command = Object.create(ExportWorkspace.prototype) as ExportWorkspace;
    Object.assign(command, {
      parse: $$.SANDBOX.stub().resolves({
        flags: {
          'workspace-id': 'space',
          'output-dir': destination,
          'web-fragment-map': selectionFile,
        },
      }),
      getOrgContext: $$.SANDBOX.stub().resolves({ connection: { request }, orgId: 'source' }),
      jsonEnabled: $$.SANDBOX.stub().returns(true),
      warn: $$.SANDBOX.stub(),
    });

    const result = (await command.run()) as ExportWorkspaceResult;

    expect(result.manifest.entries).to.deep.equal([
      { file: 'items/web-draft.json', variantId: 'web-draft' },
    ]);
    expect(result.manifest.expectedCount).to.equal(1);
    expect(result.manifest.exportedCount).to.equal(1);
  });

  it('wires exact Preference Page selection to raw and typed read-report output', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'cms-preference-selection-command-'));
    temporaryDirectories.push(root);
    const selectionFile = path.join(root, 'preference-pages.json');
    await writeFile(selectionFile, '["PreferenceA"]\n', 'utf8');
    const destination = path.join(root, 'export');
    const request = $$.SANDBOX.stub().callsFake(
      ({ method, url }: { method?: string; url: string }) => {
        expect(method === undefined || method === 'GET').to.equal(true);
        if (url === '/connect/cms/spaces/space') return fakeRequest({ id: 'space' });
        if (url.startsWith('/connect/cms/items/search')) {
          const query = new URL(url, 'https://example.test').searchParams;
          expect(query.get('contentTypeFQN')).to.equal('sfdc_cms__preferencePage');
          expect(query.get('queryTerm')).to.equal('*');
          return fakeRequest({
            items: [
              {
                id: 'preference',
                managedContentSpaceId: 'space',
                type: 'ManagedContentVariantSearchResultRepresentation',
              },
            ],
            total: 1,
          });
        }
        return fakeRequest(preferencePageDetail('preference', 'PreferenceA'));
      },
    );
    const warn = $$.SANDBOX.stub();
    const command = Object.create(ExportWorkspace.prototype) as ExportWorkspace;
    Object.assign(command, {
      parse: $$.SANDBOX.stub().resolves({
        flags: {
          'workspace-id': 'space',
          'output-dir': destination,
          'preference-page-map': selectionFile,
        },
      }),
      getOrgContext: $$.SANDBOX.stub().resolves({ connection: { request }, orgId: 'source' }),
      jsonEnabled: $$.SANDBOX.stub().returns(true),
      warn,
    });

    const result = (await command.run()) as ExportWorkspaceResult;

    expect(Object.keys(result)).to.have.members(['destination', 'manifest', 'manifestSha256']);
    expect(result.manifest.entries).to.deep.equal([
      { file: 'items/preference.json', variantId: 'preference' },
    ]);
    expect(result.manifest.preferencePageReports).to.deep.equal([
      {
        path: 'reports/preference-pages/preference.json',
        rawItemPath: 'items/preference.json',
        workspaceId: 'space',
        contentType: 'sfdc_cms__preferencePage',
        variantId: 'preference',
        apiName: 'PreferenceA',
        format: 'sf-cms-preference-page-read-report@1',
      },
    ]);
    expect(result.manifest.completeness).to.equal('partial');
    expect(result.manifest.warnings.map(({ code }) => code)).to.include('REFERENCE_UNRESOLVED');
    expect(
      warn.calledWithMatch(/channel and subchannel references remain source-bound/iu),
    ).to.equal(true);
    expect(process.exitCode).to.equal(2);
    expect(request.getCalls().every(({ args }) => args[0].method !== 'POST')).to.equal(true);
    await access(path.join(destination, 'items/preference.json'));
    const report = JSON.parse(
      await readFile(path.join(destination, 'reports/preference-pages/preference.json'), 'utf8'),
    ) as { normalization: { unresolvedReferences: Array<{ sourceId: string }> } };
    expect(report.normalization.unresolvedReferences.map(({ sourceId }) => sourceId)).to.deep.equal(
      ['channel-preference', 'subchannel-preference'],
    );
  });

  it('wires exact Brand selection to raw and typed read-report output', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'cms-brand-selection-command-'));
    temporaryDirectories.push(root);
    const selectionFile = path.join(root, 'brands.json');
    await writeFile(selectionFile, '["BrandA"]\n', 'utf8');
    const destination = path.join(root, 'export');
    const request = $$.SANDBOX.stub().callsFake(
      ({ method, url }: { method?: string; url: string }) => {
        expect(method === undefined || method === 'GET').to.equal(true);
        if (url === '/connect/cms/spaces/space') return fakeRequest({ id: 'space' });
        if (url.startsWith('/connect/cms/items/search')) {
          const query = new URL(url, 'https://example.test').searchParams;
          expect(query.get('contentTypeFQN')).to.equal('sfdc_cms__brand');
          expect(query.get('queryTerm')).to.equal('*');
          return fakeRequest({
            items: [
              {
                id: 'brand',
                managedContentSpaceId: 'space',
                type: 'ManagedContentVariantSearchResultRepresentation',
              },
            ],
            total: 1,
          });
        }
        return fakeRequest(brandDetail('brand', 'BrandA'));
      },
    );
    const warn = $$.SANDBOX.stub();
    const command = Object.create(ExportWorkspace.prototype) as ExportWorkspace;
    Object.assign(command, {
      parse: $$.SANDBOX.stub().resolves({
        flags: {
          'workspace-id': 'space',
          'output-dir': destination,
          'brand-map': selectionFile,
        },
      }),
      getOrgContext: $$.SANDBOX.stub().resolves({ connection: { request }, orgId: 'source' }),
      jsonEnabled: $$.SANDBOX.stub().returns(true),
      warn,
    });

    const result = (await command.run()) as ExportWorkspaceResult;

    expect(result.manifest.entries).to.deep.equal([
      { file: 'items/brand.json', variantId: 'brand' },
    ]);
    expect(result.manifest.brandReports).to.deep.equal([
      {
        path: 'reports/brands/brand.json',
        rawItemPath: 'items/brand.json',
        workspaceId: 'space',
        contentType: 'sfdc_cms__brand',
        variantId: 'brand',
        apiName: 'BrandA',
        format: 'sf-cms-brand-read-report@1',
      },
    ]);
    expect(result.manifest.completeness).to.equal('complete');
    expect(result.manifest.warnings.map(({ code }) => code)).not.to.include('REFERENCE_UNRESOLVED');
    expect(warn.neverCalledWithMatch(/references remain source-bound/iu)).to.equal(true);
    expect(process.exitCode).to.equal(undefined);
    expect(request.getCalls().every(({ args }) => args[0].method !== 'POST')).to.equal(true);
    await access(path.join(destination, 'items/brand.json'));
    const report = JSON.parse(
      await readFile(path.join(destination, 'reports/brands/brand.json'), 'utf8'),
    ) as { normalization: { unresolvedReferences: unknown[] } };
    expect(report.normalization.unresolvedReferences).to.deep.equal([]);
  });

  it('rejects malformed Brand selection before export search', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'cms-brand-selection-command-'));
    temporaryDirectories.push(root);
    const selectionFile = path.join(root, 'invalid.json');
    await writeFile(selectionFile, '["BrandA",1]\n', 'utf8');
    const request = $$.SANDBOX.stub().returns(fakeRequest({ id: 'space' }));
    const command = Object.create(ExportWorkspace.prototype) as ExportWorkspace;
    Object.assign(command, {
      parse: $$.SANDBOX.stub().resolves({
        flags: {
          'workspace-id': 'space',
          'output-dir': path.join(root, 'export'),
          'brand-map': selectionFile,
        },
      }),
      getOrgContext: $$.SANDBOX.stub().resolves({ connection: { request }, orgId: 'source' }),
    });

    let failure: unknown;
    try {
      await command.run();
    } catch (error) {
      failure = error;
    }

    expect(failure).to.be.instanceOf(TypeError);
    expect((failure as Error).message).to.include('JSON array of API-name strings');
    expect(request.calledOnce).to.equal(true);
    expect(request.firstCall.args[0].url).to.equal('/connect/cms/spaces/space');
  });

  it('rejects malformed Preference Page selection before export search', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'cms-preference-selection-command-'));
    temporaryDirectories.push(root);
    const selectionFile = path.join(root, 'invalid.json');
    await writeFile(selectionFile, '["PreferenceA",1]\n', 'utf8');
    const request = $$.SANDBOX.stub().returns(fakeRequest({ id: 'space' }));
    const command = Object.create(ExportWorkspace.prototype) as ExportWorkspace;
    Object.assign(command, {
      parse: $$.SANDBOX.stub().resolves({
        flags: {
          'workspace-id': 'space',
          'output-dir': path.join(root, 'export'),
          'preference-page-map': selectionFile,
        },
      }),
      getOrgContext: $$.SANDBOX.stub().resolves({ connection: { request }, orgId: 'source' }),
    });

    let failure: unknown;
    try {
      await command.run();
    } catch (error) {
      failure = error;
    }

    expect(failure).to.be.instanceOf(TypeError);
    expect((failure as Error).message).to.include('JSON array of API-name strings');
    expect(request.calledOnce).to.equal(true);
    expect(request.firstCall.args[0].url).to.equal('/connect/cms/spaces/space');
  });

  it('requires canonical structured Marketing evidence for Form Handler export', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'cms-form-handler-space-command-'));
    temporaryDirectories.push(root);
    const selectionFile = path.join(root, 'form-handlers.json');
    await writeFile(selectionFile, '["source_form_handler_api"]\n', 'utf8');
    const request = $$.SANDBOX.stub().callsFake(({ url }: { url: string }) => {
      if (url === '/connect/cms/spaces/space') {
        return fakeRequest({ id: 'space', spaceType: { apiName: 'marketing' } });
      }
      if (url.startsWith('/connect/cms/items/search')) {
        return fakeRequest({
          items: [
            {
              id: 'variant-form-handler-id',
              managedContentSpaceId: 'space',
              type: 'ManagedContentVariantSearchResultRepresentation',
            },
          ],
          total: 1,
        });
      }
      return fakeRequest(formHandlerDetail('variant'));
    });
    const command = Object.create(ExportWorkspace.prototype) as ExportWorkspace;
    Object.assign(command, {
      parse: $$.SANDBOX.stub().resolves({
        flags: {
          'target-org': 'source-alias',
          'api-version': '67.0',
          'workspace-id': 'space',
          'output-dir': path.join(root, 'export'),
          'form-handler-map': selectionFile,
        },
      }),
      getOrgContext: $$.SANDBOX.stub().resolves({ connection: { request }, orgId: 'source' }),
      jsonEnabled: $$.SANDBOX.stub().returns(true),
      warn: $$.SANDBOX.stub(),
    });

    let failure: unknown;
    try {
      await command.run();
    } catch (error) {
      failure = error;
    }
    expect(failure).to.be.instanceOf(Error);
    expect((failure as Error).message).to.include('not canonically Marketing');
    expect(request.calledOnce).to.equal(true);
  });

  it('wires title-resolved landing-page pairs and records canonical template identity', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'cms-landing-pair-command-'));
    temporaryDirectories.push(root);
    const selectionFile = path.join(root, 'pairs.json');
    await writeFile(
      selectionFile,
      `${JSON.stringify([
        {
          page: { apiName: 'SourcePage' },
          template: { title: 'Human Template Label' },
        },
      ])}\n`,
      'utf8',
    );
    const request = $$.SANDBOX.stub().callsFake(({ url }: { url: string }) => {
      if (url === '/connect/cms/spaces/space') return fakeRequest({ id: 'space' });
      if (url.startsWith('/connect/cms/items/search')) {
        const type = new URL(url, 'https://example.test').searchParams.get('contentTypeFQN');
        return fakeRequest(
          type === 'sfdc_cms__landingPage'
            ? {
                items: [
                  {
                    id: 'page',
                    managedContentSpaceId: 'space',
                    type: 'ManagedContentVariantSearchResultRepresentation',
                  },
                ],
                total: 1,
              }
            : {
                items: [
                  {
                    id: 'template',
                    managedContentSpaceId: 'space',
                    type: 'ManagedContentVariantSearchResultRepresentation',
                  },
                ],
                total: 1,
              },
        );
      }
      return fakeRequest(
        url.endsWith('/page')
          ? {
              apiName: 'SourcePage',
              contentKey: 'page-key',
              contentSpace: { id: 'space' },
              contentType: { fullyQualifiedName: 'sfdc_cms__landingPage' },
              id: 'page',
              references: [
                {
                  apiName: 'opaque-value',
                  contentTypeFQN: 'sfdc_cms__landingPageTemplate',
                },
              ],
            }
          : {
              apiName: 'CanonicalTemplate',
              contentKey: 'template-key',
              contentSpace: { id: 'space' },
              contentType: { fullyQualifiedName: 'sfdc_cms__landingPageTemplate' },
              id: 'template',
              title: 'Human Template Label',
            },
      );
    });
    const command = Object.create(ExportWorkspace.prototype) as ExportWorkspace;
    Object.assign(command, {
      parse: $$.SANDBOX.stub().resolves({
        flags: {
          'workspace-id': 'space',
          'output-dir': path.join(root, 'export'),
          'landing-page-pair-map': selectionFile,
        },
      }),
      getOrgContext: $$.SANDBOX.stub().resolves({ connection: { request }, orgId: 'source' }),
      jsonEnabled: $$.SANDBOX.stub().returns(true),
      warn: $$.SANDBOX.stub(),
    });

    const result = (await command.run()) as ExportWorkspaceResult;
    expect(result.manifest.landingPageTemplatePairs?.[0].template).to.deep.include({
      requestedTitle: 'Human Template Label',
      apiName: 'CanonicalTemplate',
      contentKey: 'template-key',
      variantId: 'template',
    });
  });

  it('rejects malformed email-fragment selection JSON before export search', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'cms-email-selection-command-'));
    temporaryDirectories.push(root);
    for (const [index, json] of ['{}', '["Valid",1]'].entries()) {
      const selectionFile = path.join(root, `invalid-${index}.json`);
      await writeFile(selectionFile, `${json}\n`, 'utf8');
      const request = $$.SANDBOX.stub().returns(fakeRequest({ id: 'space' }));
      const command = Object.create(ExportWorkspace.prototype) as ExportWorkspace;
      Object.assign(command, {
        parse: $$.SANDBOX.stub().resolves({
          flags: {
            'workspace-id': 'space',
            'output-dir': path.join(root, `export-${index}`),
            'email-fragment-map': selectionFile,
          },
        }),
        getOrgContext: $$.SANDBOX.stub().resolves({ connection: { request }, orgId: 'source' }),
      });
      let failure: unknown;
      try {
        await command.run();
      } catch (error) {
        failure = error;
      }
      expect(failure).to.be.instanceOf(TypeError);
      expect((failure as Error).message).to.include('JSON array of API-name strings');
      expect(request.calledOnce).to.equal(true);
    }
  });

  it('rejects invalid editable flags and both overlap directions before org access or writes', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'cms-editable-command-'));
    temporaryDirectories.push(root);
    const output = path.join(root, 'source');
    for (const flags of [
      { 'editable-dir': path.join(root, 'editable') },
      { all: true, 'output-dir': output, 'editable-dir': path.join(root, 'editable') },
      { 'output-dir': output, 'editable-dir': output },
      { 'output-dir': output, 'editable-dir': path.join(output, 'child') },
      { 'output-dir': path.join(output, 'child'), 'editable-dir': output },
    ]) {
      const command = Object.create(ExportWorkspace.prototype) as ExportWorkspace;
      const getOrgContext = $$.SANDBOX.stub();
      Object.assign(command, {
        parse: $$.SANDBOX.stub().resolves({ flags: { 'workspace-id': 'space', ...flags } }),
        getOrgContext,
      });
      let failure: unknown;
      try {
        await command.run();
      } catch (error) {
        failure = error;
      }
      expect(failure).to.be.instanceOf(Error);
      expect((failure as Error).message).to.match(/explicit|incompatible|overlap/u);
      expect(getOrgContext.notCalled).to.equal(true);
      expect(await readdir(root)).to.deep.equal([]);
    }
    expect(ExportWorkspace.flags['editable-dir'].dependsOn).to.deep.equal(['output-dir']);
    expect(ExportWorkspace.flags['editable-dir'].exclusive).to.deep.equal(['all']);
  });

  it('publishes the editable subset while retaining partial exit and machine result shape', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'cms-editable-command-'));
    temporaryDirectories.push(root);
    const editable = path.join(root, 'editable');
    const command = Object.create(ExportWorkspace.prototype) as ExportWorkspace;
    const request = $$.SANDBOX.stub().callsFake(({ url }: { url: string }) => {
      if (url === '/connect/cms/spaces/space') return fakeRequest({ id: 'space' });
      if (url.startsWith('/connect/cms/items/search'))
        return fakeRequest({
          items: [
            {
              id: 'variant',
              managedContentSpaceId: 'space',
              type: 'ManagedContentVariantSearchResultRepresentation',
            },
          ],
          total: 2,
        });
      return fakeRequest({
        id: 'variant',
        contentSpace: { id: 'space' },
        contentType: 'sfdc_cms__email',
        contentBody: { rawHtml: '<p>literal</p>' },
      });
    });
    Object.assign(command, {
      parse: $$.SANDBOX.stub().resolves({
        flags: {
          'workspace-id': 'space',
          'output-dir': path.join(root, 'source'),
          'editable-dir': editable,
        },
      }),
      getOrgContext: $$.SANDBOX.stub().resolves({ connection: { request }, orgId: 'source' }),
      jsonEnabled: $$.SANDBOX.stub().returns(true),
      warn: $$.SANDBOX.stub(),
    });
    const result = (await command.run()) as ExportWorkspaceResult;
    expect(Object.keys(result)).to.have.members(['destination', 'manifest', 'manifestSha256']);
    expect(result.manifest.completeness).to.equal('partial');
    expect(process.exitCode).to.equal(2);
    expect(await readFile(path.join(editable, 'items/variant.html'), 'utf8')).to.equal(
      '<p>literal</p>',
    );
  });

  for (const enabled of [false, true]) {
    it(`${enabled ? 'enables' : 'does not enable'} single-workspace media transport only with the explicit flag`, async () => {
      const root = await mkdtemp(path.join(tmpdir(), 'cms-media-command-'));
      temporaryDirectories.push(root);
      const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
      const md5 = createHash('md5').update(png).digest('hex');
      const request = $$.SANDBOX.stub().callsFake(
        ({ method, url }: { method?: string; url: string }) => {
          expect(method === undefined || method === 'GET').to.equal(true);
          if (url === '/connect/cms/spaces/space') return fakeRequest({ id: 'space' });
          if (url.startsWith('/connect/cms/items/search'))
            return fakeRequest({
              items: [
                {
                  id: 'variant',
                  managedContentSpaceId: 'space',
                  type: 'ManagedContentVariantSearchResultRepresentation',
                },
              ],
              total: 1,
            });
          return fakeRequest({
            contentBody: {
              'sfdc_cms:media': {
                source: { mimeType: 'image/png', size: png.length, type: 'file' },
                url: `/cms/media/key?fileHash=${md5}&fileName=image.png&version=1`,
              },
            },
            contentId: 'content',
            contentKey: 'key',
            contentSpace: { id: 'space' },
            contentType: 'sfdc_cms__image',
            id: 'variant',
            lastModifiedDate: '2026-01-01T00:00:00.000Z',
            status: { status: 'Draft' },
          });
        },
      );
      let fetchCalls = 0;
      const fetcher = $$.SANDBOX.stub(globalThis, 'fetch').callsFake(async () => {
        fetchCalls += 1;
        return fetchCalls === 1
          ? new Response(null, {
              headers: {
                location: `https://tenant.file.force.com/cms/media/key?fileHash=${md5}&fileName=image.png&version=1`,
              },
              status: 301,
            })
          : new Response(png, {
              headers: { 'content-length': String(png.length), 'content-type': 'image/png' },
              status: 200,
            });
      });
      const connection = {
        accessToken: 'synthetic-token',
        instanceUrl: 'https://tenant.my.salesforce.com',
        request,
      };
      const command = Object.create(ExportWorkspace.prototype) as ExportWorkspace;
      Object.assign(command, {
        parse: $$.SANDBOX.stub().resolves({
          flags: {
            'workspace-id': 'space',
            'output-dir': path.join(root, enabled ? 'enabled' : 'disabled'),
            'experimental-media': enabled,
          },
        }),
        getOrgContext: $$.SANDBOX.stub().resolves({ connection, orgId: 'source' }),
        jsonEnabled: $$.SANDBOX.stub().returns(true),
        warn: $$.SANDBOX.stub(),
      });

      const result = (await command.run()) as ExportWorkspaceResult;

      expect(fetcher.callCount).to.equal(enabled ? 2 : 0);
      expect(result.manifest.schemaVersion).to.equal(2);
      expect(result.manifest.media).to.have.length(enabled ? 1 : 0);
      expect(result.manifest.completeness).to.equal(enabled ? 'complete' : 'partial');
      expect(request.getCalls().every(({ args }) => args[0].method !== 'POST')).to.equal(true);
    });
  }

  it('rejects missing or combined workspace selectors before org access', async () => {
    for (const flags of [
      { 'output-dir': 'export-dir' },
      { 'output-dir': 'export-dir', 'workspace-id': 'id', 'workspace-name': 'name' },
    ]) {
      const command = Object.create(ExportWorkspace.prototype) as ExportWorkspace;
      const getConnection = $$.SANDBOX.stub();
      Object.assign(command, {
        parse: $$.SANDBOX.stub().resolves({
          flags: { 'api-version': '67.0', 'target-org': 'mcnext-sdo', ...flags },
        }),
        getConnection,
      });
      try {
        await command.run();
        expect.fail('expected selector failure');
      } catch (error) {
        expect((error as Error).message).to.include('exactly one');
      }
      expect(getConnection.notCalled).to.equal(true);
    }
  });

  it('rejects a workspace ID mismatch before invoking export search', async () => {
    const command = Object.create(ExportWorkspace.prototype) as ExportWorkspace;
    const request = $$.SANDBOX.stub().returns(fakeRequest({ id: 'different-space', name: 'Main' }));
    Object.assign(command, {
      parse: $$.SANDBOX.stub().resolves({
        flags: {
          'target-org': 'mcnext-sdo',
          'api-version': '67.0',
          'workspace-id': 'requested-space',
          'output-dir': 'export-dir',
        },
      }),
      getOrgContext: $$.SANDBOX.stub().resolves({ connection: { request }, orgId: '00DSource' }),
    });

    try {
      await command.run();
      expect.fail('expected workspace validation failure');
    } catch (error) {
      expect((error as Error).message).to.include('different-space');
    }
    expect(request.calledOnce).to.equal(true);
    expect(request.firstCall.args[0].url).to.equal('/connect/cms/spaces/requested-space');
  });

  it('rejects an omitted output when the canonical workspace has no usable name before writing', async () => {
    const command = Object.create(ExportWorkspace.prototype) as ExportWorkspace;
    const root = await mkdtemp(path.join(tmpdir(), 'sf-plugin-cms-command-'));
    temporaryDirectories.push(root);
    const request = $$.SANDBOX.stub().returns(fakeRequest({ id: 'space' }));
    Object.assign(command, {
      parse: $$.SANDBOX.stub().resolves({
        flags: {
          'target-org': 'mcnext-sdo',
          'api-version': '67.0',
          'workspace-id': 'space',
        },
      }),
      getOrgContext: $$.SANDBOX.stub().resolves({ connection: { request }, orgId: '00DSource' }),
    });

    const previousCwd = process.cwd();
    process.chdir(root);
    try {
      await command.run();
      expect.fail('expected missing workspace name failure');
    } catch (error) {
      expect((error as Error).message).to.include('no usable name');
    } finally {
      process.chdir(previousCwd);
    }

    expect(request.calledOnce).to.equal(true);
    try {
      await access(path.join(root, 'cms'));
      expect.fail('expected no export directory');
    } catch (error) {
      expect((error as NodeJS.ErrnoException).code).to.equal('ENOENT');
    }
  });

  it('exports by workspace name to the safe default destination', async () => {
    const command = Object.create(ExportWorkspace.prototype) as ExportWorkspace;
    const root = await mkdtemp(path.join(tmpdir(), 'sf-plugin-cms-command-'));
    temporaryDirectories.push(root);
    const request = $$.SANDBOX.stub().callsFake(({ url }: { url: string }) => {
      if (url.startsWith('/connect/cms/spaces?')) {
        const page = Number(new URL(url, 'https://example.test').searchParams.get('page'));
        return fakeRequest({
          currentPage: page,
          pageSize: 250,
          spaces: page === 0 ? [{ id: 'space', name: 'Main/Site' }] : [],
          total: 1,
        });
      }
      if (url === '/connect/cms/spaces/space')
        return fakeRequest({ id: 'space', name: 'Main/Site' });
      return fakeRequest({ items: [], total: 0 });
    });
    Object.assign(command, {
      parse: $$.SANDBOX.stub().resolves({
        flags: {
          'target-org': 'mcnext-sdo',
          'api-version': '67.0',
          'workspace-name': 'Main/Site',
        },
      }),
      getOrgContext: $$.SANDBOX.stub().resolves({ connection: { request }, orgId: '00DSource' }),
      jsonEnabled: $$.SANDBOX.stub().returns(true),
      warn: $$.SANDBOX.stub(),
    });

    const previousCwd = process.cwd();
    process.chdir(root);
    let result;
    try {
      result = await command.run();
    } finally {
      process.chdir(previousCwd);
    }

    const singleResult = result as ExportWorkspaceResult;
    expect(singleResult.destination).to.equal(path.join('cms', 'Main_Site'));
    await access(path.join(root, singleResult.destination, 'manifest.json'));
  });

  for (const jsonEnabled of [false, true]) {
    it(`exports, warns, and ${jsonEnabled ? 'suppresses' : 'renders'} human output in JSON=${jsonEnabled} mode`, async () => {
      const command = Object.create(ExportWorkspace.prototype) as ExportWorkspace;
      const root = await mkdtemp(path.join(tmpdir(), 'sf-plugin-cms-command-'));
      temporaryDirectories.push(root);
      const destination = path.join(root, 'export');
      const request = $$.SANDBOX.stub().callsFake(({ url }: { url: string }) => {
        if (url === '/connect/cms/spaces/space') return fakeRequest({ id: 'space' });
        if (url.startsWith('/connect/cms/items/search')) {
          return fakeRequest({
            items: [
              {
                id: 'variant',
                managedContentSpaceId: 'space',
                type: 'ManagedContentVariantSearchResultRepresentation',
              },
            ],
            total: 1,
          });
        }
        return fakeRequest({ contentSpace: { id: 'space' }, id: 'variant' });
      });
      const warn = $$.SANDBOX.stub();
      const log = $$.SANDBOX.stub();
      Object.assign(command, {
        parse: $$.SANDBOX.stub().resolves({
          flags: {
            'target-org': 'mcnext-sdo',
            'api-version': '67.0',
            'workspace-id': 'space',
            'output-dir': destination,
          },
        }),
        getOrgContext: $$.SANDBOX.stub().resolves({ connection: { request }, orgId: '00DSource' }),
        jsonEnabled: $$.SANDBOX.stub().returns(jsonEnabled),
        warn,
        log,
      });

      const result = await command.run();

      const singleResult = result as ExportWorkspaceResult;
      expect(singleResult.destination).to.equal(destination);
      expect(singleResult.manifest.exportedCount).to.equal(1);
      expect(singleResult.manifest.provenance.sourceOrgId).to.equal('00DSource');
      expect(singleResult.manifest.completeness).to.equal('complete');
      expect(process.exitCode).to.equal(undefined);
      expect(request.callCount).to.equal(3);
      expect(warn.calledOnce).to.equal(true);
      expect(warn.firstCall.args[0]).to.match(/^\[UNSUPPORTED_WILDCARD\]/u);
      if (jsonEnabled) {
        expect(log.notCalled).to.equal(true);
      } else {
        expect(log.callCount).to.equal(2);
        expect(log.firstCall.args[0]).to.equal(`Destination: ${destination}`);
        expect(log.secondCall.args[0]).to.equal('Exported variants: 1/1 expected');
      }
    });
  }

  for (const jsonEnabled of [false, true]) {
    it(`retains partial diagnostics and provenance with exit 2 in JSON=${jsonEnabled} mode`, async () => {
      const command = Object.create(ExportWorkspace.prototype) as ExportWorkspace;
      const root = await mkdtemp(path.join(tmpdir(), 'sf-plugin-cms-command-'));
      temporaryDirectories.push(root);
      const request = $$.SANDBOX.stub().callsFake(({ url }: { url: string }) => {
        if (url === '/connect/cms/spaces/space') return fakeRequest({ id: 'space' });
        return fakeRequest({ items: [], total: 1 });
      });
      const warn = $$.SANDBOX.stub();
      const log = $$.SANDBOX.stub();
      Object.assign(command, {
        parse: $$.SANDBOX.stub().resolves({
          flags: {
            'target-org': 'source-alias',
            'api-version': '67.0',
            'workspace-id': 'space',
            'output-dir': path.join(root, 'export'),
          },
        }),
        getOrgContext: $$.SANDBOX.stub().resolves({ connection: { request }, orgId: '00DActual' }),
        jsonEnabled: $$.SANDBOX.stub().returns(jsonEnabled),
        warn,
        log,
      });

      const result = (await command.run()) as ExportWorkspaceResult;

      expect(Object.keys(result)).to.have.members(['destination', 'manifest', 'manifestSha256']);
      expect(result.manifest.provenance.sourceOrgId).to.equal('00DActual');
      expect(result.manifest.completeness).to.equal('partial');
      expect(result.manifest.warnings.map(({ code }) => code)).to.include.members([
        'PREMATURE_EMPTY_PAGE',
        'COUNT_MISMATCH',
      ]);
      expect(warn.callCount).to.equal(result.manifest.warnings.length);
      expect(log.callCount).to.equal(jsonEnabled ? 0 : 2);
      expect(process.exitCode).to.equal(2);
      await access(path.join(result.destination, 'manifest.json'));
    });
  }

  for (const all of [false, true]) {
    it(`blocks an unsupported ${all ? 'bulk' : 'single'} contract version before org access`, async () => {
      const command = Object.create(ExportWorkspace.prototype) as ExportWorkspace;
      const getOrgContext = $$.SANDBOX.stub();
      const getConnection = $$.SANDBOX.stub();
      Object.assign(command, {
        parse: $$.SANDBOX.stub().resolves({
          flags: {
            'target-org': 'mcnext-sdo',
            'api-version': '67.0',
            'contract-version': 2,
            all,
            'workspace-id': all ? undefined : '0ZuSource',
          },
        }),
        getConnection,
        getOrgContext,
        jsonEnabled: $$.SANDBOX.stub().returns(true),
      });

      const result = await command.run();

      expect('status' in result && result.status).to.equal('blocked');
      expect('diagnostics' in result && result.diagnostics.errors[0].code).to.equal(
        'UNSUPPORTED_CONTRACT_VERSION',
      );
      expect(getOrgContext.notCalled).to.equal(true);
      expect(getConnection.notCalled).to.equal(true);
      expect(process.exitCode).to.equal(1);
    });
  }

  for (const jsonEnabled of [false, true]) {
    it(`returns mixed bulk results in JSON=${jsonEnabled} mode and sets exitCode`, async () => {
      const command = Object.create(ExportWorkspace.prototype) as ExportWorkspace;
      const root = await mkdtemp(path.join(tmpdir(), 'sf-plugin-cms-command-'));
      temporaryDirectories.push(root);
      const outputDirectory = path.join(root, 'cms');
      const request = $$.SANDBOX.stub().callsFake(({ url }: { url: string }) => {
        if (url.startsWith('/connect/cms/spaces?')) {
          const page = Number(new URL(url, 'https://example.test').searchParams.get('page'));
          return fakeRequest({
            spaces:
              page === 0
                ? [
                    { id: 'b', name: 'Second', spaceType: { apiName: 'marketing' } },
                    { id: 'a', name: 'First', spaceType: { apiName: 'marketing' } },
                  ]
                : [],
          });
        }
        if (url === '/connect/cms/spaces/a')
          return fakeRequest({ id: 'a', name: 'First', spaceType: { apiName: 'marketing' } });
        if (url === '/connect/cms/spaces/b')
          return fakeRequest({ id: 'b', name: 'Second', spaceType: { apiName: 'marketing' } });
        if (url.includes('contentSpaceOrFolderIds=a'))
          return Promise.reject(new Error('first failed'));
        return fakeRequest({ items: [], total: 0 });
      });
      const styledJSON = $$.SANDBOX.stub();
      Object.assign(command, {
        parse: $$.SANDBOX.stub().resolves({
          flags: {
            'target-org': 'mcnext-sdo',
            'api-version': '67.0',
            all: true,
            'output-dir': outputDirectory,
          },
        }),
        getOrgContext: $$.SANDBOX.stub().resolves({ connection: { request }, orgId: '00DSource' }),
        jsonEnabled: $$.SANDBOX.stub().returns(jsonEnabled),
        styledJSON,
      });

      const result = await command.run();

      expect('status' in result && result.status).to.equal('partial');
      expect('result' in result && result.result?.summary.failedCount).to.equal(1);
      expect(process.exitCode).to.equal(2);
      expect(styledJSON.calledOnce).to.equal(!jsonEnabled);
    });
  }
});
