import { readFile } from 'node:fs/promises';
import path from 'node:path';
import semver from 'semver';

const supportedNodeRange = '>=22.19 <25';

export function collectInstalledRuntimeNodes(tree) {
  const nodes = [];
  const visitedPaths = new Set();
  const activeNodes = new Set();

  function visit(node, dependencyName) {
    if (!node || typeof node !== 'object' || activeNodes.has(node)) return;

    const nodePath = typeof node.path === 'string' ? path.resolve(node.path) : undefined;
    if (nodePath && visitedPaths.has(nodePath)) return;
    if (nodePath) visitedPaths.add(nodePath);

    activeNodes.add(node);
    if (dependencyName && nodePath) nodes.push({ ...node, dependencyName, path: nodePath });
    for (const [name, dependency] of Object.entries(node.dependencies ?? {}))
      visit(dependency, name);
    activeNodes.delete(node);
  }

  visit(tree);
  return nodes;
}

export function nodeRangeSupportsRuntime(range) {
  if (typeof range !== 'string' || range.trim() === '') return true;
  try {
    return semver.subset(supportedNodeRange, range, { includePrerelease: true });
  } catch {
    return false;
  }
}

export async function validateRuntimeDependencyTree(tree) {
  const nodes = collectInstalledRuntimeNodes(tree);
  const nodesByIdentity = new Map();

  for (const node of nodes) {
    const metadata = JSON.parse(await readFile(path.join(node.path, 'package.json'), 'utf8'));
    const name = metadata.name ?? node.dependencyName;
    const version = metadata.version ?? node.version ?? 'unknown';
    const identity = `${name}@${version}`;
    const engineRange = metadata.engines?.node;
    nodesByIdentity.set(identity, { metadata, node });

    if (!nodeRangeSupportsRuntime(engineRange)) {
      throw new Error(
        `${identity} has Node engine ${JSON.stringify(engineRange)} excluding supported Node >=22.19 <25`,
      );
    }
  }

  validateNpmLsProblems(collectTreeProblems(tree), nodesByIdentity);

  const jsforceNodes = nodes.filter((node) => node.dependencyName === '@jsforce/jsforce-node');
  if (jsforceNodes.length === 0)
    throw new Error('packed consumer has no jsforce runtime dependency');
  for (const node of jsforceNodes) {
    const metadata = JSON.parse(await readFile(path.join(node.path, 'package.json'), 'utf8'));
    const version = metadata.version ?? node.version ?? 'unknown';
    if (version !== '3.10.16') {
      throw new Error(
        `packed consumer resolved @jsforce/jsforce-node@${version}; expected exactly 3.10.16`,
      );
    }
    if (!nodeRangeSupportsRuntime(metadata.engines?.node)) {
      throw new Error(
        `@jsforce/jsforce-node@${version} has Node engine ${JSON.stringify(metadata.engines?.node)} excluding supported Node >=22.19 <25`,
      );
    }
  }

  return { nodeCount: nodes.length, uniquePackageVersions: nodesByIdentity.size };
}

function collectTreeProblems(tree) {
  const problems = [];
  const visited = new Set();

  function visit(node) {
    if (!node || typeof node !== 'object' || visited.has(node)) return;
    visited.add(node);
    problems.push(...(node.problems ?? []));
    for (const dependency of Object.values(node.dependencies ?? {})) visit(dependency);
  }

  visit(tree);
  return [...new Set(problems)];
}

function validateNpmLsProblems(problems, nodesByIdentity) {
  const unexpected = problems.filter(
    (problem) => !isLegitimateOptionalOmission(problem, nodesByIdentity),
  );
  if (unexpected.length > 0) {
    throw new Error(`npm ls reported runtime tree problems:\n${unexpected.join('\n')}`);
  }
}

function isLegitimateOptionalOmission(problem, nodesByIdentity) {
  const match = /^missing: (.+)@([^,]+), required by (.+)@(.+)$/.exec(problem);
  if (!match) return false;

  const [, missingName, requestedRange, parentName, parentVersion] = match;
  const parent = nodesByIdentity.get(`${parentName}@${parentVersion}`);
  return parent?.metadata.optionalDependencies?.[missingName] === requestedRange;
}
