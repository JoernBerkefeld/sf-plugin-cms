import { expect } from 'chai';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import sinon from 'sinon';
import { InvalidImageImportMapError } from '../../src/contracts/workspace-import.js';
import {
  applyImageImports,
  normalizeImageMultipartFilename,
  planImageImports,
  preflightImageImports,
} from '../../src/services/image-import.js';
import { loadWorkspaceExport } from '../../src/services/import-workspace.js';
import { CmsRequestError } from '../../src/transport/json-request.js';
import { buildImageCreateMultipart } from '../../src/transport/multipart-image-create.js';

type FakeRequest<T> = Promise<T> & { stream(): PassThrough };

function fakeRequest<T>(value: T): FakeRequest<T> {
  return Object.assign(Promise.resolve(value), { stream: () => new PassThrough() });
}

function failedRequest(value: unknown): FakeRequest<never> {
  return Object.assign(Promise.reject(value), { stream: () => new PassThrough() });
}

const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function map(overrides: Record<string, unknown> = {}) {
  return {
    source: { family: 'cms', type: 'image', apiName: 'source_api' },
    contentKey: { strategy: 'preserve' },
    apiName: { strategy: 'fresh', value: 'fresh_api' },
    title: { strategy: 'fresh', value: 'Fresh title' },
    urlName: { strategy: 'generated' },
    ...overrides,
  };
}

async function writePackage(
  root: string,
  schemaVersion: 1 | 2 = 2,
  mediaOverrides: { fileName?: string; mimeType?: string } = {},
) {
  const source = path.join(root, `v${schemaVersion}`);
  await mkdir(path.join(source, 'items'), { recursive: true });
  if (schemaVersion === 2) await mkdir(path.join(source, 'media'), { recursive: true });
  const item = {
    apiName: 'source_api',
    contentBody: { 'sfdc_cms:media': { source: { type: 'file' } } },
    contentKey: 'source-key',
    contentSpace: { id: 'space' },
    contentType: 'sfdc_cms__image',
    id: 'variant',
    language: 'en',
    title: 'Source title',
  };
  const itemBytes = Buffer.from(`${JSON.stringify(item)}\n`);
  await writeFile(path.join(source, 'items/variant.json'), itemBytes);
  if (schemaVersion === 2) await writeFile(path.join(source, 'media/variant.png'), PNG);
  const media = {
    variantId: 'variant',
    contentKey: 'source-key',
    path: 'media/variant.png',
    sha256: createHash('sha256').update(PNG).digest('hex'),
    md5: createHash('md5').update(PNG).digest('hex'),
    bytes: PNG.length,
    mimeType: mediaOverrides.mimeType ?? 'image/png',
    fileName: mediaOverrides.fileName ?? 'variant.png',
    sourceStatus: 'Draft',
    sourceModifiedAt: '2026-01-01T00:00:00.000Z',
    sourceVersion: '1',
    sourceUrl: '/cms/media/source-key',
    transport: 'experimental-undocumented-authoring-media',
  };
  const items = [
    {
      path: 'items/variant.json',
      sha256: createHash('sha256').update(itemBytes).digest('hex'),
      kind: 'cms.content',
    },
    ...(schemaVersion === 2 ? [{ path: media.path, sha256: media.sha256, kind: 'cms.media' }] : []),
  ];
  const manifest = {
    schemaVersion,
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
    warnings: [{ code: 'UNSUPPORTED_WILDCARD', message: 'experimental' }],
    contract: 'sf-cms-workspace-export',
    contractVersion: schemaVersion === 2 ? '2.0.0' : '1.0.0',
    ...(schemaVersion === 2 ? { media: [media] } : {}),
    provenance: {
      producer: 'sf-plugin-cms',
      sourceOrgId: 'org',
      sourceWorkspaceId: 'space',
      pluginVersion: '0.4.0',
      generatedAt: '2026-01-01T00:00:00.000Z',
    },
    completeness: 'complete',
    dependencies: [],
    externalReferences: [],
    items,
  };
  await writeFile(path.join(source, 'manifest.json'), `${JSON.stringify(manifest)}\n`);
  return source;
}

async function rejectionMessage(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error('Expected rejection');
}

