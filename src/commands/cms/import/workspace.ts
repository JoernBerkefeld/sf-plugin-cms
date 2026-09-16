import { Flags } from '@salesforce/sf-plugins-core';
import { readFile } from 'node:fs/promises';
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
  planNativeWorkspaceImport,
  type LoadedWorkspaceExport,
  type WorkspaceImportExecutionResult,
} from '../../../services/import-workspace.js';
import { assertWorkspaceSelector, resolveWorkspace } from '../../../services/resolve-workspace.js';
import { apiVersionFlag, CmsCommand, targetOrgFlag } from '../../../command-base.js';

export default class ImportWorkspace extends CmsCommand<CmsEnvelope<WorkspaceImportResult>> {
  public static readonly summary =
    'Safely plan or apply a create-only import into a CMS workspace.';
  public static readonly description =
    'Validates the complete source workspace export locally, selects a destination, and defaults to dry-run. The default profile checks source-key absence, but complete server conflict validation and destination name availability are not established. --native-copy-map selects bounded default-language raw-HTML email/template copies with fresh names and server-generated keys; --editable-dir applies verified HTML-only companion edits against the unchanged baseline. Native and edited HTML is not resolved, rewritten, sanitized, or scanned through Phase 7. Pass --apply with a new --report-dir. No updates, publication, rollback, or package transaction.';
  public static readonly examples = [
    '<%= config.bin %> cms import workspace --target-org my-org --workspace-name "Destination" --source-dir ./cms/Source',
    '<%= config.bin %> cms import workspace --target-org my-org --workspace-id 0Zu... --source-dir ./cms/Source --apply --report-dir ./cms-import-report --contract-version 1 --json',
    '<%= config.bin %> cms import workspace --target-org my-org --workspace-id 0ZuTARGET --source-dir ./cms-baseline --native-copy-map ./native-copy-map.json --contract-version 1 --json',
    '<%= config.bin %> cms import workspace --target-org my-org --workspace-id 0ZuTARGET --source-dir ./cms-baseline --native-copy-map ./native-copy-map.json --editable-dir ./cms-editable --contract-version 1 --json',
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
    'editable-dir': Flags.directory({
      exists: true,
      dependsOn: ['native-copy-map'],
      summary:
        'Verified companion directory with editable native email/template raw HTML; original source package remains required.',
    }),
    'native-copy-map': Flags.file({
      exists: true,
      summary:
        'JSON array selecting native raw-HTML parents: sourceContentKey, language, fresh apiName and urlName. Server generates keys; no updates or publication.',
    }),
    apply: Flags.boolean({
      default: false,
      summary:
        'Create after local validation and bounded profile preflight; dry-run does not establish full conflict or apply readiness.',
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
    let nativeCopyMappings: unknown;
    try {
      if (flags['editable-dir'] !== undefined && flags['native-copy-map'] === undefined)
        throw new TypeError('--editable-dir requires --native-copy-map');
      source = await loadWorkspaceExport(flags['source-dir'], {
        allowPartial: flags['allow-partial'],
      });
      if (flags['native-copy-map'] !== undefined) {
        nativeCopyMappings = JSON.parse(
          await readFile(flags['native-copy-map'], 'utf8'),
        ) as unknown;
        await planNativeWorkspaceImport(source, nativeCopyMappings, flags['editable-dir']);
      }
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
        editableDirectory: flags['editable-dir'],
        nativeCopyMappings,
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
        execution.diagnostics,
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
      this.log('No content was created. This proposal does not establish deploy readiness.');
      for (const diagnostic of execution.diagnostics) this.log(diagnostic.message);
    } else {
      this.log(`Run report: ${execution.reportFile ?? ''}`);
      for (const diagnostic of execution.diagnostics) this.log(diagnostic.message);
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
  warnings: CmsDiagnostic[] = [],
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
    diagnostics: {
      warnings: sanitizeDiagnostics(warnings, 'diagnostics.warnings'),
      errors: sanitizeDiagnostics(errors, 'diagnostics.errors'),
    },
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
