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
  EmailPublishPreflightBlockedError,
  executePreparedDraftEmailPublish,
  prepareDraftEmailPublish,
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

async function failure(action: () => Promise<unknown>): Promise<unknown> {
  try {
    await action();
  } catch (error) {
    return error;
  }
  throw new Error('Expected failure');
}

describe('Email publish prepared seams', () => {
  const input = {
    selector: { workspaceId: 'space', apiName: 'pilot_email', useDefaultLanguage: true as const },
  };

  async function setup() {
    const current = fixture();
    const prepared = await prepareDraftEmailPublish(current.connection, input);
    const { inventory: expectedInventory } = prepared.evidence;
    const binding = Object.fromEntries(
      Object.entries(prepared.evidence).filter(
        ([key]) => !['inventory', 'siblingInventory', 'lifecycle'].includes(key),
      ),
    ) as import('../../src/contracts/content-lifecycle-batch.js').LifecycleBinding;
    const run = await createRunOwnedTemp('sf-plugin-cms-prepared-publish');
    const parent = await createRunOwnedDirectory(run, 'fixture');
    return {
      current,
      prepared,
      run,
      parent,
      context: { binding, expectedInventory, reportFile: path.join(parent, 'target-000001.json') },
    };
  }

  it('accepts explicit canonical Email without changing legacy evidence', async () => {
    const current = fixture();
    const legacy = await prepareDraftEmailPublish(current.connection, input);
    const explicit = await prepareDraftEmailPublish(current.connection, {
      selector: { ...input.selector, contentType: 'sfdc_cms__email' },
    });
    expect(explicit.evidence).to.deep.equal(legacy.evidence);
    expect(explicit.evidence).not.to.have.property('nativeEvidence');
  });

  for (const contentType of [
    'sfdc_cms__emailTemplate',
    'sfdc_cms__image',
    'sfdc_cms__document',
    'sfdc_cms__audio',
  ] as const) {
    it(`keeps ${contentType} execution closed until all snapshot checkpoints are wired`, async () => {
      const current = fixture();
      expect(
        await failure(() =>
          applyDraftEmailPublishWithReport(
            current.connection,
            {
              selector: { ...input.selector, contentType },
            },
            'not-created',
          ),
        ),
      ).to.be.instanceOf(EmailPublishPreflightBlockedError);
      expect(current.request.called).to.equal(false);
    });
  }

  it('prepares without mutation and executes once with durable pending before fresh reads', async () => {
    const test = await setup();
    expect(test.current.request.calledWithMatch({ method: 'POST' })).to.equal(false);
    const mutation = sinon.stub(JsforceConnection.prototype, 'request').callsFake(() => {
      const pending = JSON.parse(readFileSync(test.context.reportFile, 'utf8'));
      expect(pending.state).to.equal('pending');
      expect(pending.expectedInventory).to.deep.equal(test.context.expectedInventory);
      test.current.variants['variant-en'] = {
        ...test.current.variants['variant-en'],
        isPublished: true,
        status: { status: 'Published' },
      };
      return fakeRequest({ deploymentId: 'deployment' });
    });
    try {
      const evidence = await executePreparedDraftEmailPublish(
        test.current.connection,
        test.prepared,
        test.context,
      );
      expect(evidence.postPublishHash).to.equal(test.prepared.evidence.baselineHash);
      expect(JSON.parse(await readFile(test.context.reportFile, 'utf8')).state).to.equal(
        'completed',
      );
      expect(
        await failure(() =>
          executePreparedDraftEmailPublish(test.current.connection, test.prepared, test.context),
        ),
      ).to.be.instanceOf(EmailPublishPreflightBlockedError);
      expect(mutation.calledOnce).to.equal(true);
    } finally {
      mutation.restore();
      await removeFixture(test.run, test.parent);
    }
  });

  for (const drift of [
    'body',
    'parent',
    'variant',
    'default-language',
    'inventory',
    'org',
    'api-version',
    'family',
  ] as const) {
    it(`blocks ${drift} substitution before dispatch`, async () => {
      const test = await setup();
      const mutation = sinon.stub(JsforceConnection.prototype, 'request');
      if (drift === 'body')
        test.current.variants['variant-en'].contentBody = { rawHtml: 'changed' };
      if (drift === 'parent') {
        test.current.variants['variant-en'].managedContentId = 'different-parent';
        test.current.request
          .withArgs(sinon.match({ url: '/connect/cms/contents/different-parent' }))
          .callsFake(() =>
            fakeRequest({
              managedContentId: 'different-parent',
              contentType: { fullyQualifiedName: 'sfdc_cms__email' },
              contentSpace: { id: 'space' },
            }),
          );
      }
      if (drift === 'variant')
        test.current.variants['variant-en'].managedContentVariantId = 'replacement';
      if (drift === 'default-language')
        test.current.request
          .withArgs(sinon.match({ url: '/connect/cms/spaces/space' }))
          .callsFake(() => fakeRequest({ id: 'space', defaultLanguage: 'de_DE' }));
      if (drift === 'inventory')
        test.current.variants['variant-de'].title = 'unexpected sibling change';
      if (drift === 'org') test.current.connection.instanceUrl = 'https://different.invalid';
      if (drift === 'api-version') test.current.connection.version = '66.0';
      if (drift === 'family')
        test.current.variants['variant-en'].contentType = { fullyQualifiedName: 'sfdc_cms__image' };
      try {
        const error = await failure(() =>
          executePreparedDraftEmailPublish(test.current.connection, test.prepared, test.context),
        );
        expect(error).to.be.instanceOf(EmailPublishPreflightBlockedError);
        expect(mutation.called).to.equal(false);
      } finally {
        mutation.restore();
        await removeFixture(test.run, test.parent);
      }
    });
  }

  it('accepts only caller-accounted preceding lifecycle transitions', async () => {
    const test = await setup();
    test.current.variants['variant-de'].isPublished = true;
    test.current.variants['variant-de'].status = { status: 'Published' };
    test.context.expectedInventory = test.context.expectedInventory.map((entry) =>
      entry.variantId === 'variant-de'
        ? { ...entry, isPublished: true, status: 'Published' }
        : entry,
    );
    const mutation = sinon.stub(JsforceConnection.prototype, 'request').callsFake(() => {
      test.current.variants['variant-en'].isPublished = true;
      test.current.variants['variant-en'].status = { status: 'Published' };
      return fakeRequest({ deploymentId: 'deployment' });
    });
    try {
      const evidence = await executePreparedDraftEmailPublish(
        test.current.connection,
        test.prepared,
        test.context,
      );
      expect(evidence.deploymentId).to.equal('deployment');
      expect(mutation.calledOnce).to.equal(true);
    } finally {
      mutation.restore();
      await removeFixture(test.run, test.parent);
    }
  });

  for (const invalid of [
    'relative-report',
    'existing-report',
    'binding',
    'unaccounted-transition',
  ] as const) {
    it(`rejects ${invalid} without dispatch`, async () => {
      const test = await setup();
      const mutation = sinon.stub(JsforceConnection.prototype, 'request');
      if (invalid === 'relative-report') test.context.reportFile = 'target.json';
      if (invalid === 'existing-report') {
        const { rewriteAtomic } = await import('../../src/services/import-workspace.js');
        await rewriteAtomic(test.context.reportFile, { preserve: true });
      }
      if (invalid === 'binding') test.context.binding.workspaceId = 'other-space';
      if (invalid === 'unaccounted-transition') {
        test.current.variants['variant-de'].isPublished = true;
        test.current.variants['variant-de'].status = { status: 'Published' };
      }
      try {
        expect(
          await failure(() =>
            executePreparedDraftEmailPublish(test.current.connection, test.prepared, test.context),
          ),
        ).to.be.instanceOf(EmailPublishPreflightBlockedError);
        expect(mutation.called).to.equal(false);
        if (invalid === 'existing-report')
          expect(JSON.parse(await readFile(test.context.reportFile, 'utf8'))).to.deep.equal({
            preserve: true,
          });
      } finally {
        mutation.restore();
        await removeFixture(test.run, test.parent);
      }
    });
  }

  for (const phase of ['pending', 'completed'] as const) {
    it(`stops on ${phase} persistence failure without redispatch`, async () => {
      const test = await setup();
      const mutation = sinon.stub(JsforceConnection.prototype, 'request').callsFake(() => {
        test.current.variants['variant-en'].isPublished = true;
        test.current.variants['variant-en'].status = { status: 'Published' };
        return fakeRequest({ deploymentId: 'deployment' });
      });
      const { rewriteAtomic } = await import('../../src/services/import-workspace.js');
      try {
        const error = await failure(() =>
          executePreparedDraftEmailPublish(test.current.connection, test.prepared, {
            ...test.context,
            rewriteReport: async (file, report) => {
              if ((report as { state: string }).state === phase) throw new Error('disk failure');
              await rewriteAtomic(file, report);
            },
          }),
        );
        expect(error).to.be.instanceOf(
          phase === 'pending' ? EmailPublishPreflightBlockedError : EmailPublishOutcomeUnknownError,
        );
        expect(mutation.callCount).to.equal(phase === 'pending' ? 0 : 1);
      } finally {
        mutation.restore();
        await removeFixture(test.run, test.parent);
      }
    });
  }
});

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
