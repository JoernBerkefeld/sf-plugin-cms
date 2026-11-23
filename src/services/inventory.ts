import { CmsError } from '../errors/registry.js';
import {
  getSelectedOperation,
  isRecord,
  requestJson,
  type RequestConnection,
} from '../transport/json-request.js';

// One SOQL page; keyset paging (`Id > :last`) is the only proven complete inventory.
const PAGE_SIZE = 2000;
// API names per `IN (…)` list, to keep the query URL short.
const NAMES_PER_QUERY = 100;

/** What the inventory needs of a workspace. */
export type WorkspaceScope = { id: string; defaultLanguage: string | null };

/** One variant row of the SOQL inventory. */
export type InventoryVariant = {
  id: string;
  managedContentId: string;
  language: string | null;
  isPrimary: boolean;
  name: string | null;
  contentKey: string | null;
  apiName: string | null;
  contentType: string | null;
  workspaceId: string | null;
  /** `IsPublished`; null when the row does not say. */
  isPublished: boolean | null;
  /** `ManagedContentVariantStatus`: Draft, Published or Revised. */
  status: string | null;
};

/** One component (managed content) with its default variant and the variants left out. */
export type InventoryItem = {
  managedContentId: string;
  apiName: string;
  contentKey: string | null;
  defaultVariant: InventoryVariant | undefined;
  otherVariants: InventoryVariant[];
};

/**
 * A SOQL string literal.
 * @param {string} value - Raw value.
 * @returns {string} Quoted and escaped literal.
 */
