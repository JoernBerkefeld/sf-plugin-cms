import { format, inspect } from 'node:util';
import { ux } from '@oclif/core';
import type { TableOptions } from '@oclif/table';
import { Org, SfError } from '@salesforce/core';
import { Flags, SfCommand, Ux } from '@salesforce/sf-plugins-core';
import { createInvocationLogger, type InvocationLogger } from './logging.js';
import { redactSecrets } from './transport/redact-secrets.js';
import type { CmsPage, CmsRecord } from './services/read.js';
import { getPluginVersion } from './runtime-version.js';
import {
  DEFAULT_API_VERSION,
  FALLBACK_API_VERSION,
  isNumericApiVersion,
  prepareCmsConnection,
} from './api-policy.js';
import {
  finalizeCmsEnvelope,
  serializeCmsEnvelope,
  type CmsEnvelope,
  type CmsProvenance,
} from './contracts/shared.js';

// Command modules load before host prerun hooks; Salesforce telemetry consumes
// process.argv there. Retain received tokens only, never an invocation/logger singleton.
const loadedProcessArgv = process.argv.slice(2);

export const targetOrgFlag = Flags.requiredOrg();

export const apiVersionFlag = Flags.string({
  default: DEFAULT_API_VERSION,
  summary: 'Salesforce API version used for CMS requests (latest or a numeric version).',
  parse: async (value) => {
    if (value !== DEFAULT_API_VERSION && !isNumericApiVersion(value))
      throw new Error(`Invalid CMS API version: ${value}`);
    return value;
  },
});

export const pageFlag = Flags.integer({ min: 0, summary: 'Zero-based page number.' });
export const pageSizeFlag = Flags.integer({ min: 1, summary: 'Maximum items requested per page.' });

export abstract class CmsCommand<T> extends SfCommand<T> {
  public static baseFlags = {
    ...SfCommand.baseFlags,
    api: Flags.string({
      options: ['log'],
      summary: 'Opt in to API details in the CMS diagnostic log (may contain customer data).',
    }),
  };

  private invocationLogger?: InvocationLogger;
  private catchEntered = false;
  private finalizationEntered = false;
  private orgContextEntered = false;

  public async _run<R>(): Promise<R> {
    const startedAt = Date.now();
    this.catchEntered = false;
    this.finalizationEntered = false;
    this.orgContextEntered = false;
    this.invocationLogger = createInvocationLogger({
      cwd: process.cwd(),
      argv: this.invocationArgv(),
    });
    try {
      const result = await super._run<R>();
      this.invocationLogger.log(
        'debug',
        'command outcome',
        isCmsEnvelope(result)
          ? { status: result.status, metadata: result.metadata, diagnostics: result.diagnostics }
          : { kind: 'plain result' },
      );
      return result;
    } catch (error) {
      if (this.catchEntered) throw error;
      // SfCommand configuration/project setup precedes oclif's own try/finally.
      try {
        return await this.catch(error as Error);
      } finally {
        if (!this.finalizationEntered) await this.finally(error as Error);
      }
    } finally {
      this.invocationLogger.log('debug', 'command completed', {
        elapsedMs: Date.now() - startedAt,
      });
      try {
        this.emitTerminal('stderr', `CMS log: ${this.invocationLogger.filePath}\n`);
      } catch (error) {
        this.loggingFallback('log path notice failed', error);
      }
      try {
        await this.invocationLogger.close();
      } catch (error) {
        this.loggingFallback('log close failed', error);
      } finally {
        this.invocationLogger = undefined;
      }
    }
  }

  public log(message = '', ...args: unknown[]): void {
    if (!this.jsonEnabled()) this.emitTerminal('stdout', this.renderLine(message, args));
  }

  public logToStderr(message = '', ...args: unknown[]): void {
    if (!this.jsonEnabled()) this.emitTerminal('stderr', this.renderLine(message, args));
  }

  public table<R extends Record<string, unknown>>(options: TableOptions<R>): void {
    if (!this.jsonEnabled()) {
      this.emitTerminal('stdout', `${new Ux().makeTable(options)}\n`);
    }
  }

  public styledJSON(json: Parameters<SfCommand<T>['styledJSON']>[0]): void {
    if (!this.jsonEnabled()) this.emitJson(json);
  }

  public warn(input: SfCommand.Warning): SfCommand.Warning {
    // JSON mode suppresses the visible warning; retain its diagnostic evidence too.
    this.invocationLogger?.log('warn', 'command warning', input);
    return super.warn(input);
  }

  protected async catch(error: Error): Promise<never> {
    this.catchEntered = true;
    this.invocationLogger?.log('error', 'command failure', error);
    try {
      return await super.catch(error);
    } catch (error_) {
      if (
        error_ !== null &&
        typeof error_ === 'object' &&
        'skipOclifErrorHandling' in error_ &&
        error_.skipOclifErrorHandling === true
      )
        throw error_;
      // A renderer failure must neither replay the command nor rerender its error.
      this.loggingFallback('error rendering incomplete', error_);
      const original = SfError.wrap(error);
      process.exitCode = process.exitCode || original.exitCode || 1;
      Object.assign(original, { skipOclifErrorHandling: true });
      throw original;
    }
  }

  protected async finally(error: Error | undefined): Promise<void> {
    this.finalizationEntered = true;
    try {
      await super.finally(error);
    } catch (error_) {
      this.loggingFallback('warning finalization incomplete', error_);
    }
  }

