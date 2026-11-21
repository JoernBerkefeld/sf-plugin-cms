import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createInvocationLogger } from '../lib/logging.js';

test('the log file is written under logs/cms of a cwd reached through a junction, secrets redacted', async () => {
  const real = await mkdtemp(path.join(os.tmpdir(), 'sf-plugin-cms-v1-log-'));
  const linked = `${real}-link`;
  // A junction needs no privileges on Windows; elsewhere it is a directory symlink.
  await symlink(real, linked, 'junction');
  const warnings = [];
  const logger = createInvocationLogger({
    cwd: linked,
    argv: ['cms', 'retrieve', '--access-token', '00D000000000001!SECRETTOKENVALUE'],
    startedAt: new Date('2026-01-02T03:04:05.006Z'),
    stderr: (message) => warnings.push(message),
  });
  logger.log('info', 'hello', { authorization: 'Bearer 00D000000000001!SECRETTOKENVALUE' });
  await logger.close();
  await logger.close();
  assert.deepEqual(warnings, []);
  assert.equal(logger.filePath, path.join(linked, 'logs', 'cms', '2026-01-02T03.04.05.006Z.log'));
  assert.deepEqual(await readdir(path.join(real, 'logs', 'cms')), ['2026-01-02T03.04.05.006Z.log']);
  const text = await readFile(logger.filePath, 'utf8');
  assert.match(text, /"message":"hello"/u);
  assert.doesNotMatch(text, /SECRETTOKENVALUE/u);
});
