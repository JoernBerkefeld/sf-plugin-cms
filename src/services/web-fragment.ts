import type { Connection } from '@salesforce/core';
import { isDeepStrictEqual } from 'node:util';
import type { LoadedWorkspaceExport, WorkspaceImportItem } from './import-workspace.js';
import type { PlannedImportIdentities } from './import-identities.js';

const WEB_FRAGMENT_TYPE = 'sfdc_cms__webFragment';
const DATA_GRAPH_PROVIDER = 'sfdc_cms__dataGraphDataProvider';
const BODY_KEYS = [
  'lightning:backgroundImage',
  'lightning:brandSource',
  'lightning:dataProviders',
  'lightning:expressions',
  'sfdc_cms:block',
  'sfdc_cms:title',
  'sfdc_cms:variants',
] as const;
const BACKGROUND_IMAGE = { position: 'center center', repeat: 'no-repeat', size: 'cover' };

type JsonRecord = Record<string, unknown>;
type QueryConnection = { readonly query?: Connection['query'] };

export type WebFragmentDataGraphPrerequisite = {
  readonly sourceDeveloperName: string;
  readonly sourceDataSpace: string;
  readonly targetDeveloperName: string;
  readonly targetDataSpace: string;
  readonly resolution: 'preserved' | 'explicit-map';
  validationStatus?: 'pending' | 'passed' | 'failed';
};

export type PlannedWebFragmentCopies = PlannedImportIdentities & {
  readonly dataGraphs: readonly WebFragmentDataGraphPrerequisite[];
};

function record(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value: JsonRecord, expected: readonly string[], label: string): void {
  if (Object.keys(value).toSorted().join('\0') !== [...expected].toSorted().join('\0')) {
    throw new TypeError(`${label} must contain exactly ${expected.join(', ')}`);
  }
}

