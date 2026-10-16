import { Flags } from '@salesforce/sf-plugins-core';
import { lstat, mkdir } from 'node:fs/promises';
import path from 'node:path';
import {
  executeDeployBatch,
  type DeployBatchReport,
} from '../../../services/deploy-batch-executor.js';
import { preflightDeployBatch } from '../../../services/deploy-batch-preflight.js';
import { assertEditableDirectoryPath } from '../../../services/editable-raw-html-export.js';
import { getCmsApiSelection } from '../../../api-policy.js';
import { apiVersionFlag, CmsCommand, targetOrgFlag } from '../../../command-base.js';
import { type CmsEnvelope, type CmsStatus } from '../../../contracts/shared.js';
import { sourcePathSegment } from '../../../contracts/source-definition.js';
import {
  type DeployDestinationPreparation,
  type DeployPreparedItem,
} from '../../../services/deploy-destination-preparation.js';
import {
  selectDeploySources,
  type DeployLocalSelection,
} from '../../../services/deploy-source-selection.js';
import { assertWorkspaceSelector, resolveWorkspace } from '../../../services/resolve-workspace.js';
import { redactSecrets } from '../../../transport/redact-secrets.js';

export type DeployContentResult = {
  mode: 'dry-run' | 'apply';
  mutationEnabled: boolean;
  qualification: 'unqualified';
  reportFile: string | null;
  report: DeployBatchReport | null;
  scope: {
    targetOrg: string;
    workspaceId: string | null;
    workspaceName: string | null;
    language: string | null;
    defaultLanguage: boolean;
  };
  selection: DeployLocalSelection | null;
  preparation: DeployDestinationPreparation | null;
  items: Array<
    | (DeployPreparedItem & { outcome: 'planned' | 'blocked'; readback: null })
    | DeployBatchReport['items'][number]
  >;
  blockedReasons: string[];
  summary: {
    selected: number;
    plannedCreate: number;
    plannedUpdate: number;
    plannedUnchanged: number;
    blocked: number;
    completed: number;
    created: number;
    updated: number;
    unchanged: number;
    failed: number;
    uncertain: number;
    unattempted: number;
  };
  unattempted: DeployLocalSelection['items'];
};

export default class DeployContent extends CmsCommand<CmsEnvelope<DeployContentResult>> {
  public static readonly summary =
    'Plan or apply unqualified portable Email and Email Template deployment.';
  public static readonly description =
    'Default dry-run reads explicit local sources and destination without writes. --apply requires a new --report-dir, preflights the whole selection and journals sequential CREATE/UPDATE/unchanged execution, stopping on first failure. No retry, rollback, resume or publication. This capability remains unqualified pending installed same-org and cross-org live acceptance; successful execution does not qualify the capability.';
  public static readonly examples = [
    '<%= config.bin %> cms deploy content -o destination -w 0ZuDESTINATION -l en_US --definition-file ./Welcome.cms-email.json --json',
    '<%= config.bin %> cms deploy content -o destination -W Marketing -L -d ./cms -m sfdc_cms__email:Welcome --json',
  ];
  public static readonly flags = {
    'target-org': targetOrgFlag,
    'api-version': apiVersionFlag,
    'workspace-id': Flags.string({
      char: 'w',
      summary: 'Exact destination workspace ID; choose ID or name.',
    }),
    'workspace-name': Flags.string({
      char: 'W',
      summary: 'Exact case-insensitive destination workspace name; choose ID or name.',
    }),
    language: Flags.string({
      char: 'l',
      summary: 'Explicit destination language; choose this or --default-language.',
    }),
    'default-language': Flags.boolean({
      char: 'L',
      default: false,
      summary: 'Explicitly select the destination workspace default language.',
    }),
    'definition-file': Flags.string({
      char: 'f',
      multiple: true,
      multipleNonGreedy: true,
      summary: 'Local item definition JSON; repeat. Exclusive of source-dir and filters.',
    }),
    'source-dir': Flags.string({
      char: 'd',
      multiple: true,
      multipleNonGreedy: true,
      summary: 'Explicit local source directory; repeat. Never defaults to the current directory.',
    }),
    'content-type': Flags.string({
      char: 't',
      multiple: true,
      multipleNonGreedy: true,
      summary: 'Qualified Email/Email Template directory filter; repeat. Exclusive of metadata.',
    }),
    metadata: Flags.string({
      char: 'm',
      multiple: true,
      multipleNonGreedy: true,
      summary: 'Local directory filter Type or Type:ApiName; repeat. Exact members must exist.',
    }),
    apply: Flags.boolean({
      char: 'a',
      default: false,
      summary: 'Execute unqualified deployment with whole-selection preflight and journals.',
    }),
    'report-dir': Flags.string({
      char: 'r',
      summary: 'New exclusive report directory; required for apply and forbidden for dry-run.',
    }),
  };

  protected executeBatch = executeDeployBatch;
  protected selectSources = selectDeploySources;
  protected preflightBatch = preflightDeployBatch;
  protected resolveDestinationWorkspace = resolveWorkspace;

