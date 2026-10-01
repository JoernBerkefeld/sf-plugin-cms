import { Connection as JsforceConnection } from '@jsforce/jsforce-node';
import { PassThrough } from 'node:stream';
import { expect } from 'chai';
import sinon from 'sinon';
import {
  deleteVariantOneShot,
  publishContent,
  unpublishContent,
  updateVariant,
} from '../../src/services/lifecycle-foundation.js';
import { CmsRequestError } from '../../src/transport/json-request.js';

type FakeRequest<T> = Promise<T> & { stream(): PassThrough };

function fakeRequest<T>(value?: T): FakeRequest<T | undefined> {
  return Object.assign(Promise.resolve(value), { stream: () => new PassThrough() });
}

function lifecycleConnection(): {
  accessToken: string;
  instanceUrl: string;
  request: sinon.SinonStub;
  version: string;
} {
  return {
    accessToken: 'token',
    instanceUrl: 'https://example.my.salesforce.com',
    request: sinon.stub(),
    version: '67.0',
  };
}

describe('CMS lifecycle transport foundation', () => {
  afterEach(() => sinon.restore());

  it('updates one exact variant through the isolated no-refresh connection', async () => {
    const data = {
      contentBody: { body: '<p>Updated</p>' },
      isPublished: false,
      language: 'en_US',
      managedContentId: 'content-id',
      managedContentVariantId: 'variant-id',
    };
    const request = sinon.stub(JsforceConnection.prototype, 'request').returns(fakeRequest(data));
    const connection = lifecycleConnection();

    const result = await updateVariant(
      connection,
      'variant/id',
      { contentBody: data.contentBody, title: 'Updated title' },
      { timeoutMs: 4321 },
    );

    expect(result).to.deep.equal(data);
    expect(connection.request.notCalled).to.equal(true);
    expect(request.calledOnce).to.equal(true);
    expect(request.firstCall.args[0]).to.deep.include({
      method: 'PUT',
      url: '/connect/cms/contents/variants/variant%2Fid',
    });
    expect(request.firstCall.args[1]).to.deep.equal({
      retry: { maxRetries: 0 },
      timeout: 4321,
    });
  });

  it('hardens one-shot variant deletion with a non-empty identifier', async () => {
    const request = sinon.stub(JsforceConnection.prototype, 'request').returns(fakeRequest());
    const connection = lifecycleConnection();

    const result = await deleteVariantOneShot(connection, 'variant-id');

    expect(result).to.deep.equal({ operationKey: 'variant.delete' });
    expect(connection.request.notCalled).to.equal(true);
    expect(request.calledOnce).to.equal(true);
    await expectRejected(
      Promise.resolve().then(() => deleteVariantOneShot(connection, '')),
      'variantId must be a non-empty string',
    );
    expect(request.calledOnce).to.equal(true);
  });

  it('publishes exactly one selector and always excludes content references', async () => {
    const request = sinon
      .stub(JsforceConnection.prototype, 'request')
      .returns(
        fakeRequest({ deploymentId: 'deployment-id', description: null, publishDate: null }),
      );
    const connection = lifecycleConnection();

    const result = await publishContent(connection, {
      contentIds: ['content-id'],
      contextContentSpaceId: 'space-id',
      description: 'Publish',
    });

    expect(result).to.deep.equal({
      deploymentId: 'deployment-id',
      description: null,
      publishDate: null,
    });
    expect(connection.request.notCalled).to.equal(true);
    const publishRequest = request.firstCall.args[0] as { body: string };
    expect(JSON.parse(publishRequest.body)).to.deep.equal({
      contentIds: ['content-id'],
      contextContentSpaceId: 'space-id',
      description: 'Publish',
      includeContentReferences: false,
    });
    expect(request.firstCall.args[1]).to.deep.include({ retry: { maxRetries: 0 } });
  });

  it('unpublishes exactly one selector without inventing publish-only fields', async () => {
    const request = sinon
      .stub(JsforceConnection.prototype, 'request')
      .returns(
        fakeRequest({ deploymentId: 'deployment-id', unpublishDate: '2026-10-01T12:00:00Z' }),
      );
    const connection = lifecycleConnection();

    const result = await unpublishContent(connection, { variantIds: ['variant-id'] });

    expect(result).to.deep.equal({
      deploymentId: 'deployment-id',
      unpublishDate: '2026-10-01T12:00:00Z',
    });
    expect(connection.request.notCalled).to.equal(true);
    const unpublishRequest = request.firstCall.args[0] as { body: string };
    expect(JSON.parse(unpublishRequest.body)).to.deep.equal({ variantIds: ['variant-id'] });
    expect(request.calledOnce).to.equal(true);
  });

  it('rejects unknown and malformed request fields before transport', async () => {
    const connection = lifecycleConnection();

    await expectRejected(
      publishContent(connection, {} as never),
      'Exactly one of contentIds or variantIds is required',
    );
    await expectRejected(
      publishContent(connection, { contentIds: [], variantIds: ['variant-id'] } as never),
      'Exactly one of contentIds or variantIds is required',
    );
    await expectRejected(
      unpublishContent(connection, { contentIds: [] }),
      'Lifecycle selector IDs must be non-empty strings',
    );
    await expectRejected(
      publishContent(connection, {
        contentIds: ['content-id'],
        includeContentReferences: true,
      } as never),
      'Unknown request field: includeContentReferences',
    );
    await expectRejected(
      unpublishContent(connection, { contentIds: ['content-id'], description: 1 } as never),
      'description must be a string',
    );
    await expectRejected(
      updateVariant(connection, 'variant-id', {}),
      'Variant update requires at least one field',
    );
    await expectRejected(
      updateVariant(connection, 'variant-id', { unknown: true } as never),
      'Unknown request field: unknown',
    );
    await expectRejected(
      updateVariant(connection, 'variant-id', { title: 1 } as never),
      'title must be a string',
    );
    expect(connection.request.notCalled).to.equal(true);
  });

  it('fails closed without token material and rejects malformed responses', async () => {
    const callerRequest = sinon.stub();
    await expectRejected(
      publishContent({ request: callerRequest }, { contentIds: ['content-id'] }),
      'Mutation transport requires an access token and instance URL',
    );
    await expectRejected(
      deleteVariantOneShot({ request: callerRequest }, 'variant-id'),
      'Mutation transport requires an access token and instance URL',
    );
    await expectRejected(
      deleteVariantOneShot({ request: callerRequest }, 'variant-id', {
        allowCallerConnection: true,
      } as never),
      'Mutation transport requires an access token and instance URL',
    );
    expect(callerRequest.notCalled).to.equal(true);

    sinon.stub(JsforceConnection.prototype, 'request').returns(fakeRequest({ deploymentId: '' }));
    await expectRejected(
      publishContent(lifecycleConnection(), { contentIds: ['content-id'] }),
      'deploymentId must be a non-empty string',
    );
  });
});

async function expectRejected(promise: Promise<unknown>, message: string): Promise<void> {
  try {
    await promise;
    expect.fail('expected rejection');
  } catch (error) {
    expect(error).to.be.instanceOf(CmsRequestError);
    expect((error as Error).message).to.equal(message);
  }
}
