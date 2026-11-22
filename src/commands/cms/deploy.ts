import path from 'node:path';
import { Flags } from '@salesforce/sf-plugins-core';
import {
  CmsCommand,
  orgFlags,
  withWriteTimeout,
  writeTimeoutFlags,
  type CmsResult,
} from '../../command-base.js';
import { HANDLERS } from '../../content/registry.js';
import { deployComponents, type DeployResult } from '../../services/deploy.js';
import { selectSources } from '../../services/deploy-selection.js';
import { resolveWorkspace } from '../../services/workspaces.js';
import type { JsonMutationOptions } from '../../transport/json-mutation.js';

export default class Deploy extends CmsCommand<DeployResult> {
  public static readonly summary = 'Deploy local CMS component files into one workspace.';
  public static readonly description = `Creates each named component in the workspace, or updates its default variant when a component with the same API name exists; an unchanged component is not written. References and folders are resolved by name in the workspace; missing folders of a new component's folderPath are created (preview lists them). Data graph providers must name a data space and data graph the org has. Nothing is written if a component is blocked; the deploy stops at the first failed write. Deploy never publishes. Types: ${HANDLERS.map((handler) => handler.type).join(', ')}.`;
  public static readonly examples = [
    '<%= config.bin %> <%= command.id %> -m email:Welcome_Email --workspace Default_Content_Workspace -o my-org --preview',
    '<%= config.bin %> <%= command.id %> -d cms/Default_Content_Workspace/email --workspace Cloud_Kicks -o my-org',
  ];
  public static readonly flags = {
    ...orgFlags,
    ...writeTimeoutFlags,
    metadata: Flags.string({
      char: 'm',
      multiple: true,
      summary: 'Component to deploy as type:ApiName, read from cms/<workspace>/<type>/ here.',
    }),
    'source-dir': Flags.string({
      char: 'd',
      multiple: true,
      summary: 'Component file or folder under cms/ to deploy (all components below it).',
    }),
    workspace: Flags.string({
      required: true,
      summary: 'Destination workspace API name or ID (see sf cms list workspace).',
    }),
    preview: Flags.boolean({
      summary: 'Report what the deploy would do; write nothing to the org or to local files.',
      default: false,
    }),
  };

  /** Write transport options; tests replace this to use their fake connection. */
  protected writeOptions: JsonMutationOptions = {};

  public async run(): Promise<CmsResult<DeployResult>> {
    const { flags } = await this.parse(Deploy);
    const projectDirectory = process.cwd();
    const envelope = await this.withOrg(
      'cms deploy',
      flags,
      { workspace: { id: '', apiName: null }, preview: flags.preview, items: [] },
      async (org, result) => {
        const sources = await selectSources(flags.metadata, flags['source-dir'], projectDirectory);
        const workspace = await resolveWorkspace(org.connection, flags.workspace);
        const outcome: DeployResult = {
          workspace: { id: workspace.id, apiName: workspace.apiName },
          preview: flags.preview,
          items: [],
        };
        result.result = outcome;
        outcome.items = await deployComponents(org.connection, workspace, sources, {
          preview: flags.preview,
          diagnostics: result.diagnostics,
          writeOptions: withWriteTimeout(this.writeOptions, flags.timeout),
        });
        return outcome;
      },
    );
    for (const item of envelope.result.items) {
      const details = [
        item.reason,
        item.changes?.length ? `changes: ${item.changes.join(', ')}` : undefined,
        item.dependencies?.length
          ? `${item.action ? `${item.action} ` : ''}after: ${item.dependencies.join(', ')}`
          : undefined,
        item.folders?.length
          ? `folder ${item.folders[0].outcome}: ${item.folders.map((folder) => (folder.id ? `${folder.path} (${folder.id})` : folder.path)).join(', ')}`
          : undefined,
      ].filter(Boolean);
      this.log(
        `${item.outcome} ${item.type}:${item.apiName}${details.length > 0 ? ` (${details.join('; ')})` : ''}: ${path.relative(projectDirectory, item.path)}`,
      );
    }
    this.log(
      `Deploy${flags.preview ? ' preview' : ''}: ${envelope.status}; ${envelope.result.items.length} component(s), ${envelope.diagnostics.errors.length} error(s).`,
    );
    return envelope;
  }
}
