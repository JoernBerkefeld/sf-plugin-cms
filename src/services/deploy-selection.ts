import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';
import { handlerOf, HANDLERS } from '../content/registry.js';
import { readSourceFiles, SOURCE_ROOT } from '../content/source-files.js';
import type { ContentTypeHandler, SourceFiles } from '../content/types.js';
import { CmsError } from '../errors/registry.js';

/** One component chosen for deploy, read from disk. */
export type SelectedSource = {
  handler: ContentTypeHandler;
  /** Workspace folder the file lives in (`cms/<workspaceFolder>/…`): the source workspace. */
  workspaceFolder: string;
  apiName: string;
  /** Absolute path of `<ApiName>.<type>.json`. */
  path: string;
  files: SourceFiles;
};

type Located = { baseDirectory: string; workspaceFolder: string; type: string; apiName: string };

async function isDirectory(target: string): Promise<boolean> {
  try {
    const stats = await lstat(target);
    return stats.isDirectory() && !stats.isSymbolicLink();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function subdirectories(directory: string): Promise<string[]> {
  if (!(await isDirectory(directory))) return [];
  const entries = await readdir(directory, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
    .map((entry) => entry.name)
    .toSorted();
}

/**
 * Components of one type folder `cms/<workspace>/<type>/`.
 * @param {string} baseDirectory - Directory holding `cms/`.
 * @param {string} workspaceFolder - Workspace folder name.
 * @param {string} type - CLI type name (folder name).
 * @returns {Promise<Located[]>} One entry per `<ApiName>.<type>.json`.
 */
async function componentsOfTypeFolder(
  baseDirectory: string,
  workspaceFolder: string,
  type: string,
): Promise<Located[]> {
  const handler = handlerOf(type);
  const directory = path.join(baseDirectory, SOURCE_ROOT, workspaceFolder, type);
  const suffix = `.${handler.type}.json`;
  const entries = await readdir(directory, { withFileTypes: true });
  return entries
    .filter(
      (entry) => entry.isFile() && entry.name.endsWith(suffix) && entry.name.length > suffix.length,
    )
    .map((entry) => ({
      baseDirectory,
      workspaceFolder,
      type,
      apiName: entry.name.slice(0, -suffix.length),
    }));
}

/**
 * The components a `--source-dir` path names: a component file (or companion), a type folder,
 * a workspace folder, `cms/` itself, or a directory that holds `cms/`.
 * @param {string} target - Path as given.
 * @returns {Promise<Located[]>} Components.
 */
async function componentsOfPath(target: string): Promise<Located[]> {
  const absolute = path.resolve(target);
  let stats;
  try {
    stats = await lstat(absolute);
  } catch {
    throw new CmsError('SOURCE_NOT_FOUND', `${target} does not exist`);
  }
  const parts = absolute.split(path.sep);
  const cmsIndex = parts.lastIndexOf(SOURCE_ROOT);
  if (stats.isFile()) {
    if (cmsIndex === -1 || cmsIndex !== parts.length - 4)
      throw new CmsError('INVALID_SOURCE_PATH', `${target} is not cms/<workspace>/<type>/<file>`);
    const [workspaceFolder, type, name] = parts.slice(cmsIndex + 1);
    const apiName = name.split('.')[0];
    if (!name.startsWith(`${apiName}.${type}.`))
      throw new CmsError('INVALID_SOURCE_PATH', `${target} is not a file of a ${type} component`);
    return [
      { baseDirectory: parts.slice(0, cmsIndex).join(path.sep), workspaceFolder, type, apiName },
    ];
  }
  if (!stats.isDirectory() || stats.isSymbolicLink())
    throw new CmsError('INVALID_SOURCE_PATH', `${target} is neither a file nor a folder`);
  const depth = cmsIndex < 0 ? -1 : parts.length - 1 - cmsIndex;
  if (depth < 0 || depth > 2) {
    if (await isDirectory(path.join(absolute, SOURCE_ROOT)))
      return componentsOfPath(path.join(absolute, SOURCE_ROOT));
    throw new CmsError('INVALID_SOURCE_PATH', `${target} is not inside a cms/ folder`);
  }
  const baseDirectory = parts.slice(0, cmsIndex).join(path.sep);
  const workspaces = depth === 0 ? await subdirectories(absolute) : [parts[cmsIndex + 1]];
  const found: Located[] = [];
  for (const workspaceFolder of workspaces) {
    const types =
      depth === 2
        ? [parts[cmsIndex + 2]]
        : await subdirectories(path.join(baseDirectory, SOURCE_ROOT, workspaceFolder));
    for (const type of types)
      found.push(...(await componentsOfTypeFolder(baseDirectory, workspaceFolder, type)));
  }
  return found;
}

/**
 * The component a `-m type:ApiName` value names, looked up in every workspace folder of
 * `<projectDirectory>/cms/`.
 * @param {string} value - Selector.
 * @param {string} projectDirectory - Directory holding `cms/`.
 * @returns {Promise<Located>} Component.
 */
async function componentOfSelector(value: string, projectDirectory: string): Promise<Located> {
  const match = /^([\w-]+):(.+)$/u.exec(value.trim());
  if (!match)
    throw new CmsError(
      'INVALID_SELECTOR',
      `Deploy needs type:ApiName (or --source-dir), not ${value}`,
    );
  const [, type, apiName] = match;
  const handler = handlerOf(type);
  const matches: Located[] = [];
  for (const workspaceFolder of await subdirectories(path.join(projectDirectory, SOURCE_ROOT))) {
    const file = path.join(
      projectDirectory,
      SOURCE_ROOT,
      workspaceFolder,
      type,
      `${apiName}.${handler.type}.json`,
    );
    try {
      const stats = await lstat(file);
      if (stats.isFile())
        matches.push({ baseDirectory: projectDirectory, workspaceFolder, type, apiName });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  if (matches.length === 0)
    throw new CmsError(
      'SOURCE_NOT_FOUND',
      `No ${SOURCE_ROOT}/<workspace>/${type}/${apiName}.${type}.json under ${projectDirectory}`,
    );
  if (matches.length > 1)
    throw new CmsError(
      'SOURCE_AMBIGUOUS',
      `${value} is in workspace folders ${matches.map((m) => m.workspaceFolder).join(', ')}`,
    );
  return matches[0];
}

/**
 * Read the components named by `-m type:ApiName` (looked up under `projectDirectory`) and by
 * `--source-dir` paths, in deploy order (registry order, then API name). Strict: an unknown
 * type, a missing file or the same component in two workspace folders stops the deploy.
 * @param {string[] | undefined} selectors - `-m` values.
 * @param {string[] | undefined} sourcePaths - `-d` values.
 * @param {string} projectDirectory - Directory holding `cms/` for `-m`.
 * @returns {Promise<SelectedSource[]>} Components with their files.
 */
export async function selectSources(
  selectors: string[] | undefined,
  sourcePaths: string[] | undefined,
  projectDirectory: string,
): Promise<SelectedSource[]> {
  const located: Located[] = [];
  for (const value of selectors ?? [])
    located.push(await componentOfSelector(value, projectDirectory));
  for (const target of sourcePaths ?? []) located.push(...(await componentsOfPath(target)));
  if (located.length === 0)
    throw new CmsError('SOURCE_NOT_FOUND', 'Name components with -m type:ApiName or --source-dir');
  const byComponent = new Map<string, Located>();
  for (const entry of located) {
    handlerOf(entry.type);
    const key = `${entry.type}:${entry.apiName}`;
    const seen = byComponent.get(key);
    if (
      seen &&
      (seen.workspaceFolder !== entry.workspaceFolder ||
        path.resolve(seen.baseDirectory) !== path.resolve(entry.baseDirectory))
    )
      throw new CmsError(
        'SOURCE_AMBIGUOUS',
        `${key} is selected from ${seen.workspaceFolder} and ${entry.workspaceFolder}`,
      );
    byComponent.set(key, entry);
  }
  const order = (entry: Located): number => HANDLERS.findIndex((h) => h.type === entry.type);
  const sorted = [...byComponent.values()].toSorted(
    (left, right) => order(left) - order(right) || left.apiName.localeCompare(right.apiName),
  );
  const sources: SelectedSource[] = [];
  for (const entry of sorted) {
    const files = await readSourceFiles(
      entry.baseDirectory,
      entry.workspaceFolder,
      entry.type,
      entry.apiName,
    );
    sources.push({
      handler: handlerOf(entry.type),
      workspaceFolder: entry.workspaceFolder,
      apiName: entry.apiName,
      path: path.join(
        entry.baseDirectory,
        SOURCE_ROOT,
        entry.workspaceFolder,
        entry.type,
        `${entry.apiName}.${entry.type}.json`,
      ),
      files,
    });
  }
  return sources;
}
