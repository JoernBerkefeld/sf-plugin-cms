import { expect } from 'chai';
import { PassThrough } from 'node:stream';
import sinon from 'sinon';
import { brandDetail } from '../fixtures/brand.js';
import { reassembleEditableItemSourceV2 } from '../../src/services/editable-item-source-v2.js';
import { NativeInventoryRequestError } from '../../src/services/retrieve-native-inventory.js';
import type { ResolveNativeRetrieveInput } from '../../src/services/retrieve-native-resolution.js';
import {
  acquireEditableBrandSource,
  acquireEditableEmailSource,
  acquireEditableTemplateSource,
  prepareEditableSourceSelection,
  type AcquireEditableEmailSourceInput,
} from '../../src/services/retrieve-item-source.js';

type RecordValue = Record<string, unknown>;
function email(id = '9Ps000000000001AAA', language = 'en_US', apiName = 'Welcome'): RecordValue {
  if (!id.startsWith('9Ps'))
    id = `9Ps${String(['other', 'duplicate', 'translated', 'renamed'].indexOf(id) + 2).padStart(12, '0')}AAA`;
  return {
    managedContentVariantId: id,
    managedContentId: '20Y000000000001AAA',
    contentKey: 'key-source',
    contentSpace: { id: '0Zu000000000001AAA' },
    apiName,
    contentType: { fullyQualifiedName: 'sfdc_cms__email' },
    language,
    status: { status: 'Draft', label: 'Draft' },
    isPublished: false,
    title: 'Welcome',
    folder: null,
    contentBody: {
      'sfdc_cms:title': 'Welcome',
      subjectLine: 'Hello',
      messagePurpose: 'Transactional',
      rawHtml: '&lt;p&gt;Café &amp;amp; 世界&lt;/p&gt;',
      textContent: 'Plain café & 世界\r\n',
      'lightning:expressions': [],
      'sfdc_cms:variants': [],
    },
  };
}
function unchangedRows(rows: RecordValue[]): RecordValue[] {
  return rows;
}
function fixture(template = false, brand = false) {
  let contentType = template ? 'sfdc_cms__emailTemplate' : 'sfdc_cms__email';
  if (brand) contentType = 'sfdc_cms__brand';
  const workspace: RecordValue = {
    id: '0Zu000000000001AAA',
    name: 'Content Workspace for Marketing Cloud',
    apiName: 'Default_Content_Workspace',
    defaultLanguage: 'en_US',
    rootFolderId: 'root-folder-source',
  };
  const parent: RecordValue = {
    managedContentId: '20Y000000000001AAA',
    contentType: { fullyQualifiedName: contentType },
    contentSpace: { id: '0Zu000000000001AAA' },
    folder: null,
  };
  const parents = [parent];
  const variants = [email()];
  if (template) {
    variants[0].contentType = { fullyQualifiedName: contentType };
    delete (variants[0].contentBody as RecordValue).subjectLine;
  }
  if (brand) {
    Object.assign(
      variants[0],
      brandDetail('9Ps000000000001AAA', 'Welcome', selection.workspaceId),
      {
        managedContentId: '20Y000000000001AAA',
        folder: null,
      },
    );
    Object.assign(parent, structuredClone(variants[0]), {
      contentVersion: 1,
      variantVersion: '1.1',
    });
  }
  let nativePatch: (rows: RecordValue[], siblingScope: boolean) => RecordValue[] = unchangedRows;
  const nativeRows = () =>
    variants.map((detail) => ({
      Id: detail.managedContentVariantId,
      ManagedContentId: detail.managedContentId,
      ContentTypeFullyQualifiedName:
        (detail.contentType as RecordValue)?.fullyQualifiedName ?? detail.contentType,
      Language: detail.language,
      IsPublished: detail.isPublished,
      ManagedContentVariantStatus: (detail.status as RecordValue)?.status,
      IsPrimary: true,
      Name: detail.title,
      UrlName: detail.urlName ?? null,
      ManagedContentKey: detail.contentKey,
      ManagedContent: {
        AuthoredManagedContentSpaceId: '0Zu000000000001AAA',
        ApiName: detail.apiName,
      },
    }));
  const request = sinon.stub().callsFake((input: { url: string; method: string }) => {
    expect(input.method).to.equal('GET');
    const url = new URL(input.url, 'https://example.invalid');
    let value: unknown;
    if (url.pathname === '/connect/cms/spaces/0Zu000000000001AAA') value = workspace;
    else if (url.pathname === '/services/data/v67.0/query') {
      const soql = url.searchParams.get('q')!;
      const parentId = /ManagedContentId = '([^']+)'/u.exec(soql)?.[1];
      const rows = nativePatch(
        nativeRows().filter((row) =>
          parentId
            ? row.ManagedContentId === parentId
            : row.ContentTypeFullyQualifiedName === contentType,
        ),
        parentId !== undefined,
      ).toSorted((a, b) => String(a.Id).localeCompare(String(b.Id)));
      let records: RecordValue[];
      if (soql.includes('COUNT(Id)')) {
        const counts = new Map<unknown, number>();
        for (const row of rows)
          counts.set(row.ManagedContentId, (counts.get(row.ManagedContentId) ?? 0) + 1);
        records = [...counts].map(([ManagedContentId, siblingCount]) => ({
          ManagedContentId,
          siblingCount,
        }));
      } else {
        const after = /Id > '([^']+)'/u.exec(soql)?.[1];
        records = rows
          .filter((row) => after === undefined || String(row.Id) > after)
          .slice(0, 2000);
      }
      value = { totalSize: records.length, done: true, records };
    } else if (url.pathname.startsWith('/connect/cms/contents/variants/')) {
      value = variants.find(
        (raw) => raw.managedContentVariantId === url.pathname.split('/').at(-1),
      );
    } else if (url.pathname.startsWith('/connect/cms/contents/'))
      value = parents.find((item) => item.managedContentId === url.pathname.split('/').at(-1));
    else throw new Error(`Unexpected request: ${input.url}`);
    return Object.assign(Promise.resolve(structuredClone(value)), {
      stream: () => new PassThrough(),
    });
  });
  return {
    workspace,
    parent,
    parents,
    variants,
    connection: { request, version: '67.0' },
    patchNative(patch: typeof nativePatch) {
      nativePatch = patch;
    },
  };
}
// Shape recorded in independent-readback-1792035980826.json (2026-10-15T03:46:20.826Z).
// Synthetic identities keep the regression independent of the live org.
function recordedReadEnvelopes(template = false) {
  const current = fixture(template);
  Object.assign(current.variants[0], {
    contentFqn: 'marketing--Default_Content_Workspace.sfdc_cms__email--Welcome',
    createdBy: { id: 'user-source', resourceUrl: '/chatter/users/user-source' },
    createdDate: '2026-10-15T03:08:54.000Z',
    lastModifiedBy: { id: 'user-source', resourceUrl: '/chatter/users/user-source' },
    lastModifiedDate: '2026-10-15T03:08:54.000Z',
    managedContentVersionId: 'version-source',
    externalId: null,
    folder: { id: 'root-folder-source', resourceUrl: '/cms/folders/root-folder-source' },
    isPublished: false,
    status: { label: 'Draft', status: 'Draft' },
    urlName: 'welcome',
    contentBody: {
      'lightning:backgroundImage': {
        position: 'center center',
        repeat: 'no-repeat',
        size: 'cover',
      },
      'lightning:brandSource': { defaultBrandOption: 'sfdcBrand' },
      'lightning:dataProviders': [],
      'lightning:expressions': [],
      messagePurpose: 'promotional',
      rawHtml: '&lt;p&gt;Owned inert acceptance&lt;/p&gt;',
      'sfdc_cms:attachments': [],
      'sfdc_cms:title': 'Welcome',
      'sfdc_cms:urlName': 'welcome',
      'sfdc_cms:variants': [],
      subjectLine: 'Inert acceptance',
    },
  });
  if (template) {
    delete (current.variants[0].contentBody as RecordValue).subjectLine;
    delete (current.variants[0].contentBody as RecordValue)['lightning:brandSource'];
    delete (current.variants[0].contentBody as RecordValue)['sfdc_cms:urlName'];
  }
  Object.assign(current.parent, structuredClone(current.variants[0]), {
    contentType: {
      fullyQualifiedName: template ? 'sfdc_cms__emailTemplate' : 'sfdc_cms__email',
      name: template ? 'Email Template' : 'Email',
    },
    contentVersion: 1,
    variantVersion: '1.1',
    createdBy: {
      id: 'user-source',
      name: 'Test author',
      resourceUrl: '/chatter/users/user-source',
    },
    lastModifiedBy: {
      id: 'user-source',
      name: 'Test author',
      resourceUrl: '/chatter/users/user-source',
    },
  });
  return current;
}
const selection = {
  workspaceId: '0Zu000000000001AAA',
  apiName: 'Welcome',
  useDefaultLanguage: true,
} as const;
async function fails(current: ReturnType<typeof fixture>, message: string, input = selection) {
  try {
    await acquireEditableEmailSource(current.connection, input);
    expect.fail('Expected acquisition to fail');
  } catch (error) {
    expect(error).to.be.instanceOf(TypeError);
    expect((error as Error).message).to.include(message);
  }
}

