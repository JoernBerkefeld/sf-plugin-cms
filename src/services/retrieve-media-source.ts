import type { Connection } from '@salesforce/core';
import { randomUUID } from 'node:crypto';
import { lstat, mkdtemp, readFile, realpath, rmdir, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { sourcePathSegment } from '../contracts/source-definition.js';
import { downloadExperimentalCmsMedia } from '../transport/experimental-media.js';
import type { JsonRequestOptions } from '../transport/json-request.js';
import { extractEditableMediaSource } from './editable-media-source.js';
import { getContent, getVariant, getWorkspace } from './read.js';
import {
  enumerateNativeFamily,
  enumerateNativeSiblings,
  type NativeInventoryRow,
} from './retrieve-native-inventory.js';
import { requiredContentIdentifier, requiredVariantIdentifier } from './variant-identity.js';

export type EditableMediaProjection = ReturnType<typeof extractEditableMediaSource>;
export type AcquireEditableMediaSourceInput = {
  readonly workspaceId: string;
  readonly apiName: string;
  readonly language: string;
  readonly contentType: 'sfdc_cms__image' | 'sfdc_cms__document' | 'sfdc_cms__audio';
  /** Explicit URL-only mode does not attempt a binary download. */
  readonly urlOnly?: boolean;
};
export type AcquiredEditableMediaSource = {
  readonly directory: string;
  readonly projection: EditableMediaProjection;
  readonly evidence: { readonly variantId: string; readonly contentId: string };
};
type MediaConnection = Pick<Connection, 'request' | 'getApiVersion'> &
  Partial<Pick<Connection, 'accessToken' | 'instanceUrl'>>;
type RecordValue = Record<string, unknown>;
function record(value: unknown): RecordValue {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new TypeError('Expected native media object');
  return value as RecordValue;
}
function typeOf(value: RecordValue): unknown {
  return record(value.contentType).fullyQualifiedName;
}
function exactFields(value: RecordValue, allowed: string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key)))
    throw new TypeError('Unsupported native media authoring/envelope fields');
}
const readFields = [
  'apiName',
  'contentBody',
  'contentFqn',
  'contentKey',
  'contentSpace',
  'contentType',
  'createdBy',
  'createdDate',
  'externalId',
  'folder',
  'isPublished',
  'language',
  'lastModifiedBy',
  'lastModifiedDate',
  'managedContentId',
  'managedContentVariantId',
  'managedContentVersionId',
  'status',
  'title',
  'urlName',
  'source',
];
function bind(detail: RecordValue, row: NativeInventoryRow): void {
  if (
    requiredVariantIdentifier(detail) !== row.Id ||
    requiredContentIdentifier(detail) !== row.ManagedContentId ||
    record(detail.contentSpace).id !== row.ManagedContent.AuthoredManagedContentSpaceId ||
    typeOf(detail) !== row.ContentTypeFullyQualifiedName ||
    detail.apiName !== row.ManagedContent.ApiName ||
    detail.language !== row.Language ||
    detail.title !== row.Name ||
    (detail.urlName ?? null) !== row.UrlName ||
    record(detail.status).status !== row.ManagedContentVariantStatus ||
    detail.isPublished !== row.IsPublished ||
    detail.contentKey !== row.ManagedContentKey
  )
    throw new TypeError('Native media identity/scope/metadata disagreement');
}

/**
 * Download to one run-owned temporary file; cleanup never traverses a tree.
 * @param {MediaConnection} connection - Existing authenticated source context.
 * @param {URL} url - Bound native media URL.
 * @param {RecordValue} source - Validated native source evidence.
 * @param {string} contentType - Selected media content type.
 * @returns {Promise<Buffer>} Detached exact downloaded bytes.
 */
