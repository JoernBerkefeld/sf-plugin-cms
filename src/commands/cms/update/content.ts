import { Flags } from '@salesforce/sf-plugins-core';
import path from 'node:path';
import {
  assertContentUpdateResult,
  CONTENT_UPDATE_CONTRACT,
  type ContentUpdateResult,
  type ContentUpdateTarget,
  type PreparedContentUpdateEvidence,
} from '../../../contracts/content-update.js';
import {
  sanitizeDiagnostics,
  type CmsDiagnostic,
  type CmsEnvelope,
  type CmsStatus,
} from '../../../contracts/shared.js';
import {
  applyDraftEmailUpdateWithReport,
  EMAIL_TEMPLATE_UPDATE_CONTENT_TYPE,
  EMAIL_UPDATE_CONTENT_TYPE,
  EmailUpdateOutcomeUnknownError,
  EmailUpdatePreflightBlockedError,
  previewDraftEmailUpdateFromEditableHtml,
  type UpdateContentType,
} from '../../../services/email-update.js';
import { apiVersionFlag, CmsCommand, targetOrgFlag } from '../../../command-base.js';

/** Updates one exact unpublished Draft Email rawHtml field from an editable companion. */
export default class UpdateContent extends CmsCommand<CmsEnvelope<ContentUpdateResult>> {
  public static readonly summary =
    'Preview or apply one bounded Draft Email or Email Template rawHtml update.';
  public static readonly description =
    'Selects exactly one unpublished Draft Email-family variant by workspace ID, API name, and explicit language or workspace default language. Email remains contract v1 by default; Email Template requires explicit --content-type sfdc_cms__emailTemplate and contract v2. The unchanged workspace export and editable companion are both required. Dry-run is the default. --apply requires a new --report-dir and performs one non-retried PUT after durable pending intent is written. No upsert, publish, unpublish, or other content family is supported.';
  public static readonly examples = [
    '<%= config.bin %> cms update content --target-org my-org --workspace-id 0Zu... --api-name WelcomeEmail --language en_US --source-dir ./cms-baseline --editable-dir ./cms-editable --json',
    '<%= config.bin %> cms update content --target-org my-org --workspace-id 0Zu... --api-name WelcomeEmail --default-language --source-dir ./cms-baseline --editable-dir ./cms-editable --apply --report-dir ./cms-update-report --json',
  ];
  public static readonly flags = {
    'target-org': targetOrgFlag,
    'api-version': apiVersionFlag,
    'contract-version': Flags.integer({
      default: 1,
      min: 1,
      summary: 'Machine contract major version (Email: 1; Email Template: 2).',
    }),
    'content-type': Flags.string({
      options: [EMAIL_UPDATE_CONTENT_TYPE, EMAIL_TEMPLATE_UPDATE_CONTENT_TYPE],
      summary: 'Explicit Email-family content type; required for Email Template.',
    }),
    'workspace-id': Flags.string({ required: true, summary: 'Exact CMS workspace ID.' }),
    'api-name': Flags.string({ required: true, summary: 'Exact Email API name.' }),
    language: Flags.string({ exclusive: ['default-language'], summary: 'Exact Email language.' }),
    'default-language': Flags.boolean({
      default: false,
      exclusive: ['language'],
      summary: 'Select the exact workspace default-language Email variant.',
    }),
    'source-dir': Flags.directory({
      exists: true,
      required: true,
      summary: 'Unchanged workspace export baseline.',
    }),
    'editable-dir': Flags.directory({
      exists: true,
      required: true,
      summary: 'Verified editable raw-HTML companion directory.',
    }),
    apply: Flags.boolean({ default: false, summary: 'Apply the one-shot Email variant PUT.' }),
    'report-dir': Flags.directory({
      dependsOn: ['apply'],
      exists: false,
      summary: 'New directory for the durable content update report.',
    }),
  };

