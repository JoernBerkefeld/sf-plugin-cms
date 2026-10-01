import { Connection as JsforceConnection } from '@jsforce/jsforce-node';
import crypto from 'node:crypto';
import { lstat, mkdtemp, readFile, rm, rmdir, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { expect } from 'chai';
import sinon from 'sinon';
import { exportWorkspace } from '../../src/services/export-workspace.js';
import {
  EmailUpdateOutcomeUnknownError,
  previewDraftEmailUpdateFromEditableHtml,
  updateDraftEmailFromEditableHtml,
} from '../../src/services/email-update.js';

type FakeRequest<T> = Promise<T> & { stream(): PassThrough };

function fakeRequest<T>(value?: T): FakeRequest<T | undefined> {
  return Object.assign(Promise.resolve(value), { stream: () => new PassThrough() });
}

type State = {
  parent: Record<string, unknown>;
  variants: Record<string, Record<string, unknown>>;
};

function email(id: string, language: string, apiName = 'pilot_email'): Record<string, unknown> {
  return {
    managedContentVariantId: id,
    managedContentId: 'parent-email',
    contentKey: 'email-key',
    apiName,
    language,
    title: 'Pilot email',
    urlName: 'pilot-email',
    contentType: { fullyQualifiedName: 'sfdc_cms__email', name: 'Email' },
    contentSpace: { id: 'space' },
    isPublished: false,
    status: { status: 'Draft' },
    externalId: null,
    externalSource: null,
    contentBody: {
      'sfdc_cms:title': 'Pilot email',
      'sfdc_cms:urlName': 'pilot-email',
      subjectLine: 'Pilot subject',
      messagePurpose: 'Transactional',
      rawHtml: '&lt;p&gt;Original&lt;/p&gt;',
      'lightning:dataProviders': [],
      'lightning:expressions': [],
      'sfdc_cms:attachments': [],
      'sfdc_cms:variants': [],
    },
  };
}

function state(): State {
  return {
    parent: {
      managedContentId: 'parent-email',
      contentType: { fullyQualifiedName: 'sfdc_cms__email' },
      contentSpace: { id: 'space' },
    },
    variants: {
      'variant-en': email('variant-en', 'en_US'),
      'variant-de': email('variant-de', 'de_DE'),
    },
  };
}

function connection(current: State): {
  accessToken: string;
  instanceUrl: string;
  request: sinon.SinonStub;
  version: string;
} {
  const request = sinon.stub().callsFake(({ url }: { url: string }) => {
    if (url === '/connect/cms/spaces/space') {
      return fakeRequest({ id: 'space', defaultLanguage: 'en_US' });
    }
    if (url.startsWith('/connect/cms/items/search')) {
      const items = Object.keys(current.variants).map((id) => ({
        id,
        managedContentSpaceId: 'space',
        type: 'ManagedContentVariantSearchResultRepresentation',
      }));
      return fakeRequest({ items, total: items.length });
    }
    if (url.includes('/connect/cms/contents/variants/')) {
      const id = decodeURIComponent(url.split('/').at(-1) ?? '');
      return fakeRequest(structuredClone(current.variants[id]));
    }
    if (url.includes('/connect/cms/contents/parent-email')) {
      return fakeRequest(structuredClone(current.parent));
    }
    throw new Error(`Unexpected request: ${url}`);
  });
  return {
    accessToken: 'token',
    instanceUrl: 'https://example.my.salesforce.com',
    request,
    version: '67.0',
  };
}

describe('bounded Draft Email update pilot', () => {
  let root: string;
  let sourceDirectory: string;
  let editableDirectory: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'cms-email-update-'));
    await writeFile(path.join(root, '.owner'), crypto.randomUUID(), { flag: 'wx' });
    sourceDirectory = path.join(root, 'source');
    editableDirectory = path.join(root, 'editable');
    const original = state();
    delete original.variants['variant-de'];
    await exportWorkspace(connection(original), 'space', sourceDirectory, {
      editableDirectory,
      selection: { contentType: 'sfdc_cms__email', apiNames: ['pilot_email'] },
    });
    await writeFile(path.join(editableDirectory, 'items/variant-en.html'), '<p>Updated</p>');
  });

  afterEach(async () => {
    sinon.restore();
    await removeOwnedFixture(root, sourceDirectory);
    await removeOwnedFixture(root, editableDirectory);
    await unlink(path.join(root, '.owner'));
    await rmdir(root);
  });

  it('previews exact evidence without invoking any mutation transport', async () => {
    const current = state();
    const caller = connection(current);
    const mutation = sinon.stub(JsforceConnection.prototype, 'request');

    const result = await previewDraftEmailUpdateFromEditableHtml(caller, {
      sourceDirectory,
      editableDirectory,
      selector: { workspaceId: 'space', apiName: 'pilot_email', language: 'en_US' },
    });

    expect(result.status).to.equal('ready');
    if (result.status !== 'ready') throw new Error('Expected ready Email preview');
    expect(result.blockers).to.deep.equal([]);
    expect(result.evidence).to.deep.include({
      apiName: 'pilot_email',
      apiVersion: '67.0',
      changedFields: ['contentBody.rawHtml'],
      contentId: 'parent-email',
      contentType: 'sfdc_cms__email',
      language: 'en_US',
      lifecycle: { isPublished: false, status: 'Draft' },
      org: 'https://example.my.salesforce.com',
      variantId: 'variant-en',
      workspaceId: 'space',
    });
    expect(result.evidence.siblingInventory).to.have.length(2);
    expect(result.evidence.siblingInventory).to.deep.include.members([
      {
        hash: result.evidence.siblingInventory[0].hash,
        language: 'de_DE',
        lifecycle: { isPublished: false, status: 'Draft' },
        variantId: 'variant-de',
      },
      {
        hash: result.evidence.siblingInventory[1].hash,
        language: 'en_US',
        lifecycle: { isPublished: false, status: 'Draft' },
        variantId: 'variant-en',
      },
    ]);
    for (const sibling of result.evidence.siblingInventory)
      expect(sibling.hash).to.match(/^[a-f\d]{64}$/u);
    expect(result.evidence.baselineHash).to.match(/^[a-f\d]{64}$/u);
    expect(result.evidence.payloadHash).to.match(/^[a-f\d]{64}$/u);
    expect(result.evidence.payloadHash).not.to.equal(result.evidence.baselineHash);
    expect(mutation.notCalled).to.equal(true);
    expect(current).to.deep.equal(state());
  });

  it('blocks preview and apply before mutation when parent scope is inconsistent', async () => {
    const current = state();
    current.parent.contentSpace = { id: 'other-space' };
    const mutation = sinon.stub(JsforceConnection.prototype, 'request');

    const preview = await previewDraftEmailUpdateFromEditableHtml(connection(current), {
      sourceDirectory,
      editableDirectory,
      selector: { workspaceId: 'space', apiName: 'pilot_email', language: 'en_US' },
    });
    expect(preview).to.deep.equal({
      blockers: [
        {
          code: 'EMAIL_UPDATE_PREFLIGHT_BLOCKED',
          message: 'Email parent readback scope changed',
        },
      ],
      status: 'blocked',
    });
    await expectFailure(
      updateDraftEmailFromEditableHtml(connection(current), {
        sourceDirectory,
        editableDirectory,
        selector: { workspaceId: 'space', apiName: 'pilot_email', language: 'en_US' },
      }),
      /parent readback scope changed/u,
    );
    expect(mutation.notCalled).to.equal(true);
  });

  it('reports expected preflight blockers without mutation', async () => {
    await writeFile(path.join(editableDirectory, 'items/variant-en.html'), '<p>Original</p>');
    const mutation = sinon.stub(JsforceConnection.prototype, 'request');

    const result = await previewDraftEmailUpdateFromEditableHtml(connection(state()), {
      sourceDirectory,
      editableDirectory,
      selector: { workspaceId: 'space', apiName: 'pilot_email', language: 'en_US' },
    });

    expect(result).to.deep.equal({
      blockers: [
        {
          code: 'EMAIL_UPDATE_PREFLIGHT_BLOCKED',
          message: 'Email update must change rawHtml',
        },
      ],
      status: 'blocked',
    });
    expect(mutation.notCalled).to.equal(true);
  });

  it('reprepares after preview and blocks apply when the destination drifted', async () => {
    const current = state();
    const caller = connection(current);
    const preview = await previewDraftEmailUpdateFromEditableHtml(caller, {
      sourceDirectory,
      editableDirectory,
      selector: { workspaceId: 'space', apiName: 'pilot_email', language: 'en_US' },
    });
    expect(preview.status).to.equal('ready');
    (current.variants['variant-en'].contentBody as Record<string, unknown>).rawHtml =
      '&lt;p&gt;Changed after preview&lt;/p&gt;';
    const mutation = sinon.stub(JsforceConnection.prototype, 'request');

    await expectFailure(
      updateDraftEmailFromEditableHtml(caller, {
        sourceDirectory,
        editableDirectory,
        selector: { workspaceId: 'space', apiName: 'pilot_email', language: 'en_US' },
      }),
      /baseline does not match/u,
    );

    expect(mutation.notCalled).to.equal(true);
  });

  it('updates one exact Draft variant and independently proves parent, body, language, siblings, and lifecycle', async () => {
    const current = state();
    const caller = connection(current);
    const mutation = sinon.stub(JsforceConnection.prototype, 'request').callsFake((request) => {
      const body = JSON.parse((request as { body: string }).body) as Record<string, unknown>;
      current.variants['variant-en'] = {
        ...current.variants['variant-en'],
        ...body,
        contentBody: {
          ...(body.contentBody as Record<string, unknown>),
          rawHtml: '&lt;p&gt;Updated&lt;/p&gt;',
        },
      };
      return fakeRequest(structuredClone(current.variants['variant-en']));
    });

    const result = await updateDraftEmailFromEditableHtml(caller, {
      sourceDirectory,
      editableDirectory,
      selector: { workspaceId: 'space', apiName: 'pilot_email', language: 'en_US' },
    });

    expect(result).to.include({
      apiName: 'pilot_email',
      apiVersion: '67.0',
      contentId: 'parent-email',
      contentType: 'sfdc_cms__email',
      language: 'en_US',
      org: 'https://example.my.salesforce.com',
      variantId: 'variant-en',
      workspaceId: 'space',
    });
    expect(result.changedFields).to.deep.equal(['contentBody.rawHtml']);
    expect(result.lifecycle).to.deep.equal({ isPublished: false, status: 'Draft' });
    expect(result.baselineHash).to.match(/^[a-f\d]{64}$/u);
    expect(result.payloadHash).to.match(/^[a-f\d]{64}$/u);
    expect(
      result.siblingInventory.map(({ language, variantId }) => ({ language, variantId })),
    ).to.deep.equal([
      { language: 'de_DE', variantId: 'variant-de' },
      { language: 'en_US', variantId: 'variant-en' },
    ]);
    for (const sibling of result.siblingInventory) expect(sibling.hash).to.match(/^[a-f\d]{64}$/u);
    expect(mutation.calledOnce).to.equal(true);
    const submitted = JSON.parse((mutation.firstCall.args[0] as { body: string }).body) as {
      contentBody: Record<string, unknown>;
    };
    expect(submitted.contentBody.rawHtml).to.equal('<p>Updated</p>');
    expect(submitted.contentBody.subjectLine).to.equal('Pilot subject');
    expect(await readFile(path.join(editableDirectory, 'items/variant-en.html'), 'utf8')).to.equal(
      '<p>Updated</p>',
    );
  });

  it('fails closed before mutation for ambiguous selectors, wrong lifecycle, no-op edits, and prewrite drift', async () => {
    for (const configure of [
      (current: State): void => {
        current.variants['variant-two'] = email('variant-two', 'en_US');
      },
      (current: State): void => {
        current.variants['variant-en'].isPublished = true;
      },
    ]) {
      const current = state();
      configure(current);
      const mutation = sinon.stub(JsforceConnection.prototype, 'request');
      await expectFailure(run(connection(current)), /resolve exactly once|unpublished Draft/u);
      expect(mutation.notCalled).to.equal(true);
      mutation.restore();
    }

    await writeFile(path.join(editableDirectory, 'items/variant-en.html'), '<p>Original</p>');
    const noOpMutation = sinon.stub(JsforceConnection.prototype, 'request');
    await expectFailure(run(connection(state())), /must change rawHtml/u);
    expect(noOpMutation.notCalled).to.equal(true);
    noOpMutation.restore();

    await writeFile(path.join(editableDirectory, 'items/variant-en.html'), '<p>Updated</p>');
    const current = state();
    const caller = connection(current);
    let searches = 0;
    caller.request.callsFake(({ url }: { url: string }) => {
      if (url === '/connect/cms/spaces/space') {
        return fakeRequest({ id: 'space', defaultLanguage: 'en_US' });
      }
      if (url.startsWith('/connect/cms/items/search')) {
        searches += 1;
        if (searches === 2) current.variants['variant-en'].title = 'Concurrent edit';
        const items = Object.keys(current.variants).map((id) => ({
          id,
          managedContentSpaceId: 'space',
          type: 'ManagedContentVariantSearchResultRepresentation',
        }));
        return fakeRequest({ items, total: items.length });
      }
      if (url.includes('/connect/cms/contents/variants/')) {
        const id = decodeURIComponent(url.split('/').at(-1) ?? '');
        return fakeRequest(structuredClone(current.variants[id]));
      }
      return fakeRequest(structuredClone(current.parent));
    });
    const driftMutation = sinon.stub(JsforceConnection.prototype, 'request');
    await expectFailure(run(caller), /drifted before update/u);
    expect(driftMutation.notCalled).to.equal(true);
  });

  it('fails closed when sibling semantics drift without identity changes', async () => {
    const current = state();
    const caller = connection(current);
    let searches = 0;
    caller.request.callsFake(({ url }: { url: string }) => {
      if (url === '/connect/cms/spaces/space') {
        return fakeRequest({ id: 'space', defaultLanguage: 'en_US' });
      }
      if (url.startsWith('/connect/cms/items/search')) {
        searches += 1;
        if (searches === 2) {
          (current.variants['variant-de'].contentBody as Record<string, unknown>).rawHtml =
            '&lt;p&gt;Concurrent sibling edit&lt;/p&gt;';
        }
        const items = Object.keys(current.variants).map((id) => ({
          id,
          managedContentSpaceId: 'space',
          type: 'ManagedContentVariantSearchResultRepresentation',
        }));
        return fakeRequest({ items, total: items.length });
      }
      if (url.includes('/connect/cms/contents/variants/')) {
        const id = decodeURIComponent(url.split('/').at(-1) ?? '');
        return fakeRequest(structuredClone(current.variants[id]));
      }
      return fakeRequest(structuredClone(current.parent));
    });
    const mutation = sinon.stub(JsforceConnection.prototype, 'request');

    await expectFailure(run(caller), /drifted before update/u);
    expect(mutation.notCalled).to.equal(true);
  });

  it('proves the workspace default language and rejects stale editable baselines', async () => {
    const wrongDefaultState = state();
    const wrongDefault = connection(wrongDefaultState);
    wrongDefault.request.callsFake(({ url }: { url: string }) => {
      if (url === '/connect/cms/spaces/space')
        return fakeRequest({ id: 'space', defaultLanguage: 'fr_FR' });
      if (url.startsWith('/connect/cms/items/search')) {
        const items = Object.keys(wrongDefaultState.variants).map((id) => ({
          id,
          managedContentSpaceId: 'space',
          type: 'ManagedContentVariantSearchResultRepresentation',
        }));
        return fakeRequest({ items, total: items.length });
      }
      if (url.includes('/connect/cms/contents/variants/')) {
        const id = decodeURIComponent(url.split('/').at(-1) ?? '');
        return fakeRequest(structuredClone(wrongDefaultState.variants[id]));
      }
      throw new Error(`Unexpected request after wrong default: ${url}`);
    });
    const mutation = sinon.stub(JsforceConnection.prototype, 'request');
    await expectFailure(run(wrongDefault), /resolve exactly once/u);
    expect(mutation.notCalled).to.equal(true);
    mutation.restore();

    const stale = state();
    (stale.variants['variant-en'].contentBody as Record<string, unknown>).rawHtml =
      '&lt;p&gt;Newer destination&lt;/p&gt;';
    const staleMutation = sinon.stub(JsforceConnection.prototype, 'request');
    await expectFailure(run(connection(stale)), /baseline does not match/u);
    expect(staleMutation.notCalled).to.equal(true);
  });

  it('reports an ambiguous mutation outcome without retrying', async () => {
    const mutation = sinon
      .stub(JsforceConnection.prototype, 'request')
      .returns(
        Object.assign(Promise.reject(new Error('timeout')), { stream: () => new PassThrough() }),
      );
    let failure: unknown;
    try {
      await run(connection(state()));
    } catch (error) {
      failure = error;
    }
    expect(failure).to.be.instanceOf(EmailUpdateOutcomeUnknownError);
    expect((failure as EmailUpdateOutcomeUnknownError).variantId).to.equal('variant-en');
    expect((failure as EmailUpdateOutcomeUnknownError).payloadHash).to.match(/^[a-f\d]{64}$/u);
    expect(mutation.calledOnce).to.equal(true);
  });

  it('requires read-only reconciliation when post-update readback fails', async () => {
    const current = state();
    const caller = connection(current);
    const originalRequest = caller.request;
    caller.request = sinon.stub().callsFake((request: { method?: string; url: string }) => {
      if (request.method === 'GET' && request.url.includes('/connect/cms/contents/content-id')) {
        return Promise.reject(new Error('readback unavailable'));
      }
      return originalRequest(request);
    });
    sinon.stub(JsforceConnection.prototype, 'request').callsFake(() => {
      (current.variants['variant-en'].contentBody as Record<string, unknown>).rawHtml =
        '&lt;p&gt;Edited&lt;/p&gt;';
      return Object.assign(Promise.resolve(current.variants['variant-en']), {
        stream: () => new PassThrough(),
      });
    });

    await expectOutcomeUnknown(run(caller));
  });

  it('requires read-only reconciliation when post-update semantics mismatch', async () => {
    const current = state();
    sinon.stub(JsforceConnection.prototype, 'request').callsFake(() =>
      Object.assign(Promise.resolve(current.variants['variant-en']), {
        stream: () => new PassThrough(),
      }),
    );

    await expectOutcomeUnknown(run(connection(current)));
  });

  function run(caller: ReturnType<typeof connection>) {
    return updateDraftEmailFromEditableHtml(caller, {
      sourceDirectory,
      editableDirectory,
      selector: { workspaceId: 'space', apiName: 'pilot_email', useDefaultLanguage: true },
    });
  }
});

