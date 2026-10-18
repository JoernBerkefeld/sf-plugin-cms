import { assertMediaMimeType } from '../services/editable-media-source.js';
import { CmsRequestError } from './json-request.js';
import {
  buildImageUpdateMultipart,
  type MultipartImageUpdateOptions,
} from './multipart-image-update.js';

export type AudioUpdateInput = {
  title: string;
  urlName?: string;
};

export type MultipartAudioUpdateOptions = Pick<
  MultipartImageUpdateOptions,
  'boundaryFactory' | 'maxBoundaryAttempts'
> & { mimeType: string };

/**
 * Build a local, unqualified Audio UPDATE candidate without performing any requests.
 * This framing is not an established native Audio API contract or deploy admission.
 * @param {AudioUpdateInput} input - Required title and optional URL name only.
 * @param {string} filename - Exact safe ASCII binary filename.
 * @param {Uint8Array} bytes - Opaque nonempty bytes, without format or size admission policy.
 * @param {MultipartAudioUpdateOptions} options - Explicit safe MIME and boundary controls.
 * @returns {object} Detached multipart bytes, boundary and file-source metadata.
 */
export function buildAudioUpdateMultipart(
  input: AudioUpdateInput,
  filename: string,
  bytes: Uint8Array,
  options: MultipartAudioUpdateOptions,
): { body: Buffer; boundary: string; input: Readonly<Record<string, unknown>> } {
  assertMediaMimeType(options?.mimeType);
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new CmsRequestError('variant.update', 'Audio update input must be an object');
  }
  for (const key of Reflect.ownKeys(input)) {
    if (key !== 'title' && key !== 'urlName') {
      throw new CmsRequestError('variant.update', `Unsupported audio update field: ${String(key)}`);
    }
  }
  if (
    !Object.hasOwn(input, 'title') ||
    typeof input.title !== 'string' ||
    input.title.length === 0
  ) {
    throw new CmsRequestError('variant.update', 'Invalid audio update field: title');
  }
  const selected: AudioUpdateInput = { title: input.title };
  if (Object.hasOwn(input, 'urlName')) {
    if (typeof input.urlName !== 'string' || input.urlName.length === 0) {
      throw new CmsRequestError('variant.update', 'Invalid audio update field: urlName');
    }
    selected.urlName = input.urlName;
  }
  // Reuse only pure framing: existing validation preserves exact bytes and rejects unsafe headers.
  return buildImageUpdateMultipart(selected, filename, bytes, {
    mimeType: options.mimeType,
    boundaryFactory: options.boundaryFactory,
    maxBoundaryAttempts: options.maxBoundaryAttempts,
  });
}
