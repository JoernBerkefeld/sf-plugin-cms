import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import fs from 'node:fs';
import path from 'node:path';
import { Writable } from 'node:stream';
import winston from 'winston';
import { redactLogValue, redactSecrets, redactArgv } from './transport/redact-secrets.js';
import { plugin } from './plugin.js';

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
    transport?: 'multipart' | 'download';
    status?: number;
    rawBody?: string;
    responseMetadata?: unknown;
    /** The final HTTP answer as recorded on the wire, when the transport saw one. */
    response?: { status?: number; headers: Record<string, unknown>; body?: string };
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
    const { response, ...rest } = details;
    let rawBody = details.rawBody;
    if (rawBody === undefined && response?.body !== undefined)
      rawBody = context.apiEnabled ? response.body : 'omitted: pass --api log to include bodies';
    context.logger.log(
      phase === 'error' ? 'error' : 'debug',
      `CMS ${details.transport ?? 'JSON'} ${phase}`,
      redactLogValue({
        ...rest,
        elapsedMs: Date.now() - details.startedAt,
        ...(phase === 'request'
          ? {}
          : {
              status:
                details.status ??
                response?.status ??
                status ??
                'unavailable: parsed SDK boundary did not expose HTTP status',
              rawBody: rawBody ?? 'unavailable: parsed SDK boundary does not expose raw body',
              ...(response === undefined ? {} : { responseHeaders: response.headers }),
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

/**
 * Opens one append-only log file under `<cwd>/logs/cms/`; failures are diagnostic, never
 * command failures.
 * @param {InvocationLogOptions} options - The received invocation tokens and working directory.
 * @returns {InvocationLogger} An isolated logger with an idempotent close.
 */
export function createInvocationLogger(options: InvocationLogOptions): InvocationLogger {
  const startedAt = options.startedAt ?? new Date();
  const directory = path.resolve(options.cwd, 'logs', 'cms');
  const filePath = path.join(directory, `${startedAt.toISOString().replaceAll(':', '.')}.log`);
  let descriptor: number | undefined;
  let logger: winston.Logger | undefined;
  let failed = false;
  let closing: Promise<void> | undefined;
  const warn = (error: unknown): void => {
    if (failed) return;
    failed = true;
    const text = redactSecrets(`CMS logging incomplete at ${filePath}: ${String(error)}
`);
    try {
      (options.stderr ?? ((message) => process.stderr.write(message)))(text);
    } catch {
      // A broken stderr must not replace the command's outcome either.
    }
  };
  const release = (): void => {
    const owned = descriptor;
    descriptor = undefined;
    try {
      if (owned !== undefined) fs.closeSync(owned);
    } catch (error) {
      warn(error);
    }
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
    fs.mkdirSync(directory, { recursive: true });
    descriptor = fs.openSync(filePath, 'a', 0o600);
    const sink = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        try {
          if (descriptor !== undefined) fs.writeSync(descriptor, chunk);
        } catch (error) {
          warn(error);
        }
        callback();
      },
    });
    logger = winston.createLogger({
      level: 'debug',
      format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
      transports: [new winston.transports.Stream({ stream: sink })],
    });
    logger.on('error', warn);
    log('info', `sf-plugin-cms ${plugin.version}`);
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
    release();
  }
  return {
    filePath,
    log,
    close() {
      closing ??= new Promise<void>((resolve) => {
        const finish = (): void => {
          release();
          resolve();
        };
        if (!logger) {
          finish();
          return;
        }
        logger.once('finish', finish);
        try {
          logger.end();
        } catch (error) {
          warn(error);
          finish();
        }
      });
      return closing;
    },
  };
}
