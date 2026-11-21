import {
  buildVariantUpdateMultipart,
  type MultipartUpdateOptions,
  type VariantUpdateInput,
} from './multipart-image-update.js';
import { assertMediaMimeType, type MultipartBody } from './multipart.js';

/**
 * Build an Audio variant update body; the MIME type is required. Nothing is sent.
 * Send it with `sendVariantUpdateMultipart`.
 * @param {VariantUpdateInput} input - JSON part, sent as given.
 * @param {string} filename - Native file name.
 * @param {Uint8Array} bytes - Audio bytes.
 * @param {Pick<MultipartUpdateOptions, 'boundaryFactory' | 'maxBoundaryAttempts'> & { mimeType: string }} options - MIME and boundary controls.
 * @returns {MultipartBody} Built body.
 */
export function buildAudioUpdateMultipart(
  input: VariantUpdateInput,
  filename: string,
  bytes: Uint8Array,
  options: Pick<MultipartUpdateOptions, 'boundaryFactory' | 'maxBoundaryAttempts'> & {
    mimeType: string;
  },
): MultipartBody {
  assertMediaMimeType(options?.mimeType);
  return buildVariantUpdateMultipart(input, filename, bytes, options);
}
