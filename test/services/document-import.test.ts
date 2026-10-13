import { expect } from 'chai';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
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
  applyDocumentImports,
  documentCreateInput,
  planDocumentImports,
  preflightDocumentImports,
  readDocumentImportBytes,
} from '../../src/services/document-import.js';
import { loadWorkspaceExport } from '../../src/services/import-workspace.js';
import { planImageImports } from '../../src/services/image-import.js';
import { MAX_IMAGE_BYTES } from '../../src/transport/multipart-image-create.js';

const BYTES = Buffer.from('Run-owned Document fixture.\n');
const KEY = 'MCAAAAAAAAAAAAAAAAAAAAAAAAAA';
const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
const md5 = createHash('md5').update(BYTES).digest('hex');
const sourceUrl = `/cms/media/${KEY}?version=1.1&fileHash=${md5}&fileName=fixture.txt`;

function map(overrides: Record<string, unknown> = {}) {
  return {
    source: { family: 'cms', type: 'document', apiName: 'source_api' },
    contentKey: { strategy: 'generated' },
    apiName: { strategy: 'fresh', value: 'new_api' },
    title: { strategy: 'fresh', value: 'New title' },
    urlName: { strategy: 'fresh', value: 'new-url' },
    ...overrides,
  };
}

function response<T>(value: T) {
  return Object.assign(Promise.resolve(value), { stream: () => new PassThrough() });
}

async function rejected(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error('Expected rejection');
}

async function fixture(root: string) {
  const source = path.join(root, 'package');
  await mkdir(path.join(source, 'items'), { recursive: true });
  await mkdir(path.join(source, 'media'));
  const item = {
    apiName: 'source_api',
    contentKey: KEY,
    contentSpace: { id: 'space' },
    contentType: 'sfdc_cms__document',
    managedContentId: 'parent',
    managedContentVariantId: 'variant',
    managedContentVersionId: 'version-id',
    language: 'en_US',
    title: 'Source title',
    urlName: 'source-url',
    isPublished: false,
    lastModifiedDate: '2026-01-01T00:00:00.000Z',
    status: { status: 'Draft' },
    contentBody: {
      'sfdc_cms:media': {
        source: { type: 'file', ref: 'native-ref', size: BYTES.length, mimeType: 'text/plain' },
        url: sourceUrl,
      },
    },
  };
  const itemBytes = Buffer.from(`${JSON.stringify(item)}\n`);
  await writeFile(path.join(source, 'items/variant.json'), itemBytes);
  await writeFile(path.join(source, 'media/variant.txt'), BYTES);
  const media = {
    variantId: 'variant',
    contentKey: KEY,
    path: 'media/variant.txt',
    sha256: sha256(BYTES),
    md5,
    bytes: BYTES.length,
    mimeType: 'text/plain',
    fileName: 'fixture.txt',
    sourceStatus: 'Draft',
    sourceModifiedAt: item.lastModifiedDate,
    sourceVersion: '1.1',
    sourceUrl,
    transport: 'experimental-undocumented-authoring-media',
  };
  const manifest = {
    schemaVersion: 2,
    mode: 'experimental-best-effort',
    workspaceId: 'space',
    search: {
      contentSpaceOrFolderIds: ['space'],
      languages: ['All'],
      pageSize: 250,
      queryTerm: '*',
    },
    expectedCount: 1,
    foundCount: 1,
    exportedCount: 1,
    pagesRequested: 1,
    entries: [{ file: 'items/variant.json', variantId: 'variant' }],
    rejectedVariantIds: [],
    failedVariantIds: [],
    warnings: [],
    contract: 'sf-cms-workspace-export',
    contractVersion: '2.0.0',
    media: [media],
    provenance: {
      producer: 'sf-plugin-cms',
      sourceOrgId: 'org',
      sourceWorkspaceId: 'space',
      pluginVersion: '0.10.1',
      generatedAt: item.lastModifiedDate,
    },
    completeness: 'complete',
    dependencies: [],
    externalReferences: [],
    items: [
      { path: 'items/variant.json', sha256: sha256(itemBytes), kind: 'cms.content' },
      { path: media.path, sha256: media.sha256, kind: 'cms.media' },
    ],
  };
  await writeFile(path.join(source, 'manifest.json'), `${JSON.stringify(manifest)}\n`);
  return loadWorkspaceExport(source);
}

