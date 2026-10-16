import { createHash } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { assertPortablePayload } from '../contracts/capability-registry.js';
import { sourcePathSegment, type SourceDefinition } from '../contracts/source-definition.js';
import { assertEditableDirectoryPath } from './editable-raw-html-export.js';
import { readStableRegularFile } from './import-workspace.js';
import { strictSourceJson } from './source-definition-import.js';

export type EditableMediaMetadata = Pick<
  SourceDefinition,
  'identity' | 'contentType' | 'language' | 'title' | 'urlName' | 'folderPath'
>;
export type EditableMediaDefinition = EditableMediaMetadata & {
  contract: 'sf-cms-media-source';
  contractVersion: '1.0.0';
  media:
    | { representation: 'binary'; mimeType: string; companion: { role: 'media'; path: string } }
    | { representation: 'url-only'; address: string };
};
export type ReassembledMediaSource =
  | {
      representation: 'binary';
      contentBody: { 'sfdc_cms:media': { source: { type: 'file' } } };
      binary: { fileName: string; mimeType: string; bytes: Buffer };
    }
  | { representation: 'url-only'; address: string };

const extensions: Record<string, string> = {
  'image/gif': 'gif',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'text/plain': 'txt',
};

function fields(
  value: unknown,
  allowed: string[],
  required = allowed,
): asserts value is Record<string, unknown> {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !allowed.includes(key)) ||
    required.some((key) => !Object.hasOwn(value, key))
  )
    throw new TypeError('Unsupported media source fields/components');
}

function stem(metadata: EditableMediaMetadata): string {
  return `${metadata.identity.apiName}.cms-${metadata.contentType === 'sfdc_cms__image' ? 'image' : 'document'}`;
}

function mediaExtension(metadata: EditableMediaMetadata, mimeType: unknown): string {
  if (
    typeof mimeType !== 'string' ||
    !Object.hasOwn(extensions, mimeType) ||
    (metadata.contentType === 'sfdc_cms__document') !== (mimeType === 'text/plain')
  )
    throw new TypeError('Unsupported media MIME type for Image/Document');
  return extensions[mimeType];
}

function assertAddress(address: unknown): asserts address is string {
  if (
    typeof address !== 'string' ||
    !address.trim() ||
    [...address].some((character) => character.codePointAt(0)! <= 32)
  )
    throw new TypeError('Media URL-only address must be a nonempty URL');
  const parsed = new URL(address, 'https://local.invalid');
  if (
    !['https:', 'http:'].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    (!address.startsWith('/') && !/^https?:\/\//u.test(address)) ||
    address.startsWith('//')
  )
    throw new TypeError('Unsupported media URL-only address');
}

/**
 * Validate the standalone media contract without using Email validators or source locators.
 * @param {unknown} value - Local media definition.
 */
export function assertEditableMediaDefinition(
  value: unknown,
): asserts value is EditableMediaDefinition {
  fields(
    value,
    [
      'contract',
      'contractVersion',
      'identity',
      'contentType',
      'language',
      'title',
      'urlName',
      'folderPath',
      'media',
    ],
    ['contract', 'contractVersion', 'identity', 'contentType', 'language', 'folderPath', 'media'],
  );
  if (value.contract !== 'sf-cms-media-source' || value.contractVersion !== '1.0.0')
    throw new TypeError('Unsupported media source contract/version');
  fields(value.identity, ['family', 'type', 'apiName', 'context']);
  fields(value.identity.context, ['workspaceApiName']);
  if (
    value.identity.family !== 'cms' ||
    !(
      (value.contentType === 'sfdc_cms__image' && value.identity.type === 'Image') ||
      (value.contentType === 'sfdc_cms__document' && value.identity.type === 'Document')
    )
  )
    throw new TypeError('Unsupported media type/contentType');
  sourcePathSegment(value.identity.apiName);
  sourcePathSegment(value.identity.context.workspaceApiName);
  sourcePathSegment(value.language);
  if (!Array.isArray(value.folderPath)) throw new TypeError('Media folderPath must be an array');
  for (const segment of value.folderPath) sourcePathSegment(segment);
  for (const key of ['title', 'urlName'])
    if (Object.hasOwn(value, key) && (typeof value[key] !== 'string' || !value[key]))
      throw new TypeError(`Invalid media ${key}`);
  const { media, ...metadata } = value;
  assertPortablePayload(metadata);
  fields(media, ['representation', 'mimeType', 'companion', 'address'], ['representation']);
  if (media.representation === 'url-only') {
    fields(media, ['representation', 'address']);
    assertAddress(media.address);
  } else if (media.representation === 'binary') {
    fields(media, ['representation', 'mimeType', 'companion']);
    fields(media.companion, ['role', 'path']);
    const definition = value as unknown as EditableMediaDefinition;
    const extension = mediaExtension(definition, media.mimeType);
    if (
      media.companion.role !== 'media' ||
      media.companion.path !== `${stem(definition)}.media.${extension}`
    )
      throw new TypeError('Media companion must use exact same-stem role/path');
  } else throw new TypeError('Unsupported media representation');
}

function validateBytes(bytes: Buffer, mimeType: string): void {
  if (bytes.length === 0 || bytes.length > 10 * 1024 * 1024)
    throw new TypeError('Media bytes must be nonempty and at most 10 MiB');
  const signatures: Record<string, number[]> = {
    'image/png': [137, 80, 78, 71, 13, 10, 26, 10],
    'image/jpeg': [255, 216, 255],
    'image/gif': [71, 73, 70, 56],
    'image/webp': [82, 73, 70, 70],
  };
  if (mimeType === 'text/plain') {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } else if (
    !signatures[mimeType]?.every((byte, index) => bytes[index] === byte) ||
    (mimeType === 'image/webp' && bytes.subarray(8, 12).toString('ascii') !== 'WEBP')
  )
    throw new TypeError('Media signature does not match MIME type');
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => canonical(entry));
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .toSorted(([a], [b]) => a.localeCompare(b, 'en'))
      .map(([key, child]) => [key, canonical(child)]),
  );
}

