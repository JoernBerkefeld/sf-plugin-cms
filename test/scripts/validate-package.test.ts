import { execFile } from 'node:child_process';
import { lstat, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect } from 'chai';
import {
  createRunOwnedDirectory,
  createRunOwnedTemp,
  removeRunOwnedPath,
} from '../../src/filesystem/runOwnedTemp.js';

const execute = promisify(execFile);
const packageRoot = fileURLToPath(new URL('../../', import.meta.url));
const syntheticNpm = String.raw`
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
const args = process.argv.slice(2);
await appendFile(process.env.CMS_VALIDATOR_LOG, JSON.stringify({ args, cwd: process.cwd() }) + '\n');
if (args[0] === process.env.CMS_VALIDATOR_FAILURE) {
  console.error('synthetic npm failure');
  process.exit(1);
}
if (args[0] === 'pack') {
  const directory = args[args.indexOf('--pack-destination') + 1];
  await writeFile(path.join(directory, 'fixture.tgz'), 'synthetic tarball');
}
if (args[0] === 'install') {
  const directory = path.join(process.cwd(), 'jsforce-fixture');
  await mkdir(directory);
  await writeFile(path.join(directory, 'package.json'), JSON.stringify({
    name: '@jsforce/jsforce-node', version: '3.10.16', engines: { node: '>=18' }
  }));
}
if (args[0] === 'ls') {
  console.log(JSON.stringify({ dependencies: {
    '@jsforce/jsforce-node': { path: path.join(process.cwd(), 'jsforce-fixture'), version: '3.10.16' }
  } }));
}
`;

type Invocation = { args: string[]; cwd: string };

async function expectMissing(target: string): Promise<void> {
  await lstat(target).then(
    () => expect.fail('registered fixture should have been removed'),
    (error: NodeJS.ErrnoException) => expect(error.code).to.equal('ENOENT'),
  );
}

describe('package validator owned-run cleanup', () => {
  for (const failure of ['', 'pack', 'install']) {
    it(`removes only its registered child after ${failure || 'successful validation'}`, async () => {
      const run = await createRunOwnedTemp('cms-validator-test');
      const fixture = await createRunOwnedDirectory(run, 'fixture');
      const runner = path.join(fixture, 'npm-fixture.mjs');
      const log = path.join(fixture, 'invocations.jsonl');
      await writeFile(runner, syntheticNpm);
      try {
        let stdout = '';
        let error: unknown;
        try {
          ({ stdout } = await execute(process.execPath, ['scripts/validate-package.mjs'], {
            cwd: packageRoot,
            env: {
              ...process.env,
              npm_execpath: runner,
              CMS_VALIDATOR_LOG: log,
              CMS_VALIDATOR_FAILURE: failure,
            },
            windowsHide: true,
          }));
        } catch (error_) {
          error = error_;
        }
        const logContents = await readFile(log, 'utf8');
        const invocations = logContents
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line) as Invocation);
        const pack = invocations.find(({ args }) => args[0] === 'pack');
        expect(pack).not.to.equal(undefined);
        const packDirectory = pack!.args[pack!.args.indexOf('--pack-destination') + 1];
        const validatorFixture = path.dirname(packDirectory);
        const validatorRoot = path.dirname(validatorFixture);
        expect(path.basename(validatorFixture)).to.equal('fixture');
        expect(path.basename(packDirectory)).to.equal('pack');
        await expectMissing(validatorFixture);
        const retainedRoot = await lstat(validatorRoot);
        expect(retainedRoot.isDirectory()).to.equal(true);
        expect(await readFile(path.join(validatorRoot, '.sf-cms-run-owner'), 'utf8')).to.match(
          /^[\da-f-]{36}$/u,
        );
        if (failure) {
          expect(error).to.be.instanceOf(Error);
          expect(String(error)).to.include('synthetic npm failure');
          expect(invocations.map(({ args }) => args[0])).to.deep.equal(
            failure === 'pack' ? ['run', 'pack'] : ['run', 'pack', 'install'],
          );
        } else {
          expect(error).to.equal(undefined);
          expect(stdout).to.include('package metadata and packed consumer valid');
          expect(invocations.map(({ args }) => args[0])).to.deep.equal([
            'run',
            'pack',
            'install',
            'ls',
          ]);
          const install = invocations.find(({ args }) => args[0] === 'install')!;
          expect(install.cwd).to.equal(path.join(validatorFixture, 'consumer'));
          expect(install.args).to.deep.equal([
            'install',
            '--ignore-scripts',
            '--no-audit',
            '--no-fund',
            path.join(packDirectory, 'fixture.tgz'),
          ]);
        }
      } finally {
        await removeRunOwnedPath(run, fixture);
        await expectMissing(fixture);
        const retainedRoot = await lstat(run.root);
        expect(retainedRoot.isDirectory()).to.equal(true);
      }
    });
  }
});
