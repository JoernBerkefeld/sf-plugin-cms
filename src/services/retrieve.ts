import { referencedContentKeys } from '../content/json-projection.js';
import { cliTypeName, handlerOf, HANDLERS } from '../content/registry.js';
import { writeSourceFiles } from '../content/source-files.js';
import type { ContentTypeHandler, LogicalReference, NativeVariant } from '../content/types.js';
import { CmsError, toDiagnostic, type Diagnostic } from '../errors/registry.js';
import {
  getSelectedOperation,
  isRecord,
  requestJson,
  type RequestConnection,
} from '../transport/json-request.js';
import { folderPathCache, sameId } from './folders.js';
import { inventoryOf, variantsByContentKey, type InventoryItem } from './inventory.js';
import type { CmsWorkspace } from './workspaces.js';

// Variant reads in flight at once.
const READS_IN_FLIGHT = 4;

/** What `-m` selected for one type: every component, or the named ones. */
export type TypeSelection = { handler: ContentTypeHandler; apiNames: string[] | 'all' };

/**
 * Parse `-m` values into one selection per type, in registry order; no value selects every
 * component of every type.
 * @param {string[] | undefined} values - `-m type` / `-m type:ApiName` values.
 * @returns {TypeSelection[]} Selections.
 */
export function parseSelection(values: string[] | undefined): TypeSelection[] {
  if (!values || values.length === 0)
    return HANDLERS.map((handler) => ({ handler, apiNames: 'all' }));
  const byType = new Map<string, Set<string> | 'all'>();
  for (const value of values) {
    const match = /^([\w-]+)(?::(.+))?$/u.exec(value.trim());
    if (!match) throw new CmsError('INVALID_SELECTOR', `Not type or type:ApiName: ${value}`);
    const [, type, apiName] = match;
    handlerOf(type);
    const current = byType.get(type);
    if (apiName === undefined) byType.set(type, 'all');
    else if (current !== 'all') byType.set(type, (current ?? new Set()).add(apiName));
  }
  return HANDLERS.filter((handler) => byType.has(handler.type)).map((handler) => {
    const names = byType.get(handler.type)!;
    return { handler, apiNames: names === 'all' ? 'all' : [...names].toSorted() };
  });
}

/** One retrieved component. */
export type RetrievedItem = {
  type: string;
  apiName: string;
  outcome: 'retrieved' | 'unchanged';
  path: string;
  companionPaths: string[];
};

/** Content key <-> logical reference lookup of one workspace. */
export type ReferenceResolver = {
  load: (keys: string[]) => Promise<void>;
  referenceOf: (key: string) => LogicalReference | undefined;
};

/** Warnings and errors a run collects (the command envelope's diagnostics). */
export type Diagnostics = { warnings: Diagnostic[]; errors: Diagnostic[] };

/** What one component's read and write produced. */
type ItemOutcome =
  { warnings: Diagnostic[]; item: RetrievedItem } | { warnings: Diagnostic[]; error: Diagnostic };

/** Result of a retrieve run. */
export type RetrieveResult = {
  workspace: { id: string; apiName: string | null };
  outputDirectory: string;
  items: RetrievedItem[];
};

/**
 * Run `work` over `items` with at most `limit` in flight; results keep the input order.
 * @template T, R
 * @param {T[]} items - Inputs.
 * @param {number} limit - Concurrency.
 * @param {(item: T) => Promise<R>} work - Task.
 * @returns {Promise<R[]>} Results.
 */
