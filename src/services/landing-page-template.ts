import type { Connection } from '@salesforce/core';
import { isDeepStrictEqual } from 'node:util';
import {
  getSelectedOperation,
  requestJson,
  type JsonRequestOptions,
} from '../transport/json-request.js';
import type { LoadedWorkspaceExport, WorkspaceImportItem } from './import-workspace.js';
import type { PlannedImportIdentities } from './import-identities.js';
import { getVariant } from './read.js';
import {
  validateDataGraphPrerequisites,
  type WebFragmentDataGraphPrerequisite,
} from './web-fragment.js';

const TEMPLATE_TYPE = 'sfdc_cms__landingPageTemplate';
const DATA_GRAPH_PROVIDER = 'sfdc_cms__dataGraphDataProvider';
const BODY_KEYS = [
  'lightning:backgroundImage',
  'lightning:brandSource',
  'lightning:dataProviders',
  'lightning:expressions',
  'sfdc_cms:block',
  'sfdc_cms:description',
  'sfdc_cms:seoProperties',
  'sfdc_cms:title',
  'sfdc_cms:variants',
] as const;
const OPTIONAL_BODY_KEYS = ['sfdc_cms:urlName'] as const;
const CMS_DEPENDENCY_TYPES = new Map([
  ['image', 'sfdc_cms__image'],
  ['webFragment', 'sfdc_cms__webFragment'],
]);
const PAGE_SIZE = 250;
const PAGE_CAP = 1000;

type JsonRecord = Record<string, unknown>;
type RequestConnection = Pick<Connection, 'request'>;
type QueryConnection = { readonly query?: Connection['query'] };

export type LandingPageTemplateCmsPrerequisite = {
  readonly sourceContentKey: string;
  readonly sourceType: 'image' | 'webFragment';
  readonly targetApiName: string;
  readonly targetTitle?: string;
  readonly targetContentType: string;
  resolution: 'api-name' | 'title-fallback' | 'pending';
  targetContentKey?: string;
  validationStatus: 'failed' | 'passed' | 'pending';
};

export type PlannedLandingPageTemplateCopies = PlannedImportIdentities & {
  readonly cmsPrerequisites: LandingPageTemplateCmsPrerequisite[];
  readonly dataGraphs: WebFragmentDataGraphPrerequisite[];
};

