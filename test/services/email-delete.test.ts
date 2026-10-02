import { Connection as JsforceConnection } from '@jsforce/jsforce-node';
import { expect } from 'chai';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import sinon from 'sinon';
import { exportWorkspace } from '../../src/services/export-workspace.js';
import {
  applyDraftEmailDeleteWithReport,
  EmailDeleteOutcomeUnknownError,
  previewDraftEmailDelete,
} from '../../src/services/email-delete.js';

type FakeRequest<T> = Promise<T> & { stream(): PassThrough };
function fakeRequest<T>(value?: T): FakeRequest<T | undefined> {
  return Object.assign(Promise.resolve(value), { stream: () => new PassThrough() });
}
function email(id = 'variant-en'): Record<string, unknown> {
  return {
    managedContentVariantId: id,
    managedContentId: 'parent-email',
    apiName: 'pilot_email',
    language: 'en_US',
    title: 'Pilot email',
    urlName: 'pilot-email',
    contentType: { fullyQualifiedName: 'sfdc_cms__email' },
    contentSpace: { id: 'space' },
    isPublished: false,
    status: { status: 'Draft' },
    contentBody: { rawHtml: '&lt;p&gt;Original&lt;/p&gt;' },
  };
}
function template(id = 'template-en'): Record<string, unknown> {
  return {
    managedContentVariantId: id,
    managedContentId: 'parent-template',
    contentKey: 'template-key',
    apiName: 'pilot_template',
    language: 'en_US',
    title: 'Pilot template',
    contentType: { fullyQualifiedName: 'sfdc_cms__emailTemplate' },
    contentSpace: { id: 'space' },
    isPublished: false,
    status: { status: 'Draft' },
    externalId: null,
    externalSource: null,
    contentBody: {
      'sfdc_cms:title': 'Pilot template',
      subjectLine: 'Pilot subject',
      messagePurpose: 'Transactional',
      rawHtml: '&lt;p&gt;Safe template&lt;/p&gt;',
      'lightning:dataProviders': [],
      'lightning:expressions': [],
      'sfdc_cms:attachments': [],
      'sfdc_cms:variants': [],
    },
  };
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => canonical(item));
  if (typeof value !== 'object' || value === null) return value;
  const source = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(source)
      .toSorted()
      .map((key) => [key, canonical(source[key])]),
  );
}
async function ownershipFile(parent: string): Promise<string> {
  const file = path.join(parent, 'ownership.json');
  const crypto = await import('node:crypto');
  const baselineHash = crypto
    .createHash('sha256')
    .update(
      JSON.stringify(
        canonical({
          apiName: 'pilot_email',
          contentBody: { rawHtml: '&lt;p&gt;Original&lt;/p&gt;' },
          title: 'Pilot email',
          urlName: 'pilot-email',
        }),
      ),
    )
    .digest('hex');
  const requestIdentity = 'retained-create-request';
  const requestSha256 = crypto
    .createHash('sha256')
    .update(JSON.stringify(requestIdentity))
    .digest('hex');
  await writeFile(
    file,
    `${JSON.stringify(
      {
        contract: 'sf-cms-email-delete-ownership',
        contractVersion: '1.0.0',
        state: 'completed',
        identity: {
          orgId: '00Dorg',
          workspaceId: 'space',
          family: 'sfdc_cms__email',
          apiName: 'pilot_email',
          language: 'en_US',
          contentId: 'parent-email',
          variantId: 'variant-en',
        },
        requestIdentity,
        requestSha256,
        baselineHash,
      },
      null,
      2,
    )}\n`,
  );
  return file;
}
async function templateCreateJournal(parent: string): Promise<{
  journal: string;
  sourceDirectory: string;
}> {
  const sourceDirectory = path.join(parent, 'source');
  const sourceVariant = template();
  const request = sinon.stub().callsFake(({ url }: { url: string }) => {
    if (url === '/connect/cms/spaces/space') return fakeRequest({ id: 'space', name: 'Space' });
    if (url.startsWith('/connect/cms/items/search'))
      return fakeRequest({
        items: [
          {
            id: 'template-en',
            managedContentSpaceId: 'space',
            contentType: { developerName: 'sfdc_cms__emailTemplate' },
            type: 'ManagedContentVariantSearchResultRepresentation',
          },
        ],
        total: 1,
      });
    if (url.endsWith('/template-en')) return fakeRequest(sourceVariant);
    throw new Error(`Unexpected source request ${url}`);
  });
  await exportWorkspace({ request }, 'space', sourceDirectory, {
    selection: { contentType: 'sfdc_cms__emailTemplate', apiNames: ['pilot_template'] },
  });
  const manifestBytes = await readFile(path.join(sourceDirectory, 'manifest.json'));
  const payload = {
    apiName: 'pilot_template',
    contentBody: {
      ...(sourceVariant.contentBody as Record<string, unknown>),
      rawHtml: '<p>Safe template</p>',
    },
    contentSpaceId: 'space',
    contentType: 'sfdc_cms__emailTemplate',
    title: 'Pilot template',
  };
  const requestIdentity = `create-parent\0template-key\0en_US\0${JSON.stringify(payload)}`;
  const crypto = await import('node:crypto');
  const journal = path.join(parent, 'workspace-import-run.json');
  await writeFile(
    journal,
    `${JSON.stringify({
      state: 'completed',
      destinationOrgId: '00Dorg',
      destinationWorkspaceId: 'space',
      sourceDirectory,
      sourceManifestSha256: crypto.createHash('sha256').update(manifestBytes).digest('hex'),
      operations: [
        {
          state: 'succeeded',
          operationKind: 'create-parent',
          destinationOrgId: '00Dorg',
          destinationWorkspaceId: 'space',
          contentKey: 'template-key',
          language: 'en_US',
          requestIdentity,
          requestSha256: crypto.createHash('sha256').update(requestIdentity).digest('hex'),
          result: { contentId: 'parent-template', primaryVariantId: 'template-en' },
        },
      ],
      createdParents: [
        {
          contentId: 'parent-template',
          primaryVariantId: 'template-en',
          childVariantIds: [],
        },
      ],
    })}\n`,
  );
  return { journal, sourceDirectory };
}
function templateFixture() {
  const variants: Record<string, Record<string, unknown>> = { 'template-en': template() };
  let parentFailure: unknown;
  const request = sinon.stub().callsFake(({ url }: { url: string }) => {
    if (url === '/connect/cms/spaces/space')
      return fakeRequest({ id: 'space', defaultLanguage: 'en_US' });
    if (url.startsWith('/connect/cms/items/search'))
      return fakeRequest({
        items: Object.keys(variants).map((id) => ({
          id,
          managedContentSpaceId: 'space',
          contentType: { developerName: 'sfdc_cms__emailTemplate' },
          type: 'ManagedContentVariantSearchResultRepresentation',
        })),
        total: Object.keys(variants).length,
      });
    if (url === '/connect/cms/contents/parent-template') {
      if (parentFailure !== undefined)
        return Object.assign(Promise.reject(parentFailure), {
          stream: () => new PassThrough(),
        });
      return fakeRequest({
        managedContentId: 'parent-template',
        contentType: { fullyQualifiedName: 'sfdc_cms__emailTemplate' },
        contentSpace: { id: 'space' },
      });
    }
    if (url.includes('/connect/cms/contents/variants/')) {
      const id = url.split('/').at(-1)!;
      if (!(id in variants))
        return Object.assign(
          Promise.reject(
            Object.assign(new Error('variant not found'), {
              data: [{ errorCode: 'VARIANT_NOT_FOUND', message: 'Variant not found' }],
              response: { status: 404 },
            }),
          ),
          { stream: () => new PassThrough() },
        );
      return fakeRequest(variants[id]);
    }
    throw new Error(`Unexpected request ${url}`);
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
    deleteVariant() {
      delete variants['template-en'];
    },
    removeParent() {
      parentFailure = Object.assign(new Error('parent not found'), {
        data: [{ errorCode: 'NOT_FOUND', message: 'Parent not found' }],
        response: { status: 404 },
      });
    },
  };
}
function fixture() {
  const variants: Record<string, Record<string, unknown>> = { 'variant-en': email() };
  let parentFailure: unknown;
  const request = sinon.stub().callsFake(({ url }: { url: string }) => {
    if (url === '/connect/cms/spaces/space')
      return fakeRequest({ id: 'space', defaultLanguage: 'en_US' });
    if (url.startsWith('/connect/cms/items/search'))
      return fakeRequest({
        items: Object.keys(variants).map((id) => ({
          id,
          managedContentSpaceId: 'space',
          contentType: { developerName: 'sfdc_cms__email' },
          type: 'ManagedContentVariantSearchResultRepresentation',
        })),
        total: Object.keys(variants).length,
      });
    if (url === '/connect/cms/contents/parent-email') {
      if (parentFailure !== undefined)
        return Object.assign(Promise.reject(parentFailure), {
          stream: () => new PassThrough(),
        });
      return fakeRequest({
        managedContentId: 'parent-email',
        contentType: { fullyQualifiedName: 'sfdc_cms__email' },
        contentSpace: { id: 'space' },
      });
    }
    if (url.includes('/connect/cms/contents/variants/')) {
      const id = url.split('/').at(-1)!;
      if (!(id in variants))
        return Object.assign(
          Promise.reject(
            Object.assign(new Error('variant not found'), {
              data: [{ errorCode: 'VARIANT_NOT_FOUND', message: 'Variant not found' }],
              response: { status: 404 },
            }),
          ),
          { stream: () => new PassThrough() },
        );
      return fakeRequest(variants[id]);
    }
    throw new Error(`Unexpected request ${url}`);
  });
  return {
    connection: {
      accessToken: 'token',
      instanceUrl: 'https://example.invalid',
      request,
      version: '67.0',
    },
    deleteVariant() {
      delete variants['variant-en'];
    },
    removeParent(errorCode = 'NOT_FOUND', errorEntryCount = 1) {
      const data = Array.from({ length: errorEntryCount }, () => ({
        errorCode,
        message: 'Parent not found',
      }));
      parentFailure = Object.assign(new Error('parent not found'), {
        data,
        response: { status: 404 },
      });
    },
    failParent(error: unknown) {
      parentFailure = error;
    },
    request,
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

describe('Email delete service', () => {
  it('previews one exact CREATE-owned Draft Email Template from strict artifacts', async () => {
    const parent = await mkdtemp(path.join(tmpdir(), 'sf-cms-template-delete-preview-'));
    try {
      const current = templateFixture();
      const ownership = await templateCreateJournal(parent);
      const result = await previewDraftEmailDelete(current.connection, {
        contentType: 'sfdc_cms__emailTemplate',
        orgId: '00Dorg',
        ownershipReport: ownership.journal,
        selector: { workspaceId: 'space', apiName: 'pilot_template', language: 'en_US' },
      });
      expect(result.status).to.equal('ready');
      expect(result.status === 'ready' && result.evidence.contentType).to.equal(
        'sfdc_cms__emailTemplate',
      );
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it('accepts per-page count semantics for a complete workspace inventory page', async () => {
    const parent = await mkdtemp(path.join(tmpdir(), 'sf-cms-template-delete-page-count-'));
    try {
      const current = templateFixture();
      current.request.resetBehavior();
      current.request.callsFake(({ url }: { url: string }) => {
        if (url === '/connect/cms/spaces/space')
          return fakeRequest({ id: 'space', defaultLanguage: 'en_US' });
        if (url.startsWith('/connect/cms/items/search')) {
          expect(url).to.not.include('page=1');
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
                ...Array.from({ length: 30 }, (_, index) => ({
                  id: `other-${index}`,
                  managedContentSpaceId: 'space',
                  contentType: { developerName: 'sfdc_cms__image' },
                  type: 'ManagedContentVariantSearchResultRepresentation',
                })),
              ];
          return fakeRequest({ count: items.length, items });
        }
        if (url === '/connect/cms/contents/parent-template')
          return fakeRequest({
            managedContentId: 'parent-template',
            contentType: { fullyQualifiedName: 'sfdc_cms__emailTemplate' },
            contentSpace: { id: 'space' },
          });
        if (url.endsWith('/template-en')) return fakeRequest(template());
        throw new Error(`Unexpected request ${url}`);
      });
      const ownership = await templateCreateJournal(parent);
      const result = await previewDraftEmailDelete(current.connection, {
        contentType: 'sfdc_cms__emailTemplate',
        orgId: '00Dorg',
        ownershipReport: ownership.journal,
        selector: { workspaceId: 'space', apiName: 'pilot_template', language: 'en_US' },
      });
      expect(result.status).to.equal('ready');
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it('paginates complete Template inventories and rejects duplicate variant IDs', async () => {
    const parent = await mkdtemp(path.join(tmpdir(), 'sf-cms-template-delete-pagination-'));
    try {
      const current = templateFixture();
      current.request.resetBehavior();
      current.request.callsFake(({ url }: { url: string }) => {
        if (url === '/connect/cms/spaces/space')
          return fakeRequest({ id: 'space', defaultLanguage: 'en_US' });
        if (url.startsWith('/connect/cms/items/search')) {
          const page = Number(new URL(url, 'https://example.invalid').searchParams.get('page'));
          const familyScoped = url.includes('contentTypeFQN=');
          const item = (id: string) => ({
            id,
            managedContentSpaceId: 'space',
            contentType: { developerName: 'sfdc_cms__emailTemplate' },
            type: 'ManagedContentVariantSearchResultRepresentation',
          });
          if (familyScoped && page === 0)
            return fakeRequest({
              count: 200,
              items: Array.from({ length: 200 }, (_, i) =>
                item(i === 0 ? 'template-en' : `template-${i}`),
              ),
            });
          if (familyScoped && page === 1)
            return fakeRequest({ count: 1, items: [item('template-en')] });
          return fakeRequest({ count: 0, items: [] });
        }
        throw new Error(`Unexpected request ${url}`);
      });
      const ownership = await templateCreateJournal(parent);
      const result = await previewDraftEmailDelete(current.connection, {
        contentType: 'sfdc_cms__emailTemplate',
        orgId: '00Dorg',
        ownershipReport: ownership.journal,
        selector: { workspaceId: 'space', apiName: 'pilot_template', language: 'en_US' },
      });
      expect(result.status).to.equal('blocked');
      expect(result.status === 'blocked' && result.blockers[0].message).to.equal(
        'Email Template search returned a duplicate variant',
      );
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it('blocks Template delete when family search disagrees with workspace family inventory', async () => {
    const parent = await mkdtemp(path.join(tmpdir(), 'sf-cms-template-delete-inventory-'));
    try {
      const current = templateFixture();
      current.request.resetBehavior();
      current.request.callsFake(({ url }: { url: string }) => {
        if (url === '/connect/cms/spaces/space')
          return fakeRequest({ id: 'space', defaultLanguage: 'en_US' });
        if (url.startsWith('/connect/cms/items/search')) {
          const familyScoped = url.includes('contentTypeFQN=');
          return fakeRequest({
            items: familyScoped
              ? [
                  {
                    id: 'template-en',
                    managedContentSpaceId: 'space',
                    contentType: { developerName: 'sfdc_cms__emailTemplate' },
                    type: 'ManagedContentVariantSearchResultRepresentation',
                  },
                ]
              : [],
            total: familyScoped ? 1 : 0,
          });
        }
        if (url === '/connect/cms/contents/parent-template')
          return fakeRequest({
            managedContentId: 'parent-template',
            contentType: { fullyQualifiedName: 'sfdc_cms__emailTemplate' },
            contentSpace: { id: 'space' },
          });
        if (url.endsWith('/template-en')) return fakeRequest(template());
        throw new Error(`Unexpected request ${url}`);
      });
      const ownership = await templateCreateJournal(parent);
      const result = await previewDraftEmailDelete(current.connection, {
        contentType: 'sfdc_cms__emailTemplate',
        orgId: '00Dorg',
        ownershipReport: ownership.journal,
        selector: { workspaceId: 'space', apiName: 'pilot_template', language: 'en_US' },
      });
      expect(result.status).to.equal('blocked');
      expect(result.status === 'blocked' && result.blockers[0].message).to.equal(
        'Email Template family search disagrees with complete workspace inventory',
      );
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it('writes pending intent, deletes one Template variant, and proves exact absence', async () => {
    const parent = await mkdtemp(path.join(tmpdir(), 'sf-cms-template-delete-apply-'));
    const current = templateFixture();
    const reportDirectory = path.join(parent, 'report');
    const mutation = sinon.stub(JsforceConnection.prototype, 'request').callsFake((request) => {
      const pending = JSON.parse(
        readFileSync(path.join(reportDirectory, 'content-delete-run.json'), 'utf8'),
      );
      expect(pending.state).to.equal('pending');
      expect((request as { method: string; url: string }).method).to.equal('DELETE');
      current.deleteVariant();
      current.removeParent();
      return fakeRequest();
    });
    try {
      const ownership = await templateCreateJournal(parent);
      const result = await applyDraftEmailDeleteWithReport(
        current.connection,
        {
          contentType: 'sfdc_cms__emailTemplate',
          orgId: '00Dorg',
          ownershipReport: ownership.journal,
          selector: { workspaceId: 'space', apiName: 'pilot_template', language: 'en_US' },
        },
        reportDirectory,
      );
      expect(mutation.calledOnce).to.equal(true);
      expect(result.evidence).to.deep.include({
        contentType: 'sfdc_cms__emailTemplate',
        exactVariantAbsent: true,
        parentBehavior: 'not-found',
        selectedInventoryMatches: 0,
      });
      expect(result.evidence.postInventory).to.deep.equal([]);
      const report = JSON.parse(await readFile(result.reportFile, 'utf8'));
      expect(report.state).to.equal('completed');
      expect(report.intent).to.deep.equal({ cascade: false, selectorScope: 'variant' });
    } finally {
      mutation.restore();
      await rm(parent, { recursive: true, force: true });
    }
  });

  it('blocks Email ownership reports for Email Template deletion', async () => {
    const parent = await mkdtemp(path.join(tmpdir(), 'sf-cms-template-delete-cross-family-'));
    try {
      const current = templateFixture();
      const result = await previewDraftEmailDelete(current.connection, {
        contentType: 'sfdc_cms__emailTemplate',
        orgId: '00Dorg',
        ownershipReport: await ownershipFile(parent),
        selector: { workspaceId: 'space', apiName: 'pilot_template', language: 'en_US' },
      });
      expect(result).to.deep.include({ status: 'blocked' });
      expect(result.status === 'blocked' && result.blockers[0].code).to.equal(
        'EMAIL_TEMPLATE_DELETE_PREFLIGHT_BLOCKED',
      );
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it('blocks changed Template source artifacts and unsafe references', async () => {
    const parent = await mkdtemp(path.join(tmpdir(), 'sf-cms-template-delete-artifact-'));
    try {
      const current = templateFixture();
      const ownership = await templateCreateJournal(parent);
      const manifestFile = path.join(ownership.sourceDirectory, 'manifest.json');
      const manifest = JSON.parse(await readFile(manifestFile, 'utf8')) as Record<string, unknown>;
      manifest.dependencies = ['unexpected'];
      await writeFile(manifestFile, `${JSON.stringify(manifest)}\n`);
      const result = await previewDraftEmailDelete(current.connection, {
        contentType: 'sfdc_cms__emailTemplate',
        orgId: '00Dorg',
        ownershipReport: ownership.journal,
        selector: { workspaceId: 'space', apiName: 'pilot_template', language: 'en_US' },
      });
      expect(result.status).to.equal('blocked');
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it('previews one exact owned Draft variant without mutation', async () => {
    const parent = await mkdtemp(path.join(tmpdir(), 'sf-cms-delete-preview-'));
    try {
      const current = fixture();
      const result = await previewDraftEmailDelete(current.connection, {
        orgId: '00Dorg',
        ownershipReport: await ownershipFile(parent),
        selector: { workspaceId: 'space', apiName: 'pilot_email', language: 'en_US' },
      });
      expect(result.status).to.equal('ready');
      expect(result.status === 'ready' && result.evidence.siblingVariantCount).to.equal(1);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it('writes pending intent, deletes once, and proves variant plus inventory absence', async () => {
    const parent = await mkdtemp(path.join(tmpdir(), 'sf-cms-delete-apply-'));
    const current = fixture();
    const reportDirectory = path.join(parent, 'report');
    const mutation = sinon.stub(JsforceConnection.prototype, 'request').callsFake((request) => {
      const pending = JSON.parse(
        readFileSync(path.join(reportDirectory, 'content-delete-run.json'), 'utf8'),
      );
      expect(pending.state).to.equal('pending');
      expect((request as { method: string; url: string }).method).to.equal('DELETE');
      current.deleteVariant();
      return fakeRequest();
    });
    try {
      const result = await applyDraftEmailDeleteWithReport(
        current.connection,
        {
          orgId: '00Dorg',
          ownershipReport: await ownershipFile(parent),
          selector: { workspaceId: 'space', apiName: 'pilot_email', useDefaultLanguage: true },
        },
        reportDirectory,
      );
      expect(mutation.calledOnce).to.equal(true);
      expect(result.evidence).to.deep.include({
        exactVariantAbsent: true,
        parentBehavior: 'present',
        parentIdentityPreserved: true,
        selectedInventoryMatches: 0,
      });
      expect(result.evidence.postInventory).to.deep.equal([]);
      const report = JSON.parse(await readFile(result.reportFile, 'utf8'));
      expect(report.state).to.equal('completed');
      expect(report.intent).to.deep.equal({ cascade: false, selectorScope: 'variant' });
    } finally {
      mutation.restore();
      await rm(parent, { recursive: true, force: true });
    }
  });

  it('accepts exact parent NOT_FOUND only after variant and inventory absence are proven', async () => {
    const parent = await mkdtemp(path.join(tmpdir(), 'sf-cms-delete-parent-absent-'));
    const current = fixture();
    const mutation = sinon.stub(JsforceConnection.prototype, 'request').callsFake(() => {
      current.deleteVariant();
      current.removeParent();
      return fakeRequest();
    });
    try {
      const result = await applyDraftEmailDeleteWithReport(
        current.connection,
        {
          orgId: '00Dorg',
          ownershipReport: await ownershipFile(parent),
          selector: { workspaceId: 'space', apiName: 'pilot_email', language: 'en_US' },
        },
        path.join(parent, 'report'),
      );
      expect(result.evidence).to.deep.include({
        exactVariantAbsent: true,
        parentBehavior: 'not-found',
        selectedInventoryMatches: 0,
      });
      expect(result.evidence).not.to.have.property('parentIdentityPreserved');
      expect(mutation.calledOnce).to.equal(true);
    } finally {
      mutation.restore();
      await rm(parent, { recursive: true, force: true });
    }
  });

  for (const invalid of [
    { label: 'generic parent 404', errorCode: undefined, errorEntryCount: 0 },
    { label: 'wrong parent error code', errorCode: 'VARIANT_NOT_FOUND', errorEntryCount: 1 },
    { label: 'multiple parent error entries', errorCode: 'NOT_FOUND', errorEntryCount: 2 },
    { label: 'parent NOT_FOUND without HTTP status', errorCode: 'NOT_FOUND', errorEntryCount: 1 },
  ]) {
    it(`keeps ${invalid.label} ownership-uncertain`, async () => {
      const parent = await mkdtemp(path.join(tmpdir(), 'sf-cms-delete-parent-invalid-'));
      const current = fixture();
      const mutation = sinon.stub(JsforceConnection.prototype, 'request').callsFake(() => {
        current.deleteVariant();
        if (invalid.errorCode === undefined)
          current.failParent(Object.assign(new Error('not found'), { response: { status: 404 } }));
        else if (invalid.label === 'parent NOT_FOUND without HTTP status')
          current.failParent(
            Object.assign(new Error('parent not found'), {
              data: [{ errorCode: 'NOT_FOUND', message: 'Parent not found' }],
            }),
          );
        else current.removeParent(invalid.errorCode, invalid.errorEntryCount);
        return fakeRequest();
      });
      try {
        const failure = await captureFailure(
          applyDraftEmailDeleteWithReport(
            current.connection,
            {
              orgId: '00Dorg',
              ownershipReport: await ownershipFile(parent),
              selector: { workspaceId: 'space', apiName: 'pilot_email', language: 'en_US' },
            },
            path.join(parent, 'report'),
          ),
        );
        expect(failure).to.be.instanceOf(EmailDeleteOutcomeUnknownError);
        expect((failure as EmailDeleteOutcomeUnknownError).mutationError.classification).to.equal(
          'ownership-uncertain',
        );
        expect(mutation.calledOnce).to.equal(true);
      } finally {
        mutation.restore();
        await rm(parent, { recursive: true, force: true });
      }
    });
  }

  it('keeps a parent transport failure ownership-uncertain', async () => {
    const parent = await mkdtemp(path.join(tmpdir(), 'sf-cms-delete-parent-transport-'));
    const current = fixture();
    const mutation = sinon.stub(JsforceConnection.prototype, 'request').callsFake(() => {
      current.deleteVariant();
      current.failParent(new Error('timeout'));
      return fakeRequest();
    });
    try {
      const failure = await captureFailure(
        applyDraftEmailDeleteWithReport(
          current.connection,
          {
            orgId: '00Dorg',
            ownershipReport: await ownershipFile(parent),
            selector: { workspaceId: 'space', apiName: 'pilot_email', language: 'en_US' },
          },
          path.join(parent, 'report'),
        ),
      );
      expect(failure).to.be.instanceOf(EmailDeleteOutcomeUnknownError);
      expect((failure as EmailDeleteOutcomeUnknownError).mutationError.classification).to.equal(
        'ownership-uncertain',
      );
      expect(mutation.calledOnce).to.equal(true);
    } finally {
      mutation.restore();
      await rm(parent, { recursive: true, force: true });
    }
  });

  it('blocks a changed semantic body before DELETE', async () => {
    const parent = await mkdtemp(path.join(tmpdir(), 'sf-cms-delete-drift-'));
    const current = fixture();
    current.variants['variant-en'].contentBody = { rawHtml: '&lt;p&gt;Changed&lt;/p&gt;' };
    try {
      const result = await previewDraftEmailDelete(current.connection, {
        orgId: '00Dorg',
        ownershipReport: await ownershipFile(parent),
        selector: { workspaceId: 'space', apiName: 'pilot_email', language: 'en_US' },
      });
      expect(result.status).to.equal('blocked');
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it('keeps a generic post-delete 404 ownership-uncertain', async () => {
    const parent = await mkdtemp(path.join(tmpdir(), 'sf-cms-delete-generic-404-'));
    const current = fixture();
    current.request.callsFake(({ url }: { url: string }) => {
      if (url === '/connect/cms/spaces/space')
        return fakeRequest({ id: 'space', defaultLanguage: 'en_US' });
      if (url.startsWith('/connect/cms/items/search')) {
        const ids = Object.keys(current.variants);
        return fakeRequest({
          items: ids.map((id) => ({
            id,
            managedContentSpaceId: 'space',
            contentType: { developerName: 'sfdc_cms__email' },
            type: 'ManagedContentVariantSearchResultRepresentation',
          })),
          total: ids.length,
        });
      }
      if (url === '/connect/cms/contents/parent-email')
        return fakeRequest({
          managedContentId: 'parent-email',
          contentType: { fullyQualifiedName: 'sfdc_cms__email' },
          contentSpace: { id: 'space' },
        });
      if (url.includes('/connect/cms/contents/variants/')) {
        const id = url.split('/').at(-1)!;
        if (current.variants[id] !== undefined) return fakeRequest(current.variants[id]);
        return Object.assign(
          Promise.reject(
            Object.assign(new Error('generic not found'), {
              data: [{ errorCode: 'NOT_FOUND', message: 'Not found' }],
              response: { status: 404 },
            }),
          ),
          { stream: () => new PassThrough() },
        );
      }
      throw new Error(`Unexpected request ${url}`);
    });
    const mutation = sinon.stub(JsforceConnection.prototype, 'request').callsFake(() => {
      current.deleteVariant();
      return fakeRequest();
    });
    try {
      const failure = await captureFailure(
        applyDraftEmailDeleteWithReport(
          current.connection,
          {
            orgId: '00Dorg',
            ownershipReport: await ownershipFile(parent),
            selector: { workspaceId: 'space', apiName: 'pilot_email', language: 'en_US' },
          },
          path.join(parent, 'report'),
        ),
      );
      expect(failure).to.be.instanceOf(EmailDeleteOutcomeUnknownError);
      expect((failure as EmailDeleteOutcomeUnknownError).mutationError.classification).to.equal(
        'ownership-uncertain',
      );
      expect(mutation.calledOnce).to.equal(true);
    } finally {
      mutation.restore();
      await rm(parent, { recursive: true, force: true });
    }
  });

  it('classifies an explicit 403 response as rejected before mutation', async () => {
    const parent = await mkdtemp(path.join(tmpdir(), 'sf-cms-delete-rejected-'));
    const current = fixture();
    const mutation = sinon.stub(JsforceConnection.prototype, 'request').returns(
      Object.assign(
        Promise.reject(
          Object.assign(new Error('forbidden'), {
            data: [{ errorCode: 'INSUFFICIENT_ACCESS', message: 'Forbidden' }],
            response: { status: 403 },
          }),
        ),
        { stream: () => new PassThrough() },
      ),
    );
    try {
      const failure = await captureFailure(
        applyDraftEmailDeleteWithReport(
          current.connection,
          {
            orgId: '00Dorg',
            ownershipReport: await ownershipFile(parent),
            selector: { workspaceId: 'space', apiName: 'pilot_email', language: 'en_US' },
          },
          path.join(parent, 'report'),
        ),
      );
      expect(failure).to.be.instanceOf(EmailDeleteOutcomeUnknownError);
      expect((failure as EmailDeleteOutcomeUnknownError).mutationError.classification).to.equal(
        'definite-pre-mutation-rejection',
      );
      expect(mutation.calledOnce).to.equal(true);
    } finally {
      mutation.restore();
      await rm(parent, { recursive: true, force: true });
    }
  });

  it('never retries an ambiguous DELETE', async () => {
    const parent = await mkdtemp(path.join(tmpdir(), 'sf-cms-delete-uncertain-'));
    const current = fixture();
    const mutation = sinon
      .stub(JsforceConnection.prototype, 'request')
      .returns(
        Object.assign(Promise.reject(new Error('timeout')), { stream: () => new PassThrough() }),
      );
    try {
      const failure = await captureFailure(
        applyDraftEmailDeleteWithReport(
          current.connection,
          {
            orgId: '00Dorg',
            ownershipReport: await ownershipFile(parent),
            selector: { workspaceId: 'space', apiName: 'pilot_email', language: 'en_US' },
          },
          path.join(parent, 'report'),
        ),
      );
      expect(failure).to.be.instanceOf(EmailDeleteOutcomeUnknownError);
      expect((failure as EmailDeleteOutcomeUnknownError).mutationError.classification).to.equal(
        'ownership-uncertain',
      );
      expect(mutation.calledOnce).to.equal(true);
    } finally {
      mutation.restore();
      await rm(parent, { recursive: true, force: true });
    }
  });
});
