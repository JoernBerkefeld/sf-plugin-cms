import type { Connection } from '@salesforce/core';
import type { JsonRequestOptions } from '../transport/json-request.js';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { LandingPageTemplatePair } from '../contracts/workspace-export.js';
import { lookupExactCmsVariants } from './cms-prerequisite-lookup.js';
import { requiredContentIdentifier, requiredVariantIdentifier } from './variant-identity.js';
import type { LoadedWorkspaceExport, WorkspaceImportItem } from './import-workspace.js';
import {
  assertLandingPageTemplateItem,
  planLandingPageTemplateCopiesForType,
  validateLandingPageTemplatePrerequisites,
  type LandingPageTemplateCmsPrerequisite,
  type PlannedLandingPageTemplateCopies,
} from './landing-page-template.js';

const LANDING_PAGE_TYPE = 'sfdc_cms__landingPage';
const TEMPLATE_TYPE = 'sfdc_cms__landingPageTemplate';

type RequestConnection = Pick<Connection, 'request'> &
  Partial<Pick<Connection, 'version'>> & {
    readonly query?: Connection['query'];
  };

export type LandingPageImagePrerequisite = LandingPageTemplateCmsPrerequisite & {
  readonly sourceType: 'image';
  readonly targetContentType: 'sfdc_cms__image';
};

export type LandingPageResolvedTemplateIdentity = {
  readonly apiName: string;
  readonly contentKey: string;
  readonly contentId: string;
  readonly variantId: string;
  readonly title: string;
  readonly contentType: typeof TEMPLATE_TYPE;
  readonly workspaceId: string;
  readonly status: 'Draft';
  readonly isPublished: false;
  readonly bodySha256: string;
};

export type LandingPageTemplateDependency = {
  readonly source: LandingPageTemplatePair['template'];
  readonly targetContentKey?: string;
  readonly targetApiName?: string;
  readonly targetTitle?: string;
  resolution: 'content-key' | 'api-name' | 'title-fallback' | 'pending';
  target?: LandingPageResolvedTemplateIdentity;
  validationStatus: 'failed' | 'passed' | 'pending';
};

export type LandingPageCompatibilityPlan = {
  readonly pageVariantId: string;
  readonly sourceTemplateVariantId: string;
  readonly relationshipReferenceId: string;
  readonly relationshipDescriptorSha256: string;
  readonly normalizationVersion: 'landing-page-template-compatibility-v1';
  readonly normalizedPageBodySha256: string;
  readonly normalizedTemplateBodySha256: string;
  status: 'failed' | 'passed' | 'pending';
};

export type PlannedLandingPageCopies = Omit<
  PlannedLandingPageTemplateCopies,
  'cmsPrerequisites'
> & {
  readonly cmsPrerequisites: LandingPageImagePrerequisite[];
  readonly compatibility: LandingPageCompatibilityPlan[];
  readonly templateDependencies: LandingPageTemplateDependency[];
};

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sha256(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function exactKeys(
  value: Record<string, unknown>,
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

/**
 * Validate the exact captured landing-page authoring shape.
 * @param {WorkspaceImportItem} item - Captured workspace item to validate.
 * @returns {object} Extracted image and Data Graph prerequisites.
 */
export function assertLandingPageItem(item: WorkspaceImportItem): {
  cmsContentKeys: readonly string[];
  dataGraphs: readonly { developerName: string; dataSpace: string }[];
} {
  if (item.contentType !== LANDING_PAGE_TYPE) {
    throw new TypeError(`Landing-page profile requires exact content type ${LANDING_PAGE_TYPE}`);
  }
  const inspect = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const child of value) inspect(child);
      return;
    }
    if (!record(value)) return;
    if (
      record(value.source) &&
      value.source.type === 'imageReference' &&
      (!record(value.source.ref) ||
        Object.keys(value.source.ref).length !== 1 ||
        typeof value.source.ref.contentKey !== 'string' ||
        typeof value.url !== 'string' ||
        !value.url.startsWith(`/cms/media/${value.source.ref.contentKey}`))
    ) {
      throw new TypeError('Landing-page image URL must match its exact image content key');
    }
    for (const child of Object.values(value)) inspect(child);
  };
  inspect(item.contentBody);
  return assertLandingPageTemplateItem({ ...item, contentType: TEMPLATE_TYPE });
}

