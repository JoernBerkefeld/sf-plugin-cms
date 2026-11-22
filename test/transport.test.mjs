import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { Connection as JsforceConnection } from '@jsforce/jsforce-node';
import {
  CmsRequestError,
  getSelectedOperation,
  requestJson,
} from '../lib/transport/json-request.js';
import { requestEmptyMutation, requestJsonMutation } from '../lib/transport/json-mutation.js';
import { runWithInvocationLogging } from '../lib/logging.js';
import { toDiagnostic } from '../lib/errors/registry.js';
import { fakeConnection } from './support/fake-connection.mjs';

const fakeRequest = (promise, stream = new PassThrough()) =>
  Object.assign(promise, { stream: () => stream });

/**
 * Run a function and return its rejection.
 * @param {() => Promise<unknown>} run Function expected to reject.
 * @returns {Promise<any>} The rejection.
 */
async function rejection(run) {
  try {
    await run();
  } catch (error) {
    return error;
  }
  assert.fail('expected a rejection');
}

test('GET reports the HTTP status seen on the wire and Salesforce error code', async () => {
  const connection = new JsforceConnection({
    instanceUrl: 'https://example.salesforce.com',
    accessToken: 'test-token',
    version: '68.0',
  });
  const urls = [];
  Object.assign(connection, {
    _transport: {
      httpRequest(request) {
        urls.push(request.url);
        return fakeRequest(
          Promise.resolve({
            statusCode: 404,
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify([{ errorCode: 'NOT_FOUND', message: 'Absent' }]),
          }),
        );
      },
    },
  });
  const error = await rejection(() =>
    requestJson(connection, getSelectedOperation('variant.get'), { path: { variantId: 'v1' } }),
  );
  assert.ok(error instanceof CmsRequestError);
  assert.equal(error.status, 404);
  assert.equal(error.statusObserved, true);
  assert.equal(error.requestSent, true);
  assert.equal(error.errorCode, 'NOT_FOUND');
  assert.equal(error.responseMessage, 'Absent');
  assert.deepEqual(urls, [
    'https://example.salesforce.com/services/data/v68.0/connect/cms/contents/variants/v1',
  ]);
});

test('a NOT_FOUND code without a status reads as 404, not observed', async () => {
  const error = await rejection(() =>
    requestJson(
      {
        request: () =>
          fakeRequest(
            Promise.reject(
              Object.assign(new Error('Managed content not found.'), {
                errorCode: 'NOT_FOUND',
                data: { errorCode: 'NOT_FOUND', message: 'Managed content not found.' },
              }),
            ),
          ),
      },
      getSelectedOperation('content.get'),
      { path: { contentKeyOrId: 'missing' } },
    ),
  );
  assert.equal(error.status, 404);
  assert.equal(error.statusObserved, false);
  assert.equal(error.message, 'Managed content not found.');
});

test('errors are redacted and keep the status', async () => {
  const error = await rejection(() =>
    requestJson(
      {
        request: () =>
          fakeRequest(
            Promise.reject(
              Object.assign(
                new Error('Authorization: Bearer secret.token failed at ?access_token=another'),
                { statusCode: 503 },
              ),
            ),
          ),
      },
      getSelectedOperation('workspace.list'),
    ),
  );
  assert.equal(error.status, 503);
  assert.equal(error.message, 'Authorization: [REDACTED] failed at ?access_token=[REDACTED]');
});

test('rejects bad parameters, bad timeouts and aborted signals before sending', async () => {
  const connection = fakeConnection(() => ({}));
  const controller = new AbortController();
  controller.abort();
  for (const [values, options, message] of [
    [{ path: {} }, {}, 'Missing required path parameter: variantId'],
    [{ path: { variantId: 'v' }, query: { nope: 1 } }, {}, 'Unknown query parameter: nope'],
    [{ path: { variantId: 'v' } }, { timeoutMs: 0 }, 'Request timeout must be a positive number'],
    [{ path: { variantId: 'v' } }, { signal: controller.signal }, 'CMS request cancelled'],
  ]) {
    const error = await rejection(() =>
      requestJson(connection, getSelectedOperation('variant.get'), values, options),
    );
    assert.equal(error.message, message);
    assert.equal(error.requestSent, false);
  }
  assert.equal(connection.calls.length, 0);
});

test('cancelling an in-flight request destroys its stream', async () => {
  const stream = new PassThrough();
  const pending = new Promise((_resolve, reject) => stream.once('error', reject));
  const controller = new AbortController();
  const result = requestJson(
    { request: () => fakeRequest(pending, stream) },
    getSelectedOperation('workspace.list'),
    {},
    { signal: controller.signal },
  );
  controller.abort();
  const error = await rejection(() => result);
  assert.equal(error.message, 'CMS request cancelled');
  assert.equal(stream.destroyed, true);
});

