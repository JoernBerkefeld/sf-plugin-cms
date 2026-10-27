import {
  assertPortableIdentity,
  assertPortablePayload,
  type JsonValue,
} from './capability-registry.js';
import { sourcePathSegment } from './source-definition.js';

export const EMAIL_FRAGMENT_SOURCE_CONTRACT = 'sf-cms-email-fragment-source' as const;
export const EMAIL_FRAGMENT_SOURCE_VERSION = '1.0.0' as const;

export type EmailFragmentSourceDefinition = {
  contract: typeof EMAIL_FRAGMENT_SOURCE_CONTRACT;
  contractVersion: typeof EMAIL_FRAGMENT_SOURCE_VERSION;
  identity: {
    family: 'cms';
    type: 'Email Fragment';
    apiName: string;
    context: { workspaceApiName: string };
  };
  contentType: 'sfdc_cms__emailFragment';
  language: string;
  title: string;
  urlName: string;
  folderPath: string[];
  contentBody: Record<string, JsonValue>;
};

function record(value: unknown): value is Record<string, unknown> {
  return (
    value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype
  );
}

function invalid(path: string): never {
  throw new TypeError(`Invalid Email Fragment source at ${path}`);
}

function fields(
  value: unknown,
  keys: string[],
  path: string,
): asserts value is Record<string, unknown> {
  if (
    !record(value) ||
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  )
    invalid(path);
}

function language(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/u.test(value))
    invalid('exact native language');
}

/**
 * Admit only the actual default component variant, independently of enabled workspace languages.
 * @param {Array} variants - Complete actual component siblings, not workspace language configuration.
 * @param {string} defaultLanguage - Exact API-returned workspace default language.
 */
export function assertSingleDefaultEmailFragmentVariant(
  variants: ReadonlyArray<{ Language: string; IsPrimary: boolean; VariantType: string }>,
  defaultLanguage: string,
): void {
  language(defaultLanguage);
  if (variants.length !== 1)
    throw new TypeError(
      'Email Fragment requires exactly one default variant; additional actual variants are unsupported',
    );
  const variant = variants[0];
  if (
    variant.Language !== defaultLanguage ||
    variant.IsPrimary !== true ||
    variant.VariantType !== 'Content'
  )
    throw new TypeError('Email Fragment requires the exact native default Content variant');
}

function json(value: unknown, path: string): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (Array.isArray(value)) {
    if (Object.keys(value).length !== value.length) invalid(path);
    for (const [index, child] of value.entries()) json(child, `${path}[${index}]`);
  } else if (record(value)) {
    for (const [key, child] of Object.entries(value)) json(child, `${path}.${key}`);
  } else invalid(path);
}

function block(value: unknown, path: string, ids: Set<string>, idPaths: string[]): void {
  if (
    !record(value) ||
    value.type !== 'block' ||
    typeof value.definition !== 'string' ||
    !value.definition ||
    typeof value.id !== 'string' ||
    !/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/iu.test(value.id)
  )
    invalid(path);
  const id = value.id as string;
  if (ids.has(id.toLowerCase())) invalid(`${path}.id (duplicate)`);
  ids.add(id.toLowerCase());
  idPaths.push(`${path}.id`);
  if (Object.hasOwn(value, 'attributes') && !record(value.attributes))
    invalid(`${path}.attributes`);
  if (Object.hasOwn(value, 'children')) {
    if (!Array.isArray(value.children)) invalid(`${path}.children`);
    for (const [index, child] of (value.children as unknown[]).entries())
      block(child, `${path}.children[${index}]`, ids, idPaths);
  }
}

/**
 * Validate full authored primary content without sample-specific layout restrictions.
 * @param {unknown} value - Candidate single-default-variant portable source.
 */
