import { CmsRequestError, isRecord, type JsonRequestOptions } from './json-request.js';
import {
  assertMediaMimeType,
  buildMultipart,
  sendMultipart,
  withFileSource,
  type BoundaryOptions,
  type MultipartBody,
} from './multipart.js';
import type { WriteConnection } from './one-shot-connection.js';

/** JSON part of a variant update (title, urlName, contentBody, ...), sent as given. */
export type VariantUpdateInput = Readonly<Record<string, unknown>>;

/** What a variant update answers. */
export type UpdatedVariant = {
  contentBody: Readonly<Record<string, unknown>>;
  isPublished: boolean;
  language: string;
  managedContentId: string;
  managedContentVariantId: string;
};

export type MultipartUpdateOptions = JsonRequestOptions &
  BoundaryOptions & {
    /** Content-Type of the binary part; default `application/octet-stream`. */
    mimeType?: string;
  };

const OPERATION_KEY = 'variant.update';
const DEFAULT_MIME = 'application/octet-stream; charset=ISO-8859-1';

/**
 * Build a variant update body (JSON part `ManagedContentVariantInputParam` plus the file).
 * @param {VariantUpdateInput} input - JSON part.
 * @param {string} filename - Native file name.
 * @param {Uint8Array} bytes - File bytes.
 * @param {Pick<MultipartUpdateOptions, 'boundaryFactory' | 'maxBoundaryAttempts' | 'mimeType'>} options - MIME and boundary controls.
 * @returns {MultipartBody} Built body.
 */
export function buildVariantUpdateMultipart(
  input: VariantUpdateInput,
  filename: string,
  bytes: Uint8Array,
  options: Pick<
    MultipartUpdateOptions,
    'boundaryFactory' | 'maxBoundaryAttempts' | 'mimeType'
  > = {},
): MultipartBody {
  if (options.mimeType !== undefined) assertMediaMimeType(options.mimeType);
  if (!isRecord(input)) {
    throw new CmsRequestError(OPERATION_KEY, 'Variant update input must be an object');
  }
  return buildMultipart(
    OPERATION_KEY,
    'ManagedContentVariantInputParam',
    withFileSource(input),
    filename,
    bytes,
    options.mimeType ?? DEFAULT_MIME,
    options,
  );
}

/**
 * Same as {@link buildVariantUpdateMultipart}, for Image.
 * @param {VariantUpdateInput} input - JSON part.
 * @param {string} filename - Native file name.
 * @param {Uint8Array} bytes - Image bytes.
 * @param {Pick<MultipartUpdateOptions, 'boundaryFactory' | 'maxBoundaryAttempts' | 'mimeType'>} options - MIME and boundary controls.
 * @returns {MultipartBody} Built body.
 */
export function buildImageUpdateMultipart(
  input: VariantUpdateInput,
  filename: string,
  bytes: Uint8Array,
  options: Pick<
    MultipartUpdateOptions,
    'boundaryFactory' | 'maxBoundaryAttempts' | 'mimeType'
  > = {},
): MultipartBody {
  return buildVariantUpdateMultipart(input, filename, bytes, options);
}

function parseUpdatedVariant(data: unknown): UpdatedVariant {
  if (
    !isRecord(data) ||
    !isRecord(data.contentBody) ||
    typeof data.isPublished !== 'boolean' ||
    !['language', 'managedContentId', 'managedContentVariantId'].every(
      (key) => typeof data[key] === 'string' && (data[key] as string).length > 0,
    )
  ) {
    throw new CmsRequestError(OPERATION_KEY, 'Unexpected variant.update response shape', 200, {
      requestSent: true,
      statusObserved: false,
    });
  }
  return data as UpdatedVariant;
}

/**
 * Send a built variant update once (PUT /connect/cms/contents/variants/{variantId}).
 * @param {WriteConnection} connection - Org connection.
 * @param {string} variantId - Destination variant ID.
 * @param {MultipartBody} multipart - Built body.
 * @param {JsonRequestOptions} options - Timeout and cancellation.
 * @returns {Promise<UpdatedVariant>} Updated variant as Salesforce answered.
 */
export async function sendVariantUpdateMultipart(
  connection: WriteConnection,
  variantId: string,
  multipart: MultipartBody,
  options: JsonRequestOptions = {},
): Promise<UpdatedVariant> {
  if (typeof variantId !== 'string' || variantId.length === 0) {
    throw new CmsRequestError(OPERATION_KEY, 'Variant update needs a variant ID');
  }
  const data = await sendMultipart(
    connection,
    OPERATION_KEY,
    'PUT',
    `/connect/cms/contents/variants/${encodeURIComponent(variantId)}`,
    multipart,
    options,
  );
  return parseUpdatedVariant(data);
}
