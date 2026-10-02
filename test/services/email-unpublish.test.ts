import { Connection as JsforceConnection } from '@jsforce/jsforce-node';
import { expect } from 'chai';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import sinon from 'sinon';
import {
  applyPublishedEmailUnpublishWithReport,
  EmailUnpublishOutcomeUnknownError,
  EmailUnpublishPreflightBlockedError,
  previewPublishedEmailUnpublish,
} from '../../src/services/email-unpublish.js';
import { rewriteAtomic } from '../../src/services/import-workspace.js';
import { unpublishContent } from '../../src/services/lifecycle-foundation.js';

type FakeRequest<T> = Promise<T> & { stream(): PassThrough };
function fakeRequest<T>(value?: T): FakeRequest<T | undefined> {
  return Object.assign(Promise.resolve(value), { stream: () => new PassThrough() });
}
function email(
  id: string,
  language: string,
  published = true,
  parentId = 'parent-email',
  apiName = 'pilot_email',
): Record<string, unknown> {
  return {
    managedContentVariantId: id,
    managedContentId: parentId,
    apiName,
    language,
    title: 'Pilot email',
    urlName: 'pilot-email',
    contentType: { fullyQualifiedName: 'sfdc_cms__email' },
    contentSpace: { id: 'space' },
    isPublished: published,
    status: { status: published ? 'Published' : 'Draft' },
    contentBody: { rawHtml: '&lt;p&gt;Original&lt;/p&gt;' },
  };
}
function fixture() {
  const variants: Record<string, Record<string, unknown>> = {
    'variant-en': email('variant-en', 'en_US'),
    'variant-de': email('variant-de', 'de_DE', true, 'parent-other', 'other_email'),
    'variant-unrelated': email(
      'variant-unrelated',
      'fr_FR',
      false,
      'parent-unrelated',
      'unrelated_email',
    ),
  };
  let parentReads = 0;
  let searches = 0;
  const request = sinon.stub().callsFake(({ method, url }: { method?: string; url: string }) => {
    if (url === '/connect/cms/spaces/space')
      return fakeRequest({ id: 'space', defaultLanguage: 'en_US' });
    if (url.startsWith('/connect/cms/items/search')) {
      searches += 1;
      return fakeRequest({
        items: Object.keys(variants).map((id) => ({
          id,
          managedContentSpaceId: 'space',
          type: 'ManagedContentVariantSearchResultRepresentation',
        })),
        total: Object.keys(variants).length,
      });
    }
    if (url === '/connect/cms/contents/parent-email') {
      parentReads += 1;
      return fakeRequest({
        managedContentId: 'parent-email',
        contentType: { fullyQualifiedName: 'sfdc_cms__email' },
        contentSpace: { id: 'space' },
      });
    }
    if (url.includes('/connect/cms/contents/variants/'))
      return fakeRequest(variants[url.split('/').at(-1)!]);
    throw new Error(`Unexpected request ${method ?? 'GET'} ${url}`);
  });
  return {
    connection: {
      accessToken: 'token',
      instanceUrl: 'https://example.invalid',
      request,
      version: '67.0',
    },
    get parentReads() {
      return parentReads;
    },
    request,
    get searches() {
      return searches;
    },
    variants,
  };
}

async function captureFailure(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('Expected operation to fail');
}

