import { CmsError } from '../errors/registry.js';
import {
  CmsRequestError,
  getSelectedOperation,
  isRecord,
  requestJson,
  type RequestConnection,
} from '../transport/json-request.js';

/**
 * A data graph provider of a body (`sfdc_cms__dataGraphDataProvider`): the names exactly as
 * Salesforce stores them (a data graph outside `default` carries the data space prefix).
 */
export type DataGraphReference = { dataGraphApiName: string; dataspace: string };

/** Why a data graph reference cannot be used in the destination org. */
export type DataGraphBlock = {
  code: 'DATA_SPACE_NOT_IN_DESTINATION' | 'DATA_GRAPH_NOT_IN_DESTINATION';
  message: string;
};

const PROVIDER = 'sfdc_cms__dataGraphDataProvider';
// Data spaces per page of `GET /ssot/data-spaces`; the list ends when `totalSize` names are read.
const DATA_SPACE_PAGE_SIZE = 50;

/**
 * Every data graph provider in a body (`definition: sfdc_cms__dataGraphDataProvider` with
 * `attributes.dataGraphApiName` and `attributes.dataspace`), distinct, in document order.
 * @param {unknown} body - Payload body.
 * @returns {DataGraphReference[]} References.
 */
export function dataGraphReferences(body: unknown): DataGraphReference[] {
  const found = new Map<string, DataGraphReference>();
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!isRecord(value)) return;
    const { attributes } = value;
    if (
      value.definition === PROVIDER &&
      isRecord(attributes) &&
      typeof attributes.dataGraphApiName === 'string' &&
      typeof attributes.dataspace === 'string'
    ) {
      const { dataGraphApiName, dataspace } = attributes;
      found.set(`${dataspace}/${dataGraphApiName}`, { dataGraphApiName, dataspace });
    }
    for (const child of Object.values(value)) visit(child);
  };
  visit(body);
  return [...found.values()];
}

async function readDataSpaces(connection: RequestConnection): Promise<Set<string>> {
  const names = new Set<string>();
  for (let offset = 0; ;) {
    const { data } = await requestJson<unknown>(
      connection,
      getSelectedOperation('data-space.list'),
      { query: { batchSize: DATA_SPACE_PAGE_SIZE, offset } },
    );
    const entries = isRecord(data) ? data.dataSpaces : undefined;
    const total = isRecord(data) ? data.totalSize : undefined;
    if (!Array.isArray(entries) || typeof total !== 'number')
      throw new CmsError('UNEXPECTED_RESPONSE', 'The data space list has no dataSpaces/totalSize');
    for (const entry of entries) if (isRecord(entry)) names.add(String(entry.name));
    offset += entries.length;
    if (offset >= total || entries.length === 0) return names;
  }
}

/**
 * The data space of a data graph.
 * @param {RequestConnection} connection - Org connection.
 * @param {string} name - Data graph API name.
 * @returns {Promise<string | null | undefined>} Its data space; null = no graph of that name;
 *   undefined = the answer names no data space.
 */
async function readDataGraph(
  connection: RequestConnection,
  name: string,
): Promise<string | null | undefined> {
  try {
    const { data } = await requestJson<unknown>(
      connection,
      getSelectedOperation('data-graph.get'),
      {
        path: { dataGraphName: name },
      },
    );
    return isRecord(data) && typeof data.dataspaceName === 'string'
      ? data.dataspaceName
      : undefined;
  } catch (error) {
    // A missing graph answers 400 INTERNAL_ERROR "Data Graph not found with name <name>" (v68).
    if (
      error instanceof CmsRequestError &&
      (error.status === 404 ||
        (error.status === 400 &&
          error.errorCode === 'INTERNAL_ERROR' &&
          error.responseMessage === `Data Graph not found with name ${name}`))
    )
      return null;
    throw error;
  }
}

type Cache = {
  dataSpaces?: Promise<Set<string>>;
  graphs: Map<string, Promise<string | null | undefined>>;
};
const caches = new WeakMap<object, Cache>();

/**
 * Check data graph references against the destination org, read-only: the data space must
 * exist (`GET /ssot/data-spaces`, every page) and the data graph must exist in it
 * (`GET /ssot/data-graphs/{name}`). Reads are cached per connection, so one deploy reads each
 * at most once. Read failures other than a missing graph are thrown.
 * @param {RequestConnection} connection - Destination org connection.
 * @param {DataGraphReference[]} references - References of one component.
 * @returns {Promise<DataGraphBlock[]>} One entry per missing data space or data graph; [] = usable.
 */
export async function checkDataGraphReferences(
  connection: RequestConnection,
  references: DataGraphReference[],
): Promise<DataGraphBlock[]> {
  if (references.length === 0) return [];
  let cache = caches.get(connection);
  if (!cache) {
    cache = { graphs: new Map() };
    caches.set(connection, cache);
  }
  cache.dataSpaces ??= readDataSpaces(connection);
  const dataSpaces = await cache.dataSpaces;
  const blocks: DataGraphBlock[] = [];
  for (const { dataGraphApiName, dataspace } of references) {
    if (!dataSpaces.has(dataspace)) {
      blocks.push({
        code: 'DATA_SPACE_NOT_IN_DESTINATION',
        message: `Data space ${dataspace} (of data graph ${dataGraphApiName}) does not exist in the destination org`,
      });
      continue;
    }
    let graph = cache.graphs.get(dataGraphApiName);
    if (!graph) {
      graph = readDataGraph(connection, dataGraphApiName);
      cache.graphs.set(dataGraphApiName, graph);
    }
    const graphSpace = await graph;
    if (graphSpace === null || (graphSpace !== undefined && graphSpace !== dataspace))
      blocks.push({
        code: 'DATA_GRAPH_NOT_IN_DESTINATION',
        message:
          graphSpace === null
            ? `Data graph ${dataGraphApiName} does not exist in data space ${dataspace} of the destination org`
            : `Data graph ${dataGraphApiName} is in data space ${graphSpace}, not ${dataspace}, in the destination org`,
      });
  }
  return blocks;
}
