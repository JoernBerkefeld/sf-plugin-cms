import type {
  NativeVariant,
  RecordReferencePath,
  ReferenceDeclarations,
  ReferenceForm,
  RetrieveContext,
  SourceDocument,
  SourceFiles,
} from './types.js';

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

export const CONTENT_KEY = /^MC[A-Z2-7]{26}$/u;

/**
 * Content keys outside `contentKey` that every type recognises: a block's
 * `definition: "@cms/<key>"` (reusable content block) and the bare key in
 * `sfdc_cms:template.definition` (landing page). A handler adds more with
 * `referenceDeclarations.forms`.
 */
export const DEFAULT_REFERENCE_FORMS: readonly ReferenceForm[] = [
  { key: 'definition', format: '@cms/<contentKey>' },
  { key: 'definition', parent: 'sfdc_cms:template', format: '<contentKey>' },
];

/** A record ID as SOQL takes it (15 or 18 characters). */
export const RECORD_ID = /^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/u;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The built-in forms plus a handler's own.
 * @param {ReferenceDeclarations | undefined} declarations - Handler declarations.
 * @returns {readonly ReferenceForm[]} Forms to recognise.
 */
export function referenceFormsOf(
  declarations: ReferenceDeclarations | undefined,
): readonly ReferenceForm[] {
  return [...DEFAULT_REFERENCE_FORMS, ...(declarations?.forms ?? [])];
}

/**
 * The forms that apply to a property.
 * @param {readonly ReferenceForm[]} forms - Forms.
 * @param {string | undefined} parent - Property the holding object sits under.
 * @param {string} key - Property name.
 * @returns {ReferenceForm[]} Matching forms.
 */
export function formsAt(
  forms: readonly ReferenceForm[],
  parent: string | undefined,
  key: string,
): ReferenceForm[] {
  return forms.filter(
    (form) => form.key === key && (form.parent === undefined || form.parent === parent),
  );
}

/**
 * The content key a value holds in a form.
 * @param {ReferenceForm} form - Form.
 * @param {unknown} value - Native value.
 * @returns {string | undefined} Content key, or undefined when the value is not in that form.
 */
export function keyInForm(form: ReferenceForm, value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const [before, after = ''] = form.format.split('<contentKey>');
  if (value.length < before.length + after.length) return undefined;
  if (!value.startsWith(before) || !value.endsWith(after)) return undefined;
  const key = value.slice(before.length, value.length - after.length);
  return CONTENT_KEY.test(key) ? key : undefined;
}

/**
 * The value at a body path.
 * @param {unknown} body - Body.
 * @param {readonly string[]} path - Property names from the root.
 * @returns {unknown} Value, or undefined.
 */
export function valueAt(body: unknown, path: readonly string[]): unknown {
  let current = body;
  for (const key of path) {
    if (Array.isArray(current) && /^\d+$/u.test(key)) current = current[Number(key)];
    else if (isPlainObject(current)) current = current[key];
    else return undefined;
  }
  return current;
}

/** Path step that stands for every element of an array. */
export const EVERY_ELEMENT = '*';

/**
 * The concrete paths a declared path names in a body: each `*` step becomes the index of every
 * element of the array at that point. Paths that do not exist in the body are left out.
 * @param {unknown} body - Body.
 * @param {readonly string[]} path - Declared path.
 * @returns {string[][]} Concrete paths, in body order.
 */
export function pathsAt(body: unknown, path: readonly string[]): string[][] {
  let found: string[][] = [[]];
  for (const step of path)
    found = found.flatMap((prefix) => {
      const current = valueAt(body, prefix);
      if (step !== EVERY_ELEMENT)
        return isPlainObject(current) && step in current ? [[...prefix, step]] : [];
      return Array.isArray(current) ? current.map((_, index) => [...prefix, String(index)]) : [];
    });
  return found;
}

/** Lookup fields of a record path without its own: the record's Name. */
export const DEFAULT_RECORD_FIELDS: Readonly<Record<string, string>> = { name: 'Name' };

/**
 * Lookup fields of a record path (file key -> SOQL field).
 * @param {RecordReferencePath} declaration - Declared path.
 * @returns {Readonly<Record<string, string>>} Fields.
 */
export const recordFieldsOf = (
  declaration: RecordReferencePath,
): Readonly<Record<string, string>> => declaration.fields ?? DEFAULT_RECORD_FIELDS;

/**
 * Every record ID at the declared record paths of a native body.
 * @param {unknown} body - Native contentBody.
 * @param {readonly RecordReferencePath[]} paths - Declared paths.
 * @returns {Array<{ sobject: string; fields: string[]; id: string }>} IDs with the SOQL fields
 *   to read, in declaration order.
 */
export function recordIdsOf(
  body: unknown,
  paths: readonly RecordReferencePath[],
): Array<{ sobject: string; fields: string[]; id: string }> {
  return paths.flatMap((declaration) =>
    pathsAt(body, declaration.path).flatMap((path) => {
      const value = valueAt(body, path);
      return typeof value === 'string' && RECORD_ID.test(value)
        ? [
            {
              sobject: declaration.sobject,
              fields: Object.values(recordFieldsOf(declaration)),
              id: value,
            },
          ]
        : [];
    }),
  );
}

/** Body keys that hold the envelope's title and urlName; the body value wins on create. */
export const BODY_ENVELOPE_FIELDS = {
  title: 'sfdc_cms:title',
  urlName: 'sfdc_cms:urlName',
} as const;

/** Top-level body keys of a JSON type that become companion files, by file suffix. */
export type CompanionFields = Readonly<Record<string, string>>;

