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
  if (metadata.contentType === 'sfdc_cms__audio') return `${metadata.identity.apiName}.cms-audio`;
  return `${metadata.identity.apiName}.cms-${metadata.contentType === 'sfdc_cms__image' ? 'image' : 'document'}`;
}

/**
 * Require an ASCII media type safe for later header serialization, without format admission policy.
 * @param {unknown} value - Declared or native media type, without parameters.
 */
export function assertMediaMimeType(value: unknown): asserts value is string {
  if (
    typeof value !== 'string' ||
    !/^[A-Za-z0-9!#$%&'*+.^_`|~-]+\/[A-Za-z0-9!#$%&'*+.^_`|~-]+$/u.test(value)
  )
    throw new TypeError('Media MIME type must be a safe ASCII type/subtype without parameters');
}

function mediaExtension(metadata: EditableMediaMetadata, mimeType: unknown, filename = ''): string {
  assertMediaMimeType(mimeType);
  if (metadata.contentType === 'sfdc_cms__document') {
    if (mimeType !== 'text/plain') throw new TypeError('Unsupported Document MIME type');
    return 'txt';
  }
  if (metadata.contentType === 'sfdc_cms__audio' && mimeType === 'audio/x-wav') return 'wav';
  // Keep existing canonical names; unfamiliar types use filename evidence, never MIME-derived paths.
  if (Object.hasOwn(extensions, mimeType) && mimeType !== 'text/plain') return extensions[mimeType];
  const suffix = path.extname(filename).slice(1);
  return /^[A-Za-z0-9]+$/u.test(suffix) ? suffix : 'bin';
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
      (value.contentType === 'sfdc_cms__document' && value.identity.type === 'Document') ||
      (value.contentType === 'sfdc_cms__audio' && value.identity.type === 'Audio')
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
    assertMediaMimeType(media.mimeType);
    const prefix = `${stem(definition)}.media.`;
    const companion = media.companion.path;
    if (
      media.companion.role !== 'media' ||
      typeof companion !== 'string' ||
      !companion.startsWith(prefix) ||
      !/^[A-Za-z0-9]+$/u.test(companion.slice(prefix.length)) ||
      (definition.contentType === 'sfdc_cms__document' &&
        (media.mimeType !== 'text/plain' || companion !== `${prefix}txt`))
    )
      throw new TypeError('Media companion must use exact same-stem role/path');
  } else throw new TypeError('Unsupported media representation');
}

function validateBytes(bytes: Buffer, contentType: EditableMediaMetadata['contentType']): void {
  // A Buffer is already runtime-representable; Image format validity belongs to Salesforce.
  if (bytes.length === 0) throw new TypeError('Media bytes must be nonempty');
  if (contentType === 'sfdc_cms__document') {
    if (bytes.length > 10 * 1024 * 1024)
      throw new TypeError('Document bytes must be at most 10 MiB');
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  }
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
  const url = new URL(native.url, 'https://local.invalid');
  const filename = url.searchParams.get('fileName') ?? '';
  const extension = mediaExtension(metadata, native.source.mimeType, filename);
  const companions: Array<{ role: 'media'; path: string; bytes: Buffer }> = [];
  if (bytes !== undefined) {
    const binary = Buffer.from(bytes);
    validateBytes(binary, metadata.contentType);
    if (
      !/^\/cms\/media\/[^/]+$/u.test(url.pathname) ||
      [...url.searchParams.keys()].toSorted().join(',') !== 'fileHash,fileName,version' ||
      !url.searchParams.get('version') ||
      !filename ||
      filename === '.' ||
      filename === '..' ||
      /[^\u0020-\u007E]|[/\\]/u.test(filename) ||
      (metadata.contentType === 'sfdc_cms__document' && !filename.endsWith('.txt')) ||
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
  validateBytes(bytes, value.contentType);
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
