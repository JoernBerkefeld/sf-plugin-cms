import { Flags } from '@salesforce/sf-plugins-core';
import { getWorkspace, type CmsRecord } from '../../../services/read.js';
import { apiVersionFlag, CmsCommand, targetOrgFlag } from '../command-base.js';

export default class GetWorkspace extends CmsCommand<CmsRecord> {
  public static readonly summary = 'Get a Marketing Cloud CMS workspace.';
  public static readonly description = 'Retrieves one CMS workspace by its content-space ID.';
  public static readonly examples = [
    '<%= config.bin %> cms get workspace --target-org my-org --workspace-id 0Zu...',
  ];
  public static readonly flags = {
    'target-org': targetOrgFlag,
    'api-version': apiVersionFlag,
    'workspace-id': Flags.string({ required: true, summary: 'CMS workspace content-space ID.' }),
  };

  public async run(): Promise<CmsRecord> {
    const { flags } = await this.parse(GetWorkspace);
    const connection = await this.getConnection(flags['target-org'], flags['api-version']);
    const result = await getWorkspace(connection, flags['workspace-id']);
    this.showRecord(result);
    return result;
  }
}