describe('image import contracts and loader', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'cms-image-import-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('loads strict v2 offline and plans all identity strategies deterministically', async () => {
    const source = await loadWorkspaceExport(await writePackage(root), { profile: 'image' });
    const result = planImageImports(source, [map()]);
    expect(result).to.have.length(1);
    expect(result[0].identities).to.deep.equal({
      contentKey: { strategy: 'preserve', source: 'source-key', submitted: 'source-key' },
      apiName: { strategy: 'fresh', source: 'source_api', submitted: 'fresh_api' },
      title: { strategy: 'fresh', source: 'Source title', submitted: 'Fresh title' },
      urlName: { strategy: 'generated' },
    });
  });

  it('rejects v1 for image profile but permits v2 in the general loader without mutation', async () => {
    const v1 = await writePackage(root, 1);
    expect(await rejectionMessage(loadWorkspaceExport(v1, { profile: 'image' }))).to.include(
      'requires workspace package manifest version 2',
    );
    const v2 = await loadWorkspaceExport(await writePackage(root), { profile: 'general' });
    expect(v2.manifest.schemaVersion).to.equal(2);
  });

  it('normalizes safe multipart filenames from validated image MIME types', () => {
    expect(normalizeImageMultipartFilename('variant', 'image/png')).to.equal('variant.png');
    expect(normalizeImageMultipartFilename('variant.PNG', 'image/png')).to.equal('variant.PNG');
    expect(normalizeImageMultipartFilename('photo.jpeg', 'image/jpeg')).to.equal('photo.jpeg');
    expect(() => normalizeImageMultipartFilename('variant.gif', 'image/png')).to.throw(
      'filename extension does not match MIME type',
    );
    expect(() => normalizeImageMultipartFilename('variant', 'image/svg+xml')).to.throw(
      'MIME type is unsupported',
    );
  });

  it('rejects invalid maps, missing source values, duplicates, unknown and non-image selections', async () => {
    const loaded = await loadWorkspaceExport(await writePackage(root), { profile: 'image' });
    const cases = [
      [],
      [map({ source: { family: 'cms', type: 'image', apiName: 'missing' } })],
      [map(), map()],
      [map({ apiName: { strategy: 'fresh', value: 'source_api' } })],
      [map({ urlName: { strategy: 'preserve' } })],
      [map({ title: { strategy: 'generated' } })],
      [map({ contentKey: { strategy: 'generated', value: 'bad' } })],
      [map({ source: { family: 'cms', type: 'image', apiName: 'source_api', serverId: 'wrong' } })],
      [map({ source: { family: 'cms', type: 'fragment', apiName: 'source_api' } })],
    ];
    for (const value of cases)
      expect(() => planImageImports(loaded, value)).to.throw(InvalidImageImportMapError);
    const nonImage = { ...loaded, items: [{ ...loaded.items[0], contentType: 'sfdc_cms__news' }] };
    expect(() => planImageImports(nonImage, [map()])).to.throw('exactly one');
  });

  it('selects one or many by exact type-qualified API name with optional server binding', async () => {
    const loaded = await loadWorkspaceExport(await writePackage(root), { profile: 'image' });
    const secondItem = {
      ...loaded.items[0],
      id: 'variant-two',
      apiName: 'source_api_two',
      contentKey: 'source-key-two',
    };
    const secondMedia = {
      ...loaded.manifest.media![0],
      variantId: 'variant-two',
      contentKey: 'source-key-two',
      path: 'media/variant-two.png',
    };
    const multiple = {
      ...loaded,
      items: [...loaded.items, secondItem],
      manifest: { ...loaded.manifest, media: [...loaded.manifest.media!, secondMedia] },
    };
    const rows = [
      map({
        source: { family: 'cms', type: 'image', apiName: 'source_api_two' },
        contentKey: { strategy: 'fresh', value: 'two' },
      }),
      map({ source: { family: 'cms', type: 'image', apiName: 'source_api', serverId: 'variant' } }),
    ];
    expect(planImageImports(multiple, rows).map(({ source }) => source.apiName)).to.deep.equal([
      'source_api_two',
      'source_api',
    ]);
    const ambiguous = {
      ...loaded,
      items: [...loaded.items, { ...loaded.items[0], id: 'duplicate' }],
    };
    expect(() => planImageImports(ambiguous, [map()])).to.throw('exactly one');
    expect(() =>
      planImageImports(loaded, [
        map({ source: { family: 'cms', type: 'fragment', apiName: 'source_api' } }),
      ]),
    ).to.throw('cms/image');
  });

  it('rejects descriptor/item/file binding failures before org access', async () => {
    const source = await writePackage(root);
    await writeFile(path.join(source, 'media/variant.png'), Buffer.from('tampered'));
    expect(await rejectionMessage(loadWorkspaceExport(source, { profile: 'image' }))).to.include(
      'SHA-256',
    );
  });

  it('preflights exact destination workspace, image type, API name, and content key for dry-run evidence', async () => {
    const source = await loadWorkspaceExport(await writePackage(root), { profile: 'image' });
    const plans = planImageImports(source, [map()]);
    const request = sinon.stub().callsFake(({ url }: { url: string }) => {
      if (url === '/connect/cms/spaces/target-space') {
        return fakeRequest({ id: 'target-space', name: 'Target' });
      }
      if (url.startsWith('/connect/cms/items/search')) {
        const query = new URL(url, 'https://example.test').searchParams;
        expect(query.get('contentSpaceOrFolderIds')).to.equal('target-space');
        expect(query.get('contentTypeFQN')).to.equal('sfdc_cms__image');
        expect(query.get('queryTerm')).to.equal('fresh_api');
        return fakeRequest({ items: [], total: 0 });
      }
      if (url === '/connect/cms/contents/source-key') {
        return failedRequest({ data: { errorCode: 'NOT_FOUND' } });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    const result = await preflightImageImports({
      connection: { request },
      destinationOrgId: '00D-target',
      destinationWorkspaceId: 'target-space',
      plans,
      source,
    });

    expect(result.dryRun).to.equal(true);
    expect(result.contractResult).to.deep.include({
      sourcePackage: {
        manifestSha256: source.manifestSha256,
        workspaceId: 'space',
        manifestVersion: 2,
      },
      target: { orgId: '00D-target', workspaceId: 'target-space' },
      status: 'planned',
    });
    expect(result.contractResult.assets[0]).to.deep.include({
      resolution: {
        method: 'explicit-map',
        target: {
          family: 'cms',
          type: 'image',
          apiName: 'fresh_api',
          workspaceId: 'target-space',
        },
      },
      operationStatus: 'planned',
      reportStatus: 'not-created',
      metadataReadback: 'not-attempted',
      byteProof: 'unavailable',
    });
    expect(request.callCount).to.equal(3);
  });

  it('accepts the exact statusless live Salesforce missing-key shape during preflight', async () => {
    const source = await loadWorkspaceExport(await writePackage(root), { profile: 'image' });
    const plans = planImageImports(source, [map()]);
    const request = sinon.stub().callsFake(({ url }: { url: string }) => {
      if (url === '/connect/cms/spaces/target-space') return fakeRequest({ id: 'target-space' });
      if (url.startsWith('/connect/cms/items/search')) return fakeRequest({ items: [], total: 0 });
      if (url === '/connect/cms/contents/source-key') {
        return failedRequest(
          Object.assign(new Error('Provide a valid content key, ID, or FQN.'), {
            data: {
              errorCode: 'INVALID_ID_FIELD',
              message: 'Provide a valid content key, ID, or FQN.',
            },
            errorCode: 'INVALID_ID_FIELD',
            name: 'INVALID_ID_FIELD',
          }),
        );
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    const result = await preflightImageImports({
      connection: { request },
      destinationOrgId: '00D-target',
      destinationWorkspaceId: 'target-space',
      plans,
      source,
    });

    expect(result.contractResult.status).to.equal('planned');
    expect(request.callCount).to.equal(3);
  });

  it('fails closed on near-matches to the live Salesforce missing-key 400 shape', async () => {
    const source = await loadWorkspaceExport(await writePackage(root), { profile: 'image' });
    const plans = planImageImports(source, [map()]);
    const exactMessage = 'Provide a valid content key, ID, or FQN.';
    const nearMatches = [
      {
        data: { errorCode: 'INVALID_ID_FIELD', message: `${exactMessage}!` },
        statusCode: 400,
      },
      {
        data: { errorCode: 'INVALID_FIELD', message: exactMessage },
        statusCode: 400,
      },
      ...[200, 401, 500].map((statusCode) => ({
        data: { errorCode: 'INVALID_ID_FIELD', message: exactMessage },
        statusCode,
      })),
      {
        data: [
          { errorCode: 'INVALID_ID_FIELD', message: exactMessage },
          { errorCode: 'INVALID_ID_FIELD', message: exactMessage },
        ],
        statusCode: 400,
      },
      {
        data: { errorCode: 'INVALID_ID_FIELD' },
        statusCode: 400,
      },
      {
        data: 'malformed',
        statusCode: 400,
      },
      {
        data: { errorCode: 'INVALID_FIELD', message: exactMessage },
        statusCode: undefined,
      },
      {
        data: { errorCode: 'INVALID_ID_FIELD', message: `${exactMessage}!` },
        statusCode: undefined,
      },
      {
        data: [
          { errorCode: 'INVALID_ID_FIELD', message: exactMessage },
          { errorCode: 'INVALID_ID_FIELD', message: exactMessage },
        ],
        statusCode: undefined,
      },
      {
        data: 'malformed',
        statusCode: undefined,
      },
      {
        data: undefined,
        errorMessage: exactMessage,
        statusCode: undefined,
      },
    ];

    for (const shape of nearMatches) {
      const request = sinon.stub().callsFake(({ url }: { url: string }) => {
        if (url === '/connect/cms/spaces/target-space') return fakeRequest({ id: 'target-space' });
        if (url.startsWith('/connect/cms/items/search'))
          return fakeRequest({ items: [], total: 0 });
        if (url === '/connect/cms/contents/source-key') {
          return failedRequest(
            Object.assign(
              new Error('errorMessage' in shape ? shape.errorMessage : 'Request failed'),
              {
                data: shape.data,
                statusCode: shape.statusCode,
              },
            ),
          );
        }
        throw new Error(`Unexpected request: ${url}`);
      });

      expect(
        await rejectionMessage(
          preflightImageImports({
            connection: { request },
            destinationOrgId: '00D-target',
            destinationWorkspaceId: 'target-space',
            plans,
            source,
          }),
        ),
      ).to.equal('errorMessage' in shape ? shape.errorMessage : 'Request failed');
    }

    const wrongOperation = new CmsRequestError('workspace.get', 'Request failed', 400, {
      errorCode: 'INVALID_ID_FIELD',
      errorEntryCount: 1,
      responseMessage: exactMessage,
    });
    const wrongOperationRequest = sinon.stub().callsFake(({ url }: { url: string }) => {
      if (url === '/connect/cms/spaces/target-space') return fakeRequest({ id: 'target-space' });
      if (url.startsWith('/connect/cms/items/search')) return fakeRequest({ items: [], total: 0 });
      if (url === '/connect/cms/contents/source-key') return failedRequest(wrongOperation);
      throw new Error(`Unexpected request: ${url}`);
    });
    expect(
      await rejectionMessage(
        preflightImageImports({
          connection: { request: wrongOperationRequest },
          destinationOrgId: '00D-target',
          destinationWorkspaceId: 'target-space',
          plans,
          source,
        }),
      ),
    ).to.equal('Request failed');
  });

  it('validates every row before reporting an existing destination identity and makes no mutation', async () => {
    const source = await loadWorkspaceExport(await writePackage(root), { profile: 'image' });
    const secondItem = {
      ...source.items[0],
      id: 'variant-two',
      apiName: 'source_api_two',
      contentKey: 'source-key-two',
    };
    const secondMedia = {
      ...source.manifest.media![0],
      variantId: 'variant-two',
      contentKey: 'source-key-two',
      path: 'media/variant-two.png',
    };
    const multiple = {
      ...source,
      items: [...source.items, secondItem],
      manifest: { ...source.manifest, media: [...source.manifest.media!, secondMedia] },
    };
    const plans = planImageImports(multiple, [
      map(),
      map({
        source: { family: 'cms', type: 'image', apiName: 'source_api_two' },
        contentKey: { strategy: 'fresh', value: 'fresh-key-two' },
        apiName: { strategy: 'fresh', value: 'fresh_api_two' },
      }),
    ]);
    const searched: string[] = [];
    const request = sinon.stub().callsFake(({ method, url }: { method: string; url: string }) => {
      expect(method).to.equal('GET');
      if (url === '/connect/cms/spaces/target-space') return fakeRequest({ id: 'target-space' });
      if (url.startsWith('/connect/cms/items/search')) {
        const apiName = new URL(url, 'https://example.test').searchParams.get('queryTerm')!;
        searched.push(apiName);
        return fakeRequest(
          apiName === 'fresh_api_two'
            ? {
                items: [
                  {
                    id: 'existing-variant',
                    managedContentSpaceId: 'target-space',
                    type: 'ManagedContentVariantSearchResultRepresentation',
                  },
                ],
                total: 1,
              }
            : { items: [], total: 0 },
        );
      }
      if (url === '/connect/cms/contents/variants/existing-variant') {
        return fakeRequest({
          id: 'existing-variant',
          apiName: 'fresh_api_two',
          contentSpace: { id: 'target-space' },
          contentType: 'sfdc_cms__image',
        });
      }
      if (url.startsWith('/connect/cms/contents/')) {
        return failedRequest({ data: { errorCode: 'NOT_FOUND' } });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    expect(
      await rejectionMessage(
        preflightImageImports({
          connection: { request },
          destinationOrgId: '00D-target',
          destinationWorkspaceId: 'target-space',
          plans,
          source: multiple,
        }),
      ),
    ).to.include('already exists: fresh_api_two');
    expect(searched.toSorted()).to.deep.equal(['fresh_api', 'fresh_api_two']);
    expect(request.getCalls().every(({ args }) => args[0].method === 'GET')).to.equal(true);
  });

  it('applies extensionless PNG with exact corrected multipart bytes and hash evidence', async () => {
    const source = await loadWorkspaceExport(await writePackage(root, 2, { fileName: 'variant' }), {
      profile: 'image',
    });
    const plans = planImageImports(source, [
      map({
        contentKey: { strategy: 'generated' },
        urlName: { strategy: 'fresh', value: 'fresh-url' },
      }),
    ]);
    const reportDirectory = path.join(root, 'report');
    const snapshots: Array<{ operations: Array<{ state: string; requestSha256: string }> }> = [];
    let searches = 0;
    let posts = 0;
    let postedBodySha256 = '';
    const request = sinon
      .stub()
      .callsFake(
        ({
          body,
          headers,
          method,
          url,
        }: {
          body?: Buffer;
          headers?: Record<string, string>;
          method: string;
          url: string;
        }) => {
          if (url === '/connect/cms/spaces/target-space')
            return fakeRequest({ id: 'target-space' });
          if (url.startsWith('/connect/cms/items/search')) {
            searches += 1;
            return fakeRequest({ items: [], total: 0 });
          }
          if (url === '/connect/cms/contents' && method === 'POST') {
            posts += 1;
            expect(body).to.be.instanceOf(Buffer);
            expect(headers?.['content-type']).to.match(/^multipart\/form-data; boundary=/u);
            const boundary = headers?.['content-type'].split('boundary=')[1];
            expect(boundary).to.be.a('string').and.not.equal('');
            const expected = buildImageCreateMultipart(
              {
                apiName: 'fresh_api',
                contentSpaceOrFolderId: 'target-space',
                title: 'Fresh title',
                urlName: 'fresh-url',
              },
              'variant.png',
              PNG,
              { boundaryFactory: () => boundary! },
            );
            expect(body!.equals(expected.body)).to.equal(true);
            expect(body!.toString('latin1')).to.include(
              'filename="variant.png"\r\nContent-Type: application/octet-stream; charset=ISO-8859-1',
            );
            postedBodySha256 = createHash('sha256').update(body!).digest('hex');
            return fakeRequest({
              contentKey: 'generated-key',
              managedContentId: 'content-created',
              managedContentVariantId: 'variant-created',
            });
          }
          if (url === '/connect/cms/contents/variants/variant-created') {
            return fakeRequest({
              id: 'variant-created',
              apiName: 'fresh_api',
              contentKey: 'generated-key',
              title: 'Fresh title',
              urlName: 'fresh-url',
              contentSpace: { id: 'target-space' },
              contentType: 'sfdc_cms__image',
              isPublished: false,
              status: { status: 'Draft' },
            });
          }
          throw new Error(`Unexpected request: ${method} ${url}`);
        },
      );

    const result = await applyImageImports({
      connection: { request },
      destinationOrgId: '00D-target',
      destinationWorkspaceId: 'target-space',
      plans,
      reportDirectory,
      reportPersistence: {
        rewrite: async (file, report) => {
          snapshots.push(structuredClone(report));
          await writeFile(file, `${JSON.stringify(report, null, 2)}\n`);
        },
      },
      source,
    });

    expect(searches).to.equal(2);
    expect(posts).to.equal(1);
    const pending = snapshots.find(({ operations }) => operations.at(-1)?.state === 'pending');
    expect(pending?.operations.at(-1)?.requestSha256).to.equal(postedBodySha256);
    expect(result.contractResult.status).to.equal('completed');
    expect(result.contractResult.assets[0]).to.deep.include({
      metadataReadback: 'passed',
      byteProof: 'unavailable',
      operationStatus: 'succeeded',
      reportStatus: 'recorded',
    });
    expect(result.contractResult.assets[0].mutation).to.deep.include({
      contentId: 'content-created',
      variantId: 'variant-created',
    });
    expect(result.contractResult.assets[0].mutation?.requestSha256).to.equal(postedBodySha256);
    expect(result.contractResult.assets[0].identities).to.deep.include({
      contentKey: {
        strategy: 'generated',
        source: 'source-key',
        returned: 'generated-key',
      },
      apiName: {
        strategy: 'fresh',
        source: 'source_api',
        submitted: 'fresh_api',
        returned: 'fresh_api',
      },
    });
    expect(JSON.parse(await readFile(result.reportFile, 'utf8'))).to.deep.equal(result.report);
  });

  it('accepts the exact live missing-key 400 shape during the immediate TOCTOU recheck', async () => {
    const source = await loadWorkspaceExport(await writePackage(root), { profile: 'image' });
    const plans = planImageImports(source, [map()]);
    let contentKeyChecks = 0;
    let posts = 0;
    const request = sinon.stub().callsFake(({ method, url }: { method: string; url: string }) => {
      if (url === '/connect/cms/spaces/target-space') return fakeRequest({ id: 'target-space' });
      if (url.startsWith('/connect/cms/items/search')) return fakeRequest({ items: [], total: 0 });
      if (url === '/connect/cms/contents/source-key') {
        contentKeyChecks += 1;
        return failedRequest(
          Object.assign(new Error('Provide a valid content key, ID, or FQN.'), {
            data: {
              errorCode: 'INVALID_ID_FIELD',
              message: 'Provide a valid content key, ID, or FQN.',
            },
            errorCode: 'INVALID_ID_FIELD',
            name: 'INVALID_ID_FIELD',
            statusCode: 400,
          }),
        );
      }
      if (url === '/connect/cms/contents' && method === 'POST') {
        posts += 1;
        return fakeRequest({ contentKey: 'incomplete' });
      }
      throw new Error(`Unexpected request: ${method} ${url}`);
    });

    expect(
      await rejectionMessage(
        applyImageImports({
          connection: { request },
          destinationOrgId: '00D-target',
          destinationWorkspaceId: 'target-space',
          plans,
          reportDirectory: path.join(root, 'live-shape-report'),
          source,
        }),
      ),
    ).to.include('Malformed CMS image create response');
    expect(contentKeyChecks).to.equal(2);
    expect(posts).to.equal(1);
  });

  it('stops before POST when the immediate TOCTOU check observes a new conflict', async () => {
    const source = await loadWorkspaceExport(await writePackage(root), { profile: 'image' });
    const plans = planImageImports(source, [map()]);
    let searches = 0;
    const request = sinon.stub().callsFake(({ method, url }: { method: string; url: string }) => {
      if (url === '/connect/cms/spaces/target-space') return fakeRequest({ id: 'target-space' });
      if (url.startsWith('/connect/cms/items/search')) {
        searches += 1;
        return fakeRequest(
          searches === 1
            ? { items: [], total: 0 }
            : {
                items: [
                  {
                    id: 'raced-variant',
                    managedContentSpaceId: 'target-space',
                    type: 'ManagedContentVariantSearchResultRepresentation',
                  },
                ],
                total: 1,
              },
        );
      }
      if (url === '/connect/cms/contents/variants/raced-variant') {
        return fakeRequest({
          id: 'raced-variant',
          apiName: 'fresh_api',
          contentSpace: { id: 'target-space' },
          contentType: 'sfdc_cms__image',
        });
      }
      if (url === '/connect/cms/contents/source-key') {
        return failedRequest({ data: { errorCode: 'NOT_FOUND' } });
      }
      throw new Error(`Unexpected request: ${method} ${url}`);
    });

    expect(
      await rejectionMessage(
        applyImageImports({
          connection: { request },
          destinationOrgId: '00D-target',
          destinationWorkspaceId: 'target-space',
          plans,
          reportDirectory: path.join(root, 'conflict-report'),
          source,
        }),
      ),
    ).to.include('already exists: fresh_api');
    expect(request.getCalls().filter(({ args }) => args[0].method === 'POST')).to.have.length(0);
  });

  it('stops after an uncertain create response and preserves pending ownership evidence', async () => {
    const source = await loadWorkspaceExport(await writePackage(root), { profile: 'image' });
    const plans = planImageImports(source, [map()]);
    const reportDirectory = path.join(root, 'uncertain-report');
    let searches = 0;
    const request = sinon.stub().callsFake(({ method, url }: { method: string; url: string }) => {
      if (url === '/connect/cms/spaces/target-space') return fakeRequest({ id: 'target-space' });
      if (url.startsWith('/connect/cms/items/search')) {
        searches += 1;
        return fakeRequest({ items: [], total: 0 });
      }
      if (url === '/connect/cms/contents/source-key') {
        return failedRequest({ data: { errorCode: 'NOT_FOUND' } });
      }
      if (url === '/connect/cms/contents' && method === 'POST') {
        return fakeRequest({ contentKey: 'incomplete' });
      }
      throw new Error(`Unexpected request: ${method} ${url}`);
    });

    expect(
      await rejectionMessage(
        applyImageImports({
          connection: { request },
          destinationOrgId: '00D-target',
          destinationWorkspaceId: 'target-space',
          plans,
          reportDirectory,
          source,
        }),
      ),
    ).to.include('Malformed CMS image create response');
    const report = JSON.parse(
      await readFile(path.join(reportDirectory, 'workspace-import-run.json'), 'utf8'),
    ) as { state: string; operations: Array<{ state: string; error?: string }> };
    expect(searches).to.equal(2);
    expect(report.state).to.equal('ownership-uncertain');
    expect(report.operations).to.have.length(1);
    expect(report.operations[0]).to.include({ state: 'pending' });
  });

  it('fails closed on ambiguous exact API-name evidence and workspace/type drift', async () => {
    const source = await loadWorkspaceExport(await writePackage(root), { profile: 'image' });
    const plans = planImageImports(source, [map()]);
    for (const detail of [
      {
        id: 'one',
        apiName: 'fresh_api',
        contentSpace: { id: 'wrong-space' },
        contentType: 'sfdc_cms__image',
      },
      {
        id: 'one',
        apiName: 'fresh_api',
        contentSpace: { id: 'target-space' },
        contentType: 'sfdc_cms__news',
      },
    ]) {
      const request = sinon.stub().callsFake(({ url }: { url: string }) => {
        if (url === '/connect/cms/spaces/target-space') return fakeRequest({ id: 'target-space' });
        if (url.startsWith('/connect/cms/items/search')) {
          return fakeRequest({
            items: [
              {
                id: 'one',
                managedContentSpaceId: 'target-space',
                type: 'ManagedContentVariantSearchResultRepresentation',
              },
            ],
            total: 1,
          });
        }
        if (url === '/connect/cms/contents/variants/one') return fakeRequest(detail);
        throw new Error(`Unexpected request: ${url}`);
      });
      expect(
        await rejectionMessage(
          preflightImageImports({
            connection: { request },
            destinationOrgId: '00D-target',
            destinationWorkspaceId: 'target-space',
            plans,
            source,
          }),
        ),
      ).to.include('workspace/type/API-name scope');
    }
  });
});
