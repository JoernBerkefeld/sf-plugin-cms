import { Flags } from '@salesforce/sf-plugins-core';
import {
  assertWorkspaceExportSetResult,
  type WorkspaceExportSetResult,
} from '../../../contracts/workspace-export.js';
import { assertSupportedMajor, type CmsEnvelope } from '../../../contracts/shared.js';
import {
  exportAllWorkspaces,
  normalizeWorkspaceType,
} from '../../../services/bulk-export-workspaces.js';
import {
  defaultWorkspaceDestination,
  exportWorkspace,
  type ExportWorkspaceResult,
  type WorkspaceExportWarning,
} from '../../../services/export-workspace.js';
import { assertWorkspaceSelector, resolveWorkspace } from '../../../services/resolve-workspace.js';
import { apiVersionFlag, CmsCommand, targetOrgFlag } from '../../../command-base.js';

type WorkspaceExportCommandResult = CmsEnvelope<WorkspaceExportSetResult> | ExportWorkspaceResult;

export default class ExportWorkspace extends CmsCommand<WorkspaceExportCommandResult> {
  public static readonly summary =
    'Experimentally export one or all CMS workspaces using a read-only, best-effort process.';
  public static readonly description =
    'Experimentally exports one Marketing Cloud CMS workspace selected by exact ID or case-insensitive exact name, or preflights and exports all workspaces under a parent directory. Canonical fetched names and casing are preserved. Bulk preflight is global and strict; execution then continues across individual failures and returns a complete aggregate. This is not a complete or guaranteed backup and does not mutate org data.';
  public static readonly examples = [
    '<%= config.bin %> cms export workspace --target-org my-org --workspace-name "Main Site"',
    '<%= config.bin %> cms export workspace --target-org my-org --workspace-id 0Zu... --output-dir ./cms-export',
    '<%= config.bin %> cms export workspace --target-org my-org --all --workspace-type Marketing --output-dir ./cms --contract-version 1 --json',
  ];
  public static readonly flags = {
    'target-org': targetOrgFlag,
    'api-version': apiVersionFlag,
    'contract-version': Flags.integer({
      default: 1,
      min: 1,
      summary: 'Machine contract major version (supported: 1).',
    }),
    all: Flags.boolean({
      exclusive: ['workspace-id', 'workspace-name'],
      summary: 'Export every CMS workspace after a strict global preflight.',
    }),
    'workspace-id': Flags.string({
      exclusive: ['all', 'workspace-name'],
      summary: 'Exact CMS workspace content-space ID.',
    }),
    'workspace-name': Flags.string({
      exclusive: ['all', 'workspace-id'],
      summary: 'Exact case-insensitive CMS workspace name.',
    }),
    'workspace-type': Flags.string({
      dependsOn: ['all'],
      parse: async (input) => normalizeWorkspaceType(input),
      summary: 'Bulk-only workspace type filter: Marketing or Content (case-insensitive).',
    }),
    'output-dir': Flags.directory({
      exists: false,
      summary:
        'Single: exact new destination. Bulk: parent directory. Defaults to ./cms/<name> or ./cms.',
    }),
  };

  public async run(): Promise<WorkspaceExportCommandResult> {
    const { flags } = await this.parse(ExportWorkspace);
    const isBulk = flags.all === true;
    const contractVersion = flags['contract-version'] ?? 1;
    if (contractVersion !== 1) {
      const blocked = blockedEnvelope(contractVersion, flags['api-version'], this.pluginVersion);
      if (!this.jsonEnabled()) this.styledJSON(blocked);
      return this.finishEnvelope(blocked, assertWorkspaceExportSetResult);
    }
    if (isBulk) assertSupportedMajor(contractVersion);
    if (!isBulk) {
      assertWorkspaceSelector({
        workspaceId: flags['workspace-id'],
        workspaceName: flags['workspace-name'],
      });
      if (flags['workspace-type'] !== undefined) {
        throw new Error('--workspace-type is valid only with --all.');
      }
    }

    if (isBulk) {
      const { connection, orgId } = await this.getOrgContext(
        flags['target-org'],
        flags['api-version'],
      );
      const workspaceType = normalizeWorkspaceType(flags['workspace-type'] ?? 'Marketing');
      const result = await exportAllWorkspaces(
        connection,
        flags['output-dir'] ?? './cms',
        workspaceType,
        {
          apiVersion: flags['api-version'],
          pluginVersion: this.pluginVersion,
          sourceOrgId: orgId,
        },
      );
      if (!this.jsonEnabled()) this.styledJSON(result);
      return this.finishEnvelope(result, assertWorkspaceExportSetResult);
    }

    const connection = await this.getConnection(flags['target-org'], flags['api-version']);
    const selected = await resolveWorkspace(connection, {
      workspaceId: flags['workspace-id'],
      workspaceName: flags['workspace-name'],
    });
    let destination = flags['output-dir'];
    if (destination === undefined) {
      const workspaceName = selected.workspace.name;
      if (typeof workspaceName !== 'string' || workspaceName.length === 0) {
        throw new Error('Selected workspace has no usable name. Pass --output-dir explicitly.');
      }
      destination = defaultWorkspaceDestination(workspaceName);
    }
    const result = await exportWorkspace(connection, selected.id, destination, {
      pluginVersion: this.pluginVersion,
    });
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

function blockedEnvelope(
  requestedVersion: number,
  apiVersion: string,
  pluginVersion: string,
): CmsEnvelope<WorkspaceExportSetResult> {
  return {
    contract: 'sf-cms-workspace-export-set',
    contractVersion: '1.0.0',
    status: 'blocked',
    metadata: {
      operation: 'workspace.export.bulk',
      plugin: { name: 'sf-plugin-cms', version: pluginVersion },
      apiVersion,
    },
    diagnostics: {
      warnings: [],
      errors: [
        {
          code: 'UNSUPPORTED_CONTRACT_VERSION',
          message: `Contract major ${requestedVersion} is unsupported; supported major is 1.`,
          retryable: false,
        },
      ],
    },
    provenance: {
      producer: 'sf-plugin-cms',
      sourceOrgId: 'unresolved-org',
      pluginVersion,
      command: 'sf cms export workspace',
      generatedAt: new Date().toISOString(),
    },
    result: null,
  };
}

function formatWarning(warning: WorkspaceExportWarning): string {
  const variantIds = warning.variantIds?.length ? ` (${warning.variantIds.join(', ')})` : '';
  return `[${warning.code}] ${warning.message}${variantIds}`;
}
