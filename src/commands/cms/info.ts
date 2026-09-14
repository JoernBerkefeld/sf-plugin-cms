import { Flags } from '@salesforce/sf-plugins-core';
import {
  assertCmsInfoResult,
  CMS_INFO_CONTRACT,
  type CmsInfoResult,
} from '../../contracts/info.js';
import type { CmsEnvelope } from '../../contracts/shared.js';
import { CmsCommand } from '../../command-base.js';

/** Reports the offline CMS CLI contract and capability envelope. */
export default class Info extends CmsCommand<CmsEnvelope<CmsInfoResult>> {
  public static readonly summary = 'Show offline CMS contract and capability information.';
  public static readonly description =
    'Reports the versioned CLI JSON contracts, package compatibility, tested API baseline, and truthfully evidenced CMS capabilities without contacting an org.';
  public static readonly examples = [
    '<%= config.bin %> cms info',
    '<%= config.bin %> cms info --json',
    '<%= config.bin %> cms info --contract-version 1 --json',
  ];
  public static readonly flags = {
    'contract-version': Flags.integer({
      default: 1,
      min: 1,
      summary: 'Machine contract major version (supported: 1).',
    }),
  };

  public async run(): Promise<CmsEnvelope<CmsInfoResult>> {
    const { flags } = await this.parse(Info);
    const requestedVersion = flags['contract-version'] ?? 1;
    const result =
      requestedVersion === 1
        ? successEnvelope(this.pluginVersion)
        : blockedEnvelope(requestedVersion, this.pluginVersion);

    if (!this.jsonEnabled()) this.styledJSON(result);
    return this.finishEnvelope(result, assertCmsInfoResult);
  }
}

function successEnvelope(pluginVersion: string): CmsEnvelope<CmsInfoResult> {
  return {
    contract: CMS_INFO_CONTRACT,
    contractVersion: '1.0.0',
    status: 'success',
    metadata: {
      operation: 'cms.info',
      plugin: { name: 'sf-plugin-cms', version: pluginVersion },
      apiVersion: null,
    },
    diagnostics: { warnings: [], errors: [] },
    provenance: {
      producer: 'sf-plugin-cms',
      sourceOrgId: 'offline',
      pluginVersion,
      command: 'sf cms info',
      generatedAt: new Date().toISOString(),
    },
    result: {
      plugin: { name: 'sf-plugin-cms', version: pluginVersion },
      api: { defaultVersion: '67.0', testedVersions: ['67.0'] },
      contracts: {
        commandResults: {
          info: ['1.0.0'],
          workspaceExportSet: ['1.0.0'],
          workspaceImport: ['1.0.0'],
        },
        packageManifests: { workspaceExport: ['1.0.0'] },
        embeddedResults: {
          externalReferenceCorrelations: ['sf-cms-external-reference-correlations@1'],
        },
        compatibility: {
          'workspaceExportSet@1': { workspaceExportManifestMajors: [1] },
          'workspaceImport@1': { workspaceExportManifestMajors: [1] },
        },
      },
      capabilities: [
        {
          id: 'workspace.export.bulk',
          state: 'implemented',
          transport: 'cli-json',
          contract: 'sf-cms-workspace-export-set@1',
        },
        {
          id: 'workspace.export.dependency-closure',
          state: 'unavailable',
          transport: 'cli-json',
          contract: 'unavailable',
        },
        {
          id: 'workspace.export.external-reference-correlation',
          state: 'experimental',
          transport: 'cli-json',
          contract: 'sf-cms-external-reference-correlations@1',
        },
        {
          id: 'workspace.import.mapping',
          state: 'experimental',
          transport: 'cli-json',
          contract: 'sf-cms-workspace-import@1',
        },
      ],
    },
  };
}

function blockedEnvelope(
  requestedVersion: number,
  pluginVersion: string,
): CmsEnvelope<CmsInfoResult> {
  return {
    contract: CMS_INFO_CONTRACT,
    contractVersion: '1.0.0',
    status: 'blocked',
    metadata: {
      operation: 'cms.info',
      plugin: { name: 'sf-plugin-cms', version: pluginVersion },
      apiVersion: null,
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
      sourceOrgId: 'offline',
      pluginVersion,
      command: 'sf cms info',
      generatedAt: new Date().toISOString(),
    },
    result: null,
  };
}
