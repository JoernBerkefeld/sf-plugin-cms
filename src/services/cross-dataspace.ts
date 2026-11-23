import {
  DataSpaceListError,
  dmoCandidates,
  fieldCandidates,
  pairedByRulesets,
  placeDmo,
  translateFieldName,
  translateUniqueName,
  type OrgDataSpace,
  type RulesetEntry,
} from 'salesforce-data360-rules';
import type { SourceFiles } from '../content/types.js';
import { CmsError } from '../errors/registry.js';
import { CmsRequestError, isRecord, type RequestConnection } from '../transport/json-request.js';
import {
  checkDataGraphReferences,
  dataGraphAttributePaths,
  dataGraphProviders,
  mergeFieldSites,
  orgDataGraph,
  orgDataSpaces,
  orgRulesets,
  recordsOf,
} from './data-graph-check.js';

const PROVIDER = 'sfdc_cms__dataGraphDataProvider';
const DEFAULT_DATA_SPACE = 'default';

/** What a cross-data-space deploy did to one component's files. */
export type DataSpaceRenaming = {
  /** The files with every data graph provider and merge-field path in the target spelling. */
  files: SourceFiles;
  /**
   * Every rename, for preview and the result: `data graph A -> B`, `data space a -> b`,
   * `merge field x.y -> x2.y2` (only paths whose spelling changes).
   */
  renames: string[];
};

/**
 * The source and target data space of one provider, with the org's prefixes and, when a path
 * names an identity resolution output, the org's ruleset list.
 */
type Direction = {
  from: string;
  to: string;
  spaces: readonly OrgDataSpace[];
  rulesets?: readonly RulesetEntry[];
};

type GraphNode = Record<string, unknown>;

/**
 * A possible source name of an object of the target graph. `unified`: the name was paired with the
 * target object from the ruleset list, so its fields follow the identity resolution output's
 * field rule.
 */
type Owner = { name: string; unified?: boolean };

const unresolved = (component: string, message: string): CmsError =>
  new CmsError('CROSS_DATASPACE_UNRESOLVED', `${component}: ${message}`);

/**
 * A name still spelled as in another data space than the target: it holds `ssot__` towards a
 * non-default data space, or the prefix of a data space other than the target.
 * @param {Direction} direction - Source, target and prefixes.
 * @param {string} name - Name after renaming.
 * @returns {boolean} Whether the name keeps a foreign spelling.
 */
function keepsOldSpelling(direction: Direction, name: string): boolean {
  if (direction.to !== DEFAULT_DATA_SPACE && name.includes('ssot__')) return true;
  return direction.spaces.some(
    (space) =>
      space.prefix !== undefined &&
      space.name !== direction.to &&
      name.startsWith(`${space.prefix}_`),
  );
}

/**
 * Whether the ruleset list is needed: the target graph's root or a path segment is an identity
 * resolution output (`Unified…`), which the package pairs only from the ruleset list.
 * @param {Direction} direction - Source, target and prefixes.
 * @param {string} rootName - The target graph's root object.
 * @param {string[][]} paths - Paths in the source spelling.
 * @returns {boolean} Whether to read the rulesets.
 */
function needsRulesets(direction: Direction, rootName: string, paths: string[][]): boolean {
  const { from, to, spaces } = direction;
  return (
    pairedByRulesets({ source: to, target: from, spaces }, rootName) ||
    paths.some((path) =>
      path.some((segment) => pairedByRulesets({ source: from, target: to, spaces }, segment)),
    )
  );
}

/**
 * The names an identity resolution output of `from` has in `to`, from the ruleset list: the
 * package's placement (`placeDmo`), and every output of a ruleset of `to` that the package places
 * back onto the name. The second way covers the direction whose entity the rules cannot place
 * (`ds2_Individual__dlm` towards `default`).
 * @param {Direction} direction - Prefixes and the ruleset list.
 * @param {string} name - Output name in `from`.
 * @param {string} from - Data space of the name.
 * @param {string} to - Data space to name it in.
 * @returns {{names: string[]} | {reason: string}} The paired names, or why there are none.
 */
