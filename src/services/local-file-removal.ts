import { lstat, realpath, unlink } from 'node:fs/promises';
import path from 'node:path';

/** What happened to one local file after a confirmed deletion. */
export type LocalFileRemoval = {
  path: string;
  outcome: 'removed' | 'not-present' | 'kept' | 'failed';
  code?: string;
};

/**
 * A project file a confirmed deletion makes obsolete. `boundary` is either a folder the file has
 * to lie strictly inside (the project's cms folder) or, with `exact`, the one file that may
 * be removed (an explicitly given --source-dir member).
 */
export type LocalFileCandidate = { path: string; boundary: string; exact?: true };

/**
 * Compare absolute paths the way the file system does.
 * @param {string} left One absolute path.
 * @param {string} right Another absolute path.
 * @returns {boolean} Whether both name the same location.
 */
export function samePath(left: string, right: string): boolean {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/**
 * Whether a file lies within its boundary: strictly inside the folder, or the exact file.
 * @param {LocalFileCandidate} candidate File and boundary.
 * @returns {boolean} Whether the file may be considered at all.
 */
function withinBoundary(candidate: LocalFileCandidate): boolean {
  const file = path.resolve(candidate.path);
  if (candidate.exact) return samePath(file, candidate.boundary);
  const relative = path.relative(path.resolve(candidate.boundary), file);
  return relative !== '' && !path.isAbsolute(relative) && !relative.split(/[\\/]/u).includes('..');
}

/**
 * Report a local file that is kept, without touching it.
 * @param {string} file Exact path.
 * @returns {Promise<LocalFileRemoval>} Kept, or not present.
 */
async function keep(file: string): Promise<LocalFileRemoval> {
  try {
    await lstat(file);
    return { path: file, outcome: 'kept' };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return { path: file, outcome: 'not-present' };
    return { path: file, outcome: 'kept' };
  }
}

/**
 * Remove one regular file with a single unlink. Directories, symbolic links, junctions, files
 * reached through a linked folder, hard-linked files and anything outside the boundary are
 * refused; nothing is ever removed recursively.
 * @param {LocalFileCandidate} candidate File and boundary.
 * @returns {Promise<LocalFileRemoval>} What happened to the file.
 */
async function removeOne(candidate: LocalFileCandidate): Promise<LocalFileRemoval> {
  const file = path.resolve(candidate.path);
  if (!withinBoundary(candidate)) return { path: file, outcome: 'failed', code: 'UNSAFE_PATH' };
  try {
    let stat;
    try {
      stat = await lstat(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        return { path: file, outcome: 'not-present' };
      throw error;
    }
    // A link resolves elsewhere: the real path of a regular file in a real folder is itself.
    if (!stat.isFile() || stat.nlink !== 1 || !samePath(await realpath(file), file))
      return { path: file, outcome: 'failed', code: 'UNSAFE_PATH' };
    await unlink(file);
    return { path: file, outcome: 'removed' };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return {
      path: file,
      outcome: 'failed',
      code: typeof code === 'string' && /^E[A-Z]+$/u.test(code) ? code : 'REMOVE_FAILED',
    };
  }
}

/**
 * Remove the local files of a confirmed deletion, one by one; a failure is reported, never thrown.
 * @param {LocalFileCandidate[]} candidates Files and their boundaries.
 * @param {boolean} keepFiles --keep-local-files: report the files as kept instead.
 * @returns {Promise<LocalFileRemoval[]>} One outcome per file.
 */
export async function removeLocalFiles(
  candidates: LocalFileCandidate[],
  keepFiles: boolean,
): Promise<LocalFileRemoval[]> {
  const results: LocalFileRemoval[] = [];
  for (const candidate of candidates)
    results.push(keepFiles ? await keep(path.resolve(candidate.path)) : await removeOne(candidate));
  return results;
}

/**
 * Say whether a local file exists, for a preview; only a confirmed absence reads as absent.
 * @param {string} file Exact path.
 * @returns {Promise<boolean>} Whether the file is there.
 */
export async function localFilePresent(file: string): Promise<boolean> {
  try {
    await lstat(file);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ENOENT';
  }
}
