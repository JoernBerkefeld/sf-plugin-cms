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
 * Salesforce stores them (a data graph outside `default` carries the data space prefix). A
 * provider without `dataspace` (Expression) counts as `default`.
 */
export type DataGraphReference = { dataGraphApiName: string; dataspace: string };

/**
 * A data graph provider plus the attribute paths the body's merge fields read through it. A path
 * is the related object names (as the graph stores them) down to a field's source name; the root
 * object never appears, so `['ssot__BirthDate__c']` is a field of the root object.
 */
export type DataGraphUsage = DataGraphReference & { paths: string[][] };

/** Why a data graph reference cannot be used in the destination org. */
export type DataGraphBlock = {
  code:
    | 'DATA_SPACE_NOT_IN_DESTINATION'
    | 'DATA_GRAPH_NOT_IN_DESTINATION'
    | 'DATA_GRAPH_ATTRIBUTE_MISSING';
  message: string;
};

const PROVIDER = 'sfdc_cms__dataGraphDataProvider';
const DEFAULT_DATA_SPACE = 'default';
const DEFAULT_EXPRESSION_KEY = '$dataGraph';
// Data spaces per page of `GET /ssot/data-spaces`; the list ends when `totalSize` names are read.
const DATA_SPACE_PAGE_SIZE = 50;

type Provider = DataGraphReference & { expressionKey: string };

function providersOf(body: unknown): Provider[] {
  const found = new Map<string, Provider>();
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
      (typeof attributes.dataspace === 'string' || attributes.dataspace === undefined)
    ) {
      const { dataGraphApiName } = attributes;
      const dataspace = (attributes.dataspace as string | undefined) ?? DEFAULT_DATA_SPACE;
      const expressionKey =
        typeof value.sfdcExpressionKey === 'string'
          ? value.sfdcExpressionKey
          : DEFAULT_EXPRESSION_KEY;
      found.set(`${dataspace}/${dataGraphApiName}`, { dataGraphApiName, dataspace, expressionKey });
    }
    for (const child of Object.values(value)) visit(child);
  };
  visit(body);
  return [...found.values()];
}

/**
 * Every data graph provider in a body (`definition: sfdc_cms__dataGraphDataProvider` with
 * `attributes.dataGraphApiName` and `attributes.dataspace`, or no `dataspace`, which means
 * `default`), distinct, in document order.
 * @param {unknown} body - Payload body.
 * @returns {DataGraphReference[]} References.
 */
export function dataGraphReferences(body: unknown): DataGraphReference[] {
  return providersOf(body).map(({ dataGraphApiName, dataspace }) => ({
    dataGraphApiName,
    dataspace,
  }));
}

/** A handlebars term: a string literal, a bare word or number, or a call `(helper args…)`. */
type Term = { text: string } | { word: string } | Term[];

const TOKEN = /"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|([()])|([^\s()"']+)/gu;
const MUSTACHE = /\{\{\{?([^}]*)\}?\}\}/gu;

function parseTerms(source: string): Term[] {
  const stack: Term[][] = [[]];
  for (const [, double, single, paren, word] of source.matchAll(TOKEN)) {
    const top = stack.at(-1)!;
    if (paren === '(') {
      const call: Term[] = [];
      top.push(call);
      stack.push(call);
    } else if (paren === ')') {
      if (stack.length > 1) stack.pop();
    } else if (word === undefined) top.push({ text: double ?? single });
    else top.push({ word });
  }
  return stack[0];
}

const isWord = (term: Term | undefined, word: string): boolean =>
  term !== undefined && !Array.isArray(term) && 'word' in term && term.word === word;

const textOf = (term: Term | undefined): string | undefined =>
  term !== undefined && !Array.isArray(term) && 'text' in term ? term.text : undefined;

/**
 * Attribute path read from `(get @root "<key>")`: walk out through the calls that take it as
 * first argument; `get` and `map` add their string literal (a numeric index adds nothing), other
 * helpers (`sort` with its field, direction and type, `fallback`, …) add nothing.
 * @param {Term[]} start - The `(get @root "<key>")` call.
 * @param {Term[][]} ancestors - Enclosing calls, outermost first.
 * @returns {string[]} Path.
 */
