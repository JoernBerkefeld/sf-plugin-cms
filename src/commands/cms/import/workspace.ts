import { Flags } from '@salesforce/sf-plugins-core';
import {
  assertWorkspaceImportResult,
  WORKSPACE_IMPORT_CONTRACT,
  type WorkspaceImportResult,
} from '../../../contracts/workspace-import.js';
import {
  sanitizeDiagnostics,
  type CmsDiagnostic,
  type CmsEnvelope,
  type CmsStatus,
} from '../../../contracts/shared.js';
import {
  executeWorkspaceImport,
  loadWorkspaceExport,
  type LoadedWorkspaceExport,
  type WorkspaceImportExecutionResult,
} from '../../../services/import-workspace.js';
import { assertWorkspaceSelector, resolveWorkspace } from '../../../services/resolve-workspace.js';
import { apiVersionFlag, CmsCommand, targetOrgFlag } from '../../../command-base.js';

export default class ImportWorkspace extends CmsCommand<CmsEnvelope<WorkspaceImportResult>> {
  public static readonly summary =
    'Safely plan or apply a create-only import into a CMS workspace.';
  public static readonly description =
    'Validates the source workspace export locally before any org request, selects one destination workspace by exact ID or exact case-sensitive name, checks every content key for conflicts, and defaults to a non-mutating dry run. Pass --apply with a new --report-dir to create content.';
  public static readonly examples = [
    '<%= config.bin %> cms import workspace --target-org my-org --workspace-name "Destination" --source-dir ./cms/Source',
    '<%= config.bin %> cms import workspace --target-org my-org --workspace-id 0Zu... --source-dir ./cms/Source --apply --report-dir ./cms-import-report --contract-version 1 --json',
  ];
  public static readonly flags = {
    'target-org': targetOrgFlag,
    'api-version': apiVersionFlag,
    'contract-version': Flags.integer({
      default: 1,
      min: 1,
      summary: 'Machine contract major version (supported: 1).',
    }),
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

  public async run(): Promise<CmsEnvelope<WorkspaceImportResult>> {
    const { flags } = await this.parse(ImportWorkspace);
    const requestedVersion = flags['contract-version'] ?? 1;
    if (requestedVersion !== 1) {
      return this.finish(
        envelope('blocked', flags['api-version'], 'unresolved-org', this.pluginVersion, null, [
          {
            code: 'UNSUPPORTED_CONTRACT_VERSION',
            message: `Contract major ${requestedVersion} is unsupported; supported major is 1.`,
            retryable: false,
          },
        ]),
      );
    }
    if (flags.apply && flags['report-dir'] === undefined) {
      return this.finish(
        envelope('blocked', flags['api-version'], 'unresolved-org', this.pluginVersion, null, [
          {
            code: 'REPORT_DIRECTORY_REQUIRED',
            message: '--report-dir is required when --apply is set.',
            retryable: false,
          },
        ]),
      );
    }

    let source: LoadedWorkspaceExport;
    try {
      source = await loadWorkspaceExport(flags['source-dir'], {
        allowPartial: flags['allow-partial'],
      });
      assertWorkspaceSelector({
        workspaceId: flags['workspace-id'],
        workspaceName: flags['workspace-name'],
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const packageVersionFailure =
        /manifest contract\/version is unsupported|schemaVersion\/mode is unsupported/u.test(
          message,
        );
      return this.finish(
        envelope('blocked', flags['api-version'], 'unresolved-org', this.pluginVersion, null, [
          {
            code: packageVersionFailure
              ? 'UNSUPPORTED_PACKAGE_VERSION'
              : 'PACKAGE_VALIDATION_FAILED',
            message,
            retryable: false,
          },
        ]),
      );
    }

    const { connection, orgId } = await this.getOrgContext(
      flags['target-org'],
      flags['api-version'],
    );
    try {
      const selected = await resolveWorkspace(connection, {
        workspaceId: flags['workspace-id'],
        workspaceName: flags['workspace-name'],
      });
      const execution = await executeWorkspaceImport({
        allowPartial: flags['allow-partial'],
        connection,
        destinationOrgId: orgId,
        destinationWorkspace: selected.workspace,
        dryRun: !flags.apply,
        loadedSource: source,
        reportDirectory: flags['report-dir'],
        sourceDirectory: flags['source-dir'],
        workspaceId: selected.id,
      });
      const status: CmsStatus = source.isPartial ? 'partial' : 'success';
      const result = envelope(
        status,
        flags['api-version'],
        orgId,
        this.pluginVersion,
        execution.contractResult,
        [],
      );
      if (!this.jsonEnabled()) this.showPlan(execution, result);
      return this.finish(result);
    } catch (error) {
      return this.finish(
        envelope('failed', flags['api-version'], orgId, this.pluginVersion, null, [
          {
            code: 'IMPORT_FAILED',
            message: error instanceof Error ? error.message : String(error),
            retryable: false,
          },
        ]),
      );
    }
  }

  private finish(result: CmsEnvelope<WorkspaceImportResult>): CmsEnvelope<WorkspaceImportResult> {
    return this.finishEnvelope(result, assertWorkspaceImportResult);
  }

  private showPlan(
    execution: WorkspaceImportExecutionResult,
    envelopeResult: CmsEnvelope<WorkspaceImportResult>,
  ): void {
    const primaryCount = execution.plan.groups.length;
    const variantCount = execution.plan.groups.reduce(
      (count, group) => count + group.variants.length,
      0,
    );
    this.log(`Status: ${envelopeResult.status}`);
    this.log(`Mode: ${execution.dryRun ? 'dry-run (no mutations)' : 'apply (create-only)'}`);
    this.log(`Destination workspace: ${execution.plan.destinationWorkspaceId}`);
    this.log(`Destination root folder: ${execution.plan.rootFolderId}`);
    this.log(`Planned new content: ${primaryCount} parent(s), ${variantCount} child variant(s)`);
    this.log(`Resolved mappings: ${execution.contractResult.mappings.length}`);
    this.log(
      `Explicit unresolved/unsupported references: ${execution.contractResult.references.length}`,
    );
    if (execution.dryRun) {
      this.log('No content was created. Re-run with --apply and a new --report-dir to mutate.');
    } else {
      this.log(`Run report: ${execution.reportFile ?? ''}`);
    }
  }
}

function envelope(
  status: CmsStatus,
  apiVersion: string,
  orgId: string,
  pluginVersion: string,
  result: WorkspaceImportResult | null,
  errors: CmsDiagnostic[],
): CmsEnvelope<WorkspaceImportResult> {
  return {
    contract: WORKSPACE_IMPORT_CONTRACT,
    contractVersion: '1.0.0',
    status,
    metadata: {
      operation: 'workspace.import',
      plugin: { name: 'sf-plugin-cms', version: pluginVersion },
      apiVersion,
    },
    diagnostics: { warnings: [], errors: sanitizeDiagnostics(errors, 'diagnostics.errors') },
    provenance: {
      producer: 'sf-plugin-cms',
      sourceOrgId: orgId,
      pluginVersion,
      command: 'sf cms import workspace',
      generatedAt: new Date().toISOString(),
    },
    result,
  };
}