function pairedNames(
  direction: Direction,
  name: string,
  from: string,
  to: string,
): { names: string[] } | { reason: string } {
  const { spaces } = direction;
  const rulesets = direction.rulesets ?? [];
  const names = new Set<string>();
  const placed = placeDmo({ source: from, target: to, spaces, rulesets }, name);
  if (!('reason' in placed)) names.add(placed.name);
  for (const ruleset of rulesets) {
    if (ruleset.dataSpace !== to) continue;
    for (const output of ruleset.outputs)
      for (const candidate of [output.unified, output.link]) {
        if (candidate === undefined) continue;
        const back = placeDmo({ source: to, target: from, spaces, rulesets }, candidate);
        if (!('reason' in back) && back.name === name) names.add(candidate);
      }
  }
  if (names.size > 0) return { names: [...names] };
  return {
    reason: `${'reason' in placed ? placed.reason : 'no ruleset pairs it'}, and no identity resolution ruleset of ${to} has an output that is ${name} in ${from}`,
  };
}

/**
 * The names an object of the target graph can have in the source data space (the root object is
 * never named in a path, so its source name comes from the target's): the rules' candidates and,
 * for an identity resolution output, the ruleset list's pairing.
 * @param {Direction} direction - Source, target, prefixes and rulesets.
 * @param {string} targetName - DMO name in the target graph.
 * @returns {{owners: Owner[]} | {reason: string}} Possible source names, or why an output is unpaired.
 */
function sourceNamesOf(
  direction: Direction,
  targetName: string,
): { owners: Owner[] } | { reason: string } {
  const { from, to, spaces } = direction;
  const owners: Owner[] = dmoCandidates(targetName, to, from, spaces).map((candidate) => ({
    name: candidate.name,
  }));
  if (!pairedByRulesets({ source: to, target: from, spaces }, targetName)) return { owners };
  const paired = pairedNames(direction, targetName, to, from);
  if ('reason' in paired)
    return { reason: `${targetName} (the root of the target graph): ${paired.reason}` };
  for (const name of paired.names) owners.push({ name, unified: true });
  return { owners };
}

/**
 * The names a field can have on an object of the target graph, from one possible source name of
 * that object. A ruleset-paired owner is an identity resolution output: its fields follow the
 * package's field rule for outputs (as for a standard object's copy).
 * @param {Direction} direction - Source, target and prefixes.
 * @param {string} field - Field name in the source spelling.
 * @param {Owner} owner - Possible source name of the object.
 * @param {string} objectName - The object's name in the target graph.
 * @returns {string[]} Possible field names.
 */
function fieldNamesOn(
  direction: Direction,
  field: string,
  owner: Owner,
  objectName: string,
): string[] {
  const { from, to, spaces } = direction;
  const candidates = fieldCandidates(field, owner.name, from, to, spaces);
  if (!owner.unified)
    return candidates
      .filter((candidate) => candidate.owner.name === objectName)
      .map((candidate) => candidate.name);
  const byRule = candidates
    .filter((candidate) => candidate.owner.kind === 'unified')
    .map((candidate) => candidate.name);
  // An output of the oldest default ruleset has no rule shape; from default the field rule does
  // not depend on the kind.
  return byRule.length > 0
    ? byRule
    : [translateFieldName({ source: from, target: to, spaces }, 'unified', field).name];
}

/**
 * Place one merge-field path in the target graph, segment by segment: a related object segment
 * among the related objects of the object before it, the last segment also among that object's
 * fields. Each segment needs exactly one candidate of the rules that the target graph has.
 * @param {Direction} direction - Source, target and prefixes.
 * @param {GraphNode} root - The target graph's `sourceObject`.
 * @param {string[]} path - Path in the source spelling.
 * @returns {{path: string[]} | {reason: string}} The path in the target spelling, or why not.
 */
