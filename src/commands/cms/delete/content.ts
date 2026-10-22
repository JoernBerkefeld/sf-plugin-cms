import { Flags } from '@salesforce/sf-plugins-core';
import { createInterface } from 'node:readline/promises';
import { getCmsApiSelection } from '../../../api-policy.js';
import { apiVersionFlag, CmsCommand, targetOrgFlag } from '../../../command-base.js';
import {
  assertContentDeleteResult,
  CONTENT_DELETE_CONTRACT,
  type ContentDeleteResult,
} from '../../../contracts/content-delete.js';
import {
  sanitizeDiagnostics,
  type CmsEnvelope,
  type CmsStatus,
} from '../../../contracts/shared.js';
import {
  applyNativeDelete,
  NativeDeleteApplyError,
} from '../../../services/delete-native-executor.js';
import {
  normalizeDeleteSelection,
  resolveNativeDeleteSelection,
  type DeleteSelectionFlags,
  type NativeDeleteItem,
} from '../../../services/delete-native-resolution.js';
import {
  allocateMutationReportDirectory,
  validateMutationReportDirectory,
} from '../../../services/mutation-report-directory.js';
import { RETRIEVE_CONTENT_TYPES } from '../../../services/retrieve-selection.js';
import { resolveWorkspace } from '../../../services/resolve-workspace.js';
import { sourcePathSegment } from '../../../contracts/source-definition.js';
import { formatMutationOutcome } from '../../../mutation-outcome.js';

/** Permanently delete explicitly identified remote items and selected actual languages. */
export default class DeleteContent extends CmsCommand<CmsEnvelope<ContentDeleteResult>> {
  public static readonly aliases = ['content:delete'];
  public static readonly summary = 'Delete exact CMS items and selected languages, or preview.';
  public static readonly description =
    'Executes by default for email, emailTemplate, image, document and audio. Repeat -m Type:ApiName; type-only and wildcard item selectors are forbidden, including in preview. Alternatively use an exact --api-name with --content-type, or --content-key-or-id with --content-type. A sole actual language is automatic; multiple languages require an explicit --language subset or "*", or interactive multi-selection with All first. JSON, CI and non-TTY use require explicit language selection when ambiguous. Cancel or empty selection performs no mutations. No ownership report, Draft-only restriction or acknowledgement is required; the API may reject a target. Deletes exact native Content/Translation variants sequentially without retry, unpublish, parent-delete fallback or rollback. After independently confirmed remote deletion, removes only the matching pre-inspected local source and declared companions under cwd or --output-dir. Missing copies are no-ops; preview never deletes local files. Local cleanup failure returns partial/nonzero with completed remote evidence: never replay DELETE to retry local cleanup. Historical revision/reference preservation and other collateral effects are not proven; last-language parent disappearance is observed, not an explicit parent delete. --preview is read-only and rejects reporting flags before org access. Reports are opt-in: --report uses a unique cwd logs/cms/reports run directory; --report-dir implies reporting. No hidden journal or crash-recovery guarantee. Diagnostic invocation logs remain enabled.';
  public static readonly examples = [
    '<%= config.bin %> cms delete content --workspace-id 0Zu... -m email:Welcome --preview --json',
    '<%= config.bin %> content delete --workspace-id 0Zu... -m image:Banner -m audio:Intro --language "*" --report --json',
  ];
  public static readonly flags = {
    'target-org': targetOrgFlag,
    'api-version': apiVersionFlag,
    'workspace-id': Flags.string({ required: true, summary: 'Exact CMS workspace ID.' }),
    metadata: Flags.string({
      char: 'm',
      multiple: true,
      multipleNonGreedy: true,
      summary: 'Exact Type:ApiName; repeat for each item. No type-only or wildcards.',
    }),
    'content-type': Flags.string({
      options: RETRIEVE_CONTENT_TYPES.flatMap((type) => [type.slice('sfdc_cms__'.length), type]),
      summary: 'Family for an exact API name or parent/key selector; no implicit default.',
    }),
    'api-name': Flags.string({
      summary: 'Exact item API name; requires content-type and excludes metadata/parent selectors.',
    }),
    'content-key-or-id': Flags.string({
      multiple: true,
      multipleNonGreedy: true,
      summary: 'Exact parent ID or content key; requires content-type.',
    }),
    language: Flags.string({
      multiple: true,
      multipleNonGreedy: true,
      summary: 'Actual locale; repeat for a subset, or sole "*" for all actual item languages.',
    }),
    preview: Flags.boolean({
      default: false,
      summary: 'Read-only preflight; no mutation or report allocation.',
    }),
    'output-dir': Flags.directory({
      char: 'd',
      exists: false,
      summary:
        'Project root for matching local JSON and companions; defaults to the current directory.',
    }),
    report: Flags.boolean({
      default: false,
      summary: 'Persist optional reports in a unique cwd logs/cms/reports run directory.',
    }),
    'report-dir': Flags.string({
      char: 'r',
      summary: 'Exact fresh report directory; implies report and overrides default location.',
    }),
  };

