import { Flags } from '@salesforce/sf-plugins-core';
import { readFile } from 'node:fs/promises';
import {
  assertWorkspaceImageImportResultV2,
  assertWorkspaceImportResult,
  WORKSPACE_IMPORT_CONTRACT,
  WORKSPACE_IMPORT_CONTRACT_V2,
  type WorkspaceImageImportResultV2,
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
import { UnsupportedWorkspacePackageVersionError } from '../../../contracts/workspace-export.js';
import { assertWorkspaceSelector, resolveWorkspace } from '../../../services/resolve-workspace.js';
import { planEmailFragmentCopies } from '../../../services/email-fragment.js';
import { planWebFragmentCopies } from '../../../services/web-fragment.js';
import {
  applyImageImports,
  planImageImports,
  preflightImageImports,
  type ImageImportApplyResult,
  type ImageImportPreflightResult,
} from '../../../services/image-import.js';
import { apiVersionFlag, CmsCommand, targetOrgFlag } from '../../../command-base.js';

type WorkspaceImportCommandResult = WorkspaceImportResult | WorkspaceImageImportResultV2;

export default class ImportWorkspace extends CmsCommand<CmsEnvelope<WorkspaceImportCommandResult>> {
  public static readonly summary =
    'Safely plan or apply a create-only import into a CMS workspace.';
  public static readonly description =
    'Validates the complete source workspace export locally, selects a destination, and defaults to dry-run. The default profile checks source-key absence, but complete server conflict validation and destination name availability are not established. --native-copy-map selects bounded default-language raw-HTML email/template copies with fresh names and server-generated keys; --editable-dir applies verified HTML-only companion edits against the unchanged baseline. --email-fragment-map selects only the exact dependency-free sfdc_cms__emailFragment root/section/empty-column profile for create-only destination-default-language Drafts with fresh identities. --web-fragment-map selects exact sfdc_cms__webFragment API names, fresh create identities, and exact preserved or explicitly mapped Data Graph developer-name/data-space prerequisites. --image-map selects strict workspace package v2 images for exact destination preflight and sequential create-only apply under contract version 2. Profile map flags are mutually exclusive. Native and edited HTML is not resolved, rewritten, sanitized, or scanned through Phase 7. Pass --apply with a new --report-dir. No updates, publication, activation, send, rollback, or package transaction.';
  public static readonly examples = [
    '<%= config.bin %> cms import workspace --target-org my-org --workspace-name "Destination" --source-dir ./cms/Source',
    '<%= config.bin %> cms import workspace --target-org my-org --workspace-id 0Zu... --source-dir ./cms/Source --apply --report-dir ./cms-import-report --contract-version 1 --json',
    '<%= config.bin %> cms import workspace --target-org my-org --workspace-id 0ZuTARGET --source-dir ./cms-baseline --native-copy-map ./native-copy-map.json --contract-version 1 --json',
    '<%= config.bin %> cms import workspace --target-org my-org --workspace-id 0ZuTARGET --source-dir ./cms-baseline --native-copy-map ./native-copy-map.json --editable-dir ./cms-editable --contract-version 1 --json',
    '<%= config.bin %> cms import workspace --target-org my-org --workspace-id 0ZuTARGET --source-dir ./cms-baseline --email-fragment-map ./email-fragment-map.json --contract-version 1 --json',
    '<%= config.bin %> cms import workspace --target-org my-org --workspace-id 0ZuTARGET --source-dir ./cms-baseline --web-fragment-map ./web-fragment-map.json --contract-version 1 --json',
    '<%= config.bin %> cms import workspace --target-org my-org --workspace-id 0ZuTARGET --source-dir ./cms-v2 --image-map ./image-map.json --contract-version 2 --json',
    '<%= config.bin %> cms import workspace --target-org my-org --workspace-id 0ZuTARGET --source-dir ./cms-v2 --image-map ./image-map.json --contract-version 2 --apply --report-dir ./image-import-report --json',
  ];
  public static readonly flags = {
    'target-org': targetOrgFlag,
    'api-version': apiVersionFlag,
    'contract-version': Flags.integer({
      default: 1,
      min: 1,
      summary: 'Machine contract major version (supported: 1; --image-map requires 2).',
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
      exclusive: ['email-fragment-map', 'web-fragment-map', 'image-map'],
      summary:
        'JSON array selecting native raw-HTML parents: sourceContentKey, language, fresh apiName and urlName. Server generates keys; no updates or publication.',
    }),
    'email-fragment-map': Flags.file({
      exists: true,
      exclusive: ['native-copy-map', 'web-fragment-map', 'editable-dir', 'image-map'],
      summary:
        'JSON array selecting the exact dependency-free email-fragment shape with fresh contentKey/apiName; source title/urlName are preserved and must be fresh.',
    }),
    'web-fragment-map': Flags.file({
      exists: true,
      exclusive: ['native-copy-map', 'email-fragment-map', 'editable-dir', 'image-map'],
      summary:
        'JSON array selecting exact cms/webFragment API names, fresh create identities, and exact Data Graph prerequisite mappings.',
    }),
    'image-map': Flags.file({
      exists: true,
      exclusive: ['native-copy-map', 'email-fragment-map', 'web-fragment-map', 'editable-dir'],
      summary:
        'JSON array selecting strict v2 package images and explicit preserve/fresh/generated identity strategies; requires --contract-version 2.',
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

  public async run(): Promise<CmsEnvelope<WorkspaceImportCommandResult>> {
    const { flags } = await this.parse(ImportWorkspace);
    const requestedVersion = flags['contract-version'] ?? 1;
    const imageProfile = flags['image-map'] !== undefined;
    const profileContractMajor = imageProfile ? 2 : 1;
    if (requestedVersion !== profileContractMajor) {
      const message = imageProfile
        ? '--image-map requires --contract-version 2.'
        : `Contract major ${requestedVersion} is unsupported for this profile; supported major is 1.`;
      return this.finish(
        envelope(
          'blocked',
          profileContractMajor,
          flags['api-version'],
          'unresolved-org',
          this.pluginVersion,
          null,
          [{ code: 'UNSUPPORTED_CONTRACT_VERSION', message, retryable: false }],
        ),
      );
    }
    if (flags.apply && flags['report-dir'] === undefined) {
      return this.finish(
        envelope(
          'blocked',
          profileContractMajor,
          flags['api-version'],
          'unresolved-org',
          this.pluginVersion,
          null,
          [
            {
              code: 'REPORT_DIRECTORY_REQUIRED',
              message: '--report-dir is required when --apply is set.',
              retryable: false,
            },
          ],
        ),
      );
    }

    let source: LoadedWorkspaceExport;
    let emailFragmentMappings: unknown;
    let imagePlans: ReturnType<typeof planImageImports> | undefined;
    let nativeCopyMappings: unknown;
    let webFragmentMappings: unknown;
    try {
      if (flags['editable-dir'] !== undefined && flags['native-copy-map'] === undefined)
        throw new TypeError('--editable-dir requires --native-copy-map');
      source = await loadWorkspaceExport(flags['source-dir'], {
        allowPartial: flags['allow-partial'],
        profile: imageProfile ? 'image' : 'general',
      });
      if (flags['image-map'] !== undefined) {
        const imageMappings = JSON.parse(await readFile(flags['image-map'], 'utf8')) as unknown;
        imagePlans = planImageImports(source, imageMappings);
      }
      if (flags['native-copy-map'] !== undefined) {
        nativeCopyMappings = JSON.parse(
          await readFile(flags['native-copy-map'], 'utf8'),
        ) as unknown;
        await planNativeWorkspaceImport(source, nativeCopyMappings, flags['editable-dir']);
      }
      if (flags['email-fragment-map'] !== undefined) {
        emailFragmentMappings = JSON.parse(
          await readFile(flags['email-fragment-map'], 'utf8'),
        ) as unknown;
        planEmailFragmentCopies(source, emailFragmentMappings);
      }
      if (flags['web-fragment-map'] !== undefined) {
        webFragmentMappings = JSON.parse(
          await readFile(flags['web-fragment-map'], 'utf8'),
        ) as unknown;
        planWebFragmentCopies(source, webFragmentMappings);
      }
      assertWorkspaceSelector({
        workspaceId: flags['workspace-id'],
        workspaceName: flags['workspace-name'],
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const packageVersionFailure = error instanceof UnsupportedWorkspacePackageVersionError;
      return this.finish(
        envelope(
          'blocked',
          profileContractMajor,
          flags['api-version'],
          'unresolved-org',
          this.pluginVersion,
          null,
          [
            {
              code: packageVersionFailure
                ? 'UNSUPPORTED_PACKAGE_VERSION'
                : 'PACKAGE_VALIDATION_FAILED',
              message,
              retryable: false,
            },
          ],
        ),
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
      if (imagePlans !== undefined) {
        const execution = flags.apply
          ? await applyImageImports({
              connection,
              destinationOrgId: orgId,
              destinationWorkspaceId: selected.id,
              plans: imagePlans,
              reportDirectory: flags['report-dir']!,
              source,
            })
          : await preflightImageImports({
              connection,
              destinationOrgId: orgId,
              destinationWorkspaceId: selected.id,
              plans: imagePlans,
              source,
            });
        const result = envelope(
          'success',
          2,
          flags['api-version'],
          orgId,
          this.pluginVersion,
          execution.contractResult,
          [],
        );
        if (!this.jsonEnabled()) this.showImagePlan(execution, result);
        return this.finish(result);
      }
      const execution = await executeWorkspaceImport({
        allowPartial: flags['allow-partial'],
        connection,
        destinationOrgId: orgId,
        destinationWorkspace: selected.workspace,
        dryRun: !flags.apply,
        loadedSource: source,
        editableDirectory: flags['editable-dir'],
        emailFragmentMappings,
        nativeCopyMappings,
        webFragmentMappings,
        reportDirectory: flags['report-dir'],
        sourceDirectory: flags['source-dir'],
        workspaceId: selected.id,
      });
      const status: CmsStatus = source.isPartial ? 'partial' : 'success';
      const result = envelope(
        status,
        1,
        flags['api-version'],
        orgId,
        this.pluginVersion,
        execution.contractResult,
        [],
        execution.diagnostics,
      );
      if (!this.jsonEnabled())
        this.showPlan(execution, result as CmsEnvelope<WorkspaceImportResult>);
      return this.finish(result);
    } catch (error) {
      return this.finish(
        envelope(
          'failed',
          profileContractMajor,
          flags['api-version'],
          orgId,
          this.pluginVersion,
          null,
          [
            {
              code: 'IMPORT_FAILED',
              message: error instanceof Error ? error.message : String(error),
              retryable: false,
            },
          ],
        ),
      );
    }
  }

  private finish(
    result: CmsEnvelope<WorkspaceImportCommandResult>,
  ): CmsEnvelope<WorkspaceImportCommandResult> {
    return result.contractVersion === '2.0.0'
      ? this.finishEnvelope(result, assertWorkspaceImageImportResultV2)
      : this.finishEnvelope(result, assertWorkspaceImportResult);
  }

  private showImagePlan(
    execution: ImageImportApplyResult | ImageImportPreflightResult,
    envelopeResult: CmsEnvelope<WorkspaceImportCommandResult>,
  ): void {
    this.log(`Status: ${envelopeResult.status}`);
    this.log(`Mode: ${execution.dryRun ? 'dry-run (preflight only)' : 'apply (create-only)'}`);
    this.log(`Destination workspace: ${execution.contractResult.target.workspaceId}`);
    this.log(`Selected images: ${execution.contractResult.assets.length}`);
    this.log(`Image result: ${execution.contractResult.status}`);
    if (execution.dryRun) {
      this.log(
        'No images were created. Every selected identity passed exact destination preflight.',
      );
      this.log(
        'Binary byte proof remains unavailable; apply is sequential and stops on first error.',
      );
    } else {
      this.log(`Run report: ${execution.reportFile}`);
      this.log(
        'Images were created sequentially; metadata readback passed for every completed asset.',
      );
    }
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
  contractMajor: 1 | 2,
  apiVersion: string,
  orgId: string,
  pluginVersion: string,
  result: WorkspaceImportCommandResult | null,
  errors: CmsDiagnostic[],
  warnings: CmsDiagnostic[] = [],
): CmsEnvelope<WorkspaceImportCommandResult> {
  return {
    contract: contractMajor === 2 ? WORKSPACE_IMPORT_CONTRACT_V2 : WORKSPACE_IMPORT_CONTRACT,
    contractVersion: contractMajor === 2 ? '2.0.0' : '1.0.0',
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
