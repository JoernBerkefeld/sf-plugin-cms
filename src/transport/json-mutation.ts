import { Connection as JsforceConnection } from '@jsforce/jsforce-node';
import type { Connection } from '@salesforce/core';
import type { Duplex } from 'node:stream';
import type { SelectedOperation } from '../generated/operations.js';
import {
  buildOperationUrl,
  CmsRequestError,
  type JsonRequestOptions,
  type JsonRequestValues,
} from './json-request.js';
import { redactSecrets } from './redact-secrets.js';

export type JsonMutationBody = Readonly<Record<string, unknown>>;

export type JsonMutationSuccess<T> = {
  data: T;
  operationKey: SelectedOperation['localKey'];
};

export type EmptyMutationSuccess = {
  operationKey: SelectedOperation['localKey'];
};

export type JsonMutationOptions = JsonRequestOptions & {
  allowCallerConnection?: boolean;
};

type RequestStream<T> = Promise<T> & {
  stream(): Duplex;
};

type RequestConnection = Pick<Connection, 'request'> &
  Partial<Pick<Connection, 'accessToken' | 'instanceUrl' | 'version'>>;

const DEFAULT_TIMEOUT_MS = 30_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorStatus(error: unknown): number | undefined {
  if (!isRecord(error)) return undefined;
  for (const key of ['statusCode', 'status']) {
    const value = error[key];
    if (typeof value === 'number' && Number.isInteger(value)) return value;
  }
  return undefined;
}

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return redactSecrets(message || 'CMS request failed');
}

function withoutRefreshReplay(
  connection: RequestConnection,
  operation: SelectedOperation,
  allowCallerConnection: boolean,
): Pick<Connection, 'request'> {
  if (
    typeof connection.accessToken !== 'string' ||
    connection.accessToken.length === 0 ||
    typeof connection.instanceUrl !== 'string' ||
    connection.instanceUrl.length === 0
  ) {
    if (allowCallerConnection) return connection;
    throw new CmsRequestError(
      operation.localKey,
      'Mutation transport requires an access token and instance URL',
    );
  }
  return new JsforceConnection({
    accessToken: connection.accessToken,
    instanceUrl: connection.instanceUrl,
    version: connection.version,
  });
}

function validateMutationOperation(operation: SelectedOperation, hasBody: boolean): void {
  if (operation.method !== 'POST' && operation.method !== 'PUT' && operation.method !== 'DELETE') {
    throw new CmsRequestError(
      operation.localKey,
      `Unsupported mutation method: ${operation.method}`,
    );
  }
  const requestBodyMediaTypes = operation.requestBodyMediaTypes as readonly string[];
  const documentedJsonVariantUpdate =
    operation.localKey === 'variant.update' && operation.method === 'PUT';
  if (
    hasBody &&
    !requestBodyMediaTypes.includes('application/json') &&
    !documentedJsonVariantUpdate
  ) {
    throw new CmsRequestError(
      operation.localKey,
      'Mutation operation does not accept application/json',
    );
  }
  if (!hasBody && operation.requestBodyPresent) {
    throw new CmsRequestError(operation.localKey, 'Mutation operation requires a request body');
  }
}

async function sendMutation<T>(
  connection: RequestConnection,
  operation: SelectedOperation,
  values: JsonRequestValues,
  body: JsonMutationBody | undefined,
  options: JsonMutationOptions,
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new CmsRequestError(operation.localKey, 'Request timeout must be a positive number');
  }
  if (options.signal?.aborted) {
    throw new CmsRequestError(operation.localKey, 'CMS request cancelled');
  }

  validateMutationOperation(operation, body !== undefined);
  const request = withoutRefreshReplay(
    connection,
    operation,
    options.allowCallerConnection === true,
  ).request<T>(
    {
      method: operation.method,
      url: buildOperationUrl(operation, values),
      headers: { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    { retry: { maxRetries: 0 }, timeout: timeoutMs },
  ) as RequestStream<T>;
  const cancel = (): void => {
    request.stream().destroy(new Error('CMS request cancelled'));
  };
  options.signal?.addEventListener('abort', cancel, { once: true });

  try {
    return await request;
  } catch (error) {
    const message = options.signal?.aborted ? 'CMS request cancelled' : safeErrorMessage(error);
    throw new CmsRequestError(operation.localKey, message, errorStatus(error));
  } finally {
    options.signal?.removeEventListener('abort', cancel);
  }
}

export async function requestJsonMutation<T>(
  connection: RequestConnection,
  operation: SelectedOperation,
  body: JsonMutationBody,
  values: JsonRequestValues = {},
  options: JsonMutationOptions = {},
): Promise<JsonMutationSuccess<T>> {
  const data = await sendMutation<T>(connection, operation, values, body, options);
  return { data, operationKey: operation.localKey };
}

export async function requestEmptyMutation(
  connection: RequestConnection,
  operation: SelectedOperation,
  values: JsonRequestValues = {},
  options: JsonMutationOptions = {},
): Promise<EmptyMutationSuccess> {
  await sendMutation<unknown>(connection, operation, values, undefined, options);
  return { operationKey: operation.localKey };
}
