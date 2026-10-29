import { PassThrough } from 'node:stream';
import { expect } from 'chai';
import sinon from 'sinon';
import { deleteVariant } from '../../src/services/write.js';

type FakeRequest<T> = Promise<T> & { stream(): PassThrough };

function fakeRequest<T>(value?: T): FakeRequest<T | undefined> {
  return Object.assign(Promise.resolve(value), { stream: () => new PassThrough() });
}

describe('CMS write service', () => {
  it('deletes by variantId and accepts an observed 204-style empty result', async () => {
    const request = sinon.stub().returns(fakeRequest());

    const result = await deleteVariant({ request }, 'variant-id');

    expect(result).to.deep.equal({ operationKey: 'variant.delete' });
    expect(request.firstCall.args[0].url).to.equal('/connect/cms/contents/variants/variant-id');
    expect(result).not.to.have.property('data');
    expect(result).not.to.have.property('status');
  });
});
