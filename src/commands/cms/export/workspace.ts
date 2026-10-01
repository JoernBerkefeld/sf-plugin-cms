import { Flags } from '@salesforce/sf-plugins-core';
import { readFile } from 'node:fs/promises';
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
import { preflightEditableExport } from '../../../services/editable-raw-html-export.js';
import { parseLandingPagePairSelectors } from '../../../services/landing-page-pair-export.js';
import {
  assertCanonicalMarketingWorkspace,
  assertWorkspaceSelector,
  resolveWorkspace,
} from '../../../services/resolve-workspace.js';
import { apiVersionFlag, CmsCommand, targetOrgFlag } from '../../../command-base.js';

type WorkspaceExportCommandResult = CmsEnvelope<WorkspaceExportSetResult> | ExportWorkspaceResult;

export default class ExportWorkspace extends CmsCommand<WorkspaceExportCommandResult> {
  public static readonly summary =
    'Experimentally export one or all CMS workspaces using a read-only, best-effort process.';
  public static readonly description =
    'Experimentally exports one Marketing Cloud CMS workspace or preflights and exports all workspaces. Image candidates remain partial JSON-only records by default. Single-workspace --experimental-media explicitly opts into an undocumented read-only binary transport that forwards Salesforce authorization only to a narrowly validated Salesforce media host class. Bulk media export is unsupported. For a single workspace, --editable-dir creates an HTML-only companion beside an explicit unchanged baseline. The paths must be new and disjoint; the baseline is retained if companion creation fails. Eligible HTML is not proven dependency-free or safe and is not resolved, rewritten, sanitized, or scanned through Phase 7. This is not a complete or guaranteed backup and does not mutate org data.';
  public static readonly examples = [
    '<%= config.bin %> cms export workspace --target-org my-org --workspace-name "Main Site"',
    '<%= config.bin %> cms export workspace --target-org my-org --workspace-id 0Zu... --output-dir ./cms-export --json',
    '<%= config.bin %> cms export workspace --target-org my-org --workspace-id 0Zu... --output-dir ./cms-export --email-fragment-map ./email-fragments.json --json',
    '<%= config.bin %> cms export workspace --target-org my-org --workspace-id 0Zu... --output-dir ./cms-export --web-fragment-map ./web-fragments.json --json',
    '<%= config.bin %> cms export workspace --target-org my-org --workspace-id 0Zu... --output-dir ./cms-export --landing-page-template-map ./landing-page-templates.json --json',
    '<%= config.bin %> cms export workspace --target-org my-org --workspace-id 0Zu... --output-dir ./cms-export --landing-page-map ./landing-pages.json --json',
    '<%= config.bin %> cms export workspace --target-org my-org --workspace-id 0Zu... --output-dir ./cms-export --preference-page-map ./preference-pages.json --json',
    '<%= config.bin %> cms export workspace --target-org my-org --workspace-id 0Zu... --output-dir ./cms-export --brand-map ./brands.json --json',
    '<%= config.bin %> cms export workspace --target-org my-org --workspace-id 0Zu... --output-dir ./cms-export --form-map ./forms.json --json',
    '<%= config.bin %> cms export workspace --target-org my-org --workspace-id 0Zu... --output-dir ./cms-export --form-handler-map ./form-handlers.json --json',
    '<%= config.bin %> cms export workspace --target-org my-org --workspace-id 0Zu... --output-dir ./cms-export --consent-banner-map ./consent-banners.json --json',
    '<%= config.bin %> cms export workspace --target-org my-org --workspace-id 0Zu... --output-dir ./cms-export --landing-page-pair-map ./landing-page-pairs.json --json',
    '<%= config.bin %> cms export workspace --target-org my-org --workspace-id 0Zu... --output-dir ./cms-export --experimental-media --json',
    '<%= config.bin %> cms export workspace --target-org my-org --all --workspace-type Marketing --output-dir ./cms --contract-version 1 --json',
    '<%= config.bin %> cms export workspace --target-org source-org --workspace-id 0ZuSOURCE --output-dir ./cms-baseline --editable-dir ./cms-editable --json',
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
      exclusive: [
        'workspace-id',
        'workspace-name',
        'email-fragment-map',
        'web-fragment-map',
        'landing-page-template-map',
        'landing-page-map',
        'preference-page-map',
        'brand-map',
        'form-map',
        'form-handler-map',
        'consent-banner-map',
        'landing-page-pair-map',
      ],
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
    'email-fragment-map': Flags.file({
      exists: true,
      exclusive: [
        'all',
        'web-fragment-map',
        'landing-page-template-map',
        'landing-page-map',
        'preference-page-map',
        'brand-map',
        'form-map',
        'form-handler-map',
        'consent-banner-map',
        'landing-page-pair-map',
      ],
      summary:
        'JSON array of exact sfdc_cms__emailFragment API names to export; every name must resolve exactly once.',
    }),
    'web-fragment-map': Flags.file({
      exists: true,
      exclusive: [
        'all',
        'email-fragment-map',
        'landing-page-template-map',
        'landing-page-map',
        'preference-page-map',
        'brand-map',
        'form-map',
        'form-handler-map',
        'consent-banner-map',
        'landing-page-pair-map',
      ],
      summary:
        'JSON array of exact sfdc_cms__webFragment API names to export; every name must resolve exactly once.',
    }),
    'landing-page-template-map': Flags.file({
      exists: true,
      exclusive: [
        'all',
        'email-fragment-map',
        'web-fragment-map',
        'landing-page-map',
        'preference-page-map',
        'brand-map',
        'form-map',
        'form-handler-map',
        'consent-banner-map',
        'landing-page-pair-map',
      ],
      summary:
        'JSON array of exact sfdc_cms__landingPageTemplate API names to export; every name must resolve exactly once.',
    }),
    'landing-page-map': Flags.file({
      exists: true,
      exclusive: [
        'all',
        'email-fragment-map',
        'web-fragment-map',
        'landing-page-template-map',
        'preference-page-map',
        'brand-map',
        'form-map',
        'form-handler-map',
        'consent-banner-map',
        'landing-page-pair-map',
      ],
      summary:
        'JSON array of exact sfdc_cms__landingPage API names to export; every name must resolve exactly once.',
    }),
    'preference-page-map': Flags.file({
      exists: true,
      exclusive: [
        'all',
        'email-fragment-map',
        'web-fragment-map',
        'landing-page-template-map',
        'landing-page-map',
        'brand-map',
        'form-map',
        'form-handler-map',
        'consent-banner-map',
        'landing-page-pair-map',
      ],
      summary:
        'JSON array of exact sfdc_cms__preferencePage API names to export with raw items and typed read reports; every name must resolve exactly once.',
    }),
    'brand-map': Flags.file({
      exists: true,
      exclusive: [
        'all',
        'email-fragment-map',
        'web-fragment-map',
        'landing-page-template-map',
        'landing-page-map',
        'preference-page-map',
        'form-map',
        'form-handler-map',
        'consent-banner-map',
        'landing-page-pair-map',
      ],
      summary:
        'JSON array of exact sfdc_cms__brand API names to export with unchanged raw items and typed read reports; every name must resolve exactly once.',
    }),
    'form-map': Flags.file({
      exists: true,
      exclusive: [
        'all',
        'email-fragment-map',
        'web-fragment-map',
        'landing-page-template-map',
        'landing-page-map',
        'preference-page-map',
        'brand-map',
        'form-handler-map',
        'consent-banner-map',
        'landing-page-pair-map',
      ],
      summary:
        'JSON array of exact case-sensitive sfdc_cms__form API names to export with unchanged raw items and strict typed read reports.',
    }),
    'form-handler-map': Flags.file({
      exists: true,
      exclusive: [
        'all',
        'email-fragment-map',
        'web-fragment-map',
        'landing-page-template-map',
        'landing-page-map',
        'preference-page-map',
        'brand-map',
        'form-map',
        'consent-banner-map',
        'landing-page-pair-map',
      ],
      summary:
        'JSON array of exact case-sensitive sfdc_cms__formHandler API names to export with unchanged raw items and strict typed read reports.',
    }),
    'consent-banner-map': Flags.file({
      exists: true,
      exclusive: [
        'all',
        'email-fragment-map',
        'web-fragment-map',
        'landing-page-template-map',
        'landing-page-map',
        'preference-page-map',
        'brand-map',
        'form-map',
        'form-handler-map',
        'landing-page-pair-map',
      ],
      summary:
        'JSON array of exact case-sensitive sfdc_cms__consentBanner API names to export with unchanged raw items and strict typed read reports.',
    }),
    'landing-page-pair-map': Flags.file({
      exists: true,
      exclusive: [
        'all',
        'email-fragment-map',
        'web-fragment-map',
        'landing-page-template-map',
        'landing-page-map',
        'preference-page-map',
        'brand-map',
        'form-map',
        'form-handler-map',
        'consent-banner-map',
      ],
      summary:
        'JSON pairs of exact landing-page API name and exact source template title; the template API name is optional corroboration.',
    }),
    'experimental-media': Flags.boolean({
      exclusive: ['all'],
      summary:
        'Single-workspace only: opt into undocumented image binary transport and strict v2 media output.',
    }),
    'editable-dir': Flags.directory({
      exists: false,
      exclusive: ['all'],
      dependsOn: ['output-dir'],
      summary:
        'New companion directory for the native raw-email/template HTML subset; requires explicit --output-dir.',
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
    if (flags['editable-dir'] !== undefined) {
      if (isBulk) throw new Error('--editable-dir is incompatible with --all.');
      if (flags['output-dir'] === undefined)
        throw new Error('--editable-dir requires explicit --output-dir.');
      await preflightEditableExport(flags['output-dir'], flags['editable-dir']);
    }
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

    const { connection, orgId } = await this.getOrgContext(
      flags['target-org'],
      flags['api-version'],
    );
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
    const experimentalMedia =
      flags['experimental-media'] === true ? resolveExperimentalMedia(connection) : undefined;
    const pairSelectionFile = flags['landing-page-pair-map'];
    const selectionFile =
      flags['email-fragment-map'] ??
      flags['web-fragment-map'] ??
      flags['landing-page-template-map'] ??
      flags['landing-page-map'] ??
      flags['preference-page-map'] ??
      flags['brand-map'] ??
      flags['form-map'] ??
      flags['form-handler-map'] ??
      flags['consent-banner-map'];
    const selectedApiNames =
      selectionFile === undefined
        ? undefined
        : (JSON.parse(await readFile(selectionFile, 'utf8')) as unknown);
    if (
      selectedApiNames !== undefined &&
      (!Array.isArray(selectedApiNames) ||
        selectedApiNames.some((value) => typeof value !== 'string'))
    ) {
      throw new TypeError('Component map must contain a JSON array of API-name strings.');
    }
    const landingPagePairs =
      pairSelectionFile === undefined
        ? undefined
        : parseLandingPagePairSelectors(
            JSON.parse(await readFile(pairSelectionFile, 'utf8')) as unknown,
          );
    let selectedContentType: string | undefined;
    if (flags['email-fragment-map'] !== undefined) selectedContentType = 'sfdc_cms__emailFragment';
    else if (flags['web-fragment-map'] !== undefined) selectedContentType = 'sfdc_cms__webFragment';
    else if (flags['landing-page-template-map'] !== undefined)
      selectedContentType = 'sfdc_cms__landingPageTemplate';
    else if (flags['landing-page-map'] !== undefined) selectedContentType = 'sfdc_cms__landingPage';
    else if (flags['preference-page-map'] !== undefined)
      selectedContentType = 'sfdc_cms__preferencePage';
    else if (flags['brand-map'] !== undefined) selectedContentType = 'sfdc_cms__brand';
    else if (flags['form-map'] !== undefined) selectedContentType = 'sfdc_cms__form';
    else if (flags['form-handler-map'] !== undefined) selectedContentType = 'sfdc_cms__formHandler';
    else if (flags['consent-banner-map'] !== undefined)
      selectedContentType = 'sfdc_cms__consentBanner';
    if (flags['form-handler-map'] !== undefined || flags['consent-banner-map'] !== undefined)
      await assertCanonicalMarketingWorkspace(connection, selected);
    const result = await exportWorkspace(connection, selected.id, destination, {
      editableDirectory: flags['editable-dir'],
      ...(selectedApiNames === undefined
        ? {}
        : {
            selection: {
              contentType: selectedContentType!,
              apiNames: selectedApiNames,
              ...(flags['preference-page-map'] === undefined
                ? {}
                : { preferencePageReports: true }),
              ...(flags['brand-map'] === undefined ? {} : { brandReports: true }),
              ...(flags['form-map'] === undefined ? {} : { formReports: true }),
              ...(flags['form-handler-map'] === undefined ? {} : { formHandlerReports: true }),
              ...(flags['consent-banner-map'] === undefined ? {} : { consentBannerReports: true }),
            },
          }),
      ...(landingPagePairs === undefined ? {} : { landingPagePairs }),
      pluginVersion: this.pluginVersion,
      sourceOrgId: orgId,
      ...(experimentalMedia === undefined ? {} : { experimentalMedia }),
    });
    for (const warning of result.manifest.warnings) this.warn(formatWarning(warning));

    if (!this.jsonEnabled()) {
      this.log(`Destination: ${result.destination}`);
      this.log(
        `Exported variants: ${result.manifest.exportedCount}/${result.manifest.expectedCount} expected`,
      );
    }

    if (result.manifest.completeness === 'partial') process.exitCode = 2;
    return result;
  }
}

function resolveExperimentalMedia(connection: {
  accessToken?: string | null;
  instanceUrl: string;
  getConnectionOptions?: () => { accessToken?: string | null };
}): { accessToken: string; instanceUrl: string } {
  const connectionOptions = connection.getConnectionOptions?.();
  const accessToken = connection.accessToken ?? connectionOptions?.accessToken;
  if (typeof accessToken !== 'string' || accessToken.length === 0) {
    throw new Error('--experimental-media requires an authenticated org access token.');
  }
  return { accessToken, instanceUrl: connection.instanceUrl };
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