/**
 * Extract evidenced native file media; omitted bytes explicitly produce URL-only source.
 * @param {EditableMediaMetadata} metadata - Portable identity and editable item metadata only.
 * @param {unknown} contentBody - Native body with exactly sfdc_cms:media/source and URL evidence.
 * @param {Uint8Array} [bytes] - Retrieved bytes, verified against native size and URL MD5.
 * @returns {object} Deterministic definition and zero or one authoritative binary companion.
 */
export function extractEditableMediaSource(
  metadata: EditableMediaMetadata,
  contentBody: unknown,
  bytes?: Uint8Array,
): {
  definition: EditableMediaDefinition;
  definitionName: string;
  definitionBytes: Buffer;
  companions: Array<{ role: 'media'; path: string; bytes: Buffer }>;
} {
  fields(
    metadata,
    ['identity', 'contentType', 'language', 'title', 'urlName', 'folderPath'],
    ['identity', 'contentType', 'language', 'folderPath'],
  );
  fields(contentBody, ['sfdc_cms:media']);
  const native = contentBody['sfdc_cms:media'];
  fields(native, ['source', 'url']);
  fields(
    native.source,
    ['type', 'ref', 'size', 'fileSize', 'mimeType'],
    ['type', 'size', 'mimeType'],
  );
  if (Object.hasOwn(native.source, 'fileSize') && native.source.fileSize !== native.source.size)
    throw new TypeError('Native media fileSize/size disagreement');
  if (
    native.source.type !== 'file' ||
    !Number.isSafeInteger(native.source.size) ||
    (native.source.size as number) < 0 ||
    (Object.hasOwn(native.source, 'ref') &&
      (typeof native.source.ref !== 'string' || !native.source.ref))
  )
    throw new TypeError('Unsupported native media file evidence');
  assertAddress(native.url);
  const definition: EditableMediaDefinition = {
    ...structuredClone(metadata),
    contract: 'sf-cms-media-source',
    contractVersion: '1.0.0',
    media: { representation: 'url-only', address: native.url },
  };
  assertEditableMediaDefinition(definition);
  const extension = mediaExtension(metadata, native.source.mimeType);
  const companions: Array<{ role: 'media'; path: string; bytes: Buffer }> = [];
  if (bytes !== undefined) {
    const binary = Buffer.from(bytes);
    validateBytes(binary, native.source.mimeType as string);
    const url = new URL(native.url, 'https://local.invalid');
    const filename = url.searchParams.get('fileName') ?? '';
    const allowedExtensions = extension === 'jpg' ? ['jpg', 'jpeg'] : [extension];
    if (
      !/^\/cms\/media\/[^/]+$/u.test(url.pathname) ||
      [...url.searchParams.keys()].toSorted().join(',') !== 'fileHash,fileName,version' ||
      !url.searchParams.get('version') ||
      /[^\u0020-\u007E]|[/\\]/u.test(filename) ||
      !allowedExtensions.includes(filename.split('.').at(-1)!) ||
      binary.length !== native.source.size ||
      createHash('md5').update(binary).digest('hex') !==
        url.searchParams.get('fileHash')?.toLowerCase()
    )
      throw new TypeError('Media bytes/filename/size/MD5 do not match native evidence');
    const file = `${stem(metadata)}.media.${extension}`;
    definition.media = {
      representation: 'binary',
      mimeType: native.source.mimeType as string,
      companion: { role: 'media', path: file },
    };
    companions.push({ role: 'media', path: file, bytes: binary });
  }
  reassembleEditableMediaSource(
    definition,
    new Map(companions.map((entry) => [entry.path, entry.bytes])),
  );
  return {
    definition,
    definitionName: `${stem(metadata)}.json`,
    definitionBytes: Buffer.from(`${JSON.stringify(canonical(definition), undefined, 2)}\n`),
    companions,
  };
}

