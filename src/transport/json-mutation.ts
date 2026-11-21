import { randomUUID } from 'node:crypto';
import type { Duplex } from 'node:stream';
import type { SelectedOperation } from '../generated/operations.js';
import {
  buildOperationUrl,
  checkRequestOptions,
  CmsRequestError,
  sentRequestError,
  statusRecorder,
  type JsonRequestOptions,
  type JsonRequestValues,
  type OperationKey,
  RAW_TEXT_HEADERS,
} from './json-request.js';
import { oneShotConnection, type WriteConnection } from './one-shot-connection.js';
import { logApiEvent } from '../logging.js';

export type JsonMutationBody = Readonly<Record<string, unknown>>;

export type JsonMutationSuccess<T> = {
  data: T;
  operationKey: OperationKey;
};

export type EmptyMutationSuccess = {
  operationKey: OperationKey;
};

export type JsonMutationOptions = JsonRequestOptions & {
  allowCallerConnection?: boolean;
};

type RequestStream<T> = Promise<T> & {
  stream(): Duplex;
};

function validateMutationOperation(operation: SelectedOperation, hasBody: boolean): void {
  if (operation.method !== 'POST' && operation.method !== 'PUT' && operation.method !== 'DELETE') {
    throw new CmsRequestError(
      operation.localKey,
      `Unsupported mutation method: ${operation.method}`,
    );
  }
  const requestBodyMediaTypes = operation.requestBodyMediaTypes as readonly string[];
  // The v67 schema lists only multipart for the variant PUT; Salesforce accepts JSON there too.
  const jsonVariantUpdate = operation.localKey === 'variant.update' && operation.method === 'PUT';
  if (hasBody && !requestBodyMediaTypes.includes('application/json') && !jsonVariantUpdate) {
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
  connection: WriteConnection,
  operation: SelectedOperation,
  values: JsonRequestValues,
  body: JsonMutationBody | undefined,
  options: JsonMutationOptions,
): Promise<T> {
  const timeoutMs = checkRequestOptions(operation.localKey, options);
  validateMutationOperation(operation, body !== undefined);
  const receiver = oneShotConnection(
    connection,
    operation.localKey,
    options.allowCallerConnection === true,
  );
  const input = {
    method: operation.method,
    url: buildOperationUrl(operation, values),
    // Salesforce stores the body as sent either way; the header keeps the answer raw too.
    headers: { 'content-type': 'application/json', ...RAW_TEXT_HEADERS },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };
  const event = {
    requestId: randomUUID(),
    startedAt: Date.now(),
    method: operation.method,
    url: input.url,
    operationKey: operation.localKey,
  };
  logApiEvent('request', event, body);
  const recorder = statusRecorder(receiver);
  let request: RequestStream<T>;
  try {
    request = receiver.request<T>(input, {
      retry: { maxRetries: 0 },
      timeout: timeoutMs,
      ...recorder.options,
    } as unknown as Parameters<typeof receiver.request>[1]) as RequestStream<T>;
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
    return data;
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
 * Send one JSON write (POST/PUT/DELETE with a body) exactly once, never retried.
 * @template T
 * @param {WriteConnection} connection - Org connection.
 * @param {SelectedOperation} operation - Generated operation descriptor.
 * @param {JsonMutationBody} body - JSON body as the file says.
 * @param {JsonRequestValues} values - Path and query values.
 * @param {JsonMutationOptions} options - Timeout and cancellation.
 * @returns {Promise<JsonMutationSuccess<T>>} Parsed response.
 */
export async function requestJsonMutation<T>(
  connection: WriteConnection,
  operation: SelectedOperation,
  body: JsonMutationBody,
  values: JsonRequestValues = {},
  options: JsonMutationOptions = {},
): Promise<JsonMutationSuccess<T>> {
  const data = await sendMutation<T>(connection, operation, values, body, options);
  return { data, operationKey: operation.localKey };
}

/**
 * Send one write without a body (such as DELETE) exactly once, never retried.
 * @param {WriteConnection} connection - Org connection.
 * @param {SelectedOperation} operation - Generated operation descriptor.
 * @param {JsonRequestValues} values - Path and query values.
 * @param {JsonMutationOptions} options - Timeout and cancellation.
 * @returns {Promise<EmptyMutationSuccess>} Operation key.
 */
export async function requestEmptyMutation(
  connection: WriteConnection,
  operation: SelectedOperation,
  values: JsonRequestValues = {},
  options: JsonMutationOptions = {},
): Promise<EmptyMutationSuccess> {
  await sendMutation<unknown>(connection, operation, values, undefined, options);
  return { operationKey: operation.localKey };
}
