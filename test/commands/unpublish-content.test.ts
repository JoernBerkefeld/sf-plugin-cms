import { Connection as JsforceConnection } from '@jsforce/jsforce-node';
import { TestContext } from '@salesforce/core/testSetup';
import { expect } from 'chai';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import UnpublishContent from '../../src/commands/cms/unpublish/content.js';

type FakeRequest<T> = Promise<T> & { stream(): PassThrough };
function fakeRequest<T>(value?: T): FakeRequest<T | undefined> {
  return Object.assign(Promise.resolve(value), { stream: () => new PassThrough() });
}

describe('cms unpublish content command', () => {
  const context = new TestContext();
  beforeEach(() => {
    process.exitCode = undefined;
  });
  afterEach(() => {
    context.restore();
    process.exitCode = undefined;
  });

  it('blocks apply without active-use acknowledgement before org access', async () => {
    const command = Object.create(UnpublishContent.prototype) as UnpublishContent;
    const getOrgContext = context.SANDBOX.stub();
    Object.assign(command, {
      parse: context.SANDBOX.stub().resolves({
        flags: {
          'target-org': 'org',
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
          'target-org': 'org',
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
    const parent = await mkdtemp(path.join(tmpdir(), 'sf-cms-unpublish-command-rejected-'));
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
          'target-org': 'org',
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
    try {
      const result = await command.run();
      expect(result.status).to.equal('failed');
      expect(result.result?.outcome).to.equal('rejected-before-mutation');
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
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it('uses only service-resolved identity and report path in the ambiguity envelope', async () => {
    const parent = await mkdtemp(path.join(tmpdir(), 'sf-cms-unpublish-command-'));
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
        return fakeRequest({ id: 'space-resolved', defaultLanguage: 'en_US' });
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
          'target-org': 'org',
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
    try {
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
      expect(result.result?.target.language).not.to.equal('workspace-default');
      expect(mutation.calledOnce).to.equal(true);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });
});
