import { isUtf8 } from 'node:buffer';
import { CmsRequestError } from './json-request.js';
import {
  buildImageUpdateMultipart,
  type MultipartImageUpdateOptions,
} from './multipart-image-update.js';

export type DocumentUpdateInput = {
  apiName: string;
  title: string;
  urlName: string;
  contentBody: { 'sfdc_cms:media': { source: { type: 'file' } } };
};

export type MultipartDocumentUpdateOptions = Pick<
  MultipartImageUpdateOptions,
  'boundaryFactory' | 'maxBoundaryAttempts'
>;

function assertExactKeys(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  ) {
    throw new CmsRequestError('variant.update', 'Unsupported Document UPDATE metadata shape');
  }
}

/**
 * Build only the evidenced native Document UPDATE envelope; never issue a request.
 * These UTF-8, text/plain, ASCII .txt and 10 MiB bounds are a local profile, not API limits.
 * @param {DocumentUpdateInput} input - Exact accepted metadata combination, without server fields.
 * @param {string} filename - Unchanged native ASCII filename ending in lowercase .txt.
 * @param {Uint8Array} bytes - Nonempty UTF-8 bytes, preserved without re-encoding.
 * @param {MultipartDocumentUpdateOptions} options - Bounded collision-free boundary selection.
 * @returns {object} Detached multipart bytes, boundary and native metadata.
 */
export function buildDocumentUpdateMultipart(
  input: DocumentUpdateInput,
  filename: string,
  bytes: Uint8Array,
  options: MultipartDocumentUpdateOptions = {},
): { body: Buffer; boundary: string; input: Readonly<Record<string, unknown>> } {
  assertExactKeys(input, ['apiName', 'title', 'urlName', 'contentBody']);
  assertExactKeys(input.contentBody, ['sfdc_cms:media']);
  assertExactKeys(input.contentBody['sfdc_cms:media'], ['source']);
  assertExactKeys(input.contentBody['sfdc_cms:media'].source, ['type']);
  if (input.contentBody['sfdc_cms:media'].source.type !== 'file')
    throw new CmsRequestError('variant.update', 'Document UPDATE source must be file');
  for (const field of ['apiName', 'title', 'urlName'] as const) {
    if (typeof input[field] !== 'string' || !input[field].trim())
      throw new CmsRequestError('variant.update', `Invalid Document UPDATE field: ${field}`);
  }
  if (typeof filename !== 'string' || !filename.endsWith('.txt'))
    throw new CmsRequestError('variant.update', 'Document filename must end with .txt');
  if (!(bytes instanceof Uint8Array) || !bytes.byteLength || bytes.byteLength > 10 * 1024 * 1024)
    throw new CmsRequestError(
      'variant.update',
      'Document UPDATE requires nonempty binary up to 10 MiB',
    );
  if (!isUtf8(bytes))
    throw new CmsRequestError('variant.update', 'Document UPDATE bytes must be valid UTF-8');
  // Reuse pure framing only: the existing primitive constructs the exact accepted media node.
  return buildImageUpdateMultipart(
    { apiName: input.apiName, title: input.title, urlName: input.urlName },
    filename,
    bytes,
    {
      boundaryFactory: options.boundaryFactory,
      maxBoundaryAttempts: options.maxBoundaryAttempts,
      mimeType: 'text/plain',
    },
  );
}
