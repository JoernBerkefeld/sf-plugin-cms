import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { referencedContentKeys } from '../content/json-projection.js';
import { handlerOf } from '../content/registry.js';
import { SOURCE_ROOT, typeDirectory } from '../content/source-files.js';
import type { ContentTypeHandler } from '../content/types.js';
import { CmsError, toDiagnostic, type Diagnostic } from '../errors/registry.js';
import {
  CmsRequestError,
  getSelectedOperation,
  isRecord,
  requestJson,
  type RequestConnection,
} from '../transport/json-request.js';
import {
  requestEmptyMutation,
  requestJsonMutation,
  type JsonMutationOptions,
} from '../transport/json-mutation.js';
import type { WriteConnection } from '../transport/one-shot-connection.js';
import {
  componentOfFile,
  referenceOrder,
  registryRank,
  SELECTOR,
  type Located,
} from './deploy-selection.js';
import { inventoryOf, type InventoryItem } from './inventory.js';
import { localFilePresent, removeLocalFiles, type LocalFileRemoval } from './local-file-removal.js';
import type { Diagnostics } from './retrieve.js';
import type { CmsWorkspace } from './workspaces.js';

/** The three commands that change a component's state in the org. */
export type LifecycleAction = 'delete' | 'publish' | 'unpublish';

/**
 * Per-component outcome. Preview: delete, publish, unpublish, unchanged, blocked. Run: deleted,
 * published, unpublished, unchanged, blocked, failed, unknown, not-attempted.
 */
export type LifecycleOutcome =
  | LifecycleAction
  | 'deleted'
  | 'published'
  | 'unpublished'
  | 'unchanged'
  | 'blocked'
  | 'failed'
  | 'unknown'
  | 'not-attempted';

/** One component named for a lifecycle command. */
export type LifecycleTarget = {
  handler: ContentTypeHandler;
  apiName: string;
  /** Where `--source-dir` found it; `-m` components use the destination's workspace folder. */
  local?: { baseDirectory: string; workspaceFolder: string };
};

/** One component of a lifecycle result. */
export type LifecycleItem = {
  type: string;
  apiName: string;
  outcome: LifecycleOutcome;
  /** Code of the reason for blocked, failed, unknown or not-attempted. */
  reason?: string;
  managedContentId?: string;
  variantId?: string;
  contentKey?: string;
  /** Publish (preview and run): what the publish does beyond the CMS (handler `publishNote`). */
  note?: string;
  /** Publish state read back after publish/unpublish. */
  isPublished?: boolean;
  /** Salesforce's answer to publish/unpublish (`deploymentId`, `publishDate`, …). */
  answer?: Record<string, unknown>;
  /** Preview of a delete: the local files the delete would remove. */
  localFiles?: Array<{ path: string; exists: boolean }>;
  /** After a confirmed delete: what happened to each local file. */
  removedLocalFiles?: LocalFileRemoval[];
};

/** Result of a lifecycle run. */
export type LifecycleResult = {
  workspace: { id: string; apiName: string | null };
  preview: boolean;
  items: LifecycleItem[];
};

/** Options of one lifecycle run. */
export type LifecycleOptions = {
  preview: boolean;
  diagnostics: Diagnostics;
  /** Delete only: keep the local files of deleted components. */
  keepLocalFiles?: boolean;
  /** Directory holding `cms/` for `-m` components. */
  projectDirectory: string;
  writeOptions?: JsonMutationOptions;
  /**
   * Receives the items once planned, before anything is written; the run updates them in
   * place, so a caller that keeps them still reports every outcome if the run throws later.
   */
  onPlanned?: (items: LifecycleItem[]) => void;
};

const WILDCARD = /[*?[\]{}]/u;

