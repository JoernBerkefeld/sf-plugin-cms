import { expect } from 'chai';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  collectInstalledRuntimeNodes,
  nodeRangeSupportsRuntime,
  validateRuntimeDependencyTree,
  type DependencyNode,
} from '../../scripts/runtime-dependency-validation.mjs';

describe('packed runtime dependency validation', () => {
  it('evaluates Node engine ranges with semver', () => {
    expect(nodeRangeSupportsRuntime('>=18')).to.equal(true);
    expect(nodeRangeSupportsRuntime('>=22')).to.equal(true);
    expect(nodeRangeSupportsRuntime('>=22.19 <25')).to.equal(true);
    expect(nodeRangeSupportsRuntime('>=24')).to.equal(false);
    expect(nodeRangeSupportsRuntime('<22.19')).to.equal(false);
    expect(nodeRangeSupportsRuntime('not a range')).to.equal(false);
  });

  it('traverses aliases, deduped paths, and cycles once', () => {
    const shared = { path: 'C:/consumer/node_modules/shared', version: '1.0.0', dependencies: {} };
    type FixtureNode = {
      path: string;
      version: string;
      dependencies: Record<string, FixtureNode>;
    };
    const alias: FixtureNode = {
      path: 'C:/consumer/node_modules/alias',
      version: '2.0.0',
      dependencies: { shared },
    };
    alias.dependencies.cycle = alias;
    const tree = { dependencies: { alias, duplicate: shared } };

    expect(
      collectInstalledRuntimeNodes(tree).map(({ dependencyName }) => dependencyName),
    ).to.deep.equal(['alias', 'shared']);
  });

  it('rejects incompatible engines and non-optional npm-ls problems', async () => {
    const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'runtime-tree-test-'));
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
      await rm(temporaryRoot, { recursive: true, force: true });
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
