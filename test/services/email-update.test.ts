import { Connection as JsforceConnection } from '@jsforce/jsforce-node';
import crypto from 'node:crypto';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  rmdir,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { expect } from 'chai';
import sinon from 'sinon';
import { exportWorkspace } from '../../src/services/export-workspace.js';
import {
  applyDraftEmailUpdateWithReport,
  EmailUpdateOutcomeUnknownError,
  EmailUpdatePreflightBlockedError,
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

function template(
  id: string,
  language: string,
  apiName = 'pilot_template',
): Record<string, unknown> {
  return {
    ...email(id, language, apiName),
    managedContentId: 'parent-template',
    contentKey: 'template-key',
    title: 'Pilot template',
    urlName: undefined,
    contentType: { fullyQualifiedName: 'sfdc_cms__emailTemplate', name: 'Email Template' },
    contentBody: {
      'sfdc_cms:title': 'Pilot template',
      subjectLine: 'Pilot subject',
      messagePurpose: 'Transactional',
      rawHtml: '&lt;p&gt;Original template&lt;/p&gt;',
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

  it('accepts the observed Draft Email Template body without subjectLine', async () => {
    const templateRoot = await mkdtemp(path.join(tmpdir(), 'cms-template-update-no-subject-'));
    await writeFile(path.join(templateRoot, '.owner'), crypto.randomUUID(), { flag: 'wx' });
    const templateSource = path.join(templateRoot, 'source');
    const templateEditable = path.join(templateRoot, 'editable');
    const observed = template('template-en', 'en_US');
    const observedBody = observed.contentBody as Record<string, unknown>;
    delete observedBody.subjectLine;
    const current: State = {
      parent: {
        managedContentId: 'parent-template',
        contentType: { fullyQualifiedName: 'sfdc_cms__emailTemplate' },
        contentSpace: { id: 'space' },
      },
      variants: { 'template-en': observed },
    };
    const caller = connection(current);
    caller.request.callsFake(({ url }: { url: string }) => {
      if (url.startsWith('/connect/cms/items/search')) {
        const item = {
          id: 'template-en',
          managedContentSpaceId: 'space',
          contentType: { developerName: 'sfdc_cms__emailTemplate' },
          type: 'ManagedContentVariantSearchResultRepresentation',
        };
        return fakeRequest({ count: 1, items: [item] });
      }
      if (url.includes('/connect/cms/contents/variants/'))
        return fakeRequest(structuredClone(current.variants['template-en']));
      if (url.includes('/connect/cms/contents/parent-template'))
        return fakeRequest(structuredClone(current.parent));
      throw new Error(`Unexpected request: ${url}`);
    });
    try {
      await exportWorkspace(caller, 'space', templateSource, {
        editableDirectory: templateEditable,
        selection: { contentType: 'sfdc_cms__emailTemplate', apiNames: ['pilot_template'] },
      });
      await writeFile(
        path.join(templateEditable, 'items/template-en.html'),
        '<p>Updated template</p>',
      );
      const preview = await previewDraftEmailUpdateFromEditableHtml(caller, {
        contentType: 'sfdc_cms__emailTemplate',
        sourceDirectory: templateSource,
        editableDirectory: templateEditable,
        selector: { workspaceId: 'space', apiName: 'pilot_template', language: 'en_US' },
      });
      expect(preview.status).to.equal('ready');
    } finally {
      await removeOwnedFixture(templateRoot, templateSource);
      await removeOwnedFixture(templateRoot, templateEditable);
      await unlink(path.join(templateRoot, '.owner'));
      await rmdir(templateRoot);
    }
  });

  it('previews and applies one exact Draft Email Template with dual inventory and one PUT', async () => {
    const templateRoot = await mkdtemp(path.join(tmpdir(), 'cms-template-update-'));
    await writeFile(path.join(templateRoot, '.owner'), crypto.randomUUID(), { flag: 'wx' });
    const templateSource = path.join(templateRoot, 'source');
    const templateEditable = path.join(templateRoot, 'editable');
    const current: State = {
      parent: {
        managedContentId: 'parent-template',
        contentType: { fullyQualifiedName: 'sfdc_cms__emailTemplate' },
        contentSpace: { id: 'space' },
      },
      variants: { 'template-en': template('template-en', 'en_US') },
    };
    const caller = connection(current);
    caller.request.callsFake(({ url }: { url: string }) => {
      if (url === '/connect/cms/spaces/space')
        return fakeRequest({ id: 'space', defaultLanguage: 'en_US' });
      if (url.startsWith('/connect/cms/items/search')) {
        const familyScoped = url.includes('contentTypeFQN=');
        const templateItem = {
          id: 'template-en',
          managedContentSpaceId: 'space',
          contentType: { developerName: 'sfdc_cms__emailTemplate' },
          type: 'ManagedContentVariantSearchResultRepresentation',
        };
        const items = familyScoped
          ? [templateItem]
          : [
              templateItem,
              {
                id: 'other-image',
                managedContentSpaceId: 'space',
                contentType: { developerName: 'sfdc_cms__image' },
                type: 'ManagedContentVariantSearchResultRepresentation',
              },
            ];
        return fakeRequest({ count: items.length, items });
      }
      if (url.includes('/connect/cms/contents/variants/'))
        return fakeRequest(structuredClone(current.variants['template-en']));
      if (url.includes('/connect/cms/contents/parent-template'))
        return fakeRequest(structuredClone(current.parent));
      throw new Error(`Unexpected request: ${url}`);
    });
    await exportWorkspace(caller, 'space', templateSource, {
      editableDirectory: templateEditable,
      selection: { contentType: 'sfdc_cms__emailTemplate', apiNames: ['pilot_template'] },
    });
    await writeFile(
      path.join(templateEditable, 'items/template-en.html'),
      '<p>Updated template</p>',
    );
    const mutation = sinon.stub(JsforceConnection.prototype, 'request').callsFake((request) => {
      const body = JSON.parse((request as { body: string }).body) as Record<string, unknown>;
      current.variants['template-en'] = {
        ...current.variants['template-en'],
        ...body,
        contentBody: {
          ...(body.contentBody as Record<string, unknown>),
          rawHtml: '&lt;p&gt;Updated template&lt;/p&gt;',
        },
      };
      return fakeRequest(structuredClone(current.variants['template-en']));
    });
    try {
      const input = {
        contentType: 'sfdc_cms__emailTemplate' as const,
        sourceDirectory: templateSource,
        editableDirectory: templateEditable,
        selector: { workspaceId: 'space', apiName: 'pilot_template', language: 'en_US' },
      };
      const preview = await previewDraftEmailUpdateFromEditableHtml(caller, input);
      expect(preview.status).to.equal('ready');
      if (preview.status !== 'ready') throw new Error('Expected ready Template preview');
      expect(preview.evidence.contentType).to.equal('sfdc_cms__emailTemplate');
      const result = await updateDraftEmailFromEditableHtml(caller, input);
      expect(result.contentType).to.equal('sfdc_cms__emailTemplate');
      expect(result.changedFields).to.deep.equal(['contentBody.rawHtml']);
      expect(result.lifecycle).to.deep.equal({ isPublished: false, status: 'Draft' });
      expect(mutation.calledOnce).to.equal(true);
      const submitted = JSON.parse((mutation.firstCall.args[0] as { body: string }).body) as {
        contentBody: Record<string, unknown>;
      };
      expect(submitted.contentBody.rawHtml).to.equal('<p>Updated template</p>');
      expect(submitted.contentBody.subjectLine).to.equal('Pilot subject');
    } finally {
      mutation.restore();
      await removeOwnedFixture(templateRoot, templateSource);
      await removeOwnedFixture(templateRoot, templateEditable);
      await unlink(path.join(templateRoot, '.owner'));
      await rmdir(templateRoot);
    }
  });

  it('blocks Template update when dual inventories disagree without PUT', async () => {
    const templateRoot = await mkdtemp(path.join(tmpdir(), 'cms-template-update-mismatch-'));
    await writeFile(path.join(templateRoot, '.owner'), crypto.randomUUID(), { flag: 'wx' });
    const templateSource = path.join(templateRoot, 'source');
    const templateEditable = path.join(templateRoot, 'editable');
    const current: State = {
      parent: {
        managedContentId: 'parent-template',
        contentType: { fullyQualifiedName: 'sfdc_cms__emailTemplate' },
        contentSpace: { id: 'space' },
      },
      variants: { 'template-en': template('template-en', 'en_US') },
    };
    const exportCaller = connection(current);
    exportCaller.request.callsFake(({ url }: { url: string }) => {
      if (url.startsWith('/connect/cms/items/search'))
        return fakeRequest({
          count: 1,
          items: [
            {
              id: 'template-en',
              managedContentSpaceId: 'space',
              contentType: { developerName: 'sfdc_cms__emailTemplate' },
              type: 'ManagedContentVariantSearchResultRepresentation',
            },
          ],
        });
      if (url.endsWith('/template-en')) return fakeRequest(current.variants['template-en']);
      throw new Error(`Unexpected export request ${url}`);
    });
    await exportWorkspace(exportCaller, 'space', templateSource, {
      editableDirectory: templateEditable,
      selection: { contentType: 'sfdc_cms__emailTemplate', apiNames: ['pilot_template'] },
    });
    await writeFile(path.join(templateEditable, 'items/template-en.html'), '<p>Updated</p>');
    const caller = connection(current);
    caller.request.callsFake(({ url }: { url: string }) => {
      if (url === '/connect/cms/spaces/space')
        return fakeRequest({ id: 'space', defaultLanguage: 'en_US' });
      if (url.startsWith('/connect/cms/items/search')) {
        const familyScoped = url.includes('contentTypeFQN=');
        const items = familyScoped
          ? [
              {
                id: 'template-en',
                managedContentSpaceId: 'space',
                contentType: { developerName: 'sfdc_cms__emailTemplate' },
                type: 'ManagedContentVariantSearchResultRepresentation',
              },
            ]
          : [];
        return fakeRequest({ count: items.length, items });
      }
      throw new Error(`Unexpected request ${url}`);
    });
    const mutation = sinon.stub(JsforceConnection.prototype, 'request');
    try {
      const result = await previewDraftEmailUpdateFromEditableHtml(caller, {
        contentType: 'sfdc_cms__emailTemplate',
        sourceDirectory: templateSource,
        editableDirectory: templateEditable,
        selector: { workspaceId: 'space', apiName: 'pilot_template', language: 'en_US' },
      });
      expect(result.status).to.equal('blocked');
      expect(result.status === 'blocked' && result.blockers[0].message).to.equal(
        'Email Template family search disagrees with complete workspace inventory',
      );
      expect(mutation.notCalled).to.equal(true);
    } finally {
      mutation.restore();
      await removeOwnedFixture(templateRoot, templateSource);
      await removeOwnedFixture(templateRoot, templateEditable);
      await unlink(path.join(templateRoot, '.owner'));
      await rmdir(templateRoot);
    }
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

  it('normalizes malformed editable descriptor JSON as blocked preview and apply preflight', async () => {
    await writeFile(path.join(editableDirectory, 'editable.json'), '{ malformed');
    const mutation = sinon.stub(JsforceConnection.prototype, 'request');

    const preview = await previewDraftEmailUpdateFromEditableHtml(connection(state()), {
      sourceDirectory,
      editableDirectory,
      selector: { workspaceId: 'space', apiName: 'pilot_email', language: 'en_US' },
    });

    expect(preview).to.deep.equal({
      blockers: [
        {
          code: 'EMAIL_UPDATE_PREFLIGHT_BLOCKED',
          message: 'Editable descriptor must contain valid JSON',
        },
      ],
      status: 'blocked',
    });

    const reportDirectory = path.join(root, 'malformed-descriptor-report');
    let failure: unknown;
    try {
      await applyDraftEmailUpdateWithReport(
        connection(state()),
        {
          sourceDirectory,
          editableDirectory,
          selector: { workspaceId: 'space', apiName: 'pilot_email', language: 'en_US' },
        },
        reportDirectory,
      );
    } catch (error) {
      failure = error;
    }

    expect(failure).to.be.instanceOf(EmailUpdatePreflightBlockedError);
    expect((failure as Error).message).to.equal('Editable descriptor must contain valid JSON');
    expect(mutation.notCalled).to.equal(true);
    await expectMissing(reportDirectory);
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

  it('blocks a partial workspace baseline before creating a report or issuing PUT', async () => {
    const manifestFile = path.join(sourceDirectory, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestFile, 'utf8')) as Record<string, unknown>;
    manifest.completeness = 'partial';
    await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
    const reportDirectory = path.join(root, 'partial-baseline-report');
    const mutation = sinon.stub(JsforceConnection.prototype, 'request');

    let failure: unknown;
    try {
      await applyDraftEmailUpdateWithReport(
        connection(state()),
        {
          sourceDirectory,
          editableDirectory,
          selector: { workspaceId: 'space', apiName: 'pilot_email', language: 'en_US' },
        },
        reportDirectory,
      );
    } catch (error) {
      failure = error;
    }

    expect(failure).to.be.instanceOf(EmailUpdatePreflightBlockedError);
    expect((failure as Error).message).to.match(/workspace export is partial/iu);
    expect(mutation.notCalled).to.equal(true);
    await expectMissing(reportDirectory);
  });

  it('blocks stale apply preflight and existing report directories without mutation or ownership claim', async () => {
    const stale = state();
    (stale.variants['variant-en'].contentBody as Record<string, unknown>).rawHtml =
      '&lt;p&gt;Newer destination&lt;/p&gt;';
    const staleReport = path.join(root, 'stale-report');
    const staleMutation = sinon.stub(JsforceConnection.prototype, 'request');
    let staleFailure: unknown;
    try {
      await applyDraftEmailUpdateWithReport(
        connection(stale),
        {
          sourceDirectory,
          editableDirectory,
          selector: { workspaceId: 'space', apiName: 'pilot_email', language: 'en_US' },
        },
        staleReport,
      );
    } catch (error) {
      staleFailure = error;
    }
    expect(staleFailure).to.be.instanceOf(EmailUpdatePreflightBlockedError);
    expect((staleFailure as Error).message).to.match(/baseline does not match/u);
    expect(staleMutation.notCalled).to.equal(true);
    await expectMissing(staleReport);
    staleMutation.restore();

    const existingReport = path.join(root, 'existing-report');
    await mkdir(existingReport);
    const existingMutation = sinon.stub(JsforceConnection.prototype, 'request');
    let existingFailure: unknown;
    try {
      await applyDraftEmailUpdateWithReport(
        connection(state()),
        {
          sourceDirectory,
          editableDirectory,
          selector: { workspaceId: 'space', apiName: 'pilot_email', language: 'en_US' },
        },
        existingReport,
      );
    } catch (error) {
      existingFailure = error;
    }
    expect(existingFailure).to.be.instanceOf(EmailUpdatePreflightBlockedError);
    expect((existingFailure as Error).message).to.match(/already exists/u);
    expect(existingMutation.notCalled).to.equal(true);
    await expectMissing(path.join(existingReport, 'content-update-run.json'));
    existingMutation.restore();
    await rmdir(existingReport);
  });

  it('persists pending intent before one PUT and completes the durable report', async () => {
    const current = state();
    const caller = connection(current);
    const reportDirectory = path.join(root, 'report');
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

    const applied = await applyDraftEmailUpdateWithReport(
      caller,
      {
        sourceDirectory,
        editableDirectory,
        selector: { workspaceId: 'space', apiName: 'pilot_email', language: 'en_US' },
      },
      reportDirectory,
    );
    const report = JSON.parse(await readFile(applied.reportFile, 'utf8')) as Record<
      string,
      unknown
    >;
    expect(report).to.deep.include({
      contract: 'sf-cms-email-update-run',
      contractVersion: '1.0.0',
      state: 'completed',
    });
    expect(mutation.calledOnce).to.equal(true);
    await removeOwnedFixture(root, reportDirectory);
  });

  it('treats completed-report persistence failure as ownership uncertain without another PUT', async () => {
    const current = state();
    const caller = connection(current);
    const reportDirectory = path.join(root, 'report-persist-failure');
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
    const reportFile = path.join(reportDirectory, 'content-update-run.json');
    let rewrites = 0;
    const { rewriteAtomic } = await import('../../src/services/import-workspace.js');
    const rewriteReport = async (file: string, value: unknown): Promise<void> => {
      rewrites += 1;
      if (rewrites === 2) throw new Error('report unavailable');
      await rewriteAtomic(file, value);
    };

    await expectOutcomeUnknown(
      applyDraftEmailUpdateWithReport(
        caller,
        {
          sourceDirectory,
          editableDirectory,
          selector: { workspaceId: 'space', apiName: 'pilot_email', language: 'en_US' },
        },
        reportDirectory,
        { rewriteReport },
      ),
    );
    expect(mutation.calledOnce).to.equal(true);
    expect((JSON.parse(await readFile(reportFile, 'utf8')) as { state: string }).state).to.equal(
      'ownership-uncertain',
    );
    await removeOwnedFixture(root, reportDirectory);
  });

  it('retains ownership-uncertain reconciliation identity without retrying', async () => {
    const reportDirectory = path.join(root, 'uncertain-report');
    const mutation = sinon
      .stub(JsforceConnection.prototype, 'request')
      .returns(
        Object.assign(Promise.reject(new Error('timeout')), { stream: () => new PassThrough() }),
      );

    await expectOutcomeUnknown(
      applyDraftEmailUpdateWithReport(
        connection(state()),
        {
          sourceDirectory,
          editableDirectory,
          selector: { workspaceId: 'space', apiName: 'pilot_email', language: 'en_US' },
        },
        reportDirectory,
      ),
    );
    const report = JSON.parse(
      await readFile(path.join(reportDirectory, 'content-update-run.json'), 'utf8'),
    ) as { state: string; reconciliation: { variantId: string; payloadHash: string } };
    expect(report.state).to.equal('ownership-uncertain');
    expect(report.reconciliation.variantId).to.equal('variant-en');
    expect(report.reconciliation.payloadHash).to.match(/^[a-f\d]{64}$/u);
    expect(mutation.calledOnce).to.equal(true);
    await removeOwnedFixture(root, reportDirectory);
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

async function expectMissing(target: string): Promise<void> {
  let failure: unknown;
  try {
    await stat(target);
  } catch (error) {
    failure = error;
  }
  expect(failure).to.have.property('code', 'ENOENT');
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
