import { assertExactKeys, assertIdentifier, assertNonemptyString } from './shared.js';
import { EXTERNAL_REFERENCE_CORRELATIONS_CONTRACT } from './workspace-export.js';

export const CMS_INFO_CONTRACT = 'sf-cms-info' as const;
export const CMS_CAPABILITY_STATES = ['implemented', 'experimental', 'unavailable'] as const;
export const CMS_CAPABILITY_TRANSPORT = 'cli-json' as const;

export type CmsCapability = {
  id:
    | 'workspace.export.bulk'
    | 'workspace.export.dependency-closure'
    | 'workspace.export.external-reference-correlation'
    | 'workspace.export.experimental-media'
    | 'content.delete.email'
    | 'content.delete.email-template'
    | 'content.publish.email'
    | 'content.unpublish.email'
    | 'content.update.email-raw-html'
    | 'content.update.email-template-raw-html'
    | 'workspace.import.email-fragment-create'
    | 'workspace.import.image-create'
    | 'workspace.import.mapping';
  state: (typeof CMS_CAPABILITY_STATES)[number];
  transport: typeof CMS_CAPABILITY_TRANSPORT;
  contract:
    | 'unavailable'
    | 'sf-cms-workspace-export-set@1'
    | 'sf-cms-workspace-export@2'
    | 'sf-cms-content-delete@1'
    | 'sf-cms-content-delete@2'
    | 'sf-cms-content-publish@1'
    | 'sf-cms-content-unpublish@1'
    | 'sf-cms-content-update@1'
    | 'sf-cms-content-update@2'
    | typeof EXTERNAL_REFERENCE_CORRELATIONS_CONTRACT
    | 'sf-cms-workspace-import@1'
    | 'sf-cms-workspace-import@2';
};

export type CmsInfoResult = {
  plugin: {
    name: 'sf-plugin-cms';
    version: string;
  };
  api: {
    defaultVersion: '67.0';
    testedVersions: ['67.0'];
  };
  contracts: {
    commandResults: {
      info: ['1.0.0'];
      contentDelete: ['1.0.0', '2.0.0'];
      contentPublish: ['1.0.0'];
      contentUnpublish: ['1.0.0'];
      contentUpdate: ['1.0.0', '2.0.0'];
      workspaceExportSet: ['1.0.0'];
      workspaceImport: ['1.0.0', '2.0.0'];
    };
    packageManifests: {
      workspaceExport: ['1.0.0', '2.0.0'];
    };
    embeddedResults: {
      externalReferenceCorrelations: [typeof EXTERNAL_REFERENCE_CORRELATIONS_CONTRACT];
    };
    compatibility: {
      'workspaceExportSet@1': {
        workspaceExportManifestMajors: [1];
      };
      'workspaceImport@1': {
        workspaceExportManifestMajors: [1];
      };
      'workspaceImport@2': {
        workspaceExportManifestMajors: [2];
      };
    };
  };
  capabilities: CmsCapability[];
};

