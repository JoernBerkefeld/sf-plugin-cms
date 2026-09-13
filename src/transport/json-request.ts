import type { Connection } from '@salesforce/core';
import type { Duplex } from 'node:stream';
import { SELECTED_OPERATIONS, type SelectedOperation } from '../generated/operations.js';
import { redactSecrets } from './redact-secrets.js';

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
  operationKey: SelectedOperation['localKey'];
  status: number;
};

type RequestStream<T> = Promise<T> & {
  stream(): Duplex;
};

type RequestConnection = Pick<Connection, 'request'>;
type RuntimeParameter = {
  location: 'path' | 'query';
  name: string;
  required: boolean;
  type: 'boolean' | 'integer' | 'string' | 'string-array';
};

const DEFAULT_TIMEOUT_MS = 30_000;

export class CmsRequestError extends Error {
  public readonly operationKey: SelectedOperation['localKey'];
  public readonly status?: number;

  public constructor(
    operationKey: SelectedOperation['localKey'],
    message: string,
    status?: number,
  ) {
    super(message);
    this.name = 'CmsRequestError';
    this.operationKey = operationKey;
    this.status = status;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorStatus(error: unknown): number | undefined {
  if (!isRecord(error)) return undefined;
  for (const key of ['statusCode', 'status']) {
    const value = error[key];
    if (typeof value === 'number' && Number.isInteger(value)) return value;
  }
  if (error.errorCode === 'NOT_FOUND' || error.name === 'NOT_FOUND') return 404;
  if (isRecord(error.data) && error.data.errorCode === 'NOT_FOUND') return 404;
  return undefined;
}

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return redactSecrets(message || 'CMS request failed');
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

function successStatus(operation: SelectedOperation): number {
  const status = operation.responses.find(({ status: value }) => /^2\d\d$/u.test(value))?.status;
  return status === undefined ? 200 : Number(status);
}

export async function requestJson<T>(
  connection: RequestConnection,
  operation: SelectedOperation,
  values: JsonRequestValues = {},
  options: JsonRequestOptions = {},
): Promise<JsonSuccess<T>> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new CmsRequestError(operation.localKey, 'Request timeout must be a positive number');
  }
  if (options.signal?.aborted) {
    throw new CmsRequestError(operation.localKey, 'CMS request cancelled');
  }

  const url = buildOperationUrl(operation, values);
  const request = connection.request<T>(
    { method: operation.method, url },
    { timeout: timeoutMs },
  ) as RequestStream<T>;
  const cancel = (): void => {
    request.stream().destroy(new Error('CMS request cancelled'));
  };
  options.signal?.addEventListener('abort', cancel, { once: true });

  try {
    const data = await request;
    return { data, operationKey: operation.localKey, status: successStatus(operation) };
  } catch (error) {
    const message = options.signal?.aborted ? 'CMS request cancelled' : safeErrorMessage(error);
    throw new CmsRequestError(operation.localKey, message, errorStatus(error));
  } finally {
    options.signal?.removeEventListener('abort', cancel);
  }
}

export function getSelectedOperation(
  operationKey: SelectedOperation['localKey'],
): SelectedOperation {
  const operation = SELECTED_OPERATIONS.find(({ localKey }) => localKey === operationKey);
  if (!operation) throw new CmsRequestError(operationKey, `Unknown operation: ${operationKey}`);
  return operation;
}
