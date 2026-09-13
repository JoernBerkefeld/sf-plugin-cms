import { Flags } from '@salesforce/sf-plugins-core';
import { getVariant, type CmsRecord } from '../../../services/read.js';
import { apiVersionFlag, CmsCommand, targetOrgFlag } from '../command-base.js';

export default class GetVariant extends CmsCommand<CmsRecord> {
  public static readonly summary = 'Get a CMS content variant.';
  public static readonly description = 'Retrieves a content variant by its identifier.';
  public static readonly examples = [
    '<%= config.bin %> cms get variant --target-org my-org --variant-id 0ap...',
  ];
  public static readonly flags = {
    'target-org': targetOrgFlag,
    'api-version': apiVersionFlag,
    'variant-id': Flags.string({ required: true, summary: 'CMS content variant identifier.' }),
  };

  public async run(): Promise<CmsRecord> {
    const { flags } = await this.parse(GetVariant);
    const connection = await this.getConnection(flags['target-org'], flags['api-version']);
    const result = await getVariant(connection, flags['variant-id']);
    this.showRecord(result);
    return result;
  }
}
