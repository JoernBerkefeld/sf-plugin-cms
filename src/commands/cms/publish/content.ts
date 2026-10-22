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
  assertContentPublishResult,
  CONTENT_PUBLISH_CONTRACT,
  type ContentPublishResult,
  type ContentPublishTarget,
} from '../../../contracts/content-publish.js';
import {
  sanitizeDiagnostics,
  type CmsDiagnostic,
  type CmsEnvelope,
  type CmsStatus,
} from '../../../contracts/shared.js';
import {
  applyDraftEmailPublishWithReport,
  EmailPublishOutcomeUnknownError,
  EmailPublishPreflightBlockedError,
  previewDraftEmailPublish,
} from '../../../services/email-publish.js';
import { getCmsApiSelection } from '../../../api-policy.js';
import { apiVersionFlag, CmsCommand, targetOrgFlag } from '../../../command-base.js';

type PublishOutput = CmsEnvelope<ContentPublishResult | ContentLifecycleBatchResult>;

/** Publishes exact unpublished Draft Email variants without sending them. */
export default class PublishContent extends CmsCommand<PublishOutput> {
  public static readonly aliases = ['content:publish'];
  public static readonly summary = 'Preview or publish exact bounded Draft Email variants.';
  public static readonly description =
    'Repeat -m/--metadata Type:ApiName for ordered exact selections (v2), or use --api-name for one legacy Email result (v1). Exactly one selector mode is required; type-only selectors do not expand. Vocabulary recognizes email, emailTemplate, image, document and audio (or their sfdc_cms__ names), but native admission is currently Email-only; other families remain unqualified and blocked. Selects each unpublished Draft sfdc_cms__email variant by workspace ID, API name, and explicit language or workspace default language. Dry-run is the default. --apply requires a new --report-dir and --acknowledge-no-send, writes durable pending intent, then performs one non-retried variant-scoped publish with content references excluded. Publishing CMS content does not send the Email; this command never starts a Flow, transactional send, journey, or campaign.';
  public static readonly examples = [
    '<%= config.bin %> cms publish content --target-org my-org --workspace-id 0Zu... --api-name WelcomeEmail --language en_US --json',
    '<%= config.bin %> cms publish content --target-org my-org --workspace-id 0Zu... --api-name WelcomeEmail --default-language --apply --acknowledge-no-send --report-dir ./cms-publish-report --json',
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
    apply: Flags.boolean({ default: false, summary: 'Apply the one-shot Email variant publish.' }),
    'acknowledge-no-send': Flags.boolean({
      default: false,
      dependsOn: ['apply'],
      summary: 'Acknowledge that publish changes CMS lifecycle state but does not send the Email.',
    }),
    'report-dir': Flags.directory({
      dependsOn: ['apply'],
      exists: false,
      summary: 'New directory for the durable content publish report.',
    }),
  };

