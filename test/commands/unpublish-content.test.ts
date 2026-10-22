import { Parser } from '@oclif/core';
import { Connection as JsforceConnection } from '@jsforce/jsforce-node';
import { TestContext } from '@salesforce/core/testSetup';
import { expect } from 'chai';
import { lstat } from 'node:fs/promises';
import {
  createRunOwnedDirectory,
  createRunOwnedTemp,
  removeRunOwnedPath,
  type RunOwnedTemp,
} from '../../src/filesystem/runOwnedTemp.js';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import UnpublishContent from '../../src/commands/cms/unpublish/content.js';

type FakeRequest<T> = Promise<T> & { stream(): PassThrough };
function fakeRequest<T>(value?: T): FakeRequest<T | undefined> {
  return Object.assign(Promise.resolve(value), { stream: () => new PassThrough() });
}

describe('cms unpublish content command', () => {
  const context = new TestContext();
  const fixtures: Array<{ run: RunOwnedTemp; parent: string }> = [];

  async function createFixture(prefix: string): Promise<string> {
    const run = await createRunOwnedTemp(prefix);
    const parent = await createRunOwnedDirectory(run, 'fixture');
    fixtures.push({ run, parent });
    return parent;
  }

  beforeEach(() => {
    process.exitCode = undefined;
  });
  afterEach(async () => {
    context.restore();
    process.exitCode = undefined;
    for (const { run, parent } of fixtures.splice(0)) {
      await removeRunOwnedPath(run, parent);
      const rootMetadata = await lstat(run.root);
      expect(rootMetadata.isDirectory()).to.equal(true);
      let failure: unknown;
      try {
        await lstat(parent);
      } catch (error) {
        failure = error;
      }
      expect((failure as NodeJS.ErrnoException | undefined)?.code).to.equal('ENOENT');
    }
  });

  it('parses repeated short/long metadata flags without a fixed contract default', async () => {
    const { 'target-org': targetOrg, ...flags } = UnpublishContent.flags;
    expect(targetOrg.required).to.equal(true);
    const parsed = await Parser.parse(
      ['--workspace-id', 'space', '-m', 'email:A', '--metadata', 'image:B', '--language', 'en_US'],
      { flags },
    );
    expect(parsed.flags.metadata).to.deep.equal(['email:A', 'image:B']);
    expect(parsed.flags['contract-version']).to.equal(undefined);
    expect(UnpublishContent.aliases).to.deep.equal(['content:unpublish']);
    try {
      await Parser.parse(['--workspace-id', 'space', '-m', 'email:A', '--api-name', 'A'], {
        flags,
      });
      expect.fail('Expected exclusive selector rejection');
    } catch (error) {
      expect((error as Error).message).to.include('--metadata');
    }
  });

  for (const useDefaultLanguage of [false, true]) {
    it(`returns a strict ready Email batch with default-language=${String(useDefaultLanguage)}`, async () => {
      const variant = {
        managedContentVariantId: 'variant-a',
        managedContentId: 'parent-a',
        apiName: 'A',
        language: 'en_US',
        title: 'A',
        urlName: 'a',
        contentType: { fullyQualifiedName: 'sfdc_cms__email' },
        contentSpace: { id: 'space' },
        isPublished: true,
        status: { status: 'Published' },
        contentBody: { rawHtml: 'A' },
      };
      const request = context.SANDBOX.stub().callsFake(({ url }: { url: string }) => {
        if (url === '/connect/cms/spaces/space')
          return Promise.resolve({ id: 'space', apiName: 'Marketing', defaultLanguage: 'en_US' });
        if (url.startsWith('/connect/cms/items/search'))
          return Promise.resolve({
            total: 1,
            items: [
              {
                id: 'variant-a',
                managedContentSpaceId: 'space',
                type: 'ManagedContentVariantSearchResultRepresentation',
              },
            ],
          });
        if (url.includes('/connect/cms/contents/variants/')) return Promise.resolve(variant);
        if (url === '/connect/cms/contents/parent-a')
          return Promise.resolve({
            managedContentId: 'parent-a',
            contentType: { fullyQualifiedName: 'sfdc_cms__email' },
            contentSpace: { id: 'space' },
          });
        throw new Error(`Unexpected request ${url}`);
      });
      const command = Object.create(UnpublishContent.prototype) as UnpublishContent;
      Object.assign(command, {
        parse: context.SANDBOX.stub().resolves({
          flags: {
            'target-org': { getUsername: () => 'org' },
            'api-version': '67.0',
            'workspace-id': 'space',
            metadata: ['email:A'],
            ...(useDefaultLanguage ? { 'default-language': true } : { language: 'en_US' }),
          },
        }),
        getOrgContext: context.SANDBOX.stub().resolves({
          connection: { request, version: '67.0', instanceUrl: 'https://example.invalid' },
          orgId: 'org',
        }),
        jsonEnabled: () => true,
      });
      const result = await command.run();
      expect(result.status).to.equal('success');
      expect(result.contractVersion).to.equal('2.0.0');
      if (!result.result || !('selection' in result.result)) throw new Error('Expected batch');
      expect(result.result.items[0].target?.language).to.equal('en_US');
      expect(result.result.items[0].outcome).to.equal('ready');
      expect(process.exitCode).to.equal(0);
    });
  }

  for (const [name, selection, version, code] of [
    ['missing selection', {}, undefined, 'LIFECYCLE_SELECTOR_REQUIRED'],
    [
      'exclusive selection',
      { metadata: ['email:A'], 'api-name': 'A' },
      undefined,
      'LIFECYCLE_SELECTOR_REQUIRED',
    ],
    ['type-only selection', { metadata: ['email'] }, undefined, 'LIFECYCLE_SELECTOR_REQUIRED'],
    ['empty selection', { metadata: [] }, undefined, 'LIFECYCLE_SELECTOR_REQUIRED'],
    ['legacy version mismatch', { 'api-name': 'A' }, 2, 'UNSUPPORTED_CONTRACT_VERSION'],
    [
      'metadata version mismatch',
      { metadata: ['email:A', 'email:B'] },
      1,
      'UNSUPPORTED_CONTRACT_VERSION',
    ],
    [
      'metadata missing language',
      { metadata: ['email:A'], language: undefined },
      undefined,
      'LANGUAGE_SELECTOR_REQUIRED',
    ],
    [
      'metadata missing report',
      { metadata: ['email:A'], apply: true },
      undefined,
      'REPORT_DIRECTORY_REQUIRED',
    ],
    [
      'metadata missing acknowledgement',
      { metadata: ['email:A'], apply: true, 'report-dir': 'report' },
      undefined,
      'ACTIVE_USE_STOPS_ACKNOWLEDGEMENT_REQUIRED',
    ],
  ] as const) {
    it(`blocks ${name} before org access`, async () => {
      const command = Object.create(UnpublishContent.prototype) as UnpublishContent;
      const getOrgContext = context.SANDBOX.stub();
      Object.assign(command, {
        parse: context.SANDBOX.stub().resolves({
          flags: {
            'target-org': { getUsername: () => 'org' },
            'api-version': '67.0',
            'workspace-id': 'space',
            language: 'en_US',
            'contract-version': version,
            ...selection,
          },
        }),
        getOrgContext,
        jsonEnabled: () => true,
      });
      const result = await command.run();
      expect(result.status).to.equal('blocked');
      expect(result.diagnostics.errors[0].code).to.equal(code);
      expect(getOrgContext.notCalled).to.equal(true);
      if (result.result && 'selection' in result.result) {
        expect(result.contractVersion).to.equal('2.0.0');
        expect(result.result.items[0].outcome).to.equal('blocked');
        expect(
          result.result.items.slice(1).every((item) => item.outcome === 'unattempted'),
        ).to.equal(true);
      }
    });
  }

  for (const version of [undefined, 2]) {
    it(`routes ordered metadata to v2 with version ${String(version)} and blocks failed native preflight`, async () => {
      const command = Object.create(UnpublishContent.prototype) as UnpublishContent;
      const request = context.SANDBOX.stub().rejects(
        new Error('Native workspace preflight failed'),
      );
      Object.assign(command, {
        parse: context.SANDBOX.stub().resolves({
          flags: {
            'target-org': { getUsername: () => 'org' },
            'api-version': '67.0',
            'workspace-id': 'space',
            'default-language': true,
            'contract-version': version,
            metadata: ['image:A', 'sfdc_cms__audio:B'],
          },
        }),
        getOrgContext: context.SANDBOX.stub().resolves({ connection: { request }, orgId: 'org' }),
        jsonEnabled: () => true,
      });
      const result = await command.run();
      expect(result.contractVersion).to.equal('2.0.0');
      expect(result.status).to.equal('blocked');
      if (!result.result || !('selection' in result.result)) throw new Error('Expected batch');
      expect(result.result.operation).to.equal('unpublish');
      expect(result.result.items.map((item) => item.selector.apiName)).to.deep.equal(['A', 'B']);
      expect(result.result.items.map((item) => item.outcome)).to.deep.equal([
        'blocked',
        'unattempted',
      ]);
      expect(request.callCount).to.equal(2);
      expect(result.result.items[0].blockers[0].message).to.include(
        'Native workspace preflight failed',
      );
      expect(process.exitCode).to.equal(1);
    });
  }

  it('blocks apply without active-use acknowledgement before org access', async () => {
    const command = Object.create(UnpublishContent.prototype) as UnpublishContent;
    const getOrgContext = context.SANDBOX.stub();
    Object.assign(command, {
      parse: context.SANDBOX.stub().resolves({
        flags: {
          'target-org': { getUsername: () => 'org' },
          'api-version': '67.0',
          'contract-version': 1,
          'workspace-id': 'space',
          'api-name': 'Email',
          language: 'en_US',
          'default-language': false,
          apply: true,
          'report-dir': 'report',
          'acknowledge-active-use-stops': false,
        },
      }),
      getOrgContext,
      jsonEnabled: context.SANDBOX.stub().returns(true),
    });
    const result = await command.run();
    expect(result.status).to.equal('blocked');
    expect(result.diagnostics.errors[0].code).to.equal('ACTIVE_USE_STOPS_ACKNOWLEDGEMENT_REQUIRED');
    expect(result.diagnostics.errors[0].message).to.include('does not delete it');
    expect(getOrgContext.notCalled).to.equal(true);
  });

  it('blocks apply without report directory before org access', async () => {
    const command = Object.create(UnpublishContent.prototype) as UnpublishContent;
    const getOrgContext = context.SANDBOX.stub();
    Object.assign(command, {
      parse: context.SANDBOX.stub().resolves({
        flags: {
          'target-org': { getUsername: () => 'org' },
          'api-version': '67.0',
          'contract-version': 1,
          'workspace-id': 'space',
          'api-name': 'Email',
          language: 'en_US',
          'default-language': false,
          apply: true,
          'acknowledge-active-use-stops': true,
        },
      }),
      getOrgContext,
      jsonEnabled: context.SANDBOX.stub().returns(true),
    });
    const result = await command.run();
    expect(result.status).to.equal('blocked');
    expect(result.diagnostics.errors[0].code).to.equal('REPORT_DIRECTORY_REQUIRED');
    expect(getOrgContext.notCalled).to.equal(true);
  });

  it('returns sanitized evidence for a definite parser rejection', async () => {
    const parent = await createFixture('sf-plugin-cms-unpublish-command-rejected');
    const reportDirectory = path.join(parent, 'report');
    const variants: Record<string, Record<string, unknown>> = {
      'variant-en': {
        managedContentVariantId: 'variant-en',
        managedContentId: 'parent-email',
        apiName: 'pilot_email',
        language: 'en_US',
        title: 'Pilot email',
        urlName: 'pilot-email',
        contentType: { fullyQualifiedName: 'sfdc_cms__email' },
        contentSpace: { id: 'space-resolved' },
        isPublished: true,
        status: { status: 'Published' },
        contentBody: { rawHtml: '&lt;p&gt;Original&lt;/p&gt;' },
      },
    };
    const request = context.SANDBOX.stub().callsFake(({ url }: { url: string }) => {
      if (url === '/connect/cms/spaces/space-resolved')
        return fakeRequest({
          id: 'space-resolved',
          apiName: 'Controlled',
          defaultLanguage: 'en_US',
        });
      if (url.startsWith('/connect/cms/items/search'))
        return fakeRequest({
          items: [
            {
              id: 'variant-en',
              managedContentSpaceId: 'space-resolved',
              type: 'ManagedContentVariantSearchResultRepresentation',
            },
          ],
          total: 1,
        });
      if (url === '/connect/cms/contents/parent-email')
        return fakeRequest({
          managedContentId: 'parent-email',
          contentType: { fullyQualifiedName: 'sfdc_cms__email' },
          contentSpace: { id: 'space-resolved' },
        });
      if (url.endsWith('/variant-en')) return fakeRequest(variants['variant-en']);
      throw new Error(`Unexpected request ${url}`);
    });
    const mutation = context.SANDBOX.stub(JsforceConnection.prototype, 'request').returns(
      Object.assign(
        Promise.reject(
          Object.assign(new Error('request rejected'), {
            data: [
              {
                errorCode: 'JSON_PARSER_ERROR',
                message: 'Unrecognized field includeContentReferences',
              },
            ],
            response: {
              headers: { 'sforce-request-id': 'request-id-parser' },
              status: 400,
            },
          }),
        ),
        { stream: () => new PassThrough() },
      ),
    );
    const command = Object.create(UnpublishContent.prototype) as UnpublishContent;
    Object.assign(command, {
      parse: context.SANDBOX.stub().resolves({
        flags: {
          'target-org': { getUsername: () => 'org' },
          'api-version': '67.0',
          'contract-version': 1,
          'workspace-id': 'space-resolved',
          'api-name': 'pilot_email',
          language: 'en_US',
          'default-language': false,
          apply: true,
          'report-dir': reportDirectory,
          'acknowledge-active-use-stops': true,
        },
      }),
      getOrgContext: context.SANDBOX.stub().resolves({
        connection: {
          accessToken: 'token',
          instanceUrl: 'https://example.invalid',
          request,
          version: '67.0',
        },
        orgId: '00Dorg',
      }),
      jsonEnabled: context.SANDBOX.stub().returns(true),
    });
    const result = await command.run();
    expect(result.status).to.equal('failed');
    expect(result.result?.outcome).to.equal('rejected-before-mutation');
    if (result.result && 'selection' in result.result) throw new Error('Expected legacy result');
    expect(result.result?.evidence).to.deep.include({
      selectorScope: 'parent',
      includeContentReferencesOmitted: true,
      mutationError: {
        classification: 'definite-pre-mutation-rejection',
        errorCode: 'JSON_PARSER_ERROR',
        httpStatus: 400,
        requestBodySha256: '2c79189680b6c30fa3f3d74456152f3eebb59971d58b3b43240f3204030419df',
        requestId: 'request-id-parser',
        requestSelector: 'POST /connect/cms/contents/unpublish',
        salesforceMessage: 'Unrecognized field includeContentReferences',
      },
    });
    expect(mutation.calledOnce).to.equal(true);
  });

  it('uses only service-resolved identity and report path in the ambiguity envelope', async () => {
    const parent = await createFixture('sf-plugin-cms-unpublish-command');
    const reportDirectory = path.relative(process.cwd(), path.join(parent, 'relative-report'));
    const variants: Record<string, Record<string, unknown>> = {
      'variant-en': {
        managedContentVariantId: 'variant-en',
        managedContentId: 'parent-email',
        apiName: 'pilot_email',
        language: 'en_US',
        title: 'Pilot email',
        urlName: 'pilot-email',
        contentType: { fullyQualifiedName: 'sfdc_cms__email' },
        contentSpace: { id: 'space-resolved' },
        isPublished: true,
        status: { status: 'Published' },
        contentBody: { rawHtml: '&lt;p&gt;Original&lt;/p&gt;' },
      },
    };
    const request = context.SANDBOX.stub().callsFake(({ url }: { url: string }) => {
      if (url === '/connect/cms/spaces/space-resolved')
        return fakeRequest({
          id: 'space-resolved',
          apiName: 'Controlled',
          defaultLanguage: 'en_US',
        });
      if (url.startsWith('/connect/cms/items/search'))
        return fakeRequest({
          items: [
            {
              id: 'variant-en',
              managedContentSpaceId: 'space-resolved',
              type: 'ManagedContentVariantSearchResultRepresentation',
            },
          ],
          total: 1,
        });
      if (url === '/connect/cms/contents/parent-email')
        return fakeRequest({
          managedContentId: 'parent-email',
          contentType: { fullyQualifiedName: 'sfdc_cms__email' },
          contentSpace: { id: 'space-resolved' },
        });
      if (url.endsWith('/variant-en')) return fakeRequest(variants['variant-en']);
      throw new Error(`Unexpected request ${url}`);
    });
    const mutation = context.SANDBOX.stub(JsforceConnection.prototype, 'request').returns(
      Object.assign(Promise.reject(new Error('timeout')), { stream: () => new PassThrough() }),
    );
    const command = Object.create(UnpublishContent.prototype) as UnpublishContent;
    Object.assign(command, {
      parse: context.SANDBOX.stub().resolves({
        flags: {
          'target-org': { getUsername: () => 'org' },
          'api-version': '67.0',
          'contract-version': 1,
          'workspace-id': 'space-resolved',
          'api-name': 'pilot_email',
          'default-language': true,
          apply: true,
          'report-dir': reportDirectory,
          'acknowledge-active-use-stops': true,
        },
      }),
      getOrgContext: context.SANDBOX.stub().resolves({
        connection: {
          accessToken: 'token',
          instanceUrl: 'https://example.invalid',
          request,
          version: '67.0',
        },
        orgId: '00Dorg',
      }),
      jsonEnabled: context.SANDBOX.stub().returns(true),
    });
    const result = await command.run();
    expect(result.status).to.equal('failed');
    expect(result.result).to.deep.include({
      mode: 'apply',
      outcome: 'ownership-uncertain',
      target: {
        workspaceId: 'space-resolved',
        apiName: 'pilot_email',
        language: 'en_US',
        contentId: 'parent-email',
        variantId: 'variant-en',
      },
      reportFile: path.resolve(reportDirectory, 'content-unpublish-run.json'),
      reconciliation: {
        workspaceId: 'space-resolved',
        contentId: 'parent-email',
        variantId: 'variant-en',
      },
    });
    if (result.result && 'selection' in result.result) throw new Error('Expected legacy result');
    expect(result.result?.target.language).not.to.equal('workspace-default');
    expect(mutation.calledOnce).to.equal(true);
  });
});
