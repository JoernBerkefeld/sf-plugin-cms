import { Flags } from '@salesforce/sf-plugins-core';
import { DEFAULT_API_VERSION, FALLBACK_API_VERSION } from '../../api-policy.js';
import {
  CMS_CAPABILITY_DECLARATIONS,
  METADATA_CAPABILITY_CONTRACT,
  METADATA_CAPABILITY_FIXTURE_SHA256,
  METADATA_CAPABILITY_VERSION,
} from '../../contracts/capability-registry.js';
import {
  assertCmsInfoResult,
  assertCmsInfoResultV2,
  CMS_INFO_CONTRACT,
  type CmsInfoResult,
  type CmsInfoResultV2,
} from '../../contracts/info.js';
import type { CmsEnvelope } from '../../contracts/shared.js';
import { CmsCommand } from '../../command-base.js';

/** Reports the offline CMS CLI contract and capability envelope. */
export default class Info extends CmsCommand<CmsEnvelope<CmsInfoResult | CmsInfoResultV2>> {
  public static readonly summary = 'Show offline CMS contract and capability information.';
  public static readonly description =
    'Reports the versioned CLI JSON contracts, package compatibility, tested API baseline, and truthfully evidenced CMS capabilities without contacting an org.';
  public static readonly examples = [
    '<%= config.bin %> cms info',
    '<%= config.bin %> cms info --json',
    '<%= config.bin %> cms info --contract-version 1 --json',
    '<%= config.bin %> cms info --contract-version 2 --json',
  ];
  public static readonly flags = {
    'contract-version': Flags.integer({
      default: 1,
      min: 1,
      summary: 'Machine contract major version (supported: 1, 2).',
    }),
  };

  public async run(): Promise<CmsEnvelope<CmsInfoResult | CmsInfoResultV2>> {
    const { flags } = await this.parse(Info);
    const requestedVersion = flags['contract-version'] ?? 1;
    let result: CmsEnvelope<CmsInfoResult | CmsInfoResultV2>;
    if (requestedVersion === 1) result = successEnvelope(this.pluginVersion);
    else if (requestedVersion === 2) result = successEnvelopeV2(this.pluginVersion);
    else result = blockedEnvelope(requestedVersion, this.pluginVersion);

    if (!this.jsonEnabled()) this.styledJSON(result);
    return requestedVersion === 2
      ? this.finishEnvelope(result as CmsEnvelope<CmsInfoResultV2>, assertCmsInfoResultV2)
      : this.finishEnvelope(result as CmsEnvelope<CmsInfoResult>, assertCmsInfoResult);
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
      api: { defaultVersion: DEFAULT_API_VERSION, testedVersions: [FALLBACK_API_VERSION] },
      contracts: {
        commandResults: {
          info: ['1.0.0'],
          contentDelete: ['1.0.0', '2.0.0'],
          contentPublish: ['1.0.0'],
          contentUnpublish: ['1.0.0'],
          contentUpdate: ['1.0.0', '2.0.0'],
          workspaceExportSet: ['1.0.0'],
          workspaceImport: ['1.0.0', '2.0.0'],
        },
        packageManifests: { workspaceExport: ['1.0.0', '2.0.0'] },
        embeddedResults: {
          externalReferenceCorrelations: ['sf-cms-external-reference-correlations@1'],
        },
        compatibility: {
          'workspaceExportSet@1': { workspaceExportManifestMajors: [1] },
          'workspaceImport@1': { workspaceExportManifestMajors: [1] },
          'workspaceImport@2': { workspaceExportManifestMajors: [2] },
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
          id: 'workspace.export.experimental-media',
          state: 'experimental',
          transport: 'cli-json',
          contract: 'sf-cms-workspace-export@2',
        },
        {
          id: 'content.delete.email',
          state: 'experimental',
          transport: 'cli-json',
          contract: 'sf-cms-content-delete@1',
        },
        {
          id: 'content.delete.email-template',
          state: 'experimental',
          transport: 'cli-json',
          contract: 'sf-cms-content-delete@2',
        },
        {
          id: 'content.publish.email',
          state: 'experimental',
          transport: 'cli-json',
          contract: 'sf-cms-content-publish@1',
        },
        {
          id: 'content.unpublish.email',
          state: 'experimental',
          transport: 'cli-json',
          contract: 'sf-cms-content-unpublish@1',
        },
        {
          id: 'content.update.email-raw-html',
          state: 'experimental',
          transport: 'cli-json',
          contract: 'sf-cms-content-update@1',
        },
        {
          id: 'content.update.email-template-raw-html',
          state: 'experimental',
          transport: 'cli-json',
          contract: 'sf-cms-content-update@2',
        },
        {
          id: 'workspace.import.email-fragment-create',
          state: 'experimental',
          transport: 'cli-json',
          contract: 'sf-cms-workspace-import@1',
        },
        {
          id: 'workspace.import.image-create',
          state: 'experimental',
          transport: 'cli-json',
          contract: 'sf-cms-workspace-import@2',
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

function successEnvelopeV2(pluginVersion: string): CmsEnvelope<CmsInfoResultV2> {
  const v1 = successEnvelope(pluginVersion);
  return {
    ...v1,
    contractVersion: '2.0.0',
    result: {
      ...v1.result!,
      registry: {
        contract: METADATA_CAPABILITY_CONTRACT,
        version: METADATA_CAPABILITY_VERSION,
        fixtureSha256: METADATA_CAPABILITY_FIXTURE_SHA256,
        declarations: structuredClone(CMS_CAPABILITY_DECLARATIONS),
      },
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
          message: `Contract major ${requestedVersion} is unsupported; supported majors are 1 and 2.`,
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