async function inPool<T, R>(
  items: T[],
  limit: number,
  work: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = Array.from({ length: items.length });
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await work(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

/**
 * Content key -> logical reference, filled from SOQL as bodies name new keys. Only components
 * of the same workspace resolve.
 * @param {RequestConnection} connection - Org connection.
 * @param {CmsWorkspace} workspace - Workspace.
 * @returns {ReferenceResolver} `load(keys)` and `referenceOf(key)`.
 */
export function referenceResolver(
  connection: RequestConnection,
  workspace: CmsWorkspace,
): ReferenceResolver {
  const known = new Map<string, LogicalReference | null>();
  return {
    async load(keys: string[]): Promise<void> {
      const missing = keys.filter((key) => !known.has(key));
      if (missing.length === 0) return;
      for (const key of missing) known.set(key, null);
      for (const row of await variantsByContentKey(connection, missing))
        if (
          row.contentKey &&
          row.apiName &&
          row.contentType &&
          sameId(row.workspaceId, workspace.id)
        )
          known.set(row.contentKey, { type: cliTypeName(row.contentType), apiName: row.apiName });
    },
    referenceOf: (key: string): LogicalReference | undefined => known.get(key) ?? undefined,
  };
}

/**
 * Retrieve the selected components of one workspace into `cms/<workspace>/<type>/`. Lenient:
 * a component that fails is reported and the others continue. Only the default variant is
 * written; other variants give OTHER_VARIANTS_SKIPPED.
 * @param {RequestConnection} connection - Org connection.
 * @param {CmsWorkspace} workspace - Source workspace.
 * @param {TypeSelection[]} selection - Parsed `-m`.
 * @param {string} outputDirectory - Project directory.
 * @param {Diagnostics} diagnostics - Collected diagnostics.
 * @returns {Promise<RetrievedItem[]>} Written components, in selection order.
 */
export async function retrieveComponents(
  connection: RequestConnection,
  workspace: CmsWorkspace,
  selection: TypeSelection[],
  outputDirectory: string,
  diagnostics: Diagnostics,
): Promise<RetrievedItem[]> {
  const workspaceFolder = workspace.apiName ?? workspace.id;
  const folderPath = folderPathCache(connection, workspace);
  const references = referenceResolver(connection, workspace);
  const items: RetrievedItem[] = [];
  for (const { handler, apiNames } of selection) {
    let inventory: InventoryItem[];
    try {
      inventory = await inventoryOf(connection, workspace, handler.apiName, apiNames);
    } catch (error) {
      diagnostics.errors.push({ ...toDiagnostic(error), component: handler.type });
      continue;
    }
    if (apiNames !== 'all')
      for (const name of apiNames)
        if (!inventory.some((item) => item.apiName === name))
          diagnostics.errors.push({
            ...toDiagnostic(
              new CmsError(
                'COMPONENT_NOT_FOUND',
                `No ${handler.apiName} with API name ${name} in workspace ${workspaceFolder}`,
              ),
            ),
            component: `${handler.type}:${name}`,
          });
    const outcomes = await inPool(
      inventory,
      READS_IN_FLIGHT,
      async (item): Promise<ItemOutcome> => {
        const component = `${handler.type}:${item.apiName}`;
        const warnings: Diagnostic[] = [];
        try {
          if (!item.defaultVariant)
            throw new CmsError(
              'NO_DEFAULT_VARIANT',
              `None of the variants (${item.otherVariants.map((v) => v.language ?? v.name).join(', ')}) is primary or in ${workspace.defaultLanguage ?? 'the default language'}`,
            );
          if (item.otherVariants.length > 0)
            warnings.push({
              ...toDiagnostic(
                new CmsError(
                  'OTHER_VARIANTS_SKIPPED',
                  `Wrote the default variant (${item.defaultVariant.language ?? 'default'}) only; skipped: ${item.otherVariants
                    .map((variant) =>
                      variant.language && variant.language !== item.defaultVariant!.language
                        ? variant.language
                        : (variant.name ?? variant.id),
                    )
                    .join(', ')}`,
                ),
              ),
              component,
            });
          const { data } = await requestJson<unknown>(
            connection,
            getSelectedOperation('variant.get'),
            {
              path: { variantId: item.defaultVariant.id },
            },
          );
          if (!isRecord(data))
            throw new CmsError(
              'UNEXPECTED_RESPONSE',
              `Variant ${item.defaultVariant.id} is not an object`,
            );
          const native = data as NativeVariant;
          await references.load(referencedContentKeys(native.contentBody));
          const files = handler.toSource(native, {
            workspace,
            folderPath: await folderPath(
              isRecord(native.folder) ? String(native.folder.id) : undefined,
            ),
            referenceOf: references.referenceOf,
            warn: (warning) =>
              warnings.push({
                ...toDiagnostic(new CmsError(warning.code, warning.message)),
                ...warning,
                component,
              }),
          });
          const written = await writeSourceFiles(outputDirectory, workspaceFolder, files);
          return {
            warnings,
            item: { type: handler.type, apiName: files.document.apiName, ...written },
          };
        } catch (error) {
          return { warnings, error: { ...toDiagnostic(error), component } };
        }
      },
    );
    for (const outcome of outcomes) {
      diagnostics.warnings.push(...outcome.warnings);
      if ('error' in outcome) diagnostics.errors.push(outcome.error);
      else items.push(outcome.item);
    }
  }
  return items;
}
