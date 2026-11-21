import type { Connection } from '@salesforce/core';
import type { Transport } from '@jsforce/jsforce-node/lib/transport.js';
import { StreamPromise } from '@jsforce/jsforce-node/lib/util/promise.js';
import type { Duplex } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { SELECTED_OPERATIONS, type SelectedOperation } from '../generated/operations.js';
import { redactSecrets } from './redact-secrets.js';
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

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Connect REST HTML-encodes `<`, `>`, `&`, `"` and `'` in every string of a response unless this
 * header turns it off; with it, bodies such as `rawHtml` come back exactly as stored.
 */
export const RAW_TEXT_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'X-Chatter-Entity-Encoding': 'false',
});

/** What Salesforce answered for a failed request, plus whether the request left the plugin. */
export type ErrorDetails = {
  errorCode?: string;
  requestId?: string;
  requestSent?: boolean;
  responseMessage?: string;
  statusObserved?: boolean;
};

/**
 * One failed CMS request. `requestSent: false` means nothing reached Salesforce; a sent
 * request without an observed status has an unknown outcome.
 */
export class CmsRequestError extends Error {
  public readonly errorCode?: string;
  public readonly operationKey: string;
  public readonly requestId?: string;
  public readonly requestSent: boolean;
  public readonly responseMessage?: string;
  public readonly status?: number;
  public readonly statusObserved: boolean;

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
    this.status = status;
    this.statusObserved = details.statusObserved ?? status !== undefined;
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
  const entries = Array.isArray(data) ? data : [data];
  const entry = entries.length === 1 && isRecord(entries[0]) ? entries[0] : undefined;
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
  };
}

/**
 * Wrap a rejection of a request that was sent.
 * @param {string} operationKey - Operation that failed.
 * @param {unknown} error - Rejection.
 * @param {boolean} cancelled - Whether the caller aborted.
 * @param {number} [observedStatus] - Status seen on the wire, when known.
 * @returns {CmsRequestError} Wrapped error.
 */
export function sentRequestError(
  operationKey: string,
  error: unknown,
  cancelled: boolean,
  observedStatus?: number,
): CmsRequestError {
  if (error instanceof CmsRequestError) return error;
  const message = cancelled
    ? 'CMS request cancelled'
    : redactSecrets(
        (error instanceof Error ? error.message : String(error)) || 'CMS request failed',
      );
  return new CmsRequestError(operationKey, message, observedStatus ?? errorStatus(error), {
    ...responseErrorDetails(error),
    requestSent: true,
    statusObserved: observedStatus !== undefined || hasNumericStatus(error),
  });
}

/**
 * Reject a bad timeout or an already-aborted signal before anything is sent.
 * @param {string} operationKey - Operation to name in the error.
 * @param {JsonRequestOptions} options - Caller options.
 * @returns {number} Effective timeout in ms.
 */
export function checkRequestOptions(operationKey: string, options: JsonRequestOptions): number {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
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
} {
  let observed: number | undefined;
  const transport = (connection as RequestConnection & { _transport?: Transport })._transport;
  if (!transport || typeof transport.httpRequest !== 'function')
    return { options: {}, status: () => observed };
  return {
    options: {
      transport: {
        httpRequest(request, transportOptions) {
          // A refresh can issue another attempt: an earlier 401 is not the final answer.
          observed = undefined;
          const pending = transport.httpRequest(request, transportOptions);
          return StreamPromise.create(() => ({
            stream: pending.stream(),
            promise: pending.then((response) => {
              observed = Number.isInteger(response.statusCode) ? response.statusCode : undefined;
              return response;
            }),
          }));
        },
      },
    },
    status: () => observed,
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
    logApiEvent('response', event, data);
    return { data, operationKey: operation.localKey, status: successStatus(operation) };
  } catch (error) {
    logApiEvent('error', event, error);
    throw sentRequestError(
      operation.localKey,
      error,
      options.signal?.aborted === true,
      recorder.status(),
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
