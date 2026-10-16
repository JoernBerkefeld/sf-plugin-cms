import { Connection as JsforceConnection } from '@jsforce/jsforce-node';
import { expect } from 'chai';
import { readFileSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import sinon from 'sinon';
import {
  createRunOwnedDirectory,
  createRunOwnedTemp,
  removeRunOwnedPath,
  type RunOwnedTemp,
} from '../../src/filesystem/runOwnedTemp.js';
import {
  applyDraftEmailPublishWithReport,
  EmailPublishOutcomeUnknownError,
  previewDraftEmailPublish,
} from '../../src/services/email-publish.js';

type FakeRequest<T> = Promise<T> & { stream(): PassThrough };
function fakeRequest<T>(value?: T): FakeRequest<T | undefined> {
  return Object.assign(Promise.resolve(value), { stream: () => new PassThrough() });
}
function email(id: string, language: string): Record<string, unknown> {
  return {
    managedContentVariantId: id,
    managedContentId: 'parent-email',
    apiName: 'pilot_email',
    language,
    title: 'Pilot email',
    urlName: 'pilot-email',
    contentType: { fullyQualifiedName: 'sfdc_cms__email' },
    contentSpace: { id: 'space' },
    isPublished: false,
    status: { status: 'Draft' },
    contentBody: { rawHtml: '&lt;p&gt;Original&lt;/p&gt;' },
  };
}
function fixture() {
  const variants: Record<string, Record<string, unknown>> = {
    'variant-en': email('variant-en', 'en_US'),
    'variant-de': email('variant-de', 'de_DE'),
  };
  const request = sinon
    .stub()
    .callsFake(({ method, url, body }: { method?: string; url: string; body?: string }) => {
      if (url === '/connect/cms/spaces/space')
        return fakeRequest({ id: 'space', defaultLanguage: 'en_US' });
      if (url.startsWith('/connect/cms/items/search'))
        return fakeRequest({
          items: Object.keys(variants).map((id) => ({
            id,
            managedContentSpaceId: 'space',
            type: 'ManagedContentVariantSearchResultRepresentation',
          })),
          total: 2,
        });
      if (url === '/connect/cms/contents/parent-email')
        return fakeRequest({
          managedContentId: 'parent-email',
          contentType: { fullyQualifiedName: 'sfdc_cms__email' },
          contentSpace: { id: 'space' },
        });
      if (url.includes('/connect/cms/contents/variants/'))
        return fakeRequest(variants[url.split('/').at(-1)!]);
      if (url === '/connect/cms/contents/publish' && method === 'POST') {
        const payload = JSON.parse(body!);
        expect(payload).to.deep.equal({
          variantIds: ['variant-en'],
          contextContentSpaceId: 'space',
          includeContentReferences: false,
        });
        variants['variant-en'] = {
          ...variants['variant-en'],
          isPublished: true,
          status: { status: 'Published' },
        };
        return fakeRequest({ deploymentId: 'deployment', publishDate: '2026-10-01T20:00:00.000Z' });
      }
      throw new Error(`Unexpected request ${method ?? 'GET'} ${url}`);
    });
  return {
    connection: {
      accessToken: 'token',
      instanceUrl: 'https://example.invalid',
      request,
      version: '67.0',
    },
    request,
    variants,
  };
}

async function removeFixture(run: RunOwnedTemp, parent: string): Promise<void> {
  await removeRunOwnedPath(run, parent);
  let parentError: unknown;
  try {
    await stat(parent);
  } catch (error) {
    parentError = error;
  }
  expect((parentError as NodeJS.ErrnoException | undefined)?.code).to.equal('ENOENT');
  const rootMetadata = await stat(run.root);
  expect(rootMetadata.isDirectory()).to.equal(true);
}

describe('Email publish service', () => {
  it('previews one exact Draft variant without mutation', async () => {
    const current = fixture();
    const result = await previewDraftEmailPublish(current.connection, {
      selector: { workspaceId: 'space', apiName: 'pilot_email', language: 'en_US' },
    });
    expect(result.status).to.equal('ready');
    expect(current.request.calledWithMatch({ method: 'POST' })).to.equal(false);
  });

  it('writes pending intent then publishes only the selected variant', async () => {
    const current = fixture();
    const run = await createRunOwnedTemp('sf-plugin-cms-publish');
    const parent = await createRunOwnedDirectory(run, 'fixture');
    const reportDirectory = path.join(parent, 'report');
    const mutation = sinon.stub(JsforceConnection.prototype, 'request').callsFake((request) => {
      const pending = JSON.parse(
        readFileSync(path.join(reportDirectory, 'content-publish-run.json'), 'utf8'),
      );
      expect(pending.state).to.equal('pending');
      const payload = JSON.parse((request as { body: string }).body);
      expect(payload).to.deep.equal({
        variantIds: ['variant-en'],
        contextContentSpaceId: 'space',
        includeContentReferences: false,
      });
      current.variants['variant-en'] = {
        ...current.variants['variant-en'],
        isPublished: true,
        status: { status: 'Published' },
      };
      return fakeRequest({
        deploymentId: 'deployment',
        publishDate: '2026-10-01T20:00:00.000Z',
      });
    });
    try {
      const result = await applyDraftEmailPublishWithReport(
        current.connection,
        { selector: { workspaceId: 'space', apiName: 'pilot_email', useDefaultLanguage: true } },
        reportDirectory,
      );
      expect(result.evidence.deploymentId).to.equal('deployment');
      expect(mutation.calledOnce).to.equal(true);
      expect(current.variants['variant-en'].isPublished).to.equal(true);
      expect(current.variants['variant-de'].isPublished).to.equal(false);
      const report = JSON.parse(await readFile(result.reportFile, 'utf8'));
      expect(report.state).to.equal('completed');
      expect(report.intent).to.deep.equal({
        includeContentReferences: false,
        selectorScope: 'variant',
      });
    } finally {
      mutation.restore();
      await removeFixture(run, parent);
    }
  });

  it('retains ownership-uncertain identity without retrying an ambiguous publish', async () => {
    const current = fixture();
    const mutation = sinon
      .stub(JsforceConnection.prototype, 'request')
      .returns(
        Object.assign(Promise.reject(new Error('timeout')), { stream: () => new PassThrough() }),
      );
    const run = await createRunOwnedTemp('sf-plugin-cms-publish-uncertain');
    const parent = await createRunOwnedDirectory(run, 'fixture');
    const reportDirectory = path.join(parent, 'report');
    try {
      let failure: unknown;
      try {
        await applyDraftEmailPublishWithReport(
          current.connection,
          { selector: { workspaceId: 'space', apiName: 'pilot_email', language: 'en_US' } },
          reportDirectory,
        );
      } catch (error) {
        failure = error;
      }
      expect(failure).to.be.instanceOf(EmailPublishOutcomeUnknownError);
      expect(mutation.calledOnce).to.equal(true);
      const report = JSON.parse(
        await readFile(path.join(reportDirectory, 'content-publish-run.json'), 'utf8'),
      );
      expect(report.state).to.equal('ownership-uncertain');
      expect(report.reconciliation).to.deep.equal({
        contentId: 'parent-email',
        variantId: 'variant-en',
        workspaceId: 'space',
      });
    } finally {
      mutation.restore();
      await removeFixture(run, parent);
    }
  });
});
