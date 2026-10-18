import { Connection as JsforceConnection } from '@jsforce/jsforce-node';
import { randomBytes } from 'node:crypto';
import { constants as bufferConstants } from 'node:buffer';
import { assertMediaMimeType } from '../services/editable-media-source.js';
import type { Connection } from '@salesforce/core';
import type { Duplex } from 'node:stream';
import { CmsRequestError, type JsonRequestOptions } from './json-request.js';
import { redactSecrets } from './redact-secrets.js';
import { inheritCmsApiSelection } from '../api-policy.js';

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

export type ImageCreateInput = {
  apiName?: string;
  contentKey?: string;
  contentSpaceOrFolderId: string;
  title: string;
  urlName?: string;
};

export type ManagedContentDocumentBinding = {
  contentKey: string;
  managedContentId: string;
  managedContentVariantId: string;
};

export type MultipartImageCreateOptions = JsonRequestOptions & {
  /** Explicit native MIME for the binary part; omitted callers retain the legacy envelope. */
  mimeType?: string;
  boundaryFactory?: () => string;
  maxBoundaryAttempts?: number;
};

type RequestStream<T> = Promise<T> & {
  stream(): Duplex;
};

type RequestConnection = Pick<Connection, 'request'> &
  Partial<Pick<Connection, 'accessToken' | 'instanceUrl' | 'version'>>;

type MultipartParts = {
  body: Buffer;
  boundary: string;
  input: Readonly<Record<string, unknown>>;
};

const OPERATION_KEY = 'content.create';
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_BOUNDARY_ATTEMPTS = 8;
const ALLOWED_INPUT_KEYS = new Set([
  'apiName',
  'contentKey',
  'contentSpaceOrFolderId',
  'title',
  'urlName',
]);
const REQUIRED_RESPONSE_KEYS = [
  'contentKey',
  'managedContentId',
  'managedContentVariantId',
] as const;

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
  return redactSecrets(message || 'CMS image create failed').slice(0, 1024);
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

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 31 || codePoint === 127;
  });
}

function assertPlainNonemptyString(value: unknown, name: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0 || hasControlCharacter(value)) {
    throw new CmsRequestError(OPERATION_KEY, `Invalid image create field: ${name}`);
  }
}

function validateInput(input: ImageCreateInput): void {
  if (!isRecord(input)) {
    throw new CmsRequestError(OPERATION_KEY, 'Image create input must be an object');
  }
  for (const key of Object.keys(input)) {
    if (!ALLOWED_INPUT_KEYS.has(key)) {
      throw new CmsRequestError(OPERATION_KEY, `Unsupported image create field: ${key}`);
    }
  }
  assertPlainNonemptyString(input.contentSpaceOrFolderId, 'contentSpaceOrFolderId');
  assertPlainNonemptyString(input.title, 'title');
  for (const key of ['apiName', 'contentKey', 'urlName'] as const) {
    if (input[key] !== undefined) assertPlainNonemptyString(input[key], key);
  }
}

function validateFilename(filename: string): void {
  if (
    typeof filename !== 'string' ||
    filename.length === 0 ||
    filename.length > bufferConstants.MAX_LENGTH ||
    filename === '.' ||
    filename === '..' ||
    filename.includes('/') ||
    filename.includes('\\') ||
    filename.includes('"') ||
    hasControlCharacter(filename)
  ) {
    throw new CmsRequestError(OPERATION_KEY, 'Invalid image filename');
  }
}

function defaultBoundaryFactory(): string {
  return `sf-plugin-cms-${randomBytes(24).toString('hex')}`;
}

function validateBoundary(boundary: string): void {
  if (!/^[A-Za-z0-9'()+_,./:=?-]{1,70}$/u.test(boundary)) {
    throw new CmsRequestError(OPERATION_KEY, 'Invalid multipart boundary');
  }
}

function containsBoundary(buffer: Buffer, boundary: string): boolean {
  return buffer.includes(Buffer.from(boundary, 'ascii'));
}

function selectBoundary(
  json: Buffer,
  image: Buffer,
  factory: () => string,
  maxAttempts: number,
): string {
  if (!Number.isInteger(maxAttempts) || maxAttempts <= 0) {
    throw new CmsRequestError(OPERATION_KEY, 'Boundary attempt limit must be a positive integer');
  }
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const boundary = factory();
    validateBoundary(boundary);
    if (!containsBoundary(json, boundary) && !containsBoundary(image, boundary)) return boundary;
  }
  throw new CmsRequestError(OPERATION_KEY, 'Unable to generate collision-free multipart boundary');
}

