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
    | 'workspace.import.mapping';
  state: (typeof CMS_CAPABILITY_STATES)[number];
  transport: typeof CMS_CAPABILITY_TRANSPORT;
  contract:
    | 'unavailable'
    | 'sf-cms-workspace-export-set@1'
    | typeof EXTERNAL_REFERENCE_CORRELATIONS_CONTRACT
    | 'sf-cms-workspace-import@1';
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
      workspaceExportSet: ['1.0.0'];
      workspaceImport: ['1.0.0'];
    };
    packageManifests: {
      workspaceExport: ['1.0.0'];
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
    ['info', 'workspaceExportSet', 'workspaceImport'],
    'result.contracts.commandResults',
  );
  for (const key of ['info', 'workspaceExportSet', 'workspaceImport'] as const) {
    if (!isExactArray(value.contracts.commandResults[key], ['1.0.0'])) {
      throw new TypeError(`result.contracts.commandResults.${key} is invalid`);
    }
  }
  assertExactKeys(
    value.contracts.packageManifests,
    ['workspaceExport'],
    'result.contracts.packageManifests',
  );
  if (!isExactArray(value.contracts.packageManifests.workspaceExport, ['1.0.0'])) {
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
    ['workspaceExportSet@1', 'workspaceImport@1'],
    'result.contracts.compatibility',
  );
  for (const key of ['workspaceExportSet@1', 'workspaceImport@1'] as const) {
    assertExactKeys(
      value.contracts.compatibility[key],
      ['workspaceExportManifestMajors'],
      `result.contracts.compatibility.${key}`,
    );
    if (!isExactArray(value.contracts.compatibility[key].workspaceExportManifestMajors, [1])) {
      throw new TypeError(`result.contracts.compatibility.${key} is invalid`);
    }
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
