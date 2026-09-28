import { expect } from 'chai';
import { createHash } from 'node:crypto';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import sinon from 'sinon';
import { exportWorkspace } from '../../src/services/export-workspace.js';

const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
type FakeRequest<T> = Promise<T> & { stream(): PassThrough };

function fakeRequest<T>(value: T): FakeRequest<T> {
  return Object.assign(Promise.resolve(value), { stream: () => new PassThrough() });
}

function imageDetail(modifiedAt = '2026-01-01T00:00:00.000Z') {
  const md5 = createHash('md5').update(PNG).digest('hex');
  return {
    contentBody: {
      'sfdc_cms:media': {
        source: { mimeType: 'image/png', ref: 'synthetic-ref', size: PNG.length, type: 'file' },
        url: `/cms/media/media-key?fileHash=${md5}&fileName=image.png&version=1`,
      },
    },
    contentKey: 'content-key',
    contentSpace: { id: 'space' },
    contentType: 'sfdc_cms__image',
    id: 'variant',
    isPublished: false,
    lastModifiedDate: modifiedAt,
    status: { status: 'Draft' },
  };
}

describe('experimental workspace media export', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'sf-plugin-cms-media-export-'));
  });

  afterEach(async () => {
    sinon.restore();
    await rm(root, { force: true, recursive: true });
  });

  it('fails closed on invalid media caps before requests or fetches', async () => {
    for (const value of [-1, 0, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53]) {
      for (const key of ['perImageBytes', 'totalBytes'] as const) {
        const request = sinon.stub();
        const fetcher = sinon.stub();
        let failure: unknown;
        try {
          await exportWorkspace({ request }, 'space', path.join(root, `${key}-${String(value)}`), {
            experimentalMedia: {
              accessToken: 'synthetic-token',
              fetch: fetcher,
              instanceUrl: 'https://tenant.my.salesforce.com',
              [key]: value,
            },
          });
        } catch (error) {
          failure = error;
        }
        expect(failure).to.be.instanceOf(TypeError);
        expect(request.notCalled).to.equal(true);
        expect(fetcher.notCalled).to.equal(true);
      }
    }
  });

  it('fails closed without opt-in and never invokes the binary transport', async () => {
    const request = sinon.stub().callsFake(({ url }: { url: string }) =>
      fakeRequest(
        url.startsWith('/connect/cms/items/search')
          ? {
              items: [
                {
                  id: 'variant',
                  managedContentSpaceId: 'space',
                  type: 'ManagedContentVariantSearchResultRepresentation',
                },
              ],
              total: 1,
            }
          : imageDetail(),
      ),
    );
    const globalFetch = sinon.stub(globalThis, 'fetch');

    const result = await exportWorkspace({ request }, 'space', path.join(root, 'disabled'));

    expect(result.manifest).to.include({
      completeness: 'partial',
      contractVersion: '2.0.0',
      schemaVersion: 2,
    });
    expect(result.manifest.media).to.deep.equal([]);
    expect(result.manifest.warnings.at(-1)).to.deep.equal({
      code: 'MEDIA_EXPORT_FAILED',
      message:
        'Image candidate JSON was exported without media binaries because --experimental-media was not enabled.',
      variantIds: ['variant'],
    });
    expect(result.manifest.items.map(({ kind }) => kind)).to.deep.equal(['cms.content']);
    expect(globalFetch.notCalled).to.equal(true);
    await expectRejectedAccess(path.join(result.destination, 'media'));
    expect(
      JSON.parse(await readFile(path.join(result.destination, 'items/variant.json'), 'utf8')),
    ).to.have.property('contentKey', 'content-key');
  });

  it('clamps oversized per-file caps to the locked 10 MiB maximum', async () => {
    const detail = imageDetail();
    detail.contentBody['sfdc_cms:media'].source.size = 10 * 1024 * 1024 + 1;
    const request = sinon.stub().callsFake(({ url }: { url: string }) =>
      fakeRequest(
        url.startsWith('/connect/cms/items/search')
          ? {
              items: [
                {
                  id: 'variant',
                  managedContentSpaceId: 'space',
                  type: 'ManagedContentVariantSearchResultRepresentation',
                },
              ],
              total: 1,
            }
          : detail,
      ),
    );
    const fetcher = sinon.stub().resolves(
      new Response(PNG, {
        headers: {
          'content-length': String(10 * 1024 * 1024 + 1),
          'content-type': 'image/png',
        },
        status: 200,
      }),
    );
    const result = await exportWorkspace({ request }, 'space', path.join(root, 'clamped'), {
      experimentalMedia: {
        accessToken: 'synthetic-token',
        fetch: fetcher,
        instanceUrl: 'https://tenant.my.salesforce.com',
        perImageBytes: Number.MAX_SAFE_INTEGER,
        totalBytes: Number.MAX_SAFE_INTEGER,
      },
    });
    expect(result.manifest.completeness).to.equal('partial');
    expect(result.manifest.warnings.at(-1)?.message).to.include('exceeds the cap');
    expect(fetcher.calledOnce).to.equal(true);
  });

  it('writes a strict v2 media descriptor after byte and immediate source revalidation', async () => {
    const request = sinon.stub().callsFake(({ url }: { url: string }) =>
      fakeRequest(
        url.startsWith('/connect/cms/items/search')
          ? {
              items: [
                {
                  id: 'variant',
                  managedContentSpaceId: 'space',
                  type: 'ManagedContentVariantSearchResultRepresentation',
                },
              ],
              total: 1,
            }
          : imageDetail(),
      ),
    );
    let fetchCalls = 0;
    const fetcher = sinon.stub().callsFake(async () => {
      fetchCalls += 1;
      return fetchCalls === 1
        ? new Response(null, {
            headers: {
              location: `https://tenant.file.force.com/cms/media/media-key?fileHash=${createHash('md5').update(PNG).digest('hex')}&fileName=image.png&version=1`,
            },
            status: 301,
          })
        : new Response(PNG, {
            headers: { 'content-length': String(PNG.length), 'content-type': 'image/png' },
            status: 200,
          });
    });
    const result = await exportWorkspace({ request }, 'space', path.join(root, 'export'), {
      experimentalMedia: {
        accessToken: 'synthetic-token',
        fetch: fetcher,
        instanceUrl: 'https://tenant.my.salesforce.com',
      },
    });
    expect(result.manifest).to.include({
      contractVersion: '2.0.0',
      schemaVersion: 2,
    });
    expect(result.manifest.warnings.map(({ code }) => code)).not.to.include('MEDIA_EXPORT_FAILED');
    expect(result.manifest.media).to.have.length(1);
    expect(result.manifest.media?.[0]).to.include({
      bytes: PNG.length,
      mimeType: 'image/png',
      sourceStatus: 'Draft',
      transport: 'experimental-undocumented-authoring-media',
    });
    expect(
      await readFile(path.join(result.destination, result.manifest.media![0].path)),
    ).to.deep.equal(PNG);
    expect(request.callCount).to.equal(3);
    expect(fetchCalls).to.equal(2);
  });

  it('keeps authoring JSON and emits stable partial diagnostics when the source reread is stale', async () => {
    let detailReads = 0;
    const request = sinon.stub().callsFake(({ url }: { url: string }) =>
      fakeRequest(
        url.startsWith('/connect/cms/items/search')
          ? {
              items: [
                {
                  id: 'variant',
                  managedContentSpaceId: 'space',
                  type: 'ManagedContentVariantSearchResultRepresentation',
                },
              ],
              total: 1,
            }
          : imageDetail(detailReads++ === 0 ? undefined : '2026-01-02T00:00:00.000Z'),
      ),
    );
    let fetchCalls = 0;
    const fetcher = async (): Promise<Response> => {
      fetchCalls += 1;
      return fetchCalls === 1
        ? new Response(null, {
            headers: {
              location: `https://tenant.file.force.com/cms/media/media-key?fileHash=${createHash('md5').update(PNG).digest('hex')}&fileName=image.png&version=1`,
            },
            status: 301,
          })
        : new Response(PNG, {
            headers: { 'content-length': String(PNG.length), 'content-type': 'image/png' },
            status: 200,
          });
    };
    const result = await exportWorkspace({ request }, 'space', path.join(root, 'partial'), {
      experimentalMedia: {
        accessToken: 'synthetic-token',
        fetch: fetcher,
        instanceUrl: 'https://tenant.my.salesforce.com',
      },
    });
    expect(result.manifest.completeness).to.equal('partial');
    expect(result.manifest.warnings.at(-1)).to.deep.include({
      code: 'MEDIA_EXPORT_FAILED',
      variantIds: ['variant'],
    });
    expect(result.manifest.media).to.deep.equal([]);
    await expectRejectedAccess(path.join(result.destination, 'media/variant-image.png'));
    expect(
      JSON.parse(await readFile(path.join(result.destination, 'items/variant.json'), 'utf8')),
    ).to.have.property('contentKey', 'content-key');
    expect(fetchCalls).to.equal(2);
  });
});

async function expectRejectedAccess(file: string): Promise<void> {
  let failure: unknown;
  try {
    await access(file);
  } catch (error) {
    failure = error;
  }
  expect((failure as NodeJS.ErrnoException).code).to.equal('ENOENT');
}
