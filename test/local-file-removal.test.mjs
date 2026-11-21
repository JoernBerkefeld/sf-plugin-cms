import assert from 'node:assert/strict';
import { link, mkdir, mkdtemp, readdir, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { removeLocalFiles } from '../lib/services/local-file-removal.js';

async function project() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sf-plugin-cms-v1-removal-'));
  const cms = path.join(directory, 'cms');
  await mkdir(path.join(cms, 'WS', 'email'), { recursive: true });
  return { directory, cms, folder: path.join(cms, 'WS', 'email') };
}

const outcomes = (removals) =>
  removals.map((file) => [path.basename(file.path), file.outcome, file.code]);

test('a file outside cms/ is refused as UNSAFE_PATH and stays', async () => {
  const { directory, cms } = await project();
  const outside = path.join(directory, 'Outside.email.json');
  await writeFile(outside, '{}\n');
  const removals = await removeLocalFiles(
    [
      { path: outside, boundary: cms },
      { path: path.join(cms, '..', 'Outside.email.json'), boundary: cms },
      { path: cms, boundary: cms },
    ],
    false,
  );
  assert.deepEqual(outcomes(removals), [
    ['Outside.email.json', 'failed', 'UNSAFE_PATH'],
    ['Outside.email.json', 'failed', 'UNSAFE_PATH'],
    ['cms', 'failed', 'UNSAFE_PATH'],
  ]);
  const left = await readdir(directory);
  assert.deepEqual(left.toSorted(), ['Outside.email.json', 'cms'].toSorted());
});

test('a hard-linked file is refused as UNSAFE_PATH and both names stay', async () => {
  const { directory, cms, folder } = await project();
  const original = path.join(directory, 'original.json');
  await writeFile(original, '{}\n');
  const linked = path.join(folder, 'One.email.json');
  await link(original, linked);
  const removals = await removeLocalFiles([{ path: linked, boundary: cms }], false);
  assert.deepEqual(outcomes(removals), [['One.email.json', 'failed', 'UNSAFE_PATH']]);
  assert.deepEqual(await readdir(folder), ['One.email.json']);
});

test('a file reached through a junction or symbolic link is refused as UNSAFE_PATH', async (t) => {
  const { directory, cms, folder } = await project();
  const elsewhere = path.join(directory, 'elsewhere');
  await mkdir(elsewhere);
  await writeFile(path.join(elsewhere, 'One.email.json'), '{}\n');
  // A junction needs no privileges on Windows; elsewhere it is a directory symlink.
  await symlink(elsewhere, path.join(cms, 'Linked'), 'junction');
  const throughLink = path.join(cms, 'Linked', 'One.email.json');
  assert.deepEqual(
    outcomes(await removeLocalFiles([{ path: throughLink, boundary: cms }], false)),
    [['One.email.json', 'failed', 'UNSAFE_PATH']],
  );
  assert.deepEqual(await readdir(elsewhere), ['One.email.json']);

  const fileLink = path.join(folder, 'Two.email.json');
  try {
    await symlink(path.join(elsewhere, 'One.email.json'), fileLink, 'file');
  } catch (error) {
    if (process.platform === 'win32' && error.code === 'EPERM') {
      t.skip('creating a file symlink needs Developer Mode or admin rights on Windows');
      return;
    }
    throw error;
  }
  assert.deepEqual(outcomes(await removeLocalFiles([{ path: fileLink, boundary: cms }], false)), [
    ['Two.email.json', 'failed', 'UNSAFE_PATH'],
  ]);
  assert.deepEqual(await readdir(folder), ['Two.email.json']);
});
