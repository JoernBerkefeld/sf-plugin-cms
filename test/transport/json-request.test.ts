import { PassThrough } from 'node:stream';
import { Connection as JsforceConnection } from '@jsforce/jsforce-node';
import type { Transport } from '@jsforce/jsforce-node/lib/transport.js';
import { expect } from 'chai';
import sinon from 'sinon';
import {
  buildOperationUrl,
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

  it('passes through the original transport stream without consuming it', async () => {
    const connection = new JsforceConnection({
      instanceUrl: 'https://example.salesforce.com',
      accessToken: 'token',
    });
    const stream = new PassThrough();
    Object.assign(connection, {
      _transport: {
        httpRequest: () =>
          fakeRequest(
            Promise.resolve({
              statusCode: 200,
              headers: { 'content-type': 'application/json' },
              body: '{"ok":true}',
            }),
            stream,
          ),
      },
    });
    const result = await requestJson(connection, getSelectedOperation('variant.get'), {
      path: { variantId: 'variant' },
    });
    expect(result.data).to.deep.equal({ ok: true });
    expect(stream.destroyed).to.equal(false);
    expect(stream.readableLength).to.equal(0);
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

  it('preserves success and synchronous rejection when the diagnostic sink throws', async () => {
    const logger: InvocationLogger = {
      filePath: 'unused',
      log: () => {
        throw new Error('disk');
      },
      close: async () => {},
    };
    const request = sinon.stub().returns(fakeRequest(Promise.resolve('success')));
    const success = await runWithInvocationLogging(
      logger,
      () => requestJson({ request }, getSelectedOperation('workspace.list')),
      true,
    );
    expect(success.data).to.equal('success');
    const error = new Error('synchronous SDK failure');
    request.resetBehavior();
    request.throws(error);
    try {
      await runWithInvocationLogging(
        logger,
        () => requestJson({ request }, getSelectedOperation('workspace.list')),
        true,
      );
      expect.fail('expected rejection');
    } catch (error_) {
      expect(error_).to.equal(error);
    }
    expect(request.callCount).to.equal(2);
  });
  it('constructs encoded paths and deterministic query strings', () => {
    expect(
      buildOperationUrl(getSelectedOperation('content.get'), {
        path: { contentKeyOrId: 'folder/item + one' },
        query: { version: 'draft & ready', contentVersion: '3' },
      }),
    ).to.equal(
      '/connect/cms/contents/folder%2Fitem%20%2B%20one?contentVersion=3&version=draft+%26+ready',
    );
    expect(
      buildOperationUrl(getSelectedOperation('workspace.channel.list'), {
        path: { contentSpaceId: '0Z9/a' },
        query: { pageSize: 50, page: 2 },
      }),
    ).to.equal('/connect/cms/spaces/0Z9%2Fa/channels?page=2&pageSize=50');
    expect(
      buildOperationUrl(getSelectedOperation('workspace.variant.search'), {
        query: {
          queryTerm: '*',
          languages: ['en_US', 'de DE'],
          contentSpaceOrFolderIds: ['0Zu/b', '9Pu+c'],
        },
      }),
    ).to.equal(
      '/connect/cms/items/search?contentSpaceOrFolderIds=0Zu%2Fb&contentSpaceOrFolderIds=9Pu%2Bc&languages=en_US&languages=de+DE&queryTerm=*',
    );
  });

  it('validates required, unknown, and typed parameters', () => {
    const operation = getSelectedOperation('workspace.channel.list');
    expect(() => buildOperationUrl(operation)).to.throw(
      CmsRequestError,
      'Missing required path parameter: contentSpaceId',
    );
    expect(() =>
      buildOperationUrl(operation, { path: { contentSpaceId: 'space', extra: 'no' } }),
    ).to.throw(CmsRequestError, 'Unknown path parameter: extra');
    expect(() =>
      buildOperationUrl(operation, { path: { contentSpaceId: 'space' }, query: { other: 1 } }),
    ).to.throw(CmsRequestError, 'Unknown query parameter: other');
    expect(() =>
      buildOperationUrl(operation, {
        path: { contentSpaceId: 'space' },
        query: { page: 1.5 },
      }),
    ).to.throw(CmsRequestError, 'Invalid integer parameter: page');

    const search = getSelectedOperation('workspace.variant.search');
    expect(() =>
      buildOperationUrl(search, {
        query: { contentSpaceOrFolderIds: ['space'], queryTerm: '*', unknown: 'no' },
      }),
    ).to.throw(CmsRequestError, 'Unknown query parameter: unknown');
    expect(() =>
      buildOperationUrl(search, {
        query: { contentSpaceOrFolderIds: 'space', queryTerm: '*' },
      }),
    ).to.throw(CmsRequestError, 'Invalid string-array parameter: contentSpaceOrFolderIds');
    expect(() =>
      buildOperationUrl(search, {
        query: { contentSpaceOrFolderIds: [], queryTerm: '*' },
      }),
    ).to.throw(CmsRequestError, 'Invalid string-array parameter: contentSpaceOrFolderIds');
    expect(() =>
      buildOperationUrl(search, {
        query: { contentSpaceOrFolderIds: ['space', 1] as unknown as string[], queryTerm: '*' },
      }),
    ).to.throw(CmsRequestError, 'Invalid string-array parameter: contentSpaceOrFolderIds');
  });

  it('returns typed JSON success metadata and passes the timeout', async () => {
    const request = sinon.stub().returns(fakeRequest(Promise.resolve({ id: 'space' })));
    const result = await requestJson<{ id: string }>(
      { request },
      getSelectedOperation('workspace.get'),
      { path: { contentSpaceId: 'space' } },
      { timeoutMs: 4321 },
    );

    expect(result).to.deep.equal({
      data: { id: 'space' },
      operationKey: 'workspace.get',
      status: 200,
    });
    expect(
      request.calledOnceWithExactly(
        { method: 'GET', url: '/connect/cms/spaces/space' },
        { timeout: 4321 },
      ),
    ).to.equal(true);
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

  it('preserves existing request errors without relabeling their operation', async () => {
    const original = new CmsRequestError('workspace.get', 'Request failed', 400, {
      errorCode: 'INVALID_ID_FIELD',
      errorEntryCount: 1,
      responseMessage: 'Provide a valid content key, ID, or FQN.',
    });
    const request = sinon.stub().returns(fakeRequest(Promise.reject(original)));

    try {
      await requestJson({ request }, getSelectedOperation('content.get'), {
        path: { contentKeyOrId: 'missing-key' },
      });
      expect.fail('expected request to fail');
    } catch (error) {
      expect(error).to.equal(original);
      expect(error).to.include({ operationKey: 'workspace.get' });
    }
  });

  it('normalizes request timeouts', async () => {
    const request = sinon
      .stub()
      .returns(
        fakeRequest(
          Promise.reject(Object.assign(new Error('Request timed out'), { code: 'ETIMEDOUT' })),
        ),
      );

    try {
      await requestJson({ request }, getSelectedOperation('workspace.list'), {}, { timeoutMs: 25 });
      expect.fail('expected timed out request to fail');
    } catch (error) {
      expect(error).to.be.instanceOf(CmsRequestError);
      expect(error).to.include({ operationKey: 'workspace.list' });
      expect((error as Error).message).to.equal('Request timed out');
    }
    expect(
      request.calledOnceWithExactly({ method: 'GET', url: '/connect/cms/spaces' }, { timeout: 25 }),
    ).to.equal(true);
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
