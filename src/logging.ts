import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import fs from 'node:fs';
import path from 'node:path';
import { Writable } from 'node:stream';
import { createRequire } from 'node:module';
import winston from 'winston';
import { redactLogValue, redactSecrets, redactArgv } from './transport/redact-secrets.js';

export type InvocationLogger = Readonly<{
  filePath: string;
  log: (level: 'debug' | 'info' | 'warn' | 'error', message: string, details?: unknown) => void;
  close: () => Promise<void>;
}>;

export type InvocationLogOptions = Readonly<{
  cwd: string;
  argv: readonly string[];
  startedAt?: Date;
  stderr?: (message: string) => void;
}>;

type InvocationContext = { logger: InvocationLogger; apiEnabled: boolean };
const invocationContext = new AsyncLocalStorage<InvocationContext>();

export function runWithInvocationLogging<T>(
  logger: InvocationLogger,
  task: () => T,
  apiEnabled = false,
): T {
  return invocationContext.run({ logger, apiEnabled }, task);
}

export function enableInvocationApiLogging(): void {
  const context = invocationContext.getStore();
  if (context) context.apiEnabled = true;
}

// Callers own dispatch and correlation. This function only emits sanitized events.
export function logApiEvent(
  phase: 'request' | 'response' | 'error',
  details: {
    requestId: string;
    method: string;
    url: string;
    operationKey: string;
    startedAt: number;
  },
  value?: unknown,
): void {
  try {
    const context = invocationContext.getStore();
    if (!context) return;
    const error =
      phase === 'error'
        ? (value as
            | {
                status?: unknown;
                statusCode?: unknown;
                statusObserved?: boolean;
                response?: { status?: unknown; statusCode?: unknown };
              }
            | undefined)
        : undefined;
    const status =
      error?.statusObserved === false
        ? undefined
        : [
            error?.statusCode,
            error?.status,
            error?.response?.statusCode,
            error?.response?.status,
          ].find((entry) => typeof entry === 'number' && Number.isInteger(entry));
    context.logger.log(
      phase === 'error' ? 'error' : 'debug',
      `CMS JSON ${phase}`,
      redactLogValue({
        ...details,
        elapsedMs: Date.now() - details.startedAt,
        ...(phase === 'request'
          ? {}
          : {
              status: status ?? 'unavailable: parsed SDK boundary did not expose HTTP status',
              rawBody: 'unavailable: parsed SDK boundary does not expose raw body',
            }),
        ...(phase === 'error' ? { error: value } : {}),
        ...(context.apiEnabled && phase === 'request' ? { requestPayload: value ?? null } : {}),
        ...(context.apiEnabled && phase === 'response' ? { parsedResponse: value } : {}),
      }),
    );
  } catch {
    // Diagnostics cannot change a request outcome or trigger a replay.
  }
}

// Check each ancestor separately: recursive mkdir would follow an existing junction.
function prepareDirectory(directory: string): void {
  const parent = path.dirname(directory);
  if (parent !== directory) prepareDirectory(parent);
  try {
    if (parent !== directory) fs.mkdirSync(directory, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const metadata = fs.lstatSync(directory);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error(`Log directory is not a plain directory: ${directory}`);
  }
  if (fs.realpathSync.native(directory).toLowerCase() !== directory.toLowerCase()) {
    throw new Error(`Log directory resolves elsewhere: ${directory}`);
  }
}

/**
 * Creates one invocation-owned file; failures are diagnostic, never command failures.
 * @param {InvocationLogOptions} options - The received invocation tokens and working directory.
 * @returns {InvocationLogger} An isolated logger with an idempotent, bounded close.
 */
export function createInvocationLogger(options: InvocationLogOptions): InvocationLogger {
  const startedAt = options.startedAt ?? new Date();
  const directory = path.resolve(options.cwd, 'logs', 'cms');
  let filePath = path.join(directory, `${startedAt.toISOString().replaceAll(':', '.')}.log`);
  let descriptor: number | undefined;
  let logger: winston.Logger | undefined;
  let failed = false;
  let closing: Promise<void> | undefined;
  const warn = (error: unknown): void => {
    if (failed) return;
    failed = true;
    const text = redactSecrets(`CMS logging incomplete at ${filePath}: ${String(error)}\n`);
    try {
      (options.stderr ?? ((message) => process.stderr.write(message)))(text);
    } catch {
      // A broken stderr must not replace the command's outcome either.
    }
  };
  const release = (): void => {
    const owned = descriptor;
    descriptor = undefined;
    if (owned !== undefined) fs.closeSync(owned);
  };
  const log: InvocationLogger['log'] = (level, message, details) => {
    if (failed || closing || !logger) return;
    try {
      logger.log(level, redactSecrets(message), { details: redactLogValue(details) });
    } catch (error) {
      warn(error);
    }
  };
  try {
    prepareDirectory(directory);
    // Exclusive create arbitrates collisions across processes, without suffixes or append.
    for (let offset = 0; ; offset++) {
      filePath = path.join(
        directory,
        `${new Date(startedAt.getTime() + offset).toISOString().replaceAll(':', '.')}.log`,
      );
      try {
        descriptor = fs.openSync(filePath, 'wx', 0o600);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        if (fs.lstatSync(filePath).isSymbolicLink()) throw new Error('Log target is a link');
      }
    }
    const metadata = fs.fstatSync(descriptor);
    if (
      !metadata.isFile() ||
      metadata.nlink !== 1 ||
      (process.getuid && metadata.uid !== process.getuid())
    ) {
      throw new Error('Log file ownership could not be established');
    }
    const sink = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        try {
          if (descriptor === undefined) throw new Error('Log file is closed');
          let offset = 0;
          while (offset < chunk.length) {
            const written = fs.writeSync(descriptor, chunk, offset);
            if (written === 0) throw new Error('Log write made no progress');
            offset += written;
          }
          callback();
        } catch (error) {
          warn(error);
          callback();
        }
      },
    });
    logger = winston.createLogger({
      level: 'debug',
      format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
      transports: [new winston.transports.Stream({ stream: sink })],
    });
    logger.on('error', warn);
    const version = (createRequire(import.meta.url)('../package.json') as { version: string })
      .version;
    log('info', `sf-plugin-cms ${version}`);
    const argv = redactArgv(options.argv);
    log('info', 'invocation', {
      argv,
      renderedCommand: argv.map((token) => JSON.stringify(token)).join(' '),
      cwd: options.cwd,
      invocationId: randomUUID(),
      startedAt: startedAt.toISOString(),
    });
  } catch (error) {
    warn(error);
    try {
      release();
    } catch (closeError) {
      warn(closeError);
    }
  }
  return {
    get filePath() {
      return filePath;
    },
    log,
    close() {
      closing ??= new Promise<void>((resolve) => {
        let done = false;
        const finish = (): void => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          try {
            if (descriptor !== undefined) fs.fsyncSync(descriptor);
          } catch (error) {
            warn(error);
          }
          try {
            release();
          } catch (error) {
            warn(error);
          }
          try {
            logger?.close();
          } catch (error) {
            warn(error);
          }
          resolve();
        };
        const timer = setTimeout(() => {
          warn(new Error('Log flush timed out'));
          finish();
        }, 2000);
        if (logger) {
          logger.once('finish', finish);
          try {
            logger.end();
          } catch (error) {
            warn(error);
            finish();
          }
        } else {
          finish();
        }
      });
      return closing;
    },
  };
}