async function rejects(
  current: ReturnType<typeof fixture>,
  message = '',
  input: AcquireEditableEmailSourceInput = selection,
) {
  try {
    await acquireEditableTemplateSource(current.connection, input);
    expect.fail('Expected Template acquisition rejection');
  } catch (error) {
    expect(error).to.be.instanceOf(TypeError);
    expect((error as Error).message).to.include(message);
  }
}

function nativeSelection(apiNames = ['Welcome']): ResolveNativeRetrieveInput {
  return {
    workspaceId: selection.workspaceId,
    language: 'en_US',
    selection: {
      mode: 'api-name' as const,
      groups: [
        { contentType: 'sfdc_cms__email' as const, all: false, apiNames, contentKeysOrIds: [] },
      ],
    },
  };
}

async function acquisitionRejects(action: () => Promise<unknown>, message: string) {
  try {
    await action();
    expect.fail('Expected guarded acquisition rejection');
  } catch (error) {
    expect(error).to.be.instanceOf(TypeError);
    expect((error as Error).message).to.include(message);
  }
}

describe('internal native Brand acquisition', () => {
  it('projects strict original inline Brand bytes without mutating or retaining source evidence', async () => {
    const current = fixture(false, true);
    const before = JSON.stringify([current.workspace, current.parent, current.variants]);
    const input: AcquireEditableEmailSourceInput = { ...selection };
    const pending = acquireEditableBrandSource(current.connection, input);
    Object.assign(input, { apiName: 'Changed', workspaceId: 'wrong' });
    const result = await pending;
    expect(result.directory).to.equal('cms/Default_Content_Workspace/brand');
    expect(result.projection.definitionName).to.equal('Welcome.cms-brand.json');
    expect(result.projection.definition.contractVersion).to.equal('1.0.0');
    expect(result.projection.definition.contentBody).to.deep.equal(current.variants[0].contentBody);
    expect(result.projection.companions).to.deep.equal([]);
    expect(result.projection.definitionBytes.toString()).not.to.match(
      /20Y000|9Ps000|0Zu000|content-key|managedContent|createdDate/u,
    );
    expect(JSON.stringify([current.workspace, current.parent, current.variants])).to.equal(before);
    const repeated = await acquireEditableBrandSource(current.connection, selection);
    expect(repeated).to.deep.equal(result);
    result.projection.definition.contentBody['sfdc_cms:title'] = 'Edited';
    result.projection.definitionBytes.fill(0);
    expect(await acquireEditableBrandSource(current.connection, selection)).to.deep.equal(repeated);
    expect(
      current.connection.request.args.every(
        ([request]) => request.method === 'GET' && !request.url.includes('/search'),
      ),
    ).to.equal(true);
  });

  it('requires default language and exact case while retaining complete hidden siblings', async () => {
    for (const kind of ['language', 'case', 'missing-default', 'sibling', 'different-type']) {
      const current = fixture(false, true);
      if (kind === 'missing-default') delete current.workspace.defaultLanguage;
      if (kind === 'case') current.variants[0].apiName = 'welcome';
      if (kind === 'sibling' || kind === 'different-type') {
        const sibling = {
          ...structuredClone(current.variants[0]),
          managedContentVariantId: '9Ps000000000002AAA',
          language: 'de_DE',
        };
        if (kind === 'different-type')
          sibling.contentType = { fullyQualifiedName: 'sfdc_cms__email' };
        current.variants.push(sibling);
      }
      await acquisitionRejects(
        () =>
          acquireEditableBrandSource(
            current.connection,
            kind === 'language'
              ? { workspaceId: selection.workspaceId, apiName: 'Welcome', language: 'de_DE' }
              : selection,
          ),
        '',
      );
    }
  });

  it('binds native identity, status, title, URL and primary evidence before projection', async () => {
    for (const patch of [
      { Name: 'Drift' },
      { UrlName: 'drift' },
      { IsPrimary: false },
      { ManagedContentKey: 'drift' },
      { ManagedContentVariantStatus: 'Published' },
      { IsPublished: true },
      { ManagedContentId: '20Y000000000002AAA' },
      {
        ManagedContent: { AuthoredManagedContentSpaceId: selection.workspaceId, ApiName: 'Other' },
      },
    ]) {
      const current = fixture(false, true);
      current.patchNative((rows) => rows.map((row) => ({ ...row, ...patch })));
      await acquisitionRejects(() => acquireEditableBrandSource(current.connection, selection), '');
    }
    const current = fixture(false, true);
    current.patchNative((rows, siblings) => rows.map((row) => ({ ...row, IsPrimary: !siblings })));
    await acquisitionRejects(
      () => acquireEditableBrandSource(current.connection, selection),
      'single exact native sibling',
    );
  });

  it('fails closed on original parent/body/provider/reference or placement drift', async () => {
    for (const side of ['parent', 'variant', 'both'])
      for (const kind of [
        'unknown',
        'body',
        'provider',
        'reference',
        'external',
        'folder',
        'published',
        'version',
      ]) {
        const current = fixture(false, true);
        for (const target of side === 'both'
          ? [current.parent, current.variants[0]]
          : [side === 'parent' ? current.parent : current.variants[0]]) {
          const body = target.contentBody as RecordValue;
          if (kind === 'unknown') target.source = 'External';
          if (kind === 'body') body.unknown = {};
          if (kind === 'provider') body['lightning:dataProviders'] = [{ id: 'provider' }];
          if (kind === 'reference') body['sfdc_cms:variants'] = [{ contentKey: 'reference' }];
          if (kind === 'external') target.externalId = 'external';
          if (kind === 'folder') target.folder = { id: 'nested' };
          if (kind === 'published') target.isPublished = true;
          if (kind === 'version') current.parent.managedContentVariantId = '9Ps000000000003AAA';
        }
        await acquisitionRejects(
          () => acquireEditableBrandSource(current.connection, selection),
          '',
        );
      }
  });

  it('keeps prepared public acquisition runtime-closed even for a forged Brand selector', async () => {
    const current = fixture(false, true);
    const input = nativeSelection();
    Object.assign(input.selection.groups[0], { contentType: 'sfdc_cms__brand' });
    const prepared = await prepareEditableSourceSelection(current.connection, input);
    await acquisitionRejects(
      () => prepared.acquire(prepared.resolution.variants[0].Id),
      'Unsupported prepared',
    );
  });
});

