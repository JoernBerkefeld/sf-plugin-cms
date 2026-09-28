import { expect } from 'chai';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sinon from 'sinon';
import {
  downloadExperimentalCmsMedia,
  isApprovedSalesforceMediaUrl,
} from '../../src/transport/experimental-media.js';

const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);

describe('experimental CMS media transport', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'sf-plugin-cms-media-'));
  });

  afterEach(async () => {
    await rm(root, { force: true, recursive: true });
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
