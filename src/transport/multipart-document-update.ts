import {
  buildVariantUpdateMultipart,
  type MultipartUpdateOptions,
  type VariantUpdateInput,
} from './multipart-image-update.js';
import type { MultipartBody } from './multipart.js';

/**
 * Build a Document variant update body (binary part default `text/plain`); nothing is sent.
 * Send it with `sendVariantUpdateMultipart`.
 * @param {VariantUpdateInput} input - JSON part, sent as given.
 * @param {string} filename - Native file name.
 * @param {Uint8Array} bytes - Document bytes.
 * @param {Pick<MultipartUpdateOptions, 'boundaryFactory' | 'maxBoundaryAttempts' | 'mimeType'>} options - MIME and boundary controls.
 * @returns {MultipartBody} Built body.
 */
export function buildDocumentUpdateMultipart(
  input: VariantUpdateInput,
  filename: string,
  bytes: Uint8Array,
  options: Pick<
    MultipartUpdateOptions,
    'boundaryFactory' | 'maxBoundaryAttempts' | 'mimeType'
  > = {},
): MultipartBody {
  return buildVariantUpdateMultipart(input, filename, bytes, {
    ...options,
    mimeType: options.mimeType ?? 'text/plain',
  });
}