async function removeOwnedFixture(runRoot: string, target: string): Promise<void> {
  const relative = path.relative(runRoot, target);
  if (
    relative === '' ||
    path.isAbsolute(relative) ||
    relative === '..' ||
    relative.startsWith(`..${path.sep}`)
  ) {
    throw new Error('Refusing unsafe fixture cleanup target');
  }
  await readFile(path.join(runRoot, '.owner'), 'utf8');
  const information = await lstat(target);
  if (information.isSymbolicLink()) throw new Error('Refusing fixture cleanup through a symlink');
  await rm(target, { recursive: true });
}

async function expectOutcomeUnknown(promise: Promise<unknown>): Promise<void> {
  let failure: unknown;
  try {
    await promise;
  } catch (error) {
    failure = error;
  }
  expect(failure).to.be.instanceOf(EmailUpdateOutcomeUnknownError);
  expect((failure as EmailUpdateOutcomeUnknownError).contentId).to.equal('parent-email');
  expect((failure as EmailUpdateOutcomeUnknownError).variantId).to.equal('variant-en');
  expect((failure as EmailUpdateOutcomeUnknownError).payloadHash).to.match(/^[a-f\d]{64}$/u);
}

async function expectFailure(promise: Promise<unknown>, message: RegExp): Promise<void> {
  let failure: unknown;
  try {
    await promise;
  } catch (error) {
    failure = error;
  }
  expect(failure).to.be.instanceOf(Error);
  expect((failure as Error).message).to.match(message);
}
