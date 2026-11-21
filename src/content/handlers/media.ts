import { CmsError } from '../../errors/registry.js';
import { projectJsonVariant } from '../json-projection.js';
import { jsonPayloadFromSource, logicalReferences } from '../json-source.js';
import type { ContentTypeHandler, DeployPayload, NativeVariant, SourceFiles } from '../types.js';

/** Body key of the uploaded file of a media type. */
export const MEDIA_FIELD = 'sfdc_cms:media';

// Facts Salesforce derives from the uploaded bytes or assigns to them.
const DERIVED_SOURCE_FIELDS: ReadonlySet<string> = new Set(['fileSize', 'ref', 'size']);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The media node without what Salesforce derives: the `url` (`/cms/media/…`, or a copy of an
 * external `source.url`) and the file facts of `source` (`ref`, `size`, `fileSize`).
 * @param {Record<string, unknown>} body - Native contentBody.
 * @returns {Record<string, unknown>} Body for the source file.
 */
function withoutDerivedMediaFields(body: Record<string, unknown>): Record<string, unknown> {
  const media = body[MEDIA_FIELD];
  if (!isPlainObject(media)) return body;
  const source = isPlainObject(media.source)
    ? Object.fromEntries(
        Object.entries(media.source).filter(([key]) => !DERIVED_SOURCE_FIELDS.has(key)),
      )
    : media.source;
  const derivedUrl =
    typeof media.url === 'string' &&
    (media.url.startsWith('/cms/media/') ||
      (isPlainObject(media.source) && media.url === media.source.url));
  const rest = Object.fromEntries(
    Object.entries(media).filter(([key]) => key !== 'url' || !derivedUrl),
  );
  return { ...body, [MEDIA_FIELD]: { ...rest, source } };
}

function isFileSource(body: Record<string, unknown>): boolean {
  const media = body[MEDIA_FIELD];
  return isPlainObject(media) && isPlainObject(media.source) && media.source.type === 'file';
}

/**
 * A media type: the JSON holds the metadata (title, alt text, MIME type, …), the uploaded file
 * sits next to it as `<ApiName>.<type>.<native file name>`. Create and update are multipart
 * (the file plus the JSON); an item without a file (an external URL image) is sent as JSON.
 * @param {string} type - CLI type name.
 * @param {string} apiName - Salesforce content type.
 * @returns {ContentTypeHandler} Handler.
 */
export function mediaHandler(type: string, apiName: string): ContentTypeHandler {
  return {
    type,
    apiName,
    transport: 'multipart',
    toSource(native: NativeVariant, context): SourceFiles {
      const body = isPlainObject(native.contentBody) ? native.contentBody : {};
      if (isFileSource(body) && !context.media)
        throw new CmsError(
          'MEDIA_FILE_MISSING',
          `The file of ${type}:${native.apiName} was not read`,
        );
      const files = projectJsonVariant(
        type,
        { ...native, contentBody: withoutDerivedMediaFields(body) },
        context,
        {},
      );
      if (context.media) files.companions[`.${context.media.fileName}`] = context.media.bytes;
      return files;
    },
    fromSource(files: SourceFiles): DeployPayload {
      const binaries = Object.entries(files.companions);
      if (binaries.length > 1)
        throw new CmsError(
          'UNKNOWN_SETTING',
          `${type}:${files.document.apiName} has more than one file: ${binaries
            .map(([suffix]) => `${files.document.apiName}.${type}${suffix}`)
            .join(', ')}`,
        );
      const payload = jsonPayloadFromSource({ ...files, companions: {} }, {});
      if (binaries.length === 0) {
        if (isFileSource(payload.contentBody))
          throw new CmsError(
            'MEDIA_FILE_MISSING',
            `${type}:${files.document.apiName} has no file ${files.document.apiName}.${type}.<file name> next to its JSON`,
          );
        return payload;
      }
      const [[suffix, content]] = binaries;
      const media = payload.contentBody[MEDIA_FIELD];
      const mimeType =
        isPlainObject(media) && isPlainObject(media.source) ? media.source.mimeType : undefined;
      return {
        ...payload,
        file: {
          fileName: suffix.slice(1),
          bytes: typeof content === 'string' ? Buffer.from(content, 'utf8') : content,
          ...(typeof mimeType === 'string' ? { mimeType } : {}),
        },
      };
    },
    references: (payload) => logicalReferences(payload.contentBody),
  };
}

/** Image (`sfdc_cms__image`). */
export const imageHandler = mediaHandler('image', 'sfdc_cms__image');
/** Document (`sfdc_cms__document`). */
export const documentHandler = mediaHandler('document', 'sfdc_cms__document');
/** Audio (`sfdc_cms__audio`). */
export const audioHandler = mediaHandler('audio', 'sfdc_cms__audio');
