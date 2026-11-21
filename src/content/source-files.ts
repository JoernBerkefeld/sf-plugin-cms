import { mkdir, readdir, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { CmsError } from '../errors/registry.js';
import type { SourceDocument, SourceFiles } from './types.js';

/** Top folder of the project layout: `cms/<workspaceApiName>/<type>/<ApiName>.<type>.json`. */
export const SOURCE_ROOT = 'cms';

// No dots: `<ApiName>.<type>.` must never be a prefix of another component's files.
const SAFE_NAME = /^[A-Za-z0-9][\w-]*$/u;

/**
 * Refuse a name that is not usable as one path segment on every platform.
 * @param {string} name - API name, type or workspace folder name.
 * @param {string} what - What the name is, for the message.
 */
export function assertFileName(name: string, what: string): void {
  if (!SAFE_NAME.test(name))
    throw new CmsError(
      'INVALID_FILE_NAME',
      `${what} ${JSON.stringify(name)} is not a safe file name`,
    );
}

/**
 * Folder of one type in one workspace.
 * @param {string} baseDirectory - Project directory (`--output-dir` / `--source-dir`).
 * @param {string} workspaceFolder - Workspace API name.
 * @param {string} type - CLI type name.
 * @returns {string} Absolute folder path.
 */
export function typeDirectory(
  baseDirectory: string,
  workspaceFolder: string,
  type: string,
): string {
  assertFileName(workspaceFolder, 'Workspace');
  assertFileName(type, 'Type');
  return path.resolve(baseDirectory, SOURCE_ROOT, workspaceFolder, type);
}

/**
 * JSON text of a value, two-space indented, LF, trailing newline.
 * @param {unknown} value - Value.
 * @returns {string} File text.
 */
export function jsonText(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

async function existingBytes(file: string): Promise<Uint8Array | undefined> {
  try {
    return await readFile(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

/** Result of writing one component. */
export type WrittenComponent = {
  outcome: 'retrieved' | 'unchanged';
  path: string;
  companionPaths: string[];
};

/**
 * Write one component: the JSON document and its companions; companion files of the same
 * component that the new files no longer have are removed (single files, never directories).
 * @param {string} baseDirectory - Project directory.
 * @param {string} workspaceFolder - Workspace API name.
 * @param {SourceFiles} files - Component files.
 * @returns {Promise<WrittenComponent>} Paths and whether anything changed.
 */
export async function writeSourceFiles(
  baseDirectory: string,
  workspaceFolder: string,
  files: SourceFiles,
): Promise<WrittenComponent> {
  const directory = typeDirectory(baseDirectory, workspaceFolder, files.type);
  assertFileName(files.document.apiName, 'API name');
  const stem = `${files.document.apiName}.${files.type}`;
  const wanted = new Map<string, Uint8Array>([
    [`${stem}.json`, Buffer.from(jsonText(files.document), 'utf8')],
  ]);
  for (const [suffix, content] of Object.entries(files.companions)) {
    if (!/^\.[\w.() +-]*[\w()+-]$/u.test(suffix) || suffix === '.json')
      throw new CmsError(
        'INVALID_FILE_NAME',
        `Companion suffix ${JSON.stringify(suffix)} is not usable`,
      );
    wanted.set(
      `${stem}${suffix}`,
      typeof content === 'string' ? Buffer.from(content, 'utf8') : content,
    );
  }
  await mkdir(directory, { recursive: true });
  let changed = false;
  for (const [name, bytes] of wanted) {
    const file = path.join(directory, name);
    const before = await existingBytes(file);
    if (before && sameBytes(before, bytes)) continue;
    await writeFile(file, bytes);
    changed = true;
  }
  for (const name of await readdir(directory)) {
    if (name.startsWith(`${stem}.`) && !wanted.has(name)) {
      await unlink(path.join(directory, name));
      changed = true;
    }
  }
  const [json, ...companions] = [...wanted.keys()].map((name) => path.join(directory, name));
  return { outcome: changed ? 'retrieved' : 'unchanged', path: json, companionPaths: companions };
}

/**
 * Read one component from disk: `<ApiName>.<type>.json` and every `<ApiName>.<type>.*` next to
 * it. Companions with a text suffix (`.html`, `.txt`) are read as UTF-8, others as bytes.
 * @param {string} baseDirectory - Project directory.
 * @param {string} workspaceFolder - Workspace folder name.
 * @param {string} type - CLI type name.
 * @param {string} apiName - Component API name.
 * @returns {Promise<SourceFiles>} Files.
 */
export async function readSourceFiles(
  baseDirectory: string,
  workspaceFolder: string,
  type: string,
  apiName: string,
): Promise<SourceFiles> {
  const directory = typeDirectory(baseDirectory, workspaceFolder, type);
  assertFileName(apiName, 'API name');
  const stem = `${apiName}.${type}`;
  const jsonPath = path.join(directory, `${stem}.json`);
  let document: unknown;
  try {
    document = JSON.parse(await readFile(jsonPath, 'utf8'));
  } catch (error) {
    throw new CmsError('INVALID_SOURCE_FILE', `${jsonPath}: ${(error as Error).message}`);
  }
  if (!isSourceDocument(document) || document.apiName !== apiName)
    throw new CmsError(
      'INVALID_SOURCE_FILE',
      `${jsonPath}: needs apiName ${apiName}, a folderPath array and a contentBody object`,
    );
  const companions: Record<string, string | Uint8Array> = {};
  const names = await readdir(directory);
  for (const name of names.toSorted()) {
    if (!name.startsWith(`${stem}.`) || name === `${stem}.json`) continue;
    const suffix = name.slice(stem.length);
    const bytes = await readFile(path.join(directory, name));
    companions[suffix] = TEXT_SUFFIXES.has(suffix) ? bytes.toString('utf8') : new Uint8Array(bytes);
  }
  return { type, document, companions };
}

/** Companion suffixes read as text. */
export const TEXT_SUFFIXES: ReadonlySet<string> = new Set(['.html', '.txt']);

function isSourceDocument(value: unknown): value is SourceDocument {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.apiName === 'string' &&
    Array.isArray(record.folderPath) &&
    record.folderPath.every((segment) => typeof segment === 'string') &&
    typeof record.contentBody === 'object' &&
    record.contentBody !== null &&
    !Array.isArray(record.contentBody)
  );
}
