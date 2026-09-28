import type { Connection } from '@salesforce/core';
import type { JsonRequestOptions } from '../transport/json-request.js';
import type { LoadedWorkspaceExport, WorkspaceImportItem } from './import-workspace.js';
import {
  assertLandingPageTemplateItem,
  planLandingPageTemplateCopies,
  validateLandingPageTemplatePrerequisites,
  type LandingPageTemplateCmsPrerequisite,
  type PlannedLandingPageTemplateCopies,
} from './landing-page-template.js';

const LANDING_PAGE_TYPE = 'sfdc_cms__landingPage';
const TEMPLATE_TYPE = 'sfdc_cms__landingPageTemplate';

type RequestConnection = Pick<Connection, 'request'> & {
  readonly query?: Connection['query'];
};

export type LandingPageImagePrerequisite = LandingPageTemplateCmsPrerequisite & {
  readonly sourceType: 'image';
  readonly targetContentType: 'sfdc_cms__image';
};

export type PlannedLandingPageCopies = Omit<
  PlannedLandingPageTemplateCopies,
  'cmsPrerequisites'
> & {
  readonly cmsPrerequisites: LandingPageImagePrerequisite[];
};

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
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
      ['source', 'target', 'imageDependencies', 'dataGraphs'],
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
    };
  });
  const transformedSource: LoadedWorkspaceExport = {
    ...source,
    items: source.items.map((item) =>
      item.contentType === LANDING_PAGE_TYPE ? { ...item, contentType: TEMPLATE_TYPE } : item,
    ),
  };
  const planned = planLandingPageTemplateCopies(transformedSource, transformedRows);
  const items = planned.items.map((item) => ({ ...item, contentType: LANDING_PAGE_TYPE }));
  for (const item of items) assertLandingPageItem(item);
  return {
    ...planned,
    items,
    cmsPrerequisites: planned.cmsPrerequisites as LandingPageImagePrerequisite[],
  };
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