export function assertCmsInfoResult(value: unknown): asserts value is CmsInfoResult {
  assertExactKeys(value, ['plugin', 'api', 'contracts', 'capabilities'], 'result');
  assertExactKeys(value.plugin, ['name', 'version'], 'result.plugin');
  if (value.plugin.name !== 'sf-plugin-cms') throw new TypeError('result.plugin.name is invalid');
  assertNonemptyString(value.plugin.version, 'result.plugin.version');
  assertExactKeys(value.api, ['defaultVersion', 'testedVersions'], 'result.api');
  if (value.api.defaultVersion !== '67.0' || !isExactArray(value.api.testedVersions, ['67.0'])) {
    throw new TypeError('result.api is invalid');
  }
  assertExactKeys(
    value.contracts,
    ['commandResults', 'packageManifests', 'embeddedResults', 'compatibility'],
    'result.contracts',
  );
  assertExactKeys(
    value.contracts.commandResults,
    [
      'info',
      'contentDelete',
      'contentPublish',
      'contentUnpublish',
      'contentUpdate',
      'workspaceExportSet',
      'workspaceImport',
    ],
    'result.contracts.commandResults',
  );
  for (const key of ['info', 'contentPublish', 'contentUnpublish', 'workspaceExportSet'] as const) {
    if (!isExactArray(value.contracts.commandResults[key], ['1.0.0'])) {
      throw new TypeError(`result.contracts.commandResults.${key} is invalid`);
    }
  }
  if (!isExactArray(value.contracts.commandResults.contentUpdate, ['1.0.0', '2.0.0'])) {
    throw new TypeError('result.contracts.commandResults.contentUpdate is invalid');
  }
  if (!isExactArray(value.contracts.commandResults.contentDelete, ['1.0.0', '2.0.0'])) {
    throw new TypeError('result.contracts.commandResults.contentDelete is invalid');
  }
  if (!isExactArray(value.contracts.commandResults.workspaceImport, ['1.0.0', '2.0.0'])) {
    throw new TypeError('result.contracts.commandResults.workspaceImport is invalid');
  }
  assertExactKeys(
    value.contracts.packageManifests,
    ['workspaceExport'],
    'result.contracts.packageManifests',
  );
  if (!isExactArray(value.contracts.packageManifests.workspaceExport, ['1.0.0', '2.0.0'])) {
    throw new TypeError('result.contracts.packageManifests.workspaceExport is invalid');
  }
  assertExactKeys(
    value.contracts.embeddedResults,
    ['externalReferenceCorrelations'],
    'result.contracts.embeddedResults',
  );
  if (
    !isExactArray(value.contracts.embeddedResults.externalReferenceCorrelations, [
      EXTERNAL_REFERENCE_CORRELATIONS_CONTRACT,
    ])
  ) {
    throw new TypeError(
      'result.contracts.embeddedResults.externalReferenceCorrelations is invalid',
    );
  }
  assertExactKeys(
    value.contracts.compatibility,
    ['workspaceExportSet@1', 'workspaceImport@1', 'workspaceImport@2'],
    'result.contracts.compatibility',
  );
  const compatibility = value.contracts.compatibility as Record<
    'workspaceExportSet@1' | 'workspaceImport@1' | 'workspaceImport@2',
    { workspaceExportManifestMajors?: unknown }
  >;
  for (const key of ['workspaceExportSet@1', 'workspaceImport@1', 'workspaceImport@2'] as const) {
    assertExactKeys(
      compatibility[key],
      ['workspaceExportManifestMajors'],
      `result.contracts.compatibility.${key}`,
    );
  }
  if (
    !isExactArray(compatibility['workspaceExportSet@1'].workspaceExportManifestMajors, [1]) ||
    !isExactArray(compatibility['workspaceImport@1'].workspaceExportManifestMajors, [1]) ||
    !isExactArray(compatibility['workspaceImport@2'].workspaceExportManifestMajors, [2])
  ) {
    throw new TypeError('result.contracts.compatibility is invalid');
  }
  if (!Array.isArray(value.capabilities))
    throw new TypeError('result.capabilities must be an array');
  const seen = new Set<string>();
  for (const [index, capability] of value.capabilities.entries()) {
    const label = `result.capabilities[${index}]`;
    assertExactKeys(capability, ['id', 'state', 'transport', 'contract'], label);
    assertIdentifier(capability.id, `${label}.id`);
    if (seen.has(capability.id)) throw new TypeError(`duplicate capability: ${capability.id}`);
    seen.add(capability.id);
    if (!CMS_CAPABILITY_STATES.includes(capability.state as CmsCapability['state'])) {
      throw new TypeError(`${label}.state is invalid`);
    }
    if (capability.transport !== CMS_CAPABILITY_TRANSPORT)
      throw new TypeError(`${label}.transport is invalid`);
    const expectedContracts = new Map([
      ['workspace.export.bulk', 'sf-cms-workspace-export-set@1'],
      ['workspace.export.dependency-closure', 'unavailable'],
      ['workspace.export.external-reference-correlation', EXTERNAL_REFERENCE_CORRELATIONS_CONTRACT],
      ['workspace.export.experimental-media', 'sf-cms-workspace-export@2'],
      ['content.delete.email', 'sf-cms-content-delete@1'],
      ['content.delete.email-template', 'sf-cms-content-delete@2'],
      ['content.publish.email', 'sf-cms-content-publish@1'],
      ['content.unpublish.email', 'sf-cms-content-unpublish@1'],
      ['content.update.email-raw-html', 'sf-cms-content-update@1'],
      ['content.update.email-template-raw-html', 'sf-cms-content-update@2'],
      ['workspace.import.email-fragment-create', 'sf-cms-workspace-import@1'],
      ['workspace.import.image-create', 'sf-cms-workspace-import@2'],
      ['workspace.import.mapping', 'sf-cms-workspace-import@1'],
    ]);
    if (capability.contract !== expectedContracts.get(capability.id)) {
      throw new TypeError(`${label}.contract does not match its capability ID`);
    }
  }
}

function isExactArray(value: unknown, expected: readonly unknown[]): boolean {
  return Array.isArray(value) && JSON.stringify(value) === JSON.stringify(expected);
}
