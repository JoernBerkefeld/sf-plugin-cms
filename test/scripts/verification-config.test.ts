import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect } from 'chai';

const require = createRequire(import.meta.url);
const execute = promisify(execFile);
const packageRoot = fileURLToPath(new URL('../../', import.meta.url));

describe('Windows-safe verification configuration', () => {
  it('lets Node resolve the loader package without Mocha converting it to a drive path', () => {
    const config = require('../../.mocharc.cjs') as Record<string, unknown>;
    expect(config['node-option']).to.deep.equal(['loader=ts-node/esm']);
    expect(config).not.to.have.property('loader');
  });

  it('loads TypeScript tests with the configured Node option without executing hooks', async function () {
    this.timeout(60_000);
    const config = require('../../.mocharc.cjs') as { 'node-option': string[] };
    const { stdout } = await execute(
      process.execPath,
      [
        require.resolve('mocha/bin/mocha.js'),
        '--no-config',
        '--node-option',
        config['node-option'][0],
        '--dry-run',
        'test/scripts/verification-config.test.ts',
      ],
      { cwd: packageRoot, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
    );
    expect(stdout).to.include('Windows-safe verification configuration');
    expect(stdout).not.to.include('failing');
  });
});