  public async run(): Promise<CmsEnvelope<DeployContentResult>> {
    const { flags } = await this.parse(DeployContent);
    let orgId = 'unresolved-org';
    const result: DeployContentResult = {
      mode: flags.apply ? 'apply' : 'dry-run',
      mutationEnabled: false,
      qualification: 'unqualified',
      reportFile: null,
      report: null,
      scope: {
        targetOrg: flags['target-org'],
        workspaceId: flags['workspace-id'] ?? null,
        workspaceName: flags['workspace-name'] ?? null,
        language: flags.language ?? null,
        defaultLanguage: flags['default-language'],
      },
      selection: null,
      preparation: null,
      items: [],
      blockedReasons: [],
      summary: {
        selected: 0,
        plannedCreate: 0,
        plannedUpdate: 0,
        plannedUnchanged: 0,
        blocked: 0,
        completed: 0,
        created: 0,
        updated: 0,
        unchanged: 0,
        failed: 0,
        uncertain: 0,
        unattempted: 0,
      },
      unattempted: [],
    };
    const finish = (status: CmsStatus, code?: string): CmsEnvelope<DeployContentResult> => {
      result.summary.unattempted = result.unattempted.length;
      const envelope: CmsEnvelope<DeployContentResult> = {
        contract: 'sf-cms-content-deploy',
        contractVersion: '1.0.0',
        status,
        metadata: {
          operation: 'content.deploy',
          plugin: { name: 'sf-plugin-cms', version: this.pluginVersion },
          apiVersion: flags['api-version'],
        },
        provenance: {
          producer: 'sf-plugin-cms',
          sourceOrgId: orgId,
          pluginVersion: this.pluginVersion,
          command: 'sf cms deploy content',
          generatedAt: new Date().toISOString(),
        },
        diagnostics: {
          warnings: [
            {
              code: 'DEPLOY_UNQUALIFIED',
              message:
                result.mode === 'dry-run'
                  ? 'Dry-run proposals are unqualified observations only. No mutations or readback were performed.'
                  : 'Deployment capability is unqualified pending installed same-org and cross-org live acceptance. Inspect batch and per-item journals for actual outcomes.',
              retryable: false,
            },
          ],
          errors: code
            ? [
                {
                  code,
                  message: result.report
                    ? 'Deployment did not complete. Inspect outcomes, uncertain counts and batch/per-item journals before any new run.'
                    : 'Deployment is blocked before batch execution; no org mutations occurred. Inspect blockedReasons.',
                  retryable: false,
                },
              ]
            : [],
        },
        result,
      };
      if (!this.jsonEnabled()) {
        this.log(
          result.mode === 'dry-run'
            ? `Deploy dry-run: ${status}; planned create ${result.summary.plannedCreate}, update ${result.summary.plannedUpdate}, unchanged ${result.summary.plannedUnchanged}; blocked ${result.summary.blocked}, unattempted ${result.summary.unattempted}. No writes; all proposals unqualified.`
            : `Deploy apply: ${status}; created ${result.summary.created}, updated ${result.summary.updated}, unchanged ${result.summary.unchanged}, failed ${result.summary.failed}, uncertain ${result.summary.uncertain}, unattempted ${result.summary.unattempted}. Capability unqualified.`,
        );
        if (result.reportFile) this.log(`Run report: ${result.reportFile}`);
        for (const reason of result.blockedReasons) this.log(reason);
        for (const item of result.items) {
          this.log(`${item.source.definitionPath}: ${item.proposed} (unqualified)`);
          if ('blockedReasons' in item) for (const reason of item.blockedReasons) this.log(reason);
          if ('reportFile' in item) this.log(`${item.outcome}: ${item.reportFile}`);
        }
      }
      return this.finishEnvelope(envelope, assertDeployContentResult);
    };
    try {
      assertWorkspaceSelector({
        workspaceId: flags['workspace-id'],
        workspaceName: flags['workspace-name'],
      });
      if (
        !flags['target-org'].trim() ||
        flags['workspace-id']?.trim() === '' ||
        flags['workspace-name']?.trim() === '' ||
        (!flags.apply && flags['report-dir'] !== undefined)
      )
        throw new TypeError(
          'Explicit nonempty destination selectors are required; report-dir is apply-only.',
        );
      if ((flags.language !== undefined) === flags['default-language'])
        throw new TypeError('Choose exactly one explicit language or default-language.');
      if (flags.language !== undefined) sourcePathSegment(flags.language);
      if (flags.apply) {
        if (flags['report-dir'] === undefined)
          throw new TypeError('--report-dir is required when --apply is set.');
        await assertEditableDirectoryPath(flags['report-dir']);
        const parent = await lstat(path.dirname(path.resolve(flags['report-dir'])));
        if (!parent.isDirectory())
          throw new TypeError('Report parent must be an existing directory.');
      }
      result.selection = await this.selectSources(flags);
      result.summary.selected = result.selection.items.length;
      result.unattempted = [...result.selection.items];
    } catch (error) {
      result.blockedReasons.push(
        redactSecrets(error instanceof Error ? error.message : 'Invalid local selection.'),
      );
      return finish('blocked', 'DEPLOY_SELECTION_INVALID');
    }
    try {
      const context = await this.getOrgContext(flags['target-org'], flags['api-version']);
      orgId = context.orgId;
      if (flags['api-version'] === 'latest')
        flags['api-version'] = getCmsApiSelection(context.connection).effectiveApiVersion;
      const workspace = await this.resolveDestinationWorkspace(context.connection, {
        workspaceId: flags['workspace-id'],
        workspaceName: flags['workspace-name'],
      });
      result.scope.workspaceId = workspace.id;
      const language = flags.language ?? workspace.workspace.defaultLanguage;
      sourcePathSegment(language as string);
      result.scope.language = language as string;
      if (flags.apply) {
        // Allocate once, without recursive creation or reuse; the executor owns exclusive journals.
        await assertEditableDirectoryPath(flags['report-dir']!);
        const directory = path.resolve(flags['report-dir']!);
        await mkdir(directory);
        result.reportFile = path.join(directory, 'content-deploy-run.json');
        const applied = await this.executeBatch(context.connection, {
          sources: {
            'definition-file': flags['definition-file'],
            'source-dir': flags['source-dir'],
            'content-type': flags['content-type'],
            metadata: flags.metadata,
          },
          expectedSelection: result.selection,
          workspaceId: workspace.id,
          language: language as string,
          destinationOrgId: context.orgId,
          reportFile: result.reportFile,
        });
        const report = structuredClone(applied.report);
        report.blockedReasons = report.blockedReasons.map((reason) => redactSecrets(reason));
        for (const item of report.items)
          if (item.error !== undefined) item.error = redactSecrets(item.error);
        result.mutationEnabled = true;
        result.reportFile = applied.reportFile;
        result.report = report;
        result.selection = report.selection;
        result.items = report.items;
        result.blockedReasons = report.blockedReasons;
        Object.assign(result.summary, report.summary);
        result.unattempted = report.items
          .filter((item) => item.outcome === 'unattempted')
          .map((item) => item.source);
        if (report.state === 'completed') return finish('success');
        return finish(
          report.state === 'blocked' ? 'blocked' : 'partial',
          'DEPLOY_APPLY_INCOMPLETE',
        );
      }
      const preflight = await this.preflightBatch(context.connection, {
        sources: {
          'definition-file': flags['definition-file'],
          'source-dir': flags['source-dir'],
          'content-type': flags['content-type'],
          metadata: flags.metadata,
        },
        expectedSelection: result.selection,
        workspaceId: workspace.id,
        language: language as string,
      });
      const prepared = preflight.preparation;
      // Preserve preparation snapshots/changed fields while adding whole-selection operation proof.
      result.preparation = structuredClone(prepared);
      result.blockedReasons.push(
        ...preflight.blockedReasons.map((reason) => redactSecrets(reason)),
      );
      result.preparation.blockedReasons = [...result.blockedReasons];
      for (const item of result.preparation.items) {
        const operation = preflight.items.find(
          (proof) => proof.definitionFile === item.source.definitionPath,
        );
        item.blockedReasons = [
          ...item.blockedReasons,
          ...(operation?.blockedReasons ?? ['Missing operation preflight']),
        ].map((reason) => redactSecrets(reason));
        const blocked =
          result.blockedReasons.length > 0 ||
          item.blockedReasons.length > 0 ||
          item.proposed === 'blocked';
        result.items.push({ ...item, outcome: blocked ? 'blocked' : 'planned', readback: null });
        if (blocked) result.summary.blocked += 1;
        else
          switch (item.proposed) {
            case 'create': {
              result.summary.plannedCreate += 1;
              break;
            }
            case 'update': {
              result.summary.plannedUpdate += 1;
              break;
            }
            case 'unchanged': {
              result.summary.plannedUnchanged += 1;
              // No default
              break;
            }
          }
      }
      const observed = new Set(prepared.items.map((item) => item.source.definitionPath));
      result.unattempted = result.selection.items.filter(
        (item) => !observed.has(item.definitionPath),
      );
      if (
        !preflight.eligible ||
        result.blockedReasons.length > 0 ||
        result.summary.blocked ||
        result.unattempted.length > 0
      )
        return finish('blocked', 'DEPLOY_PREPARATION_BLOCKED');
      return finish('success');
    } catch (error) {
      result.blockedReasons.push(
        redactSecrets(
          error instanceof Error ? error.message : 'Destination scope or preparation failed.',
        ),
      );
      return finish('blocked', 'DEPLOY_SCOPE_BLOCKED');
    }
  }
}

function assertDeployContentResult(value: unknown): asserts value is DeployContentResult {
  if (
    value === null ||
    typeof value !== 'object' ||
    !('items' in value) ||
    !Array.isArray(value.items) ||
    !('mutationEnabled' in value) ||
    typeof value.mutationEnabled !== 'boolean' ||
    !('qualification' in value) ||
    value.qualification !== 'unqualified'
  )
    throw new TypeError('Invalid deploy result');
}