  public async run(): Promise<CmsEnvelope<ContentDeleteResult>> {
    const { flags } = await this.parse(DeleteContent);
    let orgId = 'unresolved-org';
    let result: ContentDeleteResult = {
      mode: flags.preview ? 'preview' : 'execute',
      outcome: 'blocked',
      workspaceId: flags['workspace-id'],
      targets: [],
      execution: null,
    };
    const finish = (status: CmsStatus, message?: string): CmsEnvelope<ContentDeleteResult> => {
      const envelope: CmsEnvelope<ContentDeleteResult> = {
        contract: CONTENT_DELETE_CONTRACT,
        contractVersion: '1.0.0',
        status,
        metadata: {
          operation: 'content.delete',
          plugin: { name: 'sf-plugin-cms', version: this.pluginVersion },
          apiVersion: flags['api-version'],
        },
        provenance: {
          producer: 'sf-plugin-cms',
          sourceOrgId: orgId,
          pluginVersion: this.pluginVersion,
          command: 'sf cms delete content',
          generatedAt: new Date().toISOString(),
        },
        diagnostics: {
          warnings: [],
          errors: sanitizeDiagnostics(
            message === undefined
              ? []
              : [{ code: 'CONTENT_DELETE_BLOCKED_OR_FAILED', message, retryable: false }],
            'diagnostics.errors',
          ),
        },
        result,
      };
      if (!this.jsonEnabled()) {
        this.log(`Mode: ${result.mode}; outcome: ${result.outcome}`);
        if (result.mode === 'preview')
          for (const [index, target] of result.targets.entries())
            this.log(
              formatMutationOutcome({
                operation: 'delete',
                ordinal: index + 1,
                label: target.apiName ?? undefined,
                language: target.language,
                state: 'ready',
                target,
              }),
            );
        if (result.execution?.reportFile) this.log(`Run report: ${result.execution.reportFile}`);
        if (message)
          this.log(
            'Deletion stopped. Inspect the invocation log for details; reconcile uncertain remote outcomes before any further deletion. Select exact items and, when needed, --language <locale> (repeat for a subset) or --language "*" for all actual languages.',
          );
      }
      return this.finishEnvelope(envelope, assertContentDeleteResult);
    };
    let selection: DeleteSelectionFlags;
    try {
      if (flags.preview && (flags.report || flags['report-dir'] !== undefined))
        throw new TypeError('Preview forbids --report and --report-dir.');
      if (flags['api-name'] === undefined) {
        selection = {
          metadata: flags.metadata,
          'content-type': flags['content-type'] === undefined ? undefined : [flags['content-type']],
          'content-key-or-id': flags['content-key-or-id'],
        };
      } else {
        if (
          flags.metadata !== undefined ||
          flags['content-key-or-id'] !== undefined ||
          flags['content-type'] === undefined
        )
          throw new TypeError(
            '--api-name requires --content-type and excludes metadata/parent selectors.',
          );
        selection = { metadata: [`${flags['content-type']}:${flags['api-name']}`] };
      }
      normalizeDeleteSelection(selection);
      if (
        flags.language !== undefined &&
        (flags.language.length === 0 ||
          flags.language.some(
            (locale) => !locale.trim() || (locale !== '*' && /[*?[\]]/u.test(locale)),
          ) ||
          (flags.language.includes('*') && flags.language.length !== 1))
      )
        throw new TypeError('Language requires an explicit locale subset or sole "*".');
      if (flags['report-dir'] !== undefined)
        await validateMutationReportDirectory(flags['report-dir']);
    } catch (error) {
      return finish('blocked', (error as Error).message);
    }
    try {
      const context = await this.getOrgContext(
        flags['target-org'].getUsername()!,
        flags['api-version'],
      );
      orgId = context.orgId;
      if (flags['api-version'] === 'latest')
        flags['api-version'] = getCmsApiSelection(context.connection).effectiveApiVersion;
      const resolution = await resolveNativeDeleteSelection(context.connection, {
        workspaceId: flags['workspace-id'],
        selection,
        languages: flags.language,
      });
      for (const item of resolution.items) {
        if (!item.requiresLanguageSelection) continue;
        if (this.jsonEnabled() || process.env.CI || !process.stdin.isTTY || !process.stdout.isTTY)
          throw new TypeError(
            'Multiple actual item languages: specify --language <locale> (repeat for a subset) or --language "*" in JSON/CI/noninteractive use.',
          );
        const languages = await this.selectLanguages(item, resolution.items.indexOf(item) + 1);
        if (languages.length === 0) {
          result = { ...result, outcome: 'cancelled' };
          return finish('success');
        }
        item.selected = item.available.filter((target) => languages.includes(target.language));
        if (item.selected.length !== languages.length)
          throw new TypeError('Invalid language choice.');
        item.requiresLanguageSelection = false;
      }
      result = { ...result, targets: resolution.items.flatMap((item) => item.selected) };
      if (flags.preview) {
        result = { ...result, outcome: 'ready' };
        return finish('success');
      }
      const workspace = await resolveWorkspace(context.connection, {
        workspaceId: flags['workspace-id'],
      });
      const workspaceApiName = workspace.workspace.apiName;
      if (typeof workspaceApiName !== 'string' || !workspaceApiName.trim())
        throw new TypeError(
          'Workspace API name unavailable; local source identity cannot be proven.',
        );
      sourcePathSegment(workspaceApiName);
      const directory = await allocateMutationReportDirectory(
        flags.report,
        flags['report-dir'],
        process.cwd(),
      );
      const execution = await applyNativeDelete(context.connection, {
        resolution,
        onOutcome: this.mutationOutcomeObserver(),
        localSource: { projectRoot: flags['output-dir'] ?? process.cwd(), workspaceApiName },
        ...(directory
          ? { reportDirectory: directory, reportDirectoryAllocated: true as const }
          : {}),
      });
      result = { ...result, outcome: 'completed', execution };
      return finish('success');
    } catch (error) {
      if (error instanceof NativeDeleteApplyError) {
        const localFailure = error.result.report.operations.some(
          ({ localSource }) =>
            localSource?.outcome === 'blocked' || localSource?.outcome === 'partial',
        );
        const state = localFailure ? 'partial' : error.result.report.state;
        if (state === 'applying') throw error;
        result = { ...result, outcome: state, execution: error.result };
        let status: CmsStatus = 'failed';
        if (state === 'blocked') status = 'blocked';
        if (state === 'partial') status = 'partial';
        if (state === 'completed') status = 'success';
        return finish(status, error.message);
      }
      return finish('blocked', (error as Error).message);
    }
  }

