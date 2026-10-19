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
  'boundaryFactory' | 'maxBoundaryAttempts' | 'mimeType'
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
 * Preserve opaque bytes and safe native MIME/filename identity without format or size policy.
 * @param {DocumentUpdateInput} input - Exact accepted metadata combination, without server fields.
 * @param {string} filename - Unchanged safe native ASCII filename.
 * @param {Uint8Array} bytes - Nonempty opaque bytes, preserved without re-encoding.
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
  // Reuse pure framing only: the existing primitive constructs the exact accepted media node.
  return buildImageUpdateMultipart(
    { apiName: input.apiName, title: input.title, urlName: input.urlName },
    filename,
    bytes,
    {
      boundaryFactory: options.boundaryFactory,
      maxBoundaryAttempts: options.maxBoundaryAttempts,
      mimeType: options.mimeType ?? 'text/plain',
    },
  );
}
