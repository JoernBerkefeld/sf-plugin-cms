import { createHash } from 'node:crypto';
import { expect } from 'chai';
import {
  buildDocumentUpdateMultipart,
  type DocumentUpdateInput,
} from '../../src/transport/multipart-document-update.js';
import { CmsRequestError } from '../../src/transport/json-request.js';
import sinon from 'sinon';
import { createDocumentContent } from '../../src/transport/multipart-image-create.js';
import { sendVariantUpdateMultipart } from '../../src/transport/multipart-image-update.js';

const input: DocumentUpdateInput = {
  apiName: 'CMSQ_Doc_8f3ca5070a2c',
  title: 'CMSQ_Doc_8f3ca5070a2c',
  urlName: 'cmsq-doc-8f3ca5070a2c',
  contentBody: { 'sfdc_cms:media': { source: { type: 'file' } } },
};
const bytes = Buffer.from('Owned Document UPDATE probe — café.\r\nSecond harmless line.\n', 'utf8');
const boundary = 'cms_document_update_b1dd8cf842b628a694c6fd237e1cb517955f';
const filename = 'CMSQ_Doc_8f3ca5070a2c.cms-document.media.txt';
const options = { boundaryFactory: () => boundary };

function build(value: unknown = input, name = filename, data: Uint8Array = bytes) {
  return buildDocumentUpdateMultipart(value as DocumentUpdateInput, name, data, options);
}

