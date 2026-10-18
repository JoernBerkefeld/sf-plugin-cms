import path from 'node:path';
import { normalizeContentTypeAlias } from './content-type-alias.js';
import { createHash } from 'node:crypto';
import {
  assertEditableMediaDefinition,
  loadEditableMediaSource,
  type EditableMediaDefinition,
} from './editable-media-source.js';

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

export const DEPLOY_SOURCE_CONTENT_TYPES = [
  ...SOURCE_EMAIL_PROFILES.map((profile) => profile.contentType),
  'sfdc_cms__image',
  'sfdc_cms__document',
] as const;

export interface DeploySourceSelectionFlags {
  'definition-file'?: readonly string[];
  'source-dir'?: readonly string[];
  'content-type'?: readonly string[];
  metadata?: readonly string[];
}

export interface DeployLocalItem {
  definitionPath: string;
  companionPaths: string[];
  definition: SourceDefinition | EditableItemDefinitionV2 | EditableMediaDefinition;
  /** Observed binary binding for media planning, never apply authority. */
  mediaSha256?: string;
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
  const canonical = normalizeContentTypeAlias(value, DEPLOY_SOURCE_CONTENT_TYPES);
  if (canonical === undefined)
    throw new TypeError(
      'Deploy source selection requires a supported qualified content type or short name',
    );
  return canonical;
}

function metadataSelector(value: string): Selector {
  const colon = value.indexOf(':');
  if (colon === -1) return { contentType: contentType(value) };
  const apiName = value.slice(colon + 1);
  if (!apiName.trim()) throw new TypeError('Deploy metadata requires a nonempty exact API name');
  return { contentType: contentType(value.slice(0, colon)), apiName };
}

function matches(definition: DeployLocalItem['definition'], selector: Selector): boolean {
  return (
    definition.contentType === selector.contentType &&
    (selector.apiName === undefined || definition.identity.apiName === selector.apiName)
  );
}

async function readDefinition(file: string): Promise<DeployLocalItem['definition']> {
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
  if ((candidate as { contract?: string })?.contract === 'sf-cms-media-source') {
    assertEditableMediaDefinition(candidate);
    if (candidate.media.representation !== 'binary')
      throw new TypeError(
        candidate.contentType === 'sfdc_cms__image'
          ? 'Image deploy requires a binary Image source'
          : 'Document deploy selection requires a binary source',
      );
    return candidate;
  }
  assertSourceDefinition(candidate);
  return candidate;
}

/**
 * Select local Email/Template/binary Image/Document sources without apply authority or org access.
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
  const normalizedSelectors: Selector[] | undefined = metadata
    ? metadata.map((value) => metadataSelector(value))
    : types?.map((value) => ({ contentType: contentType(value) }));
  const selectors = normalizedSelectors?.filter(
    (selector, index, all) =>
      all.findIndex(
        (other) => other.contentType === selector.contentType && other.apiName === selector.apiName,
      ) === index,
  );
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
      if (
        /\.cms-email(?:-template)?\.json$/u.test(relative) ||
        /\.cms-(?:image|document)\.json$/u.test(relative)
      )
        candidates.add(path.join(root, relative));
    }
  }
  const items: DeployLocalItem[] = [];
  const identities = new Set<string>();
  for (const file of [...candidates].toSorted()) {
    const definition = await readDefinition(file);
    if (selectors && !selectors.some((selector) => matches(definition, selector))) continue;
    const media =
      definition.contract === 'sf-cms-media-source'
        ? await loadEditableMediaSource(file)
        : undefined;
    if (media && media.source.representation !== 'binary')
      throw new TypeError(
        media.definition.contentType === 'sfdc_cms__image'
          ? 'Image deploy requires a binary Image source'
          : 'Document deploy selection requires a binary source',
      );
    let email:
      | Awaited<ReturnType<typeof loadEditableItemSourceV2>>
      | Awaited<ReturnType<typeof loadEditableItemSource>>
      | undefined;
    if (!media)
      email =
        definition.contractVersion === '2.0.0'
          ? await loadEditableItemSourceV2(file)
          : await loadEditableItemSource(file);
    const loaded = media
      ? {
          ...media,
          contentBody: media.source.representation === 'binary' ? media.source.contentBody : {},
        }
      : email!;
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
      ...(media?.source.representation === 'binary'
        ? { mediaSha256: createHash('sha256').update(media.source.binary.bytes).digest('hex') }
        : {}),
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
