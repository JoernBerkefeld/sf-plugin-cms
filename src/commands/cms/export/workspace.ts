import { Flags } from '@salesforce/sf-plugins-core';
import {
  exportWorkspace,
  type ExportWorkspaceResult,
  type WorkspaceExportWarning,
} from '../../../services/export-workspace.js';
import { getWorkspace } from '../../../services/read.js';
import { apiVersionFlag, CmsCommand, targetOrgFlag } from '../command-base.js';

export default class ExportWorkspace extends CmsCommand<ExportWorkspaceResult> {
  public static readonly summary =
    'Experimentally export a CMS workspace using a read-only, best-effort process.';
  public static readonly description =
    'Reads a Marketing Cloud CMS workspace and writes the variants observed by an experimental, best-effort search. This is not a complete or guaranteed backup and does not mutate org data.';
  public static readonly examples = [
    '<%= config.bin %> cms export workspace --target-org my-org --workspace-id 0Zu... --output-dir ./cms-export',
  ];
  public static readonly flags = {
    'target-org': targetOrgFlag,
    'api-version': apiVersionFlag,
    'workspace-id': Flags.string({ required: true, summary: 'CMS workspace content-space ID.' }),
    'output-dir': Flags.directory({
      exists: false,
      required: true,
      summary: 'New directory to receive the experimental best-effort export.',
    }),
  };

  public async run(): Promise<ExportWorkspaceResult> {
    const { flags } = await this.parse(ExportWorkspace);
    const connection = await this.getConnection(flags['target-org'], flags['api-version']);
    const workspace = await getWorkspace(connection, flags['workspace-id']);
    if (workspace.id !== flags['workspace-id']) {
      throw new Error(
        `Workspace validation returned ID ${String(workspace.id)} instead of requested ID ${flags['workspace-id']}.`,
      );
    }

    const result = await exportWorkspace(connection, flags['workspace-id'], flags['output-dir']);
    for (const warning of result.manifest.warnings) this.warn(formatWarning(warning));

    if (!this.jsonEnabled()) {
      this.log(`Destination: ${result.destination}`);
      this.log(
        `Exported variants: ${result.manifest.exportedCount}/${result.manifest.expectedCount} expected`,
      );
    }

    return result;
  }
}

function formatWarning(warning: WorkspaceExportWarning): string {
  const variantIds = warning.variantIds?.length ? ` (${warning.variantIds.join(', ')})` : '';
  return `[${warning.code}] ${warning.message}${variantIds}`;
}
