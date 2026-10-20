import { Flags } from '@salesforce/sf-plugins-core';
import { listWorkspaces, type CmsPage } from '../../../services/read.js';
import {
  apiVersionFlag,
  CmsCommand,
  pageFlag,
  pageSizeFlag,
  targetOrgFlag,
} from '../../../command-base.js';

export default class ListWorkspace extends CmsCommand<CmsPage> {
  public static readonly aliases = ['content:list:workspace'];
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
    const targetOrg = flags['target-org'].getUsername()!;
    const connection = await this.getConnection(targetOrg, flags['api-version']);
    const result = await listWorkspaces(connection, {
      nameFragment: flags['name-fragment'],
      page: flags.page,
      pageSize: flags['page-size'],
    });
    this.table({
      title: 'CMS workspaces',
      data: result.items.map((item) => {
        const spaceType = item.spaceType;
        const apiName =
          spaceType !== null && typeof spaceType === 'object' && !Array.isArray(spaceType)
            ? spaceType.apiName
            : undefined;
        let type = 'Unknown';
        if (typeof apiName === 'string' && apiName.trim().length > 0) {
          switch (apiName) {
            case 'marketing': {
              type = 'Marketing';
              break;
            }
            case 'content': {
              type = 'Content';
              break;
            }
            case 'enablement': {
              type = 'Enablement';
              break;
            }
            default: {
              type = apiName;
            }
          }
        }
        const title = typeof item.title === 'string' ? item.title : '';
        const name = typeof item.name === 'string' && item.name.length > 0 ? item.name : title;
        let enhanced = 'Unknown';
        if (item.isEnhancedSpace === true) enhanced = 'Yes';
        else if (item.isEnhancedSpace === false) enhanced = 'No';
        return {
          id: typeof item.id === 'string' ? item.id : '',
          name,
          type,
          enhanced,
        };
      }),
    });
    return result;
  }
}