/**
 * The exact components named by `-m type:ApiName` and `--source-dir` component files. A bare
 * type, a wildcard, a folder or nothing at all is refused; this runs before any org access.
 * @param {string[] | undefined} selectors - `-m` values.
 * @param {string[] | undefined} sourcePaths - `-d` values (component files).
 * @param {LifecycleAction} action - Command, for messages.
 * @returns {Promise<LifecycleTarget[]>} Distinct components in registry order, then API name.
 */
export async function parseExactSelection(
  selectors: string[] | undefined,
  sourcePaths: string[] | undefined,
  action: LifecycleAction,
): Promise<LifecycleTarget[]> {
  const refuse = (what: string): CmsError =>
    new CmsError(
      'EXACT_SELECTOR_REQUIRED',
      `${action} needs exact components (-m type:ApiName or a --source-dir component file), not ${what}`,
    );
  const targets = new Map<string, LifecycleTarget>();
  const add = (target: LifecycleTarget): void => {
    const key = `${target.handler.type}:${target.apiName}`;
    const seen = targets.get(key);
    if (
      seen?.local &&
      target.local &&
      (seen.local.workspaceFolder !== target.local.workspaceFolder ||
        path.resolve(seen.local.baseDirectory) !== path.resolve(target.local.baseDirectory))
    )
      throw new CmsError(
        'SOURCE_AMBIGUOUS',
        `${key} is selected from ${seen.local.workspaceFolder} and ${target.local.workspaceFolder}`,
      );
    targets.set(key, { ...target, local: target.local ?? seen?.local });
  };
  for (const value of selectors ?? []) {
    const trimmed = value.trim();
    if (WILDCARD.test(trimmed)) throw refuse(`the wildcard ${value}`);
    const match = SELECTOR.exec(trimmed);
    if (!match) {
      if (/^[\w-]+$/u.test(trimmed)) throw refuse(`the bare type ${value}`);
      throw new CmsError('INVALID_SELECTOR', `A -m value must be type:ApiName, not ${value}`);
    }
    add({ handler: handlerOf(match[1]), apiName: match[2] });
  }
  for (const target of sourcePaths ?? []) {
    if (WILDCARD.test(target)) throw refuse(`the wildcard ${target}`);
    let located: Located;
    try {
      located = await componentOfFile(target);
    } catch (error) {
      if (error instanceof CmsError && error.code === 'INVALID_SELECTOR')
        throw refuse(`the folder ${target}`);
      throw error;
    }
    add({
      handler: handlerOf(located.type),
      apiName: located.apiName,
      local: { baseDirectory: located.baseDirectory, workspaceFolder: located.workspaceFolder },
    });
  }
  if (targets.size === 0) throw refuse('an empty selection');
  return [...targets.values()].toSorted(registryRank);
}

/**
 * The local files of a component at its usual path: `<ApiName>.<type>.json` and every
 * `<ApiName>.<type>.*` companion next to it.
 * @param {LifecycleTarget} target - Component.
 * @param {CmsWorkspace} workspace - Destination workspace (folder of `-m` components).
 * @param {string} projectDirectory - Directory holding `cms/` for `-m` components.
 * @returns {Promise<{ boundary: string; files: string[] }>} The `cms/` folder and the files.
 */