describe('guarded native selection acquisition', () => {
  for (const published of [true, false])
    it(`preserves every portable Template byte across ${published ? 'publish' : 'unpublish'}`, async () => {
      const current = recordedReadEnvelopes(true);
      const input: ResolveNativeRetrieveInput = {
        workspaceId: selection.workspaceId,
        language: 'en_US',
        selection: {
          mode: 'api-name',
          groups: [
            {
              contentType: 'sfdc_cms__emailTemplate',
              all: false,
              apiNames: ['Welcome'],
              contentKeysOrIds: [],
            },
          ],
        },
      };
      const acquire = async () => {
        const prepared = await prepareEditableSourceSelection(current.connection, input);
        return prepared.acquire(current.variants[0].managedContentVariantId as string);
      };
      const phase = (value: boolean) => {
        for (const detail of [current.parent, current.variants[0]]) {
          detail.isPublished = value;
          detail.status = {
            label: value ? 'Published' : 'Draft',
            status: value ? 'Published' : 'Draft',
          };
        }
      };
      phase(!published);
      const before = await acquire();
      phase(published);
      const after = await acquire();
      expect(after).to.deep.equal(before);
      expect(after.projection.definitionBytes).to.deep.equal(before.projection.definitionBytes);
      expect(after.projection.companions).to.deep.equal(before.projection.companions);
    });

  it('resolves once for multiple parents and independently proves each sibling scope', async () => {
    const current = fixture();
    current.variants.push({
      ...email('other', 'en_US', 'Second'),
      managedContentId: '20Y000000000002AAA',
      contentKey: 'key-second',
    });
    current.parents.push({
      ...structuredClone(current.parent),
      managedContentId: '20Y000000000002AAA',
    });
    const prepared = await prepareEditableSourceSelection(
      current.connection,
      nativeSelection(['Welcome', 'Second']),
    );
    expect(prepared.resolution.unresolved).to.deep.equal([]);
    expect(prepared.resolution.variants).to.have.length(2);
    const acquired = [];
    for (const row of prepared.resolution.variants) acquired.push(await prepared.acquire(row.Id));
    expect(acquired.map((item) => item.projection.definitionName)).to.deep.equal([
      'Welcome.cms-email.json',
      'Second.cms-email.json',
    ]);
    const urls = current.connection.request.args.map(([request]) =>
      decodeURIComponent(request.url as string),
    );
    expect(urls.filter((url) => url.includes('ContentTypeFullyQualifiedName IN'))).to.have.length(
      6,
    );
    expect(urls.filter((url) => url.includes('ManagedContentId ='))).to.have.length(12);
    expect(urls.filter((url) => url.includes('/variants/'))).to.have.length(4);
  });

  it('never trusts mutated resolution inventory, input or selected row proof', async () => {
    const current = fixture();
    const input = nativeSelection();
    const prepared = await prepareEditableSourceSelection(current.connection, input);
    const id = prepared.resolution.variants[0].Id;
    input.workspaceId = 'wrong';
    input.language = 'de_DE';
    prepared.resolution.workspaceId = 'wrong';
    prepared.resolution.variants[0].ManagedContentId = '20Y000000000002AAA';
    prepared.resolution.variants[0].ManagedContent.ApiName = 'Forged';
    prepared.resolution.variants.push({
      ...prepared.resolution.variants[0],
      Id: '9Ps000000000002AAA',
    });
    const before = current.connection.request.callCount;
    await acquisitionRejects(() => prepared.acquire('9Ps000000000002AAA'), 'not in the resolved');
    expect(current.connection.request.callCount).to.equal(before);
    const acquired = await prepared.acquire(id);
    expect(acquired.projection.definitionName).to.equal('Welcome.cms-email.json');
  });

  it('retains missing and ambiguous selectors instead of claiming complete selection success', async () => {
    const current = fixture();
    const prepared = await prepareEditableSourceSelection(
      current.connection,
      nativeSelection(['Welcome', 'Missing']),
    );
    expect(prepared.resolution.unresolved).to.deep.include({
      contentType: 'sfdc_cms__email',
      kind: 'api-name',
      selector: 'Missing',
      reason: 'missing',
      parentIds: [],
    });
    const acquired = await prepared.acquire(prepared.resolution.variants[0].Id);
    expect(acquired.evidence.contentId).to.equal('20Y000000000001AAA');
    current.variants.push({ ...email('other'), managedContentId: '20Y000000000002AAA' });
    const ambiguous = await prepareEditableSourceSelection(current.connection, nativeSelection());
    expect(ambiguous.resolution.variants).to.deep.equal([]);
    expect(ambiguous.resolution.unresolved[0].reason).to.equal('ambiguous');
  });

  it('preserves sanitized native request errors for fatal classification', async () => {
    const current = fixture();
    current.connection.request.callsFake((request: { url: string }) => {
      if (!request.url.includes('/query'))
        return Object.assign(Promise.resolve(structuredClone(current.workspace)), {
          stream: () => new PassThrough(),
        });
      return Object.assign(
        Promise.reject({
          statusCode: 403,
          data: [{ errorCode: 'INSUFFICIENT_ACCESS', message: 'Not allowed' }],
        }),
        { stream: () => new PassThrough() },
      );
    });
    try {
      await prepareEditableSourceSelection(current.connection, nativeSelection());
      expect.fail('Expected native request failure');
    } catch (error) {
      expect(error).to.be.instanceOf(NativeInventoryRequestError);
      const nativeError = error as NativeInventoryRequestError;
      expect(nativeError.status).to.equal(403);
      expect(nativeError.statusObserved).to.equal(true);
      expect(nativeError.errorCode).to.equal('INSUFFICIENT_ACCESS');
      expect(nativeError.errorEntryCount).to.equal(1);
      expect(nativeError).not.to.have.property('response');
    }
  });

  it('rejects detail drift and independent sibling proof mismatch after resolution', async () => {
    for (const siblingDrift of [false, true]) {
      const current = fixture();
      const prepared = await prepareEditableSourceSelection(current.connection, nativeSelection());
      if (siblingDrift)
        current.patchNative((rows) => rows.map((row) => ({ ...row, IsPrimary: false })));
      else current.variants[0].contentKey = 'changed';
      await acquisitionRejects(
        () => prepared.acquire(prepared.resolution.variants[0].Id),
        siblingDrift ? 'single exact native sibling' : 'disagreement',
      );
    }
  });

  it('keeps root, paired User provenance and strict projection checks for both types', async () => {
    for (const template of [false, true]) {
      for (const invalid of ['folder', 'source', 'body', 'hidden-sibling', 'none']) {
        const current = recordedReadEnvelopes(template);
        current.variants[0].source = 'User';
        current.parent.source = 'User';
        const input = nativeSelection();
        if (template)
          Object.assign(input.selection.groups[0], { contentType: 'sfdc_cms__emailTemplate' });
        const prepared = await prepareEditableSourceSelection(current.connection, input);
        if (invalid === 'folder') current.parent.folder = { id: 'nested' };
        if (invalid === 'source') current.parent.source = 'External';
        if (invalid === 'body') (current.variants[0].contentBody as RecordValue).unknown = {};
        if (invalid === 'hidden-sibling') current.variants.push(email('translated', 'de_DE'));
        const acquire = prepared.acquire.bind(undefined, prepared.resolution.variants[0].Id);
        if (invalid === 'none') {
          const acquired = await acquire();
          expect(acquired.projection.definition.identity.type).to.equal(
            template ? 'Email Template' : 'Email',
          );
        } else await acquisitionRejects(acquire, '');
      }
    }
  });
});