  public async run(): Promise<PublishOutput> {
    const { flags } = await this.parse(PublishContent);
    const projectRoot = path.resolve(flags['output-dir'] ?? process.cwd());
    let selectors: readonly ExactLifecycleSelector[] | undefined;
    const reject = (diagnostic: CmsDiagnostic): PublishOutput => {
      const output: PublishOutput = blocked(
        this.pluginVersion,
        flags['api-version'],
        'unresolved-org',
        diagnostic,
      );
      if (selectors !== undefined) {
        output.contractVersion = '2.0.0';
        output.result = {
          selection: 'metadata',
          operation: 'publish',
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
    if (flags.apply && !flags['acknowledge-no-send'])
      return reject({
        code: 'NO_SEND_ACKNOWLEDGEMENT_REQUIRED',
        message: '--acknowledge-no-send is required when --apply is set.',
        retryable: false,
      });
    const { connection, orgId } = await this.getOrgContext(targetOrg, flags['api-version']);
    if (flags['api-version'] === 'latest')
      flags['api-version'] = getCmsApiSelection(connection).effectiveApiVersion;
    if (selectors !== undefined) {
      const batch = await runLifecycleMetadataBatch(
        connection,
        {
          operation: 'publish',
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
      const output: PublishOutput = {
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
      const preview = await previewDraftEmailPublish(connection, input);
      const result: ContentPublishResult =
        preview.status === 'ready'
          ? {
              mode: 'dry-run',
              outcome: 'ready',
              target: target(preview.evidence),
              evidence: {
                selectorScope: 'variant',
                includeContentReferences: false,
                noSendAcknowledgementRequired: true,
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
              evidence: { selectorScope: 'variant', includeContentReferences: false },
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
      const applied = await applyDraftEmailPublishWithReport(
        connection,
        input,
        flags['report-dir']!,
      );
      const result: ContentPublishResult = {
        mode: 'apply',
        outcome: 'completed',
        target: target(applied.evidence),
        evidence: {
          selectorScope: 'variant',
          includeContentReferences: false,
          noSendAcknowledged: true,
          baselineHash: applied.evidence.baselineHash,
          postPublishHash: applied.evidence.postPublishHash,
          deploymentId: applied.evidence.deploymentId,
          inventory: applied.evidence.inventory,
          ...(applied.evidence.publishDate === undefined
            ? {}
            : { publishDate: applied.evidence.publishDate }),
          siblingInventory: applied.evidence.siblingInventory,
        },
        blockers: [],
        reportFile: applied.reportFile,
      };
      const completion: ContentPublishResult =
        applied.localSource?.outcome === 'blocked'
          ? {
              ...result,
              outcome: 'remote-completed-local-blocked',
              blockers: [
                { code: 'EMAIL_PUBLISH_LOCAL_BLOCKED', message: applied.localSource.message },
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
      if (error instanceof EmailPublishPreflightBlockedError) {
        const result: ContentPublishResult = {
          mode: 'apply',
          outcome: 'blocked',
          target: unresolvedTarget(legacyFlags),
          evidence: { selectorScope: 'variant', includeContentReferences: false },
          blockers: [{ code: 'EMAIL_PUBLISH_PREFLIGHT_BLOCKED', message: error.message }],
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
      if (!(error instanceof EmailPublishOutcomeUnknownError)) throw error;
      const reportFile = path.join(flags['report-dir']!, 'content-publish-run.json');
      const result: ContentPublishResult = {
        mode: 'apply',
        outcome: 'ownership-uncertain',
        target: {
          ...unresolvedTarget(legacyFlags),
          contentId: error.contentId,
          variantId: error.variantId,
        },
        evidence: {
          selectorScope: 'variant',
          includeContentReferences: false,
          ...(error.deploymentId === undefined ? {} : { deploymentId: error.deploymentId }),
        },
        blockers: [{ code: 'EMAIL_PUBLISH_OWNERSHIP_UNCERTAIN', message: error.message }],
        reportFile,
        reconciliation: {
          workspaceId: flags['workspace-id'],
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
  private finish(result: PublishOutput): PublishOutput {
    if (result.contractVersion === '2.0.0')
      return this.finishEnvelope(
        result as CmsEnvelope<ContentLifecycleBatchResult>,
        assertContentLifecycleBatchResult,
      );
    return this.finishEnvelope(
      result as CmsEnvelope<ContentPublishResult>,
      assertContentPublishResult,
    );
  }
  private showResult(result: CmsEnvelope<ContentPublishResult>): void {
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
}): ContentPublishTarget {
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
): CmsEnvelope<ContentPublishResult> {
  return envelope('blocked', pluginVersion, apiVersion, orgId, null, [diagnostic]);
}
function envelope(
  status: CmsStatus,
  pluginVersion: string,
  apiVersion: string,
  orgId: string,
  result: ContentPublishResult | null,
  errors: readonly CmsDiagnostic[],
): CmsEnvelope<ContentPublishResult> {
  return {
    contract: CONTENT_PUBLISH_CONTRACT,
    contractVersion: '1.0.0',
    status,
    metadata: {
      operation: 'content.publish',
      plugin: { name: 'sf-plugin-cms', version: pluginVersion },
      apiVersion,
    },
    diagnostics: { warnings: [], errors: sanitizeDiagnostics(errors, 'diagnostics.errors') },
    provenance: {
      producer: 'sf-plugin-cms',
      sourceOrgId: orgId,
      pluginVersion,
      command: 'sf cms publish content',
      generatedAt: new Date().toISOString(),
    },
    result,
  };
}