function nonempty(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${label} must be a nonempty string`);
  }
}

function identifier(value: unknown, label: string): asserts value is string {
  nonempty(value, label);
  if (!/^[A-Za-z][A-Za-z\d_]*$/u.test(value)) {
    throw new TypeError(`${label} must be an exact developer/API name`);
  }
}

function dataSpace(value: unknown, label: string): asserts value is string {
  nonempty(value, label);
  if (!/^[A-Za-z][A-Za-z\d_]*$/u.test(value)) {
    throw new TypeError(`${label} must be an exact data-space developer name`);
  }
}

function assertBlock(value: unknown): void {
  if (!record(value)) throw new TypeError('Web fragment sfdc_cms:block must be an object');
  if (value.definition !== 'sfdc_cms/rootContentBlock' || value.type !== 'block') {
    throw new TypeError('Web fragment root block definition/type is unsupported');
  }
  nonempty(value.id, 'Web fragment root block id');
  if (!Array.isArray(value.children))
    throw new TypeError('Web fragment root children must be an array');
}

function provider(value: unknown, label: string): { developerName: string; dataSpace: string } {
  if (!record(value)) throw new TypeError(`${label} must be an object`);
  exactKeys(value, ['attributes', 'definition', 'sfdcExpressionKey'], label);
  if (value.definition !== DATA_GRAPH_PROVIDER || value.sfdcExpressionKey !== '$dataGraph') {
    throw new TypeError(`${label} must use the exact Data Graph provider definition`);
  }
  if (!record(value.attributes)) throw new TypeError(`${label}.attributes must be an object`);
  exactKeys(value.attributes, ['dataGraphApiName', 'dataspace'], `${label}.attributes`);
  identifier(value.attributes.dataGraphApiName, `${label}.attributes.dataGraphApiName`);
  dataSpace(value.attributes.dataspace, `${label}.attributes.dataspace`);
  return {
    developerName: value.attributes.dataGraphApiName,
    dataSpace: value.attributes.dataspace,
  };
}

/**
 * Validate the evidenced landing-page content-block shape.
 * @param {WorkspaceImportItem} item - Integrity-verified web-fragment item.
 * @returns {{developerName: string, dataSpace: string}[]} Exact named Data Graph prerequisites.
 */
export function assertWebFragmentItem(
  item: WorkspaceImportItem,
): readonly { developerName: string; dataSpace: string }[] {
  if (item.contentType !== WEB_FRAGMENT_TYPE) {
    throw new TypeError(`Web fragment profile requires exact content type ${WEB_FRAGMENT_TYPE}`);
  }
  identifier(item.apiName, 'Web fragment apiName');
  nonempty(item.title, 'Web fragment title');
  exactKeys(item.contentBody as JsonRecord, BODY_KEYS, 'Web fragment contentBody');
  if (item.contentBody['sfdc_cms:title'] !== item.title) {
    throw new TypeError('Web fragment body title must match the top-level title');
  }
  if (
    !isDeepStrictEqual(item.contentBody['lightning:brandSource'], {
      defaultBrandOption: 'sfdcBrand',
    })
  ) {
    throw new TypeError(
      'Web fragment brand source must match the evidenced Salesforce-brand profile',
    );
  }
  if (!isDeepStrictEqual(item.contentBody['lightning:backgroundImage'], BACKGROUND_IMAGE)) {
    throw new TypeError('Web fragment background image must match the evidenced profile');
  }
  if (!Array.isArray(item.contentBody['lightning:expressions'])) {
    throw new TypeError('Web fragment lightning:expressions must be an array');
  }
  if (!Array.isArray(item.contentBody['sfdc_cms:variants'])) {
    throw new TypeError('Web fragment sfdc_cms:variants must be an array');
  }
  assertBlock(item.contentBody['sfdc_cms:block']);
  const providers = item.contentBody['lightning:dataProviders'];
  if (!Array.isArray(providers) || providers.length === 0) {
    throw new TypeError('Web fragment requires at least one exact named Data Graph provider');
  }
  const prerequisites = providers.map((value, index) =>
    provider(value, `Data Graph provider ${index}`),
  );
  const identities = new Set(
    prerequisites.map(({ developerName, dataSpace: space }) => `${developerName}\0${space}`),
  );
  if (identities.size !== prerequisites.length) {
    throw new TypeError('Web fragment Data Graph providers must be unique');
  }
  return prerequisites;
}

function mappingRows(value: unknown): JsonRecord[] {
  if (!Array.isArray(value) || value.length === 0 || value.some((row) => !record(row))) {
    throw new TypeError('Web fragment mappings must be a nonempty array of objects');
  }
  return value as JsonRecord[];
}

/**
 * Plan one or many exact type-qualified web-fragment creates.
 * @param {LoadedWorkspaceExport} source - Integrity-verified workspace package.
 * @param {unknown} input - Explicit source, target, and Data Graph map rows.
 * @returns {PlannedWebFragmentCopies} Selected creates and exact prerequisite evidence.
 */
export function planWebFragmentCopies(
  source: LoadedWorkspaceExport,
  input: unknown,
): PlannedWebFragmentCopies {
  if (!source.integrity.verified) throw new TypeError('Source integrity must be verified first');
  const sourceKeys = new Set(source.items.map((item) => item.contentKey));
  const sourceNames = new Set(
    source.items.flatMap((item) => (item.apiName === undefined ? [] : [item.apiName])),
  );
  const targetKeys = new Set<string>();
  const targetNames = new Set<string>();
  const selected = new Set<string>();
  const items: WorkspaceImportItem[] = [];
  const dataGraphs: WebFragmentDataGraphPrerequisite[] = [];

  for (const [index, row] of mappingRows(input).entries()) {
    exactKeys(row, ['source', 'target', 'dataGraphs'], `Web fragment mapping ${index}`);
    if (!record(row.source))
      throw new TypeError(`Web fragment mapping ${index}.source must be an object`);
    exactKeys(row.source, ['family', 'type', 'apiName'], `Web fragment mapping ${index}.source`);
    if (row.source.family !== 'cms' || row.source.type !== 'webFragment') {
      throw new TypeError(`Web fragment mapping ${index}.source must select cms/webFragment`);
    }
    identifier(row.source.apiName, `Web fragment mapping ${index}.source.apiName`);
    const sourceApiName = row.source.apiName;
    if (selected.has(sourceApiName))
      throw new TypeError(`Duplicate web fragment selection: ${sourceApiName}`);
    const matches = source.items.filter(
      (item) => item.contentType === WEB_FRAGMENT_TYPE && item.apiName === sourceApiName,
    );
    if (matches.length !== 1) {
      throw new TypeError(
        `Typed source API name must match exactly one web fragment: ${sourceApiName}`,
      );
    }
    const item = matches[0];
    const sourcePrerequisites = assertWebFragmentItem(item);

    if (!record(row.target))
      throw new TypeError(`Web fragment mapping ${index}.target must be an object`);
    exactKeys(row.target, ['contentKey', 'apiName'], `Web fragment mapping ${index}.target`);
    identifier(row.target.contentKey, `Web fragment mapping ${index}.target.contentKey`);
    identifier(row.target.apiName, `Web fragment mapping ${index}.target.apiName`);
    const contentKey = row.target.contentKey;
    const apiName = row.target.apiName;
    if (sourceKeys.has(contentKey) || targetKeys.has(contentKey)) {
      throw new TypeError('Target web fragment content keys must be fresh and unique');
    }
    if (sourceNames.has(apiName) || targetNames.has(apiName)) {
      throw new TypeError('Target web fragment API names must be fresh and unique');
    }

    if (!Array.isArray(row.dataGraphs) || row.dataGraphs.length !== sourcePrerequisites.length) {
      throw new TypeError('Each source Data Graph prerequisite requires exactly one mapping row');
    }
    const mapped = new Map<string, WebFragmentDataGraphPrerequisite>();
    for (const [graphIndex, raw] of row.dataGraphs.entries()) {
      if (!record(raw))
        throw new TypeError(
          `Web fragment mapping ${index}.dataGraphs[${graphIndex}] must be an object`,
        );
      exactKeys(
        raw,
        ['sourceDeveloperName', 'sourceDataSpace', 'targetDeveloperName', 'targetDataSpace'],
        `Web fragment mapping ${index}.dataGraphs[${graphIndex}]`,
      );
      identifier(raw.sourceDeveloperName, 'sourceDeveloperName');
      dataSpace(raw.sourceDataSpace, 'sourceDataSpace');
      identifier(raw.targetDeveloperName, 'targetDeveloperName');
      dataSpace(raw.targetDataSpace, 'targetDataSpace');
      const key = `${raw.sourceDeveloperName}\0${raw.sourceDataSpace}`;
      if (mapped.has(key)) throw new TypeError('Duplicate Data Graph source mapping');
      mapped.set(key, {
        sourceDeveloperName: raw.sourceDeveloperName,
        sourceDataSpace: raw.sourceDataSpace,
        targetDeveloperName: raw.targetDeveloperName,
        targetDataSpace: raw.targetDataSpace,
        resolution:
          raw.sourceDeveloperName === raw.targetDeveloperName &&
          raw.sourceDataSpace === raw.targetDataSpace
            ? 'preserved'
            : 'explicit-map',
        validationStatus: 'pending',
      });
    }
    for (const prerequisite of sourcePrerequisites) {
      if (!mapped.has(`${prerequisite.developerName}\0${prerequisite.dataSpace}`)) {
        throw new TypeError(
          `Missing exact Data Graph mapping for ${prerequisite.developerName}/${prerequisite.dataSpace}`,
        );
      }
    }
    const providers = (item.contentBody['lightning:dataProviders'] as unknown[]).map((value) => {
      const identity = provider(value, 'Data Graph provider');
      const target = mapped.get(`${identity.developerName}\0${identity.dataSpace}`)!;
      return {
        ...(value as JsonRecord),
        attributes: {
          dataGraphApiName: target.targetDeveloperName,
          dataspace: target.targetDataSpace,
        },
      };
    });
    selected.add(sourceApiName);
    targetKeys.add(contentKey);
    targetNames.add(apiName);
    dataGraphs.push(...mapped.values());
    items.push({
      ...item,
      apiName,
      contentKey,
      contentBody: { ...item.contentBody, 'lightning:dataProviders': providers },
    });
  }

  return {
    items: items.toSorted((left, right) => left.apiName!.localeCompare(right.apiName!)),
    targetContentKeys: [...targetKeys].toSorted(),
    dataGraphs: dataGraphs.toSorted((left, right) =>
      `${left.targetDeveloperName}\0${left.targetDataSpace}`.localeCompare(
        `${right.targetDeveloperName}\0${right.targetDataSpace}`,
      ),
    ),
  };
}

function soqlString(value: string): string {
  return `'${value.replaceAll('\\', '\\\\').replaceAll("'", String.raw`\'`)}'`;
}