describe('recorded native User source provenance', () => {
  for (const template of [false, true]) {
    const acquire = template ? acquireEditableTemplateSource : acquireEditableEmailSource;
    const family = template ? 'Template' : 'Email';
    it(`normalizes paired User GET provenance for ${family} without losing content or identity`, async () => {
      const current = recordedReadEnvelopes(template);
      current.variants[0].source = 'User';
      current.parent.source = 'User';
      const before = JSON.stringify([current.parent, current.variants]);
      const result = await acquire(current.connection, selection);
      expect(result.evidence).to.deep.equal({
        variantId: '9Ps000000000001AAA',
        contentId: '20Y000000000001AAA',
      });
      expect(result.projection.definition.identity.type).to.equal(
        template ? 'Email Template' : 'Email',
      );
      expect(
        reassembleEditableItemSourceV2(
          result.projection.definition,
          new Map(result.projection.companions.map(({ path, bytes }) => [path, bytes])),
        ),
      ).to.deep.equal({
        ...(current.variants[0].contentBody as RecordValue),
        rawHtml: '<p>Owned inert acceptance</p>',
      });
      expect(result.projection.definition).not.to.have.property('source');
      expect(result.projection.definitionBytes.toString()).not.to.include('key-source');
      expect(JSON.stringify([current.parent, current.variants])).to.equal(before);
      expect(await acquire(current.connection, selection)).to.deep.equal(result);
    });

    it(`rejects unknown, invalid, one-sided and disagreeing ${family} provenance`, async () => {
      for (const [variant, parent] of [
        ['User', undefined],
        [undefined, 'User'],
        ['User', 'External'],
        ['External', 'User'],
        ['External', 'External'],
        [null, null],
        [{ type: 'User' }, { type: 'User' }],
        ['', ''],
      ]) {
        const current = recordedReadEnvelopes(template);
        if (variant !== undefined) current.variants[0].source = variant;
        if (parent !== undefined) current.parent.source = parent;
        try {
          await acquire(current.connection, selection);
          expect.fail('Expected unsupported source provenance rejection');
        } catch (error) {
          expect(error).to.be.instanceOf(TypeError);
          expect((error as Error).message).to.include('source provenance');
        }
      }
    });
  }
});