function placePath(
  direction: Direction,
  root: GraphNode,
  path: string[],
): { path: string[] } | { reason: string } {
  const { from, to, spaces } = direction;
  const placed: string[] = [];
  let current = root;
  const rootOwners = sourceNamesOf(direction, String(root.name));
  if ('reason' in rootOwners) return rootOwners;
  let owners = rootOwners.owners;
  for (const [index, segment] of path.entries()) {
    const last = index === path.length - 1;
    const objects = recordsOf(current.relatedObjects);
    const fields = recordsOf(current.fields);
    const at = `${segment} (in ${[String(root.name), ...placed].join('.')})`;
    const paired = new Set<string>();
    if (pairedByRulesets({ source: from, target: to, spaces }, segment)) {
      const pairing = pairedNames(direction, segment, from, to);
      if ('reason' in pairing) return { reason: `${at}: ${pairing.reason}` };
      for (const name of pairing.names) paired.add(name);
    }
    const considered = new Set<string>();
    const found = new Map<string, GraphNode | undefined>();
    const objectNames = dmoCandidates(segment, from, to, spaces).map((candidate) => candidate.name);
    for (const name of [...objectNames, ...paired]) {
      considered.add(name);
      const object = objects.find((entry) => entry.name === name);
      if (object) found.set(name, object);
    }
    if (last)
      for (const owner of owners)
        for (const name of fieldNamesOn(direction, segment, owner, String(current.name))) {
          considered.add(name);
          if (fields.some((field) => field.sourceFieldName === name))
            found.set(name, found.get(name));
        }
    if (found.size !== 1) {
      const names = [...considered];
      if (found.size > 1)
        return {
          reason: `${at} matches several names of the target graph: ${[...found.keys()].join(', ')}; the rules cannot tell which one it is`,
        };
      const asIs =
        objects.some((entry) => entry.name === segment) ||
        (last && fields.some((field) => field.sourceFieldName === segment));
      if (asIs && !names.includes(segment))
        return {
          reason: `${at}: the target graph holds it spelled as in ${from} (it would build and stay empty); rebuild the graph in the ${to} spelling (${names.join(', ') || 'no rule places the name'})`,
        };
      return {
        reason: `${at} is not in the target graph as ${names.length > 0 ? names.join(' or ') : 'any name (no rule places it)'}`,
      };
    }
    const [[name, object]] = found;
    placed.push(name);
    if (object) {
      current = object;
      owners = [{ name: segment, unified: paired.has(name) }];
    } else if (!last) return { reason: `${at} is a field, but the path goes on` };
  }
  const left = placed.find((name) => keepsOldSpelling(direction, name));
  if (left !== undefined)
    return { reason: `${left} is still spelled as in ${from} after the renaming` };
  return { path: placed };
}

/**
 * The org's ruleset list for a path with an identity resolution output; a failed read refuses the
 * component, since only the list pairs such a name (an expired session is thrown as it is).
 * @param {RequestConnection} connection - Destination org connection.
 * @param {string} component - `type:ApiName`, for messages.
 * @param {string} graph - Target data graph, for messages.
 * @returns {Promise<RulesetEntry[]>} Rulesets of every data space.
 */
async function rulesetsFor(
  connection: RequestConnection,
  component: string,
  graph: string,
): Promise<RulesetEntry[]> {
  try {
    return await orgRulesets(connection);
  } catch (error) {
    if (error instanceof CmsRequestError && error.status === 401) throw error;
    throw unresolved(
      component,
      `data graph ${graph} uses an identity resolution output (Unified…), and the identity resolution ruleset list (GET /ssot/identity-resolutions) that pairs it with its ruleset could not be read: ${error instanceof Error ? error.message : String(error)}; nothing was written, rerun the deploy`,
    );
  }
}

/**
 * Replace the names of every merge-field site in a string whose path has a new spelling, from
 * the end so that earlier offsets stay valid. Everything else stays byte for byte.
 * @param {string} value - String of the files.
 * @param {string} key - Expression key of the provider.
 * @param {Map<string, string[]>} renamed - New path per source path (`JSON.stringify`).
 * @returns {string} The string with the new names.
 */