test('logs request and response with one ID, bodies only with --api log, never secrets', async () => {
  for (const apiEnabled of [false, true]) {
    const entries = [];
    const logger = {
      filePath: 'unused',
      log: (...arguments_) => entries.push(arguments_),
      close: async () => {},
    };
    await runWithInvocationLogging(
      logger,
      () =>
        requestJson(
          fakeConnection(() => ({ spaces: [], accessToken: 'SECRET' })),
          getSelectedOperation('workspace.list'),
        ),
      apiEnabled,
    );
    assert.equal(entries.length, 2);
    assert.equal(entries[0][2].requestId, entries[1][2].requestId);
    assert.equal('parsedResponse' in entries[1][2], apiEnabled);
    assert.doesNotMatch(JSON.stringify(entries), /SECRET/u);
  }
});

test('a JSON write is sent once as given, with retries off', async () => {
  const connection = fakeConnection(() => ({ managedContentId: '20Y1' }));
  const body = { title: 'T', contentBody: { a: 1 } };
  const result = await requestJsonMutation(
    connection,
    getSelectedOperation('content.create'),
    body,
    {},
    { allowCallerConnection: true, timeoutMs: 1234 },
  );
  assert.deepEqual(result, { data: { managedContentId: '20Y1' }, operationKey: 'content.create' });
  assert.equal(connection.calls.length, 1);
  const [{ input, options }] = connection.calls;
  assert.equal(input.method, 'POST');
  assert.equal(input.url, '/connect/cms/contents');
  assert.equal(input.body, JSON.stringify(body));
  assert.deepEqual(options, { retry: { maxRetries: 0 }, timeout: 1234 });
  await requestEmptyMutation(
    connection,
    getSelectedOperation('variant.delete'),
    { path: { variantId: 'v 1' } },
    { allowCallerConnection: true },
  );
  assert.equal(connection.calls[1].input.url, '/connect/cms/contents/variants/v%201');
});

test('a write without a token is refused unless the caller allows its own connection', async () => {
  const connection = fakeConnection(() => ({}));
  const error = await rejection(() =>
    requestJsonMutation(connection, getSelectedOperation('content.create'), {}),
  );
  assert.equal(error.requestSent, false);
  assert.equal(connection.calls.length, 0);
});

test('a write uses a token-only connection: a 401 is not refreshed or replayed', async () => {
  let hits = 0;
  const server = createServer((_request, response) => {
    hits += 1;
    response.writeHead(401, { 'content-type': 'application/json' });
    response.end(JSON.stringify([{ errorCode: 'INVALID_SESSION_ID', message: 'Session expired' }]));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address();
    const refresh = { called: false };
    const connection = {
      accessToken: 'token',
      instanceUrl: `http://127.0.0.1:${port}`,
      version: '68.0',
      request() {
        refresh.called = true;
        throw new Error('the org connection must not be used for writes');
      },
    };
    const error = await rejection(() =>
      requestJsonMutation(connection, getSelectedOperation('content.create'), { title: 'T' }),
    );
    assert.ok(error instanceof CmsRequestError);
    assert.equal(error.status, 401);
    assert.equal(error.requestSent, true);
    assert.equal(error.errorCode, 'INVALID_SESSION_ID');
    assert.equal(hits, 1);
    assert.equal(refresh.called, false);
  } finally {
    server.close();
  }
});

/**
 * Run a local HTTP server for one test and give the write connection that points at it.
 * @param {import('node:http').RequestListener} handler Request handler.
 * @param {(connection: object) => Promise<void>} body Test body.
 * @returns {Promise<void>} Done.
 */
async function withServer(handler, body) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address();
    await body({ accessToken: 'token', instanceUrl: `http://127.0.0.1:${port}`, version: '68.0' });
  } finally {
    server.closeAllConnections();
    server.close();
  }
}

test('reads wait 30 s and writes 120 s unless the caller sets a timeout', async () => {
  const connection = fakeConnection(() => ({}));
  await requestJson(connection, getSelectedOperation('workspace.list'));
  await requestJsonMutation(
    connection,
    getSelectedOperation('variant.update'),
    { contentBody: {} },
    { path: { variantId: 'v' } },
    { allowCallerConnection: true },
  );
  assert.deepEqual(
    connection.calls.map((call) => call.options.timeout),
    [30_000, 120_000],
  );
});

