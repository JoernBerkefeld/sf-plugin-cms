import { PassThrough } from 'node:stream';
import { Connection as JsforceConnection } from '@jsforce/jsforce-node';
import type { Transport } from '@jsforce/jsforce-node/lib/transport.js';
import { expect } from 'chai';
import sinon from 'sinon';
import {
  CmsRequestError,
  getSelectedOperation,
  requestJson,
} from '../../src/transport/json-request.js';

import { runWithInvocationLogging, type InvocationLogger } from '../../src/logging.js';

type FakeRequest<T> = Promise<T> & { stream(): PassThrough };

function fakeRequest<T>(promise: Promise<T>, stream = new PassThrough()): FakeRequest<T> {
  return Object.assign(promise, { stream: () => stream });
}

describe('CMS JSON request transport', () => {
  it('binds actual SDK terminal responses to concurrent exact GETs without mutating the connection', async () => {
    const connection = new JsforceConnection({
      instanceUrl: 'https://example.salesforce.com',
      accessToken: 'test-token',
      version: '67.0',
    });
    const calls: Array<{ url: string; authorization?: string; timeout?: number }> = [];
    const transport: Pick<Transport, 'httpRequest'> = {
      httpRequest(request, options) {
        calls.push({
          url: request.url,
          authorization: request.headers?.Authorization,
          timeout: options?.timeout,
        });
        const variant = request.url.endsWith('/variants/variant');
        return fakeRequest(
          Promise.resolve({
            statusCode: variant ? 404 : 403,
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify([
              { errorCode: variant ? 'VARIANT_NOT_FOUND' : 'NOT_FOUND', message: 'Absent' },
            ]),
          }),
        );
      },
    };
    Object.assign(connection, { _transport: transport });
    const results = await Promise.allSettled([
      requestJson(
        connection,
        getSelectedOperation('variant.get'),
        { path: { variantId: 'variant' } },
        { timeoutMs: 4321 },
      ),
      requestJson(
        connection,
        getSelectedOperation('content.get'),
        { path: { contentKeyOrId: 'parent' } },
        { timeoutMs: 8765 },
      ),
    ]);
    for (const [index, result] of results.entries()) {
      expect(result.status).to.equal('rejected');
      if (result.status === 'rejected')
        expect(result.reason).to.include({
          status: index === 0 ? 404 : 403,
          statusObserved: true,
          errorEntryCount: 1,
          errorCode: index === 0 ? 'VARIANT_NOT_FOUND' : 'NOT_FOUND',
          operationKey: index === 0 ? 'variant.get' : 'content.get',
        });
    }
    expect(calls.map(({ timeout }) => timeout)).to.deep.equal([4321, 8765]);
    expect(
      calls.every(
        ({ url, authorization }) =>
          url.startsWith('https://example.salesforce.com/services/data/v67.0/connect/cms/') &&
          authorization === 'Bearer test-token',
      ),
    ).to.equal(true);
    expect((connection as unknown as { _transport: unknown })._transport).to.equal(transport);
  });

  it('attributes refresh readback only to the terminal response, never an earlier attempt', async () => {
    for (const terminal of [404, 403, 'network'] as const) {
      const connection = new JsforceConnection({
        instanceUrl: 'https://example.salesforce.com',
        accessToken: 'old-token',
        version: '67.0',
      });
      let attempts = 0;
      const refresh = sinon.spy(async () => {
        connection.accessToken = 'new-token';
      });
      Object.assign(connection, {
        _refreshDelegate: { isRefreshing: () => false, refresh },
        _transport: {
          httpRequest(request: { headers?: { Authorization?: string } }) {
            attempts += 1;
            if (attempts === 2) expect(request.headers?.Authorization).to.equal('Bearer new-token');
            if (attempts === 2 && terminal === 'network')
              return fakeRequest(Promise.reject(new Error('Network unavailable')));
            return fakeRequest(
              Promise.resolve({
                statusCode: attempts === 1 ? 401 : terminal,
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify([{ errorCode: 'VARIANT_NOT_FOUND', message: 'Absent' }]),
              }),
            );
          },
        },
      });
      try {
        await requestJson(connection, getSelectedOperation('variant.get'), {
          path: { variantId: 'variant' },
        });
        expect.fail('expected rejection');
      } catch (error) {
        expect(error).to.be.instanceOf(CmsRequestError);
        expect(error).to.include({
          status: terminal === 'network' ? undefined : terminal,
          statusObserved: terminal !== 'network',
        });
      }
      expect(attempts).to.equal(2);
      expect(refresh.calledOnce).to.equal(true);
    }
  });

  it('keeps cancellation stream identity through the request-local wrapper', async () => {
    const stream = new PassThrough();
    const controller = new AbortController();
    const pending = new Promise<never>((_resolve, reject) => stream.once('error', reject));
    const transport = { httpRequest: () => fakeRequest(pending, stream) };
    const connection = {
      _transport: transport,
      request<T>(_request: unknown, options: unknown) {
        const wrapped = (options as { transport: typeof transport }).transport.httpRequest();
        expect(wrapped.stream()).to.equal(stream);
        return wrapped as Promise<T> & { stream(): PassThrough };
      },
    };
    const result = requestJson(
      connection,
      getSelectedOperation('variant.get'),
      { path: { variantId: 'variant' } },
      { signal: controller.signal },
    );
    controller.abort();
    try {
      await result;
      expect.fail('expected cancellation');
    } catch (error) {
      expect(error).to.include({ statusObserved: false });
      expect((error as Error).message).to.equal('CMS request cancelled');
    }
    expect(stream.destroyed).to.equal(true);
  });

  it('retains malformed, multiple, permission and network SDK failures without inventing absence evidence', async () => {
    for (const [status, body, code, count] of [
      [404, 'not-json', 'ERROR_HTTP_404', 1],
      [
        404,
        JSON.stringify([
          { errorCode: 'VARIANT_NOT_FOUND', message: 'Absent' },
          { errorCode: 'OTHER', message: 'Other' },
        ]),
        undefined,
        2,
      ],
      [
        403,
        JSON.stringify([{ errorCode: 'INSUFFICIENT_ACCESS', message: 'Denied' }]),
        'INSUFFICIENT_ACCESS',
        1,
      ],
      [
        503,
        JSON.stringify([{ errorCode: 'SERVER_ERROR', message: 'Unavailable' }]),
        'SERVER_ERROR',
        1,
      ],
      [undefined, '', undefined, 0],
    ] as const) {
      const connection = new JsforceConnection({
        instanceUrl: 'https://example.salesforce.com',
        accessToken: 'token',
      });
      Object.assign(connection, {
        _transport: {
          httpRequest() {
            return status === undefined
              ? fakeRequest(Promise.reject(new Error('Network unavailable')))
              : fakeRequest(
                  Promise.resolve({
                    statusCode: status,
                    headers: { 'content-type': 'application/json' },
                    body,
                  }),
                );
          },
        },
      });
      try {
        await requestJson(connection, getSelectedOperation('variant.get'), {
          path: { variantId: 'variant' },
        });
        expect.fail('expected rejection');
      } catch (error) {
        expect(error).to.be.instanceOf(CmsRequestError);
        expect(error).to.include({
          status,
          statusObserved: status !== undefined,
          errorCode: code,
          errorEntryCount: count,
        });
      }
    }
  });

  it('does not treat SDK code-only variant absence as observed HTTP status', async () => {
    const error = Object.assign(new Error('Absent'), {
      name: 'VARIANT_NOT_FOUND',
      errorCode: 'VARIANT_NOT_FOUND',
      data: { errorCode: 'VARIANT_NOT_FOUND', message: 'Absent' },
    });
    try {
      await requestJson(
        { request: () => fakeRequest(Promise.reject(error)) },
        getSelectedOperation('variant.get'),
        { path: { variantId: 'variant' } },
      );
      expect.fail('expected rejection');
    } catch (error_) {
      expect(error_).to.include({
        errorCode: 'VARIANT_NOT_FOUND',
        errorEntryCount: 1,
        statusObserved: false,
        status: undefined,
      });
    }
  });

  it('isolates concurrent API opt-in, correlates phases and never inspects success streams', async () => {
    const logs = [sinon.spy(), sinon.spy()];
    const stream = new PassThrough();
    const streamAccess = sinon.spy(() => stream);
    const data = {
      nested: { accessToken: 'SECRET', body: 'customer body' },
      stream,
      binary: Buffer.from('binary'),
    };
    const receivers: unknown[] = [];
    await Promise.all(
      logs.map(async (log, index) => {
        const connection = {
          request<T>() {
            receivers.push(this);
            return Object.assign(Promise.resolve(data as T), { stream: streamAccess });
          },
        };
        const logger: InvocationLogger = { filePath: 'unused', log, close: async () => {} };
        const result = await runWithInvocationLogging(
          logger,
          () => requestJson(connection, getSelectedOperation('workspace.list')),
          index === 0,
        );
        expect(result.data).to.equal(data);
        expect(receivers).to.include(connection);
      }),
    );
    expect(streamAccess.called).to.equal(false);
    expect(stream.readableFlowing).to.equal(null);
    for (const [index, log] of logs.entries()) {
      expect(log.callCount).to.equal(2);
      const request = log.firstCall.args[2];
      const response = log.secondCall.args[2];
      expect(request.requestId).to.equal(response.requestId);
      expect(response.status).to.include('unavailable');
      expect(response.rawBody).to.include('unavailable');
      expect(JSON.stringify(log.args)).not.to.include('SECRET');
      if (index === 0) {
        expect(response.parsedResponse.stream).to.deep.equal({ omitted: 'stream (not consumed)' });
        expect(response.parsedResponse.binary).to.deep.equal({ omitted: 'binary', byteLength: 6 });
      } else expect(response).not.to.have.property('parsedResponse');
    }
    expect(logs[0].firstCall.args[2].requestId).not.to.equal(logs[1].firstCall.args[2].requestId);
  });

  it('keeps exposed SDK error causes automatically and does not invent observed status', async () => {
    for (const status of [undefined, 503]) {
      const log = sinon.spy();
      const original = Object.assign(new Error('failed', { cause: new Error('password=SECRET') }), {
        errorCode: 'NOT_FOUND',
        ...(status ? { response: { status } } : {}),
      });
      const logger: InvocationLogger = { filePath: 'unused', log, close: async () => {} };
      try {
        await runWithInvocationLogging(logger, () =>
          requestJson(
            { request: sinon.stub().returns(fakeRequest(Promise.reject(original))) },
            getSelectedOperation('workspace.list'),
          ),
        );
        expect.fail('expected error');
      } catch (error) {
        expect(error).to.be.instanceOf(CmsRequestError);
      }
      expect(log.secondCall.args[0]).to.equal('error');
      const details = log.secondCall.args[2];
      expect(details.error.cause.message).to.equal('password=[REDACTED]');
      if (status) expect(details.status).to.equal(status);
      else expect(details.status).to.include('unavailable');
    }
  });

  it('normalizes API errors with status and redacts secrets', async () => {
    const error = Object.assign(
      new Error(
        'Authorization: Bearer secret.access.token request failed at ?access_token=another-secret',
      ),
      { statusCode: 503 },
    );
    const request = sinon.stub().returns(fakeRequest(Promise.reject(error)));

    try {
      await requestJson({ request }, getSelectedOperation('workspace.list'));
      expect.fail('expected request to fail');
    } catch (error_) {
      expect(error_).to.be.instanceOf(CmsRequestError);
      expect(error_).to.include({ operationKey: 'workspace.list', status: 503 });
      expect((error_ as Error).message).to.equal(
        'Authorization: [REDACTED] request failed at ?access_token=[REDACTED]',
      );
      expect((error_ as Error).message).to.not.include('secret');
    }
  });

  it('preserves a structured variant 404 from the response object', async () => {
    const request = sinon.stub().returns(
      fakeRequest(
        Promise.reject(
          Object.assign(new Error('variant read failed'), {
            response: {
              data: [{ errorCode: 'VARIANT_NOT_FOUND', message: 'Variant not found' }],
              status: 404,
            },
          }),
        ),
      ),
    );

    try {
      await requestJson({ request }, getSelectedOperation('variant.get'), {
        path: { variantId: 'missing-variant' },
      });
      expect.fail('expected request to fail');
    } catch (error) {
      expect(error).to.be.instanceOf(CmsRequestError);
      expect(error).to.include({
        errorCode: 'VARIANT_NOT_FOUND',
        errorEntryCount: 1,
        operationKey: 'variant.get',
        responseMessage: 'Variant not found',
        status: 404,
      });
    }
  });

  it('does not synthesize HTTP 404 from a NOT_FOUND code without an observed status', async () => {
    const request = sinon.stub().returns(
      fakeRequest(
        Promise.reject(
          Object.assign(new Error('Managed content not found.'), {
            data: { errorCode: 'NOT_FOUND', message: 'Managed content not found.' },
            errorCode: 'NOT_FOUND',
            name: 'NOT_FOUND',
          }),
        ),
      ),
    );

    try {
      await requestJson({ request }, getSelectedOperation('content.get'), {
        path: { contentKeyOrId: 'missing-key' },
      });
      expect.fail('expected request to fail');
    } catch (error) {
      expect(error).to.be.instanceOf(CmsRequestError);
      expect(error).to.include({
        errorCode: 'NOT_FOUND',
        errorEntryCount: 1,
        operationKey: 'content.get',
        responseMessage: 'Managed content not found.',
        status: 404,
        statusObserved: false,
      });
      expect((error as Error).message).to.equal('Managed content not found.');
    }
  });

  it('preserves legacy error-code construction and redacts structured evidence', () => {
    const legacy = new CmsRequestError('content.get', 'request failed', 400, 'INVALID_ID_FIELD');
    expect(legacy).to.include({ errorCode: 'INVALID_ID_FIELD', errorEntryCount: 0 });

    const structured = new CmsRequestError(
      'content.get',
      'Authorization: Bearer secret.access.token',
      400,
      {
        errorCode: 'INVALID_ID_FIELD',
        errorEntryCount: 1,
        responseMessage: '?access_token=another-secret',
      },
    );
    expect(structured.message).to.equal('Authorization: [REDACTED]');
    expect(structured.responseMessage).to.equal('?access_token=[REDACTED]');
  });

  it('supports cancellation and rejects already-aborted requests', async () => {
    const controller = new AbortController();
    controller.abort();
    try {
      await requestJson(
        { request: sinon.stub() },
        getSelectedOperation('workspace.list'),
        {},
        { signal: controller.signal },
      );
      expect.fail('expected cancelled request to fail');
    } catch (error) {
      expect(error).to.be.instanceOf(CmsRequestError);
      expect((error as Error).message).to.equal('CMS request cancelled');
    }

    const stream = new PassThrough();
    const pending = new Promise<never>((_resolve, reject) => {
      stream.once('error', reject);
    });
    const activeController = new AbortController();
    const activeRequest = requestJson(
      { request: sinon.stub().returns(fakeRequest(pending, stream)) },
      getSelectedOperation('workspace.list'),
      {},
      { signal: activeController.signal },
    );
    activeController.abort();
    try {
      await activeRequest;
      expect.fail('expected active request cancellation to fail');
    } catch (error) {
      expect(error).to.be.instanceOf(CmsRequestError);
      expect((error as Error).message).to.equal('CMS request cancelled');
    }
  });

  it('rejects invalid timeout values before making a request', async () => {
    const request = sinon.stub();
    try {
      await requestJson({ request }, getSelectedOperation('workspace.list'), {}, { timeoutMs: 0 });
      expect.fail('expected invalid timeout to fail');
    } catch (error) {
      expect(error).to.be.instanceOf(CmsRequestError);
      expect((error as Error).message).to.equal('Request timeout must be a positive number');
    }
    expect(request.called).to.equal(false);
  });
});