function rewrite(value: string, key: string, renamed: Map<string, string[]>): string {
  const edits: Array<{ start: number; length: number; name: string }> = [];
  for (const site of mergeFieldSites(value, key)) {
    const target = renamed.get(JSON.stringify(site.path));
    if (!target) continue;
    for (const [index, start] of site.starts.entries())
      if (target[index] !== site.path[index])
        edits.push({ start, length: site.path[index].length, name: target[index] });
  }
  edits.sort((left, right) => right.start - left.start);
  let result = value;
  for (const { start, length, name } of edits)
    result = `${result.slice(0, start)}${name}${result.slice(start + length)}`;
  return result;
}

function mapStrings(value: unknown, change: (text: string) => string): unknown {
  if (typeof value === 'string') return change(value);
  if (Array.isArray(value)) return value.map((item) => mapStrings(item, change));
  if (isRecord(value))
    return Object.fromEntries(
      Object.entries(value).map(([name, child]) => [name, mapStrings(child, change)]),
    );
  return value;
}

function hasProviderWithoutDataSpace(value: unknown): boolean {
  if (Array.isArray(value)) return value.some((item) => hasProviderWithoutDataSpace(item));
  if (!isRecord(value)) return false;
  const { attributes } = value;
  if (value.definition === PROVIDER && isRecord(attributes) && attributes.dataspace === undefined)
    return true;
  return Object.values(value).some((child) => hasProviderWithoutDataSpace(child));
}

function renameProviders(
  value: unknown,
  graphs: Map<string, { dataGraphApiName: string; dataspace: string }>,
): unknown {
  if (Array.isArray(value)) return value.map((item) => renameProviders(item, graphs));
  if (!isRecord(value)) return value;
  const copy = Object.fromEntries(
    Object.entries(value).map(([name, child]) => [name, renameProviders(child, graphs)]),
  );
  const { attributes } = value;
  if (value.definition === PROVIDER && isRecord(attributes)) {
    const dataspace =
      typeof attributes.dataspace === 'string' ? attributes.dataspace : DEFAULT_DATA_SPACE;
    const next = graphs.get(`${dataspace}/${String(attributes.dataGraphApiName)}`);
    if (next)
      copy.attributes = {
        ...(copy.attributes as Record<string, unknown>),
        dataGraphApiName: next.dataGraphApiName,
        dataspace: next.dataspace,
      };
  }
  return copy;
}

/**
 * Cross-data-space deploy of one component (`--dataspace`): every data graph provider whose data
 * space is not `target` is renamed into it, the data graph by the prefix rule and each merge-field
 * path segment by segment against the target graph (the package's candidates; exactly one must
 * exist at each position). The names are replaced in place in the handlebars string literals and
 * `{!<key>.…}` references; nothing else changes. An identity resolution output (`Unified…`) is
 * paired from the org's ruleset list, read only when a path or the target root names one.
 * Read-only: the data space list, the target graph and the ruleset list are read once per
 * connection (shared with the attribute check).
 * @param {RequestConnection} connection - Destination org connection.
 * @param {SourceFiles} files - The component's files.
 * @param {object} options - Options.
 * @param {string} options.target - Target data space (`--dataspace`).
 * @param {boolean} options.allowCrossDataspace - Whether `--allow-cross-dataspace` was given.
 * @param {string} options.component - `type:ApiName`, for messages.
 * @returns {Promise<DataSpaceRenaming>} Renamed files and the renames; the files unchanged when
 *   every provider is in `target` already.
 * @throws {CmsError} CROSS_DATASPACE_NOT_ALLOWED without the flag; CROSS_DATASPACE_UNRESOLVED
 *   when a name cannot be placed; the attribute check's code when the target graph is missing.
 */
