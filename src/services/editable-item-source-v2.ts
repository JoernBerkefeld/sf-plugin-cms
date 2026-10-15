import path from 'node:path';
import { readdir } from 'node:fs/promises';
import {
  assertSourceDefinition,
  serializeSourceDefinition,
  SOURCE_EMAIL_PROFILES,
  type SourceDefinition,
} from '../contracts/source-definition.js';
import type { JsonValue } from '../contracts/capability-registry.js';
import { assertEditableDirectoryPath } from './editable-raw-html-export.js';
import { readStableRegularFile } from './import-workspace.js';
import { strictSourceJson } from './source-definition-import.js';
import { reassembleEditableItemSource } from './editable-item-source.js';

type ComponentRole = 'rawHtml' | 'textContent';
export type EditableItemDefinitionV2 = Omit<SourceDefinition, 'contractVersion' | 'companions'> & {
  contractVersion: '2.0.0';
  companions: Array<{ role: ComponentRole; path: string }>;
};
export type EditableItemProjectionV2 = {
  definition: EditableItemDefinitionV2;
  definitionName: string;
  definitionBytes: Buffer;
  companions: Array<{ role: ComponentRole; path: string; bytes: Buffer }>;
};

function stem(definition: EditableItemDefinitionV2): string {
  const profile = SOURCE_EMAIL_PROFILES.find(
    (entry) => entry.contentType === definition.contentType,
  );
  if (!profile) throw new TypeError('Editable v2 supports only Email and Email Template');
  return `${definition.identity.apiName}.cms-${profile.token}`;
}

function legacy(definition: EditableItemDefinitionV2, textContent?: string): SourceDefinition {
  return {
    ...definition,
    contractVersion: '1.0.0',
    contentBody: {
      ...definition.contentBody,
      ...(textContent === undefined ? {} : { textContent }),
    },
    companions: { rawHtml: `${stem(definition)}.html` },
  };
}

/**
 * Validate the v2 role/path schema without weakening the original v1 contract.
 * @param {unknown} value - Candidate portable definition.
 */
export function assertEditableItemDefinitionV2(
  value: unknown,
): asserts value is EditableItemDefinitionV2 {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new TypeError('Editable v2 definition must be an object');
  const candidate = value as EditableItemDefinitionV2;
  if (candidate.contractVersion !== '2.0.0' || !Array.isArray(candidate.companions))
    throw new TypeError('Unsupported editable v2 contract/version or companions');
  // Validate all unchanged fields through v1 before using identity or body values.
  assertSourceDefinition({
    ...candidate,
    contractVersion: '1.0.0',
    companions: {
      rawHtml: `${candidate.identity?.apiName}.cms-${
        candidate.contentType === 'sfdc_cms__emailTemplate' ? 'email-template' : 'email'
      }.html`,
    },
  });
  const base = stem(candidate);
  if (Object.hasOwn(candidate.contentBody, 'textContent'))
    throw new TypeError('Editable v2 textContent must not retain an embedded copy');
  const roles = new Set<string>();
  for (const companion of candidate.companions) {
    if (
      companion === null ||
      typeof companion !== 'object' ||
      Array.isArray(companion) ||
      Object.keys(companion).toSorted().join(',') !== 'path,role' ||
      !['rawHtml', 'textContent'].includes(companion.role) ||
      roles.has(companion.role)
    )
      throw new TypeError('Invalid or duplicate editable v2 companion role');
    roles.add(companion.role);
    const extension = companion.role === 'rawHtml' ? 'html' : 'txt';
    if (companion.path !== `${base}.${companion.role}.${extension}`)
      throw new TypeError('Editable v2 companion must use its exact same-stem role/path');
  }
  if (!roles.has('rawHtml')) throw new TypeError('Editable v2 rawHtml companion is required');
}

/**
 * Extract literal HTML and optional native textContent into authoritative companions.
 * @param {SourceDefinition} definition - Existing validated portable v1 Email/Template metadata.
 * @param {string} literalHtml - Already decoded HTML; no GET decoding is performed here.
 * @returns {EditableItemProjectionV2} Deterministic JSON and companion bytes, ready for a caller to write.
 */