function pairForPage(
  source: LoadedWorkspaceExport,
  item: WorkspaceImportItem,
  sourceApiName: string,
): { pair: LandingPageTemplatePair; relationshipReferenceId: string } {
  const pairs = source.manifest.landingPageTemplatePairs ?? [];
  const matches = pairs.filter(
    ({ page }) =>
      page.apiName === sourceApiName &&
      page.apiName === item.apiName &&
      page.contentKey === item.contentKey &&
      page.variantId === item.id,
  );
  if (matches.length !== 1) {
    throw new TypeError(
      `Landing-page source must bind exactly one manifest template pair: ${sourceApiName}`,
    );
  }
  const relationships = source.manifest.externalReferences.filter(
    (reference) =>
      reference.kind === 'cms.relationship' &&
      reference.source.sourceId === item.id &&
      reference.resolution === 'unsupported',
  );
  if (relationships.length === 0) {
    throw new TypeError(
      `Landing-page source must retain its bound unsupported relationship: ${sourceApiName}`,
    );
  }
  return { pair: matches[0], relationshipReferenceId: relationships[0].referenceId };
}

function parseTemplateDependency(
  value: unknown,
  pair: LandingPageTemplatePair,
  label: string,
): LandingPageTemplateDependency {
  if (!record(value)) throw new TypeError(`${label} must be an object`);
  exactKeys(value, ['source'], ['targetContentKey', 'targetApiName', 'targetTitle'], label);
  if (!record(value.source)) throw new TypeError(`${label}.source must be an object`);
  exactKeys(value.source, ['requestedTitle', 'apiName', 'contentKey'], [], `${label}.source`);
  for (const key of ['requestedTitle', 'apiName', 'contentKey'] as const) {
    if (typeof value.source[key] !== 'string' || value.source[key].length === 0) {
      throw new TypeError(`${label}.source.${key} must be a nonempty string`);
    }
  }
  if (
    value.source.requestedTitle !== pair.template.requestedTitle ||
    value.source.apiName !== pair.template.apiName ||
    value.source.contentKey !== pair.template.contentKey
  ) {
    throw new TypeError(`${label}.source disagrees with manifest landingPageTemplatePairs`);
  }
  const contentKey = value.targetContentKey;
  const apiName = value.targetApiName;
  const title = value.targetTitle;
  if ((contentKey === undefined) === (apiName === undefined)) {
    throw new TypeError(`${label} must select target by exactly one of content key or API name`);
  }
  if (contentKey !== undefined) {
    if (typeof contentKey !== 'string' || contentKey.length === 0)
      throw new TypeError(`${label}.targetContentKey must be a nonempty string`);
    if (title !== undefined)
      throw new TypeError(`${label}.targetTitle is not allowed with targetContentKey`);
  }
  if (
    apiName !== undefined &&
    (typeof apiName !== 'string' || !/^[A-Za-z][A-Za-z\d_]*$/u.test(apiName))
  ) {
    throw new TypeError(`${label}.targetApiName must be an exact developer/API name`);
  }
  if (title !== undefined && (typeof title !== 'string' || title.trim().length === 0)) {
    throw new TypeError(`${label}.targetTitle must be a nonempty string`);
  }
  return {
    source: pair.template,
    ...(contentKey === undefined ? {} : { targetContentKey: contentKey }),
    ...(apiName === undefined ? {} : { targetApiName: apiName }),
    ...(title === undefined ? {} : { targetTitle: title }),
    resolution: 'pending',
    validationStatus: 'pending',
  };
}

