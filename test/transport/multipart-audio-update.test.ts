import { constants as bufferConstants } from 'node:buffer';
import { createHash } from 'node:crypto';
import { expect } from 'chai';
import sinon from 'sinon';
import {
  buildAudioUpdateMultipart,
  type AudioUpdateInput,
  type MultipartAudioUpdateOptions,
} from '../../src/transport/multipart-audio-update.js';
import { CmsRequestError } from '../../src/transport/json-request.js';

const input = { title: 'Updated café', urlName: 'updated-audio' };
const bytes = Buffer.from([0, 255, 128, 13, 10, 1]);
const options = { mimeType: 'audio/x-wav', boundaryFactory: () => 'safe' };
const hash = (value: Uint8Array): string => createHash('sha256').update(value).digest('hex');

// All cases are local framing evidence, not native Audio UPDATE qualification.
describe('local unqualified pure Audio UPDATE multipart builder', () => {
  it('builds exact CRLF framing, filename, explicit MIME and closing delimiter', () => {
    const backing = Buffer.concat([Buffer.from([9]), bytes, Buffer.from([8])]);
    const built = buildAudioUpdateMultipart(
      input,
      'Original-name.WAV',
      backing.subarray(1, -1),
      options,
    );
    const expectedInput = {
      ...input,
      contentBody: { 'sfdc_cms:media': { source: { type: 'file' } } },
    };
    const expected = Buffer.concat([
      Buffer.from(
        '--safe\r\nContent-Disposition: form-data; name="ManagedContentVariantInputParam"\r\n' +
          'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
          JSON.stringify(expectedInput) +
          '\r\n--safe\r\nContent-Disposition: form-data; name="contentData"; filename="Original-name.WAV"\r\n' +
          'Content-Type: audio/x-wav\r\n\r\n',
        'utf8',
      ),
      bytes,
      Buffer.from('\r\n--safe--\r\n'),
    ]);
    expect(built.body.equals(expected)).to.equal(true);
    expect(built.boundary).to.equal('safe');
    expect(built.input).to.deep.equal(expectedInput);
    expect(Object.keys(built.input)).to.deep.equal(['title', 'urlName', 'contentBody']);
    expect(Object.keys(built.input.contentBody as object)).to.deep.equal(['sfdc_cms:media']);
    expect(built.input).not.to.have.property('apiName');
    expect(input).to.deep.equal({ title: 'Updated café', urlName: 'updated-audio' });
  });

  it('omits absent optional URL and detaches returned metadata and opaque nonzero-offset bytes', () => {
    const selected = { title: 'Only title' };
    const backing = new Uint8Array([9, ...bytes, 8]);
    const view = new Uint8Array(backing.buffer, 1, bytes.length);
    const built = buildAudioUpdateMultipart(selected, 'opaque.bin', view, options);
    const before = hash(built.body);
    selected.title = 'Changed';
    backing.fill(7);
    expect(hash(built.body)).to.equal(before);
    expect(built.input).to.deep.equal({
      title: 'Only title',
      contentBody: { 'sfdc_cms:media': { source: { type: 'file' } } },
    });
    expect(built.body.includes(bytes)).to.equal(true);
  });

  it('locally frames unfamiliar safe MIME and opaque non-WAV bytes above revoked 10 MiB', () => {
    const opaque = Buffer.alloc(10 * 1024 * 1024 + 1, 255);
    opaque.set(bytes);
    const built = buildAudioUpdateMultipart(input, 'opaque.dat', opaque, {
      ...options,
      mimeType: 'application/x-future-audio',
    });
    const header = Buffer.from('Content-Type: application/x-future-audio\r\n\r\n');
    const start = built.body.indexOf(header) + header.length;
    expect(start).to.be.greaterThan(header.length);
    expect(hash(built.body.subarray(start, start + opaque.length))).to.equal(hash(opaque));
    expect(built.body.subarray(start + opaque.length).toString('ascii')).to.equal(
      '\r\n--safe--\r\n',
    );
    expect(built.body.includes(Buffer.from('charset=ISO-8859-1'))).to.equal(false);
  });

  it('requires safe explicit MIME at runtime without a fallback', () => {
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
      'audio/wav\r\nInjected: yes',
      'audio/\0wav',
      'audio/\u007Fwav',
      'audio/\u010Dwav',
    ]) {
      expect(() =>
        buildAudioUpdateMultipart(input, 'a.wav', bytes, {
          boundaryFactory,
          mimeType,
        } as MultipartAudioUpdateOptions),
      ).to.throw(TypeError, 'safe ASCII type/subtype');
    }
    expect(() =>
      buildAudioUpdateMultipart(
        input,
        'a.wav',
        bytes,
        undefined as unknown as MultipartAudioUpdateOptions,
      ),
    ).to.throw(TypeError);
    expect(boundaryFactory.called).to.equal(false);
  });

  it('rejects every extra field including CREATE, identity, server and body overrides', () => {
    for (const key of [
      'apiName',
      'contentKey',
      'contentType',
      'contentSpaceOrFolderId',
      'workspaceId',
      'language',
      'managedContentId',
      'managedContentVariantId',
      'isPublished',
      'contentBody',
      'media',
      'source',
      'url',
      'mimeType',
      'nativeUrl',
    ]) {
      expect(() =>
        buildAudioUpdateMultipart({ ...input, [key]: 'value' }, 'a.wav', bytes, options),
      ).to.throw(CmsRequestError, 'Unsupported audio update field');
    }
    for (const key of ['hidden', Symbol('extra')]) {
      const extra = Object.defineProperty({ ...input }, key, { value: true });
      expect(() => buildAudioUpdateMultipart(extra, 'a.wav', bytes, options)).to.throw(
        CmsRequestError,
        'Unsupported audio update field',
      );
    }
  });

  it('rejects malformed input, missing title and invalid title or optional URL', () => {
    for (const value of [null, [], 'text', {}, { urlName: 'only-url' }]) {
      expect(() =>
        buildAudioUpdateMultipart(value as AudioUpdateInput, 'a.wav', bytes, options),
      ).to.throw(CmsRequestError);
    }
    for (const value of ['', null, 1, 'bad\r\nvalue', 'bad\0value', 'bad\u007Fvalue']) {
      for (const key of ['title', 'urlName']) {
        expect(() =>
          buildAudioUpdateMultipart(
            { ...input, [key]: value } as AudioUpdateInput,
            'a.wav',
            bytes,
            options,
          ),
        ).to.throw(CmsRequestError);
      }
    }
    expect(() =>
      buildAudioUpdateMultipart({ ...input, urlName: undefined }, 'a.wav', bytes, options),
    ).to.throw(CmsRequestError);
  });

  it('rejects unsafe or non-ASCII filenames before generating a boundary', () => {
    const boundaryFactory = sinon.stub().returns('safe');
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
      'café.wav',
      'a\u010D.wav',
      '😀.wav',
    ]) {
      expect(() =>
        buildAudioUpdateMultipart(input, filename, bytes, { ...options, boundaryFactory }),
      ).to.throw(CmsRequestError, 'Invalid image filename');
    }
    expect(boundaryFactory.called).to.equal(false);
  });

  it('rejects empty, nonbinary and Buffer-unrepresentable data', () => {
    const boundaryFactory = sinon.stub().returns('safe');
    for (const value of [Buffer.alloc(0), 'text', null]) {
      expect(() =>
        buildAudioUpdateMultipart(input, 'a.wav', value as Uint8Array, {
          ...options,
          boundaryFactory,
        }),
      ).to.throw(CmsRequestError);
    }
    for (const byteLength of [
      bufferConstants.MAX_LENGTH + 1,
      Number.MAX_SAFE_INTEGER + 1,
      Number.POSITIVE_INFINITY,
    ]) {
      const value = Object.defineProperty(new Uint8Array(1), 'byteLength', { value: byteLength });
      expect(() =>
        buildAudioUpdateMultipart(input, 'a.wav', value, { ...options, boundaryFactory }),
      ).to.throw(CmsRequestError, 'represented by a Buffer');
    }
    expect(boundaryFactory.called).to.equal(false);
  });

  it('rejects invalid boundaries and attempt budgets', () => {
    for (const boundary of ['', 'bad boundary', 'x'.repeat(71), 'bad\r\n']) {
      expect(() =>
        buildAudioUpdateMultipart(input, 'a.wav', bytes, {
          ...options,
          boundaryFactory: () => boundary,
        }),
      ).to.throw(CmsRequestError, 'Invalid multipart boundary');
    }
    for (const maxBoundaryAttempts of [0, -1, 1.5, Number.NaN]) {
      expect(() =>
        buildAudioUpdateMultipart(input, 'a.wav', bytes, { ...options, maxBoundaryAttempts }),
      ).to.throw(CmsRequestError, 'positive integer');
    }
  });

  it('retries JSON and binary boundary collisions within the exact attempt budget', () => {
    const boundaryFactory = sinon
      .stub()
      .onFirstCall()
      .returns('title')
      .onSecondCall()
      .returns('collision')
      .onThirdCall()
      .returns('safe');
    expect(
      buildAudioUpdateMultipart(input, 'a.wav', Buffer.from('collision'), {
        ...options,
        boundaryFactory,
        maxBoundaryAttempts: 3,
      }).boundary,
    ).to.equal('safe');
    expect(boundaryFactory.callCount).to.equal(3);
    for (const collision of ['title', 'collision']) {
      const exhausted = sinon.stub().returns(collision);
      expect(() =>
        buildAudioUpdateMultipart(input, 'a.wav', Buffer.from('collision'), {
          ...options,
          boundaryFactory: exhausted,
          maxBoundaryAttempts: 2,
        }),
      ).to.throw(CmsRequestError, 'collision-free');
      expect(exhausted.callCount).to.equal(2);
    }
  });
});
