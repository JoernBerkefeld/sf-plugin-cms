import type { Connection } from '@salesforce/core';
import type { Transport } from '@jsforce/jsforce-node/lib/transport.js';
import { StreamPromise } from '@jsforce/jsforce-node/lib/util/promise.js';
import type { Duplex } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { SELECTED_OPERATIONS, type SelectedOperation } from '../generated/operations.js';
import { redactLogValue, redactSecrets } from './redact-secrets.js';
import { logApiEvent } from '../logging.js';

export type OperationKey = SelectedOperation['localKey'];

export type OperationParameterValues = Readonly<
  Record<string, boolean | number | readonly string[] | string | undefined>
>;

export type JsonRequestValues = {
  path?: OperationParameterValues;
  query?: OperationParameterValues;
};

export type JsonRequestOptions = {
  signal?: AbortSignal;
  timeoutMs?: number;
};

export type JsonSuccess<T> = {
  data: T;
  operationKey: OperationKey;
  status: number;
};

type RequestStream<T> = Promise<T> & {
  stream(): Duplex;
};

export type RequestConnection = Pick<Connection, 'request'>;

type RuntimeParameter = {
  location: 'path' | 'query';
  name: string;
  required: boolean;
  type: 'boolean' | 'integer' | 'string' | 'string-array';
};

/** Default wait for the answer to a read. */
export const DEFAULT_READ_TIMEOUT_MS = 30_000;

/** Default wait for the answer to a write; Salesforce has needed 41-65 s for an email update. */
export const DEFAULT_WRITE_TIMEOUT_MS = 120_000;

/**
 * Connect REST HTML-encodes `<`, `>`, `&`, `"` and `'` in every string of a response unless this
 * header turns it off; with it, bodies such as `rawHtml` come back exactly as stored.
 */
export const RAW_TEXT_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'X-Chatter-Entity-Encoding': 'false',
});

/** One error entry of a Salesforce error answer, with every field it holds (redacted). */
export type SalesforceErrorEntry = Record<string, unknown>;

/** What failed below HTTP when no answer came: the error's name and, if any, its code. */
export type TransportFailure = { name: string; code?: string };

/** What Salesforce answered for a failed request, plus whether the request left the plugin. */
export type ErrorDetails = {
  elapsedMs?: number;
  errorCode?: string;
  requestId?: string;
  requestSent?: boolean;
  responseMessage?: string;
  salesforceErrors?: SalesforceErrorEntry[];
  statusObserved?: boolean;
  timeoutMs?: number;
  transportError?: TransportFailure;
};

/**
 * The attempt a failure belongs to: its timeout, start time, whether it was a write and the
 * response headers seen on the wire (jsforce drops them from its errors).
 */
export type RequestAttempt = {
  timeoutMs: number;
  startedAt: number;
  write: boolean;
  responseHeaders?: Record<string, unknown>;
};

/**
 * One failed CMS request. `requestSent: false` means nothing reached Salesforce; a sent
 * request without an observed status has an unknown outcome.
 */
export class CmsRequestError extends Error {
  public readonly elapsedMs?: number;
  public readonly errorCode?: string;
  public readonly operationKey: string;
  public readonly requestId?: string;
  public readonly requestSent: boolean;
  public readonly responseMessage?: string;
  public readonly salesforceErrors?: SalesforceErrorEntry[];
  public readonly status?: number;
  public readonly statusObserved: boolean;
  public readonly timeoutMs?: number;
  public readonly transportError?: TransportFailure;