function requestStub(search?: unknown, detail?: unknown) {
  return sinon.stub().callsFake(({ method, url }: { method: string; url: string }) => {
    expect(method).to.equal('GET');
    if (url === '/connect/cms/spaces/target-space') return response({ id: 'target-space' });
    if (url.startsWith('/connect/cms/items/search')) {
      const query = new URL(url, 'https://example.test').searchParams;
      expect(query.get('contentSpaceOrFolderIds')).to.equal('target-space');
      expect(query.get('contentTypeFQN')).to.equal('sfdc_cms__document');
      expect(query.get('queryTerm')).to.equal('new_api');
      return response(search ?? { items: [], count: 0 });
    }
    if (url === '/connect/cms/contents/variants/existing') return response(detail);
    throw new Error(`Unexpected request ${url}`);
  });
}

function options(source: Awaited<ReturnType<typeof fixture>>, request = requestStub()) {
  return {
    source,
    plans: planDocumentImports(source, [map()]),
    connection: { request },
    destinationOrgId: 'target-org',
    destinationWorkspaceId: 'target-space',
  };
}

describe('Document import admission and read-only preflight', () => {
  let run: RunOwnedTemp;
  let root: string;
  beforeEach(async () => {
    run = await createRunOwnedTemp('cms-document-import-test');
    root = await createRunOwnedDirectory(run, 'fixture');
  });
  afterEach(async () => {
    await removeRunOwnedPath(run, root);
  });

  function applyOptions(
    source: Awaited<ReturnType<typeof fixture>>,
    change: Record<string, unknown> = {},
  ) {
    const detail = {
      ...source.items[0],
      apiName: 'new_api',
      title: 'New title',
      urlName: 'new-url',
      contentSpace: { id: 'target-space' },
      managedContentId: 'created-parent',
      managedContentVariantId: 'created-variant',
      ...change,
    };
    const request = sinon.stub().callsFake(({ method, url }: { method: string; url: string }) => {
      if (method === 'POST')
        return response({
          contentKey: KEY,
          managedContentId: 'created-parent',
          managedContentVariantId: 'created-variant',
        });
      if (url === '/connect/cms/spaces/target-space') return response({ id: 'target-space' });
      if (url.startsWith('/connect/cms/items/search')) return response({ items: [], count: 0 });
      if (url === '/connect/cms/contents/variants/created-variant') return response(detail);
      throw new Error(`Unexpected ${method} ${url}`);
    });
    const fetcher = sinon.stub().resolves(
      new Response(BYTES, {
        headers: { 'content-type': 'text/plain', 'content-length': String(BYTES.length) },
      }),
    );
    return {
      ...options(source, request),
      reportDirectory: path.join(root, 'report'),
      mediaOptions: {
        instanceUrl: 'https://example.my.salesforce.com',
        accessToken: 'fixture-token',
        fetch: fetcher as typeof fetch,
      },
    };
  }

  it('persists exclusive intent before exactly one POST and proves independent native metadata and bytes', async () => {
    const source = await fixture(root);
    const input = applyOptions(source);
    const request = input.connection.request;
    const original = request.getCall;
    expect(original).to.be.a('function');
    let intent: unknown;
    request.callsFake(
      async ({ method, url, body }: { method: string; url: string; body?: Buffer }) => {
        if (method === 'POST') {
          intent = JSON.parse(
            await readFile(path.join(input.reportDirectory, 'workspace-import-run.json'), 'utf8'),
          );
          expect(
            (intent as { operations: Array<{ requestSha256: string }> }).operations[0]
              .requestSha256,
          ).to.equal(sha256(body!));
          return {
            contentKey: KEY,
            managedContentId: 'created-parent',
            managedContentVariantId: 'created-variant',
          };
        }
        if (url === '/connect/cms/spaces/target-space') return { id: 'target-space' };
        if (url.startsWith('/connect/cms/items/search')) return { items: [], count: 0 };
        return {
          ...source.items[0],
          apiName: 'new_api',
          title: 'New title',
          urlName: 'new-url',
          contentSpace: { id: 'target-space' },
          managedContentId: 'created-parent',
          managedContentVariantId: 'created-variant',
        };
      },
    );
    const result = await applyDocumentImports(input);
    expect(intent).not.to.equal(undefined);
    expect(request.getCalls().filter((call) => call.args[0].method === 'POST')).to.have.length(1);
    expect(result.contractResult.assets[0]).to.include({
      byteProof: 'passed',
      metadataReadback: 'passed',
      operationStatus: 'succeeded',
    });
    expect(result.report.state).to.equal('completed');
    expect(await readFile(path.join(input.reportDirectory, 'document-readback.txt'))).to.deep.equal(
      BYTES,
    );
  });

  it('intent persistence failure and an existing journal directory cause zero POST', async () => {
    const source = await fixture(root);
    const input = applyOptions(source);
    const failure = new Error('intent failure');
    expect(
      await rejected(
        applyDocumentImports({
          ...input,
          reportPersistence: {
            rewrite: async () => {
              throw failure;
            },
          },
        }),
      ),
    ).to.equal('intent failure');
    expect(
      input.connection.request.getCalls().some((call) => call.args[0].method === 'POST'),
    ).to.equal(false);
    expect(
      await readFile(path.join(input.reportDirectory, 'workspace-import-run.json'), 'utf8'),
    ).to.include('pending');
    expect(await rejected(applyDocumentImports(input))).to.include('EEXIST');
    expect(
      input.connection.request.getCalls().some((call) => call.args[0].method === 'POST'),
    ).to.equal(false);
  });

  it('retains truthful pending ownership evidence after an ambiguous single POST', async () => {
    const source = await fixture(root);
    const input = applyOptions(source);
    const get = input.connection.request;
    get.callsFake(({ method, url }: { method: string; url: string }) => {
      if (method === 'POST')
        return Object.assign(Promise.reject(new Error('socket lost')), {
          stream: () => new PassThrough(),
        });
      return response(
        url.startsWith('/connect/cms/items/search')
          ? { items: [], count: 0 }
          : { id: 'target-space' },
      );
    });
    expect(await rejected(applyDocumentImports(input))).to.include('socket lost');
    expect(get.getCalls().filter((call) => call.args[0].method === 'POST')).to.have.length(1);
    const journal = JSON.parse(
      await readFile(path.join(input.reportDirectory, 'workspace-import-run.json'), 'utf8'),
    ) as { state: string; operations: Array<{ state: string }> };
    expect(journal.state).to.equal('ownership-uncertain');
    expect(journal.operations[0].state).to.equal('pending');
  });

  it('rejects metadata drift with no byte download or false success', async () => {
    const source = await fixture(root);
    const input = applyOptions(source, { managedContentId: 'wrong-parent' });
    expect(await rejected(applyDocumentImports(input))).to.include('metadata identity');
    expect((input.mediaOptions.fetch as sinon.SinonStub).called).to.equal(false);
    expect(
      await readFile(path.join(input.reportDirectory, 'workspace-import-run.json'), 'utf8'),
    ).to.include('ownership-uncertain');
  });

  it('rejects independent downloaded byte mismatch without reporting success', async () => {
    const source = await fixture(root);
    const input = applyOptions(source);
    (input.mediaOptions.fetch as sinon.SinonStub).resolves(
      new Response(Buffer.alloc(BYTES.length, 65), { headers: { 'content-type': 'text/plain' } }),
    );
    expect(await rejected(applyDocumentImports(input))).to.include('MD5');
    expect(
      await readFile(path.join(input.reportDirectory, 'workspace-import-run.json'), 'utf8'),
    ).not.to.include('succeeded');
  });

  it('reports post-CREATE journal failure honestly and never retries mutation', async () => {
    const source = await fixture(root);
    const input = applyOptions(source);
    let writes = 0;
    try {
      await applyDocumentImports({
        ...input,
        reportPersistence: {
          rewrite: async () => {
            writes += 1;
            if (writes > 1) throw new Error('journal lost');
          },
        },
      });
      throw new Error('Expected rejection');
    } catch (error) {
      const evidence = (error as Error & { documentImportEvidence: { report: { state: string } } })
        .documentImportEvidence;
      expect((error as Error).message).to.equal('journal lost');
      expect(evidence.report.state).to.equal('ownership-uncertain');
    }
    expect(
      input.connection.request.getCalls().filter((call) => call.args[0].method === 'POST'),
    ).to.have.length(1);
    expect(
      await readFile(path.join(input.reportDirectory, 'workspace-import-run.json'), 'utf8'),
    ).to.include('pending');
  });

  it('revalidates package immediately after intent with zero POST on tampering', async () => {
    const source = await fixture(root);
    const input = applyOptions(source);
    await rejected(
      applyDocumentImports({
        ...input,
        reportPersistence: {
          rewrite: async () => {
            await writeFile(path.join(source.sourceDirectory, 'media/variant.txt'), 'tampered');
          },
        },
      }),
    );
    expect(
      input.connection.request.getCalls().some((call) => call.args[0].method === 'POST'),
    ).to.equal(false);
  });

  it('admits one exact native text/plain txt selection with explicit identity strategies', async () => {
    const source = await fixture(root);
    const plans = planDocumentImports(source, [
      map({
        source: {
          family: 'cms',
          type: 'document',
          apiName: 'source_api',
          serverId: 'variant',
          workspaceId: 'space',
          language: 'en_US',
          title: 'Source title',
          version: 'version-id',
        },
      }),
    ]);
    expect(plans).to.have.length(1);
    expect(await readDocumentImportBytes(source, plans)).to.deep.equal(BYTES);
    expect(documentCreateInput(plans[0], 'target-space')).to.deep.equal({
      apiName: 'new_api',
      title: 'New title',
      urlName: 'new-url',
      contentSpaceOrFolderId: 'target-space',
    });
    expect(plans[0].identities.contentKey).to.deep.equal({ strategy: 'generated', source: KEY });
    expect(() => planImageImports(source, [map()])).to.throw('cms/image');
  });

  it('returns unchanged major2 planned evidence without files, reports or writes', async () => {
    const source = await fixture(root);
    const manifestBefore = await readFile(path.join(source.sourceDirectory, 'manifest.json'));
    const request = requestStub();
    const result = await preflightDocumentImports(options(source, request));
    expect(result.dryRun).to.equal(true);
    expect(result.contractResult).to.deep.include({
      status: 'planned',
      target: { orgId: 'target-org', workspaceId: 'target-space' },
    });
    expect(result.contractResult.assets[0]).to.deep.include({
      operationStatus: 'planned',
      reportStatus: 'not-created',
      metadataReadback: 'not-attempted',
      byteProof: 'unavailable',
    });
    expect(result.contractResult.assets[0].source.type).to.equal('document');
    expect(result.contractResult.assets[0].binary?.sha256).to.equal(sha256(BYTES));
    expect(request.callCount).to.equal(2);
    expect(await readFile(path.join(source.sourceDirectory, 'manifest.json'))).to.deep.equal(
      manifestBefore,
    );
    await loadWorkspaceExport(source.sourceDirectory);
  });

  it('rejects non-opt-in, extra/multiple rows, unsupported strategies and mismatched selectors', async () => {
    const source = await fixture(root);
    for (const input of [
      [],
      [map(), map()],
      [map({ extra: true })],
      [map({ source: { family: 'cms', type: 'image', apiName: 'source_api' } })],
      [map({ source: { family: 'cms', type: 'document', apiName: 'missing' } })],
      [
        map({
          source: { family: 'cms', type: 'document', apiName: 'source_api', serverId: 'wrong' },
        }),
      ],
      [
        map({
          source: { family: 'cms', type: 'document', apiName: 'source_api', language: 'wrong' },
        }),
      ],
      [map({ apiName: { strategy: 'generated' } })],
      [map({ title: { strategy: 'generated' } })],
      [map({ contentKey: { strategy: 'fresh', value: 'bad-key' } })],
      [map({ apiName: { strategy: 'fresh', value: 'source_api' } })],
      [map({ urlName: { strategy: 'fresh', value: 'INVALID_URL' } })],
      [map({ urlName: { strategy: 'generated', value: 'extra' } })],
    ]) {
      expect(() => planDocumentImports(source, input)).to.throw();
    }
    expect(() =>
      planDocumentImports({ ...source, manifest: { ...source.manifest, schemaVersion: 1 } }, [
        map(),
      ]),
    ).to.throw('strict manifest v2');
    expect(() =>
      planDocumentImports({ ...source, items: [...source.items, source.items[0]] }, [map()]),
    ).to.throw('exactly one native Document');
  });

  it('rejects unsupported native bodies, descriptor binding, MIME, extension and size', async () => {
    const source = await fixture(root);
    const descriptor = source.manifest.media![0];
    for (const change of [
      { mimeType: 'application/pdf' },
      { fileName: 'fixture.TXT' },
      { fileName: 'fixture' },
      { contentKey: 'MCBBBBBBBBBBBBBBBBBBBBBBBBBB' },
      { bytes: MAX_IMAGE_BYTES + 1 },
      { bytes: 0 },
      { sourceStatus: 'Published' },
      { sourceModifiedAt: 'different' },
      { sourceVersion: 'wrong' },
      { md5: 'a'.repeat(32) },
      { path: '../escape.txt' },
      { sha256: 'a'.repeat(64) },
    ]) {
      expect(() =>
        planDocumentImports(
          { ...source, manifest: { ...source.manifest, media: [{ ...descriptor, ...change }] } },
          [map()],
        ),
      ).to.throw();
    }
    for (const body of [
      {},
      { 'sfdc_cms:media': { source: { type: 'url' }, url: sourceUrl } },
      { ...source.items[0].contentBody, other: { ref: 'external' } },
    ]) {
      expect(() =>
        planDocumentImports(
          {
            ...source,
            items: [
              { ...source.items[0], contentBody: body as (typeof source.items)[0]['contentBody'] },
            ],
          },
          [map()],
        ),
      ).to.throw();
    }
    expect(() =>
      planDocumentImports({ ...source, manifest: { ...source.manifest, media: [] } }, [map()]),
    ).to.throw('exactly one bound media');
  });

  it('rejects coherently bound Unicode filenames before destination access and zero CREATE', async () => {
    const original = await fixture(root);
    const admitted = applyOptions(original);
    const manifestPath = path.join(original.sourceDirectory, 'manifest.json');
    const itemPath = path.join(original.sourceDirectory, 'items/variant.json');
    const originalManifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
      media: Array<{ fileName: string; sourceUrl: string }>;
      items: Array<{ sha256: string }>;
    };
    for (const fileName of [
      'owned\u010D.txt',
      'owned\u010A.txt',
      'owned\u0122.txt',
      'owned\u010D\u010AInjected.txt',
      'caf\u00E9.txt',
      '\u6587\u4EF6.txt',
    ]) {
      const manifest = structuredClone(originalManifest);
      const url = new URL(sourceUrl, 'https://example.test');
      url.searchParams.set('fileName', fileName);
      const boundUrl = `${url.pathname}${url.search}`;
      const item = structuredClone(original.items[0]);
      (item.contentBody['sfdc_cms:media'] as { url: string }).url = boundUrl;
      const itemBytes = Buffer.from(`${JSON.stringify(item)}\n`);
      manifest.items[0].sha256 = sha256(itemBytes);
      manifest.media[0].fileName = fileName;
      manifest.media[0].sourceUrl = boundUrl;
      await writeFile(itemPath, itemBytes);
      await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);
      const source = await loadWorkspaceExport(original.sourceDirectory);
      expect(() => planDocumentImports(source, [map()])).to.throw(
        'Document filename must contain only ASCII characters',
      );
      const input = { ...admitted, source };
      expect(await rejected(preflightDocumentImports(input))).to.equal(
        'Document filename must contain only ASCII characters',
      );
      expect(await rejected(applyDocumentImports(input))).to.equal(
        'Document filename must contain only ASCII characters',
      );
    }
    expect(admitted.connection.request.callCount).to.equal(0);
    expect((admitted.mediaOptions.fetch as sinon.SinonStub).callCount).to.equal(0);
  });

  it('rechecks local binary SHA/MD5/package before any destination request', async () => {
    const source = await fixture(root);
    const request = sinon.stub().throws(new Error('Must not reach destination'));
    const input = options(source, request);
    await writeFile(path.join(source.sourceDirectory, 'media/variant.txt'), 'tampered');
    expect(await rejected(preflightDocumentImports(input))).to.include('SHA-256');
    expect(request.called).to.equal(false);
  });

  it('rejects package, plan and MD5 tampering before destination access', async () => {
    const source = await fixture(root);
    const request = sinon.stub().throws(new Error('Must not reach destination'));
    const input = options(source, request);
    expect(
      await rejected(
        preflightDocumentImports({
          ...input,
          plans: [{ ...input.plans[0], media: { ...input.plans[0].media, path: '../escape.txt' } }],
        }),
      ),
    ).to.include('plan changed');
    expect(
      await rejected(
        preflightDocumentImports({
          ...input,
          source: { ...source, manifestSha256: 'a'.repeat(64) },
        }),
      ),
    ).to.include('package changed');
    const manifestPath = path.join(source.sourceDirectory, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
      media: Array<{ md5: string; sourceUrl: string }>;
    };
    manifest.media[0].md5 = 'b'.repeat(32);
    await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);
    const changed = await loadWorkspaceExport(source.sourceDirectory);
    expect(() => planDocumentImports(changed, [map()])).to.throw('hash/version URL evidence');
    expect(request.called).to.equal(false);
  });

  it('rejects coherent but false native MD5 evidence before destination access', async () => {
    const source = await fixture(root);
    const manifestPath = path.join(source.sourceDirectory, 'manifest.json');
    const itemPath = path.join(source.sourceDirectory, 'items/variant.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
      media: Array<{ md5: string; sourceUrl: string }>;
      items: Array<{ sha256: string }>;
    };
    const item = JSON.parse(await readFile(itemPath, 'utf8')) as {
      contentBody: { 'sfdc_cms:media': { url: string } };
    };
    const falseUrl = sourceUrl.replace(md5, 'b'.repeat(32));
    manifest.media[0].md5 = 'b'.repeat(32);
    manifest.media[0].sourceUrl = falseUrl;
    item.contentBody['sfdc_cms:media'].url = falseUrl;
    const itemBytes = Buffer.from(`${JSON.stringify(item)}\n`);
    manifest.items[0].sha256 = sha256(itemBytes);
    await writeFile(itemPath, itemBytes);
    await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);
    const coherent = await loadWorkspaceExport(source.sourceDirectory);
    const request = sinon.stub().throws(new Error('Must not reach destination'));
    expect(await rejected(preflightDocumentImports(options(coherent, request)))).to.include(
      'SHA-256/MD5/size',
    );
    expect(request.called).to.equal(false);
  });

  it('rejects scoped external refs and unlisted files without side effects', async () => {
    const source = await fixture(root);
    const referenced = {
      ...source,
      manifest: {
        ...source.manifest,
        externalReferences: [
          {
            referenceId: 'ref',
            owner: 'cms' as const,
            kind: 'file',
            source: { workspaceId: 'space', sourceId: 'variant' },
            portableKey: { scheme: 'cms-opaque-v1' as const, value: 'external' },
            required: true,
            resolution: 'unresolved' as const,
          },
        ],
      },
    };
    expect(() => planDocumentImports(referenced, [map()])).to.throw('external references');
    expect(() =>
      planDocumentImports(
        { ...source, manifest: { ...source.manifest, dependencies: ['unresolved'] } },
        [map()],
      ),
    ).to.throw('dependencies');
    for (const extra of [
      { references: [] },
      { referencesList: [] },
      { externalSource: {} },
      { externalId: 'external' },
    ]) {
      expect(() =>
        planDocumentImports(
          { ...source, items: [{ ...source.items[0], ...extra } as (typeof source.items)[0]] },
          [map()],
        ),
      ).to.throw('external references');
    }
    const request = sinon.stub().throws(new Error('Must not reach destination'));
    const input = options(source, request);
    await writeFile(path.join(source.sourceDirectory, 'unexpected.txt'), 'unexpected');
    expect(await rejected(preflightDocumentImports(input))).to.include('unlisted');
    expect(request.called).to.equal(false);
  });

  it('rejects an exact destination collision but not a fuzzy candidate', async () => {
    const source = await fixture(root);
    const search = {
      items: [
        {
          id: 'existing',
          type: 'ManagedContentVariantSearchResultRepresentation',
          managedContentSpaceId: 'target-space',
        },
      ],
      count: 1,
    };
    const detail = {
      managedContentVariantId: 'existing',
      apiName: 'new_api',
      contentSpace: { id: 'target-space' },
      contentType: { fullyQualifiedName: 'sfdc_cms__document' },
    };
    const request = requestStub(search, detail);
    expect(await rejected(preflightDocumentImports(options(source, request)))).to.include(
      'already exists',
    );
    const fuzzy = requestStub(search, { ...detail, apiName: 'new_api_suffix' });
    const result = await preflightDocumentImports(options(source, fuzzy));
    expect(result.dryRun).to.equal(true);
  });

  it('fails closed on malformed counts, workspace/type/variant drift and missing API names', async () => {
    const source = await fixture(root);
    const item = {
      id: 'existing',
      type: 'ManagedContentVariantSearchResultRepresentation',
      managedContentSpaceId: 'target-space',
    };
    const detail = {
      managedContentVariantId: 'existing',
      apiName: 'new_api',
      contentSpace: { id: 'target-space' },
      contentType: 'sfdc_cms__document',
    };
    for (const [search, readback] of [
      [{ items: [], count: 1 }, detail],
      [{ items: [item, item], count: 2 }, detail],
      [{ items: [{ ...item, managedContentSpaceId: 'wrong' }], count: 1 }, detail],
      [
        { items: [item], count: 1 },
        { ...detail, contentType: 'sfdc_cms__image' },
      ],
      [
        { items: [item], count: 1 },
        { ...detail, contentSpace: { id: 'wrong' } },
      ],
      [
        { items: [item], count: 1 },
        { ...detail, managedContentVariantId: 'wrong' },
      ],
      [
        { items: [item], count: 1 },
        { ...detail, apiName: undefined },
      ],
    ]) {
      expect(
        await rejected(preflightDocumentImports(options(source, requestStub(search, readback)))),
      ).not.to.equal('Expected rejection');
    }
  });

  it('checks explicit canonical content keys and accepts only existing missing-key policy', async () => {
    const source = await fixture(root);
    for (const statusCode of [404, 400, undefined, 403]) {
      const request = requestStub();
      const missing = Object.assign(new Error('Provide a valid content key, ID, or FQN.'), {
        statusCode,
        data: {
          errorCode: 'INVALID_ID_FIELD',
          message: 'Provide a valid content key, ID, or FQN.',
        },
      });
      request.callsFake(({ method, url }: { method: string; url: string }) => {
        expect(method).to.equal('GET');
        if (url === '/connect/cms/spaces/target-space') return response({ id: 'target-space' });
        if (url.startsWith('/connect/cms/items/search')) return response({ items: [], count: 0 });
        if (url === `/connect/cms/contents/${KEY}`)
          return Object.assign(Promise.reject(missing), { stream: () => new PassThrough() });
        throw new Error(`Unexpected request ${url}`);
      });
      const input = {
        ...options(source, request),
        plans: planDocumentImports(source, [map({ contentKey: { strategy: 'preserve' } })]),
      };
      if (statusCode === 403)
        expect(await rejected(preflightDocumentImports(input))).to.include('Provide a valid');
      else {
        const result = await preflightDocumentImports(input);
        expect(result.dryRun).to.equal(true);
      }
    }
  });
});
