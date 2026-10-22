import { Flags } from '@salesforce/sf-plugins-core';
import path from 'node:path';
import {
  assertContentLifecycleBatchResult,
  type ContentLifecycleBatchResult,
  type ExactLifecycleSelector,
} from '../../../contracts/content-lifecycle-batch.js';
import { runLifecycleMetadataBatch } from '../../../services/lifecycle-batch.js';
import { normalizeLifecycleMetadata } from '../../../services/lifecycle-selection.js';

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
import { getCmsApiSelection } from '../../../api-policy.js';
import { apiVersionFlag, CmsCommand, targetOrgFlag } from '../../../command-base.js';

type UnpublishOutput = CmsEnvelope<ContentUnpublishResult | ContentLifecycleBatchResult>;

/** Unpublishes exact published Email variants without deleting them. */
export default class UnpublishContent extends CmsCommand<UnpublishOutput> {
  public static readonly aliases = ['content:unpublish'];
  public static readonly summary = 'Preview or parent-unpublish exact bounded published Emails.';
  public static readonly description =
    'Repeat -m/--metadata Type:ApiName for ordered exact selections (v2), or use --api-name for one legacy Email result (v1). Exactly one selector mode is required; type-only selectors do not expand. Vocabulary recognizes email, emailTemplate, image, document and audio (or their sfdc_cms__ names), but native admission is currently Email-only; other families remain unqualified and blocked. Selects each Published sfdc_cms__email by workspace ID, API name, and explicit language or workspace default language, and requires fresh proof that its parent has exactly one variant. Dry-run is the default and shows parent scope. --apply requires a new --report-dir and --acknowledge-active-use-stops before org access. Unpublish removes the Email from active use but does not delete it.';
  public static readonly examples = [
    '<%= config.bin %> cms unpublish content --target-org my-org --workspace-id 0Zu... --api-name WelcomeEmail --language en_US --json',
    '<%= config.bin %> cms unpublish content --target-org my-org --workspace-id 0Zu... --api-name WelcomeEmail --default-language --apply --acknowledge-active-use-stops --report-dir ./cms-unpublish-report --json',
  ];
  public static readonly flags = {
    'target-org': targetOrgFlag,
    'api-version': apiVersionFlag,
    'contract-version': Flags.integer({
      min: 1,
      summary:
        'Machine contract major: 1 for --api-name, 2 for --metadata; selected automatically when omitted.',
    }),
    'workspace-id': Flags.string({ required: true, summary: 'Exact CMS workspace ID.' }),
    'api-name': Flags.string({
      exclusive: ['metadata'],
      summary: 'Exact Email API name (legacy single-result v1).',
    }),
    metadata: Flags.string({
      char: 'm',
      multiple: true,
      multipleNonGreedy: true,
      exclusive: ['api-name'],
      summary: 'Exact Type:ApiName; repeat in execution order (batch v2). No implicit expansion.',
    }),
    'output-dir': Flags.directory({
      char: 'd',
      summary: 'Local source root for inspection and synchronization (default: current directory).',
    }),
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

  public async run(): Promise<UnpublishOutput> {
    const { flags } = await this.parse(UnpublishContent);
    const projectRoot = path.resolve(flags['output-dir'] ?? process.cwd());
    let selectors: readonly ExactLifecycleSelector[] | undefined;
    const reject = (diagnostic: CmsDiagnostic): UnpublishOutput => {
      const output: UnpublishOutput = blocked(
        this.pluginVersion,
        flags['api-version'],
        'unresolved-org',
        diagnostic,
      );
      if (selectors !== undefined) {
        output.contractVersion = '2.0.0';
        output.result = {
          selection: 'metadata',
          operation: 'unpublish',
          mode: flags.apply ? 'apply' : 'dry-run',
          outcome: 'blocked',
          stop: { index: 0, outcome: 'blocked' },
          items: selectors.map((selector, index) => ({
            index,
            selector,
            outcome: index === 0 ? 'blocked' : 'unattempted',
            blockers: index === 0 ? [{ code: diagnostic.code, message: diagnostic.message }] : [],
          })),
        };
      }
      return this.finish(output);
    };
    try {
      if ((flags.metadata === undefined) === (flags['api-name'] === undefined))
        throw new TypeError('Specify exactly one of --metadata or --api-name.');
      if (flags.metadata !== undefined) selectors = normalizeLifecycleMetadata(flags.metadata);
    } catch (error) {
      return reject({
        code: 'LIFECYCLE_SELECTOR_REQUIRED',
        message: (error as Error).message,
        retryable: false,
      });
    }
    const targetOrg = flags['target-org'].getUsername()!;
    if (
      (flags['contract-version'] ?? (selectors === undefined ? 1 : 2)) !==
      (selectors === undefined ? 1 : 2)
    )
      return reject({
        code: 'UNSUPPORTED_CONTRACT_VERSION',
        message: 'Use contract major 1 with --api-name or major 2 with --metadata.',
        retryable: false,
      });
    if ((flags.language === undefined) === !flags['default-language'])
      return reject({
        code: 'LANGUAGE_SELECTOR_REQUIRED',
        message: 'Specify exactly one of --language or --default-language.',
        retryable: false,
      });
    if (flags.apply && flags['report-dir'] === undefined)
      return reject({
        code: 'REPORT_DIRECTORY_REQUIRED',
        message: '--report-dir is required when --apply is set.',
        retryable: false,
      });
    if (flags.apply && !flags['acknowledge-active-use-stops'])
      return reject({
        code: 'ACTIVE_USE_STOPS_ACKNOWLEDGEMENT_REQUIRED',
        message:
          '--acknowledge-active-use-stops is required when --apply is set because unpublish removes content from active use but does not delete it.',
        retryable: false,
      });
    const { connection, orgId } = await this.getOrgContext(targetOrg, flags['api-version']);
    if (flags['api-version'] === 'latest')
      flags['api-version'] = getCmsApiSelection(connection).effectiveApiVersion;
    if (selectors !== undefined) {
      const batch = await runLifecycleMetadataBatch(
        connection,
        {
          operation: 'unpublish',
          selectors,
          workspaceId: flags['workspace-id'],
          ...(flags.language === undefined
            ? { useDefaultLanguage: true as const }
            : { language: flags.language }),
        },
        {
          mode: flags.apply ? 'apply' : 'dry-run',
          reportDirectory: flags['report-dir'],
          projectRoot,
        },
      );
      const output: UnpublishOutput = {
        ...envelope(
          batch.status,
          this.pluginVersion,
          flags['api-version'],
          orgId,
          null,
          batch.result.items.flatMap((item) => item.blockers),
        ),
        contractVersion: '2.0.0',
        result: batch.result,
      };
      if (!this.jsonEnabled()) {
        this.log(
          `Status: ${output.status}; mode: ${batch.result.mode}; outcome: ${batch.result.outcome}`,
        );
        for (const item of batch.result.items)
          this.log(`${item.selector.contentType}:${item.selector.apiName}: ${item.outcome}`);
        if (batch.result.reportFile) this.log(`Run report: ${batch.result.reportFile}`);
      }
      return this.finish(output);
    }
    const legacyFlags = { ...flags, 'api-name': flags['api-name']! };
    const input = {
      projectRoot,
      selector: {
        workspaceId: flags['workspace-id'],
        apiName: legacyFlags['api-name'],
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
              target: unresolvedTarget(legacyFlags),
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
      const completion: ContentUnpublishResult =
        applied.localSource?.outcome === 'blocked'
          ? {
              ...result,
              outcome: 'remote-completed-local-blocked',
              blockers: [
                { code: 'EMAIL_UNPUBLISH_LOCAL_BLOCKED', message: applied.localSource.message },
              ],
              localSource: applied.localSource,
              ...(applied.localReportFile === undefined
                ? {}
                : { localReportFile: applied.localReportFile }),
            }
          : result;
      const output = envelope(
        completion.outcome === 'completed' ? 'success' : 'partial',
        this.pluginVersion,
        flags['api-version'],
        orgId,
        completion,
        completion.blockers,
      );
      if (!this.jsonEnabled()) this.showResult(output);
      return this.finish(output);
    } catch (error) {
      if (error instanceof EmailUnpublishPreflightBlockedError) {
        const result: ContentUnpublishResult = {
          mode: 'apply',
          outcome: 'blocked',
          target: unresolvedTarget(legacyFlags),
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
  private finish(result: UnpublishOutput): UnpublishOutput {
    if (result.contractVersion === '2.0.0')
      return this.finishEnvelope(
        result as CmsEnvelope<ContentLifecycleBatchResult>,
        assertContentLifecycleBatchResult,
      );
    return this.finishEnvelope(
      result as CmsEnvelope<ContentUnpublishResult>,
      assertContentUnpublishResult,
    );
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
