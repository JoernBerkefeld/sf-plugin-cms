import { PassThrough } from 'node:stream';
import { expect } from 'chai';
import sinon from 'sinon';
import { createContent, createVariant, deleteVariant } from '../../src/services/write.js';

type FakeRequest<T> = Promise<T> & { stream(): PassThrough };

function fakeRequest<T>(value?: T): FakeRequest<T | undefined> {
  return Object.assign(Promise.resolve(value), { stream: () => new PassThrough() });
}

describe('CMS write service', () => {
  it('creates content with the direct contentBody and supported optional fields', async () => {
    const request = sinon.stub().returns(fakeRequest({ id: 'content-id' }));
    const contentBody = { body: '<p>Body</p>' };
    const body = {
      apiName: 'api_name',
      contentBody,
      contentKey: 'content-key',
      contentSpaceOrFolderId: 'space',
      contentType: 'sfdc_cms__news',
      externalId: 'external-id',
      externalSource: { source: 'runtime' },
      title: 'Title',
      urlName: 'url-name',
    };

    const result = await createContent({ request }, body);

    expect(result).to.deep.equal({ id: 'content-id' });
    expect(JSON.parse(request.firstCall.args[0].body)).to.deep.equal(body);
    expect(JSON.parse(request.firstCall.args[0].body).contentBody).to.deep.equal(contentBody);
  });

  it('creates a variant with canonical managedContentKeyOrId spelling', async () => {
    const request = sinon.stub().returns(fakeRequest({ id: 'variant-id' }));
    const body = {
      contentBody: { body: 'French body' },
      language: 'fr',
      managedContentKeyOrId: 'content-key',
      title: 'French title',
      urlName: 'french-title',
    };

    await createVariant({ request }, body);

    const transmittedBody = JSON.parse(request.firstCall.args[0].body);
    expect(transmittedBody).to.deep.equal(body);
    expect(transmittedBody).to.have.property('managedContentKeyOrId', 'content-key');
    expect(transmittedBody).not.to.have.property('managedContentKeyorId');
  });

  it('deletes by variantId and accepts an observed 204-style empty result', async () => {
    const request = sinon.stub().returns(fakeRequest());

    const result = await deleteVariant({ request }, 'variant-id');

    expect(result).to.deep.equal({ operationKey: 'variant.delete' });
    expect(request.firstCall.args[0].url).to.equal('/connect/cms/contents/variants/variant-id');
    expect(result).not.to.have.property('data');
    expect(result).not.to.have.property('status');
  });

  it('rejects non-object create responses', async () => {
    const request = sinon.stub().returns(fakeRequest());

    try {
      await createVariant(
        { request },
        { contentBody: {}, language: 'fr', managedContentKeyOrId: 'content-key' },
      );
      expect.fail('expected response-shape error');
    } catch (error) {
      expect((error as Error).message).to.equal('Unexpected variant.create response shape');
    }
  });
});