test('a write without an answer in time is a client timeout, not "10 minutes"', async () => {
  await withServer(
    () => {
      // Never answers.
    },
    async (connection) => {
      const error = await rejection(() =>
        requestJsonMutation(
          connection,
          getSelectedOperation('variant.update'),
          { contentBody: {} },
          { path: { variantId: 'v1' } },
          { timeoutMs: 200 },
        ),
      );
      assert.ok(error instanceof CmsRequestError);
      assert.equal(
        error.message,
        'no answer from Salesforce within 0.2 s (client timeout); the change may still be applied',
      );
      assert.equal(error.requestSent, true);
      assert.equal(error.statusObserved, false);
      assert.equal(error.timeoutMs, 200);
      assert.ok(error.elapsedMs >= 150);
      assert.deepEqual(error.transportError, { name: 'AbortError' });
      const diagnostic = toDiagnostic(error);
      assert.equal(
        diagnostic.message,
        'variant.update: no answer from Salesforce within 0.2 s (client timeout); the change may still be applied',
      );
      assert.equal(diagnostic.timeoutMs, 200);
      assert.deepEqual(diagnostic.transportError, { name: 'AbortError' });
    },
  );
});

test('a dropped connection keeps its error name and code', async () => {
  await withServer(
    (request) => request.socket.destroy(),
    async (connection) => {
      const error = await rejection(() =>
        requestJsonMutation(connection, getSelectedOperation('content.create'), { title: 'T' }),
      );
      assert.equal(error.statusObserved, false);
      assert.equal(error.transportError.name, 'FetchError');
      assert.equal(error.transportError.code, 'ECONNRESET');
      assert.equal(error.timeoutMs, 120_000);
      assert.doesNotMatch(error.message, /client timeout/u);
    },
  );
});

test('every error entry Salesforce answers is kept; the message leads with the first', async () => {
  const entries = [
    {
      errorCode: 'INVALID_API_INPUT',
      message: 'AMPscript syntax error at line 3',
      fields: ['contentBody.rawHtml'],
      detail: { line: 3 },
    },
    { errorCode: 'FIELD_INTEGRITY_EXCEPTION', message: 'Subject is required', fields: ['subject'] },
  ];
  await withServer(
    (_request, response) => {
      response.writeHead(400, { 'content-type': 'application/json', 'sforce-request-id': 'R1' });
      response.end(JSON.stringify(entries));
    },
    async (connection) => {
      const logged = [];
      const logger = { filePath: 'unused', log: (...a) => logged.push(a), close: async () => {} };
      const error = await rejection(() =>
        runWithInvocationLogging(logger, () =>
          requestJsonMutation(
            connection,
            getSelectedOperation('variant.update'),
            { contentBody: {} },
            { path: { variantId: 'v1' } },
          ),
        ),
      );
      assert.equal(error.status, 400);
      assert.equal(error.statusObserved, true);
      assert.equal(error.errorCode, 'INVALID_API_INPUT');
      assert.equal(error.transportError, undefined);
      assert.equal(error.timeoutMs, undefined);
      assert.deepEqual(error.salesforceErrors, entries);
      assert.deepEqual(
        { ...toDiagnostic(error), hint: undefined },
        {
          code: 'REQUEST_FAILED',
          message:
            'variant.update: HTTP 400: INVALID_API_INPUT: AMPscript syntax error at line 3 (and 1 more error, see salesforceErrors)',
          status: 400,
          salesforceErrorCode: 'INVALID_API_INPUT',
          requestId: 'R1',
          salesforceErrors: entries,
          hint: undefined,
        },
      );
      // The invocation log has the status and headers seen on the wire; the body only with --api log.
      const failure = logged.find(([level]) => level === 'error')[2];
      assert.equal(failure.status, 400);
      assert.equal(failure.responseHeaders['sforce-request-id'], 'R1');
      assert.equal(failure.rawBody, 'omitted: pass --api log to include bodies');
    },
  );
});

test('with --api log the raw answer body is logged', async () => {
  await withServer(
    (_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"managedContentVariantId":"9Ps1"}');
    },
    async (connection) => {
      const logged = [];
      const logger = { filePath: 'unused', log: (...a) => logged.push(a), close: async () => {} };
      await runWithInvocationLogging(
        logger,
        () =>
          requestJsonMutation(
            connection,
            getSelectedOperation('variant.update'),
            { contentBody: {} },
            { path: { variantId: 'v1' } },
          ),
        true,
      );
      const answer = logged.at(-1)[2];
      assert.equal(answer.status, 200);
      assert.equal(answer.rawBody, '{"managedContentVariantId":"9Ps1"}');
    },
  );
});
