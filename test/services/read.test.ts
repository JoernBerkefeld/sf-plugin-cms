import { PassThrough } from 'node:stream';
import { expect } from 'chai';
import sinon from 'sinon';
import {
  getChannel,
  getContent,
  getVariant,
  getWorkspace,
  listWorkspaceChannels,
  listWorkspaces,
  listAllWorkspaces,
  listAllWorkspaceChannels,
} from '../../src/services/read.js';

type FakeRequest<T> = Promise<T> & { stream(): PassThrough };

function fakeRequest<T>(value: T): FakeRequest<T> {
  return Object.assign(Promise.resolve(value), { stream: () => new PassThrough() });
}

describe('CMS aggregate read services', () => {
  for (const channels of [false, true]) {
    const label = channels ? 'channels' : 'workspaces';
    const run = (request: sinon.SinonStub, query = {}) =>
      channels
        ? listAllWorkspaceChannels({ request }, 'space/id', query)
        : listAllWorkspaces({ request }, query);
    const envelope = (items: unknown[], navigation: Record<string, unknown> = {}) =>
      channels
        ? { spaceChannels: items.map((channelSummary) => ({ channelSummary })), ...navigation }
        : { spaces: items, ...navigation };

    it(`aggregates ${label} sequentially with exact filters, first-seen records and null termination`, async () => {
      const first = {
        id: 'one',
        spaceType: { apiName: 'marketing' },
        extras: [null, { deep: ['kept'] }],
      };
      const second = { id: 'two', nested: { complete: true } };
      const request = sinon.stub();
      request
        .onCall(0)
        .returns(fakeRequest(envelope([first], { nextPageUrl: '/ignored?page=99', total: 1 })));
      request
        .onCall(1)
        .returns(
          fakeRequest(envelope([{ id: 'one', changed: true }, second], { nextPageUrl: null })),
        );
      const query = { ...(channels ? {} : { nameFragment: 'Main & More' }), page: 8, pageSize: 25 };
      const before = structuredClone(query);
      expect(await run(request, query)).to.deep.equal({ items: [first, second], total: 2 });
      expect(query).to.deep.equal(before);
      const base = channels ? '/connect/cms/spaces/space%2Fid/channels' : '/connect/cms/spaces';
      const filter = channels ? '' : 'nameFragment=Main+%26+More&';
      expect(request.getCalls().map((call) => call.args[0])).to.deep.equal([
        { method: 'GET', url: `${base}?${filter}page=0&pageSize=25` },
        { method: 'GET', url: `${base}?${filter}page=1&pageSize=25` },
      ]);
    });

    it(`continues short ${label} pages without navigation until an empty page using API page size`, async () => {
      const request = sinon.stub();
      request
        .onCall(0)
        .returns(fakeRequest(envelope([{ id: 'one' }], { total: 0, pageSize: 250 })));
      request.onCall(1).returns(fakeRequest(envelope([{ id: 'two' }])));
      request.onCall(2).returns(fakeRequest(envelope([])));
      expect(await run(request)).to.deep.equal({ items: [{ id: 'one' }, { id: 'two' }], total: 2 });
      const base = channels ? '/connect/cms/spaces/space%2Fid/channels' : '/connect/cms/spaces';
      expect(request.getCalls().map((call) => call.args[0])).to.deep.equal(
        [0, 1, 2].map((page) => ({ method: 'GET', url: `${base}?page=${page}` })),
      );
    });

    for (const navigation of [{}, { nextPageUrl: null }]) {
      it(`accepts empty first ${label} page ${JSON.stringify(navigation)}`, async () => {
        const request = sinon.stub().returns(fakeRequest(envelope([], navigation)));
        expect(await run(request)).to.deep.equal({ items: [], total: 0 });
        expect(request.calledOnce).to.equal(true);
      });
    }

    for (const nextPageUrl of ['', '  ', 1, false, {}, [], undefined]) {
      it(`rejects malformed ${label} navigation ${JSON.stringify(nextPageUrl)}`, async () => {
        const request = sinon
          .stub()
          .returns(fakeRequest(envelope([{ id: 'one' }], { nextPageUrl })));
        await expectFailure(run(request), 'nextPageUrl');
      });
    }

    it(`rejects empty ${label} pages advertising more results`, async () => {
      const request = sinon.stub().returns(fakeRequest(envelope([], { nextPageUrl: '/next' })));
      await expectFailure(run(request), 'empty page');
    });

    for (const id of [undefined, null, '', 1, {}, []]) {
      it(`rejects malformed ${label} IDs ${JSON.stringify(id)}`, async () => {
        const request = sinon
          .stub()
          .returns(fakeRequest(envelope([{ id }], { nextPageUrl: null })));
        await expectFailure(run(request), 'malformed ID');
      });
    }

    for (const alias of ['ONE', 'ｏｎｅ']) {
      it(`rejects ambiguous ${label} IDs ${alias}`, async () => {
        const request = sinon.stub();
        request.onCall(0).returns(fakeRequest(envelope([{ id: 'one' }])));
        request.onCall(1).returns(fakeRequest(envelope([{ id: alias }], { nextPageUrl: null })));
        await expectFailure(run(request), 'ambiguous');
      });
    }

    it(`rejects repeated ${label} pages even with changed records and terminal navigation`, async () => {
      const request = sinon.stub();
      request.onCall(0).returns(fakeRequest(envelope([{ id: 'one' }])));
      request
        .onCall(1)
        .returns(fakeRequest(envelope([{ id: 'one', changed: true }], { nextPageUrl: null })));
      await expectFailure(run(request), 'no progress');
      expect(request.callCount).to.equal(2);
    });

    for (const raw of [
      null,
      {},
      'bad',
      { spaces: {} },
      { spaceChannels: [null] },
      { spaceChannels: [{}] },
      envelope([null]),
      envelope([1]),
      envelope([[]]),
    ]) {
      it(`rejects malformed raw ${label} shape ${JSON.stringify(raw)}`, async () => {
        const request = sinon.stub().returns(fakeRequest(raw));
        await expectFailure(run(request), 'response shape');
      });
    }

    it(`bounds ${label} collection at 1000 requests`, async () => {
      const request = sinon
        .stub()
        .callsFake(() => fakeRequest(envelope([{ id: `id-${request.callCount}` }])));
      await expectFailure(run(request), '1000-page safety limit');
      expect(request.callCount).to.equal(1000);
    });

    it(`propagates later ${label} request errors instead of returning partial results`, async () => {
      const request = sinon.stub();
      request.onCall(0).returns(fakeRequest(envelope([{ id: 'one' }])));
      request.onCall(1).throws(new Error('later request failed'));
      await expectFailure(run(request), 'later request failed');
      expect(request.callCount).to.equal(2);
    });
  }

  it('accepts all existing direct collection envelope names', async () => {
    for (const key of ['items', 'spaces', 'contentSpaces', 'channels']) {
      const request = sinon
        .stub()
        .returns(fakeRequest({ [key]: [{ id: 'one' }], nextPageUrl: null }));
      expect(await listAllWorkspaces({ request })).to.deep.equal({
        items: [{ id: 'one' }],
        total: 1,
      });
    }
    const request = sinon.stub();
    request.onCall(0).returns(fakeRequest([{ id: 'one' }]));
    request.onCall(1).returns(fakeRequest([]));
    expect(await listAllWorkspaces({ request })).to.deep.equal({
      items: [{ id: 'one' }],
      total: 1,
    });
  });

  it('does not tighten permissive single-page normalization', async () => {
    const request = sinon
      .stub()
      .returns(fakeRequest({ spaces: [null, 1, { name: 'without ID' }], nextPageUrl: false }));
    expect(await listWorkspaces({ request })).to.deep.equal({ items: [{ name: 'without ID' }] });
    request.returns(fakeRequest(null));
    expect(await listWorkspaceChannels({ request }, 'space')).to.deep.equal({ items: [] });
  });
});