  protected async selectLanguages(item: NativeDeleteItem, ordinal = 1): Promise<string[]> {
    const prompt = createInterface({ input: process.stdin, output: process.stdout });
    const cancellation = new AbortController();
    prompt.once('SIGINT', () => cancellation.abort());
    prompt.once('close', () => cancellation.abort());
    try {
      this.log(
        `${formatMutationOutcome({ operation: 'delete', ordinal, label: item.available[0]?.apiName ?? undefined, state: 'select languages', target: { contentId: item.contentId } })}\n0: All\n${item.available.map((target, index) => `${index + 1}: ${target.language}`).join('\n')}`,
      );
      const input = await prompt.question('Select comma-separated numbers (empty cancels): ', {
        signal: cancellation.signal,
      });
      const answer = input.trim();
      if (!answer) return [];
      const choices = [...new Set(answer.split(',').map((value) => value.trim()))];
      if (choices.length === 1 && choices[0] === '0')
        return item.available.map((target) => target.language);
      if (
        choices.some((value) => !/^[1-9]\d*$/u.test(value) || Number(value) > item.available.length)
      )
        throw new TypeError('Invalid language selection.');
      return choices.map((value) => item.available[Number(value) - 1].language);
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code === 'ABORT_ERR' ||
        (error as NodeJS.ErrnoException).code === 'ERR_USE_AFTER_CLOSE'
      )
        return [];
      throw error;
    } finally {
      prompt.close();
    }
  }
}