async function localFilesOf(
  target: LifecycleTarget,
  workspace: CmsWorkspace,
  projectDirectory: string,
): Promise<{ boundary: string; files: string[] }> {
  const baseDirectory = target.local?.baseDirectory ?? projectDirectory;
  const workspaceFolder = target.local?.workspaceFolder ?? workspace.apiName ?? workspace.id;
  const { type } = target.handler;
  const directory = typeDirectory(baseDirectory, workspaceFolder, type);
  const stem = `${target.apiName}.${type}.`;
  let names: string[] = [];
  try {
    const entries = await readdir(directory);
    names = entries.filter((name) => name.startsWith(stem)).toSorted();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const json = `${stem}json`;
  if (!names.includes(json)) names = [json, ...names];
  return {
    boundary: path.resolve(baseDirectory, SOURCE_ROOT),
    files: names.map((name) => path.join(directory, name)),
  };
}

type Planned = {
  target: LifecycleTarget;
  item: LifecycleItem;
  /** Delete: the local files, listed while planning. */
  local?: { boundary: string; files: string[] };
  /** Content keys the default variant's body references (read when the order depends on it). */
  references?: string[];
};

function componentDiagnostic(error: unknown, component: string): Diagnostic {
  return { ...toDiagnostic(error), component };
}

const unknown = (error: unknown): Diagnostic => ({
  ...toDiagnostic(error),
  code: 'UNKNOWN_OUTCOME',
  hint: toDiagnostic(new CmsError('UNKNOWN_OUTCOME', '')).hint,
});

const isUnknownOutcome = (error: unknown): boolean =>
  error instanceof CmsRequestError && error.requestSent && !error.statusObserved;

/**
 * Delete, publish or unpublish the named components in one workspace. Plans every component
 * first (inventory by API name); if one is blocked nothing is sent. Then one request per
 * component, each followed by one readback; stops on the first failure and never repeats a
 * request. Several components are handled in reference order, read from their default variants:
 * publish puts what is referenced first, unpublish and delete put dependants first; registry
 * order and API name only break ties, and a reference cycle is refused before any write. Only
 * the default variant is acted on (`variantIds`): publish/unpublish leave other
 * variants as they are and warn; delete refuses a component with other variants, because
 * deleting it would delete them too.
 * @param {RequestConnection & WriteConnection} connection - Org connection.
 * @param {CmsWorkspace} workspace - Workspace.
 * @param {LifecycleAction} action - Command.
 * @param {LifecycleTarget[]} targets - Components (see parseExactSelection).
 * @param {LifecycleOptions} options - Preview, diagnostics, local-file and write options.
 * @returns {Promise<LifecycleItem[]>} One item per component, in the order they were handled.
 */
export async function runLifecycle(
  connection: RequestConnection & WriteConnection,
  workspace: CmsWorkspace,
  action: LifecycleAction,
  targets: LifecycleTarget[],
  options: LifecycleOptions,
): Promise<LifecycleItem[]> {
  const { diagnostics } = options;
  const inventories = new Map<ContentTypeHandler, Map<string, InventoryItem>>();
  const plans: Planned[] = [];

  for (const target of targets) {
    const { handler, apiName } = target;
    const component = `${handler.type}:${apiName}`;
    const item: LifecycleItem = { type: handler.type, apiName, outcome: 'blocked' };
    const plan: Planned = { target, item };
    plans.push(plan);
    try {
      let inventory = inventories.get(handler);
      if (!inventory) {
        const names = targets.filter((t) => t.handler === handler).map((t) => t.apiName);
        const found = await inventoryOf(connection, workspace, handler.apiName, names);
        inventory = new Map(found.map((entry) => [entry.apiName, entry]));
        inventories.set(handler, inventory);
      }
      const found = inventory.get(apiName);
      if (!found) {
        if (action === 'delete') {
          item.outcome = 'unchanged';
          continue;
        }
        throw new CmsError(
          'COMPONENT_NOT_FOUND',
          `Workspace ${workspace.apiName ?? workspace.id} has no ${component}`,
        );
      }
      Object.assign(item, {
        managedContentId: found.managedContentId,
        ...(found.contentKey ? { contentKey: found.contentKey } : {}),
      });
      const others = found.otherVariants.map((v) => v.language ?? v.name ?? v.id).join(', ');
      // Deleting the component deletes every variant; publish/unpublish target one variant.
      if (others && action === 'delete')
        throw new CmsError(
          'HAS_OTHER_VARIANTS',
          `Deleting it would also delete its other variants: ${others}`,
        );
      if (!found.defaultVariant)
        throw new CmsError(
          'NO_DEFAULT_VARIANT',
          `None of the variants is primary or in ${workspace.defaultLanguage ?? 'the default language'}`,
        );
      if (others)
        diagnostics.warnings.push({
          ...toDiagnostic(
            new CmsError(
              'OTHER_VARIANTS_SKIPPED',
              `${action} acts on the default variant (${found.defaultVariant.language ?? 'default'}) only; left as they are: ${others}`,
            ),
          ),
          component,
        });
      // Listed while planning, for preview and run alike: an unusable path blocks before any write.
      if (action === 'delete') {
        plan.local = await localFilesOf(target, workspace, options.projectDirectory);
        if (options.preview) {
          item.localFiles = [];
          for (const file of plan.local.files)
            item.localFiles.push({ path: file, exists: await localFilePresent(file) });
        }
      }
      item.variantId = found.defaultVariant.id;
      if (action === 'publish' && handler.publishNote) item.note = handler.publishNote;
      item.outcome = action;
    } catch (error) {
      item.outcome = 'blocked';
      item.reason = toDiagnostic(error).code;
      diagnostics.errors.push(componentDiagnostic(error, component));
    }
  }
  const readVariant = async (variantId: string): Promise<Record<string, unknown>> => {
    const { data } = await requestJson<unknown>(connection, getSelectedOperation('variant.get'), {
      path: { variantId },
    });
    if (!isRecord(data))
      throw new CmsError('UNEXPECTED_RESPONSE', `Variant ${variantId} is not an object`);
    return data;
  };

  // The order depends on references only when several components are acted on.
  const acting = plans.filter((plan) => plan.item.outcome === action);
  if (acting.length > 1 && !plans.some((plan) => plan.item.outcome === 'blocked'))
    for (const plan of acting)
      try {
        const native = await readVariant(plan.item.variantId!);
        plan.references = referencedContentKeys(native.contentBody);
      } catch (error) {
        Object.assign(plan.item, { outcome: 'blocked', reason: toDiagnostic(error).code });
        diagnostics.errors.push(
          componentDiagnostic(error, `${plan.target.handler.type}:${plan.target.apiName}`),
        );
      }
  const keyOf = (plan: Planned): string =>
    plan.item.contentKey ?? `${plan.target.handler.type}:${plan.target.apiName}`;
  const referenced = referenceOrder(
    plans,
    keyOf,
    (plan) => plan.references ?? [],
    (left, right) => registryRank(left.target, right.target),
  );
  // Publish what is referenced first; delete and unpublish dependants first.
  plans.splice(0, plans.length, ...(action === 'publish' ? referenced : referenced.toReversed()));
  const items = plans.map((plan) => plan.item);
  options.onPlanned?.(items);
  if (options.preview) return items;
  if (items.some((item) => item.outcome === 'blocked')) {
    for (const item of items)
      if (item.outcome === action)
        Object.assign(item, { outcome: 'not-attempted', reason: 'LIFECYCLE_BLOCKED' });
    return items;
  }

  let stopped = false;
  let current: LifecycleItem | undefined;
  try {
    await writeAll();
  } catch (error) {
    // Something unexpected: the component in progress may have been changed, the rest were not.
    for (const item of items)
      if (item.outcome === action)
        Object.assign(
          item,
          item === current
            ? { outcome: 'unknown', reason: 'UNKNOWN_OUTCOME' }
            : { outcome: 'not-attempted', reason: 'NOT_ATTEMPTED' },
        );
    throw error;
  }
  return items;

  async function writeAll(): Promise<void> {
    for (const { target, item, local } of plans) {
      if (item.outcome !== action) continue;
      current = item;
      if (stopped) {
        Object.assign(item, { outcome: 'not-attempted', reason: 'NOT_ATTEMPTED' });
        continue;
      }
      const component = `${target.handler.type}:${target.apiName}`;
      const fail = (outcome: 'failed' | 'unknown', diagnostic: Diagnostic): void => {
        stopped = true;
        item.outcome = outcome;
        item.reason = diagnostic.code;
        diagnostics.errors.push({ ...diagnostic, component });
      };
      const variantId = item.variantId!;

      if (action === 'delete') {
        // The DELETE answer does not decide: a successful delete has answered 404.
        let answer: unknown;
        try {
          await requestEmptyMutation(
            connection,
            getSelectedOperation('variant.delete'),
            { path: { variantId } },
            options.writeOptions,
          );
        } catch (error) {
          if (error instanceof CmsRequestError && !error.requestSent) {
            fail('failed', toDiagnostic(error));
            continue;
          }
          answer = error;
        }
        let gone: boolean;
        try {
          await readVariant(variantId);
          gone = false;
        } catch (error) {
          if (error instanceof CmsRequestError && error.status === 404) gone = true;
          else {
            fail('unknown', unknown(error));
            continue;
          }
        }
        if (!gone) {
          fail(
            'failed',
            answer === undefined || isUnknownOutcome(answer)
              ? toDiagnostic(
                  new CmsError(
                    'DELETE_NOT_CONFIRMED',
                    `Variant ${variantId} is still there after the delete`,
                  ),
                )
              : toDiagnostic(answer),
          );
          continue;
        }
        item.outcome = 'deleted';
        if (answer !== undefined)
          diagnostics.warnings.push({
            ...toDiagnostic(
              new CmsError(
                'DELETE_ANSWER_IGNORED',
                `Salesforce answered ${toDiagnostic(answer).message}; the readback shows the component is gone`,
              ),
            ),
            component,
          });
        try {
          item.removedLocalFiles = await removeLocalFiles(
            local!.files.map((file) => ({ path: file, boundary: local!.boundary })),
            options.keepLocalFiles === true,
          );
        } catch (error) {
          // The org delete is done and stays reported; only the local cleanup failed.
          item.removedLocalFiles = [];
          diagnostics.errors.push({
            ...toDiagnostic(
              new CmsError(
                'LOCAL_FILE_REMOVAL_FAILED',
                toDiagnostic(error, 'REMOVE_FAILED').message,
              ),
            ),
            component,
          });
        }
        for (const removal of item.removedLocalFiles)
          if (removal.outcome === 'failed')
            diagnostics.errors.push({
              ...toDiagnostic(
                new CmsError(
                  'LOCAL_FILE_REMOVAL_FAILED',
                  `${removal.path}: ${removal.code ?? 'REMOVE_FAILED'}`,
                ),
              ),
              component,
            });
        continue;
      }

      // Publish / unpublish: the default variant only, in the workspace's context.
      const body =
        action === 'publish'
          ? {
              variantIds: [variantId],
              contextContentSpaceId: workspace.id,
              includeContentReferences: false,
            }
          : { variantIds: [variantId], contextContentSpaceId: workspace.id };
      try {
        const { data } = await requestJsonMutation<unknown>(
          connection,
          getSelectedOperation(action === 'publish' ? 'content.publish' : 'content.unpublish'),
          body,
          {},
          options.writeOptions,
        );
        if (isRecord(data)) item.answer = data;
      } catch (error) {
        if (isUnknownOutcome(error)) fail('unknown', unknown(error));
        else fail('failed', toDiagnostic(error));
        continue;
      }
      item.outcome = action === 'publish' ? 'published' : 'unpublished';
      // An unconfirmed state is an error (exit 69 when nothing failed) but does not stop the run.
      try {
        const readback = await readVariant(variantId);
        item.isPublished = readback.isPublished === true;
      } catch (error) {
        diagnostics.errors.push({
          ...toDiagnostic(
            new CmsError('STATE_NOT_CONFIRMED', `Readback failed: ${toDiagnostic(error).message}`),
          ),
          component,
        });
        continue;
      }
      if (item.isPublished !== (action === 'publish'))
        diagnostics.errors.push({
          ...toDiagnostic(
            new CmsError(
              'STATE_NOT_CONFIRMED',
              `After the ${action}, the default variant reads isPublished=${String(item.isPublished)}`,
            ),
          ),
          component,
        });
    }
  }
}