export function soqlString(value: string): string {
  return `'${value.replaceAll('\\', '\\\\').replaceAll("'", String.raw`\'`)}'`;
}

function text(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' ? value : null;
}

function toVariant(record: Record<string, unknown>): InventoryVariant {
  const parent = isRecord(record.ManagedContent) ? record.ManagedContent : {};
  const id = text(record, 'Id');
  const managedContentId = text(record, 'ManagedContentId');
  if (!id || !managedContentId)
    throw new CmsError('UNEXPECTED_RESPONSE', 'ManagedContentVariant row without Id');
  return {
    id,
    managedContentId,
    language: text(record, 'Language'),
    isPrimary: record.IsPrimary === true,
    name: text(record, 'Name'),
    contentKey: text(record, 'ManagedContentKey'),
    apiName: text(parent, 'ApiName'),
    contentType: text(record, 'ContentTypeFullyQualifiedName'),
    workspaceId: text(parent, 'AuthoredManagedContentSpaceId'),
    isPublished: typeof record.IsPublished === 'boolean' ? record.IsPublished : null,
    status: text(record, 'ManagedContentVariantStatus'),
  };
}

const FIELDS =
  'Id, ManagedContentId, Language, IsPrimary, Name, ManagedContentKey, ContentTypeFullyQualifiedName, IsPublished, ManagedContentVariantStatus, ManagedContent.ApiName, ManagedContent.AuthoredManagedContentSpaceId';

/**
 * Every ManagedContentVariant row matching a WHERE clause, by keyset paging on Id.
 * @param {RequestConnection} connection - Org connection.
 * @param {string} where - SOQL condition (without WHERE).
 * @returns {Promise<InventoryVariant[]>} Rows in Id order.
 */
export async function queryVariants(
  connection: RequestConnection,
  where: string,
): Promise<InventoryVariant[]> {
  const rows: InventoryVariant[] = [];
  let last: string | undefined;
  for (;;) {
    const keyset = last === undefined ? '' : ` AND Id > ${soqlString(last)}`;
    const q = `SELECT ${FIELDS} FROM ManagedContentVariant WHERE ${where}${keyset} ORDER BY Id LIMIT ${PAGE_SIZE}`;
    const { data } = await requestJson<unknown>(connection, getSelectedOperation('soql.query'), {
      query: { q },
    });
    const records = isRecord(data) ? data.records : undefined;
    if (!Array.isArray(records) || !records.every((record) => isRecord(record)))
      throw new CmsError('UNEXPECTED_RESPONSE', 'SOQL answer without records');
    const page = (records as Array<Record<string, unknown>>).map((record) => toVariant(record));
    rows.push(...page);
    if (page.length < PAGE_SIZE) return rows;
    last = page.at(-1)!.id;
  }
}

/**
 * Group variant rows into components and pick each one's default variant: the primary one,
 * else the one in the workspace default language.
 * @param {InventoryVariant[]} rows - Variant rows.
 * @param {string | null} defaultLanguage - Workspace default language.
 * @returns {InventoryItem[]} Components, sorted by API name.
 */
export function groupInventory(
  rows: InventoryVariant[],
  defaultLanguage: string | null,
): InventoryItem[] {
  const byContent = new Map<string, InventoryVariant[]>();
  for (const row of rows) {
    const list = byContent.get(row.managedContentId) ?? [];
    list.push(row);
    byContent.set(row.managedContentId, list);
  }
  return [...byContent.values()]
    .map((variants): InventoryItem => {
      const defaultVariant =
        variants.find((variant) => variant.isPrimary) ??
        variants.find(
          (variant) => variant.language !== null && variant.language === defaultLanguage,
        );
      return {
        managedContentId: variants[0].managedContentId,
        apiName: variants[0].apiName ?? variants[0].contentKey ?? variants[0].managedContentId,
        contentKey: variants[0].contentKey,
        defaultVariant,
        otherVariants: variants.filter((variant) => variant !== defaultVariant),
      };
    })
    .toSorted((left, right) => left.apiName.localeCompare(right.apiName));
}

/**
 * The components of one content type in one workspace: all of them, or the named ones.
 * @param {RequestConnection} connection - Org connection.
 * @param {WorkspaceScope} workspace - Workspace ID and default language.
 * @param {string} contentType - Fully qualified content type.
 * @param {string[] | 'all'} apiNames - API names, or every component of the type.
 * @returns {Promise<InventoryItem[]>} Components found (missing names are simply absent).
 */
export async function inventoryOf(
  connection: RequestConnection,
  workspace: WorkspaceScope,
  contentType: string,
  apiNames: string[] | 'all',
): Promise<InventoryItem[]> {
  const scope = `ManagedContent.AuthoredManagedContentSpaceId = ${soqlString(workspace.id)} AND ContentTypeFullyQualifiedName = ${soqlString(contentType)}`;
  if (apiNames === 'all')
    return groupInventory(await queryVariants(connection, scope), workspace.defaultLanguage);
  const rows: InventoryVariant[] = [];
  for (let index = 0; index < apiNames.length; index += NAMES_PER_QUERY) {
    const names = apiNames.slice(index, index + NAMES_PER_QUERY).map((name) => soqlString(name));
    rows.push(
      ...(await queryVariants(
        connection,
        `${scope} AND ManagedContent.ApiName IN (${names.join(', ')})`,
      )),
    );
  }
  return groupInventory(rows, workspace.defaultLanguage);
}

/**
 * Variant rows of the components with the given content keys (for reference resolution).
 * @param {RequestConnection} connection - Org connection.
 * @param {string[]} contentKeys - Content keys.
 * @returns {Promise<InventoryVariant[]>} Primary variant rows.
 */
export async function variantsByContentKey(
  connection: RequestConnection,
  contentKeys: string[],
): Promise<InventoryVariant[]> {
  const rows: InventoryVariant[] = [];
  for (let index = 0; index < contentKeys.length; index += NAMES_PER_QUERY) {
    const keys = contentKeys.slice(index, index + NAMES_PER_QUERY).map((key) => soqlString(key));
    rows.push(
      ...(await queryVariants(
        connection,
        `ManagedContentKey IN (${keys.join(', ')}) AND IsPrimary = true`,
      )),
    );
  }
  return rows;
}