  public async run(): Promise<CmsEnvelope<ContentUpdateResult>> {
    const { flags } = await this.parse(UpdateContent);
    const selectedContentType = (flags['content-type'] ??
      EMAIL_UPDATE_CONTENT_TYPE) as UpdateContentType;
    const expectedContractVersion =
      selectedContentType === EMAIL_TEMPLATE_UPDATE_CONTENT_TYPE ? 2 : 1;
    if (
      (flags['contract-version'] ?? 1) !== expectedContractVersion ||
      (selectedContentType === EMAIL_TEMPLATE_UPDATE_CONTENT_TYPE &&
        flags['content-type'] === undefined)
    ) {
      return this.finish(
        blocked(
          this.pluginVersion,
          flags['api-version'],
          'unresolved-org',
          {
            code: 'UNSUPPORTED_CONTRACT_VERSION',
            message:
              selectedContentType === EMAIL_TEMPLATE_UPDATE_CONTENT_TYPE
                ? 'Email Template update requires explicit content type and contract major 2.'
                : 'Email update requires contract major 1.',
            retryable: false,
          },
          selectedContentType,
          expectedContractVersion,
        ),
      );
    }
    if ((flags.language === undefined) === !flags['default-language']) {
      return this.finish(
        blocked(
          this.pluginVersion,
          flags['api-version'],
          'unresolved-org',
          {
            code: 'LANGUAGE_SELECTOR_REQUIRED',
            message: 'Specify exactly one of --language or --default-language.',
            retryable: false,
          },
          selectedContentType,
          expectedContractVersion,
        ),
      );
    }
    if (flags.apply && flags['report-dir'] === undefined) {
      return this.finish(
        blocked(
          this.pluginVersion,
          flags['api-version'],
          'unresolved-org',
          {
            code: 'REPORT_DIRECTORY_REQUIRED',
            message: '--report-dir is required when --apply is set.',
            retryable: false,
          },
          selectedContentType,
          expectedContractVersion,
        ),
      );
    }

    const { connection, orgId } = await this.getOrgContext(
      flags['target-org'],
      flags['api-version'],
    );
    const input = {
      contentType: selectedContentType,
      sourceDirectory: flags['source-dir'],
      editableDirectory: flags['editable-dir'],
      selector: {
        workspaceId: flags['workspace-id'],
        apiName: flags['api-name'],
        ...(flags.language === undefined
          ? { useDefaultLanguage: true as const }
          : { language: flags.language }),
      },
    };
    if (!flags.apply) {
      const preview = await previewDraftEmailUpdateFromEditableHtml(connection, input);
      const result: ContentUpdateResult =
        preview.status === 'ready'
          ? {
              mode: 'dry-run',
              outcome: 'ready',
              target: target(preview.evidence),
              evidence: evidence(preview.evidence),
              blockers: [],
              ...(selectedContentType === EMAIL_TEMPLATE_UPDATE_CONTENT_TYPE
                ? { contentType: EMAIL_TEMPLATE_UPDATE_CONTENT_TYPE }
                : {}),
            }
          : {
              mode: 'dry-run',
              outcome: 'blocked',
              target: {
                workspaceId: flags['workspace-id'],
                apiName: flags['api-name'],
                language: flags.language ?? 'workspace-default',
              },
              evidence: { changedFields: [] },
              blockers: [
                {
                  message: preview.blockers[0].message,
                  code:
                    selectedContentType === EMAIL_TEMPLATE_UPDATE_CONTENT_TYPE
                      ? 'EMAIL_TEMPLATE_UPDATE_PREFLIGHT_BLOCKED'
                      : 'EMAIL_UPDATE_PREFLIGHT_BLOCKED',
                },
              ],
              ...(selectedContentType === EMAIL_TEMPLATE_UPDATE_CONTENT_TYPE
                ? { contentType: EMAIL_TEMPLATE_UPDATE_CONTENT_TYPE }
                : {}),
            };
      const envelopeResult = envelope(
        preview.status === 'ready' ? 'success' : 'blocked',
        this.pluginVersion,
        flags['api-version'],
        orgId,
        result,
        preview.status === 'ready' ? [] : result.blockers,
        expectedContractVersion,
      );
      if (!this.jsonEnabled()) this.showResult(envelopeResult);
      return this.finish(envelopeResult);
    }

    try {
      const applied = await applyDraftEmailUpdateWithReport(
        connection,
        input,
        flags['report-dir']!,
      );
      const result: ContentUpdateResult = {
        mode: 'apply',
        outcome: 'completed',
        target: target(applied.evidence),
        evidence: evidence(applied.evidence),
        blockers: [],
        reportFile: applied.reportFile,
        ...(selectedContentType === EMAIL_TEMPLATE_UPDATE_CONTENT_TYPE
          ? { contentType: EMAIL_TEMPLATE_UPDATE_CONTENT_TYPE }
          : {}),
      };
      const envelopeResult = envelope(
        'success',
        this.pluginVersion,
        flags['api-version'],
        orgId,
        result,
        [],
        expectedContractVersion,
      );
      if (!this.jsonEnabled()) this.showResult(envelopeResult);
      return this.finish(envelopeResult);
    } catch (error) {
      if (error instanceof EmailUpdatePreflightBlockedError) {
        const result: ContentUpdateResult = {
          mode: 'apply',
          outcome: 'blocked',
          target: {
            workspaceId: flags['workspace-id'],
            apiName: flags['api-name'],
            language: flags.language ?? 'workspace-default',
          },
          evidence: { changedFields: [] },
          blockers: [
            {
              code:
                selectedContentType === EMAIL_TEMPLATE_UPDATE_CONTENT_TYPE
                  ? 'EMAIL_TEMPLATE_UPDATE_PREFLIGHT_BLOCKED'
                  : 'EMAIL_UPDATE_PREFLIGHT_BLOCKED',
              message: error.message,
            },
          ],
          ...(selectedContentType === EMAIL_TEMPLATE_UPDATE_CONTENT_TYPE
            ? { contentType: EMAIL_TEMPLATE_UPDATE_CONTENT_TYPE }
            : {}),
        };
        const envelopeResult = envelope(
          'blocked',
          this.pluginVersion,
          flags['api-version'],
          orgId,
          result,
          result.blockers,
          expectedContractVersion,
        );
        if (!this.jsonEnabled()) this.showResult(envelopeResult);
        return this.finish(envelopeResult);
      }
      if (!(error instanceof EmailUpdateOutcomeUnknownError)) throw error;
      const reportFile = path.join(flags['report-dir']!, 'content-update-run.json');
      const result: ContentUpdateResult = {
        mode: 'apply',
        outcome: 'ownership-uncertain',
        target: {
          workspaceId: flags['workspace-id'],
          apiName: flags['api-name'],
          language: flags.language ?? 'workspace-default',
          contentId: error.contentId,
          variantId: error.variantId,
        },
        evidence: { changedFields: ['contentBody.rawHtml'], payloadHash: error.payloadHash },
        blockers: [
          {
            code:
              selectedContentType === EMAIL_TEMPLATE_UPDATE_CONTENT_TYPE
                ? 'EMAIL_TEMPLATE_UPDATE_OWNERSHIP_UNCERTAIN'
                : 'EMAIL_UPDATE_OWNERSHIP_UNCERTAIN',
            message: error.message,
          },
        ],
        reportFile,
        reconciliation: {
          contentId: error.contentId,
          payloadHash: error.payloadHash,
          variantId: error.variantId,
          workspaceId: flags['workspace-id'],
        },
        ...(selectedContentType === EMAIL_TEMPLATE_UPDATE_CONTENT_TYPE
          ? { contentType: EMAIL_TEMPLATE_UPDATE_CONTENT_TYPE }
          : {}),
      };
      const envelopeResult = envelope(
        'failed',
        this.pluginVersion,
        flags['api-version'],
        orgId,
        result,
        result.blockers,
        expectedContractVersion,
      );
      if (!this.jsonEnabled()) this.showResult(envelopeResult);
      return this.finish(envelopeResult);
    }
  }

