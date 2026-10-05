import {
  assertPortableIdentity,
  assertPortablePayload,
  type JsonValue,
  type PortableIdentity,
} from './capability-registry.js';
import { assertNativeBody } from '../services/import-identities.js';
import type { WorkspaceImportItem } from '../services/import-workspace.js';
import { validBrandBody } from '../services/brand.js';

export const SOURCE_DEFINITION_CONTRACT = 'sf-cms-source-definition' as const;
export const SOURCE_DEFINITION_VERSION = '1.0.0' as const;
export const SOURCE_EMAIL_PROFILES = [
  { contentType: 'sfdc_cms__email', type: 'Email', directory: 'email', token: 'email' },
  {
    contentType: 'sfdc_cms__emailTemplate',
    type: 'Email Template',
    directory: 'emailTemplate',
    token: 'email-template',
  },
] as const;
export const SOURCE_PROFILES = [
  ...SOURCE_EMAIL_PROFILES,
  { contentType: 'sfdc_cms__brand', type: 'Brand', directory: 'brand', token: 'brand' },
] as const;

export type SourceDefinition = {
  contract: typeof SOURCE_DEFINITION_CONTRACT;
  contractVersion: typeof SOURCE_DEFINITION_VERSION;
  identity: PortableIdentity & { family: 'cms'; context: { workspaceApiName: string } };
  contentType: string;
  contentBody: Record<string, JsonValue>;
  language: string;
  title?: string;
  urlName?: string;
  folderPath: string[];
  companions: { rawHtml?: string };
};

export function sourcePathSegment(value: unknown): asserts value is string {
  if (
    typeof value !== 'string' ||
    !/^[A-Za-z0-9_-]+$/u.test(value) ||
    /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/iu.test(value)
  )
    throw new TypeError('Unsafe source path segment');
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function fields(
  value: unknown,
  allowed: string[],
  required = allowed,
): asserts value is Record<string, unknown> {
  if (
    !record(value) ||
    Object.keys(value).some((key) => !allowed.includes(key)) ||
    required.some((key) => !Object.hasOwn(value, key))
  )
    throw new TypeError('Invalid source definition fields');
}

/**
 * Validate the strict Email/Template portable schema, not baseline integrity or deployment eligibility.
 * @param {unknown} value - Candidate portable definition.
 */
export function assertSourceDefinition(value: unknown): asserts value is SourceDefinition {
  fields(
    value,
    [
      'contract',
      'contractVersion',
      'identity',
      'contentType',
      'contentBody',
      'language',
      'title',
      'urlName',
      'folderPath',
      'companions',
    ],
    [
      'contract',
      'contractVersion',
      'identity',
      'contentType',
      'contentBody',
      'language',
      'folderPath',
      'companions',
    ],
  );
  if (
    value.contract !== SOURCE_DEFINITION_CONTRACT ||
    value.contractVersion !== SOURCE_DEFINITION_VERSION
  )
    throw new TypeError('Unsupported source definition contract/version');
  fields(value.identity, ['family', 'type', 'apiName', 'context']);
  fields(value.identity.context, ['workspaceApiName']);
  assertPortableIdentity(value.identity);
  const identity = value.identity;
  const profile = SOURCE_PROFILES.find(
    (candidate) => candidate.contentType === value.contentType && candidate.type === identity.type,
  );
  if (value.identity.family !== 'cms' || !profile)
    throw new TypeError('Source definition type/contentType disagreement or unsupported family');
  sourcePathSegment(value.identity.apiName);
  sourcePathSegment(value.identity.context.workspaceApiName);
  if (typeof value.language !== 'string' || !/^[A-Za-z0-9_-]+$/u.test(value.language))
    throw new TypeError('Exact native language is required');
  for (const key of ['title', 'urlName']) {
    if (
      Object.hasOwn(value, key) &&
      (typeof value[key] !== 'string' || (value[key] as string).length === 0)
    )
      throw new TypeError(`Invalid source ${key}`);
  }
  if (!Array.isArray(value.folderPath)) throw new TypeError('Evidenced folderPath is required');
  for (const segment of value.folderPath) sourcePathSegment(segment);
  if (!record(value.contentBody) || Object.hasOwn(value.contentBody, 'rawHtml'))
    throw new TypeError('Source contentBody must be inline without rawHtml');
  if (profile.type === 'Brand') {
    fields(value.companions, []);
    if (!validBrandBody(value.contentBody) || value.title !== value.contentBody['sfdc_cms:title'])
      throw new TypeError('Unsupported source Brand inline body/title');
  } else {
    fields(value.companions, ['rawHtml']);
    if (
      value.companions.rawHtml !== `${value.identity.apiName as string}.cms-${profile.token}.html`
    )
      throw new TypeError('Source companion must use the exact same-stem token');
    assertNativeBody({
      contentType: value.contentType,
      contentBody: { ...value.contentBody, rawHtml: '<p>Companion</p>' },
    } as unknown as WorkspaceImportItem);
  }
  assertPortablePayload(value);
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((child) => canonical(child));
  if (!record(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .toSorted()
      .map((key) => [key, canonical(value[key])]),
  );
}

/**
 * Serialize recursively sorted JSON with two spaces and one terminal LF.
 * @param {SourceDefinition} definition - Validated portable Email/Template definition.
 * @returns {string} Canonical UTF-8 JSON text.
 */
export function serializeSourceDefinition(definition: SourceDefinition): string {
  assertSourceDefinition(definition);
  return `${JSON.stringify(canonical(definition), undefined, 2)}\n`;
}