function record(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
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

function exactKeys(
  value: JsonRecord,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): void {
  const keys = Object.keys(value);
  if (
    required.some((key) => !keys.includes(key)) ||
    keys.some((key) => !required.includes(key) && !optional.includes(key))
  ) {
    throw new TypeError(`${label} contains unsupported or missing fields`);
  }
}

function dataGraphProvider(
  value: unknown,
  label: string,
): { developerName: string; dataSpace: string } {
  if (!record(value)) throw new TypeError(`${label} must be an object`);
  if (
    Object.keys(value).toSorted().join('\0') !==
      ['attributes', 'definition', 'sfdcExpressionKey'].toSorted().join('\0') ||
    value.definition !== DATA_GRAPH_PROVIDER ||
    value.sfdcExpressionKey !== '$dataGraph' ||
    !record(value.attributes)
  ) {
    throw new TypeError(`${label} must use the exact Data Graph provider shape`);
  }
  if (
    Object.keys(value.attributes).toSorted().join('\0') !==
    ['dataGraphApiName', 'dataspace'].toSorted().join('\0')
  ) {
    throw new TypeError(`${label}.attributes is unsupported`);
  }
  identifier(value.attributes.dataGraphApiName, `${label}.attributes.dataGraphApiName`);
  identifier(value.attributes.dataspace, `${label}.attributes.dataspace`);
  return {
    developerName: value.attributes.dataGraphApiName,
    dataSpace: value.attributes.dataspace,
  };
}

function collectCmsReferences(value: unknown, references: Set<string>): void {
  if (Array.isArray(value)) {
    for (const child of value) collectCmsReferences(child, references);
    return;
  }
  if (!record(value)) return;
  if ('ref' in value || (typeof value.type === 'string' && value.type.endsWith('Reference'))) {
    if (
      value.type !== 'imageReference' ||
      !record(value.ref) ||
      Object.keys(value.ref).length !== 1 ||
      typeof value.ref.contentKey !== 'string' ||
      value.ref.contentKey.length === 0
    ) {
      throw new TypeError('Landing-page template contains an unsupported CMS dependency shape');
    }
    references.add(value.ref.contentKey);
  }
  for (const child of Object.values(value)) collectCmsReferences(child, references);
}

/**
 * Validate the captured landing-page-template authoring shape.
 * @param {WorkspaceImportItem} item - Captured workspace item to validate.
 * @returns {object} Extracted prerequisite identities.
 */
export function assertLandingPageTemplateItem(item: WorkspaceImportItem): {
  cmsContentKeys: readonly string[];
  dataGraphs: readonly { developerName: string; dataSpace: string }[];
} {
  if (item.contentType !== TEMPLATE_TYPE) {
    throw new TypeError(
      `Landing-page-template profile requires exact content type ${TEMPLATE_TYPE}`,
    );
  }
  identifier(item.apiName, 'Landing-page template apiName');
  nonempty(item.title, 'Landing-page template title');
  exactKeys(
    item.contentBody as JsonRecord,
    BODY_KEYS,
    OPTIONAL_BODY_KEYS,
    'Landing-page template body',
  );
  if (item.contentBody['sfdc_cms:title'] !== item.title) {
    throw new TypeError('Landing-page template body title must match the top-level title');
  }
  if (
    item.contentBody['sfdc_cms:urlName'] !== undefined &&
    item.contentBody['sfdc_cms:urlName'] !== item.urlName
  ) {
    throw new TypeError('Landing-page template body URL name must match the top-level URL name');
  }
  if (
    !isDeepStrictEqual(item.contentBody['lightning:brandSource'], {
      defaultBrandOption: 'sfdcBrand',
    })
  ) {
    throw new TypeError('Landing-page template brand source is unsupported');
  }
  for (const key of ['lightning:expressions', 'sfdc_cms:variants'] as const) {
    if (!Array.isArray(item.contentBody[key])) throw new TypeError(`${key} must be an array`);
  }
  if (!record(item.contentBody['sfdc_cms:block'])) {
    throw new TypeError('Landing-page template root block must be an object');
  }
  const providers = item.contentBody['lightning:dataProviders'];
  if (!Array.isArray(providers))
    throw new TypeError('Landing-page template data providers must be an array');
  const dataGraphs = providers.map((value, index) =>
    dataGraphProvider(value, `Data Graph provider ${index}`),
  );
  if (
    new Set(dataGraphs.map((value) => `${value.developerName}\0${value.dataSpace}`)).size !==
    dataGraphs.length
  ) {
    throw new TypeError('Landing-page template Data Graph providers must be unique');
  }
  const references = new Set<string>();
  collectCmsReferences(item.contentBody, references);
  return { cmsContentKeys: [...references].toSorted(), dataGraphs };
}

function rows(value: unknown): JsonRecord[] {
  if (!Array.isArray(value) || value.length === 0 || value.some((row) => !record(row))) {
    throw new TypeError('Landing-page template mappings must be a nonempty array of objects');
  }
  return value as JsonRecord[];
}

/**
 * Plan exact type-qualified template creates and their explicit prerequisites.
 * @param {LoadedWorkspaceExport} source - Verified source workspace package.
 * @param {unknown} input - User-supplied template mapping JSON.
 * @returns {PlannedLandingPageTemplateCopies} Validated create proposal.
 */
export function planLandingPageTemplateCopies(
  source: LoadedWorkspaceExport,
  input: unknown,
): PlannedLandingPageTemplateCopies {
  if (!source.integrity.verified) throw new TypeError('Source integrity must be verified first');
  const sourceKeys = new Set(source.items.map((item) => item.contentKey));
  const sourceNames = new Set(
    source.items.flatMap((item) => (item.apiName === undefined ? [] : [item.apiName])),
  );
  const targetKeys = new Set<string>();
  const targetNames = new Set<string>();
  const selected = new Set<string>();
  const items: WorkspaceImportItem[] = [];
  const cmsPrerequisites: LandingPageTemplateCmsPrerequisite[] = [];
  const dataGraphs: WebFragmentDataGraphPrerequisite[] = [];

  for (const [index, row] of rows(input).entries()) {
    exactKeys(
      row,
      ['source', 'target', 'cmsDependencies', 'dataGraphs'],
      [],
      `Template mapping ${index}`,
    );
    if (!record(row.source))
      throw new TypeError(`Template mapping ${index}.source must be an object`);
    exactKeys(row.source, ['family', 'type', 'apiName'], [], `Template mapping ${index}.source`);
    if (row.source.family !== 'cms' || row.source.type !== 'landingPageTemplate') {
      throw new TypeError(`Template mapping ${index}.source must select cms/landingPageTemplate`);
    }
    identifier(row.source.apiName, `Template mapping ${index}.source.apiName`);
    const sourceApiName = row.source.apiName;
    if (selected.has(sourceApiName))
      throw new TypeError(`Duplicate template selection: ${sourceApiName}`);
    const matches = source.items.filter(
      (item) => item.contentType === TEMPLATE_TYPE && item.apiName === sourceApiName,
    );
    if (matches.length !== 1) {
      throw new TypeError(
        `Typed source API name must match exactly one landing-page template: ${sourceApiName}`,
      );
    }
    const item = matches[0];
    const prerequisites = assertLandingPageTemplateItem(item);

    if (!record(row.target))
      throw new TypeError(`Template mapping ${index}.target must be an object`);
    exactKeys(row.target, ['contentKey', 'apiName'], [], `Template mapping ${index}.target`);
    identifier(row.target.contentKey, `Template mapping ${index}.target.contentKey`);
    identifier(row.target.apiName, `Template mapping ${index}.target.apiName`);
    if (sourceKeys.has(row.target.contentKey) || targetKeys.has(row.target.contentKey)) {
      throw new TypeError('Target template content keys must be fresh and unique');
    }
    if (sourceNames.has(row.target.apiName) || targetNames.has(row.target.apiName)) {
      throw new TypeError('Target template API names must be fresh and unique');
    }

    if (
      !Array.isArray(row.cmsDependencies) ||
      row.cmsDependencies.length !== prerequisites.cmsContentKeys.length
    ) {
      throw new TypeError('Each CMS content prerequisite requires exactly one mapping row');
    }
    const dependencyMap = new Map<string, LandingPageTemplateCmsPrerequisite>();
    for (const [dependencyIndex, raw] of row.cmsDependencies.entries()) {
      if (!record(raw))
        throw new TypeError(`Template dependency ${dependencyIndex} must be an object`);
      exactKeys(
        raw,
        ['sourceContentKey', 'sourceType', 'targetApiName'],
        ['targetTitle'],
        `Template dependency ${dependencyIndex}`,
      );
      nonempty(raw.sourceContentKey, 'sourceContentKey');
      identifier(raw.targetApiName, 'targetApiName');
      if (raw.targetTitle !== undefined) nonempty(raw.targetTitle, 'targetTitle');
      const targetContentType = CMS_DEPENDENCY_TYPES.get(String(raw.sourceType));
      if (targetContentType === undefined)
        throw new TypeError('Template CMS dependency type is unsupported');
      if (dependencyMap.has(raw.sourceContentKey))
        throw new TypeError('Duplicate template CMS dependency mapping');
      dependencyMap.set(raw.sourceContentKey, {
        sourceContentKey: raw.sourceContentKey,
        sourceType: raw.sourceType as 'image' | 'webFragment',
        targetApiName: raw.targetApiName,
        ...(raw.targetTitle === undefined ? {} : { targetTitle: raw.targetTitle }),
        targetContentType,
        resolution: 'pending',
        validationStatus: 'pending',
      });
    }
    for (const contentKey of prerequisites.cmsContentKeys) {
      if (!dependencyMap.has(contentKey))
        throw new TypeError(`Missing exact CMS dependency mapping for ${contentKey}`);
    }

    if (
      !Array.isArray(row.dataGraphs) ||
      row.dataGraphs.length !== prerequisites.dataGraphs.length
    ) {
      throw new TypeError('Each Data Graph prerequisite requires exactly one mapping row');
    }
    const graphMap = new Map<string, WebFragmentDataGraphPrerequisite>();
    for (const raw of row.dataGraphs) {
      if (!record(raw)) throw new TypeError('Template Data Graph mapping must be an object');
      exactKeys(
        raw,
        ['sourceDeveloperName', 'sourceDataSpace', 'targetDeveloperName', 'targetDataSpace'],
        [],
        'Template Data Graph mapping',
      );
      for (const key of [
        'sourceDeveloperName',
        'sourceDataSpace',
        'targetDeveloperName',
        'targetDataSpace',
      ] as const)
        identifier(raw[key], key);
      const sourceDeveloperName = raw.sourceDeveloperName as string;
      const sourceDataSpace = raw.sourceDataSpace as string;
      const targetDeveloperName = raw.targetDeveloperName as string;
      const targetDataSpace = raw.targetDataSpace as string;
      const key = `${sourceDeveloperName}\0${sourceDataSpace}`;
      if (graphMap.has(key)) throw new TypeError('Duplicate template Data Graph source mapping');
      graphMap.set(key, {
        sourceDeveloperName,
        sourceDataSpace,
        targetDeveloperName,
        targetDataSpace,
        resolution:
          sourceDeveloperName === targetDeveloperName && sourceDataSpace === targetDataSpace
            ? 'preserved'
            : 'explicit-map',
        validationStatus: 'pending',
      });
    }
    for (const prerequisite of prerequisites.dataGraphs) {
      if (!graphMap.has(`${prerequisite.developerName}\0${prerequisite.dataSpace}`)) {
        throw new TypeError(
          `Missing exact Data Graph mapping for ${prerequisite.developerName}/${prerequisite.dataSpace}`,
        );
      }
    }

    const providers = (item.contentBody['lightning:dataProviders'] as unknown[]).map((value) => {
      const identity = dataGraphProvider(value, 'Data Graph provider');
      const target = graphMap.get(`${identity.developerName}\0${identity.dataSpace}`)!;
      return {
        ...(value as JsonRecord),
        attributes: {
          dataGraphApiName: target.targetDeveloperName,
          dataspace: target.targetDataSpace,
        },
      };
    });
    selected.add(sourceApiName);
    targetKeys.add(row.target.contentKey);
    targetNames.add(row.target.apiName);
    cmsPrerequisites.push(...dependencyMap.values());
    dataGraphs.push(...graphMap.values());
    items.push({
      ...item,
      apiName: row.target.apiName,
      contentKey: row.target.contentKey,
      contentBody: { ...item.contentBody, 'lightning:dataProviders': providers },
    });
  }

  return {
    items: items.toSorted((left, right) => left.apiName!.localeCompare(right.apiName!)),
    targetContentKeys: [...targetKeys].toSorted(),
    cmsPrerequisites,
    dataGraphs,
  };
}

function responseItems(value: unknown): unknown[] {
  if (!record(value) || !Array.isArray(value.items))
    throw new TypeError('CMS prerequisite search must return items');
  return value.items;
}

function responseCount(value: unknown): number {
  if (record(value)) {
    for (const key of ['total', 'totalCount', 'count']) {
      if (typeof value[key] === 'number' && Number.isInteger(value[key]) && value[key] >= 0)
        return value[key];
    }
  }
  throw new TypeError('CMS prerequisite search must return a count');
}

async function exactMatches(
  connection: RequestConnection,
  workspaceId: string,
  contentType: string,
  queryTerm: string,
  predicate: (detail: JsonRecord) => boolean,
  options: JsonRequestOptions,
): Promise<JsonRecord[]> {
  const candidates = new Map<string, true>();
  let expected: number | undefined;
  for (let page = 0; page < PAGE_CAP; page += 1) {
    const response = await requestJson<unknown>(
      connection,
      getSelectedOperation('workspace.variant.search'),
      {
        query: {
          contentSpaceOrFolderIds: [workspaceId],
          contentTypeFQN: contentType,
          languages: ['All'],
          page,
          pageSize: PAGE_SIZE,
          queryTerm,
        },
      },
      options,
    );
    const items = responseItems(response.data);
    const count = responseCount(response.data);
    if (expected === undefined) expected = count;
    else if (expected !== count) throw new TypeError('CMS prerequisite search count changed');
    for (const item of items) {
      if (
        !record(item) ||
        item.type !== 'ManagedContentVariantSearchResultRepresentation' ||
        typeof item.id !== 'string' ||
        item.managedContentSpaceId !== workspaceId ||
        candidates.has(item.id)
      ) {
        throw new TypeError('CMS prerequisite search returned ambiguous scope evidence');
      }
      candidates.set(item.id, true);
    }
    if (items.length === 0 || candidates.size >= count) break;
    if (page === PAGE_CAP - 1) throw new TypeError('CMS prerequisite search exceeded page cap');
  }
  if (expected === undefined || candidates.size !== expected)
    throw new TypeError('CMS prerequisite search count was not satisfied');
  const matches: JsonRecord[] = [];
  for (const id of candidates.keys()) {
    const detail = await getVariant(connection, id, options);
    const type = record(detail.contentType)
      ? detail.contentType.fullyQualifiedName
      : detail.contentType;
    if (
      !record(detail.contentSpace) ||
      detail.contentSpace.id !== workspaceId ||
      type !== contentType
    ) {
      throw new TypeError('CMS prerequisite detail changed workspace or type scope');
    }
    if (predicate(detail as JsonRecord)) matches.push(detail as JsonRecord);
  }
  return matches;
}

/**
 * Resolve exact typed CMS dependencies, with title fallback only after zero API-name matches.
 * @param {RequestConnection & QueryConnection} connection - Destination org connection.
 * @param {string} workspaceId - Exact destination workspace ID.
 * @param {PlannedLandingPageTemplateCopies} proposal - Template create proposal to validate.
 * @param {JsonRequestOptions} options - Optional request metadata and signal.
 * @returns {Promise<void>} Resolves after every prerequisite is validated and rewritten.
 */
export async function validateLandingPageTemplatePrerequisites(
  connection: RequestConnection & QueryConnection,
  workspaceId: string,
  proposal: PlannedLandingPageTemplateCopies,
  options: JsonRequestOptions = {},
): Promise<void> {
  await validateDataGraphPrerequisites(connection, proposal.dataGraphs);
  const resolved = new Map<string, string>();
  for (const prerequisite of proposal.cmsPrerequisites) {
    try {
      const apiMatches = await exactMatches(
        connection,
        workspaceId,
        prerequisite.targetContentType,
        prerequisite.targetApiName,
        (detail) => detail.apiName === prerequisite.targetApiName,
        options,
      );
      let match: JsonRecord | undefined;
      if (apiMatches.length === 1) {
        match = apiMatches[0];
        prerequisite.resolution = 'api-name';
      } else if (apiMatches.length > 1) {
        throw new TypeError(
          `CMS prerequisite API name is ambiguous: ${prerequisite.targetApiName}`,
        );
      } else {
        if (prerequisite.targetTitle === undefined) {
          throw new TypeError(
            `CMS prerequisite API name was not found and no title fallback was provided: ${prerequisite.targetApiName}`,
          );
        }
        const titleMatches = await exactMatches(
          connection,
          workspaceId,
          prerequisite.targetContentType,
          prerequisite.targetTitle,
          (detail) => detail.title === prerequisite.targetTitle,
          options,
        );
        if (titleMatches.length !== 1) {
          throw new TypeError(
            `CMS prerequisite title fallback must resolve exactly once: ${prerequisite.targetTitle}`,
          );
        }
        match = titleMatches[0];
        prerequisite.resolution = 'title-fallback';
      }
      nonempty(match.contentKey, 'Resolved CMS prerequisite contentKey');
      prerequisite.targetContentKey = match.contentKey;
      prerequisite.validationStatus = 'passed';
      resolved.set(prerequisite.sourceContentKey, match.contentKey);
    } catch (error) {
      prerequisite.validationStatus = 'failed';
      throw error;
    }
  }
  const rewrite = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map((child) => rewrite(child));
    if (!record(value)) return value;
    const next = Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, rewrite(child)]),
    );
    if (record(next.ref) && typeof next.ref.contentKey === 'string') {
      const target = resolved.get(next.ref.contentKey);
      if (target !== undefined) next.ref = { ...next.ref, contentKey: target };
    }
    if (typeof next.url === 'string') {
      let rewrittenUrl = next.url;
      for (const [sourceKey, targetKey] of resolved) {
        rewrittenUrl = rewrittenUrl.replaceAll(sourceKey, targetKey);
      }
      next.url = rewrittenUrl;
    }
    return next;
  };
  for (const [index, item] of proposal.items.entries()) {
    (proposal.items as WorkspaceImportItem[])[index] = {
      ...item,
      contentBody: rewrite(item.contentBody) as WorkspaceImportItem['contentBody'],
    };
  }
}
