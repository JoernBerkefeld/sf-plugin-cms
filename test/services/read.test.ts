import { PassThrough } from 'node:stream';
import { expect } from 'chai';
import sinon from 'sinon';
import { listAllWorkspaces, listAllWorkspaceChannels } from '../../src/services/read.js';

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
});

async function expectFailure(result: Promise<unknown>, message: string): Promise<void> {
  try {
    await result;
    expect.fail('expected aggregate failure');
  } catch (error) {
    expect((error as Error).message).to.include(message);
  }
}
