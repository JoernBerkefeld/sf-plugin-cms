import { Flags } from '@salesforce/sf-plugins-core';
import {
  executeWorkspaceImport,
  loadWorkspaceExport,
  type WorkspaceImportResult,
} from '../../../services/import-workspace.js';
import { assertWorkspaceSelector, resolveWorkspace } from '../../../services/resolve-workspace.js';
import { apiVersionFlag, CmsCommand, targetOrgFlag } from '../command-base.js';

export default class ImportWorkspace extends CmsCommand<WorkspaceImportResult> {
  public static readonly summary =
    'Safely plan or apply a create-only import into a CMS workspace.';
  public static readonly description =
    'Validates the source workspace export locally before any org request, selects one destination workspace by exact ID or exact case-sensitive name, checks every content key for conflicts, and defaults to a non-mutating dry run. Pass --apply with a new --report-dir to create content.';
  public static readonly examples = [
    '<%= config.bin %> cms import workspace --target-org my-org --workspace-name "Destination" --source-dir ./cms/Source',
    '<%= config.bin %> cms import workspace --target-org my-org --workspace-id 0Zu... --source-dir ./cms/Source --apply --report-dir ./cms-import-report',
  ];
  public static readonly flags = {
    'target-org': targetOrgFlag,
    'api-version': apiVersionFlag,
    'workspace-id': Flags.string({ summary: 'Exact destination CMS workspace ID.' }),
    'workspace-name': Flags.string({ summary: 'Exact case-sensitive destination workspace name.' }),
    'source-dir': Flags.directory({
      exists: true,
      required: true,
      summary: 'Source workspace export containing manifest.json and items/.',
    }),
    apply: Flags.boolean({
      default: false,
      summary: 'Create the planned content after all validation and conflict checks pass.',
    }),
    'allow-partial': Flags.boolean({
      default: false,
      summary: 'Accept an export whose manifest records omissions or incomplete coverage.',
    }),
    'report-dir': Flags.directory({
      dependsOn: ['apply'],
      exists: false,
      summary: 'New directory for the durable applied-import run report.',
    }),
  };

  public async run(): Promise<WorkspaceImportResult> {
    const { flags } = await this.parse(ImportWorkspace);
    if (flags.apply && flags['report-dir'] === undefined) {
      throw new Error('--report-dir is required when --apply is set.');
    }

    // Reject malformed, unsafe, or disallowed partial packages before contacting the org.
    await loadWorkspaceExport(flags['source-dir'], { allowPartial: flags['allow-partial'] });
    const selector = {
      workspaceId: flags['workspace-id'],
      workspaceName: flags['workspace-name'],
    };
    assertWorkspaceSelector(selector);

    const { connection, orgId } = await this.getOrgContext(
      flags['target-org'],
      flags['api-version'],
    );
    const selected = await resolveWorkspace(connection, selector);
    const result = await executeWorkspaceImport({
      allowPartial: flags['allow-partial'],
      connection,
      destinationOrgId: orgId,
      destinationWorkspace: selected.workspace,
      dryRun: !flags.apply,
      reportDirectory: flags['report-dir'],
      sourceDirectory: flags['source-dir'],
      workspaceId: selected.id,
    });

    if (!this.jsonEnabled()) this.showPlan(result);
    return result;
  }

  private showPlan(result: WorkspaceImportResult): void {
    const primaryCount = result.plan.groups.length;
    const variantCount = result.plan.groups.reduce(
      (count, group) => count + group.variants.length,
      0,
    );
    this.log(`Mode: ${result.dryRun ? 'dry-run (no mutations)' : 'apply (create-only)'}`);
    this.log(`Destination workspace: ${result.plan.destinationWorkspaceId}`);
    this.log(`Destination root folder: ${result.plan.rootFolderId}`);
    this.log(`Planned new content: ${primaryCount} parent(s), ${variantCount} child variant(s)`);
    for (const group of result.plan.groups) {
      const childLanguages = group.variants.map(({ language }) => language).join(', ') || 'none';
      this.log(
        `- ${group.contentKey}: primary ${group.primary.language}; child languages ${childLanguages}`,
      );
    }
    if (result.dryRun) {
      this.log('No content was created. Re-run with --apply and a new --report-dir to mutate.');
    } else {
      this.log(`Run report: ${result.reportFile ?? ''}`);
    }
  }
}
