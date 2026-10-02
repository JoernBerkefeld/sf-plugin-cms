import { Flags } from '@salesforce/sf-plugins-core';
import {
  assertContentDeleteResult,
  CONTENT_DELETE_CONTRACT,
  type ContentDeleteResult,
  type ContentDeleteTarget,
} from '../../../contracts/content-delete.js';
import {
  sanitizeDiagnostics,
  type CmsDiagnostic,
  type CmsEnvelope,
  type CmsStatus,
} from '../../../contracts/shared.js';
import {
  applyDraftEmailDeleteWithReport,
  deleteFamilyPolicy,
  EMAIL_CONTENT_TYPE,
  EMAIL_TEMPLATE_CONTENT_TYPE,
  EmailDeleteOutcomeUnknownError,
  EmailDeletePreflightBlockedError,
  previewDraftEmailDelete,
  type DeleteContentType,
} from '../../../services/email-delete.js';
import { apiVersionFlag, CmsCommand, targetOrgFlag } from '../../../command-base.js';

/** Permanently deletes one exact run-owned Draft Email variant. */
export default class DeleteContent extends CmsCommand<CmsEnvelope<ContentDeleteResult>> {
  public static readonly summary =
    'Preview or permanently delete one bounded run-owned Draft Email or Email Template.';
  public static readonly description =
    'Selects exactly one Draft/unpublished sealed content family by workspace ID, API name, and explicit language or workspace default language. sfdc_cms__email remains the default and requires contract v1; sfdc_cms__emailTemplate requires contract v2 and a strict completed CREATE journal with unchanged source artifacts. Dry-run is the default. --apply additionally requires a new --report-dir and --acknowledge-permanent-delete before org access. The command deletes one variant only, never cascades, never deletes published content, and never retries ambiguity.';
  public static readonly examples = [
    '<%= config.bin %> cms delete content --target-org my-org --workspace-id 0Zu... --api-name WelcomeEmail --language en_US --ownership-report ./create-report/workspace-import-run.json --json',
    '<%= config.bin %> cms delete content --target-org my-org --workspace-id 0Zu... --api-name WelcomeEmail --default-language --ownership-report ./delete-ownership.json --apply --acknowledge-permanent-delete --report-dir ./cms-delete-report --json',
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
      default: EMAIL_CONTENT_TYPE,
      options: [EMAIL_CONTENT_TYPE, EMAIL_TEMPLATE_CONTENT_TYPE],
      summary: 'Sealed CMS delete family.',
    }),
    'workspace-id': Flags.string({ required: true, summary: 'Exact CMS workspace ID.' }),
    'api-name': Flags.string({ required: true, summary: 'Exact Email API name.' }),
    language: Flags.string({ exclusive: ['default-language'], summary: 'Exact Email language.' }),
    'default-language': Flags.boolean({
      default: false,
      exclusive: ['language'],
      summary: 'Select the exact workspace default-language Email variant.',
    }),
    'ownership-report': Flags.file({
      required: true,
      exists: true,
      summary:
        'Strict completed CREATE journal or plugin ownership report authorizing this exact variant.',
    }),
    apply: Flags.boolean({
      default: false,
      summary: 'Apply the one-shot permanent Email variant deletion.',
    }),
    'acknowledge-permanent-delete': Flags.boolean({
      default: false,
      dependsOn: ['apply'],
      summary: 'Acknowledge that the selected Email variant will be permanently deleted.',
    }),
    'report-dir': Flags.directory({
      dependsOn: ['apply'],
      exists: false,
      summary: 'New directory for the durable content delete report.',
    }),
  };

  public async run(): Promise<CmsEnvelope<ContentDeleteResult>> {
    const { flags } = await this.parse(DeleteContent);
    const selectedContentType = flags['content-type'] as DeleteContentType;
    const expectedContractVersion = selectedContentType === EMAIL_TEMPLATE_CONTENT_TYPE ? 2 : 1;
    if ((flags['contract-version'] ?? 1) !== expectedContractVersion)
      return this.finish(
        blocked(
          this.pluginVersion,
          flags['api-version'],
          'unresolved-org',
          flags,
          {
            code: 'UNSUPPORTED_CONTRACT_VERSION',
            message:
              selectedContentType === EMAIL_TEMPLATE_CONTENT_TYPE
                ? 'Email Template delete requires contract major 2.'
                : 'Email delete requires contract major 1.',
            retryable: false,
          },
          selectedContentType,
          expectedContractVersion,
        ),
      );
    if ((flags.language === undefined) === !flags['default-language'])
      return this.finish(
        blocked(
          this.pluginVersion,
          flags['api-version'],
          'unresolved-org',
          flags,
          {
            code: 'LANGUAGE_SELECTOR_REQUIRED',
            message: 'Specify exactly one of --language or --default-language.',
            retryable: false,
          },
          selectedContentType,
          expectedContractVersion,
        ),
      );
    if (flags.apply && flags['report-dir'] === undefined)
      return this.finish(
        blocked(
          this.pluginVersion,
          flags['api-version'],
          'unresolved-org',
          flags,
          {
            code: 'REPORT_DIRECTORY_REQUIRED',
            message: '--report-dir is required when --apply is set.',
            retryable: false,
          },
          selectedContentType,
          expectedContractVersion,
        ),
      );
    if (flags.apply && !flags['acknowledge-permanent-delete'])
      return this.finish(
        blocked(
          this.pluginVersion,
          flags['api-version'],
          'unresolved-org',
          flags,
          {
            code: 'PERMANENT_DELETE_ACKNOWLEDGEMENT_REQUIRED',
            message: '--acknowledge-permanent-delete is required when --apply is set.',
            retryable: false,
          },
          selectedContentType,
          expectedContractVersion,
        ),
      );
    const { connection, orgId } = await this.getOrgContext(
      flags['target-org'],
      flags['api-version'],
    );
    const input = {
      contentType: selectedContentType,
      orgId,
      ownershipReport: flags['ownership-report'],
      selector: {
        workspaceId: flags['workspace-id'],
        apiName: flags['api-name'],
        ...(flags.language === undefined
          ? { useDefaultLanguage: true as const }
          : { language: flags.language }),
      },
    };
    if (!flags.apply) {
      const preview = await previewDraftEmailDelete(connection, input);
      const result: ContentDeleteResult =
        preview.status === 'ready'
          ? {
              mode: 'dry-run',
              outcome: 'ready',
              target: target(preview.evidence),
              evidence: {
                acknowledgementRequired: true,
                baselineHash: preview.evidence.ownership.baselineHash,
                currentHash: preview.evidence.hash,
                ownershipReport: preview.evidence.ownership.reportFile,
                ownershipRequestSha256: preview.evidence.ownership.requestSha256,
                inventoryVariantCount: preview.evidence.inventory.length,
                siblingVariantCount: preview.evidence.siblingVariantCount,
                ...(selectedContentType === EMAIL_TEMPLATE_CONTENT_TYPE
                  ? { contentType: EMAIL_TEMPLATE_CONTENT_TYPE }
                  : {}),
              },
              blockers: [],
            }
          : {
              mode: 'dry-run',
              outcome: 'blocked',
              target: unresolvedTarget(flags),
              evidence: { ownershipReport: flags['ownership-report'] },
              blockers: preview.blockers,
            };
      const output = envelope(
        preview.status === 'ready' ? 'success' : 'blocked',
        this.pluginVersion,
        flags['api-version'],
        orgId,
        result,
        preview.status === 'ready' ? [] : preview.blockers,
        expectedContractVersion,
      );
      if (!this.jsonEnabled()) this.showResult(output);
      return this.finish(output);
    }
    try {
      const applied = await applyDraftEmailDeleteWithReport(
        connection,
        input,
        flags['report-dir']!,
      );
      const result: ContentDeleteResult = {
        mode: 'apply',
        outcome: 'completed',
        target: target(applied.evidence),
        evidence: {
          acknowledgedPermanentDelete: true,
          baselineHash: applied.evidence.ownership.baselineHash,
          ownershipReport: applied.evidence.ownership.reportFile,
          ownershipRequestSha256: applied.evidence.ownership.requestSha256,
          selectedInventoryMatches: applied.evidence.selectedInventoryMatches,
          exactVariantAbsent: applied.evidence.exactVariantAbsent,
          parentBehavior: applied.evidence.parentBehavior,
          ...(applied.evidence.parentIdentityPreserved === undefined
            ? {}
            : { parentIdentityPreserved: true as const }),
          ...(selectedContentType === EMAIL_TEMPLATE_CONTENT_TYPE
            ? {
                contentType: EMAIL_TEMPLATE_CONTENT_TYPE,
                remainingFamilyVariantCount: applied.evidence.postInventory.length,
              }
            : { remainingEmailVariantCount: applied.evidence.postInventory.length }),
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
        expectedContractVersion,
      );
      if (!this.jsonEnabled()) this.showResult(output);
      return this.finish(output);
    } catch (error) {
      if (error instanceof EmailDeletePreflightBlockedError) {
        const result: ContentDeleteResult = {
          mode: 'apply',
          outcome: 'blocked',
          target: unresolvedTarget(flags),
          evidence: { ownershipReport: flags['ownership-report'] },
          blockers: [
            { code: deleteFamilyPolicy(selectedContentType).blockerCode, message: error.message },
          ],
        };
        const output = envelope(
          'blocked',
          this.pluginVersion,
          flags['api-version'],
          orgId,
          result,
          result.blockers,
          expectedContractVersion,
        );
        if (!this.jsonEnabled()) this.showResult(output);
        return this.finish(output);
      }
      if (!(error instanceof EmailDeleteOutcomeUnknownError)) throw error;
      const rejected = error.mutationError.classification === 'definite-pre-mutation-rejection';
      let mutationBlockerCode:
        | 'EMAIL_DELETE_OWNERSHIP_UNCERTAIN'
        | 'EMAIL_DELETE_REJECTED_BEFORE_MUTATION'
        | 'EMAIL_TEMPLATE_DELETE_OWNERSHIP_UNCERTAIN'
        | 'EMAIL_TEMPLATE_DELETE_REJECTED_BEFORE_MUTATION';
      if (selectedContentType === EMAIL_TEMPLATE_CONTENT_TYPE) {
        mutationBlockerCode = rejected
          ? 'EMAIL_TEMPLATE_DELETE_REJECTED_BEFORE_MUTATION'
          : 'EMAIL_TEMPLATE_DELETE_OWNERSHIP_UNCERTAIN';
      } else {
        mutationBlockerCode = rejected
          ? 'EMAIL_DELETE_REJECTED_BEFORE_MUTATION'
          : 'EMAIL_DELETE_OWNERSHIP_UNCERTAIN';
      }
      const result: ContentDeleteResult = {
        mode: 'apply',
        outcome: rejected ? 'rejected-before-mutation' : 'ownership-uncertain',
        target: {
          workspaceId: error.workspaceId,
          apiName: error.apiName,
          language: error.language,
          contentId: error.contentId,
          variantId: error.variantId,
        },
        evidence: { mutationError: error.mutationError },
        blockers: [
          {
            code: mutationBlockerCode,
            message: rejected
              ? `${selectedContentType === EMAIL_TEMPLATE_CONTENT_TYPE ? 'Email Template' : 'Email'} delete was rejected before mutation; no retry was attempted`
              : error.message,
          },
        ],
        reportFile: error.reportFile,
        reconciliation: {
          workspaceId: error.workspaceId,
          contentId: error.contentId,
          variantId: error.variantId,
        },
      };
      const output = envelope(
        'failed',
        this.pluginVersion,
        flags['api-version'],
        orgId,
        result,
        result.blockers,
        expectedContractVersion,
      );
      if (!this.jsonEnabled()) this.showResult(output);
      return this.finish(output);
    }
  }

  private finish(result: CmsEnvelope<ContentDeleteResult>): CmsEnvelope<ContentDeleteResult> {
    return this.finishEnvelope(result, assertContentDeleteResult);
  }

  private showResult(result: CmsEnvelope<ContentDeleteResult>): void {
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
}): ContentDeleteTarget {
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
  flags: {
    'workspace-id': string;
    'api-name': string;
    language?: string;
    'ownership-report': string;
  },
  diagnostic: CmsDiagnostic,
  contentType: DeleteContentType = EMAIL_CONTENT_TYPE,
  contractVersion: 1 | 2 = 1,
): CmsEnvelope<ContentDeleteResult> {
  const result: ContentDeleteResult = {
    mode: 'dry-run',
    outcome: 'blocked',
    target: unresolvedTarget(flags),
    evidence: { ownershipReport: flags['ownership-report'] },
    blockers: [{ code: deleteFamilyPolicy(contentType).blockerCode, message: diagnostic.message }],
  };
  return envelope(
    'blocked',
    pluginVersion,
    apiVersion,
    orgId,
    result,
    [diagnostic],
    contractVersion,
  );
}
function envelope(
  status: CmsStatus,
  pluginVersion: string,
  apiVersion: string,
  orgId: string,
  result: ContentDeleteResult | null,
  errors: readonly CmsDiagnostic[],
  contractVersion: 1 | 2 = 1,
): CmsEnvelope<ContentDeleteResult> {
  return {
    contract: CONTENT_DELETE_CONTRACT,
    contractVersion: contractVersion === 2 ? '2.0.0' : '1.0.0',
    status,
    metadata: {
      operation: 'content.delete',
      plugin: { name: 'sf-plugin-cms', version: pluginVersion },
      apiVersion,
    },
    diagnostics: { warnings: [], errors: sanitizeDiagnostics(errors, 'diagnostics.errors') },
    provenance: {
      producer: 'sf-plugin-cms',
      sourceOrgId: orgId,
      pluginVersion,
      command: 'sf cms delete content',
      generatedAt: new Date().toISOString(),
    },
    result,
  };
}
