import { Flags } from '@salesforce/sf-plugins-core';
import { getChannel, type CmsRecord } from '../../../services/read.js';
import { apiVersionFlag, CmsCommand, targetOrgFlag } from '../../../command-base.js';

export default class GetChannel extends CmsCommand<CmsRecord> {
  public static readonly summary = 'Get a CMS channel.';
  public static readonly description = 'Retrieves a channel by its identifier.';
  public static readonly examples = [
    '<%= config.bin %> cms get channel --target-org my-org --channel-id 0ap...',
  ];
  public static readonly flags = {
    'target-org': targetOrgFlag,
    'api-version': apiVersionFlag,
    'channel-id': Flags.string({ required: true, summary: 'CMS channel identifier.' }),
  };

  public async run(): Promise<CmsRecord> {
    const { flags } = await this.parse(GetChannel);
    const connection = await this.getConnection(flags['target-org'], flags['api-version']);
    const result = await getChannel(connection, flags['channel-id']);
    this.showRecord(result);
    return result;
  }
}
