import { Org } from '@salesforce/core';
import { Flags, SfCommand } from '@salesforce/sf-plugins-core';
import type { CmsPage, CmsRecord } from './services/read.js';

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

function stringValue(record: CmsRecord, key: string): string {
  const value = record[key];
  return typeof value === 'string' ? value : '';
}
