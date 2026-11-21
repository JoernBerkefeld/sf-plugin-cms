import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';
import { handlerOf, HANDLERS } from '../content/registry.js';
import { assertFileName, readSourceFiles, SOURCE_ROOT } from '../content/source-files.js';
import type { ContentTypeHandler, DeployContext, SourceFiles } from '../content/types.js';
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

/** A `-m type:ApiName` value naming one component (no dots, paths or wildcards). */
export const SELECTOR = /^([\w-]+):([A-Za-z0-9][\w-]*)$/u;

/** Where a selected component lives on disk. */
export type Located = {
  baseDirectory: string;
  workspaceFolder: string;
  type: string;
  apiName: string;
};

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
 * The component a file path `cms/<workspace>/<type>/<ApiName>.<type>.*` belongs to.
 * @param {string} target - Path as given (for messages).
 * @param {string} absolute - Resolved path of an existing file.
 * @returns {Located} Component.
 */
function componentOfFilePath(target: string, absolute: string): Located {
  const parts = absolute.split(path.sep);
  const cmsIndex = parts.lastIndexOf(SOURCE_ROOT);
  if (cmsIndex === -1 || cmsIndex !== parts.length - 4)
    throw new CmsError('INVALID_SOURCE_PATH', `${target} is not cms/<workspace>/<type>/<file>`);
  const [workspaceFolder, type, name] = parts.slice(cmsIndex + 1);
  assertFileName(workspaceFolder, 'Workspace');
  const apiName = name.split('.')[0];
  if (!name.startsWith(`${apiName}.${type}.`))
    throw new CmsError('INVALID_SOURCE_PATH', `${target} is not a file of a ${type} component`);
  return { baseDirectory: parts.slice(0, cmsIndex).join(path.sep), workspaceFolder, type, apiName };
}

/**
 * The component one `--source-dir` file names (the component JSON or a companion). A folder is
 * refused: commands that change the org's state take exact components only.
 * @param {string} target - Path as given.
 * @returns {Promise<Located>} Component.
 */
export async function componentOfFile(target: string): Promise<Located> {
  const absolute = path.resolve(target);
  let stats;
  try {
    stats = await lstat(absolute);
  } catch {
    throw new CmsError('SOURCE_NOT_FOUND', `${target} does not exist`);
  }
  if (!stats.isFile())
    throw new CmsError(
      'INVALID_SELECTOR',
      `${target} is not a component file; name single components (cms/<workspace>/<type>/<ApiName>.<type>.json)`,
    );
  return componentOfFilePath(target, absolute);
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
  if (stats.isFile()) return [componentOfFilePath(target, absolute)];
  if (!stats.isDirectory() || stats.isSymbolicLink())
    throw new CmsError('INVALID_SOURCE_PATH', `${target} is neither a file nor a folder`);
  const depth = cmsIndex === -1 ? -1 : parts.length - 1 - cmsIndex;
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
  const match = SELECTOR.exec(value.trim());
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
 * `--source-dir` paths, in registry order, then API name (deploy puts referenced components first
 * with `dependencyOrder`). Strict: an unknown
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

const registryIndex = (source: SelectedSource): number =>
  HANDLERS.findIndex((handler) => handler.type === source.handler.type);

/**
 * The sources in dependency order: a component another selected component references comes
 * first. Ties keep registry order, then API name. References to components outside the
 * selection are left to the plan. A source whose files do not parse counts as having no
 * references (the plan reports it). A cycle is refused before anything is written.
 * @param {SelectedSource[]} sources - Selected components.
 * @param {DeployContext} context - Destination workspace.
 * @returns {SelectedSource[]} Same sources, referenced ones first.
 */
export function dependencyOrder(
  sources: SelectedSource[],
  context: DeployContext,
): SelectedSource[] {
  const keyOf = (source: SelectedSource): string => `${source.handler.type}:${source.apiName}`;
  const byKey = new Map(sources.map((source) => [keyOf(source), source]));
  const dependencies = new Map<string, Set<string>>();
  for (const source of sources) {
    let wanted: string[] = [];
    try {
      wanted = source.handler
        .references(source.handler.fromSource(source.files, context))
        .map((reference) => `${reference.type}:${reference.apiName}`);
    } catch {
      // Planning blocks this source with the parse error.
    }
    dependencies.set(
      keyOf(source),
      new Set(wanted.filter((key) => key !== keyOf(source) && byKey.has(key))),
    );
  }
  const rank = (left: SelectedSource, right: SelectedSource): number =>
    registryIndex(left) - registryIndex(right) || left.apiName.localeCompare(right.apiName);
  const ordered: SelectedSource[] = [];
  const done = new Set<string>();
  let pending = sources.toSorted(rank);
  while (pending.length > 0) {
    const next = pending.find((source) =>
      [...dependencies.get(keyOf(source))!].every((key) => done.has(key)),
    );
    if (!next) {
      // Every pending component waits for another pending one: follow the edges to a cycle.
      const path = [keyOf(pending[0])];
      for (;;) {
        const waitsFor = [...dependencies.get(path.at(-1)!)!]
          .filter((key) => !done.has(key))
          .toSorted((left, right) => rank(byKey.get(left)!, byKey.get(right)!))[0];
        const seen = path.indexOf(waitsFor);
        if (seen !== -1) {
          const cycle = [...path.slice(seen), waitsFor];
          throw new CmsError(
            'DEPENDENCY_CYCLE',
            `Components reference each other in a cycle: ${cycle.join(' -> ')}`,
          );
        }
        path.push(waitsFor);
      }
    }
    ordered.push(next);
    done.add(keyOf(next));
    pending = pending.filter((source) => source !== next);
  }
  return ordered;
}
