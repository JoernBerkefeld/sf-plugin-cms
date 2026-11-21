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

/**
 * JSON part of a media create. `contentSpaceOrFolderId` is required; every other key is sent as
 * the caller gives it. `contentType` is set by the builder.
 */
export type MediaCreateInput = Readonly<Record<string, unknown>> & {
  contentSpaceOrFolderId: string;
  title?: string;
  apiName?: string;
  contentKey?: string;
  urlName?: string;
  contentBody?: Readonly<Record<string, unknown>>;
};

/** What a create answers: the identities of the new content and its default variant. */
export type ManagedContentDocumentBinding = {
  contentKey: string;
  managedContentId: string;
  managedContentVariantId: string;
};

export type MultipartCreateOptions = JsonRequestOptions &
  BoundaryOptions & {
    /** Content-Type of the binary part; a per-type default applies when omitted. */
    mimeType?: string;
  };

export type MediaContentType =
  | 'sfdc_cms__image'
  | 'sfdc_cms__document'
  | 'sfdc_cms__audio'
  | 'sfdc_cms__video'
  | 'sfdc_cms__customFont'
  | 'sfdc_cms__vcf';

const OPERATION_KEY = 'content.create';
// Default part MIME type per media type; undefined = the file must name its MIME type.
const DEFAULT_MIME: Record<MediaContentType, string | undefined> = {
  sfdc_cms__image: 'application/octet-stream; charset=ISO-8859-1',
  sfdc_cms__document: 'text/plain',
  sfdc_cms__audio: undefined,
  sfdc_cms__video: undefined,
  sfdc_cms__customFont: undefined,
  sfdc_cms__vcf: undefined,
};

/**
 * Whether a content type is one of the media types (multipart create and update).
 * @param {string} contentType - Native content type.
 * @returns {boolean} True for a media type.
 */
export const isMediaContentType = (contentType: string): contentType is MediaContentType =>
  Object.hasOwn(DEFAULT_MIME, contentType);

/**
 * Whether a media type needs the file's MIME type from the source (it has no default).
 * @param {MediaContentType} contentType - Native media type.
 * @returns {boolean} True when the MIME type is required.
 */
export const mediaMimeTypeRequired = (contentType: MediaContentType): boolean =>
  DEFAULT_MIME[contentType] === undefined;

/**
 * Build a media create body without sending it.
 * @param {MediaContentType} contentType - Native content type.
 * @param {MediaCreateInput} input - JSON part.
 * @param {string} filename - Native file name.
 * @param {Uint8Array} bytes - File bytes.
 * @param {MultipartCreateOptions} options - MIME and boundary controls.
 * @returns {MultipartBody} Built body.
 */
export function buildMediaCreateMultipart(
  contentType: MediaContentType,
  input: MediaCreateInput,
  filename: string,
  bytes: Uint8Array,
  options: Pick<
    MultipartCreateOptions,
    'boundaryFactory' | 'maxBoundaryAttempts' | 'mimeType'
  > = {},
): MultipartBody {
  if (options.mimeType !== undefined) assertMediaMimeType(options.mimeType);
  const mimeType = options.mimeType ?? DEFAULT_MIME[contentType];
  if (mimeType === undefined) {
    throw new CmsRequestError(OPERATION_KEY, `A MIME type is required for ${contentType}`);
  }
  if (
    !isRecord(input) ||
    typeof input.contentSpaceOrFolderId !== 'string' ||
    input.contentSpaceOrFolderId.length === 0
  ) {
    throw new CmsRequestError(OPERATION_KEY, 'Media create needs contentSpaceOrFolderId');
  }
  return buildMultipart(
    OPERATION_KEY,
    'ManagedContentInputParam',
    withFileSource({ ...input, contentType }),
    filename,
    bytes,
    mimeType,
    options,
  );
}

function parseBinding(value: unknown): ManagedContentDocumentBinding {
  if (
    !isRecord(value) ||
    !['contentKey', 'managedContentId', 'managedContentVariantId'].every(
      (key) => typeof value[key] === 'string' && (value[key] as string).length > 0,
    )
  ) {
    throw new CmsRequestError(OPERATION_KEY, 'Unexpected content.create response shape', 200, {
      requestSent: true,
      statusObserved: false,
    });
  }
  return {
    contentKey: value.contentKey as string,
    managedContentId: value.managedContentId as string,
    managedContentVariantId: value.managedContentVariantId as string,
  };
}

/**
 * Create one media item from its bytes (POST /connect/cms/contents, multipart), sent once.
 * @param {MediaContentType} contentType - Native content type.
 * @param {WriteConnection} connection - Org connection.
 * @param {MediaCreateInput} input - JSON part.
 * @param {string} filename - Native file name.
 * @param {Uint8Array} bytes - File bytes.
 * @param {MultipartCreateOptions} options - MIME, boundary, timeout and cancellation.
 * @returns {Promise<ManagedContentDocumentBinding>} New identities.
 */
export async function createMediaContent(
  contentType: MediaContentType,
  connection: WriteConnection,
  input: MediaCreateInput,
  filename: string,
  bytes: Uint8Array,
  options: MultipartCreateOptions,
): Promise<ManagedContentDocumentBinding> {
  const multipart = buildMediaCreateMultipart(contentType, input, filename, bytes, options);
  const data = await sendMultipart(
    connection,
    OPERATION_KEY,
    'POST',
    '/connect/cms/contents',
    multipart,
    options,
  );
  return parseBinding(data);
}
