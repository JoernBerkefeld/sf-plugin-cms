import { SfCommand } from '@salesforce/sf-plugins-core';

export type InfoResult = {
  name: string;
  status: 'scaffold';
};

/** Reports that the CMS plugin scaffold is installed. */
export default class Info extends SfCommand<InfoResult> {
  public static readonly summary = 'Show CMS plugin scaffold information.';
  public static readonly description =
    'Confirms that the sf-plugin-cms command entrypoint can be loaded without making org calls.';
  public static readonly examples = ['<%= config.bin %> cms info'];

  public async run(): Promise<InfoResult> {
    const result: InfoResult = { name: 'sf-plugin-cms', status: 'scaffold' };
    this.logJson(result);
    return result;
  }
}
