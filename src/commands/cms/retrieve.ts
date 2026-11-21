import path from 'node:path';
import { Flags } from '@salesforce/sf-plugins-core';
import { CmsCommand, orgFlags, type CmsResult } from '../../command-base.js';
import { HANDLERS } from '../../content/registry.js';
import {
  parseSelection,
  retrieveComponents,
  type RetrieveResult,
} from '../../services/retrieve.js';
import { resolveWorkspace } from '../../services/workspaces.js';

export default class Retrieve extends CmsCommand<RetrieveResult> {
  public static readonly summary = 'Retrieve CMS components of one workspace into local files.';
  public static readonly description = `Writes each selected component to cms/<workspace>/<type>/<ApiName>.<type>.json, with companion files such as the HTML body next to it. Only the default variant is written. A component that fails is reported and the others continue. Types: ${HANDLERS.map((handler) => handler.type).join(', ')}.`;
  public static readonly examples = [
    '<%= config.bin %> <%= command.id %> -m email --workspace Default_Content_Workspace -o my-org',
    '<%= config.bin %> <%= command.id %> -m email:Welcome_Email -m email-template --workspace 0Zu... -o my-org',
  ];
  public static readonly flags = {
    ...orgFlags,
    metadata: Flags.string({
      char: 'm',
      multiple: true,
      summary:
        'Component to retrieve: type (all of that type) or type:ApiName. Default: every type.',
    }),
    workspace: Flags.string({
      required: true,
      summary: 'Workspace API name or ID (see sf cms list workspace).',
    }),
    'output-dir': Flags.directory({
      summary: 'Project directory the cms/ folder is written to (default: current directory).',
    }),
  };

  public async run(): Promise<CmsResult<RetrieveResult>> {
    const { flags } = await this.parse(Retrieve);
    const outputDirectory = path.resolve(flags['output-dir'] ?? process.cwd());
    const envelope = await this.withOrg(
      'cms retrieve',
      flags,
      { workspace: { id: '', apiName: null }, outputDirectory, items: [] },
      async (org, result) => {
        const selection = parseSelection(flags.metadata);
        const workspace = await resolveWorkspace(org.connection, flags.workspace);
        const outcome: RetrieveResult = {
          workspace: { id: workspace.id, apiName: workspace.apiName },
          outputDirectory,
          items: [],
        };
        // Filled as components are written, so a later failure keeps what was done.
        result.result = outcome;
        outcome.items = await retrieveComponents(
          org.connection,
          workspace,
          selection,
          outputDirectory,
          result.diagnostics,
        );
        return outcome;
      },
    );
    for (const item of envelope.result.items)
      this.log(
        `Retrieved ${item.type}:${item.apiName} (${item.outcome}): ${path.relative(outputDirectory, item.path)}`,
      );
    this.log(
      `Retrieve: ${envelope.status}; ${envelope.result.items.length} component(s), ${envelope.diagnostics.errors.length} error(s).`,
    );
    return envelope;
  }
}
