import { Flags } from '@salesforce/sf-plugins-core';
import { listWorkspaceChannels, type CmsPage } from '../../../services/read.js';
import {
  apiVersionFlag,
  CmsCommand,
  pageFlag,
  pageSizeFlag,
  targetOrgFlag,
} from '../command-base.js';

export default class ListChannel extends CmsCommand<CmsPage> {
  public static readonly summary = 'List channels assigned to a CMS workspace.';
  public static readonly description = 'Retrieves one page of channels for an explicit workspace.';
  public static readonly examples = [
    '<%= config.bin %> cms list channel --target-org my-org --workspace-id 0Zu...',
  ];
  public static readonly flags = {
    'target-org': targetOrgFlag,
    'api-version': apiVersionFlag,
    'workspace-id': Flags.string({ required: true, summary: 'CMS workspace content-space ID.' }),
    page: pageFlag,
    'page-size': pageSizeFlag,
  };

  public async run(): Promise<CmsPage> {
    const { flags } = await this.parse(ListChannel);
    const connection = await this.getConnection(flags['target-org'], flags['api-version']);
    const result = await listWorkspaceChannels(connection, flags['workspace-id'], {
      page: flags.page,
      pageSize: flags['page-size'],
    });
    this.showPage('CMS channels', result);
    return result;
  }
}
