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
  CMS_INFO_CONTRACT,
  CMS_PUBLIC_CAPABILITIES,
  CMS_PUBLIC_COMMAND_RESULTS,
  CMS_PUBLIC_COMMANDS,
  type CmsInfoResult,
} from '../../contracts/info.js';
import type { CmsEnvelope } from '../../contracts/shared.js';
import { CmsCommand } from '../../command-base.js';

/** Reports current public support separately from retained internal CMS engines. */
export default class Info extends CmsCommand<CmsEnvelope<CmsInfoResult>> {
  public static readonly summary = 'Show offline CMS contract and capability information.';
  public static readonly description =
    'Reports current public retrieve/deploy/upload and lifecycle support, tested API baseline, and separately labelled internal-engine metadata without contacting an org. Deploy and loose-image upload remain unqualified; internal family profiles do not imply public support.';
  public static readonly examples = [
    '<%= config.bin %> cms info',
    '<%= config.bin %> cms info --json',
  ];
  public static readonly flags = {
    'contract-version': Flags.integer({
      default: 1,
      min: 1,
      summary: 'Current machine contract major (supported: 1).',
    }),
  };

  public async run(): Promise<CmsEnvelope<CmsInfoResult>> {
    const { flags } = await this.parse(Info);
    const requestedVersion = flags['contract-version'] ?? 1;
    const result = successEnvelope(this.pluginVersion);
    if (requestedVersion !== 1) {
      result.status = 'blocked';
      result.result = null;
      result.diagnostics.errors.push({
        code: 'UNSUPPORTED_CONTRACT_VERSION',
        message: `Contract major ${requestedVersion} is unsupported; supported major is 1.`,
        retryable: false,
      });
    }
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
      api: { defaultVersion: DEFAULT_API_VERSION, testedVersions: [FALLBACK_API_VERSION] },
      commands: [...CMS_PUBLIC_COMMANDS],
      contracts: {
        commandResults: {
          info: [...CMS_PUBLIC_COMMAND_RESULTS.info],
          contentRetrieve: [...CMS_PUBLIC_COMMAND_RESULTS.contentRetrieve],
          contentDeploy: [...CMS_PUBLIC_COMMAND_RESULTS.contentDeploy],
          imagesUpload: [...CMS_PUBLIC_COMMAND_RESULTS.imagesUpload],
          contentDelete: [...CMS_PUBLIC_COMMAND_RESULTS.contentDelete],
          contentPublish: [...CMS_PUBLIC_COMMAND_RESULTS.contentPublish],
          contentUnpublish: [...CMS_PUBLIC_COMMAND_RESULTS.contentUnpublish],
        },
      },
      capabilities: structuredClone([...CMS_PUBLIC_CAPABILITIES]),
      internalRegistry: {
        scope: 'internal-engine-only',
        contract: METADATA_CAPABILITY_CONTRACT,
        version: METADATA_CAPABILITY_VERSION,
        fixtureSha256: METADATA_CAPABILITY_FIXTURE_SHA256,
        declarations: structuredClone(CMS_CAPABILITY_DECLARATIONS),
      },
    },
  };
}