export function buildImageCreateMultipart(
  input: ImageCreateInput,
  filename: string,
  image: Uint8Array,
  options: Pick<
    MultipartImageCreateOptions,
    'boundaryFactory' | 'maxBoundaryAttempts' | 'mimeType'
  > = {},
): MultipartParts {
  if (options.mimeType !== undefined) assertMediaMimeType(options.mimeType);
  validateFilename(filename);
  if ([...filename].some((character) => character.codePointAt(0)! > 127)) {
    throw new CmsRequestError(OPERATION_KEY, 'Image filename must contain only ASCII characters');
  }
  return buildFileCreateMultipart(input, filename, image, 'sfdc_cms__image', options);
}

export function buildAudioCreateMultipart(
  input: ImageCreateInput,
  filename: string,
  audio: Uint8Array,
  options: Pick<MultipartImageCreateOptions, 'boundaryFactory' | 'maxBoundaryAttempts'> & {
    mimeType: string;
  },
): MultipartParts {
  assertMediaMimeType(options.mimeType);
  validateFilename(filename);
  // Reject Unicode before ASCII framing can introduce header delimiters.
  if ([...filename].some((character) => character.codePointAt(0)! > 127)) {
    throw new CmsRequestError(OPERATION_KEY, 'Audio filename must contain only ASCII characters');
  }
  return buildFileCreateMultipart(input, filename, audio, 'sfdc_cms__audio', options);
}

export function buildDocumentCreateMultipart(
  input: ImageCreateInput,
  filename: string,
  document: Uint8Array,
  options: Pick<MultipartImageCreateOptions, 'boundaryFactory' | 'maxBoundaryAttempts'> = {},
): MultipartParts {
  validateFilename(filename);
  // ASCII framing truncates Unicode code points, potentially introducing header delimiters.
  if ([...filename].some((character) => character.codePointAt(0)! > 127)) {
    throw new CmsRequestError(
      OPERATION_KEY,
      'Document filename must contain only ASCII characters',
    );
  }
  if (!filename.endsWith('.txt')) {
    throw new CmsRequestError(OPERATION_KEY, 'Document filename must end with .txt');
  }
  return buildFileCreateMultipart(input, filename, document, 'sfdc_cms__document', options);
}