describe('pure native Document UPDATE multipart builder', () => {
  it('pins the accepted two-part CRLF envelope, UTF-8 bytes and captured body hash', () => {
    const built = build();
    const expected = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="ManagedContentVariantInputParam"\r\n` +
          'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
          JSON.stringify(input) +
          `\r\n--${boundary}\r\nContent-Disposition: form-data; name="contentData"; filename="${filename}"\r\n` +
          'Content-Type: text/plain\r\n\r\n',
        'utf8',
      ),
      bytes,
      Buffer.from(`\r\n--${boundary}--\r\n`, 'ascii'),
    ]);
    expect(built.body.equals(expected)).to.equal(true);
    expect(built.body.length).to.equal(667);
    expect(createHash('sha256').update(built.body).digest('hex')).to.equal(
      'ca1b70e688092779e7ace17561f8f86e3b9da485476b14e48024b6004357a845',
    );
    expect(bytes.length).to.equal(62);
    expect(createHash('sha256').update(bytes).digest('hex')).to.equal(
      '4f893cf249319507d755a3904f6d451f530f4953661f30a2d9d7d27605287b62',
    );
    expect(built.input).to.deep.equal(input);
    expect(built.boundary).to.equal(boundary);
    expect(built.body.toString('utf8')).not.to.include('Content-Transfer-Encoding');
    expect(built.body.toString('utf8')).not.to.include('name="ManagedContentInputParam"');
  });

  it('preserves Unicode JSON and offset-view binary without mutation or re-encoding', () => {
    const selected = { ...input, title: 'Document café — 更新' };
    const snapshot = structuredClone(selected);
    const backing = Buffer.concat([Buffer.from('prefix'), bytes, Buffer.from('suffix')]);
    const view = backing.subarray(6, -6);
    const built = build(selected, filename, view);
    expect(built.body.includes(Buffer.from(JSON.stringify(selected), 'utf8'))).to.equal(true);
    expect(built.body.includes(bytes)).to.equal(true);
    expect(built.body.includes(Buffer.from('prefix'))).to.equal(false);
    expect(built.body.includes(Buffer.from('suffix'))).to.equal(false);
    expect(selected).to.deep.equal(snapshot);
    expect(view.equals(bytes)).to.equal(true);
    backing.fill(0);
    selected.title = 'changed';
    expect(built.body.includes(bytes)).to.equal(true);
    expect(built.input.title).to.equal(snapshot.title);
  });

  it('omits server/read-only fields and rejects them rather than silently stripping', () => {
    for (const field of [
      'language',
      'contentType',
      'contentSpaceId',
      'contentSpaceOrFolderId',
      'managedContentId',
      'managedContentVariantId',
      'variantId',
      'contentKey',
      'folder',
      'isPublished',
      'status',
    ]) {
      expect(() => build({ ...input, [field]: 'server' })).to.throw(CmsRequestError);
      expect(Object.keys(build().input)).not.to.include(field);
    }
    for (const field of ['ref', 'size', 'mimeType', 'url', 'fileHash', 'version']) {
      for (const node of ['media', 'source']) {
        const selected = structuredClone(input);
        const media = selected.contentBody['sfdc_cms:media'];
        Object.assign(node === 'media' ? media : media.source, { [field]: 'readonly' });
        expect(() => build(selected)).to.throw(CmsRequestError);
      }
    }
  });

  it('rejects missing, malformed or broadened metadata combinations', () => {
    for (const value of [
      null,
      [],
      {},
      { ...input, contentBody: {} },
      { ...input, contentBody: { 'sfdc_cms:media': { source: { type: 'url' } } } },
      { ...input, contentBody: { 'sfdc_cms:media': { source: { type: 'file' }, extra: true } } },
    ])
      expect(() => build(value)).to.throw(CmsRequestError);
    for (const field of ['apiName', 'title', 'urlName']) {
      const missing: Record<string, unknown> = { ...input };
      delete missing[field];
      expect(() => build(missing)).to.throw(CmsRequestError);
      for (const value of ['', ' ', null, 42, 'bad\r\nvalue', 'bad\0value'])
        expect(() => build({ ...input, [field]: value })).to.throw(CmsRequestError);
    }
  });

  it('rejects unsafe or unproven filenames and binary profiles', () => {
    for (const name of [
      '',
      '../a.txt',
      'a/b.txt',
      String.raw`a\b.txt`,
      'a"b.txt',
      'a\r\nb.txt',
      'café.txt',
      'a\u007F.txt',
    ])
      expect(() => build(input, name)).to.throw(CmsRequestError);
    for (const data of [new Uint8Array()])
      expect(() => build(input, filename, data)).to.throw(CmsRequestError);
    expect(() => build(input, filename, 'text' as unknown as Uint8Array)).to.throw(CmsRequestError);
  });

  for (const method of ['CREATE', 'UPDATE']) {
    for (const rejected of [false, true]) {
      it(`preserves >10 MiB opaque Document MIME/bytes through ${method}, API rejection ${rejected}, without replay`, async () => {
        const binary = Buffer.alloc(10 * 1024 * 1024 + 1, 255);
        const nativeOptions = { ...options, mimeType: 'application/pdf' };
        const failure = Object.assign(new Error('native format rejected'), { statusCode: 415 });
        const response =
          method === 'CREATE'
            ? { contentKey: 'key', managedContentId: 'parent', managedContentVariantId: 'variant' }
            : {
                language: 'en_US',
                managedContentId: 'parent',
                managedContentVariantId: 'variant',
                contentBody: {},
                isPublished: false,
              };
        const request = sinon
          .stub()
          .callsFake(() => (rejected ? Promise.reject(failure) : Promise.resolve(response)));
        const multipart = buildDocumentUpdateMultipart(input, 'native.PDF', binary, nativeOptions);
        const invoke = () =>
          method === 'CREATE'
            ? createDocumentContent(
                { request },
                { apiName: input.apiName, title: input.title, contentSpaceOrFolderId: 'workspace' },
                'native.PDF',
                binary,
                nativeOptions,
              )
            : sendVariantUpdateMultipart({ request }, 'variant', multipart);
        if (rejected) {
          try {
            await invoke();
            expect.fail('expected native rejection');
          } catch (error) {
            expect(error).to.be.instanceOf(CmsRequestError);
            expect((error as CmsRequestError).status).to.equal(415);
            expect((error as Error).message).to.equal('native format rejected');
          }
        } else expect(await invoke()).to.deep.equal(response);
        expect(request.calledOnce).to.equal(true);
        const wire = request.firstCall.args[0].body as Buffer;
        expect(
          wire.includes(
            Buffer.from('filename="native.PDF"\r\nContent-Type: application/pdf\r\n\r\n'),
          ),
        ).to.equal(true);
        const start = wire.indexOf(binary);
        expect(start).to.be.greaterThan(0);
        expect(
          createHash('sha256')
            .update(wire.subarray(start, start + binary.length))
            .digest('hex'),
        ).to.equal(createHash('sha256').update(binary).digest('hex'));
        expect(request.firstCall.args[1].retry).to.deep.equal({ maxRetries: 0 });
      });
    }
  }

  it('rejects unsafe MIME before framing', () => {
    for (const mimeType of [
      'application/pdf\r\nInjected: true',
      'text/plain; charset=UTF-8',
      '',
      'café/pdf',
    ]) {
      expect(() =>
        buildDocumentUpdateMultipart(input, 'native.bin', bytes, { mimeType }),
      ).to.throw();
    }
  });

  it('regenerates JSON/binary collisions and bounds collision exhaustion', () => {
    const candidates = [input.apiName, 'Second', 'safe'];
    let calls = 0;
    const built = buildDocumentUpdateMultipart(input, filename, bytes, {
      boundaryFactory: () => candidates[calls++],
      maxBoundaryAttempts: 3,
    });
    expect(calls).to.equal(3);
    expect(built.boundary).to.equal('safe');
    expect(() =>
      buildDocumentUpdateMultipart(input, filename, bytes, {
        boundaryFactory: () => 'Second',
        maxBoundaryAttempts: 2,
      }),
    ).to.throw(CmsRequestError, 'collision-free');
    for (const maxBoundaryAttempts of [0, -1, 1.5])
      expect(() =>
        buildDocumentUpdateMultipart(input, filename, bytes, { maxBoundaryAttempts }),
      ).to.throw(CmsRequestError, 'positive integer');
    expect(() =>
      buildDocumentUpdateMultipart(input, filename, bytes, { boundaryFactory: () => 'bad\r\n' }),
    ).to.throw(CmsRequestError, 'Invalid multipart boundary');
    expect(buildDocumentUpdateMultipart(input, filename, bytes).boundary).to.match(
      /^[A-Za-z0-9-]+$/u,
    );
  });
});