/**
 * Reassemble edited file bytes separately from native input, or return an explicit URL-only record.
 * @param {unknown} value - Portable media definition.
 * @param {ReadonlyMap<string, Uint8Array>} files - Exactly the declared companion bytes.
 * @returns {ReassembledMediaSource} Local file input plus bytes, never a destination or transport.
 */
export function reassembleEditableMediaSource(
  value: unknown,
  files: ReadonlyMap<string, Uint8Array>,
): ReassembledMediaSource {
  assertEditableMediaDefinition(value);
  const { media } = value;
  if (files.size !== (media.representation === 'binary' ? 1 : 0))
    throw new TypeError('Media source requires exactly its declared companions');
  if (media.representation === 'url-only')
    return { representation: 'url-only', address: media.address };
  const selected = files.get(media.companion.path);
  if (!selected) throw new TypeError(`Media companion is missing: ${media.companion.path}`);
  const bytes = Buffer.from(selected);
  validateBytes(bytes, media.mimeType);
  return {
    representation: 'binary',
    contentBody: { 'sfdc_cms:media': { source: { type: 'file' } } },
    binary: { fileName: media.companion.path, mimeType: media.mimeType, bytes },
  };
}

async function readExact(directory: string, name: string): Promise<Buffer> {
  const entries = await readdir(directory);
  const matches = entries.filter((entry) => entry.toLowerCase() === name.toLowerCase());
  if (matches.length !== 1 || matches[0] !== name)
    throw new TypeError(`Media source file is missing, ambiguous or case-aliased: ${name}`);
  return readStableRegularFile(path.join(directory, name), 'Media source file');
}

/**
 * Load one selected media JSON and its exact same-directory binary without a baseline.
 * @param {string} definitionFile - Exact local item JSON path.
 * @returns {Promise<object>} Detached definition, paths, and reconstructed local source.
 */
export async function loadEditableMediaSource(definitionFile: string): Promise<{
  definitionPath: string;
  definition: EditableMediaDefinition;
  companionPaths: string[];
  source: ReassembledMediaSource;
}> {
  if (!definitionFile.trim()) throw new TypeError('Media definition path must be nonempty');
  const directory = path.resolve(path.dirname(definitionFile));
  await assertEditableDirectoryPath(directory, false);
  const name = path.basename(definitionFile);
  const json = await readExact(directory, name);
  const definition = strictSourceJson(json, 'Media source JSON');
  assertEditableMediaDefinition(definition);
  if (name !== `${stem(definition)}.json`)
    throw new TypeError('Media definition must use exact same-stem filename');
  const files = new Map<string, Buffer>();
  if (definition.media.representation === 'binary') {
    const file = definition.media.companion.path;
    files.set(file, await readExact(directory, file));
  }
  const source = reassembleEditableMediaSource(definition, files);
  await assertEditableDirectoryPath(directory, false);
  for (const [file, bytes] of [[name, json], ...files] as const) {
    const current = await readExact(directory, file);
    if (!current.equals(bytes)) throw new TypeError('Media source changed during loading');
  }
  return {
    definitionPath: path.join(directory, name),
    definition: structuredClone(definition),
    companionPaths: [...files.keys()].map((file) => path.join(directory, file)),
    source,
  };
}
