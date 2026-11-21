import type { Connection } from '@salesforce/core';
import { MEDIA_FIELD } from '../content/handlers/media.js';
import type { ContentTypeHandler, MediaFile, NativeVariant } from '../content/types.js';
import { CmsError } from '../errors/registry.js';
import {
  downloadExperimentalCmsMedia,
  type ExperimentalMediaDownloadOptions,
} from '../transport/experimental-media.js';
import { isRecord, type RequestConnection } from '../transport/json-request.js';

/** A connection that can also download media: its token and instance URL. */
export type MediaConnection = RequestConnection &
  Partial<Pick<Connection, 'accessToken' | 'instanceUrl'>>;

type FileHandle =
  NonNullable<ExperimentalMediaDownloadOptions['openFile']> extends (
    file: string,
  ) => Promise<infer H>
    ? H
    : never;

/**
 * The uploaded file of a media variant, downloaded into memory through the media transport
 * (instance origin, `/cms/media/` path, file.force.com redirects only). The answer must match
 * the size, MIME type and MD5 the variant states. Undefined for JSON types and for media
 * without an uploaded file (an external URL image).
 * @param {MediaConnection} connection - Org connection (token and instance URL).
 * @param {ContentTypeHandler} handler - Handler of the variant's type.
 * @param {NativeVariant} native - Variant as read.
 * @returns {Promise<MediaFile | undefined>} Native file name and bytes.
 */
export async function mediaOf(
  connection: MediaConnection,
  handler: ContentTypeHandler,
  native: NativeVariant,
): Promise<MediaFile | undefined> {
  if (handler.transport !== 'multipart') return undefined;
  const media = isRecord(native.contentBody) ? native.contentBody[MEDIA_FIELD] : undefined;
  if (!isRecord(media) || !isRecord(media.source) || media.source.type !== 'file') return undefined;
  const { source } = media;
  const component = `${handler.type}:${String(native.apiName)}`;
  try {
    if (typeof media.url !== 'string' || !connection.instanceUrl)
      throw new Error('the variant has no media URL');
    const url = new URL(media.url, connection.instanceUrl);
    const fileName = url.searchParams.get('fileName') ?? '';
    const chunks: Buffer[] = [];
    const handle = {
      write: async (chunk: Uint8Array) => {
        chunks.push(Buffer.from(chunk));
        return { bytesWritten: chunk.byteLength, buffer: chunk };
      },
      close: async () => {},
    } as unknown as FileHandle;
    await downloadExperimentalCmsMedia(url, {
      accessToken: connection.accessToken ?? '',
      instanceUrl: connection.instanceUrl,
      contentType: handler.apiName as ExperimentalMediaDownloadOptions['contentType'],
      expectedMd5: url.searchParams.get('fileHash') ?? '',
      expectedMimeType: String(source.mimeType),
      expectedSize: Number(source.size ?? source.fileSize),
      outputFile: fileName,
      openFile: async () => handle,
      unlinkFile: async () => {},
    });
    return { fileName, bytes: new Uint8Array(Buffer.concat(chunks)) };
  } catch (error) {
    throw new CmsError(
      'MEDIA_DOWNLOAD_FAILED',
      `${component}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
