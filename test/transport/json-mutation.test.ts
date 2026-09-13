import { Connection as JsforceConnection } from '@jsforce/jsforce-node';
import { PassThrough } from 'node:stream';
import { expect } from 'chai';
import sinon from 'sinon';
import { getSelectedOperation, CmsRequestError } from '../../src/transport/json-request.js';
import { requestEmptyMutation, requestJsonMutation } from '../../src/transport/json-mutation.js';

type FakeRequest<T> = Promise<T> & { stream(): PassThrough };

function fakeRequest<T>(value?: T): FakeRequest<T | undefined> {
  return Object.assign(Promise.resolve(value), { stream: () => new PassThrough() });
}

function failedRequest(error: Error): FakeRequest<never> {
  return Object.assign(Promise.reject(error), { stream: () => new PassThrough() });
}

function ignoreRejection(): void {}

describe('JSON mutation transport', () => {
  it('sends the exact POST URL, JSON header, direct object body, timeout, and no-retry option', async () => {
    const request = sinon.stub().returns(fakeRequest({ id: 'created' }));
    const contentBody = { body: '<p>Hello</p>', nested: { value: true } };
    const body = {
      contentBody,
      contentSpaceOrFolderId: 'space',
      contentType: 'sfdc_cms__news',
      title: 'Title',
    };

    const result = await requestJsonMutation(
      { request },
      getSelectedOperation('content.create'),
      body,
      {},
      { timeoutMs: 1234 },
    );

    expect(result).to.deep.equal({ data: { id: 'created' }, operationKey: 'content.create' });
    expect(request.calledOnce).to.equal(true);
    expect(request.firstCall.args).to.deep.equal([
      {
        body: JSON.stringify(body),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
        url: '/connect/cms/contents',
      },
      { retry: { maxRetries: 0 }, timeout: 1234 },
    ]);
    expect(JSON.parse(request.firstCall.args[0].body)).to.deep.equal(body);
  });

  it('uses a token-only connection to prevent refresh replay', async () => {
    const request = sinon
      .stub(JsforceConnection.prototype, 'request')
      .returns(fakeRequest({ id: 'created' }));
    const refreshingConnection = {
      accessToken: 'token',
      instanceUrl: 'https://example.my.salesforce.com',
      request: sinon.stub(),
      version: '67.0',
    };

    await requestJsonMutation(refreshingConnection, getSelectedOperation('variant.create'), {
      contentBody: {},
      language: 'fr',
      managedContentKeyOrId: 'content',
    });

    expect(refreshingConnection.request.callCount).to.equal(0);
    expect(request.calledOnce).to.equal(true);
    expect(request.thisValues[0]).not.to.equal(refreshingConnection);
    expect(request.firstCall.args[1]).to.deep.include({ retry: { maxRetries: 0 } });
    request.restore();
  });

  it('accepts an empty successful delete without inventing body or status', async () => {
    const request = sinon.stub().returns(fakeRequest());

    const result = await requestEmptyMutation({ request }, getSelectedOperation('variant.delete'), {
      path: { variantId: 'variant/id' },
    });

    expect(result).to.deep.equal({ operationKey: 'variant.delete' });
    expect(request.firstCall.args[0]).to.deep.equal({
      headers: { 'content-type': 'application/json' },
      method: 'DELETE',
      url: '/connect/cms/contents/variants/variant%2Fid',
    });
  });

  it('rejects invalid timeout and already-aborted requests before transport', async () => {
    const request = sinon.stub();
    const controller = new AbortController();
    controller.abort();

    for (const options of [{ timeoutMs: 0 }, { signal: controller.signal }]) {
      try {
        await requestEmptyMutation(
          { request },
          getSelectedOperation('variant.delete'),
          { path: { variantId: 'variant' } },
          options,
        );
        expect.fail('expected request rejection');
      } catch (error) {
        expect(error).to.be.instanceOf(CmsRequestError);
      }
    }
    expect(request.callCount).to.equal(0);
  });

  it('destroys the in-flight stream and normalizes cancellation', async () => {
    const stream = new PassThrough();
    stream.on('error', () => {});
    let rejectRequest: (error: Error) => void = ignoreRejection;
    const pending = new Promise<never>((_resolve, reject) => {
      rejectRequest = reject;
    });
    const requestPromise = Object.assign(pending, { stream: () => stream });
    const request = sinon.stub().returns(requestPromise);
    const destroy = sinon.spy(stream, 'destroy');
    const controller = new AbortController();

    const result = requestEmptyMutation(
      { request },
      getSelectedOperation('variant.delete'),
      { path: { variantId: 'variant' } },
      { signal: controller.signal },
    );
    controller.abort();
    rejectRequest(new Error('Bearer secret-token'));

    try {
      await result;
      expect.fail('expected cancellation');
    } catch (error) {
      expect((error as Error).message).to.equal('CMS request cancelled');
    }
    expect(destroy.calledOnce).to.equal(true);
  });

  it('redacts and normalizes status-bearing errors without retrying', async () => {
    const failure = Object.assign(
      new Error('Authorization: Bearer secret-token ?access_token=also-secret'),
      { statusCode: 503 },
    );
    const request = sinon.stub().returns(failedRequest(failure));

    try {
      await requestJsonMutation({ request }, getSelectedOperation('variant.create'), {
        contentBody: {},
        language: 'fr',
        managedContentKeyOrId: 'content',
      });
      expect.fail('expected API error');
    } catch (error) {
      expect(error).to.be.instanceOf(CmsRequestError);
      expect((error as CmsRequestError).status).to.equal(503);
      expect((error as Error).message).to.equal(
        'Authorization: [REDACTED] ?access_token=[REDACTED]',
      );
    }
    expect(request.calledOnce).to.equal(true);
    expect(request.firstCall.args[1]).to.deep.include({ retry: { maxRetries: 0 } });
  });
});
