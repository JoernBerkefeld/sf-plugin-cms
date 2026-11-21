import { CmsCommand, orgFlags, type CmsResult } from '../../../command-base.js';
import { listWorkspaces, type CmsWorkspace } from '../../../services/workspaces.js';

export type ListWorkspaceResult = { workspaces: CmsWorkspace[] };

export default class ListWorkspace extends CmsCommand<ListWorkspaceResult> {
  public static readonly summary = 'List the CMS workspaces of an org.';
  public static readonly description =
    'Lists every CMS workspace the user can see, with its API name, ID, display name, type and default language. Use the API name or the ID as --workspace in the other cms commands.';
  public static readonly examples = ['<%= config.bin %> <%= command.id %> --target-org my-org'];
  public static readonly flags = { ...orgFlags };

  public async run(): Promise<CmsResult<ListWorkspaceResult>> {
    const { flags } = await this.parse(ListWorkspace);
    const envelope = await this.withOrg(
      'cms list workspace',
      flags,
      { workspaces: [] },
      async (org) => ({
        workspaces: await listWorkspaces(org.connection),
      }),
    );
    if (envelope.status === 'success') {
      const { workspaces } = envelope.result;
      this.log(`Workspaces: ${workspaces.length}.`);
      for (const workspace of workspaces)
        this.log(
          `${workspace.apiName ?? '(no API name)'} (${workspace.id}): ${workspace.name}; type ${workspace.type || 'unknown'}; ${workspace.enhanced === false ? 'not enhanced' : 'enhanced'}${workspace.defaultLanguage ? `; default language ${workspace.defaultLanguage}` : ''}.`,
        );
    }
    return envelope;
  }
}
