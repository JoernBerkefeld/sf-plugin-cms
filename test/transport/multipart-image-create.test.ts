import { Connection as JsforceConnection } from '@jsforce/jsforce-node';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { PassThrough } from 'node:stream';
import { expect } from 'chai';
import { runWithInvocationLogging, type InvocationLogger } from '../../src/logging.js';
import sinon from 'sinon';
import {
  buildAudioCreateMultipart,
  buildDocumentCreateMultipart,
  buildImageCreateMultipart,
  createAudioContent,
  createDocumentContent,
  createImageContent,
  MAX_IMAGE_BYTES,
} from '../../src/transport/multipart-image-create.js';
import { CmsRequestError } from '../../src/transport/json-request.js';

import { prepareCmsConnection } from '../../src/api-policy.js';

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

describe('shared multipart CREATE logging', () => {
  for (const apiEnabled of [false, true]) {
    it(`logs shared Image/Document/Audio parsed boundaries with API ${apiEnabled}`, async () => {
      for (const family of ['image', 'document', 'audio']) {
        const records: unknown[] = [];
        const logger: InvocationLogger = {
          filePath: '',
          close: async () => {},
          log: (_level, _message, details) => {
            records.push(details);
          },
        };
        const data = {
          contentKey: 'key',
          managedContentId: 'parent',
          managedContentVariantId: 'variant',
        };
        const request = sinon.stub().returns(fakeRequest(Promise.resolve(data)));
        const bytes = Buffer.from('SECRETbinary');
        await runWithInvocationLogging(
          logger,
          () => {
            if (family === 'audio')
              return createAudioContent({ request }, input, 'sound.bin', bytes, {
                mimeType: 'audio/mpeg',
              });
            if (family === 'document')
              return createDocumentContent({ request }, input, 'file.txt', bytes);
            return createImageContent({ request }, input, 'image.png', bytes);
          },
          apiEnabled,
        );
        expect(request.calledOnce).to.equal(true);
        const text = JSON.stringify(records);
        expect(text).not.to.include('SECRETbinary');
        expect(text).to.include('unavailable: parsed SDK boundary');
        expect(text.includes('requestPayload')).to.equal(apiEnabled);
        expect(text.includes('parsedResponse')).to.equal(apiEnabled);
        if (apiEnabled) expect(text).to.include(`sfdc_cms__${family}`).and.include('byteLength');
      }
    });
  }
  it('retains exposed rejection data automatically and ignores a failing sink', async () => {
    const original = Object.assign(new Error('Bearer SECRETtoken'), {
      statusCode: 422,
      data: [{ message: 'useful validation', token: 'SECRETdata' }],
    });
    const records: unknown[] = [];
    const logger: InvocationLogger = {
      filePath: '',
      close: async () => {},
      log: (_level, _message, details) => {
        records.push(details);
      },
    };
    const request = sinon.stub().callsFake(() => fakeRequest(Promise.reject(original)));
    await runWithInvocationLogging(logger, async () => {
      try {
        await createImageContent({ request }, input, 'image.png', Buffer.from('x'));
        expect.fail();
      } catch (error) {
        expect(error).to.be.instanceOf(CmsRequestError);
      }
    });
    expect(JSON.stringify(records))
      .to.include('useful validation')
      .and.include('422')
      .and.not.include('SECRET');
    const broken = {
      ...logger,
      log: () => {
        throw new Error('sink failed');
      },
    };
    const data = {
      contentKey: 'key',
      managedContentId: 'parent',
      managedContentVariantId: 'variant',
    };
    const success = sinon.stub().returns(fakeRequest(Promise.resolve(data)));
    expect(
      await runWithInvocationLogging(
        broken,
        () => createImageContent({ request: success }, input, 'image.png', Buffer.from('x')),
        true,
      ),
    ).to.deep.equal(data);
    expect(success.calledOnce).to.equal(true);
  });
});

