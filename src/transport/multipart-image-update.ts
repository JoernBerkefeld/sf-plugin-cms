import { Connection as JsforceConnection } from '@jsforce/jsforce-node';
import { randomBytes } from 'node:crypto';
import type { Connection } from '@salesforce/core';
import type { Duplex } from 'node:stream';
import { inheritCmsApiSelection } from '../api-policy.js';
import type { UpdatedVariant } from '../services/lifecycle-foundation.js';
import { CmsRequestError, type JsonRequestOptions } from './json-request.js';
import { constants as bufferConstants } from 'node:buffer';
import { assertMediaMimeType } from '../services/editable-media-source.js';
import { redactSecrets } from './redact-secrets.js';

export type ImageUpdateInput = {
  apiName?: string;
  title?: string;
  urlName?: string;
};

export type MultipartImageUpdateOptions = JsonRequestOptions & {
  /** Explicit native MIME for the binary part; omitted callers retain the legacy envelope. */
  mimeType?: string;
  boundaryFactory?: () => string;
  maxBoundaryAttempts?: number;
};

type RequestConnection = Pick<Connection, 'request'> &
  Partial<Pick<Connection, 'accessToken' | 'instanceUrl' | 'version'>>;

type RequestStream = Promise<unknown> & { stream(): Duplex };

const OPERATION_KEY = 'variant.update';
const DEFAULT_TIMEOUT_MS = 30_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0)!;
    return code <= 31 || code === 127;
  });
}

function assertPlainString(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0 || hasControlCharacter(value)) {
    throw new CmsRequestError(OPERATION_KEY, `Invalid image update field: ${field}`);
  }
}