  private invocationArgv(): string[] {
    const received = process.argv.length > 2 ? process.argv.slice(2) : loadedProcessArgv;
    const prefixLength = received.length - this.argv.length;
    const identifiers = [this.id, ...this.ctor.aliases].map((id) => id?.replaceAll(' ', ':'));
    if (
      prefixLength > 0 &&
      this.argv.every((token, index) => received[prefixLength + index] === token) &&
      identifiers.includes(received.slice(0, prefixLength).join(':'))
    ) {
      return received;
    }
    // Programmatic Command.run receives arguments only: the selected alias is unavailable.
    // Do not mislabel a static canonical ID as the user's received command tokens.
    return [...this.argv];
  }

  private renderLine(message: unknown, args: unknown[]): string {
    return `${format(typeof message === 'string' ? message : inspect(message), ...args)}\n`;
  }

  private emitTerminal(channel: 'stdout' | 'stderr', text: string): void {
    this.invocationLogger?.log('info', 'terminal', { channel, text });
    process[channel].write(text);
  }

  private loggingFallback(message: string, error: unknown): void {
    const text = redactSecrets(`CMS logging incomplete: ${message}: ${String(error)}\n`);
    this.invocationLogger?.log('error', message, error);
    try {
      process.stderr.write(text);
    } catch {
      // Diagnostic output cannot replace the invocation outcome.
    }
  }

  protected get pluginVersion(): string {
    return getPluginVersion(this.config);
  }

  protected finishEnvelope<R>(
    envelope: CmsEnvelope<R>,
    resultValidator: (result: unknown, provenance?: CmsProvenance) => asserts result is R,
  ): CmsEnvelope<R> {
    this.invocationLogger?.log('debug', 'command diagnostics', {
      status: envelope.status,
      operation: envelope.metadata.operation,
      diagnostics: envelope.diagnostics,
      orgContext: this.orgContextEntered
        ? 'entered; HTTP and mutation counts are not observed by this output boundary'
        : 'not entered; no CMS org HTTP or mutation dispatched',
      ...guardDetails(envelope.result),
    });
    // Offline/pre-org failures have no resolved numeric API version.
    if (envelope.metadata.apiVersion === DEFAULT_API_VERSION) envelope.metadata.apiVersion = null;
    return finalizeCmsEnvelope(envelope, resultValidator, {
      emit: (value) => {
        if (this.config !== undefined && this.jsonEnabled()) {
          this.emitTerminal('stdout', serializeCmsEnvelope(value, resultValidator));
        }
      },
      setExitCode: (exitCode) => {
        process.exitCode = exitCode;
      },
    });
  }

  public logJson(json: unknown): void {
    if (!isCmsEnvelope(json)) this.emitJson(json);
  }

  private emitJson(json: unknown): void {
    const theme = {
      key: 'blueBright',
      string: 'greenBright',
      number: 'blue',
      boolean: 'redBright',
      null: 'blackBright',
      ...this.config.theme?.json,
    };
    this.emitTerminal('stdout', `${ux.colorizeJson(json, { theme })}\n`);
  }

  protected toSuccessJson(result: T): SfCommand.Json<T> {
    return result as SfCommand.Json<T>;
  }

  protected async getConnection(
    targetOrg: string,
    apiVersion: string,
  ): Promise<ReturnType<Org['getConnection']>> {
    const context = await this.getOrgContext(targetOrg, apiVersion);
    return context.connection;
  }

  protected async getOrgContext(
    targetOrg: string,
    apiVersion: string,
  ): Promise<{ connection: ReturnType<Org['getConnection']>; orgId: string }> {
    this.orgContextEntered = true;
    const org = await Org.create({ aliasOrUsername: targetOrg });
    const connection = org.getConnection(
      apiVersion === DEFAULT_API_VERSION ? FALLBACK_API_VERSION : apiVersion,
    );
    await prepareCmsConnection(connection, apiVersion);
    return { connection, orgId: org.getOrgId() };
  }

  protected showPage(title: string, page: CmsPage): void {
    this.table({
      data: page.items.map((item) => ({
        id: stringValue(item, 'id'),
        name: stringValue(item, 'name') || stringValue(item, 'title'),
        type: stringValue(item, 'type'),
      })),
      title,
    });
  }

  protected showRecord(record: CmsRecord): void {
    if (!this.jsonEnabled()) this.styledJSON(record);
  }
}

function isCmsEnvelope(value: unknown): value is CmsEnvelope<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === 7 &&
    'contract' in value &&
    'contractVersion' in value &&
    'status' in value &&
    'metadata' in value &&
    'diagnostics' in value &&
    'provenance' in value &&
    'result' in value
  );
}

// Keep normal-return guard evidence without implicitly dumping successful API content.
function guardDetails(result: unknown): Record<string, unknown> {
  if (result === null || typeof result !== 'object') return {};
  const record = result as Record<string, unknown>;
  return {
    ...(Array.isArray(record.blockedReasons) ? { blockedReasons: record.blockedReasons } : {}),
    ...(Array.isArray(record.items)
      ? {
          itemGuards: record.items.flatMap((item: unknown, index: number) => {
            if (item === null || typeof item !== 'object') return [];
            const reasons = (item as Record<string, unknown>).blockedReasons;
            return Array.isArray(reasons) ? [{ index, reasons }] : [];
          }),
        }
      : {}),
  };
}

function stringValue(record: CmsRecord, key: string): string {
  const value = record[key];
  return typeof value === 'string' ? value : '';
}
