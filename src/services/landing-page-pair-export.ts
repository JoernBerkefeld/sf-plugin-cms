import type { CmsRecord } from './read.js';
import { requiredVariantIdentifier } from './variant-identity.js';

export const LANDING_PAGE_TYPE = 'sfdc_cms__landingPage' as const;
export const LANDING_PAGE_TEMPLATE_TYPE = 'sfdc_cms__landingPageTemplate' as const;

export type LandingPagePairSelector = {
  readonly page: { readonly apiName: string };
  readonly template: { readonly title: string; readonly apiName?: string };
};

export type LandingPageTemplatePair = {
  readonly page: {
    readonly apiName: string;
    readonly contentKey: string;
    readonly variantId: string;
  };
  readonly template: {
    readonly requestedTitle: string;
    readonly apiName: string;
    readonly contentKey: string;
    readonly variantId: string;
  };
  readonly compatibility: {
    readonly basis: 'declared-source-pair';
    readonly relationship: 'opaque-structural-match';
  };
};

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonempty(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${label} must be a nonempty string`);
  }
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

export function parseLandingPagePairSelectors(value: unknown): LandingPagePairSelector[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError('Landing-page pair map must contain a nonempty JSON array');
  }
  const pageNames = new Set<string>();
  return value.map((raw, index) => {
    if (!record(raw)) throw new TypeError(`Landing-page pair ${index} must be an object`);
    exactKeys(raw, ['page', 'template'], [], `Landing-page pair ${index}`);
    if (!record(raw.page) || !record(raw.template)) {
      throw new TypeError(`Landing-page pair ${index} selectors must be objects`);
    }
    exactKeys(raw.page, ['apiName'], [], `Landing-page pair ${index}.page`);
    exactKeys(raw.template, ['title'], ['apiName'], `Landing-page pair ${index}.template`);
    nonempty(raw.page.apiName, `Landing-page pair ${index}.page.apiName`);
    nonempty(raw.template.title, `Landing-page pair ${index}.template.title`);
    if (raw.template.apiName !== undefined) {
      nonempty(raw.template.apiName, `Landing-page pair ${index}.template.apiName`);
    }
    if (pageNames.has(raw.page.apiName)) {
      throw new TypeError(`Duplicate landing-page pair selection: ${raw.page.apiName}`);
    }
    pageNames.add(raw.page.apiName);
    return {
      page: { apiName: raw.page.apiName },
      template: {
        title: raw.template.title,
        ...(raw.template.apiName === undefined ? {} : { apiName: raw.template.apiName }),
      },
    };
  });
}

function contentType(record_: Record<string, unknown>): string | undefined {
  return record(record_.contentType)
    ? (record_.contentType.fullyQualifiedName as string | undefined)
    : (record_.contentType as string | undefined);
}

function descriptorType(value: Record<string, unknown>): string | undefined {
  for (const key of ['contentType', 'contentTypeFQN', 'contentTypeFullyQualifiedName'] as const) {
    const candidate = value[key];
    if (candidate === LANDING_PAGE_TEMPLATE_TYPE) return candidate;
    if (record(candidate) && candidate.fullyQualifiedName === LANDING_PAGE_TEMPLATE_TYPE) {
      return LANDING_PAGE_TEMPLATE_TYPE;
    }
  }
  return undefined;
}

function declaredTemplateDescriptors(page: CmsRecord): Record<string, unknown>[] {
  const containers: unknown[] = [];
  if (Array.isArray(page.references)) containers.push(...page.references);
  if (Array.isArray(page.referencesList)) containers.push(...page.referencesList);
  return containers.filter(
    (value): value is Record<string, unknown> =>
      record(value) && descriptorType(value) !== undefined,
  );
}

function canonicalIdentity(
  record_: CmsRecord,
  expectedVariantId: string,
  label: string,
): {
  apiName: string;
  contentKey: string;
  variantId: string;
} {
  nonempty(record_.apiName, `${label}.apiName`);
  nonempty(record_.contentKey, `${label}.contentKey`);
  const variantId = requiredVariantIdentifier(record_, label);
  if (variantId !== expectedVariantId) {
    throw new TypeError(`${label} does not match its search variant ID`);
  }
  return { apiName: record_.apiName, contentKey: record_.contentKey, variantId };
}

export function bindLandingPageTemplatePairs(
  selectors: readonly LandingPagePairSelector[],
  details: ReadonlyMap<string, CmsRecord>,
): LandingPageTemplatePair[] {
  const pages = [...details.entries()].filter(
    ([, value]) => contentType(value) === LANDING_PAGE_TYPE,
  );
  const templates = [...details.entries()].filter(
    ([, value]) => contentType(value) === LANDING_PAGE_TEMPLATE_TYPE,
  );
  return selectors
    .map((selector) => {
      const pageMatches = pages.filter(([, value]) => value.apiName === selector.page.apiName);
      if (pageMatches.length !== 1) {
        throw new TypeError(
          `Exact landing-page API name must resolve once: ${selector.page.apiName}`,
        );
      }
      const titleMatches = templates.filter(([, value]) => value.title === selector.template.title);
      if (titleMatches.length !== 1) {
        throw new TypeError(
          `Exact landing-page-template title must resolve once: ${selector.template.title}`,
        );
      }
      const [templateVariantId, template] = titleMatches[0];
      if (
        selector.template.apiName !== undefined &&
        template.apiName !== selector.template.apiName
      ) {
        throw new TypeError(
          `Resolved landing-page-template API name does not match the independently known selector: ${selector.template.apiName}`,
        );
      }
      const [pageVariantId, page] = pageMatches[0];
      if (declaredTemplateDescriptors(page).length !== 1) {
        throw new TypeError(
          `Landing page ${selector.page.apiName} does not contain exactly one structurally compatible declared template relationship`,
        );
      }
      return {
        page: canonicalIdentity(page, pageVariantId, 'Landing-page pair page'),
        template: {
          requestedTitle: selector.template.title,
          ...canonicalIdentity(template, templateVariantId, 'Landing-page pair template'),
        },
        compatibility: {
          basis: 'declared-source-pair' as const,
          relationship: 'opaque-structural-match' as const,
        },
      };
    })
    .toSorted((left, right) =>
      [left.page.apiName, left.template.requestedTitle, left.template.apiName]
        .join('\0')
        .localeCompare(
          [right.page.apiName, right.template.requestedTitle, right.template.apiName].join('\0'),
        ),
    );
}
