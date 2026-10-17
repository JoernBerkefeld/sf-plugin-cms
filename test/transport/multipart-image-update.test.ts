import { Connection as JsforceConnection } from '@jsforce/jsforce-node';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PassThrough } from 'node:stream';
import { expect } from 'chai';
import sinon from 'sinon';
import {
  buildImageUpdateMultipart,
  updateImageContent,
} from '../../src/transport/multipart-image-update.js';
import { MAX_IMAGE_BYTES } from '../../src/transport/multipart-image-create.js';
import { CmsRequestError } from '../../src/transport/json-request.js';

const input = { apiName: 'hero_image', title: 'Updated café', urlName: 'hero-image' };
const bytes = Buffer.from([0, 13, 10, 128, 255]);
const options = { boundaryFactory: () => 'safe', timeoutMs: 1234 };
const response = {
  contentBody: { 'sfdc_cms:media': { source: { type: 'file' } } },
  isPublished: false,
  language: 'en_US',
  managedContentId: 'parent',
  managedContentVariantId: 'variant',
};

function fakeRequest(promise: Promise<unknown>, stream = new PassThrough()) {
  return Object.assign(promise, { stream: () => stream });
}

async function rejects(action: () => Promise<unknown>, message?: string): Promise<CmsRequestError> {
  try {
    await action();
  } catch (error) {
    expect(error).to.be.instanceOf(CmsRequestError);
    if (message) expect((error as Error).message).to.include(message);
    return error as CmsRequestError;
  }
  throw new Error('Expected rejection');
}

