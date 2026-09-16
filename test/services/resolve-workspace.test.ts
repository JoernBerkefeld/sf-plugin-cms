import { PassThrough } from 'node:stream';
import { expect } from 'chai';
import sinon from 'sinon';
import { resolveWorkspace } from '../../src/services/resolve-workspace.js';

type FakeRequest<T> = Promise<T> & { stream(): PassThrough };

function fakeRequest<T>(value: T): FakeRequest<T> {
  return Object.assign(Promise.resolve(value), { stream: () => new PassThrough() });
}

function pageNumber(url: string): number {
  return Number(new URL(url, 'https://example.test').searchParams.get('page'));
}

describe('workspace resolver', () => {
  it('requires exactly one selector before a request', async () => {
    for (const selector of [{}, { workspaceId: 'id', workspaceName: 'name' }]) {
      const request = sinon.stub();
      try {
        await resolveWorkspace({ request }, selector);
        expect.fail('expected selector rejection');
      } catch (error) {
        expect((error as Error).message).to.include('exactly one');
      }
      expect(request.notCalled).to.equal(true);
    }
  });

  it('gets an ID directly and rejects a canonical mismatch', async () => {
    const request = sinon.stub().returns(fakeRequest({ id: 'different' }));
    try {
      await resolveWorkspace({ request }, { workspaceId: 'requested' });
      expect.fail('expected ID mismatch');
    } catch (error) {
      expect((error as Error).message).to.include('different');
    }
    expect(request.calledOnce).to.equal(true);
  });

  it('scans until an empty page for an exact case-insensitive name before getting the selected ID', async () => {
    const request = sinon.stub().callsFake(({ url }: { url: string }) => {
      if (url.startsWith('/connect/cms/spaces?')) {
        const page = pageNumber(url);
        return fakeRequest({
          currentPage: page,
          pageSize: 250,
          spaces:
            page === 0
              ? [
                  { id: 'wrong', name: 'Elsewhere' },
                  { id: 'chosen', name: 'MAIN' },
                ]
              : [],
          total: 2,
        });
      }
      return fakeRequest({ id: 'chosen', name: 'Main' });
    });

    const result = await resolveWorkspace({ request }, { workspaceName: 'Main' });

    expect(result.id).to.equal('chosen');
    expect(request.callCount).to.equal(3);
    expect(request.firstCall.args[0].url).to.equal(
      '/connect/cms/spaces?nameFragment=Main&page=0&pageSize=250',
    );
  });

  it('detects case-only duplicate names on a later page', async () => {
    const pages = [[{ id: 'one', name: 'Main' }], [{ id: 'two', name: 'MAIN' }], []];
    const request = sinon.stub().callsFake(({ url }: { url: string }) => {
      const page = pageNumber(url);
      return fakeRequest({ currentPage: page, pageSize: 100, spaces: pages[page] });
    });
    try {
      await resolveWorkspace({ request }, { workspaceName: 'Main' });
      expect.fail('expected ambiguity');
    } catch (error) {
      expect((error as Error).message).to.include('one, two');
    }
  });

  it('does not trust misleading totals and stops on an empty page', async () => {
    const pages = [[{ id: 'one', name: 'Main' }], [{ id: 'other', name: 'Other' }], []];
    const request = sinon.stub().callsFake(({ url }: { url: string }) => {
      if (!url.includes('?')) return fakeRequest({ id: 'one', name: 'Main' });
      const page = pageNumber(url);
      return fakeRequest({ currentPage: page + 1, pageSize: 100, spaces: pages[page], total: 1 });
    });
    await resolveWorkspace({ request }, { workspaceName: 'Main' });
    expect(request.callCount).to.equal(4);
  });

  it('enforces the finite page bound when pages remain unique and nonempty', async () => {
    const request = sinon.stub().callsFake(({ url }: { url: string }) => {
      const page = pageNumber(url);
      return fakeRequest({ spaces: [{ id: `space-${page}`, name: 'Other' }] });
    });
    try {
      await resolveWorkspace({ request }, { workspaceName: 'Main' });
      expect.fail('expected page-cap rejection');
    } catch (error) {
      expect((error as Error).message).to.include('1000-page safety limit');
    }
    expect(request.callCount).to.equal(1000);
  });

  it('rejects repeated nonempty pages', async () => {
    const request = sinon.stub().returns(fakeRequest({ spaces: [{ id: 'one', name: 'Main' }] }));
    try {
      await resolveWorkspace({ request }, { workspaceName: 'Main' });
      expect.fail('expected repeat rejection');
    } catch (error) {
      expect((error as Error).message).to.include('repeated');
    }
  });

  it('ignores list type conflicts for single-workspace name resolution', async () => {
    const pages = [
      [{ id: 'chosen', name: 'Main', spaceType: { apiName: 'marketing' } }],
      [
        { id: 'chosen', name: 'Main', spaceType: { apiName: 'content' } },
        { id: 'other', name: 'Other' },
      ],
      [],
    ];
    const request = sinon.stub().callsFake(({ url }: { url: string }) => {
      if (!url.includes('?')) return fakeRequest({ id: 'chosen', name: 'Main' });
      return fakeRequest({ spaces: pages[pageNumber(url)] ?? [] });
    });

    const result = await resolveWorkspace({ request }, { workspaceName: 'Main' });

    expect(result.id).to.equal('chosen');
    expect(request.callCount).to.equal(4);
  });

  it('rejects duplicate-only pages that make no progress', async () => {
    const request = sinon.stub().callsFake(({ url }: { url: string }) =>
      fakeRequest({
        spaces:
          pageNumber(url) === 0
            ? [{ id: 'one', name: 'Other' }]
            : [
                { id: 'one', name: 'Other' },
                { id: 'one', name: 'Other' },
              ],
      }),
    );
    try {
      await resolveWorkspace({ request }, { workspaceName: 'Main' });
      expect.fail('expected no-progress rejection');
    } catch (error) {
      expect((error as Error).message).to.include('no progress');
    }
  });

  it('rejects malformed and case-only ambiguous IDs', async () => {
    for (const pages of [
      [[{ name: 'Main' }]],
      [[{ id: 'ABC', name: 'Other' }], [{ id: 'abc', name: 'Main' }]],
    ]) {
      const request = sinon
        .stub()
        .callsFake(({ url }: { url: string }) =>
          fakeRequest({ spaces: pages[pageNumber(url)] ?? [] }),
        );
      try {
        await resolveWorkspace({ request }, { workspaceName: 'Main' });
        expect.fail('expected malformed/ambiguous ID rejection');
      } catch (error) {
        expect((error as Error).message).to.match(/malformed ID|differ only by case/iu);
      }
    }
  });
});
