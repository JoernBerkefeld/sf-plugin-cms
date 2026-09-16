import { lstat, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  cleanupOwnedPath,
  publishDirectoryNoClobber,
  type CleanupOptions,
  type DirectoryPublishOptions,
} from './atomic-publish.js';
import { projectEditableRawHtml, type EditableRawItem } from './editable-raw-html.js';

export type EditablePublishOptions = DirectoryPublishOptions & CleanupOptions;

/**
 * Validate portable directory paths and reject observed symlink routes.
 * @param {string} destination - Local directory path.
 * @param {boolean} requireNew - Whether the final directory must not exist.
 * @returns {Promise<void>} Resolves for a safe directory route.
 */
export async function assertEditableDirectoryPath(
  destination: string,
  requireNew = true,
): Promise<void> {
  if (!destination.trim()) throw new TypeError('Editable export paths must be nonempty');
  if (destination.startsWith('\\\\') || destination.startsWith('//')) {
    throw new TypeError('Editable export paths must not use network or device namespaces');
  }
  // Reject path aliases before normalization, including Windows device/stream spellings.
  for (const component of destination.slice(path.parse(destination).root.length).split(/[\\/]/u)) {
    if (component === '' || component === '.') continue;
    if (
      component === '..' ||
      /[. ]$/u.test(component) ||
      /[<>:"|?*]/u.test(component) ||
      [...component].some((character) => (character.codePointAt(0) ?? 0) < 32) ||
      /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu.test(component)
    )
      throw new TypeError('Unsafe editable export path component');
  }
  const absolute = path.resolve(destination);
  let current = path.parse(absolute).root;
  for (const component of absolute.slice(current.length).split(path.sep)) {
    current = path.join(current, component);
    let information;
    try {
      information = await lstat(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    if (information.isSymbolicLink() || !information.isDirectory()) {
      throw new TypeError(
        `Export path must use regular directories, not symlinks or reparse points: ${current}`,
      );
    }
    if (requireNew && current === absolute)
      throw new Error(`Export destination already exists: ${destination}`);
  }
}

/**
 * Validate disjoint, new destinations without writes or org access.
 * @param {string} outputDirectory - Explicit immutable package destination.
 * @param {string} editableDirectory - Separate new companion destination.
 * @returns {Promise<void>} Resolves when both local destinations are safe.
 */
export async function preflightEditableExport(
  outputDirectory: string,
  editableDirectory: string,
): Promise<void> {
  const output = path.resolve(outputDirectory);
  const editable = path.resolve(editableDirectory);
  const contains = (parent: string, child: string): boolean => {
    const relative = path.relative(parent, child);
    return (
      relative === '' ||
      (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))
    );
  };
  if (contains(output, editable) || contains(editable, output)) {
    throw new TypeError('--output-dir and --editable-dir must not overlap');
  }
  await assertEditableDirectoryPath(outputDirectory);
  await assertEditableDirectoryPath(editableDirectory);
}

/**
 * Publish only the fixed companion paths from original raw variant JSON.
 * @param {readonly EditableRawItem[]} rawItems - Verified original JSON paired with manifest IDs.
 * @param {string} sourceManifestSha256 - Verified immutable manifest digest.
 * @param {string} destination - New companion directory.
 * @param {EditablePublishOptions} options - Atomic publication and cleanup hooks.
 * @returns {Promise<void>} Resolves after no-clobber publication.
 */
export async function writeEditableRawHtml(
  rawItems: readonly EditableRawItem[],
  sourceManifestSha256: string,
  destination: string,
  options: EditablePublishOptions = {},
): Promise<void> {
  await assertEditableDirectoryPath(destination);
  const projection = projectEditableRawHtml(rawItems, sourceManifestSha256);
  const absolute = path.resolve(destination);
  const parent = path.dirname(absolute);
  await mkdir(parent, { recursive: true });
  await assertEditableDirectoryPath(destination);
  const temporary = await mkdtemp(path.join(parent, `.${path.basename(absolute)}.tmp-`));
  try {
    await mkdir(path.join(temporary, 'items'));
    await writeFile(path.join(temporary, 'editable.json'), projection.descriptorBytes, {
      flag: 'wx',
    });
    for (const item of projection.items) {
      await writeFile(path.join(temporary, item.metadataPath), item.metadataBytes, { flag: 'wx' });
      await writeFile(path.join(temporary, item.htmlPath), item.htmlBytes, { flag: 'wx' });
    }
    await assertEditableDirectoryPath(destination);
    await publishDirectoryNoClobber(temporary, absolute, options);
  } catch (error) {
    await cleanupOwnedPath(temporary, error, options);
  }
}