describe('private multipart Image UPDATE transport', () => {
  afterEach(() => sinon.restore());

  it('builds exact UPDATE-only JSON, two ordered parts and binary view bytes', () => {
    const backing = Buffer.concat([Buffer.from([9]), bytes, Buffer.from([8])]);
    const built = buildImageUpdateMultipart(
      input,
      'Original-name.PNG',
      backing.subarray(1, -1),
      options,
    );
    const nativeInput = {
      ...input,
      contentBody: { 'sfdc_cms:media': { source: { type: 'file' } } },
    };
    const expected = Buffer.concat([
      Buffer.from(
        '--safe\r\nContent-Disposition: form-data; name="ManagedContentVariantInputParam"\r\n' +
          'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
          JSON.stringify(nativeInput) +
          '\r\n--safe\r\nContent-Disposition: form-data; name="contentData"; filename="Original-name.PNG"\r\n' +
          'Content-Type: application/octet-stream; charset=ISO-8859-1\r\n\r\n',
        'utf8',
      ),
      bytes,
      Buffer.from('\r\n--safe--\r\n'),
    ]);
    expect(built.body.equals(expected)).to.equal(true);
    expect(built.input).to.deep.equal(nativeInput);
    expect(built.body.toString('utf8')).not.to.include('name="ManagedContentInputParam"');
    expect(buildImageUpdateMultipart({}, 'image.png', bytes, options).input).to.deep.equal({
      contentBody: nativeInput.contentBody,
    });
  });

  it('preserves the unchanged native title in the exact bytes-only UPDATE wire body', async () => {
    const request = sinon.stub().returns(fakeRequest(Promise.resolve(response)));
    await updateImageContent(
      { request },
      'variant',
      { title: 'Native café image' },
      'a.png',
      bytes,
      options,
    );
    const expected = Buffer.concat([
      Buffer.from(
        '--safe\r\nContent-Disposition: form-data; name="ManagedContentVariantInputParam"\r\n' +
          'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
          '{"title":"Native café image","contentBody":{"sfdc_cms:media":{"source":{"type":"file"}}}}' +
          '\r\n--safe\r\nContent-Disposition: form-data; name="contentData"; filename="a.png"\r\n' +
          'Content-Type: application/octet-stream; charset=ISO-8859-1\r\n\r\n',
        'utf8',
      ),
      bytes,
      Buffer.from('\r\n--safe--\r\n'),
    ]);
    expect(request.firstCall.args[0].body.equals(expected)).to.equal(true);
    expect(request.calledOnce).to.equal(true);
  });

  it('rejects CREATE fields, arbitrary body overrides and invalid metadata before request', async () => {
    const request = sinon.stub();
    for (const extra of [
      { contentKey: 'key' },
      { contentType: 'sfdc_cms__image' },
      { contentSpaceOrFolderId: 'space' },
      { contentBody: {} },
      { media: {} },
    ]) {
      await rejects(
        () => updateImageContent({ request }, 'variant', { ...input, ...extra }, 'a.png', bytes),
        'Unsupported image update field',
      );
    }
    for (const value of ['', 'bad\r\nvalue', 1, null]) {
      expect(() => buildImageUpdateMultipart({ title: value as string }, 'a.png', bytes)).to.throw(
        CmsRequestError,
      );
    }
    expect(() =>
      buildImageUpdateMultipart(null as unknown as typeof input, 'a.png', bytes),
    ).to.throw(CmsRequestError);
    expect(request.called).to.equal(false);
  });

  it('rejects unsafe and non-ASCII filenames without lossy framing', () => {
    for (const filename of [
      '',
      '.',
      '..',
      'a/b',
      String.raw`a\b`,
      'a"b',
      'a\r\nb',
      'a\0b',
      'a\u007Fb',
      'café.png',
      'a\u010D.png',
      '😀.png',
    ]) {
      expect(() => buildImageUpdateMultipart(input, filename, bytes)).to.throw(
        CmsRequestError,
        'Invalid image filename',
      );
    }
  });

  it('enforces binary caps and boundary validation with bounded collision handling', () => {
    for (const value of [Buffer.alloc(0), Buffer.alloc(MAX_IMAGE_BYTES + 1), 'text']) {
      expect(() => buildImageUpdateMultipart(input, 'a.png', value as Uint8Array)).to.throw(
        CmsRequestError,
      );
    }
    expect(() =>
      buildImageUpdateMultipart(input, 'a.png', Buffer.alloc(MAX_IMAGE_BYTES), options),
    ).not.to.throw();
    for (const boundary of ['', 'bad boundary', 'x'.repeat(71), 'bad\r\n']) {
      expect(() =>
        buildImageUpdateMultipart(input, 'a.png', bytes, { boundaryFactory: () => boundary }),
      ).to.throw(CmsRequestError, 'Invalid multipart boundary');
    }
    for (const maxBoundaryAttempts of [0, -1, 1.5, Number.NaN]) {
      expect(() =>
        buildImageUpdateMultipart(input, 'a.png', bytes, { maxBoundaryAttempts }),
      ).to.throw(CmsRequestError);
    }
    const factory = sinon.stub().returns('collision');
    expect(() =>
      buildImageUpdateMultipart(input, 'a.png', Buffer.from('collision'), {
        boundaryFactory: factory,
        maxBoundaryAttempts: 2,
      }),
    ).to.throw(CmsRequestError, 'collision-free');
    expect(factory.callCount).to.equal(2);
    const next = sinon.stub().onFirstCall().returns('title').onSecondCall().returns('safe');
    expect(
      buildImageUpdateMultipart(input, 'a.png', bytes, { boundaryFactory: next }).boundary,
    ).to.equal('safe');
  });

  it('sends the exact PUT bytes once, with encoded identity, timeout and no retry', async () => {
    const request = sinon.stub().returns(fakeRequest(Promise.resolve(response)));
    expect(
      await updateImageContent({ request }, 'variant/one', input, 'a.png', bytes, options),
    ).to.deep.equal(response);
    expect(request.calledOnce).to.equal(true);
    const actual = request.firstCall.args[0];
    expect(actual.method).to.equal('PUT');
    expect(actual.url).to.equal('/connect/cms/contents/variants/variant%2Fone');
    expect(
      actual.body.equals(buildImageUpdateMultipart(input, 'a.png', bytes, options).body),
    ).to.equal(true);
    expect(actual.headers).to.deep.equal({
      'content-length': String(actual.body.length),
      'content-type': 'multipart/form-data; boundary=safe',
    });
    expect(request.firstCall.args[1]).to.deep.equal({ retry: { maxRetries: 0 }, timeout: 1234 });
  });

  it('awaits raw partial responses before strict rejection for later durable journaling', async () => {
    const partial = { managedContentVariantId: 'returned-variant' };
    let finish!: () => void;
    const persisted = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const observer = sinon.stub().callsFake(async (value: unknown) => {
      expect(value).to.equal(partial);
      await persisted;
    });
    const request = sinon.stub().returns(fakeRequest(Promise.resolve(partial)));
    let settled = false;
    const pending = rejects(
      () => updateImageContent({ request }, 'variant', input, 'a.png', bytes, options, observer),
      'response shape',
    ).then(() => {
      settled = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(observer.calledOnce).to.equal(true);
    expect(settled).to.equal(false);
    finish();
    await pending;
    expect(request.calledOnce).to.equal(true);
  });

  it('uses the existing strict variant response contract, not a CREATE binding', async () => {
    for (const malformed of [
      null,
      [],
      { contentKey: 'key', managedContentId: 'parent', managedContentVariantId: 'variant' },
      { ...response, contentBody: [] },
      { ...response, isPublished: 'false' },
      { ...response, language: '' },
      { ...response, managedContentId: '' },
      { ...response, managedContentVariantId: '' },
    ]) {
      const request = sinon.stub().returns(fakeRequest(Promise.resolve(malformed)));
      const observer = sinon.stub().resolves();
      await rejects(
        () => updateImageContent({ request }, 'variant', input, 'a.png', bytes, options, observer),
        'response shape',
      );
      expect(observer.calledOnceWithExactly(malformed)).to.equal(true);
      expect(request.calledOnce).to.equal(true);
    }
  });

  it('rejects invalid timeout, selector and pre-aborted requests without HTTP', async () => {
    const request = sinon.stub();
    const controller = new AbortController();
    controller.abort();
    for (const timeoutMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      await rejects(
        () => updateImageContent({ request }, 'variant', input, 'a.png', bytes, { timeoutMs }),
        'timeout',
      );
    }
    for (const variant of ['', 'bad\nvariant']) {
      await rejects(() => updateImageContent({ request }, variant, input, 'a.png', bytes));
    }
    await rejects(
      () =>
        updateImageContent({ request }, 'variant', input, 'a.png', bytes, {
          signal: controller.signal,
        }),
      'cancelled',
    );
    expect(request.called).to.equal(false);
  });

  it('cancels the in-flight stream and removes its listener without replay', async () => {
    const controller = new AbortController();
    const remove = sinon.spy(controller.signal, 'removeEventListener');
    const stream = new PassThrough();
    const promise = new Promise<unknown>((resolve, reject) => {
      stream.once('error', reject);
    });
    const request = sinon.stub().returns(fakeRequest(promise, stream));
    const pending = rejects(
      () =>
        updateImageContent({ request }, 'variant', input, 'a.png', bytes, {
          signal: controller.signal,
        }),
      'cancelled',
    );
    controller.abort();
    await pending;
    expect(stream.destroyed).to.equal(true);
    expect(request.calledOnce).to.equal(true);
    expect(remove.calledOnce).to.equal(true);
  });

  it('does not retry timeout/auth/socket failures and redacts bounded status errors', async () => {
    for (const statusCode of [401, 503]) {
      const failure = Object.assign(
        new Error(`Authorization: Bearer secret ?access_token=private ${'x'.repeat(1500)}`),
        { statusCode },
      );
      const request = sinon.stub().returns(fakeRequest(Promise.reject(failure)));
      const observer = sinon.stub();
      const error = await rejects(() =>
        updateImageContent({ request }, 'variant', input, 'a.png', bytes, options, observer),
      );
      expect(error.status).to.equal(statusCode);
      expect(error.message).not.to.include('secret');
      expect(error.message).not.to.include('private');
      expect(error.message.length).to.be.at.most(1024);
      expect(request.calledOnce).to.equal(true);
      expect(observer.called).to.equal(false);
    }
    for (const message of ['Request timeout', 'ambiguous socket failure']) {
      const request = sinon.stub().returns(fakeRequest(Promise.reject(new Error(message))));
      await rejects(
        () => updateImageContent({ request }, 'variant', input, 'a.png', bytes),
        message,
      );
      expect(request.calledOnce).to.equal(true);
    }
  });

  it('uses a fresh token-only connection rather than the refresh-capable caller', async () => {
    const request = sinon
      .stub(JsforceConnection.prototype, 'request')
      .returns(fakeRequest(Promise.resolve(response)));
    const caller = sinon.stub();
    await updateImageContent(
      {
        request: caller,
        accessToken: 'token',
        instanceUrl: 'https://example.my.salesforce.com',
        version: '67.0',
      },
      'variant',
      input,
      'a.png',
      bytes,
    );
    expect(caller.called).to.equal(false);
    expect(request.calledOnce).to.equal(true);
    expect(request.firstCall.args[1]).to.deep.include({ retry: { maxRetries: 0 } });
    expect((request.thisValues[0] as JsforceConnection).refreshToken).to.equal(undefined);
  });

  it('proves actual JSforce PUT framing, binary preservation and JSON response on loopback', async () => {
    const expected = buildImageUpdateMultipart(input, 'a.png', bytes, options);
    let captured: Buffer | undefined;
    let count = 0;
    const server = createServer((request, reply) => {
      count += 1;
      expect(request.method).to.equal('PUT');
      expect(request.url).to.equal('/services/data/v67.0/connect/cms/contents/variants/variant');
      expect(request.headers.authorization).to.equal('Bearer token');
      expect(request.headers['content-type']).to.equal('multipart/form-data; boundary=safe');
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        captured = Buffer.concat(chunks);
        reply.writeHead(200, { 'content-type': 'application/json' });
        reply.end(JSON.stringify(response));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const { port } = server.address() as AddressInfo;
      const connection = new JsforceConnection({
        accessToken: 'token',
        instanceUrl: `http://127.0.0.1:${port}`,
        version: '67.0',
      });
      expect(
        await updateImageContent(connection, 'variant', input, 'a.png', bytes, options),
      ).to.deep.equal(response);
      expect(captured?.equals(expected.body)).to.equal(true);
      expect(count).to.equal(1);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});