describe('Email unpublish service', () => {
  it('previews one exact Published variant without mutation', async () => {
    const current = fixture();
    const result = await previewPublishedEmailUnpublish(current.connection, {
      selector: { workspaceId: 'space', apiName: 'pilot_email', language: 'en_US' },
    });
    expect(result.status).to.equal('ready');
    expect(current.request.calledWithMatch({ method: 'POST' })).to.equal(false);
  });

  it('writes pending intent then unpublishes only the selected variant', async () => {
    const current = fixture();
    const parent = await mkdtemp(path.join(tmpdir(), 'sf-cms-unpublish-'));
    const reportDirectory = path.join(parent, 'report');
    const mutation = sinon.stub(JsforceConnection.prototype, 'request').callsFake((request) => {
      const pending = JSON.parse(
        readFileSync(path.join(reportDirectory, 'content-unpublish-run.json'), 'utf8'),
      );
      expect(pending.state).to.equal('pending');
      expect(JSON.parse((request as { body: string }).body)).to.deep.equal({
        contentIds: ['parent-email'],
      });
      current.variants['variant-en'] = {
        ...current.variants['variant-en'],
        isPublished: false,
        status: { status: 'Draft' },
      };
      return fakeRequest({ deploymentId: 'deployment', unpublishDate: '2026-10-02T00:00:00.000Z' });
    });
    try {
      const result = await applyPublishedEmailUnpublishWithReport(
        current.connection,
        { selector: { workspaceId: 'space', apiName: 'pilot_email', useDefaultLanguage: true } },
        reportDirectory,
      );
      expect(result.evidence.deploymentId).to.equal('deployment');
      expect(mutation.calledOnce).to.equal(true);
      expect(current.variants['variant-en'].isPublished).to.equal(false);
      expect(current.variants['variant-de'].isPublished).to.equal(true);
      expect(current.variants['variant-unrelated'].isPublished).to.equal(false);
      const report = JSON.parse(await readFile(result.reportFile, 'utf8'));
      expect(report.contract).to.equal('sf-cms-email-unpublish-run');
      expect(report.state).to.equal('completed');
      expect(report.intent).to.deep.equal({
        includeContentReferencesOmitted: true,
        selectorScope: 'parent',
      });
    } finally {
      mutation.restore();
      await rm(parent, { recursive: true, force: true });
    }
  });

  it('returns resolved default-language identity and canonical report path on ambiguity', async () => {
    const current = fixture();
    const mutation = sinon
      .stub(JsforceConnection.prototype, 'request')
      .returns(
        Object.assign(Promise.reject(new Error('timeout')), { stream: () => new PassThrough() }),
      );
    const parent = await mkdtemp(path.join(tmpdir(), 'sf-cms-unpublish-uncertain-'));
    const reportDirectory = path.relative(process.cwd(), path.join(parent, 'report'));
    try {
      const failure = await captureFailure(
        applyPublishedEmailUnpublishWithReport(
          current.connection,
          { selector: { workspaceId: 'space', apiName: 'pilot_email', useDefaultLanguage: true } },
          reportDirectory,
        ),
      );
      expect(failure).to.be.instanceOf(EmailUnpublishOutcomeUnknownError);
      expect(failure).to.deep.include({
        workspaceId: 'space',
        apiName: 'pilot_email',
        language: 'en_US',
        contentId: 'parent-email',
        variantId: 'variant-en',
        reportFile: path.resolve(reportDirectory, 'content-unpublish-run.json'),
      });
      expect(path.isAbsolute((failure as EmailUnpublishOutcomeUnknownError).reportFile)).to.equal(
        true,
      );
      expect(mutation.calledOnce).to.equal(true);
      const report = JSON.parse(
        await readFile((failure as EmailUnpublishOutcomeUnknownError).reportFile, 'utf8'),
      );
      expect(report.state).to.equal('ownership-uncertain');
    } finally {
      mutation.restore();
      await rm(parent, { recursive: true, force: true });
    }
  });

  it('classifies a status-bearing parser rejection as definite pre-mutation', async () => {
    const current = fixture();
    const mutation = sinon.stub(JsforceConnection.prototype, 'request').returns(
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
    const parent = await mkdtemp(path.join(tmpdir(), 'sf-cms-unpublish-rejected-'));
    const reportDirectory = path.join(parent, 'report');
    try {
      const failure = await captureFailure(
        applyPublishedEmailUnpublishWithReport(
          current.connection,
          { selector: { workspaceId: 'space', apiName: 'pilot_email', language: 'en_US' } },
          reportDirectory,
        ),
      );
      expect(failure).to.be.instanceOf(EmailUnpublishOutcomeUnknownError);
      expect((failure as EmailUnpublishOutcomeUnknownError).mutationError).to.deep.equal({
        classification: 'definite-pre-mutation-rejection',
        errorCode: 'JSON_PARSER_ERROR',
        httpStatus: 400,
        requestBodySha256: '2c79189680b6c30fa3f3d74456152f3eebb59971d58b3b43240f3204030419df',
        requestId: 'request-id-parser',
        requestSelector: 'POST /connect/cms/contents/unpublish',
        salesforceMessage: 'Unrecognized field includeContentReferences',
      });
      expect(mutation.calledOnce).to.equal(true);
      const report = JSON.parse(
        await readFile((failure as EmailUnpublishOutcomeUnknownError).reportFile, 'utf8'),
      );
      expect(report.state).to.equal('rejected-before-mutation');
    } finally {
      mutation.restore();
      await rm(parent, { recursive: true, force: true });
    }
  });

  it('keeps an unrecognized 4xx ownership-uncertain', async () => {
    const current = fixture();
    const mutation = sinon.stub(JsforceConnection.prototype, 'request').returns(
      Object.assign(
        Promise.reject(
          Object.assign(new Error('conflict'), {
            data: [{ errorCode: 'CMS_CONFLICT', message: 'Conflict' }],
            response: { status: 409 },
          }),
        ),
        { stream: () => new PassThrough() },
      ),
    );
    const parent = await mkdtemp(path.join(tmpdir(), 'sf-cms-unpublish-conflict-'));
    try {
      const failure = await captureFailure(
        applyPublishedEmailUnpublishWithReport(
          current.connection,
          { selector: { workspaceId: 'space', apiName: 'pilot_email', language: 'en_US' } },
          path.join(parent, 'report'),
        ),
      );
      expect(failure).to.be.instanceOf(EmailUnpublishOutcomeUnknownError);
      expect((failure as EmailUnpublishOutcomeUnknownError).mutationError).to.deep.include({
        classification: 'ownership-uncertain',
        errorCode: 'CMS_CONFLICT',
        httpStatus: 409,
      });
    } finally {
      mutation.restore();
      await rm(parent, { recursive: true, force: true });
    }
  });

  it('prevents POST when pending report persistence fails', async () => {
    const current = fixture();
    const mutation = sinon.stub(JsforceConnection.prototype, 'request');
    const parent = await mkdtemp(path.join(tmpdir(), 'sf-cms-unpublish-pending-'));
    const reportDirectory = path.join(parent, 'report');
    try {
      const failure = await captureFailure(
        applyPublishedEmailUnpublishWithReport(
          current.connection,
          { selector: { workspaceId: 'space', apiName: 'pilot_email', language: 'en_US' } },
          reportDirectory,
          { rewriteReport: sinon.stub().rejects(new Error('disk unavailable')) },
        ),
      );
      expect(failure).to.be.instanceOf(EmailUnpublishPreflightBlockedError);
      expect(mutation.notCalled).to.equal(true);
    } finally {
      mutation.restore();
      await rm(parent, { recursive: true, force: true });
    }
  });

  it('retains deployment ownership when the completed report write fails', async () => {
    const current = fixture();
    const parent = await mkdtemp(path.join(tmpdir(), 'sf-cms-unpublish-final-'));
    const reportDirectory = path.join(parent, 'report');
    const mutation = sinon.stub(JsforceConnection.prototype, 'request').callsFake(() => {
      current.variants['variant-en'] = {
        ...current.variants['variant-en'],
        isPublished: false,
        status: { status: 'Draft' },
      };
      return fakeRequest({ deploymentId: 'deployment-final' });
    });
    let rewrites = 0;
    const rewriteReport = async (file: string, value: unknown): Promise<void> => {
      rewrites += 1;
      if (rewrites === 2) throw new Error('final write unavailable');
      await rewriteAtomic(file, value);
    };
    try {
      const failure = await captureFailure(
        applyPublishedEmailUnpublishWithReport(
          current.connection,
          { selector: { workspaceId: 'space', apiName: 'pilot_email', language: 'en_US' } },
          reportDirectory,
          { rewriteReport },
        ),
      );
      expect(failure).to.be.instanceOf(EmailUnpublishOutcomeUnknownError);
      expect((failure as EmailUnpublishOutcomeUnknownError).deploymentId).to.equal(
        'deployment-final',
      );
      expect(mutation.calledOnce).to.equal(true);
      const report = JSON.parse(
        await readFile(path.join(reportDirectory, 'content-unpublish-run.json'), 'utf8'),
      );
      expect(report.state).to.equal('ownership-uncertain');
      expect(report.reconciliation.deploymentId).to.equal('deployment-final');
    } finally {
      mutation.restore();
      await rm(parent, { recursive: true, force: true });
    }
  });

  it('allows delayed convergence within five read attempts and performs one POST', async () => {
    const current = fixture();
    const parent = await mkdtemp(path.join(tmpdir(), 'sf-cms-unpublish-delayed-'));
    const reportDirectory = path.join(parent, 'report');
    const mutation = sinon
      .stub(JsforceConnection.prototype, 'request')
      .returns(fakeRequest({ deploymentId: 'deployment-delayed' }));
    let searchCalls = 0;
    current.request.callsFake(({ method, url }: { method?: string; url: string }) => {
      if (url === '/connect/cms/spaces/space')
        return fakeRequest({ id: 'space', defaultLanguage: 'en_US' });
      if (url.startsWith('/connect/cms/items/search')) {
        searchCalls += 1;
        if (searchCalls === 6)
          current.variants['variant-en'] = {
            ...current.variants['variant-en'],
            isPublished: false,
            status: { status: 'Draft' },
          };
        return fakeRequest({
          items: Object.keys(current.variants).map((id) => ({
            id,
            managedContentSpaceId: 'space',
            type: 'ManagedContentVariantSearchResultRepresentation',
          })),
          total: Object.keys(current.variants).length,
        });
      }
      if (url === '/connect/cms/contents/parent-email')
        return fakeRequest({
          managedContentId: 'parent-email',
          contentType: { fullyQualifiedName: 'sfdc_cms__email' },
          contentSpace: { id: 'space' },
        });
      if (url.includes('/connect/cms/contents/variants/'))
        return fakeRequest(current.variants[url.split('/').at(-1)!]);
      throw new Error(`Unexpected request ${method ?? 'GET'} ${url}`);
    });
    try {
      const result = await applyPublishedEmailUnpublishWithReport(
        current.connection,
        { selector: { workspaceId: 'space', apiName: 'pilot_email', language: 'en_US' } },
        reportDirectory,
      );
      expect(result.evidence.deploymentId).to.equal('deployment-delayed');
      expect(mutation.calledOnce).to.equal(true);
      expect(current.request.callCount).to.be.greaterThan(0);
    } finally {
      mutation.restore();
      await rm(parent, { recursive: true, force: true });
    }
  });

  it('stops after five non-converged read attempts and performs one POST', async () => {
    const current = fixture();
    const parent = await mkdtemp(path.join(tmpdir(), 'sf-cms-unpublish-bounded-'));
    const reportDirectory = path.join(parent, 'report');
    const mutation = sinon
      .stub(JsforceConnection.prototype, 'request')
      .returns(fakeRequest({ deploymentId: 'deployment-bounded' }));
    try {
      const failure = await captureFailure(
        applyPublishedEmailUnpublishWithReport(
          current.connection,
          { selector: { workspaceId: 'space', apiName: 'pilot_email', language: 'en_US' } },
          reportDirectory,
        ),
      );
      expect(failure).to.be.instanceOf(EmailUnpublishOutcomeUnknownError);
      expect((failure as EmailUnpublishOutcomeUnknownError).deploymentId).to.equal(
        'deployment-bounded',
      );
      expect(current.searches).to.equal(7);
      expect(current.parentReads).to.equal(7);
      expect(mutation.calledOnce).to.equal(true);
    } finally {
      mutation.restore();
      await rm(parent, { recursive: true, force: true });
    }
  });

  for (const drift of [
    {
      name: 'exact variant language',
      mutate: (current: ReturnType<typeof fixture>): void => {
        current.variants['variant-en'].language = 'en_GB';
      },
    },
    {
      name: 'exact variant body',
      mutate: (current: ReturnType<typeof fixture>): void => {
        current.variants['variant-en'].contentBody = { rawHtml: '&lt;p&gt;Drift&lt;/p&gt;' };
      },
    },
    {
      name: 'single-variant parent scope',
      mutate: (current: ReturnType<typeof fixture>): void => {
        current.variants['variant-de'].managedContentId = 'parent-email';
      },
    },
    {
      name: 'unrelated full inventory variant',
      mutate: (current: ReturnType<typeof fixture>): void => {
        current.variants['variant-unrelated'].title = 'Unrelated drift';
      },
    },
  ]) {
    it(`blocks ${drift.name} drift before POST`, async () => {
      const current = fixture();
      let searchCalls = 0;
      current.request.callsFake(({ method, url }: { method?: string; url: string }) => {
        if (url === '/connect/cms/spaces/space')
          return fakeRequest({ id: 'space', defaultLanguage: 'en_US' });
        if (url.startsWith('/connect/cms/items/search')) {
          searchCalls += 1;
          if (searchCalls === 2) drift.mutate(current);
          return fakeRequest({
            items: Object.keys(current.variants).map((id) => ({
              id,
              managedContentSpaceId: 'space',
              type: 'ManagedContentVariantSearchResultRepresentation',
            })),
            total: Object.keys(current.variants).length,
          });
        }
        if (url === '/connect/cms/contents/parent-email') {
          return fakeRequest({
            managedContentId: 'parent-email',
            contentType: { fullyQualifiedName: 'sfdc_cms__email' },
            contentSpace: { id: 'space' },
          });
        }
        if (url.includes('/connect/cms/contents/variants/'))
          return fakeRequest(current.variants[url.split('/').at(-1)!]);
        throw new Error(`Unexpected request ${method ?? 'GET'} ${url}`);
      });
      const result = await previewPublishedEmailUnpublish(current.connection, {
        selector: { workspaceId: 'space', apiName: 'pilot_email', language: 'en_US' },
      });
      expect(result.status).to.equal('blocked');
    });
  }

  it('blocks parent identity drift before POST', async () => {
    const current = fixture();
    current.request
      .withArgs(sinon.match.has('url', '/connect/cms/contents/parent-email'))
      .onSecondCall()
      .returns(
        fakeRequest({
          managedContentId: 'different-parent',
          contentType: { fullyQualifiedName: 'sfdc_cms__email' },
          contentSpace: { id: 'space' },
        }),
      );
    const result = await previewPublishedEmailUnpublish(current.connection, {
      selector: { workspaceId: 'space', apiName: 'pilot_email', language: 'en_US' },
    });
    expect(result.status).to.equal('blocked');
  });

  it('forces excluded references and rejects caller override', async () => {
    const connection = { request: sinon.stub() };
    const failure = await captureFailure(
      unpublishContent(connection, {
        variantIds: ['variant'],
        includeContentReferences: true,
      } as never),
    );
    expect(failure).to.be.instanceOf(Error);
    expect(connection.request.notCalled).to.equal(true);
  });
});