function compatibilityBody(item: WorkspaceImportItem): Record<string, unknown> {
  const normalize = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map((child) => normalize(child));
    if (!record(value)) return value;
    const next = Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, normalize(child)]),
    );
    if (
      next.type === 'imageReference' &&
      record(next.ref) &&
      typeof next.ref.contentKey === 'string'
    ) {
      next.ref = { ...next.ref, contentKey: '<image-content-key>' };
    }
    if (typeof next.url === 'string' && next.url.startsWith('/cms/media/')) {
      next.url = '/cms/media/<image-content-key>';
    }
    if (next.definition === 'sfdc_cms__dataGraphDataProvider' && record(next.attributes)) {
      next.attributes = {
        ...next.attributes,
        dataGraphApiName: '<data-graph-api-name>',
        dataspace: '<data-space>',
      };
    }
    return next;
  };
  const body = normalize(item.contentBody) as Record<string, unknown>;
  delete body['sfdc_cms:title'];
  delete body['sfdc_cms:urlName'];
  return body;
}

function assertSourcePairCompatibility(
  pageItem: WorkspaceImportItem,
  templateItem: WorkspaceImportItem,
): void {
  assertLandingPageItem(pageItem);
  assertLandingPageTemplateItem(templateItem);
  if (!isDeepStrictEqual(compatibilityBody(pageItem), compatibilityBody(templateItem))) {
    throw new TypeError('Landing page and bound source template differ outside title/urlName');
  }
}

function rows(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value) || value.length === 0 || value.some((row) => !record(row))) {
    throw new TypeError('Landing-page mappings must be a nonempty array of objects');
  }
  return value as Record<string, unknown>[];
}

/**
 * Plan exact type-qualified landing-page creates using only evidenced image references.
 * @param {LoadedWorkspaceExport} source - Verified source workspace package.
 * @param {unknown} input - User-supplied landing-page mapping JSON.
 * @returns {PlannedLandingPageCopies} Validated create proposal.
 */
