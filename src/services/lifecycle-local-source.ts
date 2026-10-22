import path from 'node:path';
import fs, { lstat, readdir } from 'node:fs/promises';
import type { LifecycleContentType } from '../contracts/content-lifecycle-batch.js';
import {
  assertSourceDefinition,
  SOURCE_EMAIL_PROFILES,
  sourcePathSegment,
} from '../contracts/source-definition.js';
import { assertEditableDirectoryPath } from './editable-raw-html-export.js';
import { readStableRegularFile } from './import-workspace.js';
import { strictSourceJson } from './source-definition-import.js';
import {
  assertEditableItemDefinitionV2,
  reassembleEditableItemSourceV2,
  type EditableItemDefinitionV2,
} from './editable-item-source-v2.js';
import { reassembleEditableItemSource } from './editable-item-source.js';
import {
  assertEditableMediaDefinition,
  reassembleEditableMediaSource,
  type EditableMediaDefinition,
} from './editable-media-source.js';
import type { SourceDefinition } from '../contracts/source-definition.js';

export type LifecycleLocalIdentity = {
  workspaceApiName: string;
  contentType: LifecycleContentType;
  apiName: string;
  language: string;
};

export type LifecycleLocalFileSnapshot = {
  path: string;
  bytes: Buffer;
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
};

export type LifecycleLocalSourceInspection =
  | { outcome: 'absent'; identity: LifecycleLocalIdentity; directory: string }
  | { outcome: 'blocked'; identity: LifecycleLocalIdentity; message: string }
  | {
      outcome: 'matched';
      identity: LifecycleLocalIdentity;
      directory: string;
      definition: LifecycleLocalFileSnapshot;
      companions: LifecycleLocalFileSnapshot[];
      owners: LifecycleLocalFileSnapshot[];
    };

/** Evidence is supplied only after independently confirming remote deletion of this identity. */
export type LifecycleRemoteDeletionEvidence = {
  outcome: 'deleted';
  identity: LifecycleLocalIdentity;
};

export type LifecycleLocalDeletionResult = {
  outcome: 'noop' | 'deleted' | 'blocked' | 'partial';
  removed: string[];
  remaining: string[];
  message?: string;
};

function sameIdentity(a: LifecycleLocalIdentity, b: LifecycleLocalIdentity): boolean {
  return (
    a.workspaceApiName === b.workspaceApiName &&
    a.contentType === b.contentType &&
    a.apiName === b.apiName &&
    a.language === b.language
  );
}

function sameSnapshot(a: LifecycleLocalFileSnapshot, b: LifecycleLocalFileSnapshot): boolean {
  return (
    a.path === b.path &&
    a.bytes.equals(b.bytes) &&
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.size === b.size &&
    a.mtimeMs === b.mtimeMs &&
    a.ctimeMs === b.ctimeMs
  );
}

/**
 * Remove only a pre-remote inspected copy after independent remote deletion confirmation.
 * Revalidate remaining snapshots and all potential owners before each individual unlink.
 * This is not an atomic filesystem transaction: observed drift stops the remaining suffix.
 * @param {string} projectRoot - Original explicit selected project root.
 * @param {LifecycleLocalSourceInspection} inspection - Inspection captured before remote work.
 * @param {LifecycleRemoteDeletionEvidence | undefined} evidence - Independently confirmed remote deletion.
 * @returns {Promise<LifecycleLocalDeletionResult>} Exact removed and unremoved paths, without rollback.
 */
