import { Connection as JsforceConnection } from '@jsforce/jsforce-node';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PassThrough } from 'node:stream';
import { expect } from 'chai';
import sinon from 'sinon';
import {
  buildImageCreateMultipart,
  createImageContent,
  MAX_IMAGE_BYTES,
} from '../../src/transport/multipart-image-create.js';
import { CmsRequestError } from '../../src/transport/json-request.js';

type FakeRequest<T> = Promise<T> & { stream(): PassThrough };

function fakeRequest<T>(promise: Promise<T>, stream = new PassThrough()): FakeRequest<T> {
  return Object.assign(promise, { stream: () => stream });
}

const input = {
  apiName: 'hero_image',
  contentKey: 'MCA4CCV5QS2BAB5H7YRCRPTCWGZQ',
  contentSpaceOrFolderId: '0Zu000000000001',
  title: 'Hero image',
  urlName: 'hero-image',
} as const;

function constantBoundary(value: string): () => string {
  return () => value;
}

describe('multipart image create transport', () => {
  it('builds exactly two ordered parts with exact headers and CRLF framing', () => {
    const image = Buffer.from([0, 1, 13, 10, 127, 128, 255]);
    const result = buildImageCreateMultipart(input, 'hero.png', image, {
      boundaryFactory: constantBoundary('safe-boundary'),
    });
    const expectedJson = JSON.stringify({
      ...input,
      contentType: 'sfdc_cms__image',
      contentBody: { 'sfdc_cms:media': { source: { type: 'file' } } },
    });
    const expectedPrefix = Buffer.from(
      '--safe-boundary\r\n' +
        'Content-Disposition: form-data; name="ManagedContentInputParam"\r\n' +
        'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
        expectedJson +
        '\r\n--safe-boundary\r\n' +
        'Content-Disposition: form-data; name="contentData"; filename="hero.png"\r\n' +
        'Content-Type: application/octet-stream; charset=ISO-8859-1\r\n\r\n',
      'ascii',
    );
    const expected = Buffer.concat([
      expectedPrefix,
      image,
      Buffer.from('\r\n--safe-boundary--\r\n', 'ascii'),
    ]);

    expect(result.body.equals(expected)).to.equal(true);
    expect(result.input).to.deep.equal(JSON.parse(expectedJson));
    expect(
      result.body
        .subarray(expectedPrefix.length, expectedPrefix.length + image.byteLength)
        .equals(image),
    ).to.equal(true);
    expect(result.body.toString('latin1').match(/Content-Disposition:/gu)).to.have.length(2);
    expect(result.body.toString('latin1')).not.to.match(/(?<!\r)\n/u);
  });

  it('rejects filename quoting, injection, controls, and paths', () => {
    for (const filename of [
      '',
      '.',
      '..',
      'a/b.png',
      String.raw`a\b.png`,
      'a".png',
      'a\r\nX-Evil: yes.png',
      'a\u0000.png',
      'a\u007F.png',
    ]) {
      expect(() =>
        buildImageCreateMultipart(input, filename, Buffer.from([1]), {
          boundaryFactory: constantBoundary('safe'),
        }),
      ).to.throw(CmsRequestError, 'Invalid image filename');
    }
  });

  it('regenerates colliding boundaries and fails after a bounded attempt count', () => {
    const candidates = ['collision', 'safe'];
    const regenerated = buildImageCreateMultipart(input, 'image.png', Buffer.from('collision'), {
      boundaryFactory: () => candidates.shift() ?? 'safe',
      maxBoundaryAttempts: 2,
    });
    expect(regenerated.boundary).to.equal('safe');

    expect(() =>
      buildImageCreateMultipart(input, 'image.png', Buffer.from('collision'), {
        boundaryFactory: constantBoundary('collision'),
        maxBoundaryAttempts: 2,
      }),
    ).to.throw(CmsRequestError, 'Unable to generate collision-free multipart boundary');
  });

  it('rejects invalid boundaries, zero bytes, oversized bytes, and non-binary input', () => {
    expect(() =>
      buildImageCreateMultipart(input, 'image.png', Buffer.from([1]), {
        boundaryFactory: constantBoundary('bad boundary'),
      }),
    ).to.throw(CmsRequestError, 'Invalid multipart boundary');
    expect(() =>
      buildImageCreateMultipart(input, 'image.png', Buffer.alloc(0), {
        boundaryFactory: constantBoundary('safe'),
      }),
    ).to.throw(CmsRequestError, 'Image data must not be empty');
    expect(() =>
      buildImageCreateMultipart(input, 'image.png', Buffer.alloc(MAX_IMAGE_BYTES + 1), {
        boundaryFactory: constantBoundary('safe'),
      }),
    ).to.throw(CmsRequestError, `Image exceeds ${MAX_IMAGE_BYTES} byte limit`);
    expect(() =>
      buildImageCreateMultipart(input, 'image.png', 'not-binary' as unknown as Uint8Array, {
        boundaryFactory: constantBoundary('safe'),
      }),
    ).to.throw(CmsRequestError, 'Image data must be binary');
  });

  it('accepts the locked cap and preserves a sliced view without adjacent bytes', () => {
    const backing = Buffer.from([9, 0, 128, 255, 8]);
    const image = backing.subarray(1, 4);
    const result = buildImageCreateMultipart(input, 'image.png', image, {
      boundaryFactory: constantBoundary('safe'),
    });
    const binaryStart = result.body.lastIndexOf(Buffer.from('\r\n\r\n', 'ascii')) + 4;
    const binaryEnd = result.body.indexOf(Buffer.from('\r\n--safe--\r\n', 'ascii'), binaryStart);
    expect([...result.body.subarray(binaryStart, binaryEnd)]).to.deep.equal([0, 128, 255]);

    expect(() =>
      buildImageCreateMultipart(input, 'image.png', Buffer.alloc(MAX_IMAGE_BYTES), {
        boundaryFactory: constantBoundary('safe-cap'),
      }),
    ).not.to.throw();
  });

  it('enforces the JSON allowlist and fixed server-safe media shape', () => {
    for (const extra of [
      { contentType: 'sfdc_cms__doc' },
      { contentBody: { media: 'server-owned' } },
      { media: { sourceUrl: 'secret' } },
      { externalId: 'owned-by-server' },
    ]) {
      expect(() =>
        buildImageCreateMultipart({ ...input, ...extra }, 'image.png', Buffer.from([1]), {
          boundaryFactory: constantBoundary('safe'),
        }),
      ).to.throw(CmsRequestError, 'Unsupported image create field');
    }
    expect(() =>
      buildImageCreateMultipart({ ...input, title: 'bad\rtitle' }, 'image.png', Buffer.from([1]), {
        boundaryFactory: constantBoundary('safe'),
      }),
    ).to.throw(CmsRequestError, 'Invalid image create field: title');
  });

  it('sends exact bytes through connection.request with connection-managed authorization', async () => {
    const response = {
      contentKey: 'created-key',
      managedContentId: '20Y000000000001',
      managedContentVariantId: '20X000000000001',
    };
    const request = sinon.stub().callsFake((requestOptions: Record<string, unknown>) => {
      const headers = requestOptions.headers as Record<string, string>;
      const body = requestOptions.body as Buffer;
      expect(requestOptions.method).to.equal('POST');
      expect(requestOptions.url).to.equal('/connect/cms/contents');
      expect(headers.authorization).to.equal(undefined);
      expect(headers.Authorization).to.equal(undefined);
      expect(headers['content-type']).to.equal('multipart/form-data; boundary=safe');
      expect(headers['content-length']).to.equal(String(body.byteLength));
      expect(body.includes(Buffer.from([0, 128, 255]))).to.equal(true);
      return fakeRequest(Promise.resolve(response));
    });

    const result = await createImageContent(
      { request },
      input,
      'image.png',
      Buffer.from([0, 128, 255]),
      { boundaryFactory: constantBoundary('safe'), timeoutMs: 1234 },
    );

    expect(result).to.deep.equal(response);
    expect(request.calledOnce).to.equal(true);
    expect(request.firstCall.args[1]).to.deep.equal({ retry: { maxRetries: 0 }, timeout: 1234 });
    expect(request.firstCall.args[0].method).to.equal('POST');
  });

  it('proves installed JSforce sends exact multipart bytes and parses JSON', async () => {
    const image = Buffer.from([0, 128, 255]);
    const expected = buildImageCreateMultipart(input, 'image.png', image, {
      boundaryFactory: constantBoundary('safe'),
    });
    let captured:
      | {
          authorization?: string;
          body: Buffer;
          contentLength?: string;
          contentType?: string;
          method?: string;
          url?: string;
        }
      | undefined;
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        captured = {
          authorization: request.headers.authorization,
          body: Buffer.concat(chunks),
          contentLength: request.headers['content-length'],
          contentType: request.headers['content-type'],
          method: request.method,
          url: request.url,
        };
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            contentKey: 'created-key',
            managedContentId: '20Y000000000001',
            managedContentVariantId: '20X000000000001',
          }),
        );
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;

    try {
      const connection = new JsforceConnection({
        accessToken: 'connection-owned-token',
        instanceUrl: `http://127.0.0.1:${port}`,
        version: '67.0',
      });
      const result = await createImageContent(connection, input, 'image.png', image, {
        boundaryFactory: constantBoundary('safe'),
      });

      expect(result.contentKey).to.equal('created-key');
      expect(captured).to.include({
        authorization: 'Bearer connection-owned-token',
        contentLength: String(expected.body.byteLength),
        contentType: 'multipart/form-data; boundary=safe',
        method: 'POST',
        url: '/services/data/v67.0/connect/cms/contents',
      });
      expect(captured?.body.equals(expected.body)).to.equal(true);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it('uses a token-only JSforce connection to prevent authenticated refresh replay', async () => {
    const response = {
      contentKey: 'created-key',
      managedContentId: '20Y000000000001',
      managedContentVariantId: '20X000000000001',
    };
    const jsforceRequest = sinon
      .stub(JsforceConnection.prototype, 'request')
      .returns(fakeRequest(Promise.resolve(response)));
    const originalRequest = sinon.stub();

    try {
      await createImageContent(
        {
          accessToken: 'connection-owned-token',
          instanceUrl: 'https://example.my.salesforce.com',
          request: originalRequest,
          version: '67.0',
        },
        input,
        'image.png',
        Buffer.from([1]),
        { boundaryFactory: constantBoundary('safe') },
      );

      expect(originalRequest.called).to.equal(false);
      expect(jsforceRequest.calledOnce).to.equal(true);
      const request = jsforceRequest.firstCall.args[0];
      expect(request).not.to.be.a('string');
      if (typeof request === 'string') {
        throw new TypeError('expected an HTTP request object');
      }
      const headers = request.headers as Record<string, string>;
      expect(headers.Authorization).to.equal(undefined);
      expect(headers.authorization).to.equal(undefined);
      expect(jsforceRequest.firstCall.args[1]).to.deep.include({ retry: { maxRetries: 0 } });
    } finally {
      jsforceRequest.restore();
    }
  });

  it('rejects malformed successful JSON and bounded redacted non-200 errors', async () => {
    const malformed = sinon
      .stub()
      .returns(fakeRequest(Promise.resolve({ contentKey: 'only-one' })));
    try {
      await createImageContent({ request: malformed }, input, 'image.png', Buffer.from([1]), {
        boundaryFactory: constantBoundary('safe'),
      });
      expect.fail('expected malformed response');
    } catch (error) {
      expect(error).to.be.instanceOf(CmsRequestError);
      expect((error as Error).message).to.equal('Malformed CMS image create response');
    }

    const secret = 's'.repeat(1500);
    const failure = Object.assign(
      new Error(`Authorization: Bearer ${secret} ?access_token=other-secret ${'x'.repeat(1500)}`),
      { statusCode: 503 },
    );
    const failed = sinon.stub().returns(fakeRequest(Promise.reject(failure)));
    try {
      await createImageContent({ request: failed }, input, 'image.png', Buffer.from([1]), {
        boundaryFactory: constantBoundary('safe'),
      });
      expect.fail('expected failed response');
    } catch (error) {
      expect(error).to.be.instanceOf(CmsRequestError);
      expect((error as CmsRequestError).status).to.equal(503);
      expect((error as Error).message).to.include('Authorization: [REDACTED]');
      expect((error as Error).message).to.not.include(secret);
      expect((error as Error).message.length).to.be.at.most(1024);
    }
    expect(failed.calledOnce).to.equal(true);
  });

  it('rejects invalid timeout and cancellation without another HTTP method', async () => {
    const request = sinon.stub();
    const controller = new AbortController();
    controller.abort();
    for (const options of [
      { boundaryFactory: constantBoundary('safe'), timeoutMs: 0 },
      { boundaryFactory: constantBoundary('safe'), signal: controller.signal },
    ]) {
      try {
        await createImageContent({ request }, input, 'image.png', Buffer.from([1]), options);
        expect.fail('expected preflight rejection');
      } catch (error) {
        expect(error).to.be.instanceOf(CmsRequestError);
      }
    }
    expect(request.called).to.equal(false);
  });
});