export function planLandingPageCopies(
  source: LoadedWorkspaceExport,
  input: unknown,
): PlannedLandingPageCopies {
  const transformedRows = rows(input).map((row, index) => {
    exactKeys(
      row,
      ['source', 'target', 'templateDependency', 'imageDependencies', 'dataGraphs'],
      [],
      `Landing-page mapping ${index}`,
    );
    if (!record(row.source)) {
      throw new TypeError(`Landing-page mapping ${index}.source must be an object`);
    }
    exactKeys(
      row.source,
      ['family', 'type', 'apiName'],
      [],
      `Landing-page mapping ${index}.source`,
    );
    if (row.source.family !== 'cms' || row.source.type !== 'landingPage') {
      throw new TypeError(`Landing-page mapping ${index}.source must select cms/landingPage`);
    }
    const sourceApiName = row.source.apiName;
    if (typeof sourceApiName !== 'string') {
      throw new TypeError(`Landing-page mapping ${index}.source.apiName must be a string`);
    }
    const sourceMatches = source.items.filter(
      (item) => item.contentType === LANDING_PAGE_TYPE && item.apiName === sourceApiName,
    );
    if (sourceMatches.length !== 1) {
      throw new TypeError(
        `Typed source API name must match exactly one landing page: ${sourceApiName}`,
      );
    }
    const { pair, relationshipReferenceId } = pairForPage(source, sourceMatches[0], sourceApiName);
    const sourceTemplateMatches = source.items.filter(
      (item) =>
        item.contentType === TEMPLATE_TYPE &&
        item.id === pair.template.variantId &&
        item.apiName === pair.template.apiName &&
        item.contentKey === pair.template.contentKey &&
        item.title === pair.template.requestedTitle,
    );
    if (sourceTemplateMatches.length !== 1) {
      throw new TypeError('Bound source landing-page template identity is absent or inconsistent');
    }
    assertSourcePairCompatibility(sourceMatches[0], sourceTemplateMatches[0]);
    const normalizedPageBody = compatibilityBody(sourceMatches[0]);
    const normalizedTemplateBody = compatibilityBody(sourceTemplateMatches[0]);
    const relationship = source.manifest.externalReferences.find(
      ({ referenceId }) => referenceId === relationshipReferenceId,
    )!;
    const templateDependency = parseTemplateDependency(
      row.templateDependency,
      pair,
      `Landing-page mapping ${index}.templateDependency`,
    );
    if (!Array.isArray(row.imageDependencies)) {
      throw new TypeError(`Landing-page mapping ${index}.imageDependencies must be an array`);
    }
    const cmsDependencies = row.imageDependencies.map((dependency, dependencyIndex) => {
      if (!record(dependency)) {
        throw new TypeError(`Landing-page image dependency ${dependencyIndex} must be an object`);
      }
      exactKeys(
        dependency,
        ['sourceContentKey', 'targetApiName'],
        ['targetTitle'],
        `Landing-page image dependency ${dependencyIndex}`,
      );
      return { ...dependency, sourceType: 'image' };
    });
    return {
      source: { ...row.source, type: 'landingPageTemplate' },
      target: row.target,
      cmsDependencies,
      dataGraphs: row.dataGraphs,
      templateDependency,
      compatibility: {
        pageVariantId: sourceMatches[0].id,
        sourceTemplateVariantId: sourceTemplateMatches[0].id,
        relationshipReferenceId,
        relationshipDescriptorSha256: sha256(relationship),
        normalizationVersion: 'landing-page-template-compatibility-v1' as const,
        normalizedPageBodySha256: sha256(normalizedPageBody),
        normalizedTemplateBodySha256: sha256(normalizedTemplateBody),
        status: 'passed' as const,
      },
    };
  });
  const transformedSource: LoadedWorkspaceExport = {
    ...source,
    items: source.items.map((item) =>
      item.contentType === LANDING_PAGE_TYPE ? { ...item, contentType: TEMPLATE_TYPE } : item,
    ),
  };
  const targetContentKeys = new Set<string>();
  const targetApiNames = new Set<string>();
  for (const { templateDependency } of transformedRows) {
    if (templateDependency.targetContentKey !== undefined) {
      if (targetContentKeys.has(templateDependency.targetContentKey)) {
        throw new TypeError('Duplicate landing-page target template content key');
      }
      targetContentKeys.add(templateDependency.targetContentKey);
    } else if (templateDependency.targetApiName !== undefined) {
      if (targetApiNames.has(templateDependency.targetApiName)) {
        throw new TypeError('Duplicate landing-page target template API name');
      }
      targetApiNames.add(templateDependency.targetApiName);
    }
  }
  const planned = planLandingPageTemplateCopiesForType(
    transformedSource,
    transformedRows.map((row) => ({
      source: row.source,
      target: row.target,
      cmsDependencies: row.cmsDependencies,
      dataGraphs: row.dataGraphs,
    })),
    LANDING_PAGE_TYPE,
    'Landing-page mapping',
  );
  const items = planned.items.map((item) => ({ ...item, contentType: LANDING_PAGE_TYPE }));
  for (const item of items) assertLandingPageItem(item);
  return {
    ...planned,
    items,
    cmsPrerequisites: planned.cmsPrerequisites as LandingPageImagePrerequisite[],
    compatibility: transformedRows.map(({ compatibility }) => compatibility),
    templateDependencies: transformedRows.map(({ templateDependency }) => templateDependency),
  };
}

function resolvedTemplateIdentity(
  value: Record<string, unknown>,
): LandingPageResolvedTemplateIdentity {
  const contentType = record(value.contentType)
    ? value.contentType.fullyQualifiedName
    : value.contentType;
  if (
    contentType !== TEMPLATE_TYPE ||
    !record(value.contentSpace) ||
    typeof value.contentSpace.id !== 'string' ||
    !record(value.status) ||
    value.status.status !== 'Draft' ||
    value.isPublished !== false ||
    typeof value.apiName !== 'string' ||
    typeof value.contentKey !== 'string' ||
    typeof value.title !== 'string' ||
    !record(value.contentBody)
  ) {
    throw new TypeError('Landing-page target template has incoherent type, identity, or lifecycle');
  }
  const variantId = requiredVariantIdentifier(value, 'Landing-page target template');
  const contentId = requiredContentIdentifier(value, 'Landing-page target template parent');
  if (contentId === variantId) {
    throw new TypeError('Landing-page target template content/variant IDs are incoherent');
  }
  return {
    apiName: value.apiName,
    contentKey: value.contentKey,
    contentId,
    variantId,
    title: value.title,
    contentType: TEMPLATE_TYPE,
    workspaceId: (value.contentSpace as Record<string, unknown>).id as string,
    status: 'Draft',
    isPublished: false,
    bodySha256: sha256(value.contentBody),
  };
}

