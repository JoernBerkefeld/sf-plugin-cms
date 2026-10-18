import { expect } from 'chai';
import { createHash } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { writeEditableItemSource } from '../../src/services/write-item-source.js';
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
const DOCUMENT = Buffer.from('Café & 世界\r\nSecond line\n', 'utf8');
const documentInput = { ...input, contentType: 'sfdc_cms__document' as const };
const AUDIO = Buffer.from('RIFF\u0004\u0000\u0000\u0000WAVE');
const audioInput = { ...input, contentType: 'sfdc_cms__audio' as const };
function fixture(document = false, audio = false) {
  const kind = audio ? 'audio' : 'image';
  const values = {
    audio: {
      bytes: AUDIO,
      mime: 'audio/x-wav',
      contentType: audioInput.contentType,
      suffix: 'wav',
    },
    image: { bytes: PNG, mime: 'image/png', contentType: input.contentType, suffix: 'png' },
    document: {
      bytes: DOCUMENT,
      mime: 'text/plain',
      contentType: documentInput.contentType,
      suffix: 'txt',
    },
  };
  const { bytes, mime, contentType, suffix } = values[document ? 'document' : kind];
  const raw: R = {
    managedContentVariantId: '9Ps000000000001AAA',
    managedContentId: '20Y000000000001AAA',
    apiName: 'Hero',
    contentKey: 'source-key',
    contentSpace: { id: input.workspaceId },
    contentType: { fullyQualifiedName: contentType },
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
          size: bytes.length,
          fileSize: bytes.length,
          mimeType: mime,
        },
        url: `/cms/media/source-key?version=1.3&fileHash=${createHash('md5').update(bytes).digest('hex')}&fileName=original.${suffix}`,
      },
    },
  };
  const parent = structuredClone(raw);
  parent.contentType = { fullyQualifiedName: contentType, name: 'Image' };
  parent.contentVersion = 1;
  parent.variantVersion = '1.3';
  const workspace = {
    id: input.workspaceId,
    apiName: 'Marketing',
    rootFolderId: 'root',
    defaultLanguage: 'en_US',
  };
  const row: R = {
    Id: raw.managedContentVariantId,
    ManagedContentId: raw.managedContentId,
    ContentTypeFullyQualifiedName: contentType,
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
            'target-org': { getUsername: () => 'source' },
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
  it('acquires exact native Audio bytes and portable identity through public selection', async () => {
    const f = fixture(false, true);
    const fetcher = sinon.stub(globalThis, 'fetch').callsFake(
      async () =>
        new Response(AUDIO, {
          headers: { 'content-type': 'audio/x-wav', 'content-length': String(AUDIO.length) },
        }),
    );
    const prepared = await prepareEditableSourceSelection(f.connection, {
      workspaceId: input.workspaceId,
      language: input.language,
      selection: normalizeRetrieveSelection({ metadata: ['sfdc_cms__audio:Hero'] }),
    });
    const acquired = await prepared.acquire(f.row.Id as string);
    expect(acquired.evidence).to.deep.equal({
      variantId: f.row.Id,
      contentId: f.row.ManagedContentId,
    });
    expect(acquired.directory).to.equal('cms/Marketing/audio');
    expect(acquired.projection.definitionName).to.equal('Hero.cms-audio.json');
    expect(acquired.projection.definition.identity.type).to.equal('Audio');
    expect(acquired.projection.companions[0].path).to.equal('Hero.cms-audio.media.wav');
    expect(acquired.projection.companions[0].bytes).to.deep.equal(AUDIO);
    expect(
      createHash('sha256').update(acquired.projection.companions[0].bytes).digest('hex'),
    ).to.equal(createHash('sha256').update(AUDIO).digest('hex'));
    expect(fetcher.calledOnce).to.equal(true);
    await failure(prepared.acquire('unselected'), /resolved native selection/u);
  });

  for (const blocked of [false, true]) {
    it(`runs public Audio retrieval with ${blocked ? 'guarded failure and no writer' : 'exact local bytes and identity'}`, async () => {
      const f = fixture(false, true);
      sinon.stub(globalThis, 'fetch').callsFake(
        async () =>
          new Response(AUDIO, {
            headers: { 'content-type': 'audio/x-wav' },
          }),
      );
      const project = await mkdtemp(path.join(os.tmpdir(), 'cms-audio-command-'));
      const prepared = await prepareEditableSourceSelection(f.connection, {
        workspaceId: input.workspaceId,
        language: input.language,
        selection: normalizeRetrieveSelection({ metadata: ['sfdc_cms__audio:Hero'] }),
      });
      if (blocked) f.row.IsPrimary = false;
      const writeSource = sinon.spy(writeEditableItemSource);
      const instance = Object.create(RetrieveContent.prototype) as RetrieveContent;
      Object.assign(instance, {
        parse: sinon.stub().resolves({
          flags: {
            'target-org': { getUsername: () => 'source' },
            'api-version': '67.0',
            'workspace-id': input.workspaceId,
            metadata: ['sfdc_cms__audio:Hero'],
            language: input.language,
            'output-dir': project,
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
      expect(result.status).to.equal(blocked ? 'blocked' : 'success');
      expect(result.result!.items[0].identity).to.include({
        contentType: audioInput.contentType,
        apiName: 'Hero',
      });
      if (blocked) {
        expect(writeSource.notCalled).to.equal(true);
        expect(result.result!.items[0].diagnostics).to.include('RETRIEVE_SOURCE_BLOCKED');
      } else {
        expect(writeSource.calledOnce).to.equal(true);
        expect(result.result!.items[0].evidence).to.deep.equal({
          variantId: f.row.Id,
          contentId: f.row.ManagedContentId,
        });
        expect(
          await readFile(path.join(project, 'cms/Marketing/audio/Hero.cms-audio.media.wav')),
        ).to.deep.equal(AUDIO);
      }
    });
  }

  it('retains private Audio scope despite caller mutations and rejects substituted workspace identity', async () => {
    const f = fixture(false, true);
    const selected = {
      workspaceId: input.workspaceId,
      language: input.language,
      selection: normalizeRetrieveSelection({ metadata: ['sfdc_cms__audio:Hero'] }),
    };
    const prepared = await prepareEditableSourceSelection(f.connection, selected);
    selected.workspaceId = 'forged';
    selected.selection.groups.length = 0;
    prepared.resolution.variants[0].ManagedContent.ApiName = 'forged';
    f.workspace.apiName = 'Other';
    sinon.stub(globalThis, 'fetch').callsFake(
      async () =>
        new Response(AUDIO, {
          headers: { 'content-type': 'audio/x-wav' },
        }),
    );
    await failure(prepared.acquire(f.row.Id as string), /Resolved media identity\/workspace/u);
  });

  it('rejects Audio eligibility and native disagreement before fetching', async () => {
    const fetcher = sinon.stub(globalThis, 'fetch');
    const patches: Array<(f: ReturnType<typeof fixture>) => void> = [
      (f) => {
        f.workspace.defaultLanguage = 'fr';
      },
      (f) => {
        f.row.IsPrimary = false;
      },
      (f) => {
        f.raw.contentKey = 'other';
      },
      (f) => {
        f.parent.contentType = { fullyQualifiedName: 'sfdc_cms__image' };
      },
      (f) => {
        f.raw.contentSpace = { id: 'other' };
      },
      (f) => {
        f.parent.folder = { id: 'child' };
      },
      (f) => {
        f.parent.title = 'changed';
      },
      (f) => {
        f.setSiblings([f.row, { ...f.row, Id: '9Ps000000000002AAA' }]);
      },
    ];
    for (const patch of patches) {
      const f = fixture(false, true);
      patch(f);
      await failure(
        acquireEditableMediaSource(f.connection, audioInput),
        /default|primary|disagreement|root|sibling/u,
      );
    }
    expect(fetcher.notCalled).to.equal(true);
  });

  it('rejects Audio native drift introduced during binary download', async () => {
    const fetcher = sinon.stub(globalThis, 'fetch');
    const patches: Array<(f: ReturnType<typeof fixture>) => void> = [
      (f) => {
        f.raw.managedContentVersionId = 'changed';
      },
      (f) => {
        f.parent.variantVersion = 'changed';
      },
      (f) => {
        f.row.IsPrimary = false;
      },
      (f) => {
        f.workspace.defaultLanguage = 'fr';
      },
      (f) => {
        f.setSiblings([f.row, { ...f.row, Id: '9Ps000000000002AAA' }]);
      },
    ];
    for (const patch of patches) {
      const f = fixture(false, true);
      fetcher.callsFake(async () => {
        patch(f);
        return new Response(AUDIO, { headers: { 'content-type': 'audio/x-wav' } });
      });
      await failure(
        acquireEditableMediaSource(f.connection, audioInput),
        /changed during acquisition/u,
      );
    }
  });

  it('rejects Audio binary MIME, filename, declared size and hash disagreement', async () => {
    const fetcher = sinon.stub(globalThis, 'fetch');
    for (const problem of ['mime', 'filename', 'size', 'hash', 'length']) {
      const f = fixture(false, true);
      const media = (f.raw.contentBody as R)['sfdc_cms:media'] as R;
      if (problem === 'filename')
        media.url = String(media.url).replace('original.wav', '..%2Faudio.wav');
      if (problem === 'hash')
        media.url = String(media.url).replace(
          /fileHash=[^&]+/u,
          'fileHash=00000000000000000000000000000000',
        );
      if (problem === 'size') {
        (media.source as R).size = AUDIO.length + 1;
        (media.source as R).fileSize = AUDIO.length + 1;
      }
      f.parent.contentBody = structuredClone(f.raw.contentBody);
      fetcher.callsFake(
        async () =>
          new Response(AUDIO, {
            headers: {
              'content-type': problem === 'mime' ? 'audio/mpeg' : 'audio/x-wav',
              'content-length': String(AUDIO.length + Number(problem === 'length')),
            },
          }),
      );
      await failure(
        acquireEditableMediaSource(f.connection, audioInput),
        /MIME|filename|byte count|MD5/u,
      );
    }
  });

  it('represents non-WAV opaque Audio and URL-only without native format qualification', async () => {
    const bytes = Buffer.from('opaque audio bytes');
    const f = fixture(false, true);
    const media = (f.raw.contentBody as R)['sfdc_cms:media'] as R;
    media.source = { type: 'file', ref: 'source-ref', size: bytes.length, mimeType: 'audio/mpeg' };
    media.url = `/cms/media/source-key?version=1.3&fileHash=${createHash('md5').update(bytes).digest('hex')}&fileName=original.mp3`;
    f.parent.contentBody = structuredClone(f.raw.contentBody);
    const fetcher = sinon
      .stub(globalThis, 'fetch')
      .callsFake(async () => new Response(bytes, { headers: { 'content-type': 'audio/mpeg' } }));
    const prepared = await prepareEditableSourceSelection(f.connection, {
      workspaceId: input.workspaceId,
      language: input.language,
      selection: normalizeRetrieveSelection({ metadata: ['sfdc_cms__audio:Hero'] }),
    });
    const acquired = await prepared.acquire(f.row.Id as string);
    expect(acquired.projection.companions[0].bytes).to.deep.equal(bytes);
    expect(acquired.projection.companions[0].path).to.equal('Hero.cms-audio.media.mp3');
    const urlOnly = await acquireEditableMediaSource(f.connection, {
      ...audioInput,
      urlOnly: true,
    });
    expect(urlOnly.projection.definition.media.representation).to.equal('url-only');
    expect(fetcher.calledOnce).to.equal(true);
  });

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
  for (const responseType of [
    'IMAGE/PNG; charset=utf-8',
    'Application/Octet-Stream; charset=ISO-8859-1',
  ]) {
    it(`acquires exact Image bytes and native MIME from parameterized HTTP ${responseType}`, async () => {
      const f = fixture();
      sinon
        .stub(globalThis, 'fetch')
        .callsFake(async () => new Response(PNG, { headers: { 'content-type': responseType } }));
      const acquired = await acquireEditableMediaSource(f.connection, input);
      expect(acquired.projection.definition.media).to.include({ mimeType: 'image/png' });
      expect(acquired.projection.companions[0].bytes).to.deep.equal(PNG);
    });
  }
  for (const kind of ['image', 'document', 'audio'] as const) {
    const document = kind === 'document';
    const audio = kind === 'audio';
    for (const selectors of [
      { 'api-name': ['Hero'] },
      { 'content-key-or-id': ['source-key', 'source-key'] },
      { 'content-key-or-id': ['20Y000000000001AAA'] },
      { all: true },
    ]) {
      it(`acquires resolved ${kind} selections with exact bytes: ${JSON.stringify(selectors)}`, async () => {
        const f = fixture(document, audio);
        const selectedInput = { audio: audioInput, document: documentInput, image: input }[kind];
        const bytes = { audio: AUDIO, document: DOCUMENT, image: PNG }[kind];
        const fetcher = sinon.stub(globalThis, 'fetch').callsFake(
          async () =>
            new Response(bytes, {
              headers: {
                'content-type': {
                  audio: 'audio/x-wav',
                  document: 'text/plain',
                  image: 'image/png',
                }[kind],
              },
            }),
        );
        const prepared = await prepareEditableSourceSelection(f.connection, {
          workspaceId: input.workspaceId,
          language: input.language,
          selection: normalizeRetrieveSelection({
            'content-type': [selectedInput.contentType],
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
        expect(acquired.projection.companions[0].bytes.equals(bytes)).to.equal(true);
        expect(acquired.directory).to.equal(`cms/Marketing/${kind}`);
        expect(acquired.projection.definitionName).to.equal(`Hero.cms-${kind}.json`);
        expect(await prepared.acquire(id)).to.deep.equal(acquired);
        expect(fetcher.calledTwice).to.equal(true);
        await failure(prepared.acquire('unselected'), /resolved native selection/u);
      });
    }
  }

  for (const kind of ['image', 'document', 'audio']) {
    it(`blocks a substituted native ${kind} identity after selection and retains missing selectors`, async () => {
      const f = fixture(kind === 'document', kind === 'audio');
      const contentType = `sfdc_cms__${kind}`;
      const native = (f.raw.contentBody as R)['sfdc_cms:media'] as R;
      native.url = 'https://cdn.example/hero.png';
      f.parent.contentBody = structuredClone(f.raw.contentBody);
      const prepared = await prepareEditableSourceSelection(f.connection, {
        workspaceId: input.workspaceId,
        language: input.language,
        selection: normalizeRetrieveSelection({
          metadata: [contentType, `${contentType}:Missing`],
        }),
      });
      expect(prepared.resolution.unresolved[0]).to.include({
        selector: 'Missing',
        reason: 'missing',
      });
      const id = f.row.Id as string;
      for (const value of [f.raw, f.parent]) value.managedContentVariantId = '9Ps000000000002AAA';
      f.row.Id = '9Ps000000000002AAA';
      await failure(prepared.acquire(id), /Resolved media identity/u);
    });
  }

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
  for (const document of [false, true]) {
    it(`rejects ${document ? 'Document' : 'Image'} native, parent, workspace, sibling, placement and unknown authoring disagreement before fetching`, async () => {
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
        const f = fixture(document);
        patch(f);
        await failure(
          acquireEditableMediaSource(f.connection, document ? documentInput : input),
          /disagreement|sibling|root|fields/u,
        );
      }
      expect(fetcher.called).to.equal(false);
    });
  }

  it('writes Document exact bytes stably, protects edits and retains unrelated files', async () => {
    sinon
      .stub(globalThis, 'fetch')
      .callsFake(async () => new Response(DOCUMENT, { headers: { 'content-type': 'text/plain' } }));
    const prepared = await prepareEditableSourceSelection(fixture(true).connection, {
      workspaceId: input.workspaceId,
      language: input.language,
      selection: normalizeRetrieveSelection({
        metadata: [documentInput.contentType, `${documentInput.contentType}:Hero`],
      }),
    });
    expect(prepared.resolution.variants).to.have.length(1);
    const acquired = await prepared.acquire(prepared.resolution.variants[0].Id);
    const project = await mkdtemp(path.join(os.tmpdir(), 'cms-document-retrieve-'));
    const unrelated = path.join(project, 'unrelated.txt');
    await writeFile(unrelated, 'keep');
    const write = (overwrite = false) =>
      writeEditableItemSource(project, acquired.directory, acquired.projection, overwrite);
    const first = await write();
    const companion = path.join(project, acquired.directory, 'Hero.cms-document.media.txt');
    expect(await readFile(companion)).to.deep.equal(DOCUMENT);
    const repeated = await write();
    expect(repeated.unchanged).to.have.length(2);
    await writeFile(companion, 'local edit');
    await failure(write(), /overwrite/u);
    expect(await readFile(companion, 'utf8')).to.equal('local edit');
    const overwritten = await write(true);
    expect(overwritten.updated).to.deep.equal([companion]);
    expect(await readFile(companion)).to.deep.equal(DOCUMENT);
    expect(await readFile(unrelated, 'utf8')).to.equal('keep');
    expect(first.created).to.have.length(2);
  });

  it('rejects downloaded Document bytes, MIME and invalid UTF-8', async () => {
    const fetcher = sinon.stub(globalThis, 'fetch');
    for (const [bytes, mime] of [
      [Buffer.concat([DOCUMENT, Buffer.from('changed')]), 'text/plain'],
      [DOCUMENT, 'image/png'],
      [Buffer.alloc(DOCUMENT.length, 255), 'text/plain'],
    ] as const) {
      fetcher.callsFake(async () => new Response(bytes, { headers: { 'content-type': mime } }));
      const f = fixture(true);
      if (bytes[0] === 255) {
        const media = (f.raw.contentBody as R)['sfdc_cms:media'] as R;
        media.url = `/cms/media/source-key?version=1.3&fileHash=${createHash('md5').update(bytes).digest('hex')}&fileName=original.txt`;
        f.parent.contentBody = structuredClone(f.raw.contentBody);
      }
      await failure(
        acquireEditableMediaSource(f.connection, documentInput),
        /byte count|MIME|UTF|encoded/u,
      );
    }
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
