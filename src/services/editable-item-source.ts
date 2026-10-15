import { readdir } from 'node:fs/promises';
import path from 'node:path';
import {
  assertSourceDefinition,
  SOURCE_EMAIL_PROFILES,
  type SourceDefinition,
} from '../contracts/source-definition.js';
import type { JsonValue } from '../contracts/capability-registry.js';
import { assertEditableDirectoryPath } from './editable-raw-html-export.js';
import { readStableRegularFile } from './import-workspace.js';
import { strictSourceJson } from './source-definition-import.js';
import { assertSourceNativeHtml } from './source-definition.js';

export type EditableItemSource = {
  readonly definitionPath: string;
  readonly htmlPath: string;
  readonly definition: SourceDefinition;
  readonly contentBody: Record<string, JsonValue>;
};

/**
 * Reassemble a supported portable item with literal HTML, without baseline admission.
 * This validates the local format, not destination resolution or operation eligibility.
 * @param {unknown} value - Portable v1 definition.
 * @param {string} literalHtml - Edited UTF-8 companion text, never GET-decoded.
 * @returns {Record<string, JsonValue>} Detached native body with its HTML component restored.
 */
export function reassembleEditableItemSource(
  value: unknown,
  literalHtml: string,
): Record<string, JsonValue> {
  assertSourceDefinition(value);
  if (!SOURCE_EMAIL_PROFILES.some((profile) => profile.contentType === value.contentType))
    throw new TypeError('Editable item source supports only Email and Email Template');
  assertSourceNativeHtml(value.contentType, value.contentBody, literalHtml);
  return { ...structuredClone(value.contentBody), rawHtml: literalHtml };
}

async function exactFile(directory: string, name: string, label: string): Promise<string> {
  const names = await readdir(directory);
  const matches = names.filter((candidate) => candidate.toLowerCase() === name.toLowerCase());
  if (matches.length > 1 || (matches.length === 1 && matches[0] !== name))
    throw new TypeError(`${label} has an ambiguous or case-aliased filename: ${name}`);
  if (matches.length === 0) throw new TypeError(`${label} is missing: ${name}`);
  return path.join(directory, name);
}

/**
 * Load one authoritative Email/Template JSON and its exact same-stem HTML companion.
 * Unrelated project files are ignored; no export manifest or original hashes are needed.
 * @param {string} definitionFile - Explicit item JSON path.
 * @returns {Promise<EditableItemSource>} Portable metadata, resolved paths and reassembled body.
 */
export async function loadEditableItemSource(definitionFile: string): Promise<EditableItemSource> {
  if (!definitionFile.trim()) throw new TypeError('Editable definition path must be nonempty');
  await assertEditableDirectoryPath(path.dirname(definitionFile), false);
  const directory = path.resolve(path.dirname(definitionFile));
  const definitionPath = await exactFile(
    directory,
    path.basename(definitionFile),
    'Editable definition',
  );
  const definitionBytes = await readStableRegularFile(definitionPath, 'Editable definition');
  const candidate = strictSourceJson(definitionBytes, 'Editable definition JSON');
  // Diagnose path escapes before the stricter same-stem contract reports a token mismatch.
  if (candidate !== null && typeof candidate === 'object' && 'companions' in candidate) {
    const companions = candidate.companions;
    if (companions !== null && typeof companions === 'object' && 'rawHtml' in companions) {
      const reference = companions.rawHtml;
      if (typeof reference === 'string' && /[\\/:]|^\.{1,2}$/u.test(reference))
        throw new TypeError('Editable HTML companion must not escape its definition directory');
    }
  }
  assertSourceDefinition(candidate);
  const profile = SOURCE_EMAIL_PROFILES.find(
    (entry) => entry.contentType === candidate.contentType,
  );
  if (!profile) throw new TypeError('Editable item source supports only Email and Email Template');
  if (path.basename(definitionPath) !== `${candidate.identity.apiName}.cms-${profile.token}.json`)
    throw new TypeError('Editable definition must use the exact same-stem JSON filename');
  const htmlPath = await exactFile(
    directory,
    candidate.companions.rawHtml!,
    'Editable HTML companion',
  );
  const htmlBytes = await readStableRegularFile(htmlPath, 'Editable HTML companion');
  let literalHtml: string;
  try {
    literalHtml = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(htmlBytes);
  } catch (error) {
    throw new TypeError('Editable HTML companion must contain valid UTF-8', { cause: error });
  }
  const contentBody = reassembleEditableItemSource(candidate, literalHtml);
  await assertEditableDirectoryPath(directory, false);
  await exactFile(directory, path.basename(definitionPath), 'Editable definition');
  await exactFile(directory, path.basename(htmlPath), 'Editable HTML companion');
  for (const [file, bytes] of [
    [definitionPath, definitionBytes],
    [htmlPath, htmlBytes],
  ] as const) {
    const current = await readStableRegularFile(file, 'Editable item revalidation');
    if (!current.equals(bytes)) throw new TypeError('Editable item files changed during loading');
  }
  return { definitionPath, htmlPath, definition: structuredClone(candidate), contentBody };
}
