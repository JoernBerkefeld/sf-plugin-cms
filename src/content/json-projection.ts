import type { NativeVariant, RetrieveContext, SourceDocument, SourceFiles } from './types.js';

/** Envelope fields Salesforce owns: IDs, keys, actors, dates, state. Never written to source. */
export const RUNTIME_FIELDS: ReadonlySet<string> = new Set([
  'contentFqn',
  'contentKey',
  'contentSpace',
  'contentType',
  'contentVersion',
  'createdBy',
  'createdDate',
  'deliveryUrls',
  'folder',
  'isPublished',
  'language',
  'lastModifiedBy',
  'lastModifiedDate',
  'managedContentId',
  'managedContentVariantId',
  'managedContentVersionId',
  'source',
  'status',
  'variantVersion',
]);

const CONTENT_KEY = /^MC[A-Z2-7]{26}$/u;

/** Top-level body keys of a JSON type that become companion files, by file suffix. */
export type CompanionFields = Readonly<Record<string, string>>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Every content key a body references (`contentKey` properties anywhere in it).
 * @param {unknown} body - Native contentBody.
 * @returns {string[]} Distinct keys in document order.
 */
export function referencedContentKeys(body: unknown): string[] {
  const found = new Set<string>();
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
    } else if (isPlainObject(value)) {
      for (const [key, child] of Object.entries(value)) {
        if (key === 'contentKey' && typeof child === 'string' && CONTENT_KEY.test(child))
          found.add(child);
        else visit(child);
      }
    }
  };
  visit(body);
  return [...found];
}

/**
 * Copy of a body with sorted object keys (arrays keep their order), logical references in place
 * of content keys, and generated media URLs of references left out.
 * @param {unknown} value - Native value.
 * @param {RetrieveContext} context - Reference lookup and warnings.
 * @returns {unknown} Source value.
 */
function projectValue(value: unknown, context: RetrieveContext): unknown {
  if (Array.isArray(value)) return value.map((item) => projectValue(item, context));
  if (!isPlainObject(value)) return value;
  const isReference =
    isPlainObject(value.source) && isPlainObject(value.source.ref) && typeof value.url === 'string';
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value).toSorted()) {
    const child = value[key];
    // `url` of a referenced image is derived from the reference (`/cms/media/<key>?fileHash=…`).
    if (isReference && key === 'url' && (child as string).startsWith('/cms/media/')) continue;
    if (key === 'contentKey' && typeof child === 'string' && CONTENT_KEY.test(child)) {
      const reference = context.referenceOf(child);
      if (reference) result[key] = { type: reference.type, apiName: reference.apiName };
      else {
        result[key] = child;
        context.warn({
          code: 'REFERENCE_UNRESOLVED',
          message: `Content key ${child} is not a component of workspace ${context.workspace.apiName ?? context.workspace.id}; kept as is.`,
        });
      }
      continue;
    }
    result[key] = projectValue(child, context);
  }
  return result;
}

/**
 * The retrieve projection shared by JSON types: drop runtime fields, keep every other envelope
 * field (unknown ones included), turn the folder into a path, references into `{ type, apiName }`
 * and the named body fields into companion files.
 * @param {string} type - CLI type name.
 * @param {NativeVariant} native - Default variant as read.
 * @param {RetrieveContext} context - Folder path, reference lookup, warnings.
 * @param {CompanionFields} companionFields - Body key -> file suffix, such as rawHtml -> .html.
 * @returns {SourceFiles} Files of the component.
 */
export function projectJsonVariant(
  type: string,
  native: NativeVariant,
  context: RetrieveContext,
  companionFields: CompanionFields,
): SourceFiles {
  const body = isPlainObject(native.contentBody) ? { ...native.contentBody } : {};
  const companions: Record<string, string> = {};
  for (const [field, suffix] of Object.entries(companionFields)) {
    if (typeof body[field] === 'string') {
      companions[suffix] = body[field];
      delete body[field];
    }
  }
  const extra: Record<string, unknown> = {};
  for (const key of Object.keys(native).toSorted()) {
    if (RUNTIME_FIELDS.has(key) || ['apiName', 'title', 'urlName', 'contentBody'].includes(key))
      continue;
    if (key === 'externalId' && native[key] === null) continue;
    extra[key] = projectValue(native[key], context);
  }
  const document: SourceDocument = {
    apiName: String(native.apiName),
    ...(typeof native.title === 'string' ? { title: native.title } : {}),
    ...(typeof native.urlName === 'string' ? { urlName: native.urlName } : {}),
    folderPath: [...context.folderPath],
    ...extra,
    contentBody: projectValue(body, context) as Record<string, unknown>,
  };
  return { type, document, companions };
}