async function download(
  connection: MediaConnection,
  url: URL,
  source: RecordValue,
  contentType: AcquireEditableMediaSourceInput['contentType'],
): Promise<Buffer> {
  if (!connection.accessToken || !connection.instanceUrl)
    throw new TypeError('Native media requires existing authenticated download context');
  const root = await mkdtemp(path.join(os.tmpdir(), 'cms-acquire-media-'));
  const resolvedRoot = await realpath(root);
  const marker = randomUUID();
  const markerFile = path.join(root, 'owner');
  const outputFile = path.join(root, 'media');
  const registered = new Set([markerFile, outputFile]);
  await writeFile(markerFile, marker, { flag: 'wx' });
  const cleanup = async (): Promise<void> => {
    const rootInfo = await lstat(root);
    if (
      rootInfo.isSymbolicLink() ||
      (await realpath(root)) !== resolvedRoot ||
      (await readFile(markerFile, 'utf8')) !== marker
    )
      throw new TypeError('Media temporary ownership changed; refusing cleanup');
    for (const target of [outputFile, markerFile]) {
      if (
        !registered.has(target) ||
        path.dirname(target) !== root ||
        !path.relative(root, target) ||
        path.relative(root, target).startsWith('..')
      )
        throw new TypeError('Unregistered media temporary target');
      try {
        const info = await lstat(target);
        if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1)
          throw new TypeError('Unsafe media temporary target');
        await unlink(target);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    await rmdir(root);
  };
  try {
    await downloadExperimentalCmsMedia(url, {
      accessToken: connection.accessToken,
      instanceUrl: connection.instanceUrl,
      contentType,
      expectedMd5: url.searchParams.get('fileHash') ?? '',
      expectedMimeType: source.mimeType as string,
      expectedSize: source.size as number,
      outputFile,
    });
    return await readFile(outputFile);
  } finally {
    await cleanup();
  }
}

/**
 * Acquire one exact root-level native Image/Document/Audio with complete sibling evidence.
 * Unknown authoring fields are rejected before download; no org mutations occur.
 * @param {MediaConnection} connection - Existing source connection including binary auth context.
 * @param {AcquireEditableMediaSourceInput} input - Explicit native scope and representation choice.
 * @param {JsonRequestOptions} requestOptions - Read request metadata/cancellation.
 * @returns {Promise<AcquiredEditableMediaSource>} Portable files and detached source evidence.
 */
export async function acquireEditableMediaSource(
  connection: MediaConnection,
  input: AcquireEditableMediaSourceInput,
  requestOptions: JsonRequestOptions = {},
): Promise<AcquiredEditableMediaSource> {
  const selected = structuredClone(input);
  const options = { ...requestOptions };
  for (const value of [selected.apiName, selected.language]) sourcePathSegment(value);
  if (
    !['sfdc_cms__image', 'sfdc_cms__document', 'sfdc_cms__audio'].includes(selected.contentType) ||
    (selected.urlOnly !== undefined && typeof selected.urlOnly !== 'boolean')
  )
    throw new TypeError('Unsupported media acquisition selection');
  const workspace = await getWorkspace(connection, selected.workspaceId, options);
  if (workspace.id !== selected.workspaceId) throw new TypeError('Workspace identity disagreement');
  sourcePathSegment(workspace.apiName);
  const workspaceApiName = workspace.apiName as string;
  const family = await enumerateNativeFamily(
    connection,
    selected.workspaceId,
    [selected.contentType],
    options,
  );
  const matches = family.records.filter(
    (row) => row.ManagedContent.ApiName === selected.apiName && row.Language === selected.language,
  );
  if (matches.length !== 1)
    throw new TypeError('Media selection requires exactly one native variant');
  const row = matches[0];
  const audio = selected.contentType === 'sfdc_cms__audio';
  if (audio && (workspace.defaultLanguage !== selected.language || !row.IsPrimary))
    throw new TypeError('Audio requires workspace-default language and a primary native variant');
  const mediaTypes = {
    sfdc_cms__audio: 'Audio',
    sfdc_cms__image: 'Image',
    sfdc_cms__document: 'Document',
  };
  const mediaType = mediaTypes[selected.contentType];
  const raw = await getVariant(connection, row.Id, options);
  bind(raw, row);
  const parent = await getContent(connection, row.ManagedContentId, {}, options);
  bind(parent, row);
  exactFields(raw, readFields);
  exactFields(parent, [...readFields, 'contentVersion', 'variantVersion']);
  exactFields(record(raw.contentType), ['fullyQualifiedName']);
  exactFields(record(parent.contentType), ['fullyQualifiedName', 'name']);
  for (const key of [
    'apiName',
    'contentBody',
    'contentFqn',
    'contentKey',
    'externalId',
    'isPublished',
    'language',
    'managedContentId',
    'managedContentVariantId',
    'managedContentVersionId',
    'status',
    'title',
    'urlName',
    'source',
  ])
    if (!isDeepStrictEqual(raw[key], parent[key]))
      throw new TypeError(`Media parent ${key} disagreement`);
  if (
    (raw.externalId !== undefined && raw.externalId !== null) ||
    (raw.source !== undefined && raw.source !== 'User')
  )
    throw new TypeError('Unsupported external media provenance');
  for (const detail of [raw, parent]) {
    exactFields(record(detail.contentSpace), ['id', 'resourceUrl']);
    exactFields(record(detail.status), ['label', 'status']);
    if (detail.folder !== null) exactFields(record(detail.folder), ['id', 'resourceUrl']);
    if (
      detail.folder !== null &&
      (!workspace.rootFolderId ||
        workspace.rootFolderId === workspace.id ||
        record(detail.folder).id !== workspace.rootFolderId)
    )
      throw new TypeError('Media folder ancestry is unknown or non-root');
  }
  if ((raw.folder === null) !== (parent.folder === null))
    throw new TypeError('Media parent placement disagreement');
  const siblings = await enumerateNativeSiblings(
    connection,
    selected.workspaceId,
    row.ManagedContentId,
    options,
  );
  if (siblings.records.length !== 1 || !isDeepStrictEqual(siblings.records[0], row))
    throw new TypeError('Complete single exact native media sibling evidence is required');
  const sibling = await getVariant(connection, row.Id, options);
  if (!isDeepStrictEqual(sibling, raw))
    throw new TypeError('Native media changed during acquisition');
  const metadata = {
    identity: {
      family: 'cms' as const,
      type: mediaType,
      apiName: selected.apiName,
      context: { workspaceApiName },
    },
    contentType: selected.contentType,
    language: selected.language,
    folderPath: [],
    ...(raw.title === undefined ? {} : { title: raw.title as string }),
    ...(raw.urlName === undefined ? {} : { urlName: raw.urlName as string }),
  };
  // Validate every authoring field before interpreting the download evidence.
  const urlProjection = extractEditableMediaSource(metadata, raw.contentBody);
  let projection = urlProjection;
  if (!selected.urlOnly) {
    const media = record(record(raw.contentBody)['sfdc_cms:media']);
    const address = media.url as string;
    const url = new URL(address, connection.instanceUrl ?? 'https://local.invalid');
    const native =
      url.pathname.startsWith('/cms/media/') &&
      (address.startsWith('/') ||
        (connection.instanceUrl && url.origin === new URL(connection.instanceUrl).origin));
    // External URLs stay URL-only; no fetching or fabricated binary source.
    if (native) {
      if (
        url.pathname !== `/cms/media/${String(raw.contentKey)}` ||
        (parent.variantVersion !== undefined &&
          url.searchParams.get('version') !== parent.variantVersion)
      )
        throw new TypeError('Native media URL identity/version disagreement');
      if (!connection.instanceUrl)
        throw new TypeError('Native media requires authenticated instance URL');
      const bytes = await download(
        connection,
        new URL(address, connection.instanceUrl),
        record(media.source),
        selected.contentType,
      );
      projection = extractEditableMediaSource(metadata, raw.contentBody, bytes);
    }
  }
  if (audio) {
    const finalWorkspace = await getWorkspace(connection, selected.workspaceId, options);
    const finalVariant = await getVariant(connection, row.Id, options);
    const finalParent = await getContent(connection, row.ManagedContentId, {}, options);
    const finalFamily = await enumerateNativeFamily(
      connection,
      selected.workspaceId,
      [selected.contentType],
      options,
    );
    const finalSiblings = await enumerateNativeSiblings(
      connection,
      selected.workspaceId,
      row.ManagedContentId,
      options,
    );
    if (
      !isDeepStrictEqual(finalSiblings.records, siblings.records) ||
      !isDeepStrictEqual(finalWorkspace, workspace) ||
      !isDeepStrictEqual(finalVariant, raw) ||
      !isDeepStrictEqual(finalParent, parent) ||
      !isDeepStrictEqual(finalFamily.records, family.records)
    )
      throw new TypeError('Native Audio changed during acquisition');
  }
  return {
    directory: `cms/${workspaceApiName}/${mediaType.toLowerCase()}`,
    projection,
    evidence: { variantId: row.Id, contentId: row.ManagedContentId },
  };
}
