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

/** Record name <-> ID lookups of one org, read-only SOQL, cached per run. */
export type RecordResolver = {
  /** Read the names of these records (`SELECT Id, Name … WHERE Id IN`). */
  loadNames: (records: Array<{ sobject: string; id: string }>) => Promise<void>;
  /** Name of a loaded record; undefined = not found. */
  nameOf: (sobject: string, id: string) => string | undefined;
  /** IDs of the records with this name (at most two: enough to tell ambiguous). */
  idsOf: (reference: RecordReference) => Promise<string[]>;
};

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

const nameKey = (sobject: string, id: string): string => `${sobject}:${id.slice(0, 15)}`;

function assertSobject(sobject: string): void {
  if (!SOBJECT_NAME.test(sobject))
    throw new CmsError('UNEXPECTED_RESPONSE', `Not an sObject name: ${sobject}`);
}

/**
 * Record lookups for the record references handlers declare (`referenceDeclarations.records`).
 * @param {RequestConnection} connection - Org connection.
 * @returns {RecordResolver} Lookups.
 */
export function recordResolver(connection: RequestConnection): RecordResolver {
  const names = new Map<string, string | null>();
  const ids = new Map<string, Promise<string[]>>();
  return {
    async loadNames(records): Promise<void> {
      const bySobject = new Map<string, string[]>();
      for (const { sobject, id } of records)
        if (RECORD_ID.test(id) && !names.has(nameKey(sobject, id))) {
          names.set(nameKey(sobject, id), null);
          bySobject.set(sobject, [...(bySobject.get(sobject) ?? []), id]);
        }
      for (const [sobject, wanted] of bySobject) {
        assertSobject(sobject);
        for (let index = 0; index < wanted.length; index += IDS_PER_QUERY) {
          const list = wanted.slice(index, index + IDS_PER_QUERY).map((id) => soqlString(id));
          const rows = await query(
            connection,
            `SELECT Id, Name FROM ${sobject} WHERE Id IN (${list.join(', ')})`,
          );
          for (const row of rows)
            if (typeof row.Id === 'string' && typeof row.Name === 'string')
              for (const id of wanted)
                if (sameId(id, row.Id)) names.set(nameKey(sobject, id), row.Name);
        }
      }
    },
    nameOf: (sobject, id) => names.get(nameKey(sobject, id)) ?? undefined,
    idsOf({ sobject, name }): Promise<string[]> {
      const key = `${sobject}:${name}`;
      let found = ids.get(key);
      if (!found) {
        assertSobject(sobject);
        found = query(
          connection,
          `SELECT Id FROM ${sobject} WHERE Name = ${soqlString(name)} LIMIT 2`,
        ).then((rows) =>
          rows.map((row) => row.Id).filter((id): id is string => typeof id === 'string'),
        );
        ids.set(key, found);
      }
      return found;
    },
  };
}
