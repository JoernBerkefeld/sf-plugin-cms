import { Flags } from '@salesforce/sf-plugins-core';
import { getContent, type CmsRecord } from '../../../services/read.js';
import { apiVersionFlag, CmsCommand, targetOrgFlag } from '../command-base.js';

export default class GetContent extends CmsCommand<CmsRecord> {
  public static readonly summary = 'Get CMS content.';
  public static readonly description = 'Retrieves content by its key or identifier.';
  public static readonly examples = [
    '<%= config.bin %> cms get content --target-org my-org --content-key-or-id news-banner',
  ];
  public static readonly flags = {
    'target-org': targetOrgFlag,
    'api-version': apiVersionFlag,
    'content-key-or-id': Flags.string({
      required: true,
      summary: 'CMS content key or identifier.',
    }),
    'content-version': Flags.string({ summary: 'Content version selector.' }),
    language: Flags.string({ summary: 'Content language selector.' }),
    'variant-version': Flags.string({ summary: 'Variant version selector.' }),
    version: Flags.string({ summary: 'Document version selector.' }),
  };

  public async run(): Promise<CmsRecord> {
    const { flags } = await this.parse(GetContent);
    const connection = await this.getConnection(flags['target-org'], flags['api-version']);
    const result = await getContent(connection, flags['content-key-or-id'], {
      contentVersion: flags['content-version'],
      language: flags.language,
      variantVersion: flags['variant-version'],
      version: flags.version,
    });
    this.showRecord(result);
    return result;
  }
}
