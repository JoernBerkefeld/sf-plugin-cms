import { Flags } from '@salesforce/sf-plugins-core';
import { CmsCommand, orgFlags, type CmsResult } from '../../../command-base.js';
import {
  listWorkspaceChannels,
  resolveWorkspace,
  type CmsChannel,
} from '../../../services/workspaces.js';

export type ListChannelResult = {
  workspace: { id: string; apiName: string | null } | null;
  channels: CmsChannel[];
};

export default class ListChannel extends CmsCommand<ListChannelResult> {
  public static readonly summary = 'List the channels of a CMS workspace.';
  public static readonly description =
    'Lists the channels assigned to one CMS workspace, with name, ID and channel type.';
  public static readonly examples = [
    '<%= config.bin %> <%= command.id %> --workspace Default_Content_Workspace --target-org my-org',
  ];
  public static readonly flags = {
    ...orgFlags,
    workspace: Flags.string({
      required: true,
      summary: 'Workspace API name or ID (see sf cms list workspace).',
    }),
  };

  public async run(): Promise<CmsResult<ListChannelResult>> {
    const { flags } = await this.parse(ListChannel);
    const envelope = await this.withOrg(
      'cms list channel',
      flags,
      { workspace: null, channels: [] },
      async (org) => {
        const workspace = await resolveWorkspace(org.connection, flags.workspace);
        return {
          workspace: { id: workspace.id, apiName: workspace.apiName },
          channels: await listWorkspaceChannels(org.connection, workspace.id),
        };
      },
    );
    if (envelope.status === 'success') {
      const { workspace, channels } = envelope.result;
      this.log(`Channels of ${workspace?.apiName ?? workspace?.id}: ${channels.length}.`);
      for (const channel of channels)
        this.log(`${channel.name} (${channel.id}): type ${channel.type || 'unknown'}.`);
    }
    return envelope;
  }
}