export function assertEmailFragmentSourceDefinition(
  value: unknown,
): asserts value is EmailFragmentSourceDefinition {
  fields(
    value,
    [
      'contract',
      'contractVersion',
      'identity',
      'contentType',
      'language',
      'title',
      'urlName',
      'folderPath',
      'contentBody',
    ],
    '$',
  );
  if (
    value.contract !== EMAIL_FRAGMENT_SOURCE_CONTRACT ||
    value.contractVersion !== EMAIL_FRAGMENT_SOURCE_VERSION ||
    value.contentType !== 'sfdc_cms__emailFragment'
  )
    invalid('contract/version/contentType');
  fields(value.identity, ['family', 'type', 'apiName', 'context'], '$.identity');
  fields(value.identity.context, ['workspaceApiName'], '$.identity.context');
  if (value.identity.family !== 'cms' || value.identity.type !== 'Email Fragment')
    invalid('identity');
  assertPortableIdentity(value.identity);
  sourcePathSegment(value.identity.apiName);
  sourcePathSegment(value.identity.context.workspaceApiName);
  language(value.language);
  if (!Array.isArray(value.folderPath)) invalid('folderPath');
  for (const segment of value.folderPath as unknown[]) sourcePathSegment(segment);
  if (!record(value.contentBody) || Object.hasOwn(value.contentBody, 'rawHtml'))
    invalid('contentBody');
  const body = value.contentBody as Record<string, unknown>;
  for (const key of ['title', 'urlName']) {
    if (typeof value[key] !== 'string' || !value[key]) invalid(`primary ${key}`);
    const bodyKey = `sfdc_cms:${key}`;
    if (Object.hasOwn(body, bodyKey) && typeof body[bodyKey] !== 'string')
      invalid(`contentBody.${bodyKey}`);
  }
  if (
    Object.hasOwn(body, 'sfdc_cms:variants') &&
    (!Array.isArray(body['sfdc_cms:variants']) ||
      (body['sfdc_cms:variants'] as unknown[]).length > 0)
  )
    throw new TypeError('Additional authored Email Fragment variants are unsupported');
  json(value, '$');
  const idPaths: string[] = [];
  const root = body['sfdc_cms:block'];
  if (!record(root) || root.definition !== 'sfdc_cms/rootContentBlock') invalid('root block');
  block(root, '$.contentBody.sfdc_cms:block', new Set(), idPaths);
  assertPortablePayload(value, { allowedStructuralIdPaths: idPaths });
}

const ordinary = (value: unknown): value is string =>
  typeof value === 'string' && /^[!-~](?:[ -~]*[!-~])?(?![\s\S])/u.test(value);

/**
 * Bind a detached write expectation without changing observed source metadata or authored body.
 * UPDATE qualification is deliberately limited to printable ASCII with non-space boundaries.
 * CREATE retains the observed envelope, including the qualified single-terminal-space body pair.
 * @param {EmailFragmentSourceDefinition} source - Exact observed source representation.
 * @param {'create' | 'update'} operation - Native operation whose envelope is expected.
 * @param {string} workspaceApiName - Destination-local context mapping only.
 * @param {EmailFragmentSourceDefinition} [native] - Independently acquired native definition.
 * @returns {EmailFragmentSourceDefinition} Strict expected definition, never a title-ignoring comparator.
 */
export function expectedEmailFragmentDefinition(
  source: EmailFragmentSourceDefinition,
  operation: 'create' | 'update',
  workspaceApiName: string,
  native?: EmailFragmentSourceDefinition,
): EmailFragmentSourceDefinition {
  const expected = structuredClone(source);
  expected.identity.context.workspaceApiName = workspaceApiName;
  // Exact observed pairs need no derivation or mutation, even outside the write domain.
  if (
    native &&
    serializeEmailFragmentSourceDefinition(native) ===
      serializeEmailFragmentSourceDefinition(expected)
  )
    return expected;
  const title = source.contentBody['sfdc_cms:title'];
  if (operation === 'update' && ordinary(title)) {
    expected.title = title;
    return expected;
  }
  if (
    operation === 'create' &&
    ordinary(source.title) &&
    (title === source.title || title === `${source.title} `)
  )
    return expected;
  throw new TypeError(
    `Unsupported derived envelope for Fragment ${operation.toUpperCase()}: changed writes require a nonempty printable ASCII body title without boundary whitespace; CREATE additionally requires matching envelope/body or exactly one terminal body space`,
  );
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
 * Serialize sorted object keys, ordered arrays, two-space JSON and one terminal LF.
 * @param {EmailFragmentSourceDefinition} definition - Validated single-default source.
 * @returns {string} Canonical JSON text without a BOM.
 */
export function serializeEmailFragmentSourceDefinition(
  definition: EmailFragmentSourceDefinition,
): string {
  assertEmailFragmentSourceDefinition(definition);
  return `${JSON.stringify(canonical(definition), undefined, 2)}\n`;
}
