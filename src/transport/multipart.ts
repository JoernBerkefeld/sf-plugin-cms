import { constants as bufferConstants } from 'node:buffer';
import { randomBytes, randomUUID } from 'node:crypto';
import type { Duplex } from 'node:stream';
import { logApiEvent } from '../logging.js';
import {
  checkRequestOptions,
  DEFAULT_WRITE_TIMEOUT_MS,
  CmsRequestError,
  isRecord,
  sentRequestError,
  statusRecorder,
  type JsonRequestOptions,
} from './json-request.js';
import { oneShotConnection, type WriteConnection } from './one-shot-connection.js';

/** A built multipart body: the JSON part, then the binary part. Nothing is sent yet. */
export type MultipartBody = {
  body: Buffer;
  boundary: string;
  input: Readonly<Record<string, unknown>>;
  file: { name: string; mimeType: string; byteLength: number };
};

export type BoundaryOptions = {
  boundaryFactory?: () => string;
  maxBoundaryAttempts?: number;
};

const DEFAULT_BOUNDARY_ATTEMPTS = 8;

/**
 * A MIME type that is safe to put in a part header: ASCII `type/subtype`, no parameters.
 * @param {unknown} value - Candidate MIME type.
 */
export function assertMediaMimeType(value: unknown): asserts value is string {
  if (
    typeof value !== 'string' ||
    !/^[A-Za-z0-9!#$%&'*+.^_`|~-]+\/[A-Za-z0-9!#$%&'*+.^_`|~-]+$/u.test(value)
  )
    throw new TypeError('Media MIME type must be a safe ASCII type/subtype without parameters');
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 31 || codePoint === 127;
  });
}

/**
 * Header safety of the file name: ASCII only (the header is ASCII-framed, so other code points
 * could be truncated into delimiters), no quotes, paths or control characters.
 * @param {string} operationKey - Operation to name in the error.
 * @param {string} filename - Native file name.
 */
function assertSafeFilename(operationKey: string, filename: string): void {
  if (
    typeof filename !== 'string' ||
    filename.length === 0 ||
    filename.length > bufferConstants.MAX_LENGTH ||
    filename === '.' ||
    filename === '..' ||
    filename.includes('/') ||
    filename.includes('\\') ||
    filename.includes('"') ||
    hasControlCharacter(filename) ||
    [...filename].some((character) => character.codePointAt(0)! > 127)
  ) {
    throw new CmsRequestError(
      operationKey,
      'File name must be plain ASCII without paths or quotes',
    );
  }
}

function selectBoundary(
  operationKey: string,
  json: Buffer,
  binary: Buffer,
  options: BoundaryOptions,
): string {
  const maxAttempts = options.maxBoundaryAttempts ?? DEFAULT_BOUNDARY_ATTEMPTS;
  if (!Number.isInteger(maxAttempts) || maxAttempts <= 0) {
    throw new CmsRequestError(operationKey, 'Boundary attempt limit must be a positive integer');
  }
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const boundary =
      options.boundaryFactory?.() ?? `sf-plugin-cms-${randomBytes(24).toString('hex')}`;
    if (!/^[A-Za-z0-9'()+_,./:=?-]{1,70}$/u.test(boundary)) {
      throw new CmsRequestError(operationKey, 'Invalid multipart boundary');
    }
    const marker = Buffer.from(boundary, 'ascii');
    if (!json.includes(marker) && !binary.includes(marker)) return boundary;
  }
  throw new CmsRequestError(operationKey, 'Unable to generate collision-free multipart boundary');
}

/**
 * The JSON input with its media node pointing at the file part; other contentBody keys stay.
 * @param {Readonly<Record<string, unknown>>} input - JSON input as the caller built it.
 * @returns {Record<string, unknown>} Input with `contentBody['sfdc_cms:media'].source = file`.
 */
export function withFileSource(input: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const contentBody = isRecord(input.contentBody) ? input.contentBody : {};
  const media = isRecord(contentBody['sfdc_cms:media']) ? contentBody['sfdc_cms:media'] : {};
  return {
    ...input,
    contentBody: { ...contentBody, 'sfdc_cms:media': { ...media, source: { type: 'file' } } },
  };
}

