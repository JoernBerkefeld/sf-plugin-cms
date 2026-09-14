import { Org } from '@salesforce/core';
import { Flags, SfCommand } from '@salesforce/sf-plugins-core';
import type { CmsPage, CmsRecord } from './services/read.js';
import { getPluginVersion } from './runtime-version.js';
import {
  finalizeCmsEnvelope,
  serializeCmsEnvelope,
  type CmsEnvelope,
  type CmsProvenance,
} from './contracts/shared.js';

export const targetOrgFlag = Flags.string({
  char: 'o',
  required: true,
  summary: 'Username or alias of the target Salesforce org.',
});

export const apiVersionFlag = Flags.orgApiVersion({
  default: '67.0',
  summary: 'Salesforce API version used for CMS requests.',
});

export const pageFlag = Flags.integer({ min: 0, summary: 'Zero-based page number.' });
export const pageSizeFlag = Flags.integer({ min: 1, summary: 'Maximum items requested per page.' });

export abstract class CmsCommand<T> extends SfCommand<T> {
  protected get pluginVersion(): string {
    return getPluginVersion(this.config);
  }

  protected finishEnvelope<R>(
    envelope: CmsEnvelope<R>,
    resultValidator: (result: unknown, provenance?: CmsProvenance) => asserts result is R,
  ): CmsEnvelope<R> {
    return finalizeCmsEnvelope(envelope, resultValidator, {
      emit: (value) => {
        if (this.config !== undefined && this.jsonEnabled()) {
          process.stdout.write(serializeCmsEnvelope(value, resultValidator));
        }
      },
      setExitCode: (exitCode) => {
        process.exitCode = exitCode;
      },
    });
  }

  public logJson(json: unknown): void {
    if (!isCmsEnvelope(json)) super.logJson(json);
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
    const org = await Org.create({ aliasOrUsername: targetOrg });
    return { connection: org.getConnection(apiVersion), orgId: org.getOrgId() };
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

function stringValue(record: CmsRecord, key: string): string {
  const value = record[key];
  return typeof value === 'string' ? value : '';
}