export async function deleteLifecycleLocalSource(
  projectRoot: string,
  inspection: LifecycleLocalSourceInspection,
  evidence?: LifecycleRemoteDeletionEvidence,
): Promise<LifecycleLocalDeletionResult> {
  // Companions first keeps the ownership definition available until the final unlink.
  const files =
    inspection.outcome === 'matched' ? [...inspection.companions, inspection.definition] : [];
  const removed: string[] = [];
  const remaining = files.map((file) => file.path);
  if (!evidence) return { outcome: 'noop', removed, remaining };
  try {
    if (evidence.outcome !== 'deleted' || !sameIdentity(evidence.identity, inspection.identity))
      throw new TypeError('Remote deletion confirmation does not match local identity');
    if (inspection.outcome === 'blocked') throw new TypeError(inspection.message);
    if (inspection.outcome === 'absent') return { outcome: 'noop', removed, remaining };
    const current = await inspectLifecycleLocalSource(projectRoot, inspection.identity);
    if (
      current.outcome !== 'matched' ||
      current.directory !== inspection.directory ||
      !sameSnapshot(current.definition, inspection.definition) ||
      current.companions.length !== inspection.companions.length ||
      current.companions.some((file, index) => !sameSnapshot(file, inspection.companions[index])) ||
      current.owners.length !== inspection.owners.length ||
      current.owners.some((file, index) => !sameSnapshot(file, inspection.owners[index]))
    )
      throw new TypeError(
        'Local lifecycle source or ownership changed since pre-remote inspection',
      );
    for (let index = 0; index < files.length; index++) {
      if (!(await directoryExists(inspection.directory)))
        throw new TypeError('Local lifecycle directory changed before deletion');
      const listing = await readdir(inspection.directory);
      const ownerNames = listing
        .filter(
          (name) =>
            /\.cms-[^.]+\.json$/iu.test(name) && name !== path.basename(inspection.definition.path),
        )
        .toSorted();
      if (
        JSON.stringify(ownerNames) !==
        JSON.stringify(inspection.owners.map((file) => path.basename(file.path)))
      )
        throw new TypeError('Local lifecycle ownership changed before deletion');
      // Owner bytes and identity must remain captured even after a companion prefix was removed.
      for (const prior of [...inspection.owners, ...files.slice(index)]) {
        const fresh = await snapshot(inspection.directory, path.basename(prior.path));
        if (!sameSnapshot(fresh, prior))
          throw new TypeError('Local lifecycle source or ownership changed before deletion');
      }
      const target = files[index];
      // Last check is the exact file about to be unlinked; no recursive or directory operations.
      if (!sameSnapshot(await snapshot(inspection.directory, path.basename(target.path)), target))
        throw new TypeError('Local lifecycle file changed immediately before deletion');
      await fs.unlink(target.path);
      removed.push(target.path);
      remaining.shift();
    }
    return { outcome: 'deleted', removed, remaining };
  } catch (error) {
    return {
      outcome: removed.length > 0 ? 'partial' : 'blocked',
      removed,
      remaining,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

export type LifecycleRemoteSynchronizationEvidence = {
  outcome: 'published' | 'unpublished';
  identity: LifecycleLocalIdentity;
};
export type LifecycleLocalSynchronizationResult = {
  outcome: 'noop' | 'blocked';
  reason?: 'missing-copy' | 'unconfirmed' | 'retrieval-equivalent';
  message?: string;
};

/**
 * Revalidate a qualified local copy after independently confirmed lifecycle success.
 * Recorded public retrieval preserves portable authoring fields and companions for
 * Template and bounded en_US Email/binary media; retain authored bytes and formatting.
 * This helper does not independently authenticate remote success or write any files.
 * @param {string} projectRoot - Same selected project root used before remote work.
 * @param {LifecycleLocalSourceInspection} inspection - Pre-remote local snapshots.
 * @param {LifecycleRemoteSynchronizationEvidence} [evidence] - Caller-confirmed exact remote transition.
 * @returns {Promise<LifecycleLocalSynchronizationResult>} Validated no-op or local failure.
 */
export async function synchronizeLifecycleLocalSource(
  projectRoot: string,
  inspection: LifecycleLocalSourceInspection,
  evidence?: LifecycleRemoteSynchronizationEvidence,
): Promise<LifecycleLocalSynchronizationResult> {
  if (!evidence) return { outcome: 'noop', reason: 'unconfirmed' };
  try {
    if (
      !['published', 'unpublished'].includes(evidence.outcome) ||
      !sameIdentity(evidence.identity, inspection.identity)
    )
      throw new TypeError('Remote lifecycle confirmation does not match local identity');
    if (inspection.outcome === 'blocked') throw new TypeError(inspection.message);
    if (inspection.outcome === 'absent') return { outcome: 'noop', reason: 'missing-copy' };
    assertLifecycleLocalSynchronizationEligible(inspection);
    const current = await inspectLifecycleLocalSource(projectRoot, inspection.identity);
    if (
      current.outcome !== 'matched' ||
      current.directory !== inspection.directory ||
      !sameSnapshot(current.definition, inspection.definition) ||
      current.companions.length !== inspection.companions.length ||
      current.companions.some((file, index) => !sameSnapshot(file, inspection.companions[index])) ||
      current.owners.length !== inspection.owners.length ||
      current.owners.some((file, index) => !sameSnapshot(file, inspection.owners[index]))
    )
      throw new TypeError(
        'Local lifecycle source or ownership changed since pre-remote inspection',
      );
    return { outcome: 'noop', reason: 'retrieval-equivalent' };
  } catch (error) {
    return {
      outcome: 'blocked',
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Admit only known write-free synchronization profiles before any remote mutation.
 * @param {LifecycleLocalSourceInspection} inspection - Captured existing copy or absence.
 */
export function assertLifecycleLocalSynchronizationEligible(
  inspection: LifecycleLocalSourceInspection,
): void {
  if (inspection.outcome === 'blocked') throw new TypeError(inspection.message);
  if (inspection.outcome === 'absent') return;
  const definition = parse(inspection.definition.bytes);
  const mediaMime = {
    sfdc_cms__image: 'image/png',
    sfdc_cms__document: 'text/plain',
    sfdc_cms__audio: 'audio/x-wav',
  };
  const qualified =
    inspection.identity.contentType === 'sfdc_cms__emailTemplate' ||
    (inspection.identity.language === 'en_US' &&
      (inspection.identity.contentType === 'sfdc_cms__email' ||
        (definition.contract === 'sf-cms-media-source' &&
          definition.media.representation === 'binary' &&
          Object.hasOwn(mediaMime, definition.contentType) &&
          definition.media.mimeType ===
            mediaMime[definition.contentType as keyof typeof mediaMime])));
  if (!qualified)
    throw new TypeError(
      'Local lifecycle retrieval equivalence is not established for this profile',
    );
}

type Definition = SourceDefinition | EditableItemDefinitionV2 | EditableMediaDefinition;

function profile(contentType: string) {
  const email = SOURCE_EMAIL_PROFILES.find((entry) => entry.contentType === contentType);
  if (email) return email;
  const media = {
    sfdc_cms__image: 'image',
    sfdc_cms__document: 'document',
    sfdc_cms__audio: 'audio',
  };
  if (!Object.hasOwn(media, contentType)) throw new TypeError('Unsupported local lifecycle type');
  const token = media[contentType as keyof typeof media];
  return { directory: token, token };
}

function parse(bytes: Buffer): Definition {
  const value = strictSourceJson(bytes, 'Local lifecycle definition');
  if ((value as { contract?: unknown })?.contract === 'sf-cms-media-source') {
    assertEditableMediaDefinition(value);
  } else if ((value as { contractVersion?: unknown })?.contractVersion === '2.0.0') {
    assertEditableItemDefinitionV2(value);
  } else {
    assertSourceDefinition(value);
    if (!SOURCE_EMAIL_PROFILES.some((entry) => entry.contentType === value.contentType))
      throw new TypeError('Unsupported local lifecycle source profile');
  }
  return value;
}

function companions(definition: Definition): string[] {
  if (definition.contract === 'sf-cms-media-source')
    return definition.media.representation === 'binary' ? [definition.media.companion.path] : [];
  return Array.isArray(definition.companions)
    ? definition.companions.map((entry) => entry.path)
    : [definition.companions.rawHtml!];
}

async function exactName(directory: string, name: string): Promise<boolean> {
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
  const matches = entries.filter((entry) => entry.toLowerCase() === name.toLowerCase());
  if (matches.length === 0) return false;
  if (matches.length !== 1 || matches[0] !== name)
    throw new TypeError(`Local lifecycle path is case-aliased: ${name}`);
  return true;
}

async function directoryExists(directory: string): Promise<boolean> {
  await assertEditableDirectoryPath(directory, false);
  const root = path.parse(directory).root;
  let current = root;
  for (const part of directory.slice(root.length).split(path.sep)) {
    if (!(await exactName(current, part))) return false;
    current = path.join(current, part);
  }
  return true;
}

async function snapshot(directory: string, name: string): Promise<LifecycleLocalFileSnapshot> {
  if (!(await exactName(directory, name)))
    throw new TypeError(`Local lifecycle file is missing: ${name}`);
  const file = path.join(directory, name);
  const before = await lstat(file);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1)
    throw new TypeError(`Local lifecycle file must be regular, not linked: ${name}`);
  const bytes = await readStableRegularFile(file, 'Local lifecycle file');
  const after = await lstat(file);
  if (
    !after.isFile() ||
    after.isSymbolicLink() ||
    after.nlink !== 1 ||
    ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].some(
      (key) => before[key as keyof typeof before] !== after[key as keyof typeof after],
    )
  )
    throw new TypeError(`Local lifecycle file changed during inspection: ${name}`);
  return {
    path: file,
    bytes: Buffer.from(bytes),
    dev: after.dev,
    ino: after.ino,
    size: after.size,
    mtimeMs: after.mtimeMs,
    ctimeMs: after.ctimeMs,
  };
}

function canonical(definition: Definition, name: string, identity: LifecycleLocalIdentity): void {
  const layout = profile(definition.contentType);
  if (
    definition.identity.context.workspaceApiName !== identity.workspaceApiName ||
    definition.contentType !== identity.contentType ||
    name !== `${definition.identity.apiName}.cms-${layout.token}.json`
  )
    throw new TypeError('Local lifecycle definition conflicts with canonical directory/filename');
}

/**
 * Inspect an existing canonical portable copy without writes, org access or remote-byte comparison.
 * The selected root plus unique portable identity is authority; returned snapshots are not an unlink permit.
 * @param {string} projectRoot - Explicit selected project root (cwd may be supplied by the caller).
 * @param {LifecycleLocalIdentity} selection - Exact workspace, canonical type, API name and language.
 * @returns {Promise<LifecycleLocalSourceInspection>} Detached existing files, absence or a blocking diagnostic.
 */
export async function inspectLifecycleLocalSource(
  projectRoot: string,
  selection: LifecycleLocalIdentity,
): Promise<LifecycleLocalSourceInspection> {
  const identity = { ...selection };
  try {
    for (const value of [identity.workspaceApiName, identity.apiName, identity.language])
      sourcePathSegment(value);
    const layout = profile(identity.contentType);
    await assertEditableDirectoryPath(projectRoot, false);
    const directory = path.join(
      path.resolve(projectRoot),
      'cms',
      identity.workspaceApiName,
      layout.directory,
    );
    if (!(await directoryExists(directory))) return { outcome: 'absent', identity, directory };
    const name = `${identity.apiName}.cms-${layout.token}.json`;
    if (!(await exactName(directory, name))) return { outcome: 'absent', identity, directory };
    const definition = await snapshot(directory, name);
    const parsed = parse(definition.bytes);
    canonical(parsed, name, identity);
    if (parsed.identity.apiName !== identity.apiName || parsed.language !== identity.language)
      throw new TypeError('Local lifecycle portable identity/language does not match selection');
    const selectedNames = companions(parsed);
    const selected = await Promise.all(
      selectedNames.map(async (file) => snapshot(directory, file)),
    );
    const files = new Map(selected.map((file) => [path.basename(file.path), file.bytes]));
    if (parsed.contract === 'sf-cms-media-source') reassembleEditableMediaSource(parsed, files);
    else if (parsed.contractVersion === '2.0.0') reassembleEditableItemSourceV2(parsed, files);
    else {
      const html = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
        selected[0].bytes,
      );
      if (html.startsWith('\uFEFF'))
        throw new TypeError('Local lifecycle HTML must not contain a BOM');
      reassembleEditableItemSource(parsed, html);
    }
    // One shallow type-directory scan: malformed potential owners cannot authorize deletion.
    // Undeclared same-stem files, subdirectories and unrelated non-definition files are not selected.
    const listing = await readdir(directory);
    const entries = listing.toSorted();
    const owners: LifecycleLocalFileSnapshot[] = [];
    for (const entry of entries) {
      if (!/\.cms-[^.]+\.json$/iu.test(entry) || entry === name) continue;
      const owner = await snapshot(directory, entry);
      const candidate = parse(owner.bytes);
      canonical(candidate, entry, identity);
      if (candidate.identity.apiName.toLowerCase() === identity.apiName.toLowerCase())
        throw new TypeError('Ambiguous local lifecycle portable identity');
      if (
        companions(candidate).some((file) =>
          selectedNames.some((selectedName) => file.toLowerCase() === selectedName.toLowerCase()),
        )
      )
        throw new TypeError('Shared or ambiguous local lifecycle companion ownership');
      owners.push(owner);
    }
    if (!(await directoryExists(directory)))
      throw new TypeError('Local lifecycle directory disappeared during inspection');
    const currentEntries = await readdir(directory);
    if (JSON.stringify(currentEntries.toSorted()) !== JSON.stringify(entries))
      throw new TypeError('Local lifecycle ownership directory changed during inspection');
    for (const prior of [definition, ...selected, ...owners]) {
      const current = await snapshot(directory, path.basename(prior.path));
      if (
        !current.bytes.equals(prior.bytes) ||
        ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].some(
          (key) => current[key as keyof typeof current] !== prior[key as keyof typeof prior],
        )
      )
        throw new TypeError('Local lifecycle source changed during inspection');
    }
    return { outcome: 'matched', identity, directory, definition, companions: selected, owners };
  } catch (error) {
    return {
      outcome: 'blocked',
      identity,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}