function pathFrom(start: Term[], ancestors: Term[][]): string[] {
  const path: string[] = [];
  let current = start;
  for (let index = ancestors.length - 1; index >= 0; index -= 1) {
    const parent = ancestors[index];
    if (parent[1] !== current) break;
    const segment = textOf(parent[2]);
    if ((isWord(parent[0], 'get') || isWord(parent[0], 'map')) && segment !== undefined)
      path.push(segment);
    current = parent;
  }
  return path;
}

function handlebarsPaths(source: string, key: string, paths: string[][]): void {
  const ancestors: Term[][] = [];
  const visit = (call: Term[]): void => {
    if (isWord(call[0], 'get') && isWord(call[1], '@root') && textOf(call[2]) === key) {
      paths.push(pathFrom(call, ancestors));
      return;
    }
    ancestors.push(call);
    for (const term of call) if (Array.isArray(term)) visit(term);
    ancestors.pop();
  };
  // The mustache itself is a call: `{{fallback (…) ""}}` reads as `(fallback (…) "")`.
  for (const [, inner] of source.matchAll(MUSTACHE)) visit(parseTerms(inner));
}

/**
 * The attribute paths a body reads through the data graph expression key `key` (`$dataGraph`):
 * in every handlebars mustache (such as a named `sfdc_cms__handlebarExpression`, which block text
 * uses as `{!$Expression.<name>}`), the string literals of `get` and `map` after
 * `(get @root "$dataGraph")`, skipping `sort` arguments and numeric indexes; and the segments of
 * every `{!$dataGraph.<…>}` reference. Distinct, in body order.
 * @param {unknown} body - Payload body.
 * @param {string} [key] - Expression key of the provider.
 * @returns {string[][]} Paths.
 */
export function dataGraphAttributePaths(
  body: unknown,
  key: string = DEFAULT_EXPRESSION_KEY,
): string[][] {
  const paths: string[][] = [];
  const prefix = `{!${key}.`;
  const visit = (value: unknown): void => {
    if (typeof value === 'string') {
      if (value.includes('@root')) handlebarsPaths(value, key, paths);
      for (let start = value.indexOf(prefix); start !== -1; start = value.indexOf(prefix, start)) {
        start += prefix.length;
        const end = value.indexOf('}', start);
        if (end === -1) break;
        paths.push(value.slice(start, end).split('.'));
      }
    } else if (Array.isArray(value)) for (const item of value) visit(item);
    else if (isRecord(value)) for (const child of Object.values(value)) visit(child);
  };
  visit(body);
  const distinct = new Map<string, string[]>();
  for (const path of paths)
    if (path.length > 0 && path.every(Boolean)) distinct.set(JSON.stringify(path), path);
  return [...distinct.values()];
}

/**
 * Every data graph provider of a body with the attribute paths its merge fields read through it
 * (`dataGraphAttributePaths` for the provider's `sfdcExpressionKey`).
 * @param {unknown} body - Payload body.
 * @returns {DataGraphUsage[]} Usages, in document order.
 */