  private finish(result: CmsEnvelope<ContentUpdateResult>): CmsEnvelope<ContentUpdateResult> {
    return this.finishEnvelope(result, assertContentUpdateResult);
  }

  private showResult(result: CmsEnvelope<ContentUpdateResult>): void {
    this.log(`Status: ${result.status}`);
    this.log(`Mode: ${result.result?.mode ?? 'unknown'}`);
    this.log(`Outcome: ${result.result?.outcome ?? 'unknown'}`);
    if (result.result && 'variantId' in result.result.target) {
      this.log(`Variant: ${result.result.target.variantId}`);
    }
    if (result.result && 'reportFile' in result.result) {
      this.log(`Run report: ${result.result.reportFile}`);
    }
    for (const blocker of result.result?.blockers ?? [])
      this.log(`Blocker ${blocker.code}: ${blocker.message}`);
  }
}

function target(value: {
  apiName: string;
  contentId: string;
  language: string;
  variantId: string;
  workspaceId: string;
}): ContentUpdateTarget {
  return {
    apiName: value.apiName,
    contentId: value.contentId,
    language: value.language,
    variantId: value.variantId,
    workspaceId: value.workspaceId,
  };
}

function evidence(
  value: PreparedContentUpdateEvidence & { postUpdateHash: string },
): PreparedContentUpdateEvidence & { postUpdateHash: string };
function evidence(value: PreparedContentUpdateEvidence): PreparedContentUpdateEvidence;
function evidence(
  value: PreparedContentUpdateEvidence & { postUpdateHash?: string },
): PreparedContentUpdateEvidence & { postUpdateHash?: string } {
  return {
    baselineHash: value.baselineHash,
    changedFields: value.changedFields,
    payloadHash: value.payloadHash,
    ...(value.postUpdateHash === undefined ? {} : { postUpdateHash: value.postUpdateHash }),
    siblingInventory: value.siblingInventory,
  };
}

function blocked(
  pluginVersion: string,
  apiVersion: string,
  orgId: string,
  diagnostic: CmsDiagnostic,
  contentType: UpdateContentType = EMAIL_UPDATE_CONTENT_TYPE,
  contractVersion: 1 | 2 = 1,
): CmsEnvelope<ContentUpdateResult> {
  return envelope(
    'blocked',
    pluginVersion,
    apiVersion,
    orgId,
    null,
    [diagnostic],
    contentType === EMAIL_TEMPLATE_UPDATE_CONTENT_TYPE ? contractVersion : 1,
  );
}

function envelope(
  status: CmsStatus,
  pluginVersion: string,
  apiVersion: string,
  orgId: string,
  result: ContentUpdateResult | null,
  errors: readonly CmsDiagnostic[],
  contractVersion: 1 | 2 = 1,
): CmsEnvelope<ContentUpdateResult> {
  return {
    contract: CONTENT_UPDATE_CONTRACT,
    contractVersion: contractVersion === 2 ? '2.0.0' : '1.0.0',
    status,
    metadata: {
      operation: 'content.update',
      plugin: { name: 'sf-plugin-cms', version: pluginVersion },
      apiVersion,
    },
    diagnostics: { warnings: [], errors: sanitizeDiagnostics(errors, 'diagnostics.errors') },
    provenance: {
      producer: 'sf-plugin-cms',
      sourceOrgId: orgId,
      pluginVersion,
      command: 'sf cms update content',
      generatedAt: new Date().toISOString(),
    },
    result,
  };
}
