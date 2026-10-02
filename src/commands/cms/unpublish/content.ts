import { Flags } from '@salesforce/sf-plugins-core';
import {
  assertContentUnpublishResult,
  CONTENT_UNPUBLISH_CONTRACT,
  type ContentUnpublishResult,
  type ContentUnpublishTarget,
} from '../../../contracts/content-unpublish.js';
import {
  sanitizeDiagnostics,
  type CmsDiagnostic,
  type CmsEnvelope,
  type CmsStatus,
} from '../../../contracts/shared.js';
import {
  applyPublishedEmailUnpublishWithReport,
  EmailUnpublishOutcomeUnknownError,
  EmailUnpublishPreflightBlockedError,
  previewPublishedEmailUnpublish,
} from '../../../services/email-unpublish.js';
import { apiVersionFlag, CmsCommand, targetOrgFlag } from '../../../command-base.js';

/** Unpublishes one exact published Email variant without deleting it. */
export default class UnpublishContent extends CmsCommand<CmsEnvelope<ContentUnpublishResult>> {
  public static readonly summary = 'Preview or parent-unpublish one bounded published Email.';
  public static readonly description =
    'Selects exactly one Published sfdc_cms__email by workspace ID, API name, and explicit language or workspace default language, and requires fresh proof that its parent has exactly one variant. Dry-run is the default and shows parent scope. --apply requires a new --report-dir and --acknowledge-active-use-stops before org access. Unpublish removes the Email from active use but does not delete it.';
  public static readonly examples = [
    '<%= config.bin %> cms unpublish content --target-org my-org --workspace-id 0Zu... --api-name WelcomeEmail --language en_US --json',
    '<%= config.bin %> cms unpublish content --target-org my-org --workspace-id 0Zu... --api-name WelcomeEmail --default-language --apply --acknowledge-active-use-stops --report-dir ./cms-unpublish-report --json',
  ];
  public static readonly flags = {
    'target-org': targetOrgFlag,
    'api-version': apiVersionFlag,
    'contract-version': Flags.integer({
      default: 1,
      min: 1,
      summary: 'Machine contract major version (supported: 1).',
    }),
    'workspace-id': Flags.string({ required: true, summary: 'Exact CMS workspace ID.' }),
    'api-name': Flags.string({ required: true, summary: 'Exact Email API name.' }),
    language: Flags.string({ exclusive: ['default-language'], summary: 'Exact Email language.' }),
    'default-language': Flags.boolean({
      default: false,
      exclusive: ['language'],
      summary: 'Select the exact workspace default-language Email variant.',
    }),
    apply: Flags.boolean({
      default: false,
      summary: 'Apply the one-shot Email variant unpublish.',
    }),
    'acknowledge-active-use-stops': Flags.boolean({
      default: false,
      dependsOn: ['apply'],
      summary: 'Acknowledge that unpublish removes content from active use but does not delete it.',
    }),
    'report-dir': Flags.directory({
      dependsOn: ['apply'],
      exists: false,
      summary: 'New directory for the durable content unpublish report.',
    }),
  };