export function buildImageUpdateMultipart(
  input: ImageUpdateInput,
  filename: string,
  image: Uint8Array,
  options: Pick<
    MultipartImageUpdateOptions,
    'boundaryFactory' | 'maxBoundaryAttempts' | 'mimeType'
  > = {},
): { body: Buffer; boundary: string; input: Readonly<Record<string, unknown>> } {
  if (options.mimeType !== undefined) assertMediaMimeType(options.mimeType);
  if (!isRecord(input)) {
    throw new CmsRequestError(OPERATION_KEY, 'Image update input must be an object');
  }
  for (const key of Object.keys(input)) {
    if (!['apiName', 'title', 'urlName'].includes(key)) {
      throw new CmsRequestError(OPERATION_KEY, `Unsupported image update field: ${key}`);
    }
  }
  for (const key of ['apiName', 'title', 'urlName'] as const) {
    if (input[key] !== undefined) assertPlainString(input[key], key);
  }
  // ASCII-only filenames avoid lossy header encoding and preserve the original name exactly.
  if (
    typeof filename !== 'string' ||
    filename.length === 0 ||
    filename.length > bufferConstants.MAX_LENGTH ||
    filename === '.' ||
    filename === '..' ||
    hasControlCharacter(filename) ||
    [...filename].some((character) => character.codePointAt(0)! > 127) ||
    filename.includes('/') ||
    filename.includes('\\') ||
    filename.includes('"')
  ) {
    throw new CmsRequestError(OPERATION_KEY, 'Invalid image filename');
  }
  if (!(image instanceof Uint8Array)) {
    throw new CmsRequestError(OPERATION_KEY, 'Image data must be binary');
  }
  if (!image.byteLength) {
    throw new CmsRequestError(OPERATION_KEY, 'Image data must not be empty');
  }
  if (!Number.isSafeInteger(image.byteLength) || image.byteLength > bufferConstants.MAX_LENGTH) {
    throw new CmsRequestError(OPERATION_KEY, 'Binary size cannot be represented by a Buffer');
  }
  const managedContentVariantInput = {
    ...input,
    contentBody: { 'sfdc_cms:media': { source: { type: 'file' } } },
  };
  const json = Buffer.from(JSON.stringify(managedContentVariantInput), 'utf8');
  const binary = Buffer.from(image.buffer, image.byteOffset, image.byteLength);
  const maxAttempts = options.maxBoundaryAttempts ?? 8;
  if (!Number.isInteger(maxAttempts) || maxAttempts <= 0) {
    throw new CmsRequestError(OPERATION_KEY, 'Boundary attempt limit must be a positive integer');
  }
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const boundary =
      options.boundaryFactory?.() ?? `sf-plugin-cms-${randomBytes(24).toString('hex')}`;
    if (!/^[A-Za-z0-9'()+_,./:=?-]{1,70}$/u.test(boundary)) {
      throw new CmsRequestError(OPERATION_KEY, 'Invalid multipart boundary');
    }
    if (
      json.includes(Buffer.from(boundary, 'ascii')) ||
      binary.includes(Buffer.from(boundary, 'ascii'))
    ) {
      continue;
    }
    const parts = [
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="ManagedContentVariantInputParam"\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`,
        'ascii',
      ),
      json,
      Buffer.from(
        `\r\n--${boundary}\r\nContent-Disposition: form-data; name="contentData"; filename="${filename}"\r\nContent-Type: ${options.mimeType ?? 'application/octet-stream; charset=ISO-8859-1'}\r\n\r\n`,
        'ascii',
      ),
      binary,
      Buffer.from(`\r\n--${boundary}--\r\n`, 'ascii'),
    ];
    const length = parts.reduce((total, part) => total + part.byteLength, 0);
    if (!Number.isSafeInteger(length) || length > bufferConstants.MAX_LENGTH) {
      throw new CmsRequestError(OPERATION_KEY, 'Multipart size cannot be represented by a Buffer');
    }
    return { boundary, input: managedContentVariantInput, body: Buffer.concat(parts, length) };
  }
  throw new CmsRequestError(OPERATION_KEY, 'Unable to generate collision-free multipart boundary');
}

function validateUpdatedVariant(data: unknown): UpdatedVariant {
  if (!isRecord(data) || !isRecord(data.contentBody) || typeof data.isPublished !== 'boolean') {
    throw new CmsRequestError(OPERATION_KEY, 'Unexpected variant.update response shape');
  }
  for (const key of ['language', 'managedContentId', 'managedContentVariantId']) {
    if (typeof data[key] !== 'string' || data[key].length === 0) {
      throw new CmsRequestError(OPERATION_KEY, 'Unexpected variant.update response shape');
    }
  }
  return data as UpdatedVariant;
}

function withoutRefreshReplay(connection: RequestConnection): Pick<Connection, 'request'> {
  if (!connection.accessToken || !connection.instanceUrl) return connection;
  const fresh = new JsforceConnection({
    accessToken: connection.accessToken,
    instanceUrl: connection.instanceUrl,
    version: connection.version,
  });
  inheritCmsApiSelection(connection.version ? connection : fresh, fresh);
  return fresh;
}

/**
 * Replace private Image binary data once; this transport does not confer deploy eligibility.
 * @param {RequestConnection} connection - Authenticated request connection.
 * @param {string} variantId - Destination variant identity.
 * @param {ImageUpdateInput} input - UPDATE-only metadata fields.
 * @param {string} filename - Exact ASCII binary filename.
 * @param {Uint8Array} image - Binary bytes to upload.
 * @param {MultipartImageUpdateOptions} options - Boundary, timeout and cancellation controls.
 * @param {(data: unknown) => Promise<void>} observeResponse - Awaited raw-response observer before strict shape rejection.
 * @returns {Promise<UpdatedVariant>} Existing UPDATE response, not independently verified readback.
 */
export async function updateImageContent(
  connection: RequestConnection,
  variantId: string,
  input: ImageUpdateInput,
  filename: string,
  image: Uint8Array,
  options: MultipartImageUpdateOptions = {},
  observeResponse?: (data: unknown) => Promise<void>,
): Promise<UpdatedVariant> {
  assertPlainString(variantId, 'variantId');
  const multipart = buildImageUpdateMultipart(input, filename, image, options);
  return sendVariantUpdateMultipart(connection, variantId, multipart, options, observeResponse);
}

/**
 * Send an already validated native variant envelope exactly once without credential replay.
 * This shared request plumbing does not select or validate a media family.
 * @param {RequestConnection} connection - Authenticated destination.
 * @param {string} variantId - Native variant identity.
 * @param {object} multipart - Detached family-validated multipart body and boundary.
 * @param {Buffer} multipart.body - Exact validated wire bytes.
 * @param {string} multipart.boundary - Collision-free boundary.
 * @param {JsonRequestOptions} options - Timeout and cancellation controls.
 * @param {Function} observeResponse - Awaited raw response observer before strict validation.
 * @param {Function} onDispatch - Synchronous marker immediately before request invocation.
 * @returns {Promise<UpdatedVariant>} Shape-validated response, not independent readback.
 */
export async function sendVariantUpdateMultipart(
  connection: RequestConnection,
  variantId: string,
  multipart: { body: Buffer; boundary: string },
  options: JsonRequestOptions = {},
  observeResponse?: (data: unknown) => Promise<void>,
  onDispatch?: () => void,
): Promise<UpdatedVariant> {
  assertPlainString(variantId, 'variantId');
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new CmsRequestError(OPERATION_KEY, 'Request timeout must be a positive number');
  }
  if (options.signal?.aborted) {
    throw new CmsRequestError(OPERATION_KEY, 'CMS image update cancelled');
  }
  const receiver = withoutRefreshReplay(connection);
  onDispatch?.();
  const request = receiver.request<unknown>(
    {
      body: multipart.body,
      headers: {
        'content-length': String(multipart.body.byteLength),
        'content-type': `multipart/form-data; boundary=${multipart.boundary}`,
      },
      method: 'PUT',
      url: `/connect/cms/contents/variants/${encodeURIComponent(variantId)}`,
    },
    { retry: { maxRetries: 0 }, timeout: timeoutMs },
  ) as RequestStream;
  const cancel = (): void => {
    request.stream().destroy(new Error('CMS image update cancelled'));
  };
  options.signal?.addEventListener('abort', cancel, { once: true });
  try {
    const data = await request;
    // Durable journal consumers must see even partial identities before strict rejection.
    await observeResponse?.(data);
    return validateUpdatedVariant(data);
  } catch (error) {
    if (error instanceof CmsRequestError) throw error;
    const message = options.signal?.aborted
      ? 'CMS image update cancelled'
      : redactSecrets(error instanceof Error ? error.message : String(error)).slice(0, 1024);
    const status = isRecord(error) ? (error.statusCode ?? error.status) : undefined;
    throw new CmsRequestError(
      OPERATION_KEY,
      message,
      typeof status === 'number' && Number.isInteger(status) ? status : undefined,
    );
  } finally {
    options.signal?.removeEventListener('abort', cancel);
  }
}
