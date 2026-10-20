import { Flags } from '@salesforce/sf-plugins-core';
import {
  allocateMutationReportDirectory,
  validateMutationReportDirectory,
} from '../../../services/mutation-report-directory.js';
import path from 'node:path';
import {
  executeDeployBatch,
  type DeployBatchReport,
} from '../../../services/deploy-batch-executor.js';
import { preflightDeployBatch } from '../../../services/deploy-batch-preflight.js';
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
  mode: 'preview' | 'execute';
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
  public static readonly aliases = ['content:deploy'];
  public static readonly summary =
    'Deploy portable Email, Email Template, Image, Document and Audio content.';
  public static readonly description =
    'Uses your configured default org unless -o overrides it. Executes by default. --preview reads explicit local sources and destination with no org mutations, content writes or report allocation; existing diagnostic invocation logs remain enabled. Audio supports unqualified CREATE, bytes-only UPDATE and exact unchanged for binary root/default-language sources with safe MIME and paths. Existing Audio must be single-primary unpublished Drafts with unchanged metadata, native filename, MIME, language and type. Bounded two-org development-artifact acceptance covers the tested 844-byte WAV profile for CREATE, bytes-only UPDATE, zero-write unchanged and public retrieval with independent native identity, inventory and exact-byte readbacks; this is not general-format or released-package qualification. Whole-selection preflight precedes sequential CREATE/UPDATE/unchanged execution, stopping on first failure or uncertainty. Reporting is opt-in: --report allocates ./logs/cms/reports/<timestamp>-<unique-id>/ under invocation cwd; --report-dir implies reporting at that exact fresh directory. Without either flag no reports or hidden journals are written, and no crash-surviving structured journal is available. Preview rejects both reporting options. Images require root/default-language binary sources; Salesforce determines format and size acceptance (no client format whitelist or 25 MB cap); existing Images must be single-primary unpublished Drafts with exact metadata, filename and MIME, with bytes-only UPDATE. Documents support CREATE, bytes-only UPDATE and exact unchanged: root/default-language opaque nonempty runtime-representable bytes with safe native MIME and ASCII filename; no client format whitelist, UTF-8 conversion, suffix restriction or 10 MiB cap. Salesforce determines format and size acceptance; explicit caller download budgets still bind. Existing Documents must be single-primary unpublished Drafts with unchanged metadata, native filename, MIME, language and type. Only bytes may change; all other Document differences block the whole selection before mutation. Document UPDATE never falls back to Image transport and remains unqualified; bounded two-org development-artifact acceptance covers the tested text/plain profile. No retry, rollback, resume or publication. This capability remains unqualified. Narrow installed same-org PNG acceptance does not establish cross-org qualification; successful execution does not broaden supported shapes.';
  public static readonly examples = [
    '<%= config.bin %> cms deploy content -o destination -w 0ZuDESTINATION -l en_US --source-dir ./Welcome.cms-email.json --json',
    '<%= config.bin %> cms deploy content -W Marketing -L -m email:Welcome --json',
    '<%= config.bin %> cms deploy content -W Marketing -L -m audio:Intro --json',
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
    'source-dir': Flags.string({
      char: 'd',
      multiple: true,
      multipleNonGreedy: true,
      summary: 'Explicit definition file or source directory; repeat. Exclusive of metadata.',
      exclusive: ['metadata'],
    }),
    'content-type': Flags.string({
      char: 't',
      multiple: true,
      multipleNonGreedy: true,
      summary:
        'Email/Email Template/Image/Document/Audio filter: email, emailTemplate, image, document, audio (or sfdc_cms__ names). Exclusive of metadata.',
    }),
    metadata: Flags.string({
      char: 'm',
      multiple: true,
      multipleNonGreedy: true,
      summary:
        'Select cwd cms/<destinationWorkspaceApiName>/<type> by Type[:ApiName]; repeat. Exact members must exist.',
      exclusive: ['source-dir', 'content-type'],
    }),
    preview: Flags.boolean({
      default: false,
      summary:
        'Read-only preflight; no mutations, content writes or reports (diagnostic logs remain).',
    }),
    report: Flags.boolean({
      default: false,
      summary: 'Persist reports in a unique cwd logs/cms/reports run directory; not with preview.',
    }),
    'report-dir': Flags.string({
      char: 'r',
      summary: 'Exact fresh report directory; implies report and overrides its default location.',
    }),
  };

  protected executeBatch = executeDeployBatch;
  protected selectSources = selectDeploySources;
  protected preflightBatch = preflightDeployBatch;
  protected resolveDestinationWorkspace = resolveWorkspace;

  public async run(): Promise<CmsEnvelope<DeployContentResult>> {
    const { flags } = await this.parse(DeployContent);
    const targetOrg = flags['target-org'].getUsername()!;
    const invocationCwd = process.cwd();
    let orgId = 'unresolved-org';
    const result: DeployContentResult = {
      mode: flags.preview ? 'preview' : 'execute',
      mutationEnabled: false,
      qualification: 'unqualified',
      reportFile: null,
      report: null,
      scope: {
        targetOrg,
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
                result.mode === 'preview'
                  ? 'Preview proposals are unqualified observations only. No mutations or mutation readback were performed; diagnostic invocation logs remain enabled.'
                  : 'Deployment capability remains unqualified; narrow same-org PNG acceptance does not establish cross-org Image qualification. Inspect returned batch and per-item outcomes; durable reports exist only when requested.',
              retryable: false,
            },
          ],
          errors: code
            ? [
                {
                  code,
                  message: result.report
                    ? 'Deployment did not complete. Inspect returned outcomes and uncertain counts before any new run; inspect durable reports only when reporting was enabled.'
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
          result.mode === 'preview'
            ? `Deploy preview: ${status}; planned create ${result.summary.plannedCreate}, update ${result.summary.plannedUpdate}, unchanged ${result.summary.plannedUnchanged}; blocked ${result.summary.blocked}, unattempted ${result.summary.unattempted}. No mutations, content writes or reports; diagnostic logs remain. All proposals unqualified.`
            : `Deploy execution: ${status}; created ${result.summary.created}, updated ${result.summary.updated}, unchanged ${result.summary.unchanged}, failed ${result.summary.failed}, uncertain ${result.summary.uncertain}, unattempted ${result.summary.unattempted}. Capability unqualified.`,
        );
        if (result.reportFile) this.log(`Run report: ${result.reportFile}`);
        for (const reason of result.blockedReasons) this.log(reason);
        for (const item of result.items) {
          this.log(`${item.source.definitionPath}: ${item.proposed} (unqualified)`);
          if ('blockedReasons' in item) for (const reason of item.blockedReasons) this.log(reason);
          if ('outcome' in item)
            this.log(
              `${item.outcome}${'reportFile' in item && item.reportFile ? `: ${item.reportFile}` : ''}`,
            );
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
        !targetOrg.trim() ||
        flags['workspace-id']?.trim() === '' ||
        flags['workspace-name']?.trim() === '' ||
        (flags.preview && (flags.report || flags['report-dir'] !== undefined))
      )
        throw new TypeError(
          'Explicit nonempty destination selectors are required; preview forbids report and report-dir.',
        );
      if ((flags.language !== undefined) === flags['default-language'])
        throw new TypeError('Choose exactly one explicit language or default-language.');
      if (flags.language !== undefined) sourcePathSegment(flags.language);
      if (flags['report-dir'] !== undefined)
        await validateMutationReportDirectory(flags['report-dir']);
      if ((flags.metadata !== undefined) === (flags['source-dir'] !== undefined))
        throw new TypeError('Choose exactly one metadata or source-dir selection.');
      if (flags.metadata !== undefined && flags['content-type'] !== undefined)
        throw new TypeError('Content-type filters require source-dir selection.');
      if (flags.metadata === undefined) {
        result.selection = await this.selectSources(flags);
      } else {
        // Canonical paths require the resolved destination API name, never the display name.
        if (flags.metadata.length === 0 || flags.metadata.some((value) => !value.trim()))
          throw new TypeError('Deploy metadata selectors must be nonempty.');
      }
      if (result.selection) {
        result.summary.selected = result.selection.items.length;
        result.unattempted = [...result.selection.items];
      }
    } catch (error) {
      result.blockedReasons.push(
        redactSecrets(error instanceof Error ? error.message : 'Invalid local selection.'),
      );
      return finish('blocked', 'DEPLOY_SELECTION_INVALID');
    }
    try {
      const context = await this.getOrgContext(targetOrg, flags['api-version']);
      orgId = context.orgId;
      if (flags['api-version'] === 'latest')
        flags['api-version'] = getCmsApiSelection(context.connection).effectiveApiVersion;
      const workspace = await this.resolveDestinationWorkspace(context.connection, {
        workspaceId: flags['workspace-id'],
        workspaceName: flags['workspace-name'],
      });
      result.scope.workspaceId = workspace.id;
      const sources = {
        'source-dir': flags['source-dir'],
        'content-type': flags['content-type'],
        metadata: flags.metadata,
        ...(flags.metadata === undefined
          ? {}
          : { workspaceApiName: workspace.workspace.apiName as string, cwd: invocationCwd }),
      };
      if (result.selection === null) {
        result.selection = await this.selectSources(sources);
        result.summary.selected = result.selection.items.length;
        result.unattempted = [...result.selection.items];
      }
      const language = flags.language ?? workspace.workspace.defaultLanguage;
      sourcePathSegment(language as string);
      result.scope.language = language as string;
      if (!flags.preview) {
        const directory = await allocateMutationReportDirectory(
          flags.report,
          flags['report-dir'],
          invocationCwd,
        );
        result.reportFile = directory ? path.join(directory, 'content-deploy-run.json') : null;
        const applied = await this.executeBatch(context.connection, {
          sources,
          expectedSelection: result.selection,
          workspaceId: workspace.id,
          language: language as string,
          destinationOrgId: context.orgId,
          ...(result.reportFile ? { reportFile: result.reportFile } : {}),
        });
        const report = structuredClone(applied.report);
        report.blockedReasons = report.blockedReasons.map((reason) => redactSecrets(reason));
        for (const item of report.items)
          if (item.error !== undefined) item.error = redactSecrets(item.error);
        result.mutationEnabled = true;
        result.reportFile = applied.reportFile ?? null;
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
        sources,
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