  public async run(): Promise<CmsEnvelope<ContentUnpublishResult>> {
    const { flags } = await this.parse(UnpublishContent);
    if ((flags['contract-version'] ?? 1) !== 1)
      return this.finish(
        blocked(this.pluginVersion, flags['api-version'], 'unresolved-org', {
          code: 'UNSUPPORTED_CONTRACT_VERSION',
          message: 'Only contract major 1 is supported.',
          retryable: false,
        }),
      );
    if ((flags.language === undefined) === !flags['default-language'])
      return this.finish(
        blocked(this.pluginVersion, flags['api-version'], 'unresolved-org', {
          code: 'LANGUAGE_SELECTOR_REQUIRED',
          message: 'Specify exactly one of --language or --default-language.',
          retryable: false,
        }),
      );
    if (flags.apply && flags['report-dir'] === undefined)
      return this.finish(
        blocked(this.pluginVersion, flags['api-version'], 'unresolved-org', {
          code: 'REPORT_DIRECTORY_REQUIRED',
          message: '--report-dir is required when --apply is set.',
          retryable: false,
        }),
      );
    if (flags.apply && !flags['acknowledge-active-use-stops'])
      return this.finish(
        blocked(this.pluginVersion, flags['api-version'], 'unresolved-org', {
          code: 'ACTIVE_USE_STOPS_ACKNOWLEDGEMENT_REQUIRED',
          message:
            '--acknowledge-active-use-stops is required when --apply is set because unpublish removes content from active use but does not delete it.',
          retryable: false,
        }),
      );
    const { connection, orgId } = await this.getOrgContext(
      flags['target-org'],
      flags['api-version'],
    );
    const input = {
      selector: {
        workspaceId: flags['workspace-id'],
        apiName: flags['api-name'],
        ...(flags.language === undefined
          ? { useDefaultLanguage: true as const }
          : { language: flags.language }),
      },
    };
    if (!flags.apply) {
      const preview = await previewPublishedEmailUnpublish(connection, input);
      const result: ContentUnpublishResult =
        preview.status === 'ready'
          ? {
              mode: 'dry-run',
              outcome: 'ready',
              target: target(preview.evidence),
              evidence: {
                selectorScope: 'parent',
                includeContentReferencesOmitted: true,
                activeUseStopsAcknowledgementRequired: true,
                baselineHash: preview.evidence.baselineHash,
                inventory: preview.evidence.inventory,
                siblingInventory: preview.evidence.siblingInventory,
              },
              blockers: [],
            }
          : {
              mode: 'dry-run',
              outcome: 'blocked',
              target: unresolvedTarget(flags),
              evidence: { selectorScope: 'parent', includeContentReferencesOmitted: true },
              blockers: preview.blockers,
            };
      const output = envelope(
        preview.status === 'ready' ? 'success' : 'blocked',
        this.pluginVersion,
        flags['api-version'],
        orgId,
        result,
        preview.status === 'ready' ? [] : preview.blockers,
      );
      if (!this.jsonEnabled()) this.showResult(output);
      return this.finish(output);
    }
    try {
      const applied = await applyPublishedEmailUnpublishWithReport(
        connection,
        input,
        flags['report-dir']!,
      );
      const result: ContentUnpublishResult = {
        mode: 'apply',
        outcome: 'completed',
        target: target(applied.evidence),
        evidence: {
          selectorScope: 'parent',
          includeContentReferencesOmitted: true,
          activeUseStopsAcknowledged: true,
          baselineHash: applied.evidence.baselineHash,
          postUnpublishHash: applied.evidence.postUnpublishHash,
          deploymentId: applied.evidence.deploymentId,
          ...(applied.evidence.unpublishDate === undefined
            ? {}
            : { unpublishDate: applied.evidence.unpublishDate }),
          inventory: applied.evidence.inventory,
          siblingInventory: applied.evidence.siblingInventory,
        },
        blockers: [],
        reportFile: applied.reportFile,
      };
      const output = envelope(
        'success',
        this.pluginVersion,
        flags['api-version'],
        orgId,
        result,
        [],
      );
      if (!this.jsonEnabled()) this.showResult(output);
      return this.finish(output);
    } catch (error) {
      if (error instanceof EmailUnpublishPreflightBlockedError) {
        const result: ContentUnpublishResult = {
          mode: 'apply',
          outcome: 'blocked',
          target: unresolvedTarget(flags),
          evidence: { selectorScope: 'parent', includeContentReferencesOmitted: true },
          blockers: [{ code: 'EMAIL_UNPUBLISH_PREFLIGHT_BLOCKED', message: error.message }],
        };
        const output = envelope(
          'blocked',
          this.pluginVersion,
          flags['api-version'],
          orgId,
          result,
          result.blockers,
        );
        if (!this.jsonEnabled()) this.showResult(output);
        return this.finish(output);
      }
      if (!(error instanceof EmailUnpublishOutcomeUnknownError)) throw error;
      const rejected = error.mutationError.classification === 'definite-pre-mutation-rejection';
      const result: ContentUnpublishResult = {
        mode: 'apply',
        outcome: rejected ? 'rejected-before-mutation' : 'ownership-uncertain',
        target: {
          workspaceId: error.workspaceId,
          apiName: error.apiName,
          language: error.language,
          contentId: error.contentId,
          variantId: error.variantId,
        },
        evidence: {
          selectorScope: 'parent',
          includeContentReferencesOmitted: true,
          ...(error.deploymentId === undefined ? {} : { deploymentId: error.deploymentId }),
          mutationError: error.mutationError,
        },
        blockers: [
          {
            code: rejected
              ? 'EMAIL_UNPUBLISH_REJECTED_BEFORE_MUTATION'
              : 'EMAIL_UNPUBLISH_OWNERSHIP_UNCERTAIN',
            message: rejected
              ? 'Email unpublish was rejected before mutation; no retry was attempted'
              : error.message,
          },
        ],
        reportFile: error.reportFile,
        reconciliation: {
          workspaceId: error.workspaceId,
          contentId: error.contentId,
          variantId: error.variantId,
          ...(error.deploymentId === undefined ? {} : { deploymentId: error.deploymentId }),
        },
      };
      const output = envelope(
        'failed',
        this.pluginVersion,
        flags['api-version'],
        orgId,
        result,
        result.blockers,
      );
      if (!this.jsonEnabled()) this.showResult(output);
      return this.finish(output);
    }
  }
  private finish(result: CmsEnvelope<ContentUnpublishResult>): CmsEnvelope<ContentUnpublishResult> {
    return this.finishEnvelope(result, assertContentUnpublishResult);
  }
  private showResult(result: CmsEnvelope<ContentUnpublishResult>): void {
    this.log(`Status: ${result.status}`);
    this.log(`Mode: ${result.result?.mode ?? 'unknown'}`);
    this.log(`Outcome: ${result.result?.outcome ?? 'unknown'}`);
    if (result.result && 'variantId' in result.result.target)
      this.log(`Variant: ${result.result.target.variantId}`);
    if (result.result && 'reportFile' in result.result)
      this.log(`Run report: ${result.result.reportFile}`);
    for (const item of result.result?.blockers ?? [])
      this.log(`Blocker ${item.code}: ${item.message}`);
  }
}
function unresolvedTarget(flags: {
  'workspace-id': string;
  'api-name': string;
  language?: string;
}): { workspaceId: string; apiName: string; language: string } {
  return {
    workspaceId: flags['workspace-id'],
    apiName: flags['api-name'],
    language: flags.language ?? 'workspace-default',
  };
}
function target(value: {
  workspaceId: string;
  apiName: string;
  language: string;
  contentId: string;
  variantId: string;
}): ContentUnpublishTarget {
  return {
    workspaceId: value.workspaceId,
    apiName: value.apiName,
    language: value.language,
    contentId: value.contentId,
    variantId: value.variantId,
  };
}
function blocked(
  pluginVersion: string,
  apiVersion: string,
  orgId: string,
  diagnostic: CmsDiagnostic,
): CmsEnvelope<ContentUnpublishResult> {
  return envelope('blocked', pluginVersion, apiVersion, orgId, null, [diagnostic]);
}
function envelope(
  status: CmsStatus,
  pluginVersion: string,
  apiVersion: string,
  orgId: string,
  result: ContentUnpublishResult | null,
  errors: readonly CmsDiagnostic[],
): CmsEnvelope<ContentUnpublishResult> {
  return {
    contract: CONTENT_UNPUBLISH_CONTRACT,
    contractVersion: '1.0.0',
    status,
    metadata: {
      operation: 'content.unpublish',
      plugin: { name: 'sf-plugin-cms', version: pluginVersion },
      apiVersion,
    },
    diagnostics: { warnings: [], errors: sanitizeDiagnostics(errors, 'diagnostics.errors') },
    provenance: {
      producer: 'sf-plugin-cms',
      sourceOrgId: orgId,
      pluginVersion,
      command: 'sf cms unpublish content',
      generatedAt: new Date().toISOString(),
    },
    result,
  };
}
