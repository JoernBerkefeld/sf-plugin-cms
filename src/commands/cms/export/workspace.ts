import { Flags } from '@salesforce/sf-plugins-core';
import {
  defaultWorkspaceDestination,
  exportWorkspace,
  type ExportWorkspaceResult,
  type WorkspaceExportWarning,
} from '../../../services/export-workspace.js';
import { assertWorkspaceSelector, resolveWorkspace } from '../../../services/resolve-workspace.js';
import { apiVersionFlag, CmsCommand, targetOrgFlag } from '../command-base.js';

export default class ExportWorkspace extends CmsCommand<ExportWorkspaceResult> {
  public static readonly summary =
    'Experimentally export a CMS workspace using a read-only, best-effort process.';
  public static readonly description =
    'Selects one Marketing Cloud CMS workspace by exact ID or exact case-sensitive name and writes the variants observed by an experimental, best-effort search. Without --output-dir, the new destination is ./cms/<safe-workspace-name>. This is not a complete or guaranteed backup and does not mutate org data.';
  public static readonly examples = [
    '<%= config.bin %> cms export workspace --target-org my-org --workspace-name "Main Site"',
    '<%= config.bin %> cms export workspace --target-org my-org --workspace-id 0Zu... --output-dir ./cms-export',
  ];
  public static readonly flags = {
    'target-org': targetOrgFlag,
    'api-version': apiVersionFlag,
    'workspace-id': Flags.string({ summary: 'Exact CMS workspace content-space ID.' }),
    'workspace-name': Flags.string({ summary: 'Exact case-sensitive CMS workspace name.' }),
    'output-dir': Flags.directory({
      exists: false,
      summary: 'Exact new destination directory; defaults to ./cms/<safe-workspace-name>.',
    }),
  };

  public async run(): Promise<ExportWorkspaceResult> {
    const { flags } = await this.parse(ExportWorkspace);
    const selector = {
      workspaceId: flags['workspace-id'],
      workspaceName: flags['workspace-name'],
    };
    assertWorkspaceSelector(selector);
    const connection = await this.getConnection(flags['target-org'], flags['api-version']);
    const selected = await resolveWorkspace(connection, selector);
    let destination = flags['output-dir'];
    if (destination === undefined) {
      const workspaceName = selected.workspace.name;
      if (typeof workspaceName !== 'string' || workspaceName.length === 0) {
        throw new Error('Selected workspace has no usable name. Pass --output-dir explicitly.');
      }
      destination = defaultWorkspaceDestination(workspaceName);
    }
    const result = await exportWorkspace(connection, selected.id, destination);
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
