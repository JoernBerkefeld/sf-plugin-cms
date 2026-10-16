import path from 'node:path';
import {
  assertSourceDefinition,
  SOURCE_EMAIL_PROFILES,
  type SourceDefinition,
} from '../contracts/source-definition.js';
import type { JsonValue } from '../contracts/capability-registry.js';
import { assertEditableDirectoryPath } from './editable-raw-html-export.js';
import { loadEditableItemSource } from './editable-item-source.js';
import {
  assertEditableItemDefinitionV2,
  loadEditableItemSourceV2,
  type EditableItemDefinitionV2,
} from './editable-item-source-v2.js';
import { enumeratePackageFiles, readStableRegularFile } from './import-workspace.js';
import { strictSourceJson } from './source-definition-import.js';

export interface DeploySourceSelectionFlags {
  'definition-file'?: readonly string[];
  'source-dir'?: readonly string[];
  'content-type'?: readonly string[];
  metadata?: readonly string[];
}

export interface DeployLocalItem {
  definitionPath: string;
  companionPaths: string[];
  definition: SourceDefinition | EditableItemDefinitionV2;
  contentBody: Record<string, JsonValue>;
  /** Destination-relative identity; source workspace context remains in definition only. */
  targetIdentity: { contentType: string; apiName: string; language: string };
}

export interface DeployLocalSelection {
  mode: 'definition-file' | 'source-dir';
  items: DeployLocalItem[];
}

type Selector = { contentType: string; apiName?: string };

function values(input: readonly string[] | undefined): string[] | undefined {
  if (input === undefined) return undefined;
  if (
    !Array.isArray(input) ||
    input.length === 0 ||
    input.some((value) => typeof value !== 'string' || !value.trim())
  )
    throw new TypeError('Deploy source selectors must be nonempty arrays of nonempty strings');
  return [...new Set(input)];
}

function contentType(value: string): string {
  if (!SOURCE_EMAIL_PROFILES.some((profile) => profile.contentType === value))
    throw new TypeError('Deploy source selection requires a supported qualified content type');
  return value;
}

function metadataSelector(value: string): Selector {
  const colon = value.indexOf(':');
  if (colon === -1) return { contentType: contentType(value) };
  const apiName = value.slice(colon + 1);
  if (!apiName.trim()) throw new TypeError('Deploy metadata requires a nonempty exact API name');
  return { contentType: contentType(value.slice(0, colon)), apiName };
}

function matches(
  definition: SourceDefinition | EditableItemDefinitionV2,
  selector: Selector,
): boolean {
  return (
    definition.contentType === selector.contentType &&
    (selector.apiName === undefined || definition.identity.apiName === selector.apiName)
  );
}

async function readDefinition(file: string): Promise<SourceDefinition | EditableItemDefinitionV2> {
  // Preserve the caller's route spelling for the existing admission guard before resolution.
  await assertEditableDirectoryPath(path.dirname(file), false);
  const candidate = strictSourceJson(
    await readStableRegularFile(file, 'Deploy source definition'),
    'Deploy source definition JSON',
  );
  if (
    candidate !== null &&
    typeof candidate === 'object' &&
    'contractVersion' in candidate &&
    candidate.contractVersion === '2.0.0'
  ) {
    assertEditableItemDefinitionV2(candidate);
    return candidate;
  }
  assertSourceDefinition(candidate);
  return candidate;
}

/**
 * Select and reconstruct local Email/Template sources without destination or org access.
 * @param {DeploySourceSelectionFlags} flags - Explicit files or directories with optional directory filters.
 * @returns {Promise<DeployLocalSelection>} Deterministic admitted sources and destination-relative identities.
 */
export async function selectDeploySources(
  flags: DeploySourceSelectionFlags,
): Promise<DeployLocalSelection> {
  const files = values(flags['definition-file']);
  const directories = values(flags['source-dir']);
  const types = values(flags['content-type']);
  const metadata = values(flags.metadata);
  if (Number(files !== undefined) + Number(directories !== undefined) !== 1)
    throw new TypeError('Deploy requires exactly one source mode: definition-file or source-dir');
  if (types !== undefined && metadata !== undefined)
    throw new TypeError('Deploy content-type and metadata filters are exclusive');
  if (files !== undefined && (types !== undefined || metadata !== undefined))
    throw new TypeError('Deploy filters require source-dir mode');
  const selectors: Selector[] | undefined = metadata
    ? metadata.map((value) => metadataSelector(value))
    : types?.map((value) => ({ contentType: contentType(value) }));
  const candidates = new Set<string>();
  for (const file of files ?? []) {
    await assertEditableDirectoryPath(path.dirname(file), false);
    candidates.add(path.resolve(file));
  }
  for (const directory of directories ?? []) {
    await assertEditableDirectoryPath(directory, false);
    const root = path.resolve(directory);
    // Reuse the package's no-follow recursive traversal, never a permissive new walker.
    for (const relative of await enumeratePackageFiles(root, root)) {
      if (/\.cms-email(?:-template)?\.json$/u.test(relative))
        candidates.add(path.join(root, relative));
    }
  }
  const items: DeployLocalItem[] = [];
  const identities = new Set<string>();
  for (const file of [...candidates].toSorted()) {
    const definition = await readDefinition(file);
    if (selectors && !selectors.some((selector) => matches(definition, selector))) continue;
    const loaded =
      definition.contractVersion === '2.0.0'
        ? await loadEditableItemSourceV2(file)
        : await loadEditableItemSource(file);
    // Match the loader's final validated snapshot, not just the initial discovery read.
    if (selectors && !selectors.some((selector) => matches(loaded.definition, selector)))
      throw new TypeError('Deploy source selection changed during loading');
    const targetIdentity = {
      contentType: loaded.definition.contentType,
      apiName: loaded.definition.identity.apiName,
      language: loaded.definition.language,
    };
    const key = JSON.stringify(targetIdentity);
    if (identities.has(key))
      throw new TypeError(`Distinct deploy definitions collide at destination identity: ${key}`);
    identities.add(key);
    items.push({
      definitionPath: loaded.definitionPath,
      definition: loaded.definition,
      contentBody: loaded.contentBody,
      companionPaths: 'companionPaths' in loaded ? loaded.companionPaths : [loaded.htmlPath],
      targetIdentity,
    });
  }
  for (const selector of selectors ?? []) {
    if (selector.apiName !== undefined && !items.some((item) => matches(item.definition, selector)))
      throw new TypeError(
        `Exact deploy metadata member is missing: ${selector.contentType}:${selector.apiName}`,
      );
  }
  if (items.length === 0) throw new TypeError('Deploy source selection is empty');
  return { mode: files === undefined ? 'source-dir' : 'definition-file', items };
}
