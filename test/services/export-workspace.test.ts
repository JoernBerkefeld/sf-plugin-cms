import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { expect } from 'chai';
import sinon from 'sinon';
import {
  defaultWorkspaceDestination,
  exportWorkspace,
  safeWorkspaceDirectoryName,
} from '../../src/services/export-workspace.js';

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

function detail(id: string, workspaceId = 'space', overrides = {}) {
  return { contentSpace: { id: workspaceId }, id, value: `value-${id}`, ...overrides };
}

function pageNumber(url: string): number {
  return Number(new URL(url, 'https://example.test').searchParams.get('page'));
}

describe('workspace export service', () => {
  let root: string;

  it('sanitizes default workspace directory names portably', () => {
    expect(safeWorkspaceDirectoryName('Café / Launch:*? ')).to.equal('Café _ Launch___');
    expect(defaultWorkspaceDestination('Main')).to.equal(path.join('.', 'cms', 'Main'));
    for (const name of ['', '.', '..', 'CON', 'lpt1.txt', '...   ']) {
      expect(() => safeWorkspaceDirectoryName(name)).to.throw('--output-dir');
    }
  });

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
    expect(result.manifest).to.include({
      schemaVersion: 1,
      contract: 'sf-cms-workspace-export',
      contractVersion: '1.0.0',
      completeness: 'complete',
    });
    expect(result.manifest.items.map(({ path: itemPath }) => itemPath)).to.deep.equal([
      'items/a.json',
      'items/b.json',
    ]);
    expect(result.manifest.items.every(({ sha256 }) => /^[a-f\d]{64}$/u.test(sha256))).to.equal(
      true,
    );
    expect(result.manifestSha256).to.match(/^[a-f\d]{64}$/u);
    expect(await readdir(path.join(destination, 'items'))).to.deep.equal(['a.json', 'b.json']);
  });

  it('inventories evidenced CMS content identity without inspecting unknown payload fields', async () => {
    const request = sinon.stub().callsFake(({ url }: { url: string }) => {
      if (url.startsWith('/connect/cms/items/search')) {
        return fakeRequest({ items: [row('variant-b'), row('variant-a')], total: 2 });
      }
      const id = decodeURIComponent(url.split('/').at(-1) ?? '');
      return fakeRequest(
        detail(id, 'space', {
          contentId: 'content-1',
          contentKey: 'Opaque/Key + Exact',
          nestedUnknown: { linkedContentId: 'do-not-infer' },
        }),
      );
    });

    const { manifest } = await exportWorkspace({ request }, 'space', path.join(root, 'export'));

    expect(manifest.completeness).to.equal('complete');
    expect(manifest.externalReferences).to.have.length(1);
    expect(manifest.externalReferences[0]).to.deep.include({
      kind: 'cms.content',
      source: { workspaceId: 'space', sourceId: 'content-1' },
      portableKey: { scheme: 'cms-opaque-v1', value: 'Opaque/Key + Exact' },
      resolution: 'included',
    });
    expect(manifest.dependencies).to.deep.equal([]);
    expect(manifest.items.map(({ referenceId }) => referenceId)).to.deep.equal([
      manifest.externalReferences[0].referenceId,
      manifest.externalReferences[0].referenceId,
    ]);
    expect(JSON.stringify(manifest)).not.to.include('do-not-infer');
  });

  it('emits unsupported relationships only when relationship fields are encountered', async () => {
    const referenceRoot = await mkdtemp(path.join(tmpdir(), 'sf-plugin-cms-reference-'));
    const request = sinon.stub().callsFake((request_: { url: string }) => {
      if (request_.url.includes('/connect/cms/items/search')) {
        return fakeRequest({ items: [row('with-reference')], total: 1 });
      }
      return fakeRequest(
        detail('with-reference', 'space', {
          contentId: 'content-1',
          contentKey: 'key-1',
          contentBody: {
            bannerImage: { ref: { contentKey: 'key-2', type: 'imageReference' } },
          },
        }),
      );
    });

    const { manifest } = await exportWorkspace(
      { request },
      'space',
      path.join(referenceRoot, 'export'),
    );

    expect(manifest.completeness).to.equal('partial');
    expect(manifest.dependencies).to.deep.equal([]);
    expect(manifest.externalReferences).to.deep.include.members([
      {
        referenceId: manifest.externalReferences.find(({ kind }) => kind === 'cms.relationship')!
          .referenceId,
        owner: 'cms',
        kind: 'cms.relationship',
        resolution: 'unsupported',
        source: { workspaceId: 'space', sourceId: 'with-reference' },
        portableKey: { scheme: 'cms-opaque-v1', value: 'with-reference' },
        required: true,
      },
    ]);
    expect(manifest.warnings.map(({ code }) => code)).to.include('REFERENCE_UNSUPPORTED');
    await rm(referenceRoot, { force: true, recursive: true });
  });

  it('marks ownership-ambiguous and identity-incomplete references explicitly', async () => {
    const request = sinon.stub().callsFake(({ url }: { url: string }) => {
      if (url.startsWith('/connect/cms/items/search')) {
        return fakeRequest({
          items: [row('ambiguous-a'), row('ambiguous-b'), row('unresolved')],
          total: 3,
        });
      }
      const id = decodeURIComponent(url.split('/').at(-1) ?? '');
      if (id === 'unresolved') return fakeRequest(detail(id, 'space', { contentKey: 'key-only' }));
      return fakeRequest(
        detail(id, 'space', {
          contentId: id === 'ambiguous-a' ? 'content-a' : 'content-b',
          contentKey: 'shared-key',
        }),
      );
    });

    const { manifest } = await exportWorkspace({ request }, 'space', path.join(root, 'export'));

    expect(manifest.completeness).to.equal('partial');
    expect(manifest.dependencies).to.deep.equal([]);
    expect(manifest.externalReferences.every(({ kind }) => kind === 'cms.unknown')).to.equal(true);
    expect(
      manifest.externalReferences.filter(({ resolution }) => resolution === 'unsupported'),
    ).to.have.length(2);
    expect(
      manifest.externalReferences.filter(({ resolution }) => resolution === 'unresolved'),
    ).to.have.length(1);
    expect(manifest.warnings.map(({ code }) => code)).to.include.members([
      'REFERENCE_UNRESOLVED',
      'REFERENCE_UNSUPPORTED',
    ]);
    expect(manifest.items.every(({ referenceId }) => referenceId === undefined)).to.equal(true);
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
    expect(manifest.completeness).to.equal('partial');
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

  it('creates missing destination parents and keeps sibling defaults distinct', async () => {
    const request = sinon.stub().returns(fakeRequest({ items: [], total: 0 }));
    const first = path.join(root, 'cms', safeWorkspaceDirectoryName('One'));
    const second = path.join(root, 'cms', safeWorkspaceDirectoryName('Two'));

    await exportWorkspace({ request }, 'one', first);
    await exportWorkspace({ request }, 'two', second);

    expect(await readdir(path.join(root, 'cms'))).to.deep.equal(['One', 'Two']);
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
