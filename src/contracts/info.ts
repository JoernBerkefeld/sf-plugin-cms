import { DEFAULT_API_VERSION, FALLBACK_API_VERSION } from '../api-policy.js';
import {
  assertCapabilityRegistryFixture,
  METADATA_CAPABILITY_CONTRACT,
  METADATA_CAPABILITY_FIXTURE_SHA256,
  METADATA_CAPABILITY_VERSION,
  type CapabilityRegistryFixture,
} from './capability-registry.js';
import { assertExactKeys, assertNonemptyString } from './shared.js';

export const CMS_INFO_CONTRACT = 'sf-cms-info' as const;
export const CMS_CAPABILITY_STATES = [
  'implemented',
  'experimental',
  'unqualified',
  'unavailable',
] as const;
export const CMS_CAPABILITY_TRANSPORT = 'cli-json' as const;

// Only commands with a CMS-owned envelope have a command-result contract.
export const CMS_PUBLIC_COMMAND_RESULTS = {
  info: ['1.0.0'],
  contentRetrieve: ['1.0.0'],
  contentDeploy: ['1.0.0'],
  imagesUpload: ['1.0.0'],
  contentDelete: ['1.0.0', '2.0.0'],
  contentPublish: ['1.0.0'],
  contentUnpublish: ['1.0.0'],
} as const;

export const CMS_PUBLIC_COMMANDS = [
  'cms info',
  'cms list workspace',
  'cms list channel',
  'cms retrieve content',
  'cms deploy content',
  'cms upload images',
  'cms delete content',
  'cms publish content',
  'cms unpublish content',
] as const;

export type CmsCapability = {
  id: string;
  state: (typeof CMS_CAPABILITY_STATES)[number];
  transport: typeof CMS_CAPABILITY_TRANSPORT;
  contract: string;
};