export function dataGraphUsages(body: unknown): DataGraphUsage[] {
  return providersOf(body).map(({ dataGraphApiName, dataspace, expressionKey }) => ({
    dataGraphApiName,
    dataspace,
    paths: dataGraphAttributePaths(body, expressionKey),
  }));
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

/** A data graph as read: its data space (undefined = not named) and its root object, if any. */
type GraphRead = { dataspace?: string; sourceObject?: Record<string, unknown> };

/**
 * One data graph definition.
 * @param {RequestConnection} connection - Org connection.
 * @param {string} name - Data graph API name.
 * @returns {Promise<GraphRead | null>} The graph; null = no graph of that name.
 */
async function readDataGraph(
  connection: RequestConnection,
  name: string,
): Promise<GraphRead | null> {
  try {
    const { data } = await requestJson<unknown>(
      connection,
      getSelectedOperation('data-graph.get'),
      {
        path: { dataGraphName: name },
      },
    );
    if (!isRecord(data)) return {};
    return {
      dataspace: typeof data.dataspaceName === 'string' ? data.dataspaceName : undefined,
      sourceObject: isRecord(data.sourceObject) ? data.sourceObject : undefined,
    };
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

const recordsOf = (value: unknown): Array<Record<string, unknown>> =>
  Array.isArray(value) ? value.filter((item) => isRecord(item)) : [];

/**
 * Whether a graph has an attribute path: each segment but the last names a related object
 * (`relatedObjects[].name`) of the object before it; the last names one of its fields
 * (`fields[].sourceFieldName`) or a related object.
 * @param {Record<string, unknown>} root - The graph's `sourceObject`.
 * @param {string[]} path - Attribute path.
 * @returns {boolean} True when the graph has it.
 */
function hasPath(root: Record<string, unknown>, path: string[]): boolean {
  let current = root;
  for (const [index, segment] of path.entries()) {
    const related = recordsOf(current.relatedObjects).find((object) => object.name === segment);
    if (related) {
      current = related;
      continue;
    }
    return (
      index === path.length - 1 &&
      recordsOf(current.fields).some((field) => field.sourceFieldName === segment)
    );
  }
  return true;
}

type Cache = {
  dataSpaces?: Promise<Set<string>>;
  graphs: Map<string, Promise<GraphRead | null>>;
};
const caches = new WeakMap<object, Cache>();

/**
 * Check data graph references against the destination org, read-only: the data space must
 * exist (`GET /ssot/data-spaces`, every page), the data graph must exist in it and hold every
 * attribute path of the usage (`GET /ssot/data-graphs/{name}`). Reads are cached per connection
 * (one in-flight read per name), so one deploy reads each at most once. Read failures other than
 * a missing graph are thrown.
 * @param {RequestConnection} connection - Destination org connection.
 * @param {Array<DataGraphReference | DataGraphUsage>} references - References (with paths) of one component.
 * @returns {Promise<DataGraphBlock[]>} One entry per missing data space, data graph or set of
 *   attributes; [] = usable.
 */
export async function checkDataGraphReferences(
  connection: RequestConnection,
  references: Array<DataGraphReference | DataGraphUsage>,
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
  for (const reference of references) {
    const { dataGraphApiName, dataspace } = reference;
    if (!dataSpaces.has(dataspace)) {
      blocks.push({
        code: 'DATA_SPACE_NOT_IN_DESTINATION',
        message: `Data space ${dataspace} (of data graph ${dataGraphApiName}) does not exist in the destination org`,
      });
      continue;
    }
    let pending = cache.graphs.get(dataGraphApiName);
    if (!pending) {
      pending = readDataGraph(connection, dataGraphApiName);
      cache.graphs.set(dataGraphApiName, pending);
    }
    const graph = await pending;
    if (graph === null || (graph.dataspace !== undefined && graph.dataspace !== dataspace)) {
      blocks.push({
        code: 'DATA_GRAPH_NOT_IN_DESTINATION',
        message:
          graph === null
            ? `Data graph ${dataGraphApiName} does not exist in data space ${dataspace} of the destination org`
            : `Data graph ${dataGraphApiName} is in data space ${graph.dataspace}, not ${dataspace}, in the destination org`,
      });
      continue;
    }
    const paths = 'paths' in reference ? reference.paths : [];
    if (paths.length === 0) continue;
    const root = graph.sourceObject;
    if (!root)
      throw new CmsError(
        'UNEXPECTED_RESPONSE',
        `Data graph ${dataGraphApiName} was read without a sourceObject`,
      );
    const missing = paths.filter((path) => !hasPath(root, path));
    if (missing.length > 0)
      blocks.push({
        code: 'DATA_GRAPH_ATTRIBUTE_MISSING',
        message: `Data graph ${dataGraphApiName} in data space ${dataspace} of the destination org lacks ${missing.map((path) => path.join('.')).join(', ')}`,
      });
  }
  return blocks;
}