/**
 * Resolve exact destination landing-page templates without mutating page bodies.
 * @param {RequestConnection} connection - Destination org connection.
 * @param {string} workspaceId - Exact destination workspace ID.
 * @param {PlannedLandingPageCopies} proposal - Landing-page dependency plan.
 * @param {JsonRequestOptions} options - Optional request metadata and signal.
 * @returns {Promise<void>} Resolves after every target template is proven.
 */
export async function resolveLandingPageTemplateDependencies(
  connection: RequestConnection,
  workspaceId: string,
  proposal: PlannedLandingPageCopies,
  options: JsonRequestOptions = {},
): Promise<void> {
  for (const dependency of proposal.templateDependencies) {
    try {
      let matches: Record<string, unknown>[];
      if (dependency.targetContentKey === undefined) {
        matches = await lookupExactCmsVariants(
          connection,
          workspaceId,
          TEMPLATE_TYPE,
          dependency.targetApiName!,
          (detail) => detail.apiName === dependency.targetApiName,
          options,
        );
        if (matches.length === 0 && dependency.targetTitle !== undefined) {
          matches = await lookupExactCmsVariants(
            connection,
            workspaceId,
            TEMPLATE_TYPE,
            dependency.targetTitle,
            (detail) => detail.title === dependency.targetTitle,
            options,
          );
          dependency.resolution = 'title-fallback';
        } else {
          dependency.resolution = 'api-name';
        }
      } else {
        matches = await lookupExactCmsVariants(
          connection,
          workspaceId,
          TEMPLATE_TYPE,
          dependency.targetContentKey,
          (detail) => detail.contentKey === dependency.targetContentKey,
          options,
        );
        dependency.resolution = 'content-key';
      }
      if (matches.length !== 1) {
        throw new TypeError('Landing-page target template selector must resolve exactly once');
      }
      const target = resolvedTemplateIdentity(matches[0]);
      const targetSpace = matches[0].contentSpace;
      if (!record(targetSpace) || targetSpace.id !== workspaceId) {
        throw new TypeError('Landing-page target template belongs to another workspace');
      }
      dependency.target = target;
      dependency.validationStatus = 'passed';
    } catch (error) {
      dependency.validationStatus = 'failed';
      throw error;
    }
  }
}

/**
 * Resolve exact typed images, validate Data Graph identities, and rewrite evidenced references.
 * @param {RequestConnection} connection - Destination org connection.
 * @param {string} workspaceId - Exact destination workspace ID.
 * @param {PlannedLandingPageCopies} proposal - Landing-page proposal to validate.
 * @param {JsonRequestOptions} options - Optional request metadata and signal.
 * @returns {Promise<void>} Resolves after every prerequisite is validated and rewritten.
 */
export async function validateLandingPagePrerequisites(
  connection: RequestConnection,
  workspaceId: string,
  proposal: PlannedLandingPageCopies,
  options: JsonRequestOptions = {},
): Promise<void> {
  const templateProposal: PlannedLandingPageTemplateCopies = {
    ...proposal,
    items: proposal.items.map((item) => ({ ...item, contentType: TEMPLATE_TYPE })),
  };
  await validateLandingPageTemplatePrerequisites(
    connection,
    workspaceId,
    templateProposal,
    options,
  );
  for (const [index, item] of templateProposal.items.entries()) {
    (proposal.items as WorkspaceImportItem[])[index] = { ...item, contentType: LANDING_PAGE_TYPE };
  }
}
