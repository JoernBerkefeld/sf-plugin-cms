import { expect } from 'chai';
import { PassThrough } from 'node:stream';
import sinon from 'sinon';
import { reassembleEditableItemSourceV2 } from '../../src/services/editable-item-source-v2.js';
import {
  acquireEditableEmailSource,
  type AcquireEditableEmailSourceInput,
} from '../../src/services/retrieve-item-source.js';

type RecordValue = Record<string, unknown>;
function email(id = 'variant-source', language = 'en_US', apiName = 'Welcome'): RecordValue {
  return {
    managedContentVariantId: id,
    managedContentId: 'parent-source',
    contentKey: 'key-source',
    contentSpace: { id: 'space-source' },
    apiName,
    contentType: { fullyQualifiedName: 'sfdc_cms__email' },
    language,
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
function fixture() {
  const workspace: RecordValue = {
    id: 'space-source',
    name: 'Content Workspace for Marketing Cloud',
    apiName: 'Default_Content_Workspace',
    defaultLanguage: 'en_US',
    rootFolderId: 'root-folder-source',
  };
  const parent: RecordValue = {
    managedContentId: 'parent-source',
    contentType: { fullyQualifiedName: 'sfdc_cms__email' },
    contentSpace: { id: 'space-source' },
    folder: null,
  };
  const variants = [email()];
  let pages: number[][] | undefined;
  let count: number | undefined;
  const request = sinon.stub().callsFake((input: { url: string; method: string }) => {
    expect(input.method).to.equal('GET');
    const url = new URL(input.url, 'https://example.invalid');
    let value: unknown;
    if (url.pathname === '/connect/cms/spaces/space-source') value = workspace;
    else if (url.pathname === '/connect/cms/items/search') {
      expect(url.searchParams.get('queryTerm')).to.equal('*');
      expect(url.searchParams.get('languages')).to.equal('All');
      expect(url.searchParams.get('contentTypeFQN')).to.equal('sfdc_cms__email');
      expect(url.searchParams.get('contentSpaceOrFolderIds')).to.equal('space-source');
      const page = Number(url.searchParams.get('page'));
      const indices = pages?.[page] ?? (pages ? [] : variants.map((_, index) => index));
      value = {
        count: count ?? variants.length,
        items: indices.map((index) => ({
          id: variants[index].managedContentVariantId,
          managedContentSpaceId: 'space-source',
          type: 'ManagedContentVariantSearchResultRepresentation',
        })),
      };
    } else if (url.pathname.startsWith('/connect/cms/contents/variants/')) {
      value = variants.find(
        (raw) => raw.managedContentVariantId === url.pathname.split('/').at(-1),
      );
    } else if (url.pathname === '/connect/cms/contents/parent-source') value = parent;
    else throw new Error(`Unexpected request: ${input.url}`);
    return Object.assign(Promise.resolve(structuredClone(value)), {
      stream: () => new PassThrough(),
    });
  });
  return {
    workspace,
    parent,
    variants,
    connection: { request, version: '67.0' },
    paginate(value: number[][], total?: number) {
      pages = value;
      count = total;
    },
  };
}
// Shape recorded in independent-readback-1792035980826.json (2026-10-15T03:46:20.826Z).
// Synthetic identities keep the regression independent of the live org.
function recordedReadEnvelopes() {
  const current = fixture();
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
  Object.assign(current.parent, structuredClone(current.variants[0]), {
    contentType: { fullyQualifiedName: 'sfdc_cms__email', name: 'Email' },
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
  workspaceId: 'space-source',
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
      variantId: 'variant-source',
      contentId: 'parent-source',
    });
    const { projection } = result;
    expect(projection.definitionName).to.equal('Welcome.cms-email.json');
    expect(projection.definition.folderPath).to.deep.equal([]);
    expect(projection.companions.map(({ path }) => path)).to.deep.equal([
      'Welcome.cms-email.rawHtml.html',
      'Welcome.cms-email.textContent.txt',
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
      /variant-source|parent-source|space-source|key-source|rawHtml.*<p>|Plain café/u,
    );
    expect(JSON.stringify([current.workspace, current.parent, current.variants])).to.equal(before);
    expect(current.connection.request.callCount).to.equal(4);
    // Only in-memory buffers are produced: no output path or publication API exists.
    expect(result).to.have.all.keys('directory', 'projection', 'evidence');
    expect(await acquireEditableEmailSource(current.connection, selection)).to.deep.equal(result);
  });

  it('normalizes recorded variant/parent GET metadata without mutating evidence or portable IDs', async () => {
    const current = recordedReadEnvelopes();
    const before = JSON.stringify([current.parent, current.variants]);
    const result = await acquireEditableEmailSource(current.connection, selection);
    expect(result.evidence).to.deep.equal({
      variantId: 'variant-source',
      contentId: 'parent-source',
    });
    expect(result.projection.companions[0].bytes.toString()).to.equal(
      '<p>Owned inert acceptance</p>',
    );
    expect(result.projection.definition.contentBody).to.have.property('lightning:brandSource');
    expect(result.projection.definitionBytes.toString()).not.to.match(
      /variant-source|parent-source|space-source|key-source|user-source|version-source|contentFqn|createdBy|createdDate|lastModified|managedContent|contentVersion|variantVersion/u,
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
        '/connect/cms/spaces/space-source',
      );
    }
  });

  it('uses an explicit language and proven root folder references without a default', async () => {
    const current = fixture();
    delete current.workspace.defaultLanguage;
    Object.assign(current.variants[0], { language: 'de_DE', folder: { id: 'root-folder-source' } });
    current.parent.folder = { id: 'root-folder-source' };
    const result = await acquireEditableEmailSource(current.connection, {
      workspaceId: 'space-source',
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
          ([request]) => !request.url.endsWith('/contents/parent-source'),
        ),
      ).to.equal(true);
    }
  });

  it('enumerates every global-count page and every detail before selection', async () => {
    const current = fixture();
    current.variants.unshift({
      ...email('other', 'fr_FR', 'Other'),
      managedContentId: 'other-parent',
    });
    current.paginate([[0], [1]]);
    const result = await acquireEditableEmailSource(current.connection, selection);
    expect(result.evidence.variantId).to.equal('variant-source');
    const urls = current.connection.request.args.map(([request]) => request.url as string);
    expect(urls.filter((url) => url.includes('/items/search'))).to.have.length(2);
    expect(urls.filter((url) => url.includes('/variants/'))).to.have.length(2);
    current.paginate([[0], []], 2);
    await fails(current, 'count was not satisfied');
  });

  it('rejects translated or differently named siblings from complete all-language inventory', async () => {
    for (const sibling of [email('translated', 'de_DE'), email('renamed', 'en_US', 'Other')]) {
      const current = fixture();
      current.variants.push(sibling);
      current.paginate([[0], [1]]);
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
        current.workspace.rootFolderId = 'space-source';
        current.parent.folder = { id: 'space-source' };
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
