import { CmsError } from '../errors/registry.js';
import {
  BODY_ENVELOPE_FIELDS,
  DEFAULT_REFERENCE_FORMS,
  formsAt,
  pathsAt,
  RECORD_ID,
  recordFieldsOf,
  valueAt,
  type CompanionFields,
} from './json-projection.js';
import type {
  DeployPayload,
  LogicalReference,
  RecordReference,
  RecordReferencePath,
  ReferenceForm,
  SourceFiles,
} from './types.js';

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
 * Whether a value is a logical reference in another form: `{ type, apiName, format }`.
 * @param {unknown} value - Property value.
 * @returns {boolean} Logical reference with its native format.
 */
export function isFormReference(value: unknown): value is LogicalReference & { format: string } {
  return (
    isPlainObject(value) &&
    Object.keys(value).length === 3 &&
    typeof value.type === 'string' &&
    typeof value.apiName === 'string' &&
    typeof value.format === 'string'
  );
}

/**
 * The form a file value is written in, if the property takes it.
 * @param {readonly ReferenceForm[]} forms - Forms.
 * @param {string | undefined} parent - Property the holding object sits under.
 * @param {string} key - Property name.
 * @param {unknown} value - File value.
 * @returns {ReferenceForm | undefined} Form of a `{ type, apiName, format }` value.
 */
function formOfValue(
  forms: readonly ReferenceForm[],
  parent: string | undefined,
  key: string,
  value: unknown,
): ReferenceForm | undefined {
  if (!isFormReference(value)) return undefined;
  return formsAt(forms, parent, key).find((form) => form.format === value.format);
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
 * Every logical reference in a body (`contentKey: { type, apiName }` anywhere, and
 * `{ type, apiName, format }` where a reference form applies), distinct, in document order.
 * @param {unknown} body - Payload body.
 * @param {readonly ReferenceForm[]} forms - Forms besides `contentKey` (default: `DEFAULT_REFERENCE_FORMS`).
 * @returns {LogicalReference[]} References.
 */
export function logicalReferences(
  body: unknown,
  forms: readonly ReferenceForm[] = DEFAULT_REFERENCE_FORMS,
): LogicalReference[] {
  const found = new Map<string, LogicalReference>();
  const visit = (value: unknown, parent?: string): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item, parent);
    } else if (isPlainObject(value)) {
      for (const [key, child] of Object.entries(value)) {
        if (
          (key === 'contentKey' && isLogicalReference(child)) ||
          formOfValue(forms, parent, key, child)
        ) {
          const { type, apiName } = child as LogicalReference;
          found.set(`${type}:${apiName}`, { type, apiName });
        } else visit(child, key);
      }
    }
  };
  visit(body);
  return [...found.values()];
}

/**
 * Copy of a body with each logical reference replaced by the destination content key, written
 * in the reference's format (`@cms/<key>`, the bare key, …).
 * @param {unknown} body - Payload body.
 * @param {(reference: LogicalReference) => string} keyOf - Destination key of a reference.
 * @param {readonly ReferenceForm[]} forms - Forms besides `contentKey` (default: `DEFAULT_REFERENCE_FORMS`).
 * @param {string} [parent] - Property the body sits under (recursion).
 * @returns {unknown} Native body.
 */
export function resolveReferences(
  body: unknown,
  keyOf: (reference: LogicalReference) => string,
  forms: readonly ReferenceForm[] = DEFAULT_REFERENCE_FORMS,
  parent?: string,
): unknown {
  if (Array.isArray(body)) return body.map((item) => resolveReferences(item, keyOf, forms, parent));
  if (!isPlainObject(body)) return body;
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(body)) {
    const form = formOfValue(forms, parent, key, child);
    if (key === 'contentKey' && isLogicalReference(child)) result[key] = keyOf(child);
    else if (form) {
      const { type, apiName } = child as LogicalReference;
      result[key] = form.format.replace('<contentKey>', keyOf({ type, apiName }));
    } else result[key] = resolveReferences(child, keyOf, forms, key);
  }
  return result;
}

/** A record reference of a payload body and where it sits. */
export type LocatedRecordReference = RecordReference & { path: readonly string[] };

/**
 * The record references `{ sobject, <lookup fields> }` at the declared paths of a payload body
 * (`*` steps expanded to concrete paths). A path
 * holding a plain value (an ID kept as it was) is left to Salesforce. Strict: an object of
 * another shape or sObject is refused (UNKNOWN_SETTING).
 * @param {unknown} body - Payload body.
 * @param {readonly RecordReferencePath[]} paths - Declared paths.
 * @returns {LocatedRecordReference[]} References, in declaration order.
 */
export function recordReferences(
  body: unknown,
  paths: readonly RecordReferencePath[],
): LocatedRecordReference[] {
  const found: LocatedRecordReference[] = [];
  for (const declaration of paths) {
    const { sobject } = declaration;
    const fields = recordFieldsOf(declaration);
    const keys = Object.keys(fields);
    for (const path of pathsAt(body, declaration.path)) {
      const value = valueAt(body, path);
      if (!isPlainObject(value)) continue;
      if (
        Object.keys(value).length !== keys.length + 1 ||
        value.sobject !== sobject ||
        !keys.every((key) => typeof value[key] === 'string')
      )
        throw new CmsError(
          'UNKNOWN_SETTING',
          `contentBody.${path.join('.')} must be { "sobject": "${sobject}", ${keys.map((key) => `"${key}": "<${fields[key]}>"`).join(', ')} } or a record ID`,
        );
      found.push({
        path,
        sobject,
        fields,
        values: Object.fromEntries(keys.map((key) => [key, value[key] as string])),
      });
    }
  }
  return found;
}

/**
 * The declared record paths of a payload body that hold a raw record ID instead of the
 * `{ sobject, <lookup fields> }` form (`*` steps expanded).
 * @param {unknown} body - Payload body.
 * @param {readonly RecordReferencePath[]} paths - Declared paths.
 * @returns {Array<{ path: string[]; sobject: string }>} Raw IDs, in declaration order.
 */
export function rawRecordIds(
  body: unknown,
  paths: readonly RecordReferencePath[],
): Array<{ path: string[]; sobject: string }> {
  return paths.flatMap(({ path: declared, sobject }) =>
    pathsAt(body, declared).flatMap((path) => {
      const value = valueAt(body, path);
      return typeof value === 'string' && RECORD_ID.test(value) ? [{ path, sobject }] : [];
    }),
  );
}

/**
 * Copy of a body with each record reference replaced by the destination record ID.
 * @param {Record<string, unknown>} body - Payload body.
 * @param {readonly RecordReferencePath[]} paths - Declared paths.
 * @param {(reference: RecordReference) => string} idOf - Destination ID of a record.
 * @returns {Record<string, unknown>} Native body.
 */
export function resolveRecordReferences(
  body: Record<string, unknown>,
  paths: readonly RecordReferencePath[],
  idOf: (reference: RecordReference) => string,
): Record<string, unknown> {
  const references = recordReferences(body, paths);
  if (references.length === 0) return body;
  const result = structuredClone(body);
  for (const { path, ...reference } of references) {
    const holder = valueAt(result, path.slice(0, -1)) as Record<string, unknown>;
    holder[path.at(-1)!] = idOf(reference);
  }
  return result;
}