export async function renameIntoDataSpace(
  connection: RequestConnection,
  files: SourceFiles,
  options: { target: string; allowCrossDataspace: boolean; component: string },
): Promise<DataSpaceRenaming> {
  const { target, component } = options;
  const textCompanions = Object.fromEntries(
    Object.entries(files.companions).filter(([, content]) => typeof content === 'string'),
  );
  const scanned = { document: files.document, companions: textCompanions };
  const foreign = dataGraphProviders(files.document.contentBody).filter(
    (provider) => provider.dataspace !== target,
  );
  if (foreign.length === 0) return { files, renames: [] };
  if (!options.allowCrossDataspace)
    throw new CmsError(
      'CROSS_DATASPACE_NOT_ALLOWED',
      `${component} reads data graph ${foreign.map((p) => `${p.dataGraphApiName} of data space ${p.dataspace}`).join(', ')}, not of --dataspace ${target}; add --allow-cross-dataspace (-c) to rename it into ${target}`,
    );
  // An Expression's provider names no data space and Salesforce reads it in default; whether
  // one with a data space is accepted is not known, so it is not renamed (nothing is guessed).
  if (hasProviderWithoutDataSpace(files.document.contentBody))
    throw unresolved(
      component,
      `its data graph provider names no data space (read as ${DEFAULT_DATA_SPACE}), so it cannot be moved into ${target}`,
    );
  const spaces = await orgDataSpaces(connection);
  const graphs = new Map<string, { dataGraphApiName: string; dataspace: string }>();
  const renames: string[] = [];
  const byKey = new Map<string, Map<string, string[]>>();
  for (const provider of foreign) {
    const { dataGraphApiName, dataspace: from, expressionKey } = provider;
    let direction: Direction = { from, to: target, spaces };
    const graph = translateUniqueName({ source: from, target, spaces }, dataGraphApiName);
    if ('reason' in graph)
      throw unresolved(
        component,
        `data graph ${dataGraphApiName} of ${from} cannot be named in ${target}: ${graph.reason}`,
      );
    const blocks = await checkDataGraphReferences(connection, [
      { dataGraphApiName: graph.name, dataspace: target },
    ]);
    if (blocks.length > 0) throw new CmsError(blocks[0].code, blocks[0].message);
    const read = await orgDataGraph(connection, graph.name);
    const root = read?.sourceObject;
    const paths = dataGraphAttributePaths(scanned, expressionKey);
    if (paths.length > 0 && !root)
      throw new CmsError(
        'UNEXPECTED_RESPONSE',
        `Data graph ${graph.name} was read without a sourceObject`,
      );
    if (root && paths.length > 0 && needsRulesets(direction, String(root.name), paths))
      direction = { ...direction, rulesets: await rulesetsFor(connection, component, graph.name) };
    graphs.set(`${from}/${dataGraphApiName}`, { dataGraphApiName: graph.name, dataspace: target });
    if (graph.name !== dataGraphApiName)
      renames.push(`data graph ${dataGraphApiName} -> ${graph.name}`);
    renames.push(`data space ${from} -> ${target}`);
    const renamed = byKey.get(expressionKey) ?? new Map<string, string[]>();
    byKey.set(expressionKey, renamed);
    const failures: string[] = [];
    for (const path of paths) {
      let result: ReturnType<typeof placePath>;
      try {
        result = placePath(direction, root!, path);
      } catch (error) {
        if (!(error instanceof DataSpaceListError)) throw error;
        result = { reason: error.message };
      }
      if ('reason' in result) {
        failures.push(`${path.join('.')}: ${result.reason}`);
        continue;
      }
      renamed.set(JSON.stringify(path), result.path);
      if (result.path.join('.') !== path.join('.'))
        renames.push(`merge field ${path.join('.')} -> ${result.path.join('.')}`);
    }
    if (failures.length > 0)
      throw unresolved(
        component,
        `merge fields of data graph ${dataGraphApiName} (${from}) cannot be placed in ${graph.name} (${target}): ${failures.join('; ')}`,
      );
  }
  const change = (text: string): string => {
    let result = text;
    for (const [key, renamed] of byKey) result = rewrite(result, key, renamed);
    return result;
  };
  const document = mapStrings(
    { ...files.document, contentBody: renameProviders(files.document.contentBody, graphs) },
    change,
  ) as SourceFiles['document'];
  const companions = Object.fromEntries(
    Object.entries(files.companions).map(([suffix, content]) => [
      suffix,
      typeof content === 'string' ? change(content) : content,
    ]),
  );
  return { files: { ...files, document, companions }, renames };
}