/**
 * Frame the JSON part and the binary part of a CMS media request. Bytes are sent as they are.
 * @param {string} operationKey - Operation to name in errors.
 * @param {string} jsonPartName - Form name of the JSON part.
 * @param {Readonly<Record<string, unknown>>} input - JSON part content.
 * @param {string} filename - Native file name.
 * @param {Uint8Array} bytes - File bytes.
 * @param {string} mimeType - Content-Type header of the binary part.
 * @param {BoundaryOptions} options - Boundary controls.
 * @returns {MultipartBody} Body and boundary.
 */
export function buildMultipart(
  operationKey: string,
  jsonPartName: string,
  input: Readonly<Record<string, unknown>>,
  filename: string,
  bytes: Uint8Array,
  mimeType: string,
  options: BoundaryOptions = {},
): MultipartBody {
  assertSafeFilename(operationKey, filename);
  if (!(bytes instanceof Uint8Array)) {
    throw new CmsRequestError(operationKey, 'File data must be binary');
  }
  if (bytes.byteLength === 0) {
    throw new CmsRequestError(operationKey, 'File data must not be empty');
  }
  const json = Buffer.from(JSON.stringify(input), 'utf8');
  const binary = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const boundary = selectBoundary(operationKey, json, binary, options);
  const parts = [
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${jsonPartName}"\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`,
      'ascii',
    ),
    json,
    Buffer.from(
      `\r\n--${boundary}\r\nContent-Disposition: form-data; name="contentData"; filename="${filename}"\r\nContent-Type: ${mimeType}\r\n\r\n`,
      'ascii',
    ),
    binary,
    Buffer.from(`\r\n--${boundary}--\r\n`, 'ascii'),
  ];
  const length = parts.reduce((total, part) => total + part.byteLength, 0);
  if (!Number.isSafeInteger(length) || length > bufferConstants.MAX_LENGTH) {
    throw new CmsRequestError(operationKey, 'Multipart size cannot be represented by a Buffer');
  }
  return {
    body: Buffer.concat(parts, length),
    boundary,
    input,
    file: { name: filename, mimeType, byteLength: bytes.byteLength },
  };
}

/**
 * Send one multipart write exactly once on a token-only connection, never retried.
 * @param {WriteConnection} connection - Org connection.
 * @param {string} operationKey - Operation key for logs and errors.
 * @param {'POST' | 'PUT'} method - HTTP method.
 * @param {string} url - Relative URL.
 * @param {MultipartBody} multipart - Built body.
 * @param {JsonRequestOptions} options - Timeout and cancellation.
 * @returns {Promise<unknown>} Parsed response.
 */
export async function sendMultipart(
  connection: WriteConnection,
  operationKey: string,
  method: 'POST' | 'PUT',
  url: string,
  multipart: MultipartBody,
  options: JsonRequestOptions = {},
): Promise<unknown> {
  const timeoutMs = checkRequestOptions(operationKey, options, DEFAULT_WRITE_TIMEOUT_MS);
  const receiver = oneShotConnection(connection, operationKey, true);
  const details = {
    requestId: randomUUID(),
    method,
    url,
    operationKey,
    startedAt: Date.now(),
    transport: 'multipart' as const,
  };
  const headers = {
    'content-length': String(multipart.body.byteLength),
    'content-type': `multipart/form-data; boundary=${multipart.boundary}`,
  };
  logApiEvent('request', details, {
    headers,
    json: multipart.input,
    file: multipart.file,
    binary: 'omitted: multipart binary bytes',
  });
  const recorder = statusRecorder(receiver);
  let request: Promise<unknown> & { stream(): Duplex };
  try {
    request = receiver.request<unknown>({ body: multipart.body, headers, method, url }, {
      retry: { maxRetries: 0 },
      timeout: timeoutMs,
      ...recorder.options,
    } as unknown as Parameters<typeof receiver.request>[1]) as Promise<unknown> & {
      stream(): Duplex;
    };
  } catch (error) {
    logApiEvent('error', details, error);
    throw error;
  }
  const cancel = (): void => {
    request.stream().destroy(new Error('CMS request cancelled'));
  };
  options.signal?.addEventListener('abort', cancel, { once: true });
  try {
    const data = await request;
    logApiEvent('response', { ...details, response: recorder.response() }, data);
    return data;
  } catch (error) {
    logApiEvent('error', { ...details, response: recorder.response() }, error);
    throw sentRequestError(
      operationKey,
      error,
      options.signal?.aborted === true,
      recorder.status(),
      {
        timeoutMs,
        startedAt: details.startedAt,
        write: true,
        responseHeaders: recorder.response()?.headers,
      },
    );
  } finally {
    options.signal?.removeEventListener('abort', cancel);
  }
}