export const CMS_PUBLIC_CAPABILITIES: readonly CmsCapability[] = [
  {
    id: 'content.retrieve.email',
    state: 'experimental',
    transport: 'cli-json',
    contract: 'sf-cms-content-retrieve@1',
  },
  {
    id: 'content.retrieve.email-template',
    state: 'experimental',
    transport: 'cli-json',
    contract: 'sf-cms-content-retrieve@1',
  },
  {
    id: 'content.retrieve.image',
    state: 'experimental',
    transport: 'cli-json',
    contract: 'sf-cms-content-retrieve@1',
  },
  {
    id: 'content.retrieve.document',
    state: 'unqualified',
    transport: 'cli-json',
    contract: 'sf-cms-content-retrieve@1',
  },
  {
    id: 'content.retrieve.audio',
    state: 'unqualified',
    transport: 'cli-json',
    contract: 'sf-cms-content-retrieve@1',
  },
  {
    id: 'content.deploy.email.create',
    state: 'unqualified',
    transport: 'cli-json',
    contract: 'sf-cms-content-deploy@1',
  },
  {
    id: 'content.deploy.email.update',
    state: 'unqualified',
    transport: 'cli-json',
    contract: 'sf-cms-content-deploy@1',
  },
  {
    id: 'content.deploy.email.unchanged',
    state: 'unqualified',
    transport: 'cli-json',
    contract: 'sf-cms-content-deploy@1',
  },
  {
    id: 'content.deploy.email-template.create',
    state: 'unqualified',
    transport: 'cli-json',
    contract: 'sf-cms-content-deploy@1',
  },
  {
    id: 'content.deploy.email-template.update',
    state: 'unqualified',
    transport: 'cli-json',
    contract: 'sf-cms-content-deploy@1',
  },
  {
    id: 'content.deploy.email-template.unchanged',
    state: 'unqualified',
    transport: 'cli-json',
    contract: 'sf-cms-content-deploy@1',
  },
  {
    id: 'content.deploy.image.create',
    state: 'unqualified',
    transport: 'cli-json',
    contract: 'sf-cms-content-deploy@1',
  },
  {
    id: 'content.deploy.image.update',
    state: 'unqualified',
    transport: 'cli-json',
    contract: 'sf-cms-content-deploy@1',
  },
  {
    id: 'content.deploy.image.unchanged',
    state: 'unqualified',
    transport: 'cli-json',
    contract: 'sf-cms-content-deploy@1',
  },
  {
    id: 'content.deploy.document.create',
    state: 'unqualified',
    transport: 'cli-json',
    contract: 'sf-cms-content-deploy@1',
  },
  {
    id: 'content.deploy.document.update',
    state: 'unqualified',
    transport: 'cli-json',
    contract: 'sf-cms-content-deploy@1',
  },
  {
    id: 'content.deploy.document.unchanged',
    state: 'unqualified',
    transport: 'cli-json',
    contract: 'sf-cms-content-deploy@1',
  },
  {
    id: 'content.deploy.audio.create',
    state: 'unqualified',
    transport: 'cli-json',
    contract: 'sf-cms-content-deploy@1',
  },
  {
    id: 'content.deploy.audio.update',
    state: 'unqualified',
    transport: 'cli-json',
    contract: 'sf-cms-content-deploy@1',
  },
  {
    id: 'content.deploy.audio.unchanged',
    state: 'unqualified',
    transport: 'cli-json',
    contract: 'sf-cms-content-deploy@1',
  },
  {
    id: 'images.upload.create',
    state: 'unqualified',
    transport: 'cli-json',
    contract: 'sf-cms-images-upload@1',
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
];

export type CmsCapabilityRegistryResult = {
  scope: 'internal-engine-only';
  contract: typeof METADATA_CAPABILITY_CONTRACT;
  version: typeof METADATA_CAPABILITY_VERSION;
  fixtureSha256: typeof METADATA_CAPABILITY_FIXTURE_SHA256;
  declarations: CapabilityRegistryFixture['declarations'];
};

export type CmsInfoResult = {
  plugin: { name: 'sf-plugin-cms'; version: string };
  api: {
    defaultVersion: typeof DEFAULT_API_VERSION | typeof FALLBACK_API_VERSION;
    testedVersions: [typeof FALLBACK_API_VERSION];
  };
  commands: Array<(typeof CMS_PUBLIC_COMMANDS)[number]>;
  contracts: { commandResults: { [K in keyof typeof CMS_PUBLIC_COMMAND_RESULTS]: string[] } };
  capabilities: CmsCapability[];
  internalRegistry: CmsCapabilityRegistryResult;
};

export function assertCmsInfoResult(value: unknown): asserts value is CmsInfoResult {
  assertExactKeys(
    value,
    ['plugin', 'api', 'commands', 'contracts', 'capabilities', 'internalRegistry'],
    'result',
  );
  assertExactKeys(value.plugin, ['name', 'version'], 'result.plugin');
  if (value.plugin.name !== 'sf-plugin-cms') throw new TypeError('result.plugin.name is invalid');
  assertNonemptyString(value.plugin.version, 'result.plugin.version');
  assertExactKeys(value.api, ['defaultVersion', 'testedVersions'], 'result.api');
  if (
    (value.api.defaultVersion !== DEFAULT_API_VERSION &&
      value.api.defaultVersion !== FALLBACK_API_VERSION) ||
    !isExact(value.api.testedVersions, [FALLBACK_API_VERSION])
  ) {
    throw new TypeError('result.api is invalid');
  }
  if (!isExact(value.commands, CMS_PUBLIC_COMMANDS))
    throw new TypeError('result.commands is invalid');
  assertExactKeys(value.contracts, ['commandResults'], 'result.contracts');
  assertExactKeys(
    value.contracts.commandResults,
    Object.keys(CMS_PUBLIC_COMMAND_RESULTS),
    'result.contracts.commandResults',
  );
  for (const [key, versions] of Object.entries(CMS_PUBLIC_COMMAND_RESULTS)) {
    if (!isExact(value.contracts.commandResults[key], versions))
      throw new TypeError(`result.contracts.commandResults.${key} is invalid`);
  }
  if (!isExact(value.capabilities, CMS_PUBLIC_CAPABILITIES))
    throw new TypeError('result.capabilities does not match public support');
  assertExactKeys(
    value.internalRegistry,
    ['scope', 'contract', 'version', 'fixtureSha256', 'declarations'],
    'result.internalRegistry',
  );
  const registry = value.internalRegistry;
  if (registry.scope !== 'internal-engine-only')
    throw new TypeError('result.internalRegistry.scope is invalid');
  if (registry.fixtureSha256 !== METADATA_CAPABILITY_FIXTURE_SHA256)
    throw new TypeError('result.internalRegistry.fixtureSha256 is invalid');
  assertCapabilityRegistryFixture({
    contract: registry.contract,
    version: registry.version,
    declarations: registry.declarations,
  });
  if (
    (registry.declarations as CapabilityRegistryFixture['declarations']).some(
      (declaration) =>
        declaration.identity.provider !== 'sf-plugin-cms' ||
        declaration.providerContract.name !== 'sf-plugin-cms' ||
        declaration.identity.family !== 'cms',
    )
  ) {
    throw new TypeError('result.internalRegistry provider provenance is invalid');
  }
}

function isExact(value: unknown, expected: unknown): boolean {
  return JSON.stringify(value) === JSON.stringify(expected);
}
