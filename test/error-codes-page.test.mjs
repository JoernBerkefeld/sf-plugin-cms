import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { errorCodeInfo, registeredErrorCodes } from '../lib/errors/registry.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('docs/errors.md lists every registered code with its hint', () => {
  const page = readFileSync(path.join(root, 'docs', 'errors.md'), 'utf8');
  for (const code of registeredErrorCodes()) {
    const row = page.split('\n').find((line) => line.startsWith(`| \`${code}\``));
    assert.ok(row, `${code} is missing from docs/errors.md`);
    assert.ok(row.includes(errorCodeInfo(code).hint.replaceAll('|', String.raw`\|`)), code);
  }
});
