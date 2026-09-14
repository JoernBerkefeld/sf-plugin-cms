import { createRequire } from 'node:module';
import { rename, rm } from 'node:fs/promises';

export type AtomicPublishOptions = {
  readonly delay?: (milliseconds: number) => Promise<void>;
  readonly platform?: NodeJS.Platform;
  readonly renamePath?: typeof rename;
};

export type CleanupOptions = {
  readonly removePath?: typeof rm;
};

export type DirectoryPublishOptions = AtomicPublishOptions & {
  readonly publishPath?: (temporary: string, destination: string) => Promise<void>;
};

const windowsRenameRetryDelays = [10, 25, 50] as const;
const require = createRequire(import.meta.url);
const runtimeReport = process.report.getReport() as {
  readonly header?: { readonly glibcVersionRuntime?: string };
};
const linuxLibc = runtimeReport.header?.glibcVersionRuntime === undefined ? 'musl' : 'gnu';
const nativeNoReplacePackages: Partial<Record<NodeJS.Platform, Partial<Record<string, string>>>> = {
  darwin: {
    arm64: '@skill-steward/rename-noreplace-darwin-arm64',
    x64: '@skill-steward/rename-noreplace-darwin-x64',
  },
  linux: {
    arm64: `@skill-steward/rename-noreplace-linux-arm64-${linuxLibc}`,
    x64: `@skill-steward/rename-noreplace-linux-x64-${linuxLibc}`,
  },
};

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string'
    ? error.code
    : undefined;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

async function renameWithNarrowWindowsRetry(
  temporary: string,
  destination: string,
  options: AtomicPublishOptions,
): Promise<void> {
  const renamePath = options.renamePath ?? rename;
  const wait = options.delay ?? delay;
  for (let attempt = 0; ; attempt += 1) {
    try {
      await renamePath(temporary, destination);
      return;
    } catch (error) {
      const retryDelay = windowsRenameRetryDelays[attempt];
      const code = errorCode(error);
      if (
        (options.platform ?? process.platform) !== 'win32' ||
        (code !== 'EPERM' && code !== 'EBUSY') ||
        retryDelay === undefined
      ) {
        throw error;
      }
      await wait(retryDelay);
    }
  }
}

export async function replaceFileByAtomicRename(
  temporary: string,
  destination: string,
  options: AtomicPublishOptions = {},
): Promise<void> {
  await renameWithNarrowWindowsRetry(temporary, destination, options);
}

function nativeDirectoryPublisher(): (temporary: string, destination: string) => Promise<void> {
  if (process.platform === 'win32') return rename;
  const packageName = nativeNoReplacePackages[process.platform]?.[process.arch];
  if (packageName === undefined) {
    throw new Error(
      `Atomic no-clobber directory publication is unsupported on ${process.platform}/${process.arch}`,
    );
  }
  const binding = require(packageName) as
    | ((temporary: string, destination: string) => void)
    | { readonly renameNoReplace?: (temporary: string, destination: string) => void };
  const renameNoReplace = typeof binding === 'function' ? binding : binding.renameNoReplace;
  if (renameNoReplace === undefined) {
    throw new TypeError(`${packageName} does not export renameNoReplace`);
  }
  return async (temporary, destination) => renameNoReplace(temporary, destination);
}

export async function publishDirectoryNoClobber(
  temporary: string,
  destination: string,
  options: DirectoryPublishOptions = {},
): Promise<void> {
  const publishPath = options.publishPath ?? options.renamePath ?? nativeDirectoryPublisher();
  await renameWithNarrowWindowsRetry(temporary, destination, {
    ...options,
    renamePath: publishPath as typeof rename,
  });
}

export async function cleanupOwnedPath(
  ownedPath: string,
  primaryError: unknown,
  options: CleanupOptions = {},
): Promise<never> {
  try {
    await (options.removePath ?? rm)(ownedPath, { force: true, recursive: true });
  } catch (cleanupError) {
    try {
      if (
        typeof primaryError === 'object' &&
        primaryError !== null &&
        Object.isExtensible(primaryError)
      ) {
        Object.defineProperty(primaryError, 'cleanupError', {
          configurable: true,
          enumerable: false,
          value: cleanupError,
        });
      }
    } catch {
      // Preserve the primary publication error even when diagnostics cannot be attached.
    }
  }
  throw primaryError;
}
