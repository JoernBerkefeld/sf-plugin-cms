import { RECORD_ID } from '../content/json-projection.js';
import type { RecordReference } from '../content/types.js';
import { CmsError } from '../errors/registry.js';
import {
  getSelectedOperation,
  isRecord,
  requestJson,
  type RequestConnection,
} from '../transport/json-request.js';
import { sameId } from './folders.js';
import { soqlString } from './inventory.js';

// IDs per `IN (…)` list, to keep the query URL short.
const IDS_PER_QUERY = 100;
const SOBJECT_NAME = /^\w+$/u;

/** Record lookup fields <-> ID lookups of one org, read-only SOQL, cached per run. */
export type RecordResolver = {
  /** Read the lookup fields of these records (`SELECT Id, <fields> … WHERE Id IN`). */
  load: (
    records: Array<{ sobject: string; fields: readonly string[]; id: string }>,
  ) => Promise<void>;
  /** Lookup field values (SOQL field -> value) of a loaded record; undefined = not found. */
  recordOf: (
    sobject: string,
    fields: readonly string[],
    id: string,
  ) => Readonly<Record<string, string>> | undefined;
  /** IDs of the records with these field values (at most two: enough to tell ambiguous). */
  idsOf: (reference: RecordReference) => Promise<string[]>;
};

/**
 * Key of a record reference, the same for equal sObject and values.
 * @param {RecordReference} reference - Reference.
 * @returns {string} Key.
 */
export const recordKey = (reference: RecordReference): string =>
  `${reference.sobject}:${JSON.stringify(Object.keys(reference.fields).map((key) => reference.values[key]))}`;

/**
 * How a message names a record reference: `Campaign "Spring"`, `RecordType "Lead" / "Std"`.
 * @param {RecordReference} reference - Reference.
 * @returns {string} Label.
 */
export const recordLabel = (reference: RecordReference): string =>
  `${reference.sobject} ${Object.keys(reference.fields)
    .map((key) => `"${reference.values[key]}"`)
    .join(' / ')}`;

async function query(
  connection: RequestConnection,
  q: string,
): Promise<Array<Record<string, unknown>>> {
  const { data } = await requestJson<unknown>(connection, getSelectedOperation('soql.query'), {
    query: { q },
  });
  const records = isRecord(data) ? data.records : undefined;
  if (!Array.isArray(records) || !records.every((record) => isRecord(record)))
    throw new CmsError('UNEXPECTED_RESPONSE', 'SOQL answer without records');
  return records as Array<Record<string, unknown>>;
}

const rowKey = (sobject: string, fields: readonly string[], id: string): string =>
  `${sobject}:${fields.join(',')}:${id.slice(0, 15)}`;

function assertName(name: string): void {
  if (!SOBJECT_NAME.test(name))
    throw new CmsError('UNEXPECTED_RESPONSE', `Not an sObject or field name: ${name}`);
}

/**
 * Record lookups for the record references handlers declare (`referenceDeclarations.records`).
 * @param {RequestConnection} connection - Org connection.
 * @returns {RecordResolver} Lookups.
 */
export function recordResolver(connection: RequestConnection): RecordResolver {
  const rows = new Map<string, Readonly<Record<string, string>>>();
  // One read per record, shared by every caller that names it (concurrent items wait for it).
  const reads = new Map<string, Promise<void>>();
  const ids = new Map<string, Promise<string[]>>();
  const read = async (
    wanted: Map<string, { sobject: string; fields: readonly string[]; ids: string[] }>,
  ): Promise<void> => {
    for (const { sobject, fields, ids: list } of wanted.values()) {
      for (const name of [sobject, ...fields]) assertName(name);
      for (let index = 0; index < list.length; index += IDS_PER_QUERY) {
        const chunk = list.slice(index, index + IDS_PER_QUERY);
        const found = await query(
          connection,
          `SELECT Id, ${fields.join(', ')} FROM ${sobject} WHERE Id IN (${chunk.map((id) => soqlString(id)).join(', ')})`,
        );
        for (const row of found) {
          if (typeof row.Id !== 'string') continue;
          const values = Object.fromEntries(fields.map((field) => [field, row[field]]));
          if (!Object.values(values).every((value) => typeof value === 'string')) continue;
          for (const id of chunk)
            if (sameId(id, row.Id))
              rows.set(rowKey(sobject, fields, id), values as Record<string, string>);
        }
      }
    }
  };
  return {
    async load(records): Promise<void> {
      const named = records.filter(({ id }) => RECORD_ID.test(id));
      const wanted = new Map<
        string,
        { sobject: string; fields: readonly string[]; ids: string[] }
      >();
      const keys: string[] = [];
      for (const { sobject, fields, id } of named) {
        const key = rowKey(sobject, fields, id);
        if (reads.has(key) || keys.includes(key)) continue;
        keys.push(key);
        const group = `${sobject}:${fields.join(',')}`;
        const entry = wanted.get(group) ?? { sobject, fields, ids: [] };
        entry.ids.push(id);
        wanted.set(group, entry);
      }
      if (keys.length > 0) {
        const pending = read(wanted);
        for (const key of keys) reads.set(key, pending);
        // A failed read is not cached: a later load asks again.
        pending.catch(() => {
          for (const key of keys) if (reads.get(key) === pending) reads.delete(key);
        });
      }
      await Promise.all(
        new Set(named.map(({ sobject, fields, id }) => reads.get(rowKey(sobject, fields, id)))),
      );
    },
    recordOf: (sobject, fields, id) => rows.get(rowKey(sobject, fields, id)),
    idsOf(reference): Promise<string[]> {
      const key = recordKey(reference);
      let found = ids.get(key);
      if (!found) {
        const { sobject, fields, values } = reference;
        for (const name of [sobject, ...Object.values(fields)]) assertName(name);
        const where = Object.entries(fields)
          .map(([fileKey, field]) => `${field} = ${soqlString(values[fileKey])}`)
          .join(' AND ');
        found = query(connection, `SELECT Id FROM ${sobject} WHERE ${where} LIMIT 2`).then(
          (answer) =>
            answer.map((row) => row.Id).filter((id): id is string => typeof id === 'string'),
        );
        ids.set(key, found);
      }
      return found;
    },
  };
}