/**
 * Every content key a body references: `contentKey` properties anywhere in it and values in one
 * of the reference forms.
 * @param {unknown} body - Native contentBody.
 * @param {readonly ReferenceForm[]} forms - Forms besides `contentKey` (see `referenceFormsOf`).
 * @returns {string[]} Distinct keys in document order.
 */
export function referencedContentKeys(
  body: unknown,
  forms: readonly ReferenceForm[] = DEFAULT_REFERENCE_FORMS,
): string[] {
  const found = new Set<string>();
  const visit = (value: unknown, parent?: string): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item, parent);
    } else if (isPlainObject(value)) {
      for (const [key, child] of Object.entries(value)) {
        if (key === 'contentKey' && typeof child === 'string' && CONTENT_KEY.test(child)) {
          found.add(child);
          continue;
        }
        const inForm = formsAt(forms, parent, key)
          .map((form) => keyInForm(form, child))
          .find(Boolean);
        if (inForm) found.add(inForm);
        else visit(child, key);
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
 * @param {readonly ReferenceForm[]} forms - Forms besides `contentKey`.
 * @param {string} [parent] - Property the value sits under.
 * @returns {unknown} Source value.
 */
function projectValue(
  value: unknown,
  context: RetrieveContext,
  forms: readonly ReferenceForm[],
  parent?: string,
): unknown {
  if (Array.isArray(value)) return value.map((item) => projectValue(item, context, forms, parent));
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
    const inForm = formsAt(forms, parent, key)
      .map((form) => ({ form, contentKey: keyInForm(form, child) }))
      .find((match) => match.contentKey !== undefined);
    if (inForm) {
      const reference = context.referenceOf(inForm.contentKey!);
      if (reference)
        result[key] = {
          type: reference.type,
          apiName: reference.apiName,
          format: inForm.form.format,
        };
      else {
        result[key] = child;
        context.warn({
          code: 'REFERENCE_UNRESOLVED',
          message: `Content key ${inForm.contentKey} (${key}) is not a component of workspace ${context.workspace.apiName ?? context.workspace.id}; kept as is.`,
        });
      }
      continue;
    }
    result[key] = projectValue(child, context, forms, key);
  }
  return result;
}

/**
 * Replace the record IDs at the declared paths by `{ sobject, name }`, in place. An ID whose
 * record the pipeline did not find stays as it is, with a warning.
 * @param {Record<string, unknown>} body - Copy of the native body.
 * @param {readonly RecordReferencePath[]} paths - Declared paths.
 * @param {RetrieveContext} context - Record names and warnings.
 * @returns {Record<string, unknown>} The same body.
 */
function projectRecords(
  body: Record<string, unknown>,
  paths: readonly RecordReferencePath[],
  context: RetrieveContext,
): Record<string, unknown> {
  for (const declaration of paths) {
    const { sobject } = declaration;
    const fields = Object.entries(recordFieldsOf(declaration));
    for (const path of pathsAt(body, declaration.path)) {
      const holder = valueAt(body, path.slice(0, -1)) as Record<string, unknown>;
      const key = path.at(-1)!;
      const id = holder[key];
      if (typeof id !== 'string' || id === '') continue;
      const row = RECORD_ID.test(id)
        ? context.recordOf?.(
            sobject,
            fields.map(([, field]) => field),
            id,
          )
        : undefined;
      if (row === undefined)
        context.warn({
          code: 'RECORD_REFERENCE_UNRESOLVED',
          message: `${path.join('.')} names ${sobject} ${id}, which was not found; kept as is.`,
        });
      else
        holder[key] = {
          sobject,
          ...Object.fromEntries(fields.map(([fileKey, field]) => [fileKey, row[field]])),
        };
    }
  }
  return body;
}

/**
 * The retrieve projection shared by JSON types: drop runtime fields, keep every other envelope
 * field (unknown ones included), turn the folder into a path, references into `{ type, apiName }`
 * and the named body fields into companion files.
 * @param {string} type - CLI type name.
 * @param {NativeVariant} native - Default variant as read.
 * @param {RetrieveContext} context - Folder path, reference lookup, warnings.
 * @param {CompanionFields} companionFields - Body key -> file suffix, such as rawHtml -> .html.
 * @param {ReferenceDeclarations} declarations - The handler's `referenceDeclarations` (extra
 *   reference forms and record paths).
 * @returns {SourceFiles} Files of the component.
 */
export function projectJsonVariant(
  type: string,
  native: NativeVariant,
  context: RetrieveContext,
  companionFields: CompanionFields,
  declarations: ReferenceDeclarations = {},
): SourceFiles {
  const forms = referenceFormsOf(declarations);
  const body = isPlainObject(native.contentBody)
    ? projectRecords(structuredClone(native.contentBody), declarations.records ?? [], context)
    : {};
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
    extra[key] = projectValue(native[key], context, forms);
  }
  // Each value once, where it wins on create: the body's `sfdc_cms:title` / `sfdc_cms:urlName`
  // over the envelope's; the deploy fills the envelope from the body.
  const envelope = (key: 'title' | 'urlName'): Record<string, string> =>
    typeof native[key] === 'string' && typeof body[BODY_ENVELOPE_FIELDS[key]] !== 'string'
      ? { [key]: native[key] }
      : {};
  const document: SourceDocument = {
    apiName: String(native.apiName),
    ...envelope('title'),
    ...envelope('urlName'),
    folderPath: [...context.folderPath],
    ...extra,
    contentBody: projectValue(body, context, forms) as Record<string, unknown>,
  };
  return { type, document, companions };
}