describe('read-only editable Template acquisition', () => {
  it('projects portable v2 Template companions with exact workspace and language', async () => {
    const current = fixture(true);
    const before = JSON.stringify([current.parent, current.variants]);
    const result = await acquireEditableTemplateSource(current.connection, selection);
    expect(result.directory).to.equal('cms/Default_Content_Workspace/emailTemplate');
    expect(result.projection.definitionName).to.equal('Welcome.cms-email-template.json');
    expect(result.projection.definition.identity.type).to.equal('Email Template');
    expect(result.projection.definition.language).to.equal('en_US');
    expect(result.projection.definitionBytes.toString()).not.to.match(
      /20Y000000000001AAA|9Ps000000000001AAA|0Zu000000000001AAA|key-source/u,
    );
    expect(
      reassembleEditableItemSourceV2(
        result.projection.definition,
        new Map(result.projection.companions.map(({ path, bytes }) => [path, bytes])),
      ),
    ).to.deep.equal({
      ...(current.variants[0].contentBody as RecordValue),
      rawHtml: '<p>Café &amp; 世界</p>',
    });
    expect(JSON.stringify([current.parent, current.variants])).to.equal(before);
    current.variants[0].language = 'de_DE';
    delete current.workspace.defaultLanguage;
    const explicit = await acquireEditableTemplateSource(current.connection, {
      workspaceId: selection.workspaceId,
      apiName: selection.apiName,
      language: 'de_DE',
    });
    expect(explicit.projection.definition.language).to.equal('de_DE');
  });

  it('admits a native Template absent from search without any search request', async () => {
    const current = fixture(true);
    const acquired = await acquireEditableTemplateSource(current.connection, selection);
    expect(acquired.evidence.variantId).to.equal('9Ps000000000001AAA');
    const urls = current.connection.request.args.map(([request]) => request.url as string);
    expect(urls.some((url) => url.includes('/items/search'))).to.equal(false);
    expect(urls.filter((url) => url.includes('/variants/'))).to.have.length(2);
  });

  it('rejects native/detail metadata and workspace drift', async () => {
    for (const patch of [
      { ManagedContentId: '20Y000000000002AAA' },
      { Language: 'de_DE' },
      { ManagedContentVariantStatus: 'Published' },
      { ManagedContentKey: 'other-key' },
      {
        ManagedContent: { AuthoredManagedContentSpaceId: '0Zu000000000002AAA', ApiName: 'Welcome' },
      },
      {
        ManagedContent: { AuthoredManagedContentSpaceId: selection.workspaceId, ApiName: 'Other' },
      },
    ]) {
      const current = fixture(true);
      current.patchNative((rows) => rows.map((row) => ({ ...row, ...patch })));
      await rejects(current, 'disagreement');
    }
  });

  it('requires exact case/language, one match, root ancestry and unchanged detail identity', async () => {
    for (const patch of [
      { apiName: 'welcome' },
      { language: 'fr_FR' },
      { contentSpace: { id: 'wrong' } },
      { contentType: 'sfdc_cms__email' },
      { id: 'conflict' },
      { folder: { id: 'nested' } },
    ]) {
      const current = fixture(true);
      Object.assign(current.variants[0], patch);
      await rejects(current);
    }
    const ambiguous = fixture(true);
    ambiguous.variants.push({
      ...structuredClone(ambiguous.variants[0]),
      managedContentVariantId: '9Ps000000000002AAA',
    });
    await rejects(ambiguous, 'exactly one');
  });

  it('preserves known GET distinctions but rejects unknown authoring and parent disagreements', async () => {
    const current = fixture(true);
    Object.assign(current.variants[0], {
      managedContentVersionId: 'version',
      externalId: null,
      createdDate: '2026-10-15T00:00:00Z',
    });
    Object.assign(current.parent, structuredClone(current.variants[0]), {
      contentVersion: 1,
      variantVersion: '1.1',
    });
    await acquireEditableTemplateSource(current.connection, selection);
    for (const [key, value] of [
      ['managedContentId', 'wrong'],
      ['managedContentVariantId', 'wrong'],
      ['managedContentVersionId', 'wrong'],
      ['language', 'de_DE'],
      ['contentBody', {}],
      ['contentSpace', { id: 'wrong' }],
      ['contentType', 'sfdc_cms__email'],
      ['unknownField', {}],
    ] as const) {
      const saved = structuredClone(current.parent);
      current.parent[key] = value;
      await rejects(current);
      for (const field of Object.keys(current.parent)) {
        delete current.parent[field];
      }
      Object.assign(current.parent, saved);
    }
    for (const side of [current.parent, current.variants[0]]) {
      side.unknownField = {};
      await rejects(current);
      delete side.unknownField;
    }
    for (const side of [current.parent, current.variants[0]])
      (side.contentBody as RecordValue)['lightning:unknownComponent'] = {};
    await rejects(current, 'Unsupported native body field');
  });
});

