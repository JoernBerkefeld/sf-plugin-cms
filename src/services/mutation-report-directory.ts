import { randomUUID } from 'node:crypto';
import { lstat, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { assertEditableDirectoryPath } from './editable-raw-html-export.js';

/**
 * Validate an explicit report destination without allocating it.
 * @param {string} directory - Exact fresh directory requested by the caller.
 * @returns {Promise<void>} Resolves when the path and existing parent are safe.
 */
export async function validateMutationReportDirectory(directory: string): Promise<void> {
  await assertEditableDirectoryPath(directory);
  const parent = await lstat(path.dirname(path.resolve(directory)));
  if (!parent.isDirectory()) throw new TypeError('Report parent must be an existing directory.');
}

/**
 * Allocate one exclusive durable report directory only when reporting was requested.
 * @param {boolean} enabled - Whether the default report location was requested.
 * @param {string | undefined} directory - Optional exact destination, implying reporting.
 * @param {string} cwd - Invocation directory for the default durable location.
 * @returns {Promise<string | undefined>} Fresh directory, or undefined without any filesystem I/O.
 */
export async function allocateMutationReportDirectory(
  enabled: boolean,
  directory: string | undefined,
  cwd: string,
): Promise<string | undefined> {
  if (directory !== undefined) {
    await validateMutationReportDirectory(directory);
    const absolute = path.resolve(directory);
    await mkdir(absolute);
    return absolute;
  }
  if (!enabled) return undefined;
  const parent = path.join(cwd, 'logs', 'cms', 'reports');
  // Validate each ancestor before creating it; never recursively follow an existing link.
  await assertEditableDirectoryPath(parent, false);
  const relative = path.relative(path.parse(parent).root, parent);
  let current = path.parse(parent).root;
  for (const component of relative.split(path.sep)) {
    current = path.join(current, component);
    await assertEditableDirectoryPath(current, false);
    try {
      await mkdir(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    await assertEditableDirectoryPath(current, false);
  }
  const allocated = path.join(
    parent,
    `${new Date().toISOString().replaceAll(':', '.')}-${randomUUID()}`,
  );
  await assertEditableDirectoryPath(allocated);
  await mkdir(allocated);
  return allocated;
}
