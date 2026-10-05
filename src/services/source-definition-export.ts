import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { publishDirectoryNoClobber, type DirectoryPublishOptions } from './atomic-publish.js';
import { assertEditableDirectoryPath } from './editable-raw-html-export.js';
import { isDeepStrictEqual } from 'node:util';
import {
  projectSourceDefinitions,
  type SourceDefinitionInputItem,
  type SourceDefinitionProjection,
} from './source-definition.js';

export type SourcePublicationFile = {
  readonly path: string;
  readonly bytes: Buffer;
  readonly sha256: string;
};

/**
 * Bind every publication file to a fresh projection of original acquired evidence.
 * This pure checkpoint performs no filesystem publication or baseline integrity verification.
 * @param {readonly SourceDefinitionInputItem[]} original - Verified original native records.
 * @param {SourceDefinitionProjection} candidate - Proposed immutable publication projection.
 * @returns {readonly SourcePublicationFile[]} Detached exact file bytes with hashes.
 */
export function bindSourcePublication(
  original: readonly SourceDefinitionInputItem[],
  candidate: SourceDefinitionProjection,
): readonly SourcePublicationFile[] {
  const expected = projectSourceDefinitions(original);
  if (!isDeepStrictEqual(candidate, expected))
    throw new TypeError('Source publication must match deterministic original reprojection');
  const files: SourcePublicationFile[] = [];
  const aliases = new Set<string>();
  const add = (filePath: string, bytes: Buffer): void => {
    const alias = filePath.toLowerCase();
    if (aliases.has(alias)) throw new TypeError('Source publication path collision');
    aliases.add(alias);
    const detached = Buffer.from(bytes);
    files.push({
      path: filePath,
      bytes: detached,
      sha256: createHash('sha256').update(detached).digest('hex'),
    });
  };
  for (const item of expected.items) {
    add(item.definitionPath, item.definitionBytes);
    if (item.htmlPath !== undefined && item.htmlBytes !== undefined)
      add(item.htmlPath, item.htmlBytes);
  }
  return files.toSorted((left, right) =>
    left.path < right.path ? -1 : Number(left.path > right.path),
  );
}

/**
 * Reject overlapping baseline/source trees and unsafe or existing source destinations.
 * Baseline integrity remains the caller's responsibility; this performs no writes.
 * @param {string} baselineDirectory - Separate immutable export directory.
 * @param {string} destination - New source-definition directory.
 * @returns {Promise<void>} Resolves when both directory routes are safe and disjoint.
 */
export async function preflightSourceDefinitionExport(
  baselineDirectory: string,
  destination: string,
): Promise<void> {
  await assertEditableDirectoryPath(baselineDirectory, false);
  await assertEditableDirectoryPath(destination);
  const baseline = path.resolve(baselineDirectory).toLowerCase();
  const source = path.resolve(destination).toLowerCase();
  const contains = (parent: string, child: string): boolean => {
    const relative = path.relative(parent, child);
    return (
      relative === '' ||
      (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))
    );
  };
  if (contains(baseline, source) || contains(source, baseline))
    throw new TypeError('Baseline and source-definition directories must not overlap');
}

/**
 * Stage detached original definitions and publish a new tree atomically without replacement.
 * Failed staging is deliberately retained: stagingPath on extensible errors identifies it.
 * No recursive workspace/sibling cleanup is performed, including on publication failure.
 * @param {readonly SourceDefinitionInputItem[]} original - Verified original acquired records.
 * @param {SourceDefinitionProjection} candidate - Exact deterministic source projection.
 * @param {string} baselineDirectory - Disjoint immutable baseline directory.
 * @param {string} destination - New source-definition directory.
 * @param {DirectoryPublishOptions} options - Existing atomic publication hooks.
 * @returns {Promise<readonly SourcePublicationFile[]>} Detached published files and SHA-256 hashes.
 */
export async function writeSourceDefinitions(
  original: readonly SourceDefinitionInputItem[],
  candidate: SourceDefinitionProjection,
  baselineDirectory: string,
  destination: string,
  options: DirectoryPublishOptions = {},
): Promise<readonly SourcePublicationFile[]> {
  const files = bindSourcePublication(original, candidate);
  await preflightSourceDefinitionExport(baselineDirectory, destination);
  const absolute = path.resolve(destination);
  const parent = path.dirname(absolute);
  await mkdir(parent, { recursive: true });
  await preflightSourceDefinitionExport(baselineDirectory, destination);
  const temporary = await mkdtemp(path.join(parent, `.${path.basename(absolute)}.tmp-`));
  try {
    for (const file of files) {
      const target = path.join(temporary, file.path);
      await mkdir(path.dirname(target), { recursive: true });
      await assertEditableDirectoryPath(path.dirname(target), false);
      await writeFile(target, file.bytes, { flag: 'wx' });
    }
    for (const file of files) {
      const target = path.join(temporary, file.path);
      await assertEditableDirectoryPath(path.dirname(target), false);
      const information = await lstat(target);
      if (
        !information.isFile() ||
        information.isSymbolicLink() ||
        information.nlink !== 1 ||
        createHash('sha256')
          .update(await readFile(target))
          .digest('hex') !== file.sha256
      )
        throw new TypeError('Staged source publication must contain exact regular files');
    }
    await preflightSourceDefinitionExport(baselineDirectory, destination);
    await publishDirectoryNoClobber(temporary, absolute, options);
    return files;
  } catch (error) {
    try {
      if (typeof error === 'object' && error !== null && Object.isExtensible(error))
        Object.defineProperty(error, 'stagingPath', { value: temporary, enumerable: false });
    } catch {
      // Diagnostic attachment must never replace the original publication failure.
    }
    throw error;
  }
}