describe('read-only editable Email acquisition', () => {
  it('acquires default-language v2 HTML/text with detached IDs and no publication', async () => {
    const current = fixture();
    const before = JSON.stringify([current.workspace, current.parent, current.variants]);
    const result = await acquireEditableEmailSource(current.connection, selection);
    expect(result.directory).to.equal('cms/Default_Content_Workspace/email');
    expect(result.projection.definition.identity.context.workspaceApiName).to.equal(
      'Default_Content_Workspace',
    );
    expect(result.evidence).to.deep.equal({
      variantId: '9Ps000000000001AAA',
      contentId: '20Y000000000001AAA',
    });
    const { projection } = result;
    expect(projection.definitionName).to.equal('Welcome.cms-email.json');
    expect(projection.definition.folderPath).to.deep.equal([]);
    expect(projection.companions.map(({ path }) => path)).to.deep.equal([
      'Welcome.cms-email.html',
      'Welcome.cms-email.txt',
    ]);
    expect(projection.companions[0].bytes.toString()).to.equal('<p>Café &amp; 世界</p>');
    const body = reassembleEditableItemSourceV2(
      projection.definition,
      new Map(projection.companions.map(({ path, bytes }) => [path, bytes])),
    );
    expect(body).to.deep.equal({
      ...(current.variants[0].contentBody as RecordValue),
      rawHtml: '<p>Café &amp; 世界</p>',
    });
    expect(projection.definitionBytes.toString()).not.to.match(
      /9Ps000000000001AAA|20Y000000000001AAA|0Zu000000000001AAA|key-source|rawHtml.*<p>|Plain café/u,
    );
    expect(JSON.stringify([current.workspace, current.parent, current.variants])).to.equal(before);
    expect(current.connection.request.callCount).to.equal(16);
    // Only in-memory buffers are produced: no output path or publication API exists.
    expect(result).to.have.all.keys('directory', 'projection', 'evidence');
    expect(await acquireEditableEmailSource(current.connection, selection)).to.deep.equal(result);
  });

  it('normalizes recorded variant/parent GET metadata without mutating evidence or portable IDs', async () => {
    const current = recordedReadEnvelopes();
    const before = JSON.stringify([current.parent, current.variants]);
    const result = await acquireEditableEmailSource(current.connection, selection);
    expect(result.evidence).to.deep.equal({
      variantId: '9Ps000000000001AAA',
      contentId: '20Y000000000001AAA',
    });
    expect(result.projection.companions[0].bytes.toString()).to.equal(
      '<p>Owned inert acceptance</p>',
    );
    expect(result.projection.definition.contentBody).to.have.property('lightning:brandSource');
    expect(result.projection.definitionBytes.toString()).not.to.match(
      /9Ps000000000001AAA|20Y000000000001AAA|0Zu000000000001AAA|key-source|user-source|version-source|contentFqn|createdBy|createdDate|lastModified|managedContent|contentVersion|variantVersion/u,
    );
    expect(JSON.stringify([current.parent, current.variants])).to.equal(before);
  });

  it('does not hide unknown envelopes or unsupported editable components in either GET', async () => {
    for (const side of ['variant', 'parent'] as const) {
      for (const location of ['envelope', 'body'] as const) {
        const current = recordedReadEnvelopes();
        const value = side === 'variant' ? current.variants[0] : current.parent;
        if (location === 'envelope') value.unknownAuthoringComponent = {};
        else (value.contentBody as RecordValue)['lightning:unknownComponent'] = {};
        await fails(current, '');
      }
    }
    const current = recordedReadEnvelopes();
    for (const value of [current.parent, current.variants[0]])
      (value.contentBody as RecordValue)['lightning:unknownComponent'] = {};
    await fails(current, 'Unsupported native body field');
  });

  it('retains original parent identity, scope, payload, sibling and version safety evidence', async () => {
    for (const [key, value] of [
      ['managedContentId', 'wrong-parent'],
      ['managedContentVariantId', 'wrong-variant'],
      ['managedContentVersionId', 'wrong-version'],
      ['contentSpace', { id: 'wrong-space' }],
      ['contentType', { fullyQualifiedName: 'sfdc_cms__emailTemplate' }],
      ['contentFqn', 'wrong-fqn'],
      ['contentBody', {}],
      ['language', 'de_DE'],
      ['externalId', 'external-provider'],
    ] as const) {
      const current = recordedReadEnvelopes();
      current.parent[key] = value;
      await fails(current, '');
    }
    const current = recordedReadEnvelopes();
    current.variants.push(email('translated', 'de_DE'));
    await fails(current, 'single exact native sibling');
  });

  it('rejects missing or invalid workspace API names before inventory without display-name fallback', async () => {
    for (const apiName of [undefined, null, '', '   ', '../escape']) {
      const current = fixture();
      current.workspace.name = 'Marketing';
      if (apiName === undefined) delete current.workspace.apiName;
      else current.workspace.apiName = apiName;
      await fails(
        current,
        apiName === '../escape' ? 'Unsafe source path segment' : 'Workspace API name',
      );
      expect(current.connection.request.callCount).to.equal(1);
      expect(current.connection.request.firstCall.args[0].url).to.equal(
        '/connect/cms/spaces/0Zu000000000001AAA',
      );
    }
  });

  it('uses an explicit language and proven root folder references without a default', async () => {
    const current = fixture();
    delete current.workspace.defaultLanguage;
    Object.assign(current.variants[0], { language: 'de_DE', folder: { id: 'root-folder-source' } });
    current.parent.folder = { id: 'root-folder-source' };
    const result = await acquireEditableEmailSource(current.connection, {
      workspaceId: '0Zu000000000001AAA',
      apiName: 'Welcome',
      language: 'de_DE',
    });
    expect(result.projection.definition.language).to.equal('de_DE');
    expect(result.projection.definition.folderPath).to.deep.equal([]);
  });

  it('requires exactly one explicit language choice before issuing requests', async () => {
    for (const patch of [
      { useDefaultLanguage: undefined },
      { language: 'en_US' },
      { useDefaultLanguage: false },
      { language: '', useDefaultLanguage: undefined },
      { workspaceId: '' },
      { apiName: '../escape' },
    ]) {
      const current = fixture();
      try {
        await acquireEditableEmailSource(current.connection, {
          ...selection,
          ...patch,
        } as AcquireEditableEmailSourceInput);
        expect.fail('Expected invalid selector rejection');
      } catch (error) {
        expect(error).to.be.instanceOf(TypeError);
      }
      expect(current.connection.request.called).to.equal(false);
    }
  });

  it('rejects missing and ambiguous exact matches, including wrong language/API case', async () => {
    for (const variants of [
      [],
      [email('other', 'fr_FR')],
      [email('other', 'en_US', 'welcome')],
      [email(), email('duplicate')],
    ]) {
      const current = fixture();
      current.variants.splice(0, current.variants.length, ...variants);
      await fails(current, 'exactly one');
      expect(
        current.connection.request.args.every(
          ([request]) => !request.url.endsWith('/contents/20Y000000000001AAA'),
        ),
      ).to.equal(true);
    }
  });

  it('binds every native family detail before exact Email selection without search', async () => {
    const current = fixture();
    current.variants.unshift({
      ...email('other', 'fr_FR', 'Other'),
      managedContentId: '20Y000000000002AAA',
    });
    const result = await acquireEditableEmailSource(current.connection, selection);
    expect(result.evidence.variantId).to.equal('9Ps000000000001AAA');
    const urls = current.connection.request.args.map(([request]) => request.url as string);
    expect(urls.filter((url) => url.includes('/items/search'))).to.have.length(0);
    expect(urls.filter((url) => url.includes('/variants/'))).to.have.length(3);
  });

  it('fetches hidden different-type/language siblings independently for both families', async () => {
    for (const template of [false, true]) {
      const current = fixture(template);
      const sibling = email('translated', 'de_DE', 'Hidden');
      sibling.contentType = {
        fullyQualifiedName: template ? 'sfdc_cms__email' : 'sfdc_cms__emailTemplate',
      };
      current.variants.push(sibling);
      await (template
        ? rejects(current, 'single exact native sibling')
        : fails(current, 'single exact native sibling'));
      const urls = current.connection.request.args.map(([request]) => request.url as string);
      expect(
        urls.some((url) => url.endsWith(`/variants/${String(sibling.managedContentVariantId)}`)),
      ).to.equal(true);
      const siblingQueries = urls.filter((url) =>
        decodeURIComponent(url).includes('ManagedContentId ='),
      );
      expect(siblingQueries).to.have.length(6);
      expect(
        siblingQueries.every(
          (url) => !decodeURIComponent(url).includes('ContentTypeFullyQualifiedName IN'),
        ),
      ).to.equal(true);
      expect(urls.some((url) => url.includes('/items/search'))).to.equal(false);
    }
  });

  it('rejects native count drift and stable but different family/sibling observations', async () => {
    const counts = fixture();
    let reads = 0;
    counts.patchNative((rows) => (++reads === 3 ? [] : rows));
    await fails(counts, 'aggregate count disagreement');
    const changed = fixture();
    changed.patchNative((rows, siblings) => rows.map((row) => ({ ...row, IsPrimary: !siblings })));
    await fails(changed, 'single exact native sibling');
  });

  it('rejects translated or differently named siblings from complete all-language inventory', async () => {
    for (const sibling of [email('translated', 'de_DE'), email('renamed', 'en_US', 'Other')]) {
      const current = fixture();
      current.variants.push(sibling);
      await fails(current, 'single exact native sibling');
    }
  });

  it('rejects workspace, detail type/identity and parent scope mismatches', async () => {
    for (const mutate of [
      (current: ReturnType<typeof fixture>) => {
        current.workspace.id = 'wrong';
      },
      (current: ReturnType<typeof fixture>) => {
        current.variants[0].contentSpace = { id: 'wrong' };
      },
      (current: ReturnType<typeof fixture>) => {
        current.variants[0].contentType = 'sfdc_cms__emailTemplate';
      },
      (current: ReturnType<typeof fixture>) => {
        current.variants[0].id = 'conflicting';
      },
      (current: ReturnType<typeof fixture>) => {
        current.parent.managedContentId = 'wrong';
      },
      (current: ReturnType<typeof fixture>) => {
        current.parent.contentSpace = { id: 'wrong' };
      },
      (current: ReturnType<typeof fixture>) => {
        current.parent.contentType = 'sfdc_cms__emailTemplate';
      },
    ]) {
      const current = fixture();
      mutate(current);
      await fails(current, '');
    }
  });

  it('never fabricates ancestry, portable workspace names or default languages', async () => {
    for (const mutate of [
      (current: ReturnType<typeof fixture>) => {
        delete current.variants[0].folder;
      },
      (current: ReturnType<typeof fixture>) => {
        delete current.parent.folder;
      },
      (current: ReturnType<typeof fixture>) => {
        current.variants[0].folder = { id: 'nested' };
      },
      (current: ReturnType<typeof fixture>) => {
        current.parent.folder = { id: 'nested' };
      },
      (current: ReturnType<typeof fixture>) => {
        current.workspace.rootFolderId = '0Zu000000000001AAA';
        current.parent.folder = { id: '0Zu000000000001AAA' };
      },
      (current: ReturnType<typeof fixture>) => {
        delete current.workspace.apiName;
      },
      (current: ReturnType<typeof fixture>) => {
        current.workspace.apiName = '../escape';
      },
      (current: ReturnType<typeof fixture>) => {
        delete current.workspace.defaultLanguage;
      },
    ]) {
      const current = fixture();
      mutate(current);
      await fails(current, '');
    }
  });
});