function buildFileCreateMultipart(
  input: ImageCreateInput,
  filename: string,
  image: Uint8Array,
  contentType: 'sfdc_cms__image' | 'sfdc_cms__document' | 'sfdc_cms__audio',
  options: Pick<
    MultipartImageCreateOptions,
    'boundaryFactory' | 'maxBoundaryAttempts' | 'mimeType'
  >,
): MultipartParts {
  validateInput(input);
  validateFilename(filename);
  if (!(image instanceof Uint8Array)) {
    throw new CmsRequestError(OPERATION_KEY, 'Image data must be binary');
  }
  if (image.byteLength === 0) {
    throw new CmsRequestError(OPERATION_KEY, 'Image data must not be empty');
  }
  if (!Number.isSafeInteger(image.byteLength) || image.byteLength > bufferConstants.MAX_LENGTH) {
    throw new CmsRequestError(OPERATION_KEY, 'Binary size cannot be represented by a Buffer');
  }
  if (contentType === 'sfdc_cms__document' && image.byteLength > MAX_IMAGE_BYTES) {
    throw new CmsRequestError(OPERATION_KEY, `Image exceeds ${MAX_IMAGE_BYTES} byte limit`);
  }

  const managedContentInput = {
    ...input,
    contentType,
    contentBody: { 'sfdc_cms:media': { source: { type: 'file' } } },
  } as const;
  const json = Buffer.from(JSON.stringify(managedContentInput), 'utf8');
  const binary = Buffer.from(image.buffer, image.byteOffset, image.byteLength);
  const boundary = selectBoundary(
    json,
    binary,
    options.boundaryFactory ?? defaultBoundaryFactory,
    options.maxBoundaryAttempts ?? DEFAULT_BOUNDARY_ATTEMPTS,
  );
  const firstHeader = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="ManagedContentInputParam"\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`,
    'ascii',
  );
  const binaryContentType =
    contentType === 'sfdc_cms__document'
      ? 'text/plain'
      : (options.mimeType ?? 'application/octet-stream; charset=ISO-8859-1');
  const secondHeader = Buffer.from(
    `\r\n--${boundary}\r\nContent-Disposition: form-data; name="contentData"; filename="${filename}"\r\nContent-Type: ${binaryContentType}\r\n\r\n`,
    'ascii',
  );
  const closing = Buffer.from(`\r\n--${boundary}--\r\n`, 'ascii');

  const parts = [firstHeader, json, secondHeader, binary, closing];
  const length = parts.reduce((total, part) => total + part.byteLength, 0);
  if (!Number.isSafeInteger(length) || length > bufferConstants.MAX_LENGTH) {
    throw new CmsRequestError(OPERATION_KEY, 'Multipart size cannot be represented by a Buffer');
  }
  return {
    body: Buffer.concat(parts, length),
    boundary,
    input: managedContentInput,
  };
}

function parseManagedContentDocument(value: unknown): ManagedContentDocumentBinding {
  if (!isRecord(value)) {
    throw new CmsRequestError(OPERATION_KEY, 'Malformed CMS image create response');
  }
  for (const key of REQUIRED_RESPONSE_KEYS) {
    if (typeof value[key] !== 'string' || value[key].length === 0) {
      throw new CmsRequestError(OPERATION_KEY, 'Malformed CMS image create response');
    }
  }
  return {
    contentKey: value.contentKey as string,
    managedContentId: value.managedContentId as string,
    managedContentVariantId: value.managedContentVariantId as string,
  };
}

export async function createImageContent(
  connection: RequestConnection,
  input: ImageCreateInput,
  filename: string,
  image: Uint8Array,
  options: MultipartImageCreateOptions = {},
): Promise<ManagedContentDocumentBinding> {
  return sendFileCreateMultipart(
    connection,
    buildImageCreateMultipart(input, filename, image, options),
    options,
  );
}

export async function createAudioContent(
  connection: RequestConnection,
  input: ImageCreateInput,
  filename: string,
  audio: Uint8Array,
  options: MultipartImageCreateOptions & { mimeType: string },
): Promise<ManagedContentDocumentBinding> {
  return sendFileCreateMultipart(
    connection,
    buildAudioCreateMultipart(input, filename, audio, options),
    options,
  );
}

export async function createDocumentContent(
  connection: RequestConnection,
  input: ImageCreateInput,
  filename: string,
  document: Uint8Array,
  options: MultipartImageCreateOptions = {},
): Promise<ManagedContentDocumentBinding> {
  return sendFileCreateMultipart(
    connection,
    buildDocumentCreateMultipart(input, filename, document, options),
    options,
  );
}

async function sendFileCreateMultipart(
  connection: RequestConnection,
  multipart: MultipartParts,
  options: MultipartImageCreateOptions,
): Promise<ManagedContentDocumentBinding> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new CmsRequestError(OPERATION_KEY, 'Request timeout must be a positive number');
  }
  if (options.signal?.aborted) {
    throw new CmsRequestError(OPERATION_KEY, 'CMS image create cancelled');
  }

  const request = withoutRefreshReplay(connection).request<unknown>(
    {
      body: multipart.body,
      headers: {
        'content-length': String(multipart.body.byteLength),
        'content-type': `multipart/form-data; boundary=${multipart.boundary}`,
      },
      method: 'POST',
      url: '/connect/cms/contents',
    },
    { retry: { maxRetries: 0 }, timeout: timeoutMs },
  ) as RequestStream<unknown>;
  const cancel = (): void => {
    request.stream().destroy(new Error('CMS image create cancelled'));
  };
  options.signal?.addEventListener('abort', cancel, { once: true });

  try {
    return parseManagedContentDocument(await request);
  } catch (error) {
    if (error instanceof CmsRequestError) throw error;
    const message = options.signal?.aborted
      ? 'CMS image create cancelled'
      : safeErrorMessage(error);
    throw new CmsRequestError(OPERATION_KEY, message, errorStatus(error));
  } finally {
    options.signal?.removeEventListener('abort', cancel);
  }
}
