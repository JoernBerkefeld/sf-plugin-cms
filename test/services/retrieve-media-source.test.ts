import { expect } from 'chai';
import { createHash } from 'node:crypto';
import { PassThrough } from 'node:stream';
import sinon from 'sinon';
import { acquireEditableMediaSource } from '../../src/services/retrieve-media-source.js';
import { prepareEditableSourceSelection } from '../../src/services/retrieve-item-source.js';
import { normalizeRetrieveSelection } from '../../src/services/retrieve-selection.js';
import RetrieveContent from '../../src/commands/cms/retrieve/content.js';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=',
  'base64',
);
const input = {
  workspaceId: '0Zu000000000001AAA',
  apiName: 'Hero',
  language: 'en_US',
  contentType: 'sfdc_cms__image' as const,
};
type R = Record<string, unknown>;
function fixture() {
  const raw: R = {
    managedContentVariantId: '9Ps000000000001AAA',
    managedContentId: '20Y000000000001AAA',
    apiName: 'Hero',
    contentKey: 'source-key',
    contentSpace: { id: input.workspaceId },
    contentType: { fullyQualifiedName: input.contentType },
    language: 'en_US',
    title: 'Hero',
    urlName: 'hero',
    status: { status: 'Published', label: 'Published' },
    isPublished: true,
    folder: { id: 'root' },
    externalId: null,
    managedContentVersionId: 'source-version',
    contentBody: {
      'sfdc_cms:media': {
        source: {
          type: 'file',
          ref: 'source-ref',
          size: PNG.length,
          fileSize: PNG.length,
          mimeType: 'image/png',
        },
        url: `/cms/media/source-key?version=1.3&fileHash=${createHash('md5').update(PNG).digest('hex')}&fileName=original.png`,
      },
    },
  };
  const parent = structuredClone(raw);
  parent.contentType = { fullyQualifiedName: input.contentType, name: 'Image' };
  parent.contentVersion = 1;
  parent.variantVersion = '1.3';
  const workspace = { id: input.workspaceId, apiName: 'Marketing', rootFolderId: 'root' };
  const row: R = {
    Id: raw.managedContentVariantId,
    ManagedContentId: raw.managedContentId,
    ContentTypeFullyQualifiedName: input.contentType,
    Language: 'en_US',
    IsPublished: true,
    ManagedContentVariantStatus: 'Published',
    IsPrimary: true,
    Name: 'Hero',
    UrlName: 'hero',
    ManagedContentKey: 'source-key',
    ManagedContent: { AuthoredManagedContentSpaceId: input.workspaceId, ApiName: 'Hero' },
  };
  let siblings = [row];
  const request = sinon.stub().callsFake((value: { url: string; method: string }) => {
    expect(value.method).to.equal('GET');
    const url = new URL(value.url, 'https://source.example');
    let result: unknown;
    if (url.pathname.includes('/query')) {
      const q = url.searchParams.get('q')!;
      const rows = q.includes('ManagedContentId =') ? siblings : [row];
      let records = q.includes('Id >') ? [] : rows;
      if (q.includes('COUNT(Id)'))
        records = [{ ManagedContentId: row.ManagedContentId, siblingCount: rows.length }];
      result = { totalSize: records.length, done: true, records };
    } else if (url.pathname.includes('/spaces/')) result = workspace;
    else if (url.pathname.includes('/variants/')) result = raw;
    else result = parent;
    return Object.assign(Promise.resolve(structuredClone(result)), {
      stream: () => new PassThrough(),
    });
  });
  return {
    raw,
    parent,
    row,
    workspace,
    setSiblings: (rows: R[]) => {
      siblings = rows;
    },
    connection: {
      request,
      getApiVersion: () => '67.0',
      accessToken: 'test-token',
      instanceUrl: 'https://source.example',
    },
  };
}
async function failure(operation: Promise<unknown>, pattern: RegExp) {
  try {
    await operation;
  } catch (error) {
    expect((error as Error).message).to.match(pattern);
    return;
  }
  throw new Error('Expected rejection');
}
describe('native editable media acquisition', () => {
  afterEach(() => {
    sinon.restore();
    process.exitCode = undefined;
  });
  for (const status of [401, 403]) {
    it(`stops the command batch on actual binary HTTP ${status} without later acquisition or writes`, async () => {
      const f = fixture();
      const fetcher = sinon
        .stub(globalThis, 'fetch')
        .callsFake(async () => new Response('private server body', { status }));
      const prepared = await prepareEditableSourceSelection(f.connection, {
        workspaceId: input.workspaceId,
        language: input.language,
        selection: normalizeRetrieveSelection({ 'content-type': [input.contentType], all: true }),
      });
      const later = structuredClone(prepared.resolution.variants[0]);
      later.Id = '9Ps000000000002AAA';
      later.ManagedContentId = '20Y000000000002AAA';
      later.ManagedContent.ApiName = 'Later';
      prepared.resolution.variants.push(later);
      const acquire = sinon.spy(prepared, 'acquire');
      const writeSource = sinon.stub().rejects(new Error('Unexpected write'));
      const instance = Object.create(RetrieveContent.prototype) as RetrieveContent;
      Object.assign(instance, {
        parse: sinon.stub().resolves({
          flags: {
            'target-org': 'source',
            'api-version': '67.0',
            'workspace-id': input.workspaceId,
            'content-type': [input.contentType],
            all: true,
            language: input.language,
            'output-dir': './unused-output',
            overwrite: false,
          },
        }),
        getOrgContext: sinon.stub().resolves({ connection: f.connection, orgId: '00DSource' }),
        resolveSourceWorkspace: sinon
          .stub()
          .resolves({ id: input.workspaceId, workspace: f.workspace }),
        prepareSources: sinon.stub().resolves(prepared),
        writeSource,
        jsonEnabled: sinon.stub().returns(true),
        log: sinon.stub(),
      });
      const result = await instance.run();
      expect(result.status).to.equal('blocked');
      expect(process.exitCode).to.equal(1);
      expect(result.result!.summary).to.include({ blocked: 1, unattempted: 1, retrieved: 0 });
      expect(result.result!.unattempted[0]).to.include({ apiName: 'Later', variantId: later.Id });
      expect(result.diagnostics.errors[0].code).to.equal('RETRIEVE_SCOPE_BLOCKED');
      expect(acquire.calledOnceWithExactly(f.row.Id as string)).to.equal(true);
      expect(fetcher.calledOnce).to.equal(true);
      expect(writeSource.notCalled).to.equal(true);
      expect(JSON.stringify(result)).not.to.include('private server body');
    });
  }
  it('binds the recorded fileSize/size PNG shape to exact stable portable bytes', async () => {
    const f = fixture();
    const fetcher = sinon
      .stub(globalThis, 'fetch')
      .callsFake(async () => new Response(PNG, { headers: { 'content-type': 'image/png' } }));
    const first = await acquireEditableMediaSource(f.connection, input);
    const second = await acquireEditableMediaSource(f.connection, input);
    expect(first).to.deep.equal(second);
    expect(first.directory).to.equal('cms/Marketing/image');
    expect(first.projection.definitionName).to.equal('Hero.cms-image.json');
    expect(first.projection.companions[0].bytes.equals(PNG)).to.equal(true);
    expect(first.projection.companions[0].path).to.equal('Hero.cms-image.media.png');
    for (const locator of [
      'source-key',
      'source-ref',
      'source-version',
      'original.png',
      'fileHash',
    ])
      expect(first.projection.definitionBytes.toString()).not.to.include(locator);
    expect(fetcher.callCount).to.equal(2);
  });
  for (const selectors of [
    { 'api-name': ['Hero'] },
    { 'content-key-or-id': ['source-key'] },
    { all: true },
  ]) {
    it(`acquires resolved Image selections with bound binary bytes: ${JSON.stringify(selectors)}`, async () => {
      const f = fixture();
      const fetcher = sinon
        .stub(globalThis, 'fetch')
        .callsFake(async () => new Response(PNG, { headers: { 'content-type': 'image/png' } }));
      const prepared = await prepareEditableSourceSelection(f.connection, {
        workspaceId: input.workspaceId,
        language: input.language,
        selection: normalizeRetrieveSelection({
          'content-type': [input.contentType],
          ...selectors,
        }),
      });
      const id = prepared.resolution.variants[0].Id;
      prepared.resolution.variants[0].ManagedContentId = 'forged';
      const acquired = await prepared.acquire(id);
      expect(acquired.evidence).to.deep.equal({
        variantId: f.row.Id,
        contentId: f.row.ManagedContentId,
      });
      expect(acquired.projection.companions[0].bytes.equals(PNG)).to.equal(true);
      expect(fetcher.calledOnce).to.equal(true);
      await failure(prepared.acquire('unselected'), /resolved native selection/u);
    });
  }

  it('blocks a substituted native Image identity after selection and retains missing selectors', async () => {
    const f = fixture();
    const native = (f.raw.contentBody as R)['sfdc_cms:media'] as R;
    native.url = 'https://cdn.example/hero.png';
    f.parent.contentBody = structuredClone(f.raw.contentBody);
    const prepared = await prepareEditableSourceSelection(f.connection, {
      workspaceId: input.workspaceId,
      language: input.language,
      selection: normalizeRetrieveSelection({
        metadata: [input.contentType, `${input.contentType}:Missing`],
      }),
    });
    expect(prepared.resolution.unresolved[0]).to.include({
      selector: 'Missing',
      reason: 'missing',
    });
    const id = f.row.Id as string;
    for (const value of [f.raw, f.parent]) value.managedContentVariantId = '9Ps000000000002AAA';
    f.row.Id = '9Ps000000000002AAA';
    await failure(prepared.acquire(id), /Resolved Image identity/u);
  });

  it('retains external and explicitly unretrieved sources as URL-only without fetching', async () => {
    const fetcher = sinon.stub(globalThis, 'fetch');
    const f = fixture();
    const native = (f.raw.contentBody as R)['sfdc_cms:media'] as R;
    native.url = 'https://cdn.example/hero.png';
    f.parent.contentBody = structuredClone(f.raw.contentBody);
    const external = await acquireEditableMediaSource(f.connection, input);
    expect(external.projection.definition.media).to.deep.equal({
      representation: 'url-only',
      address: native.url,
    });
    expect(external.projection.companions).to.deep.equal([]);
    await acquireEditableMediaSource(f.connection, { ...input, urlOnly: true });
    expect(fetcher.called).to.equal(false);
  });
  it('rejects native, parent, workspace, sibling, placement and unknown authoring disagreement before fetching', async () => {
    const fetcher = sinon.stub(globalThis, 'fetch');
    const patches: Array<(f: ReturnType<typeof fixture>) => void> = [
      (f) => {
        f.row.ManagedContentKey = 'other';
      },
      (f) => {
        f.parent.title = 'Other';
      },
      (f) => {
        f.workspace.id = 'other';
      },
      (f) => {
        f.parent.folder = { id: 'nonroot' };
      },
      (f) => {
        f.parent.folder = null;
      },
      (f) => {
        f.setSiblings([f.row, { ...f.row, Id: '9Ps000000000002AAA' }]);
      },
      (f) => {
        (f.raw.contentBody as R).unknownAuthoring = true;
        f.parent.contentBody = structuredClone(f.raw.contentBody);
      },
      (f) => {
        f.raw.unknownAuthoring = true;
      },
      (f) => {
        const source = ((f.raw.contentBody as R)['sfdc_cms:media'] as R).source as R;
        source.fileSize = 1;
        f.parent.contentBody = structuredClone(f.raw.contentBody);
      },
    ];
    for (const patch of patches) {
      const f = fixture();
      patch(f);
      await failure(
        acquireEditableMediaSource(f.connection, input),
        /disagreement|sibling|root|fields/u,
      );
    }
    expect(fetcher.called).to.equal(false);
  });
  it('rejects downloaded bytes and MIME that disagree with the native evidence', async () => {
    const fetcher = sinon.stub(globalThis, 'fetch');
    for (const [bytes, mime] of [
      [Buffer.concat([PNG, Buffer.from('changed')]), 'image/png'],
      [PNG, 'image/jpeg'],
    ] as const) {
      fetcher.callsFake(async () => new Response(bytes, { headers: { 'content-type': mime } }));
      await failure(acquireEditableMediaSource(fixture().connection, input), /byte count|MIME/u);
    }
  });
});