export function extractEditableItemSourceV2(
  definition: SourceDefinition,
  literalHtml: string,
): EditableItemProjectionV2 {
  reassembleEditableItemSource(definition, literalHtml);
  const candidate: EditableItemDefinitionV2 = {
    ...structuredClone(definition),
    contractVersion: '2.0.0',
    companions: [],
  };
  const base = stem(candidate);
  const companions: EditableItemProjectionV2['companions'] = [
    { role: 'rawHtml', path: `${base}.rawHtml.html`, bytes: Buffer.from(literalHtml, 'utf8') },
  ];
  const textContent = candidate.contentBody.textContent;
  if (typeof textContent === 'string') {
    companions.push({
      role: 'textContent',
      path: `${base}.textContent.txt`,
      bytes: Buffer.from(textContent, 'utf8'),
    });
    delete candidate.contentBody.textContent;
  }
  candidate.companions = companions.map(({ role, path: file }) => ({ role, path: file }));
  reassembleEditableItemSourceV2(
    candidate,
    new Map(companions.map((companion) => [companion.path, companion.bytes])),
  );
  // Reuse the existing recursive canonical serializer without changing its admission contract.
  const canonical = JSON.parse(serializeSourceDefinition(legacy(candidate))) as Record<
    string,
    unknown
  >;
  canonical.contractVersion = candidate.contractVersion;
  canonical.companions = candidate.companions;
  return {
    definition: candidate,
    definitionName: `${base}.json`,
    definitionBytes: Buffer.from(`${JSON.stringify(canonical, undefined, 2)}\n`, 'utf8'),
    companions,
  };
}

/**
 * Reassemble exactly the declared v2 components, preserving literal entity spellings.
 * @param {unknown} value - Portable v2 definition.
 * @param {ReadonlyMap<string, Uint8Array>} files - Exact companion paths and edited bytes.
 * @returns {Record<string, JsonValue>} Detached native content body; no destination is selected.
 */
export function reassembleEditableItemSourceV2(
  value: unknown,
  files: ReadonlyMap<string, Uint8Array>,
): Record<string, JsonValue> {
  assertEditableItemDefinitionV2(value);
  if (files.size !== value.companions.length)
    throw new TypeError('Editable v2 requires exactly the declared companions');
  const text: Partial<Record<ComponentRole, string>> = {};
  for (const companion of value.companions) {
    const bytes = files.get(companion.path);
    if (!bytes) throw new TypeError(`Editable v2 companion is missing: ${companion.path}`);
    const literal = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    if (literal.startsWith('\uFEFF'))
      throw new TypeError('Editable v2 companion must not contain a BOM');
    text[companion.role] = literal;
  }
  return reassembleEditableItemSource(legacy(value, text.textContent), text.rawHtml!);
}

async function readExact(directory: string, name: string): Promise<Buffer> {
  const entries = await readdir(directory);
  const matches = entries.filter((entry) => entry.toLowerCase() === name.toLowerCase());
  if (matches.length !== 1 || matches[0] !== name)
    throw new TypeError(`Editable v2 file is missing or case-aliased: ${name}`);
  return readStableRegularFile(path.join(directory, name), 'Editable v2 file');
}

/**
 * Load an explicitly selected v2 JSON and its declared same-directory companions.
 * @param {string} definitionFile - Exact item JSON filename, not a source directory or baseline.
 * @returns {Promise<object>} Definition, resolved file paths and reconstructed native body.
 */
export async function loadEditableItemSourceV2(definitionFile: string): Promise<{
  definitionPath: string;
  definition: EditableItemDefinitionV2;
  companionPaths: string[];
  contentBody: Record<string, JsonValue>;
}> {
  if (!definitionFile.trim()) throw new TypeError('Editable v2 definition path must be nonempty');
  const directory = path.resolve(path.dirname(definitionFile));
  await assertEditableDirectoryPath(directory, false);
  const definitionName = path.basename(definitionFile);
  const definitionBytes = await readExact(directory, definitionName);
  const definition = strictSourceJson(definitionBytes, 'Editable v2 JSON');
  assertEditableItemDefinitionV2(definition);
  if (definitionName !== `${stem(definition)}.json`)
    throw new TypeError('Editable v2 definition must use its exact same-stem JSON filename');
  const files = new Map<string, Buffer>();
  for (const companion of definition.companions)
    files.set(companion.path, await readExact(directory, companion.path));
  const contentBody = reassembleEditableItemSourceV2(definition, files);
  await assertEditableDirectoryPath(directory, false);
  for (const [name, bytes] of [[definitionName, definitionBytes], ...files] as const) {
    const current = await readExact(directory, name);
    if (!current.equals(bytes)) throw new TypeError('Editable v2 files changed during loading');
  }
  return {
    definitionPath: path.join(directory, definitionName),
    definition: structuredClone(definition),
    companionPaths: definition.companions.map(({ path: name }) => path.join(directory, name)),
    contentBody,
  };
}
