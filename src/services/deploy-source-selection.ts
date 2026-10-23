import path from 'node:path';
import { lstat } from 'node:fs/promises';
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
  sourcePathSegment,
  type SourceDefinition,
} from '../contracts/source-definition.js';
import type { JsonValue } from '../contracts/capability-registry.js';
import { assertEditableDirectoryPath } from './editable-raw-html-export.js';
import { loadEditableBrandSource, loadEditableItemSource } from './editable-item-source.js';
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
  'sfdc_cms__audio',
  'sfdc_cms__brand',
] as const;

export interface DeploySourceSelectionFlags {
  /** Resolved destination workspace API name, required only for conventional metadata selection. */
  workspaceApiName?: string;
  /** Invocation directory captured before preflight and subsequent selection rechecks. */
  cwd?: string;
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
  mode: 'metadata' | 'source-dir';
  items: DeployLocalItem[];
}

export type DeploySelectionOptions = {
  /** Brand selection switch; selecting a source never grants execution authority. */
  includeUnqualifiedBrands?: boolean;
};

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

function contentType(value: string, brands: boolean): string {
  const canonical = normalizeContentTypeAlias(value, [
    ...DEPLOY_SOURCE_CONTENT_TYPES.filter((type) => brands || type !== 'sfdc_cms__brand'),
  ]);
  if (canonical === undefined)
    throw new TypeError(
      'Deploy source selection requires a supported qualified content type or short name',
    );
  return canonical;
}

function metadataSelector(value: string, brands: boolean): Selector {
  const colon = value.indexOf(':');
  if (colon === -1) return { contentType: contentType(value, brands) };
  const apiName = value.slice(colon + 1);
  if (!apiName.trim()) throw new TypeError('Deploy metadata requires a nonempty exact API name');
  return { contentType: contentType(value.slice(0, colon), brands), apiName };
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
    if (!(DEPLOY_SOURCE_CONTENT_TYPES as readonly string[]).includes(candidate.contentType))
      throw new TypeError('Unsupported deploy media content type');
    if (candidate.media.representation !== 'binary')
      throw new TypeError(
        candidate.contentType === 'sfdc_cms__image'
          ? 'Image deploy requires a binary Image source'
          : `${candidate.identity.type} deploy selection requires a binary source`,
      );
    return candidate;
  }
  assertSourceDefinition(candidate);
  return candidate;
}

/**
 * Select local Email/Template/binary media/strict Brand sources without apply authority or org access.
 * @param {DeploySourceSelectionFlags} flags - Explicit paths or conventional metadata and resolved workspace scope.
 * @param {DeploySelectionOptions} options - Optional restriction for narrower item executors.
 * @returns {Promise<DeployLocalSelection>} Deterministic admitted sources and destination-relative identities.
 */
export async function selectDeploySources(
  flags: DeploySourceSelectionFlags,
  options: DeploySelectionOptions = {},
): Promise<DeployLocalSelection> {
  const brands = options.includeUnqualifiedBrands !== false;
  const directories = values(flags['source-dir']);
  const types = values(flags['content-type']);
  const metadata = values(flags.metadata);
  if (Number(metadata !== undefined) + Number(directories !== undefined) !== 1)
    throw new TypeError('Deploy requires exactly one source mode: metadata or source-dir');
  if (types !== undefined && directories === undefined)
    throw new TypeError('Deploy content-type filters require source-dir mode');
  const normalizedSelectors: Selector[] | undefined = metadata
    ? metadata.map((value) => metadataSelector(value, brands))
    : types?.map((value) => ({ contentType: contentType(value, brands) }));
  const selectors = normalizedSelectors?.filter(
    (selector, index, all) =>
      all.findIndex(
        (other) => other.contentType === selector.contentType && other.apiName === selector.apiName,
      ) === index,
  );
  const candidates = new Set<string>();
  let roots = directories;
  if (metadata !== undefined) {
    if (typeof flags.workspaceApiName !== 'string' || !flags.workspaceApiName)
      throw new TypeError('Deploy metadata requires the resolved destination workspace API name');
    sourcePathSegment(flags.workspaceApiName);
    const cwd = flags.cwd ?? process.cwd();
    await assertEditableDirectoryPath(cwd, false);
    roots = [
      ...new Set(
        selectors!.map((selector) =>
          path.join(
            cwd,
            'cms',
            flags.workspaceApiName!,
            selector.contentType.slice('sfdc_cms__'.length),
          ),
        ),
      ),
    ];
  }
  for (const directory of roots ?? []) {
    // Validate the original route before resolving; files share the existing guarded loaders.
    await assertEditableDirectoryPath(path.dirname(directory), false);
    const information = await lstat(directory);
    if (information.isFile()) {
      if (metadata !== undefined)
        throw new TypeError('Deploy metadata requires a canonical type directory');
      candidates.add(path.resolve(directory));
      continue;
    }
    await assertEditableDirectoryPath(directory, false);
    const root = path.resolve(directory);
    // Reuse the package's no-follow recursive traversal, never a permissive new walker.
    for (const relative of await enumeratePackageFiles(root, root)) {
      if (
        /\.cms-email(?:-template)?\.json$/u.test(relative) ||
        /\.cms-(?:image|document|audio)\.json$/u.test(relative) ||
        (brands && /\.cms-brand\.json$/u.test(relative))
      )
        candidates.add(path.join(root, relative));
    }
  }
  const items: DeployLocalItem[] = [];
  const identities = new Set<string>();
  for (const file of [...candidates].toSorted()) {
    const definition = await readDefinition(file);
    if (definition.contentType === 'sfdc_cms__brand' && !brands)
      throw new TypeError('Brand deploy selection is not publicly admitted');
    if (metadata !== undefined) {
      const typeRoot = path.join(
        flags.cwd ?? process.cwd(),
        'cms',
        flags.workspaceApiName!,
        definition.contentType.slice('sfdc_cms__'.length),
      );
      const relative = path.relative(typeRoot, file);
      if (relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
        throw new TypeError('Deploy metadata definition is outside its canonical type subtree');
    }
    if (selectors && !selectors.some((selector) => matches(definition, selector))) continue;
    const media =
      definition.contract === 'sf-cms-media-source'
        ? await loadEditableMediaSource(file)
        : undefined;
    if (media && media.source.representation !== 'binary')
      throw new TypeError(
        media.definition.contentType === 'sfdc_cms__image'
          ? 'Image deploy requires a binary Image source'
          : `${media.definition.identity.type} deploy selection requires a binary source`,
      );
    let email:
      | Awaited<ReturnType<typeof loadEditableItemSourceV2>>
      | Awaited<ReturnType<typeof loadEditableItemSource>>
      | Awaited<ReturnType<typeof loadEditableBrandSource>>
      | undefined;
    if (!media) {
      if (definition.contentType === 'sfdc_cms__brand') email = await loadEditableBrandSource(file);
      else
        email =
          definition.contractVersion === '2.0.0'
            ? await loadEditableItemSourceV2(file)
            : await loadEditableItemSource(file);
    }
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
    let companionPaths: string[] = [];
    if ('companionPaths' in loaded) companionPaths = loaded.companionPaths;
    else if ('htmlPath' in loaded) companionPaths = [loaded.htmlPath];
    items.push({
      definitionPath: loaded.definitionPath,
      definition: loaded.definition,
      contentBody: loaded.contentBody,
      ...(media?.source.representation === 'binary'
        ? { mediaSha256: createHash('sha256').update(media.source.binary.bytes).digest('hex') }
        : {}),
      companionPaths,
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
  return { mode: metadata === undefined ? 'source-dir' : 'metadata', items };
}
