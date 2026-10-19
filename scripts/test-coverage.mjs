import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function validateTemp(environment = process.env, actualTemp = tmpdir()) {
  const expected = process.platform === 'win32' ? String.raw`F:\Temp` : tmpdir();
  const normalize = (value) => {
    if (!value || !path.isAbsolute(value)) throw new Error('Temporary path must be absolute');
    const resolved = path.resolve(value).replace(/[\\/]+$/u, '');
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  const values = [environment.TEMP, actualTemp, environment.TMP, environment.TMPDIR];
  if (
    (process.platform === 'win32' && !environment.TEMP) ||
    values.filter(Boolean).some((value) => normalize(value) !== normalize(expected))
  ) {
    throw new Error(`Temporary environment must resolve to ${expected}`);
  }
}

export async function createCoverageRun() {
  validateTemp();
  const root = await mkdtemp(path.join(tmpdir(), 'cms-coverage-'));
  const marker = randomUUID();
  await writeFile(path.join(root, '.sf-cms-run-owner'), marker, { flag: 'wx' });
  const raw = path.join(root, 'raw');
  await mkdir(raw);
  await writeFile(
    path.join(root, 'registered-paths.json'),
    JSON.stringify({ marker, paths: [raw] }),
  );
  return { root, raw };
}

export async function runCommand(args) {
  const child = spawn(process.execPath, args, { stdio: 'inherit' });
  const forward = (signal) => child.kill(signal);
  const interrupt = () => forward('SIGINT');
  const terminate = () => forward('SIGTERM');
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', terminate);
  try {
    return await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => resolve({ code, signal }));
    });
  } finally {
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', terminate);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const run = await createCoverageRun();
  console.error(`Coverage artifacts retained: ${run.root}`);
  const result = await runCommand([
    fileURLToPath(new URL('../node_modules/c8/bin/c8.js', import.meta.url)),
    '--config',
    '.nycrc',
    '--src',
    'src',
    '--all',
    '--exclude-after-remap',
    '--clean=false',
    '--temp-directory',
    run.raw,
    '--reports-dir',
    'coverage',
    '--reporter',
    'json',
    '--reporter',
    'json-summary',
    '--reporter',
    'text',
    '--reporter',
    'text-summary',
    'mocha',
  ]);
  if (result.signal) process.kill(process.pid, result.signal);
  else process.exitCode = result.code ?? 1;
}
