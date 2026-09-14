import type { Config } from '@oclif/core';
import { readFileSync } from 'node:fs';

const PLUGIN_NAME = 'sf-plugin-cms';
let packageVersion: string | undefined;

export function getPluginVersion(config?: Config): string {
  const configuredVersion = config?.plugins.get(PLUGIN_NAME)?.version;
  if (configuredVersion !== undefined && configuredVersion.length > 0) return configuredVersion;

  packageVersion ??= readPackageVersion();
  return packageVersion;
}

function readPackageVersion(): string {
  const packageJson = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  ) as { name?: unknown; version?: unknown };
  if (packageJson.name !== PLUGIN_NAME || typeof packageJson.version !== 'string') {
    throw new Error(`${PLUGIN_NAME} runtime package metadata is invalid.`);
  }
  return packageJson.version;
}
