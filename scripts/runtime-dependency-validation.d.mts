export interface DependencyNode {
  dependencyName?: string;
  dependencies?: Record<string, DependencyNode>;
  path?: string;
  problems?: string[];
  version?: string;
}

export interface InstalledRuntimeNode extends DependencyNode {
  dependencyName: string;
  path: string;
}

export function collectInstalledRuntimeNodes(tree: DependencyNode): InstalledRuntimeNode[];
export function nodeRangeSupportsRuntime(range: unknown): boolean;
export function validateRuntimeDependencyTree(
  tree: DependencyNode,
): Promise<{ nodeCount: number; uniquePackageVersions: number }>;
