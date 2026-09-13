import { Flags } from '@salesforce/sf-plugins-core';
import { listWorkspaces, type CmsPage } from '../../../services/read.js';
import {
  apiVersionFlag,
  CmsCommand,
  pageFlag,
  pageSizeFlag,
  targetOrgFlag,
} from '../command-base.js';

export default class ListWorkspace extends CmsCommand<CmsPage> {
  public static readonly summary = 'List Marketing Cloud CMS workspaces.';
  public static readonly description =
    'Lists one bounded page of CMS workspaces through the authenticated Salesforce connection.';
  public static readonly examples = ['<%= config.bin %> cms list workspace --target-org my-org'];
  public static readonly flags = {
    'target-org': targetOrgFlag,
    'api-version': apiVersionFlag,
    'name-fragment': Flags.string({ summary: 'Return workspaces whose names contain this value.' }),
    page: pageFlag,
    'page-size': pageSizeFlag,
  };

  public async run(): Promise<CmsPage> {
    const { flags } = await this.parse(ListWorkspace);
    const connection = await this.getConnection(flags['target-org'], flags['api-version']);
    const result = await listWorkspaces(connection, {
      nameFragment: flags['name-fragment'],
      page: flags.page,
      pageSize: flags['page-size'],
    });
    this.showPage('CMS workspaces', result);
    return result;
  }
}
