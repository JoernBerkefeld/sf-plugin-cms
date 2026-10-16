import path from 'node:path';
import { lstat, mkdir, readdir, unlink, writeFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { SOURCE_EMAIL_PROFILES } from '../contracts/source-definition.js';
import {
  assertEditableItemDefinitionV2,
  reassembleEditableItemSourceV2,
  type EditableItemProjectionV2,
} from './editable-item-source-v2.js';
import { assertEditableDirectoryPath } from './editable-raw-html-export.js';
import { readStableRegularFile } from './import-workspace.js';
import { strictSourceJson } from './source-definition-import.js';

export type ItemSourceWriteReceipt = {
  definitionPath: string;
  created: string[];
  updated: string[];
  unchanged: string[];
  removed: string[];
};

async function existing(directory: string, name: string): Promise<Buffer | undefined> {
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  const matches = entries.filter((entry) => entry.toLowerCase() === name.toLowerCase());
  if (matches.length === 0) return undefined;
  if (matches.length !== 1 || matches[0] !== name)
    throw new TypeError(`Selected item filename is case-aliased: ${name}`);
  const target = path.join(directory, name);
  const information = await lstat(target);
  if (information.nlink !== 1)
    throw new TypeError(`Selected item file must not be hard-linked: ${name}`);
  return readStableRegularFile(target, 'Selected item file');
}

/**
 * Incrementally write one selected item after preflighting all of its exact files.
 * This is not a multi-file transaction; filesystem failures may leave partial progress.
 * @param {string} projectRoot - Explicit project output root, existing or new.
 * @param {string} directory - Exact portable cms/workspace/type directory.
 * @param {EditableItemProjectionV2} projection - Validated definition and companion bytes.
 * @param {boolean} overwrite - Explicit permission to replace differing selected files.
 * @returns {Promise<ItemSourceWriteReceipt>} Absolute paths grouped by actual operation, without timestamps.
 */
export async function writeEditableItemSource(
  projectRoot: string,
  directory: string,
  projection: EditableItemProjectionV2,
  overwrite: boolean,
): Promise<ItemSourceWriteReceipt> {
  // Detach inputs before the first asynchronous filesystem operation.
  const definition = strictSourceJson(projection.definitionBytes, 'Selected item JSON');
  assertEditableItemDefinitionV2(definition);
  if (!isDeepStrictEqual(definition, projection.definition))
    throw new TypeError('Selected item projection definition/bytes disagree');
  const profile = SOURCE_EMAIL_PROFILES.find(
    (entry) => entry.contentType === definition.contentType,
  )!;
  const base = `${definition.identity.apiName}.cms-${profile.token}`;
  if (
    directory !== `cms/${definition.identity.context.workspaceApiName}/${profile.directory}` ||
    projection.definitionName !== `${base}.json`
  )
    throw new TypeError('Selected item directory/filename conflicts with its identity/type');
  if (
    !isDeepStrictEqual(
      projection.companions.map(({ role, path: name }) => ({ role, path: name })),
      definition.companions,
    )
  )
    throw new TypeError('Selected item projection companion bindings disagree');
  const files = new Map([
    [projection.definitionName, Buffer.from(projection.definitionBytes)],
    ...projection.companions.map(({ path: name, bytes }) => [name, Buffer.from(bytes)] as const),
  ]);
  reassembleEditableItemSourceV2(
    definition,
    new Map([...files].filter(([name]) => name !== projection.definitionName)),
  );
  await assertEditableDirectoryPath(projectRoot, false);
  const destination = path.join(path.resolve(projectRoot), ...directory.split('/'));
  await assertEditableDirectoryPath(destination, false);
  const before = new Map<string, Buffer | undefined>();
  for (const name of files.keys()) before.set(name, await existing(destination, name));
  const previousBytes = before.get(projection.definitionName);
  let previous;
  if (previousBytes !== undefined) {
    previous = strictSourceJson(previousBytes, 'Prior selected-item ownership definition');
    assertEditableItemDefinitionV2(previous);
    if (
      !isDeepStrictEqual(previous.identity, definition.identity) ||
      previous.contentType !== definition.contentType ||
      previous.language !== definition.language
    )
      throw new TypeError('Prior selected-item definition has an identity/type/language conflict');
  }
  // The only currently optional companion has one exact recognized filename.
  const textName = `${base}.txt`;
  const obsolete: string[] = [];
  if (!files.has(textName)) {
    const bytes = await existing(destination, textName);
    if (bytes !== undefined) {
      if (!previous?.companions.some((entry) => entry.path === textName))
        throw new TypeError(`Ambiguous obsolete companion ownership: ${textName}`);
      before.set(textName, bytes);
      obsolete.push(textName);
    }
  }
  for (const [name, bytes] of files) {
    const prior = before.get(name);
    if (prior !== undefined && !prior.equals(bytes) && !overwrite)
      throw new TypeError(`Selected item differs; explicit overwrite is required: ${name}`);
  }
  if (obsolete.length > 0 && !overwrite)
    throw new TypeError('Obsolete selected-item companions require explicit overwrite');

  // Recheck every preflighted file before making the first change.
  await assertEditableDirectoryPath(destination, false);
  for (const [name, bytes] of before) {
    const current = await existing(destination, name);
    if (bytes === undefined ? current !== undefined : !current?.equals(bytes))
      throw new TypeError(`Selected item changed during preflight: ${name}`);
  }
  const receipt: ItemSourceWriteReceipt = {
    definitionPath: path.join(destination, projection.definitionName),
    created: [],
    updated: [],
    unchanged: [],
    removed: [],
  };
  await mkdir(destination, { recursive: true });
  await assertEditableDirectoryPath(destination, false);
  // Publish the definition last so a failure never advertises unfinished companions as complete.
  const ordered = [...files].toSorted(
    ([left], [right]) =>
      Number(left === projection.definitionName) - Number(right === projection.definitionName),
  );
  for (const [name, bytes] of ordered) {
    const target = path.join(destination, name);
    const prior = before.get(name);
    if (prior?.equals(bytes)) receipt.unchanged.push(target);
    else {
      await writeFile(target, bytes, { flag: prior === undefined ? 'wx' : 'w' });
      receipt[prior === undefined ? 'created' : 'updated'].push(target);
    }
  }
  for (const name of obsolete) {
    await assertEditableDirectoryPath(destination, false);
    const current = await existing(destination, name);
    if (!current?.equals(before.get(name)!))
      throw new TypeError(`Obsolete selected-item companion changed: ${name}`);
    await unlink(path.join(destination, name));
    receipt.removed.push(path.join(destination, name));
  }
  return receipt;
}