async function expectFailure(result: Promise<unknown>, message: string): Promise<void> {
  try {
    await result;
    expect.fail('expected aggregate failure');
  } catch (error) {
    expect((error as Error).message).to.include(message);
  }
}

describe('CMS read services', () => {
  it('maps workspace and channel list parameters to descriptors', async () => {
    const request = sinon
      .stub()
      .onFirstCall()
      .returns(
        fakeRequest({
          currentPage: 1,
          pageSize: 25,
          spaces: [{ id: 'space', name: 'Main', status: 'Active' }],
          total: 1,
        }),
      )
      .onSecondCall()
      .returns(
        fakeRequest({
          currentPage: 2,
          pageSize: 10,
          spaceChannels: [
            {
              channelSummary: { id: 'channel', name: 'Email', type: 'Email' },
              role: 'CONTRIBUTOR',
            },
          ],
          totalSpaceChannels: 1,
        }),
      );

    expect(
      await listWorkspaces({ request }, { nameFragment: 'Main', page: 1, pageSize: 25 }),
    ).to.deep.equal({
      items: [{ id: 'space', name: 'Main', status: 'Active' }],
      page: 1,
      pageSize: 25,
      total: 1,
    });
    expect(
      await listWorkspaceChannels({ request }, 'space', { page: 2, pageSize: 10 }),
    ).to.deep.equal({
      items: [{ id: 'channel', name: 'Email', type: 'Email' }],
      page: 2,
      pageSize: 10,
      total: 1,
    });
    expect(request.firstCall.args[0]).to.deep.equal({
      method: 'GET',
      url: '/connect/cms/spaces?nameFragment=Main&page=1&pageSize=25',
    });
    expect(request.secondCall.args[0]).to.deep.equal({
      method: 'GET',
      url: '/connect/cms/spaces/space/channels?page=2&pageSize=10',
    });
  });

  it('preserves complete workspace records and page metadata with one list GET and no detail reads', async () => {
    const workspace = {
      id: '0Zufj000006rx4wCAA',
      name: 'Content Workspace for Marketing Cloud',
      type: 'Misleading',
      spaceType: { apiName: 'marketing', label: 'Marketing', extra: { retained: true } },
      isEnhancedSpace: true,
      extras: [null, { nested: ['unchanged'] }],
    };
    const before = structuredClone(workspace);
    const request = sinon
      .stub()
      .returns(fakeRequest({ spaces: [workspace], currentPage: 3, pageSize: 25, total: 80 }));
    expect(await listWorkspaces({ request })).to.deep.equal({
      items: [before],
      page: 3,
      pageSize: 25,
      total: 80,
    });
    expect(workspace).to.deep.equal(before);
    expect(request.calledOnce).to.equal(true);
    expect(request.firstCall.args[0]).to.deep.equal({ method: 'GET', url: '/connect/cms/spaces' });
  });

  it('returns direct live get records and maps requests to descriptors', async () => {
    const records = [
      { id: 'space', name: 'Main', channels: [{ id: 'channel' }] },
      { id: 'channel', name: 'Email', spaceId: 'space' },
      { id: 'content', title: 'News', variants: [{ id: 'variant' }] },
      { id: 'variant', content: { body: 'Hello' }, locale: 'en_US' },
    ];
    const request = sinon.stub();
    for (const [index, record] of records.entries())
      request.onCall(index).returns(fakeRequest(record));

    expect(await getWorkspace({ request }, 'space/id')).to.deep.equal(records[0]);
    expect(await getChannel({ request }, 'channel/id')).to.deep.equal(records[1]);
    expect(
      await getContent({ request }, 'content/key', {
        contentVersion: '2',
        language: 'en_US',
        variantVersion: '3',
        version: 'draft',
      }),
    ).to.deep.equal(records[2]);
    expect(await getVariant({ request }, 'variant/id')).to.deep.equal(records[3]);

    expect(request.getCalls().map((call) => call.args[0])).to.deep.equal([
      { method: 'GET', url: '/connect/cms/spaces/space%2Fid' },
      { method: 'GET', url: '/connect/cms/channels/channel%2Fid' },
      {
        method: 'GET',
        url: '/connect/cms/contents/content%2Fkey?contentVersion=2&language=en_US&variantVersion=3&version=draft',
      },
      { method: 'GET', url: '/connect/cms/contents/variants/variant%2Fid' },
    ]);
  });

  it('rejects undocumented get response shapes', async () => {
    const request = sinon.stub().returns(fakeRequest(['unexpected']));
    try {
      await getWorkspace({ request }, 'space');
      expect.fail('expected response shape failure');
    } catch (error) {
      expect(error).to.be.instanceOf(TypeError);
      expect((error as Error).message).to.equal('Unexpected workspace.get response shape');
    }
  });
});