  public constructor(
    operationKey: string,
    message: string,
    status?: number,
    details: ErrorDetails = {},
  ) {
    super(redactSecrets(message));
    this.name = 'CmsRequestError';
    this.errorCode = details.errorCode;
    this.operationKey = operationKey;
    this.requestId = details.requestId;
    this.requestSent = details.requestSent ?? false;
    this.responseMessage =
      details.responseMessage === undefined ? undefined : redactSecrets(details.responseMessage);
    this.salesforceErrors = details.salesforceErrors;
    this.status = status;
    this.statusObserved = details.statusObserved ?? status !== undefined;
    this.timeoutMs = details.timeoutMs;
    this.elapsedMs = details.elapsedMs;
    this.transportError = details.transportError;
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The HTTP status a jsforce error exposes; a NOT_FOUND code without a status reads as 404.
 * @param {unknown} error - Rejection from jsforce.
 * @returns {number | undefined} Status.
 */
export function errorStatus(error: unknown): number | undefined {
  if (!isRecord(error)) return undefined;
  for (const key of ['statusCode', 'status']) {
    const value = error[key];
    if (typeof value === 'number' && Number.isInteger(value)) return value;
  }
  if (isRecord(error.response)) {
    for (const key of ['statusCode', 'status']) {
      const value = error.response[key];
      if (typeof value === 'number' && Number.isInteger(value)) return value;
    }
  }
  if (error.errorCode === 'NOT_FOUND' || error.name === 'NOT_FOUND') return 404;
  if (isRecord(error.data) && error.data.errorCode === 'NOT_FOUND') return 404;
  return undefined;
}

function hasNumericStatus(error: unknown): boolean {
  return (
    isRecord(error) &&
    (typeof error.statusCode === 'number' ||
      typeof error.status === 'number' ||
      (isRecord(error.response) &&
        (typeof error.response.statusCode === 'number' ||
          typeof error.response.status === 'number')))
  );
}

/**
 * Salesforce's error code, message and request ID from a jsforce rejection.
 * @param {unknown} error - Rejection from jsforce.
 * @returns {ErrorDetails} Redacted details.
 */
export function responseErrorDetails(error: unknown): ErrorDetails {
  if (!isRecord(error)) return {};
  const data =
    error.data ??
    (isRecord(error.response) && 'data' in error.response ? error.response.data : undefined);
  const records = (Array.isArray(data) ? data : [data]).filter(isRecord);
  const entry = records.at(0);
  let headers: Record<string, unknown> | undefined;
  if (isRecord(error.response) && isRecord(error.response.headers)) {
    headers = error.response.headers;
  } else if (isRecord(error.headers)) {
    headers = error.headers;
  }
  const requestId = [
    error.requestId,
    entry?.requestId,
    headers?.['sforce-request-id'],
    headers?.['x-request-id'],
  ].find((value): value is string => typeof value === 'string' && value.length > 0);
  return {
    ...(typeof entry?.errorCode === 'string' ? { errorCode: entry.errorCode } : {}),
    ...(requestId === undefined ? {} : { requestId: redactSecrets(requestId) }),
    ...(typeof entry?.message === 'string'
      ? { responseMessage: redactSecrets(entry.message) }
      : {}),
    ...(records.length === 0
      ? {}
      : {
          salesforceErrors: records.map(
            (record) => structuredClone(redactLogValue(record)) as SalesforceErrorEntry,
          ),
        }),
  };
}

function transportFailure(error: unknown): TransportFailure | undefined {
  if (!isRecord(error) || typeof error.name !== 'string') return undefined;
  return {
    name: error.name,
    ...(typeof error.code === 'string' && error.code.length > 0 ? { code: error.code } : {}),
  };
}

const seconds = (ms: number): string => `${ms / 1000} s`;

/**
 * Wrap a rejection of a request that was sent. Without an HTTP answer the error keeps what
 * failed below HTTP, the timeout and the elapsed time. The client's own timeout (jsforce aborts
 * the fetch, and its text claims "10 minutes" whatever the timeout was) is said as such.
 * @param {string} operationKey - Operation that failed.
 * @param {unknown} error - Rejection.
 * @param {boolean} cancelled - Whether the caller aborted.
 * @param {number} [observedStatus] - Status seen on the wire, when known.
 * @param {RequestAttempt} [attempt] - Timeout, start time and write flag of the request.
 * @returns {CmsRequestError} Wrapped error.
 */
export function sentRequestError(
  operationKey: string,
  error: unknown,
  cancelled: boolean,
  observedStatus?: number,
  attempt?: RequestAttempt,
): CmsRequestError {
  if (error instanceof CmsRequestError) return error;
  const statusObserved = observedStatus !== undefined || hasNumericStatus(error);
  const timedOut = !cancelled && !statusObserved && isRecord(error) && error.name === 'AbortError';
  let message: string;
  if (cancelled) message = 'CMS request cancelled';
  else if (timedOut && attempt)
    message = `no answer from Salesforce within ${seconds(attempt.timeoutMs)} (client timeout)${
      attempt.write ? '; the change may still be applied' : ''
    }`;
  else
    message = redactSecrets(
      (error instanceof Error ? error.message : String(error)) || 'CMS request failed',
    );
  const transportError = statusObserved ? undefined : transportFailure(error);
  const details = responseErrorDetails(error);
  const wireRequestId = attempt?.responseHeaders?.['sforce-request-id'];
  if (details.requestId === undefined && typeof wireRequestId === 'string' && wireRequestId)
    details.requestId = redactSecrets(wireRequestId);
  return new CmsRequestError(operationKey, message, observedStatus ?? errorStatus(error), {
    ...details,
    requestSent: true,
    statusObserved,
    ...(statusObserved || !attempt
      ? {}
      : { timeoutMs: attempt.timeoutMs, elapsedMs: Date.now() - attempt.startedAt }),
    ...(transportError ? { transportError } : {}),
  });
}

/**
 * Reject a bad timeout or an already-aborted signal before anything is sent.
 * @param {string} operationKey - Operation to name in the error.
 * @param {JsonRequestOptions} options - Caller options.
 * @param {number} defaultTimeoutMs - Timeout when the caller sets none.
 * @returns {number} Effective timeout in ms.
 */
export function checkRequestOptions(
  operationKey: string,
  options: JsonRequestOptions,
  defaultTimeoutMs = DEFAULT_READ_TIMEOUT_MS,
): number {
  const timeoutMs = options.timeoutMs ?? defaultTimeoutMs;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new CmsRequestError(operationKey, 'Request timeout must be a positive number');
  }
  if (options.signal?.aborted) {
    throw new CmsRequestError(operationKey, 'CMS request cancelled');
  }
  return timeoutMs;
}

function assertValueType(
  operation: SelectedOperation,
  name: string,
  type: 'boolean' | 'integer' | 'string' | 'string-array',
  value: unknown,
): asserts value is boolean | number | readonly string[] | string {
  const valid =
    (type === 'string' && typeof value === 'string') ||
    (type === 'boolean' && typeof value === 'boolean') ||
    (type === 'integer' && typeof value === 'number' && Number.isInteger(value)) ||
    (type === 'string-array' &&
      Array.isArray(value) &&
      value.length > 0 &&
      value.every((item) => typeof item === 'string'));
  if (!valid) {
    throw new CmsRequestError(operation.localKey, `Invalid ${type} parameter: ${name}`);
  }
}

function validateKnownParameters(
  operation: SelectedOperation,
  location: 'path' | 'query',
  values: OperationParameterValues,
): void {
  const known = new Set<string>(
    operation.parameters
      .filter((parameter) => parameter.location === location)
      .map((parameter) => parameter.name),
  );
  for (const name of Object.keys(values)) {
    if (!known.has(name)) {
      throw new CmsRequestError(operation.localKey, `Unknown ${location} parameter: ${name}`);
    }
  }
}

/**
 * Build the relative request URL of an operation from its path and query values.
 * @param {SelectedOperation} operation - Generated operation descriptor.
 * @param {JsonRequestValues} values - Path and query values.
 * @returns {string} URL relative to /services/data/vXX.X.
 */
export function buildOperationUrl(
  operation: SelectedOperation,
  values: JsonRequestValues = {},
): string {
  const pathValues = values.path ?? {};
  const queryValues = values.query ?? {};
  validateKnownParameters(operation, 'path', pathValues);
  validateKnownParameters(operation, 'query', queryValues);

  const parameters = operation.parameters as readonly RuntimeParameter[];
  let requestPath: string = operation.path;
  for (const parameter of parameters.filter(({ location }) => location === 'path')) {
    const value = pathValues[parameter.name];
    if (value === undefined) {
      throw new CmsRequestError(
        operation.localKey,
        `Missing required path parameter: ${parameter.name}`,
      );
    }
    assertValueType(operation, parameter.name, parameter.type, value);
    if (typeof value === 'string' && value.length === 0) {
      throw new CmsRequestError(operation.localKey, `Empty path parameter: ${parameter.name}`);
    }
    requestPath = requestPath.replace(`{${parameter.name}}`, encodeURIComponent(String(value)));
  }

  const search = new URLSearchParams();
  const queryParameters = parameters
    .filter(({ location }) => location === 'query')
    .toSorted((left, right) => left.name.localeCompare(right.name));
  for (const parameter of queryParameters) {
    const value = queryValues[parameter.name];
    if (value === undefined) {
      if (parameter.required) {
        throw new CmsRequestError(
          operation.localKey,
          `Missing required query parameter: ${parameter.name}`,
        );
      }
      continue;
    }
    assertValueType(operation, parameter.name, parameter.type, value);
    if (parameter.type === 'string-array') {
      for (const item of value as readonly string[]) search.append(parameter.name, item);
    } else {
      search.set(parameter.name, String(value));
    }
  }

  const query = search.toString();
  return query.length > 0 ? `${requestPath}?${query}` : requestPath;
}

/** The final HTTP answer as it came over the wire (without cookies), for the invocation log. */
export type ObservedResponse = {
  status?: number;
  headers: Record<string, unknown>;
  body?: string;
};

/**
 * Request options that record the HTTP status of the final attempt, which jsforce's HttpApi
 * otherwise drops from its errors (a 404 tells "absent", a 401 "session"). HttpApi accepts a
 * per-request transport at runtime; URL normalization, headers and auth stay with the
 * connection. Connections without a jsforce transport (test doubles) get no extra option.
 * @param {RequestConnection} connection - Receiver of the request.
 * @returns {{ options: object; status: () => number | undefined }} Options and status reader.
 */
export function statusRecorder(connection: RequestConnection): {
  options: { transport?: Pick<Transport, 'httpRequest'> };
  status: () => number | undefined;
  response: () => ObservedResponse | undefined;
} {
  let observed: ObservedResponse | undefined;
  const status = (): number | undefined => observed?.status;
  const response = (): ObservedResponse | undefined => observed;
  const transport = (connection as RequestConnection & { _transport?: Transport })._transport;
  if (!transport || typeof transport.httpRequest !== 'function')
    return { options: {}, status, response };
  return {
    options: {
      transport: {
        httpRequest(request, transportOptions) {
          // A refresh can issue another attempt: an earlier 401 is not the final answer.
          observed = undefined;
          const pending = transport.httpRequest(request, transportOptions);
          return StreamPromise.create(() => ({
            stream: pending.stream(),
            promise: pending.then((answer) => {
              const headers: Record<string, unknown> = isRecord(answer.headers)
                ? { ...answer.headers }
                : {};
              delete headers['set-cookie'];
              observed = {
                ...(Number.isInteger(answer.statusCode) ? { status: answer.statusCode } : {}),
                headers,
                ...(typeof answer.body === 'string' ? { body: answer.body } : {}),
              };
              return answer;
            }),
          }));
        },
      },
    },
    status,
    response,
  };
}

function successStatus(operation: SelectedOperation): number {
  const status = operation.responses.find(({ status: value }) => /^2\d\d$/u.test(value))?.status;
  return status === undefined ? 200 : Number(status);
}

/**
 * Send one GET of a generated operation through the org connection (auth refresh allowed).
 * @template T
 * @param {RequestConnection} connection - Org connection.
 * @param {SelectedOperation} operation - Generated operation descriptor.
 * @param {JsonRequestValues} values - Path and query values.
 * @param {JsonRequestOptions} options - Timeout and cancellation.
 * @returns {Promise<JsonSuccess<T>>} Parsed response.
 */
export async function requestJson<T>(
  connection: RequestConnection,
  operation: SelectedOperation,
  values: JsonRequestValues = {},
  options: JsonRequestOptions = {},
): Promise<JsonSuccess<T>> {
  const timeoutMs = checkRequestOptions(operation.localKey, options);
  const url = buildOperationUrl(operation, values);
  const event = {
    requestId: randomUUID(),
    startedAt: Date.now(),
    method: operation.method,
    url,
    operationKey: operation.localKey,
  };
  logApiEvent('request', event);
  const recorder = statusRecorder(connection);
  let request: RequestStream<T>;
  try {
    request = connection.request<T>(
      { method: operation.method, url, headers: { ...RAW_TEXT_HEADERS } },
      {
        timeout: timeoutMs,
        ...recorder.options,
      } as unknown as Parameters<Connection['request']>[1],
    ) as RequestStream<T>;
  } catch (error) {
    logApiEvent('error', event, error);
    throw error;
  }
  const cancel = (): void => {
    request.stream().destroy(new Error('CMS request cancelled'));
  };
  options.signal?.addEventListener('abort', cancel, { once: true });

  try {
    const data = await request;
    logApiEvent('response', { ...event, response: recorder.response() }, data);
    return { data, operationKey: operation.localKey, status: successStatus(operation) };
  } catch (error) {
    logApiEvent('error', { ...event, response: recorder.response() }, error);
    throw sentRequestError(
      operation.localKey,
      error,
      options.signal?.aborted === true,
      recorder.status(),
      {
        timeoutMs,
        startedAt: event.startedAt,
        write: false,
        responseHeaders: recorder.response()?.headers,
      },
    );
  } finally {
    options.signal?.removeEventListener('abort', cancel);
  }
}

/**
 * Look up a generated operation by its local key.
 * @param {OperationKey} operationKey - Local key such as `workspace.list`.
 * @returns {SelectedOperation} Descriptor.
 */
export function getSelectedOperation(operationKey: OperationKey): SelectedOperation {
  const operation = SELECTED_OPERATIONS.find(({ localKey }) => localKey === operationKey);
  if (!operation) throw new CmsRequestError(operationKey, `Unknown operation: ${operationKey}`);
  return operation;
}