/**
 * Prove each exact target Data Graph developer-name/data-space pair exists uniquely.
 * @param {QueryConnection} connection - Destination org query transport.
 * @param {readonly WebFragmentDataGraphPrerequisite[]} prerequisites - Exact target prerequisites.
 * @returns {Promise<void>} Fulfilled only when every prerequisite resolves exactly once.
 */
export async function validateDataGraphPrerequisites(
  connection: QueryConnection,
  prerequisites: readonly WebFragmentDataGraphPrerequisite[],
): Promise<void> {
  if (connection.query === undefined) {
    throw new TypeError('Destination Data Graph prerequisites cannot be queried');
  }
  const unique = new Map(
    prerequisites.map((value) => [`${value.targetDeveloperName}\0${value.targetDataSpace}`, value]),
  );
  for (const prerequisite of unique.values()) {
    const result = await connection.query<{ DeveloperName?: string; DataSpaceDevName?: string }>(
      `SELECT DeveloperName, DataSpaceDevName FROM DataGraph WHERE DeveloperName = ${soqlString(prerequisite.targetDeveloperName)} AND DataSpaceDevName = ${soqlString(prerequisite.targetDataSpace)}`,
    );
    const matches = result.records.filter(
      (record) =>
        record.DeveloperName === prerequisite.targetDeveloperName &&
        record.DataSpaceDevName === prerequisite.targetDataSpace,
    );
    if (result.totalSize !== 1 || result.records.length !== 1 || matches.length !== 1) {
      prerequisite.validationStatus = 'failed';
      throw new TypeError(
        `Data Graph prerequisite must resolve exactly once: ${prerequisite.targetDeveloperName}/${prerequisite.targetDataSpace}`,
      );
    }
    prerequisite.validationStatus = 'passed';
  }
}
