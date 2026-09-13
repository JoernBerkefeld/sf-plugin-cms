import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { expect } from 'chai';
import sinon from 'sinon';
import { exportWorkspace } from '../../src/services/export-workspace.js';

type FakeRequest<T> = Promise<T> & { stream(): PassThrough };

function fakeRequest<T>(value: T): FakeRequest<T> {
  return Object.assign(Promise.resolve(value), { stream: () => new PassThrough() });
}

function failedRequest(message = 'detail failed'): FakeRequest<never> {
  return Object.assign(Promise.reject(new Error(message)), { stream: () => new PassThrough() });
}

function row(id: string, managedContentSpaceId = 'space') {
  return { id, managedContentSpaceId, type: 'ManagedContentVariantSearchResultRepresentation' };
}

function detail(id: string, workspaceId = 'space') {
  return { contentSpace: { id: workspaceId }, id, value: `value-${id}` };
}

function pageNumber(url: string): number {
  return Number(new URL(url, 'https://example.test').searchParams.get('page'));
}

describe('workspace export service', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'sf-plugin-cms-export-'));
  });

  afterEach(async () => {
    await rm(root, { force: true, recursive: true });
  });

  it('exports sorted details when the advertised count is satisfied', async () => {
    const request = sinon.stub().callsFake(({ url }: { url: string }) => {
      if (url.startsWith('/connect/cms/items/search'))
        return fakeRequest({ items: [row('b'), row('a')], total: 2 });
      return fakeRequest(detail(decodeURIComponent(url.split('/').at(-1) ?? '')));
    });
    const destination = path.join(root, 'export');

    const result = await exportWorkspace({ request }, 'space', destination);

    expect(result.manifest).to.include({
      expectedCount: 2,
      foundCount: 2,
      exportedCount: 2,
      pagesRequested: 1,
    });
    expect(result.manifest.entries).to.deep.equal([
      { file: 'items/a.json', variantId: 'a' },
      { file: 'items/b.json', variantId: 'b' },
    ]);
    expect(result.manifest.warnings[0].code).to.equal('UNSUPPORTED_WILDCARD');
    expect(await readdir(path.join(destination, 'items'))).to.deep.equal(['a.json', 'b.json']);
  });

  it('reconstructs every multi-page search query and ignores nextPageUri', async () => {
    const searchUrls: string[] = [];
    const request = sinon.stub().callsFake(({ url }: { url: string }) => {
      if (url.startsWith('/connect/cms/items/search')) {
        searchUrls.push(url);
        const page = pageNumber(url);
        return fakeRequest({
          items: page === 0 ? [row('a')] : [row('b')],
          nextPageUri: '/wrong?page=99&token=secret',
          total: 2,
        });
      }
      return fakeRequest(detail(decodeURIComponent(url.split('/').at(-1) ?? '')));
    });

    await exportWorkspace({ request }, 'space', path.join(root, 'export'));

    expect(searchUrls).to.deep.equal([
      '/connect/cms/items/search?contentSpaceOrFolderIds=space&languages=All&page=0&pageSize=250&queryTerm=*',
      '/connect/cms/items/search?contentSpaceOrFolderIds=space&languages=All&page=1&pageSize=250&queryTerm=*',
    ]);
  });

  it('stops on an empty page despite a next link and warns about the mismatch', async () => {
    const request = sinon.stub().callsFake(({ url }: { url: string }) => {
      if (url.startsWith('/connect/cms/items/search')) {
        return fakeRequest(
          pageNumber(url) === 0
            ? { items: [row('a')], total: 3 }
            : { items: [], nextPageUri: '/keep-going', total: 3 },
        );
      }
      return fakeRequest(detail('a'));
    });

    const { manifest } = await exportWorkspace({ request }, 'space', path.join(root, 'export'));

    expect(manifest.pagesRequested).to.equal(2);
    expect(manifest.warnings.map(({ code }) => code)).to.include.members([
      'PREMATURE_EMPTY_PAGE',
      'COUNT_MISMATCH',
    ]);
  });

  it('stops on a duplicate-only nonempty page and aggregates duplicate IDs', async () => {
    const request = sinon.stub().callsFake(({ url }: { url: string }) => {
      if (url.startsWith('/connect/cms/items/search')) {
        return fakeRequest(
          pageNumber(url) === 0
            ? { items: [row('a')], total: 4 }
            : { items: [row('a'), row('a')], total: 4 },
        );
      }
      return fakeRequest(detail('a'));
    });

    const { manifest } = await exportWorkspace({ request }, 'space', path.join(root, 'export'));

    expect(manifest.pagesRequested).to.equal(2);
    expect(
      manifest.warnings.find(({ code }) => code === 'DUPLICATE_VARIANTS')?.variantIds,
    ).to.deep.equal(['a']);
    expect(manifest.warnings.some(({ code }) => code === 'COUNT_MISMATCH')).to.equal(true);
  });

  it('continues after partial duplicates add a new variant', async () => {
    const request = sinon.stub().callsFake(({ url }: { url: string }) => {
      if (url.startsWith('/connect/cms/items/search')) {
        const pages = [[row('a')], [row('a'), row('b')], [row('c')]];
        return fakeRequest({ items: pages[pageNumber(url)], total: 3 });
      }
      return fakeRequest(detail(decodeURIComponent(url.split('/').at(-1) ?? '')));
    });

    const { manifest } = await exportWorkspace({ request }, 'space', path.join(root, 'export'));

    expect(manifest.pagesRequested).to.equal(3);
    expect(manifest.entries.map(({ variantId }) => variantId)).to.deep.equal(['a', 'b', 'c']);
  });

  it('handles an advertised zero count with one search and no details', async () => {
    const request = sinon.stub().returns(fakeRequest({ items: [], total: 0 }));

    const { manifest } = await exportWorkspace({ request }, 'space', path.join(root, 'export'));

    expect(manifest).to.include({
      expectedCount: 0,
      foundCount: 0,
      exportedCount: 0,
      pagesRequested: 1,
    });
    expect(request.callCount).to.equal(1);
  });

  it('rejects search and detail ownership drift', async () => {
    const request = sinon.stub().callsFake(({ url }: { url: string }) => {
      if (url.startsWith('/connect/cms/items/search'))
        return fakeRequest({
          items: [row('search-drift', 'other'), row('detail-drift')],
          total: 2,
        });
      return fakeRequest(detail('detail-drift', 'other'));
    });

    const { manifest } = await exportWorkspace({ request }, 'space', path.join(root, 'export'));

    expect(manifest.exportedCount).to.equal(0);
    expect(manifest.rejectedVariantIds).to.deep.equal(['detail-drift', 'search-drift']);
    expect(
      manifest.warnings.find(({ code }) => code === 'OWNERSHIP_MISMATCH')?.variantIds,
    ).to.deep.equal(['detail-drift', 'search-drift']);
  });

  it('records detail failures and publishes successful details', async () => {
    const request = sinon.stub().callsFake(({ url }: { url: string }) => {
      if (url.startsWith('/connect/cms/items/search'))
        return fakeRequest({ items: [row('bad'), row('good')], total: 2 });
      return url.endsWith('/bad') ? failedRequest() : fakeRequest(detail('good'));
    });

    const { manifest } = await exportWorkspace({ request }, 'space', path.join(root, 'export'));

    expect(manifest.failedVariantIds).to.deep.equal(['bad']);
    expect(manifest.entries).to.deep.equal([{ file: 'items/good.json', variantId: 'good' }]);
    expect(manifest.warnings.some(({ code }) => code === 'DETAIL_FAILED')).to.equal(true);
  });

  it('rejects an existing destination before making remote requests or writes', async () => {
    const destination = path.join(root, 'export');
    await writeFile(destination, 'keep', 'utf8');
    const request = sinon.stub();

    try {
      await exportWorkspace({ request }, 'space', destination);
      expect.fail('expected destination rejection');
    } catch (error) {
      expect((error as Error).message).to.include('already exists');
    }
    expect(request.callCount).to.equal(0);
    expect(await readFile(destination, 'utf8')).to.equal('keep');
  });

  it('writes stable two-space JSON bytes with a final LF', async () => {
    const request = sinon
      .stub()
      .callsFake(({ url }: { url: string }) =>
        url.startsWith('/connect/cms/items/search')
          ? fakeRequest({ items: [row('a')], total: 1 })
          : fakeRequest(detail('a')),
      );
    const destination = path.join(root, 'export');

    const { manifest } = await exportWorkspace({ request }, 'space', destination);

    expect(await readFile(path.join(destination, 'items', 'a.json'), 'utf8')).to.equal(
      `${JSON.stringify(detail('a'), null, 2)}\n`,
    );
    expect(await readFile(path.join(destination, 'manifest.json'), 'utf8')).to.equal(
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
    expect(JSON.stringify(manifest)).not.to.match(/token|timestamp/iu);
  });

  it('cleans the temporary directory and never publishes after a write failure', async () => {
    const request = sinon
      .stub()
      .callsFake(({ url }: { url: string }) =>
        url.startsWith('/connect/cms/items/search')
          ? fakeRequest({ items: [row('missing/child')], total: 1 })
          : fakeRequest(detail('missing/child')),
      );
    const destination = path.join(root, 'export');

    try {
      await exportWorkspace({ request }, 'space', destination);
      expect.fail('expected write failure');
    } catch (error) {
      expect(error).to.be.instanceOf(Error);
    }
    expect(await readdir(root)).to.deep.equal([]);
  });
});