describe('pure multipart Audio CREATE preparation', () => {
  it('frames exact sliced opaque bytes with explicit MIME and Audio input, without sending', () => {
    const backing = Buffer.from([9, 0, 255, 128, 13, 10, 8]);
    const audio = backing.subarray(1, -1);
    const result = buildAudioCreateMultipart(input, 'sound.bin', audio, {
      mimeType: 'application/x-future-audio',
      boundaryFactory: constantBoundary('safe'),
    });
    const nativeInput = {
      ...input,
      contentType: 'sfdc_cms__audio',
      contentBody: { 'sfdc_cms:media': { source: { type: 'file' } } },
    };
    const expected = Buffer.concat([
      Buffer.from(
        '--safe\r\nContent-Disposition: form-data; name="ManagedContentInputParam"\r\n' +
          'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
          JSON.stringify(nativeInput) +
          '\r\n--safe\r\nContent-Disposition: form-data; name="contentData"; filename="sound.bin"\r\n' +
          'Content-Type: application/x-future-audio\r\n\r\n',
      ),
      audio,
      Buffer.from('\r\n--safe--\r\n'),
    ]);
    expect(result.input).to.deep.equal(nativeInput);
    expect(result.body.equals(expected)).to.equal(true);
  });
  it('accepts opaque non-WAV bytes above the revoked cap as local framing, not platform qualification', () => {
    const audio = Buffer.alloc(MAX_IMAGE_BYTES + 1, 255);
    const built = buildAudioCreateMultipart(input, 'opaque.bin', audio, {
      mimeType: 'audio/x-future',
      boundaryFactory: constantBoundary('safe'),
    });
    const start = built.body.lastIndexOf(Buffer.from('\r\n\r\n')) + 4;
    expect(
      createHash('sha256')
        .update(built.body.subarray(start, start + audio.length))
        .digest('hex'),
    ).to.equal(createHash('sha256').update(audio).digest('hex'));
  });
  it('requires runtime-safe explicit MIME before boundary generation', () => {
    const boundaryFactory = sinon.stub().returns('safe');
    for (const mimeType of [
      undefined,
      null,
      42,
      {},
      '',
      'audio',
      '/wav',
      'audio/',
      ' audio/wav',
      'audio/wav ',
      'audio/wav; charset=UTF-8',
      'audio/wav\r\nX: yes',
      'audio/\0wav',
      'audio/\u007Fwav',
      'audio/\u010Dwav',
    ]) {
      expect(() =>
        buildAudioCreateMultipart(input, 'sound.bin', Buffer.from([1]), {
          mimeType: mimeType as string,
          boundaryFactory,
        }),
      ).to.throw(TypeError, 'safe ASCII type/subtype');
    }
    expect(boundaryFactory.called).to.equal(false);
  });
  it('rejects unsafe and non-ASCII filenames before ASCII serialization', () => {
    const boundaryFactory = sinon.stub().returns('safe');
    for (const filename of [
      '',
      '.',
      '..',
      '../sound.bin',
      'a/b.bin',
      String.raw`a\b.bin`,
      'a".bin',
      'a\r\nX: yes.bin',
      'a\0.bin',
      'a\u007F.bin',
      'caf\u00E9.bin',
      'a\u010D.bin',
      'a\u010A.bin',
      'a\u0122.bin',
    ]) {
      expect(() =>
        buildAudioCreateMultipart(input, filename, Buffer.from([1]), {
          mimeType: 'audio/wav',
          boundaryFactory,
        }),
      ).to.throw(CmsRequestError);
    }
    expect(boundaryFactory.called).to.equal(false);
  });
  it('reuses bounded JSON/binary collision avoidance and rejects invalid boundaries', () => {
    const candidates = ['hero_image', 'collision', 'safe'];
    const options = { mimeType: 'audio/wav', boundaryFactory: () => candidates.shift()! };
    expect(
      buildAudioCreateMultipart(input, 'sound.bin', Buffer.from('collision'), options).boundary,
    ).to.equal('safe');
    for (const boundary of ['collision', 'bad boundary']) {
      expect(() =>
        buildAudioCreateMultipart(input, 'sound.bin', Buffer.from('collision'), {
          mimeType: 'audio/wav',
          boundaryFactory: constantBoundary(boundary),
          maxBoundaryAttempts: 2,
        }),
      ).to.throw(CmsRequestError, /boundary/u);
    }
    expect(() =>
      buildAudioCreateMultipart(input, 'sound.bin', Buffer.from([1]), {
        mimeType: 'audio/wav',
        maxBoundaryAttempts: 0,
      }),
    ).to.throw(CmsRequestError, 'positive integer');
  });
  it('retains nonempty binary, input allowlist and Buffer representability guards', () => {
    const options = { mimeType: 'audio/wav', boundaryFactory: constantBoundary('safe') };
    for (const audio of [Buffer.alloc(0), 'not-binary' as unknown as Uint8Array]) {
      expect(() => buildAudioCreateMultipart(input, 'sound.bin', audio, options)).to.throw(
        CmsRequestError,
      );
    }
    for (const byteLength of [Number.MAX_SAFE_INTEGER + 1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const audio = Object.defineProperty(new Uint8Array(1), 'byteLength', { value: byteLength });
      expect(() => buildAudioCreateMultipart(input, 'sound.bin', audio, options)).to.throw(
        CmsRequestError,
        'represented by a Buffer',
      );
    }
    expect(() =>
      buildAudioCreateMultipart(
        { ...input, contentType: 'sfdc_cms__document' } as typeof input,
        'sound.bin',
        Buffer.from([1]),
        options,
      ),
    ).to.throw(CmsRequestError, 'Unsupported image create field');
  });
});

describe('multipart Audio create sender', () => {
  const binding = {
    contentKey: 'audio-key',
    managedContentId: 'audio-parent',
    managedContentVariantId: 'audio-variant',
  };
  const options = {
    mimeType: 'application/x-future-audio',
    boundaryFactory: constantBoundary('safe'),
    timeoutMs: 1234,
  };

  it('sends one exact Audio POST with explicit MIME, sliced bytes and retry disabled', async () => {
    const backing = Buffer.from([9, 0, 255, 128, 13, 10, 8]);
    const audio = backing.subarray(1, -1);
    const expected = Buffer.concat([
      Buffer.from(
        '--safe\r\nContent-Disposition: form-data; name="ManagedContentInputParam"\r\n' +
          'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
          JSON.stringify({
            ...input,
            contentType: 'sfdc_cms__audio',
            contentBody: { 'sfdc_cms:media': { source: { type: 'file' } } },
          }) +
          '\r\n--safe\r\nContent-Disposition: form-data; name="contentData"; filename="sound.bin"\r\n' +
          'Content-Type: application/x-future-audio\r\n\r\n',
      ),
      audio,
      Buffer.from('\r\n--safe--\r\n'),
    ]);
    const request = sinon.stub().returns(fakeRequest(Promise.resolve(binding)));
    expect(await createAudioContent({ request }, input, 'sound.bin', audio, options)).to.deep.equal(
      binding,
    );
    expect(request.calledOnce).to.equal(true);
    expect(request.firstCall.args[0]).to.deep.equal({
      method: 'POST',
      url: '/connect/cms/contents',
      body: expected,
      headers: {
        'content-length': String(expected.length),
        'content-type': 'multipart/form-data; boundary=safe',
      },
    });
    expect(request.firstCall.args[1]).to.deep.equal({ retry: { maxRetries: 0 }, timeout: 1234 });
  });

  it('locally sends opaque non-WAV bytes above the revoked cap with exact bytes/hash, not native qualification', async () => {
    const backing = Buffer.alloc(MAX_IMAGE_BYTES + 3, 255);
    const audio = backing.subarray(1, -1);
    audio.set([0, 13, 10, 128]);
    const request = sinon.stub().returns(fakeRequest(Promise.resolve(binding)));
    await createAudioContent({ request }, input, 'opaque.bin', audio, options);
    expect(request.calledOnce).to.equal(true);
    const body = request.firstCall.args[0].body as Buffer;
    const header = Buffer.from(`Content-Type: ${options.mimeType}\r\n\r\n`);
    const start = body.indexOf(header) + header.length;
    expect(start).to.be.greaterThan(header.length);
    const sent = body.subarray(start, start + audio.byteLength);
    expect(sent.equals(audio)).to.equal(true);
    expect(createHash('sha256').update(sent).digest('hex')).to.equal(
      createHash('sha256').update(audio).digest('hex'),
    );
    expect(body.subarray(start + audio.byteLength).toString('ascii')).to.equal('\r\n--safe--\r\n');
  });

  it('rejects invalid framing, input, options and pre-abort without any POST', async () => {
    const request = sinon.stub();
    const controller = new AbortController();
    controller.abort();
    const cases: Array<{
      filename?: string;
      audio?: Uint8Array;
      input?: Parameters<typeof createAudioContent>[1];
      options?: Partial<Parameters<typeof createAudioContent>[4]>;
    }> = [
      { filename: '../sound.bin' },
      { filename: 'a".bin' },
      { filename: 'a\r\nInjected.bin' },
      { filename: 'a\u010D.bin' },
      { audio: Buffer.alloc(0) },
      { audio: 'not-binary' as unknown as Uint8Array },
      { audio: Object.defineProperty(new Uint8Array(1), 'byteLength', { value: Number.NaN }) },
      { input: { ...input, contentBody: {} } as Parameters<typeof createAudioContent>[1] },
      { input: { ...input, title: '' } },
      { options: { mimeType: undefined as unknown as string } },
      { options: { mimeType: 'audio/wav\r\nInjected: yes' } },
      { options: { boundaryFactory: constantBoundary('bad boundary') } },
      { options: { boundaryFactory: constantBoundary('collision'), maxBoundaryAttempts: 2 } },
      { options: { maxBoundaryAttempts: 0 } },
      ...[0, -1, Number.NaN, Number.POSITIVE_INFINITY].map((timeoutMs) => ({
        options: { timeoutMs },
      })),
      { options: { signal: controller.signal } },
    ];
    for (const candidate of cases) {
      try {
        await createAudioContent(
          { request },
          candidate.input ?? input,
          candidate.filename ?? 'sound.bin',
          candidate.audio ?? Buffer.from('collision'),
          { ...options, ...candidate.options },
        );
        expect.fail('expected Audio sender rejection');
      } catch (error) {
        expect(error).to.be.instanceOf(Error);
        expect(error).not.to.have.property('message', 'expected Audio sender rejection');
      }
    }
    expect(request.called).to.equal(false);
  });

  it('destroys the in-flight stream on cancellation without a second request', async () => {
    const controller = new AbortController();
    const stream = new PassThrough();
    const pending = new Promise<never>((_resolve, reject) => stream.once('error', reject));
    const destroy = sinon.spy(stream, 'destroy');
    const request = sinon.stub().returns(fakeRequest(pending, stream));
    const result = createAudioContent({ request }, input, 'sound.bin', Buffer.from([1]), {
      ...options,
      signal: controller.signal,
    });
    controller.abort();
    try {
      await result;
      expect.fail('expected cancellation');
    } catch (error) {
      expect(error).to.be.instanceOf(CmsRequestError);
      expect((error as Error).message).to.include('cancelled');
    }
    expect(stream.destroyed).to.equal(true);
    expect(destroy.calledOnce).to.equal(true);
    controller.abort();
    expect(request.calledOnce).to.equal(true);
  });

  it('never replays or refreshes socket, 401, rate-limit or malformed-success outcomes', async () => {
    for (const outcome of [
      new Error('ambiguous socket failure'),
      Object.assign(new Error('expired token'), { statusCode: 401 }),
      Object.assign(new Error('rate limited'), { statusCode: 429 }),
      { contentKey: 'incomplete' },
    ]) {
      const originalRequest = sinon.stub();
      const refresh = sinon.spy();
      const caller = {
        request: originalRequest,
        accessToken: 'connection-owned-token',
        instanceUrl: 'https://example.my.salesforce.com',
        version: '67.0',
        refreshFn: refresh,
      };
      const request = sinon
        .stub(JsforceConnection.prototype, 'request')
        .callsFake(() =>
          fakeRequest(
            outcome instanceof Error ? Promise.reject(outcome) : Promise.resolve(outcome),
          ),
        );
      try {
        try {
          await createAudioContent(caller, input, 'sound.bin', Buffer.from([1]), options);
          expect.fail('expected uncertain Audio CREATE');
        } catch (error) {
          expect(error).to.be.instanceOf(CmsRequestError);
          if ('statusCode' in outcome) {
            expect((error as CmsRequestError).status).to.equal(outcome.statusCode);
          }
        }
        expect(request.calledOnce).to.equal(true);
        expect(originalRequest.called).to.equal(false);
        expect(refresh.called).to.equal(false);
        expect(request.thisValues[0]).not.to.equal(caller);
        expect(request.thisValues[0]).to.have.property('_refreshDelegate', undefined);
        expect(request.firstCall.args[1]).to.deep.equal({
          retry: { maxRetries: 0 },
          timeout: 1234,
        });
      } finally {
        request.restore();
      }
    }
  });
});

describe('multipart Document create transport', () => {
  it('matches the qualified native text/plain multipart body byte for byte', () => {
    const backing = Buffer.from('discard\nDocument bytes\r\n\u00E4\nignore', 'utf8');
    const bytes = backing.subarray(8, -6);
    const result = buildDocumentCreateMultipart(input, 'owned.txt', bytes, {
      boundaryFactory: constantBoundary('safe'),
    });
    const nativeInput = {
      ...input,
      contentType: 'sfdc_cms__document',
      contentBody: { 'sfdc_cms:media': { source: { type: 'file' } } },
    };
    const expected = Buffer.concat([
      Buffer.from(
        '--safe\r\nContent-Disposition: form-data; name="ManagedContentInputParam"\r\n' +
          'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
          JSON.stringify(nativeInput) +
          '\r\n--safe\r\nContent-Disposition: form-data; name="contentData"; filename="owned.txt"\r\n' +
          'Content-Type: text/plain\r\n\r\n',
      ),
      bytes,
      Buffer.from('\r\n--safe--\r\n'),
    ]);
    expect(result.input).to.deep.equal(nativeInput);
    expect(result.body.equals(expected)).to.equal(true);
  });

  it('rejects unqualified extensions, injection and overrides before any request', async () => {
    const request = sinon.stub();
    for (const filename of ['../owned.txt', 'a".txt']) {
      try {
        await createDocumentContent({ request }, input, filename, Buffer.from('document'));
        expect.fail('expected invalid Document filename');
      } catch (error) {
        expect(error).to.be.instanceOf(CmsRequestError);
      }
    }
    for (const extra of [
      { contentType: 'sfdc_cms__image' },
      { mimeType: 'text/html' },
      { contentBody: {} },
    ]) {
      expect(() =>
        buildDocumentCreateMultipart({ ...input, ...extra }, 'owned.txt', Buffer.from('document')),
      ).to.throw(CmsRequestError, 'Unsupported image create field');
    }
    expect(request.called).to.equal(false);
  });

  it('rejects Unicode low-byte delimiters and filename corruption before framing or CREATE', async () => {
    const request = sinon.stub();
    const boundaryFactory = sinon.stub().returns('safe');
    for (const filename of [
      'owned\u010D.txt',
      'owned\u010A.txt',
      'owned\u0122.txt',
      'owned\u010D\u010AInjected.txt',
      'caf\u00E9.txt',
      '\u6587\u4EF6.txt',
      '\u{1F600}.txt',
    ]) {
      expect(() =>
        buildDocumentCreateMultipart(input, filename, Buffer.from('document'), { boundaryFactory }),
      ).to.throw(CmsRequestError, 'Document filename must contain only ASCII characters');
      try {
        await createDocumentContent({ request }, input, filename, Buffer.from('document'), {
          boundaryFactory,
        });
        expect.fail('expected non-ASCII Document filename rejection');
      } catch (error) {
        expect(error).to.be.instanceOf(CmsRequestError);
        expect((error as Error).message).to.equal(
          'Document filename must contain only ASCII characters',
        );
      }
    }
    expect(boundaryFactory.called).to.equal(false);
    expect(request.called).to.equal(false);
  });

  it('threads safe native Document MIME into framing', () => {
    const options = { boundaryFactory: constantBoundary('safe'), mimeType: 'image/avif' };
    const built = buildDocumentCreateMultipart(
      input,
      'owned.txt',
      Buffer.from('document'),
      options,
    );
    expect(built.body.toString('ascii')).to.include('Content-Type: image/avif\r\n\r\n');
  });

  it('rejects unsafe Document MIME before any request', async () => {
    const request = sinon.stub();
    for (const mimeType of [
      'application/pdf\r\nInjected: true',
      'text/plain; charset=UTF-8',
      '',
      'café/pdf',
    ]) {
      try {
        await createDocumentContent({ request }, input, 'native.bin', Buffer.from([255]), {
          mimeType,
        });
        expect.fail('expected unsafe MIME rejection');
      } catch (error) {
        expect(error).to.be.instanceOf(Error);
      }
    }
    expect(request.called).to.equal(false);
  });

  it('preserves nonempty bytes and bounded boundary collision rejection', () => {
    for (const bytes of [Buffer.alloc(0)]) {
      expect(() => buildDocumentCreateMultipart(input, 'owned.txt', bytes)).to.throw(
        CmsRequestError,
      );
    }
    expect(() =>
      buildDocumentCreateMultipart(input, 'owned.txt', Buffer.from('collision'), {
        boundaryFactory: constantBoundary('collision'),
        maxBoundaryAttempts: 2,
      }),
    ).to.throw(CmsRequestError, 'Unable to generate collision-free multipart boundary');
  });

  it('sends the exact built Document request once with retry disabled', async () => {
    const bytes = Buffer.from('owned document\n');
    const options = { boundaryFactory: constantBoundary('safe'), timeoutMs: 1234 };
    const expected = buildDocumentCreateMultipart(input, 'owned.txt', bytes, options);
    const binding = {
      contentKey: 'key',
      managedContentId: 'parent',
      managedContentVariantId: 'variant',
    };
    const request = sinon.stub().returns(fakeRequest(Promise.resolve(binding)));
    expect(
      await createDocumentContent({ request }, input, 'owned.txt', bytes, options),
    ).to.deep.equal(binding);
    expect(request.calledOnce).to.equal(true);
    expect(request.firstCall.args[0].body.equals(expected.body)).to.equal(true);
    expect(request.firstCall.args[0].headers).to.deep.equal({
      'content-length': String(expected.body.length),
      'content-type': 'multipart/form-data; boundary=safe',
    });
    expect(request.firstCall.args[1]).to.deep.equal({ retry: { maxRetries: 0 }, timeout: 1234 });
  });

  it('does not retry an ambiguous CREATE or malformed successful binding', async () => {
    for (const promise of [
      Promise.reject(new Error('ambiguous socket failure')),
      Promise.resolve({ contentKey: 'key' }),
    ]) {
      const request = sinon.stub().returns(fakeRequest(promise));
      try {
        await createDocumentContent({ request }, input, 'owned.txt', Buffer.from('document'));
        expect.fail('expected uncertain CREATE');
      } catch (error) {
        expect(error).to.be.instanceOf(CmsRequestError);
      }
      expect(request.calledOnce).to.equal(true);
      expect(request.firstCall.args[1].retry).to.deep.equal({ maxRetries: 0 });
    }
  });
});

describe('multipart image create transport', () => {
  it('threads generic MIME and opaque bytes above 10 MiB without changing binary hashes', async () => {
    for (const mimeType of ['image/avif', 'image/svg+xml', 'application/x-future-format']) {
      const backing = Buffer.alloc(MAX_IMAGE_BYTES + 3, 255);
      const image = backing.subarray(1, -1);
      image.set([0, 13, 10, 128]);
      const options = { boundaryFactory: constantBoundary('safe'), mimeType };
      const built = buildImageCreateMultipart(input, 'opaque.bin', image, options);
      const header = Buffer.from(`Content-Type: ${mimeType}\r\n\r\n`, 'ascii');
      const start = built.body.indexOf(header) + header.length;
      const binary = built.body.subarray(start, start + image.byteLength);
      expect(start).to.be.greaterThan(header.length);
      expect(createHash('sha256').update(binary).digest('hex')).to.equal(
        createHash('sha256').update(image).digest('hex'),
      );
      expect(built.body.subarray(start + image.byteLength).toString('ascii')).to.equal(
        '\r\n--safe--\r\n',
      );
      expect(built.body.includes(Buffer.from('charset=ISO-8859-1'))).to.equal(false);
      const binding = {
        contentKey: 'key',
        managedContentId: 'parent',
        managedContentVariantId: 'variant',
      };
      const request = sinon.stub().returns(fakeRequest(Promise.resolve(binding)));
      await createImageContent({ request }, input, 'opaque.bin', image, options);
      expect(request.calledOnce).to.equal(true);
      expect(request.firstCall.args[0].body.equals(built.body)).to.equal(true);
      expect(request.firstCall.args[1].retry).to.deep.equal({ maxRetries: 0 });
    }
  });

  it('rejects unknown unsafe MIME values before framing or requests', async () => {
    const request = sinon.stub();
    const boundaryFactory = sinon.stub().returns('safe');
    for (const mimeType of [
      null,
      42,
      {},
      '',
      'image',
      '/png',
      'image/',
      ' image/png',
      'image/png ',
      'image/png; charset=UTF-8',
      'image/png\r\nX-Evil: yes',
      'image/\0png',
      'image/\u007Fpng',
      'image/\u010Dpng',
    ]) {
      const options = { boundaryFactory, mimeType: mimeType as string };
      expect(() =>
        buildImageCreateMultipart(input, 'opaque.bin', Buffer.from([1]), options),
      ).to.throw(TypeError, 'safe ASCII type/subtype');
      try {
        await createImageContent({ request }, input, 'opaque.bin', Buffer.from([1]), options);
        expect.fail('expected MIME rejection');
      } catch (error) {
        expect(error).to.be.instanceOf(TypeError);
      }
    }
    expect(boundaryFactory.called).to.equal(false);
    expect(request.called).to.equal(false);
  });

  it('rejects unrepresentable binary lengths before boundary generation', () => {
    const boundaryFactory = sinon.stub().returns('safe');
    for (const byteLength of [Number.MAX_SAFE_INTEGER + 1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const image = Object.defineProperty(new Uint8Array(1), 'byteLength', { value: byteLength });
      expect(() =>
        buildImageCreateMultipart(input, 'opaque.bin', image, { boundaryFactory }),
      ).to.throw(CmsRequestError, 'represented by a Buffer');
    }
    expect(boundaryFactory.called).to.equal(false);
  });

  it('rejects non-ASCII create filenames before lossy header serialization', () => {
    for (const filename of ['caf\u00E9.bin', 'a\u010D.bin', 'a\u010A.bin', 'a\u0122.bin']) {
      expect(() => buildImageCreateMultipart(input, filename, Buffer.from([1]))).to.throw(
        CmsRequestError,
        'Image filename must contain only ASCII characters',
      );
    }
  });

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

  it('rejects invalid boundaries, zero bytes, and non-binary input', () => {
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
      buildImageCreateMultipart(input, 'image.png', 'not-binary' as unknown as Uint8Array, {
        boundaryFactory: constantBoundary('safe'),
      }),
    ).to.throw(CmsRequestError, 'Image data must be binary');
  });

  it('accepts the former cap and preserves a sliced view without adjacent bytes', () => {
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

  it('inherits latest and numeric selection on the actual fresh multipart connection', async () => {
    for (const selected of ['latest', '68.0']) {
      const caller = new JsforceConnection({
        accessToken: 'token',
        instanceUrl: 'https://example.my.salesforce.com',
        version: '67.0',
      });
      const discovery = sinon.stub(caller, 'request').resolves({});
      discovery.onFirstCall().resolves([{ version: '68.0' }]);
      await prepareCmsConnection(caller, selected);
      const request = sinon.stub(JsforceConnection.prototype, 'request').returns(
        fakeRequest(
          Promise.resolve({
            contentKey: 'key',
            managedContentId: 'content',
            managedContentVariantId: 'variant',
          }),
        ),
      );
      await createImageContent(caller, input, 'image.png', Buffer.from('image'));
      expect(request.firstCall.args[0]).to.have.property(
        'url',
        `/services/data/${selected === 'latest' ? 'latest' : 'v68.0'}/connect/cms/contents`,
      );
      expect(request.thisValues[0]).not.to.equal(caller);
      expect((request.thisValues[0] as JsforceConnection).version).to.equal('68.0');
      request.restore();
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
