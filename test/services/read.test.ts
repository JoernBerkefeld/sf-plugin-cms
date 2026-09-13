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
} from '../../src/services/read.js';

type FakeRequest<T> = Promise<T> & { stream(): PassThrough };

function fakeRequest<T>(value: T): FakeRequest<T> {
  return Object.assign(Promise.resolve(value), { stream: () => new PassThrough() });
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
