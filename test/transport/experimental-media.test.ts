import { expect } from 'chai';
import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import sinon from 'sinon';
import {
  createRunOwnedDirectory,
  createRunOwnedTemp,
  removeRunOwnedPath,
  type RunOwnedTemp,
} from '../../src/filesystem/runOwnedTemp.js';
import {
  downloadExperimentalCmsMedia,
  EXPERIMENTAL_MEDIA_POLICY,
  isApprovedSalesforceMediaUrl,
} from '../../src/transport/experimental-media.js';

const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);

describe('experimental CMS media transport', () => {
  let run: RunOwnedTemp;
  let root: string;

  beforeEach(async () => {
    run = await createRunOwnedTemp('sf-plugin-cms-media');
    root = await createRunOwnedDirectory(run, 'fixture');
  });

  afterEach(async () => {
    await removeRunOwnedPath(run, root);
    await lstat(root).then(
      () => expect.fail('Fixture child must be removed'),
      (error: NodeJS.ErrnoException) => expect(error.code).to.equal('ENOENT'),
    );
    const retainedRoot = await lstat(run.root);
    expect(retainedRoot.isDirectory()).to.equal(true);
  });

  it('accepts only a strict IDNA-normalized HTTPS file.force.com subdomain', () => {
    expect(isApprovedSalesforceMediaUrl('https://tenant.file.force.com/cms/media/key')).to.equal(
      true,
    );
    for (const value of [
      'http://tenant.file.force.com/cms/media/key',
      'https://file.force.com/cms/media/key',
      'https://file.force.com.evil.test/cms/media/key',
      'https://evilfile.force.com/cms/media/key',
      'https://user@tenant.file.force.com/cms/media/key',
      'https://tenant.file.force.com:444/cms/media/key',
      'https://tenant.file.force.com.evil.test/cms/media/key',
      'https://tést.file.force.com.evil.test/cms/media/key',
      'https://xn--tst-bma.file.force.com.evil.test/cms/media/key',
    ]) {
      expect(isApprovedSalesforceMediaUrl(value), value).to.equal(false);
    }
  });

  it('forwards authorization only through the approved Salesforce redirect and strips sessions', async () => {
    const calls: Array<{ headers: Headers; url: string }> = [];
    const fetcher = sinon.stub().callsFake(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ headers: new Headers(init?.headers), url });
      return calls.length === 1
        ? new Response(null, {
            headers: {
              location:
                'https://tenant.file.force.com/cms/media/key?fileHash=' +
                createHash('md5').update(PNG).digest('hex') +
                '&fileName=image.png&version=1',
            },
            status: 301,
          })
        : new Response(PNG, {
            headers: { 'content-length': String(PNG.length), 'content-type': 'image/png' },
            status: 200,
          });
    });
    const md5 = createHash('md5').update(PNG).digest('hex');
    const result = await downloadExperimentalCmsMedia(
      new URL(
        `https://tenant.my.salesforce.com/cms/media/key?fileHash=${md5}&fileName=image.png&version=1`,
      ),
      {
        accessToken: 'synthetic-token',
        expectedMd5: md5,
        expectedMimeType: 'image/png',
        expectedSize: PNG.length,
        fetch: fetcher,
        instanceUrl: 'https://tenant.my.salesforce.com',
        outputFile: path.join(root, 'image.png'),
      },
    );
    expect(result.bytes).to.equal(PNG.length);
    expect(await readFile(path.join(root, 'image.png'))).to.deep.equal(PNG);
    expect(calls).to.have.length(2);
    expect(
      calls.every(({ headers }) => headers.get('authorization') === 'Bearer synthetic-token'),
    ).to.equal(true);
    expect(
      calls.every(({ headers }) => !headers.has('cookie') && !headers.has('x-sfdc-session')),
    ).to.equal(true);
  });

  it('admits text/plain only with explicit Document family and preserves exact bytes', async () => {
    const bytes = Buffer.from('Document fixture\r\nUTF-8 café\n');
    const md5 = createHash('md5').update(bytes).digest('hex');
    const source = new URL(
      `https://tenant.my.salesforce.com/cms/media/key?fileHash=${md5}&fileName=document.txt&version=1`,
    );
    const fetcher = sinon.stub().resolves(
      new Response(bytes, {
        headers: { 'content-type': 'text/plain', 'content-length': String(bytes.length) },
      }),
    );
    const base = {
      accessToken: 'synthetic-token',
      expectedMd5: md5,
      expectedMimeType: 'text/plain',
      expectedSize: bytes.length,
      fetch: fetcher,
      instanceUrl: 'https://tenant.my.salesforce.com',
      outputFile: path.join(root, 'document.txt'),
    };
    await expectRejected(
      downloadExperimentalCmsMedia(source, {
        ...base,
        contentType: 'sfdc_cms__document',
        expectedMimeType: 'application/pdf',
      }),
      'unsupported',
    );
    expect(fetcher.notCalled).to.equal(true);
    const result = await downloadExperimentalCmsMedia(source, {
      ...base,
      contentType: 'sfdc_cms__document',
    });
    expect(result).to.include({
      bytes: bytes.length,
      mimeType: 'text/plain',
      md5,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    });
    expect(await readFile(base.outputFile)).to.deep.equal(bytes);
    expect(new Headers(fetcher.firstCall.args[1].headers).get('accept')).to.equal('text/plain');
  });

  it('keeps Document extension, response MIME, byte/hash, cap and redirect checks fail-closed', async () => {
    const bytes = Buffer.from('Document fixture\n');
    const md5 = createHash('md5').update(bytes).digest('hex');
    for (const failure of [
      'extension',
      'missing-extension',
      'mime',
      'size',
      'md5',
      'length',
      'cap',
      'redirect',
    ]) {
      let fileName = 'document.txt';
      if (failure === 'extension') fileName = 'document.pdf';
      if (failure === 'missing-extension') fileName = 'document';
      const source = new URL(
        `https://tenant.my.salesforce.com/cms/media/key?fileHash=${md5}&fileName=${fileName}&version=1`,
      );
      const outputFile = path.join(root, `${failure}.txt`);
      await expectRejected(
        downloadExperimentalCmsMedia(source, {
          accessToken: 'synthetic-token',
          contentType: 'sfdc_cms__document',
          expectedMd5: failure === 'md5' ? '00000000000000000000000000000000' : md5,
          expectedMimeType: 'text/plain',
          expectedSize: bytes.length + Number(failure === 'size'),
          instanceUrl: 'https://tenant.my.salesforce.com',
          outputFile,
          maxBytes: failure === 'cap' ? bytes.length - 1 : bytes.length + 1,
          fetch: async () =>
            failure === 'redirect'
              ? new Response(null, {
                  status: 301,
                  headers: { location: 'https://evil.test/media' },
                })
              : new Response(bytes, {
                  headers: {
                    'content-type': failure === 'mime' ? 'image/png' : 'text/plain',
                    'content-length': String(bytes.length + Number(failure === 'length')),
                  },
                }),
        }),
        {
          extension: 'extension must be txt',
          'missing-extension': 'extension must be txt',
          mime: 'MIME type changed',
          size: 'authoring metadata',
          md5: 'MD5 differs',
          length: 'Content-Length',
          cap: 'exceeds the cap',
          redirect: 'outside the approved',
        }[failure]!,
      );
      await lstat(outputFile).then(
        () => expect.fail('Rejected Document must not leave a binary file'),
        (error: NodeJS.ErrnoException) => expect(error.code).to.equal('ENOENT'),
      );
    }
  });

  it('acquires explicit Audio audio/x-wav with exact bytes', async () => {
    const bytes = Buffer.from('RIFF\u0004\u0000\u0000\u0000WAVE');
    const md5 = createHash('md5').update(bytes).digest('hex');
    const source = new URL(
      `https://tenant.my.salesforce.com/cms/media/key?fileHash=${md5}&fileName=audio.wav&version=1`,
    );
    const fetcher = sinon
      .stub()
      .resolves(new Response(bytes, { headers: { 'content-type': 'audio/x-wav' } }));
    const base = {
      accessToken: 'synthetic-token',
      expectedMd5: md5,
      expectedMimeType: 'audio/x-wav',
      expectedSize: bytes.length,
      fetch: fetcher,
      instanceUrl: 'https://tenant.my.salesforce.com',
      outputFile: path.join(root, 'audio.wav'),
    };
    await expectRejected(
      downloadExperimentalCmsMedia(source, { ...base, contentType: 'sfdc_cms__document' }),
      'unsupported',
    );
    expect(fetcher.notCalled).to.equal(true);
    const result = await downloadExperimentalCmsMedia(source, {
      ...base,
      contentType: 'sfdc_cms__audio',
    });
    expect(result).to.include({
      bytes: bytes.length,
      mimeType: 'audio/x-wav',
      md5,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    });
    expect(await readFile(base.outputFile)).to.deep.equal(bytes);
    expect(new Headers(fetcher.firstCall.args[1].headers).get('accept')).to.equal('audio/x-wav');
  });

  it('transports opaque non-WAV Audio beyond the legacy cap without format qualification', async () => {
    const bytes = Buffer.alloc(EXPERIMENTAL_MEDIA_POLICY.perImageBytes + 1, 255);
    const md5 = createHash('md5').update(bytes).digest('hex');
    const outputFile = path.join(root, 'opaque-audio');
    const result = await downloadExperimentalCmsMedia(
      new URL(
        `https://tenant.my.salesforce.com/cms/media/key?fileHash=${md5}&fileName=opaque.bin&version=1`,
      ),
      {
        accessToken: 'synthetic-token',
        contentType: 'sfdc_cms__audio',
        expectedMd5: md5,
        expectedMimeType: 'audio/x-unfamiliar',
        expectedSize: bytes.length,
        instanceUrl: 'https://tenant.my.salesforce.com',
        outputFile,
        fetch: async () =>
          new Response(bytes, { headers: { 'content-type': 'audio/x-unfamiliar' } }),
      },
    );
    expect(result.bytes).to.equal(bytes.length);
    expect(result.sha256).to.equal(createHash('sha256').update(bytes).digest('hex'));
    expect(await readFile(outputFile)).to.deep.equal(bytes);
  });

  it('rejects Audio unsafe filename, MIME, integrity, cap and redirect failures', async () => {
    for (const failure of ['filename', 'mime', 'size', 'md5', 'length', 'cap', 'redirect']) {
      const bytes = Buffer.from('RIFF\u0004\u0000\u0000\u0000WAVE');
      const md5 = createHash('md5').update(bytes).digest('hex');
      let fileName = 'audio.wav';
      if (failure === 'filename') fileName = '../audio.wav';
      const outputFile = path.join(root, `${failure}.wav`);
      await expectRejected(
        downloadExperimentalCmsMedia(
          new URL(
            `https://tenant.my.salesforce.com/cms/media/key?fileHash=${md5}&fileName=${fileName}&version=1`,
          ),
          {
            accessToken: 'synthetic-token',
            contentType: 'sfdc_cms__audio',
            expectedMd5: failure === 'md5' ? '00000000000000000000000000000000' : md5,
            expectedMimeType: 'audio/x-wav',
            expectedSize: bytes.length + Number(failure === 'size'),
            instanceUrl: 'https://tenant.my.salesforce.com',
            outputFile,
            maxBytes: failure === 'cap' ? bytes.length - 1 : bytes.length + 1,
            fetch: async () =>
              failure === 'redirect'
                ? new Response(null, {
                    status: 301,
                    headers: { location: 'https://evil.test/media' },
                  })
                : new Response(bytes, {
                    headers: {
                      'content-type': failure === 'mime' ? 'audio/wav' : 'audio/x-wav',
                      'content-length': String(bytes.length + Number(failure === 'length')),
                    },
                  }),
          },
        ),
        {
          filename: 'filename is invalid',
          mime: 'MIME type changed',
          size: 'authoring metadata',
          md5: 'MD5 differs',
          length: 'Content-Length',
          cap: 'exceeds the cap',
          redirect: 'outside the approved',
        }[failure]!,
      );
      await lstat(outputFile).then(
        () => expect.fail('Rejected Audio must not leave a binary file'),
        (error: NodeJS.ErrnoException) => expect(error.code).to.equal('ENOENT'),
      );
    }
  });

  it('admits only explicit Video video/mp4 with byte-exact isom evidence', async () => {
    const bytes = Buffer.from('000000206674797069736f6d', 'hex');
    const md5 = createHash('md5').update(bytes).digest('hex');
    const source = new URL(
      `https://tenant.my.salesforce.com/cms/media/key?fileHash=${md5}&fileName=video.mp4&version=1`,
    );
    const fetcher = sinon
      .stub()
      .resolves(new Response(bytes, { headers: { 'content-type': 'video/mp4' } }));
    const base = {
      accessToken: 'synthetic-token',
      expectedMd5: md5,
      expectedMimeType: 'video/mp4',
      expectedSize: bytes.length,
      fetch: fetcher,
      instanceUrl: 'https://tenant.my.salesforce.com',
      outputFile: path.join(root, 'video.mp4'),
    };
    for (const contentType of ['sfdc_cms__document'] as const) {
      await expectRejected(
        downloadExperimentalCmsMedia(source, { ...base, contentType }),
        'unsupported',
      );
    }
    for (const expectedMimeType of ['video/webm', 'video/quicktime', 'application/octet-stream']) {
      await expectRejected(
        downloadExperimentalCmsMedia(source, {
          ...base,
          contentType: 'sfdc_cms__video',
          expectedMimeType,
        }),
        'unsupported',
      );
    }
    expect(fetcher.notCalled).to.equal(true);
    const result = await downloadExperimentalCmsMedia(source, {
      ...base,
      contentType: 'sfdc_cms__video',
    });
    expect(result).to.include({
      bytes: bytes.length,
      mimeType: 'video/mp4',
      md5,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    });
    expect(await readFile(base.outputFile)).to.deep.equal(bytes);
    expect(new Headers(fetcher.firstCall.args[1].headers).get('accept')).to.equal('video/mp4');
  });

  it('rejects Video extension, byte-exact signature and existing security failures', async () => {
    for (const failure of [
      'extension',
      'missing-extension',
      'signature',
      'high-bit-signature',
      'brand',
      'truncated',
      'mime',
      'size',
      'md5',
      'length',
      'cap',
      'redirect',
    ]) {
      let bytes = Buffer.from('000000206674797069736f6d', 'hex');
      if (failure === 'signature') bytes.write('fake', 4);
      if (failure === 'high-bit-signature') bytes = Buffer.from('00000020e6f4f9f0e9f3efed', 'hex');
      if (failure === 'brand') bytes.write('mp42', 8);
      if (failure === 'truncated') bytes = bytes.subarray(0, 11);
      const md5 = createHash('md5').update(bytes).digest('hex');
      let fileName = 'video.mp4';
      if (failure === 'extension') fileName = 'video.mov';
      if (failure === 'missing-extension') fileName = 'video';
      const outputFile = path.join(root, `video-${failure}.mp4`);
      await expectRejected(
        downloadExperimentalCmsMedia(
          new URL(
            `https://tenant.my.salesforce.com/cms/media/key?fileHash=${md5}&fileName=${fileName}&version=1`,
          ),
          {
            accessToken: 'synthetic-token',
            contentType: 'sfdc_cms__video',
            expectedMd5: failure === 'md5' ? '00000000000000000000000000000000' : md5,
            expectedMimeType: 'video/mp4',
            expectedSize: bytes.length + Number(failure === 'size'),
            instanceUrl: 'https://tenant.my.salesforce.com',
            outputFile,
            maxBytes: failure === 'cap' ? bytes.length - 1 : bytes.length + 1,
            fetch: async () =>
              failure === 'redirect'
                ? new Response(null, {
                    status: 301,
                    headers: { location: 'https://evil.test/media' },
                  })
                : new Response(bytes, {
                    headers: {
                      'content-type': failure === 'mime' ? 'video/webm' : 'video/mp4',
                      'content-length': String(bytes.length + Number(failure === 'length')),
                    },
                  }),
          },
        ),
        {
          extension: 'extension must be mp4',
          'missing-extension': 'extension must be mp4',
          signature: 'isom signature',
          'high-bit-signature': 'isom signature',
          brand: 'isom signature',
          truncated: 'isom signature',
          mime: 'MIME type changed',
          size: 'authoring metadata',
          md5: 'MD5 differs',
          length: 'Content-Length',
          cap: 'exceeds the cap',
          redirect: 'outside the approved',
        }[failure]!,
      );
      await lstat(outputFile).then(
        () => expect.fail('Rejected Video must not leave a binary file'),
        (error: NodeJS.ErrnoException) => expect(error.code).to.equal('ENOENT'),
      );
    }
  });

  it('preserves opaque Image bytes and exact native MIME without signature or suffix admission', async () => {
    const bytes = Buffer.from('Opaque API-admitted Image bytes');
    for (const [index, mimeType] of [
      'image/png',
      'image/x-unfamiliar+native',
      'Application/X-Native',
    ].entries()) {
      const md5 = createHash('md5').update(bytes).digest('hex');
      const outputFile = path.join(root, `opaque-${index}.bin`);
      const result = await downloadExperimentalCmsMedia(
        new URL('https://tenant.my.salesforce.com/cms/media/key?fileName=image.unfamiliar'),
        {
          accessToken: 'synthetic-token',
          expectedMd5: md5,
          expectedMimeType: mimeType,
          expectedSize: bytes.length,
          instanceUrl: 'https://tenant.my.salesforce.com',
          outputFile,
          fetch: async () =>
            new Response(bytes, {
              headers: { 'content-type': index === 2 ? 'application/octet-stream' : mimeType },
            }),
        },
      );
      expect(result).to.include({
        mimeType,
        bytes: bytes.length,
        md5,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      });
      expect(await readFile(outputFile)).to.deep.equal(bytes);
    }
  });

  for (const responseType of [
    'image/svg+xml; charset=utf-8',
    'IMAGE/SVG+XML; charset="utf-8"',
    'application/octet-stream; charset=ISO-8859-1',
    'APPLICATION/OCTET-STREAM; charset="ISO-8859-1"',
  ]) {
    it(`accepts parameterized Image HTTP Content-Type ${responseType} without changing native MIME`, async () => {
      const bytes = Buffer.from('<svg/>');
      const outputFile = path.join(
        root,
        `parameterized-${responseType.toLowerCase().startsWith('image') ? 'native' : 'generic'}-${responseType.includes('"') ? 'quoted' : 'token'}.svg`,
      );
      const result = await downloadExperimentalCmsMedia(
        new URL('https://tenant.my.salesforce.com/cms/media/key?fileName=image.svg'),
        {
          accessToken: 'synthetic-token',
          expectedMd5: createHash('md5').update(bytes).digest('hex'),
          expectedMimeType: 'Image/Svg+Xml',
          expectedSize: bytes.length,
          instanceUrl: 'https://tenant.my.salesforce.com',
          outputFile,
          fetch: async () => new Response(bytes, { headers: { 'content-type': responseType } }),
        },
      );
      expect(result.mimeType).to.equal('Image/Svg+Xml');
      expect(await readFile(outputFile)).to.deep.equal(bytes);
    });
  }

  it('downloads Images above 10 MiB while retaining the Document cap', async () => {
    const bytes = Buffer.alloc(10 * 1024 * 1024 + 1, 0x61);
    const md5 = createHash('md5').update(bytes).digest('hex');
    const base = {
      accessToken: 'synthetic-token',
      expectedMd5: md5,
      expectedSize: bytes.length,
      expectedMimeType: 'image/x-native',
      instanceUrl: 'https://tenant.my.salesforce.com',
      outputFile: path.join(root, 'large.bin'),
      fetch: async () =>
        new Response(bytes, {
          headers: { 'content-type': 'image/x-native', 'content-length': String(bytes.length) },
        }),
    };
    const source = new URL('https://tenant.my.salesforce.com/cms/media/key?fileName=image.bin');
    const downloaded = await downloadExperimentalCmsMedia(source, base);
    expect(downloaded.bytes).to.equal(bytes.length);
    await expectRejected(
      downloadExperimentalCmsMedia(source, {
        ...base,
        contentType: 'sfdc_cms__document',
        expectedMimeType: 'text/plain',
        maxBytes: Number.MAX_SAFE_INTEGER,
        fetch: async () =>
          new Response(bytes, {
            headers: { 'content-type': 'text/plain', 'content-length': String(bytes.length) },
          }),
      }),
      'exceeds the cap',
    );
  });

  it('rejects malformed Image MIME, unsafe sizes, empty bytes and integrity mismatches', async () => {
    const bytes = Buffer.from('opaque');
    const source = new URL('https://tenant.my.salesforce.com/cms/media/key?fileName=image.bin');
    const base = {
      accessToken: 'synthetic-token',
      expectedMd5: createHash('md5').update(bytes).digest('hex'),
      expectedMimeType: 'image/x-native',
      expectedSize: bytes.length,
      instanceUrl: 'https://tenant.my.salesforce.com',
      outputFile: path.join(root, 'invalid.bin'),
      fetch: async () => new Response(bytes, { headers: { 'content-type': 'image/x-native' } }),
    };
    for (const expectedMimeType of [
      'image/png;evil=x',
      'image/png\r\nx-header: injected',
      'image/é',
      'image',
      '',
    ]) {
      await expectRejected(
        downloadExperimentalCmsMedia(source, { ...base, expectedMimeType }),
        'safe ASCII',
      );
    }
    for (const responseType of [
      'image/é',
      'image',
      'image/x-native; charset',
      'image/x-native; charset=',
      'image/x-native; charset="unterminated',
      'image/x-native, image/png',
      '',
    ]) {
      await expectRejected(
        downloadExperimentalCmsMedia(source, {
          ...base,
          fetch: async () => new Response(bytes, { headers: { 'content-type': responseType } }),
        }),
        'safe ASCII',
      );
    }
    for (const expectedSize of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      await expectRejected(
        downloadExperimentalCmsMedia(source, { ...base, expectedSize }),
        'positive safe Buffer length',
      );
    }
    await expectRejected(
      downloadExperimentalCmsMedia(source, { ...base, expectedSize: bytes.length + 1 }),
      'authoring metadata',
    );
    await expectRejected(
      downloadExperimentalCmsMedia(source, { ...base, expectedMd5: '0'.repeat(32) }),
      'MD5 differs',
    );
    await expectRejected(
      downloadExperimentalCmsMedia(source, {
        ...base,
        fetch: async () =>
          new Response(Buffer.alloc(0), { headers: { 'content-type': 'image/x-native' } }),
      }),
      'authoring metadata',
    );
  });

  it('always closes and unlinks after opened-file failures while preserving the primary error', async () => {
    const md5 = createHash('md5').update(PNG).digest('hex');
    const source = new URL(
      `https://tenant.my.salesforce.com/cms/media/key?fileHash=${md5}&fileName=image.png&version=1`,
    );
    for (const failure of ['stream', 'write', 'close'] as const) {
      const primary = new Error(`${failure} bearer secret-token`);
      const close = sinon.stub().callsFake(async () => {
        if (failure === 'close') throw primary;
      });
      const write = sinon.stub().callsFake(async () => {
        if (failure === 'write') throw primary;
        return { buffer: PNG, bytesWritten: PNG.length, offset: 0 };
      });
      const unlinkFile = sinon.stub().rejects(new Error('unlink bearer secret-token'));
      let pulls = 0;
      const body =
        failure === 'stream'
          ? new ReadableStream<Uint8Array>({
              pull: (controller) => {
                if (pulls++ === 0) controller.enqueue(PNG.subarray(0, 1));
                else controller.error(primary);
              },
            })
          : PNG;
      let caught: unknown;
      try {
        await downloadExperimentalCmsMedia(source, {
          accessToken: 'synthetic-token',
          expectedMd5: md5,
          expectedMimeType: 'image/png',
          expectedSize: PNG.length,
          fetch: async () =>
            new Response(body, {
              headers: { 'content-length': String(PNG.length), 'content-type': 'image/png' },
              status: 200,
            }),
          instanceUrl: 'https://tenant.my.salesforce.com',
          openFile: async () => ({ close, write }),
          outputFile: path.join(root, `${failure}.png`),
          unlinkFile,
        });
      } catch (error) {
        caught = error;
      }
      expect(caught).to.equal(primary);
      expect(close.calledOnce).to.equal(true);
      expect(unlinkFile.calledOnce).to.equal(true);
      const diagnostics = (caught as Error & { cleanupDiagnostics?: string[] }).cleanupDiagnostics;
      expect(diagnostics).to.have.length(1);
      expect(JSON.stringify(diagnostics)).not.to.include('secret-token');
    }
  });

  it('rejects unapproved redirects, loops, login HTML, caps and integrity mismatches', async () => {
    const source = new URL(
      'https://tenant.my.salesforce.com/cms/media/key?fileHash=00000000000000000000000000000000&fileName=image.png&version=1',
    );
    const base = {
      accessToken: 'synthetic-token',
      expectedMd5: '00000000000000000000000000000000',
      expectedMimeType: 'image/png',
      expectedSize: PNG.length,
      instanceUrl: 'https://tenant.my.salesforce.com',
      outputFile: path.join(root, 'image.png'),
    };
    await expectRejected(
      downloadExperimentalCmsMedia(source, {
        ...base,
        fetch: async () =>
          new Response(null, { headers: { location: 'https://evil.test/media' }, status: 301 }),
      }),
      'outside the approved Salesforce class',
    );
    await expectRejected(
      downloadExperimentalCmsMedia(source, {
        ...base,
        fetch: async () =>
          new Response('<html>login</html>', {
            headers: { 'content-type': 'text/html' },
            status: 200,
          }),
      }),
      'not binary image content',
    );
    await expectRejected(
      downloadExperimentalCmsMedia(source, {
        ...base,
        fetch: async () =>
          new Response(PNG, {
            headers: { 'content-length': String(PNG.length), 'content-type': 'image/png' },
            status: 200,
          }),
        maxBytes: PNG.length - 1,
      }),
      'exceeds the cap',
    );
  });
});

async function expectRejected(promise: Promise<unknown>, text: string): Promise<void> {
  let failure: unknown;
  try {
    await promise;
  } catch (error) {
    failure = error;
  }
  expect((failure as Error).message).to.include(text);
}
