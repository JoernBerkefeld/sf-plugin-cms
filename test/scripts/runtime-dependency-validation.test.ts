import { expect } from 'chai';
import { lstat, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  createRunOwnedDirectory,
  createRunOwnedTemp,
  removeRunOwnedPath,
} from '../../src/filesystem/runOwnedTemp.js';
import {
  validateRuntimeDependencyTree,
  type DependencyNode,
} from '../../scripts/runtime-dependency-validation.mjs';

describe('packed runtime dependency validation', () => {
  it('rejects incompatible engines and non-optional npm-ls problems', async () => {
    const run = await createRunOwnedTemp('cms-runtime-tree-test');
    const temporaryRoot = await createRunOwnedDirectory(run, 'fixture');
    try {
      const jsforcePath = await writePackage(
        temporaryRoot,
        '@jsforce/jsforce-node',
        '3.10.16',
        '>=18',
        {
          optionalDependencies: { 'optional-native': '^1.0.0' },
        },
      );
      const incompatiblePath = await writePackage(temporaryRoot, 'future-only', '1.2.3', '>=24');
      const baseTree = {
        problems: ['missing: optional-native@^1.0.0, required by @jsforce/jsforce-node@3.10.16'],
        dependencies: {
          '@jsforce/jsforce-node': { path: jsforcePath, version: '3.10.16' },
        },
      };

      await validateRuntimeDependencyTree(baseTree);
      await expectValidationError(
        {
          ...baseTree,
          problems: ['missing: required-package@^1.0.0, required by @jsforce/jsforce-node@3.10.16'],
        },
        'npm ls reported runtime tree problems:',
      );
      await expectValidationError(
        {
          ...baseTree,
          dependencies: {
            ...baseTree.dependencies,
            'future-only': { path: incompatiblePath, version: '1.2.3' },
          },
        },
        'future-only@1.2.3 has Node engine ">=24" excluding supported Node >=22.19 <25',
      );
    } finally {
      await removeRunOwnedPath(run, temporaryRoot);
      await lstat(temporaryRoot).then(
        () => expect.fail('fixture should have been removed'),
        (error: NodeJS.ErrnoException) => expect(error.code).to.equal('ENOENT'),
      );
      const rootMetadata = await lstat(run.root);
      expect(rootMetadata.isDirectory()).to.equal(true);
    }
  });
});

async function expectValidationError(tree: DependencyNode, expected: string): Promise<void> {
  let message = '';
  try {
    await validateRuntimeDependencyTree(tree);
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  expect(message).to.include(expected);
}

async function writePackage(
  root: string,
  name: string,
  version: string,
  nodeEngine: string,
  extra: Record<string, unknown> = {},
): Promise<string> {
  const packagePath = path.join(root, ...name.split('/'));
  await mkdir(packagePath, { recursive: true });
  await writeFile(
    path.join(packagePath, 'package.json'),
    `${JSON.stringify({ name, version, engines: { node: nodeEngine }, ...extra }, null, 2)}\n`,
  );
  return packagePath;
}
