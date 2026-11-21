import { CmsError } from '../errors/registry.js';
import { BODY_ENVELOPE_FIELDS, type CompanionFields } from './json-projection.js';
import type { DeployPayload, LogicalReference, SourceFiles } from './types.js';

/** Envelope fields a JSON source document may hold besides `contentBody`. */
const ENVELOPE_FIELDS: ReadonlySet<string> = new Set([
  'apiName',
  'title',
  'urlName',
  'folderPath',
  'contentBody',
]);

/** Envelope fields only the create request takes. */
const CREATE_ONLY_FIELDS: ReadonlySet<string> = new Set(['externalId', 'externalSource']);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Whether a value is a logical reference `{ type, apiName }` (exactly these two string keys).
 * @param {unknown} value - Value of a `contentKey` property.
 * @returns {boolean} Logical reference.
 */
export function isLogicalReference(value: unknown): value is LogicalReference {
  return (
    isPlainObject(value) &&
    Object.keys(value).length === 2 &&
    typeof value.type === 'string' &&
    typeof value.apiName === 'string'
  );
}

/**
 * The deploy payload of a JSON type: companions go back into the body under their field names,
 * the envelope is taken as the file says. Strict: a top-level field or companion file the type
 * does not have is refused (UNKNOWN_SETTING), values are not checked (Salesforce decides).
 * @param {SourceFiles} files - Component files.
 * @param {CompanionFields} companionFields - Body key -> file suffix, such as rawHtml -> .html.
 * @returns {DeployPayload} Payload with logical references.
 */
export function jsonPayloadFromSource(
  files: SourceFiles,
  companionFields: CompanionFields,
): DeployPayload {
  const { document } = files;
  const unknown = Object.keys(document).filter(
    (key) => !ENVELOPE_FIELDS.has(key) && !CREATE_ONLY_FIELDS.has(key),
  );
  const fieldOf = new Map(
    Object.entries(companionFields).map(([field, suffix]) => [suffix, field]),
  );
  const contentBody: Record<string, unknown> = { ...document.contentBody };
  for (const [suffix, content] of Object.entries(files.companions)) {
    const field = fieldOf.get(suffix);
    if (!field || typeof content !== 'string') {
      unknown.push(`${document.apiName}.${files.type}${suffix}`);
      continue;
    }
    if (field in contentBody) unknown.push(`contentBody.${field} (also in ${suffix})`);
    contentBody[field] = content;
  }
  for (const key of ['title', 'urlName'] as const) {
    if (!(key in document)) continue;
    if (typeof document[key] !== 'string') unknown.push(`${key} (must be a string)`);
    else if (BODY_ENVELOPE_FIELDS[key] in contentBody)
      unknown.push(`${key} (held in contentBody.${BODY_ENVELOPE_FIELDS[key]})`);
  }
  if (unknown.length > 0)
    throw new CmsError(
      'UNKNOWN_SETTING',
      `${files.type}:${document.apiName} has settings a ${files.type} does not have: ${unknown.join(', ')}`,
    );
  const createOnly: Record<string, unknown> = {};
  for (const key of CREATE_ONLY_FIELDS) if (key in document) createOnly[key] = document[key];
  return {
    apiName: document.apiName,
    ...(typeof document.title === 'string' ? { title: document.title } : {}),
    ...(typeof document.urlName === 'string' ? { urlName: document.urlName } : {}),
    folderPath: [...document.folderPath],
    contentBody,
    createOnly,
  };
}

/**
 * Every logical reference in a body (`contentKey: { type, apiName }` anywhere), distinct, in
 * document order.
 * @param {unknown} body - Payload body.
 * @returns {LogicalReference[]} References.
 */
export function logicalReferences(body: unknown): LogicalReference[] {
  const found = new Map<string, LogicalReference>();
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
    } else if (isPlainObject(value)) {
      for (const [key, child] of Object.entries(value)) {
        if (key === 'contentKey' && isLogicalReference(child))
          found.set(`${child.type}:${child.apiName}`, { type: child.type, apiName: child.apiName });
        else visit(child);
      }
    }
  };
  visit(body);
  return [...found.values()];
}

/**
 * Copy of a body with each logical reference replaced by the destination content key.
 * @param {unknown} body - Payload body.
 * @param {(reference: LogicalReference) => string} keyOf - Destination key of a reference.
 * @returns {unknown} Native body.
 */
export function resolveReferences(
  body: unknown,
  keyOf: (reference: LogicalReference) => string,
): unknown {
  if (Array.isArray(body)) return body.map((item) => resolveReferences(item, keyOf));
  if (!isPlainObject(body)) return body;
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(body))
    result[key] =
      key === 'contentKey' && isLogicalReference(child)
        ? keyOf(child)
        : resolveReferences(child, keyOf);
  return result;
}
