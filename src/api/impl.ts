import path from 'node:path';
import type { Connection } from '@salesforce/core';
import { handlerOf, HANDLERS } from '../content/registry.js';
import type { CmsResult } from '../command-base.js';
import { CmsError, toDiagnostic } from '../errors/registry.js';
import { plugin } from '../plugin.js';
import { deployComponents, type DeployResult } from '../services/deploy.js';
import { selectSources } from '../services/deploy-selection.js';
import { inventoryOf } from '../services/inventory.js';
import {
  parseExactSelection,
  runLifecycle,
  type LifecycleAction,
  type LifecycleResult,
} from '../services/lifecycle.js';
import { parseSelection, retrieveComponents, type RetrieveResult } from '../services/retrieve.js';
import { resolveWorkspace, type CmsWorkspace } from '../services/workspaces.js';
import type { JsonMutationOptions } from '../transport/json-mutation.js';

/**
 * The org connection a library caller passes: a `@salesforce/core` Connection, as
 * `Org.getConnection()` returns it. Writes need its `accessToken` and `instanceUrl`.
 */
export type ApiConnection = Connection;

/** Workspace and component selection shared by deploy, publish, unpublish and remove. */
export type SelectionOptions = {
  /** Destination workspace API name or ID. */
  workspace: string;
  /** Components as `type:ApiName`, read from `<projectDirectory>/cms/<workspace>/<type>/`. */
  metadata?: string[];
  /** Component files or folders; relative paths are resolved against `projectDirectory`. */
  sourceDirs?: string[];
  /** Directory holding `cms/`. */
  projectDirectory: string;
  /** Report what would happen; write nothing. Default false. */
  preview?: boolean;
  /** Timeout of each write in milliseconds (default 120000). */
  timeoutMs?: number;
};

/** Options of `deploy`. */
export type DeployOptions = SelectionOptions & {
  /** Data space the data graph providers must use. */
  dataspace?: string;
  /** With `dataspace`: rename providers of another data space into it. */
  allowCrossDataspace?: boolean;
};

/** Options of `remove`. */
export type RemoveOptions = SelectionOptions & {
  /** Keep the local files of removed components (for example when Git already removed them). */
  keepLocalFiles?: boolean;
};

/** Options of `retrieve`. */
export type RetrieveOptions = {
  workspace: string;
  /** `type` (all of that type) or `type:ApiName`; none = every type. */
  metadata?: string[];
  /** Directory the `cms/` folder is written to. */
  outputDirectory: string;
};

/** One component asked for by `getItems`. */
export type ItemReference = { type: string; apiName: string };

/** State of one component in the workspace. */
export type ItemState = {
  type: string;
  apiName: string;
  exists: boolean;
  contentKey?: string;
  managedContentId?: string;
  /** Default variant. */
  variantId?: string;
  isPublished?: boolean;
  /** `Draft`, `Published` or `Revised`. */
  status?: string;
};

/** Result of `getItems`. */
export type GetItemsResult = {
  workspace: { id: string; apiName: string | null };
  items: ItemState[];
};

/** Options of `getItems`. */
export type GetItemsOptions = { workspace: string; refs: ItemReference[] };

const API_VERSION = /^\d{2,3}\.0$/u;

/**
 * Run one library call inside the result envelope the commands return with `--json`, without
 * their side effects: no exit code, no console output. Never throws.
 * @template R
 * @param {ApiConnection} connection - Org connection (`Org.getConnection()`).
 * @param {string} command - Command name for the metadata, such as `cms deploy`.
 * @param {R} empty - Result when the body did not finish.
 * @param {(result: CmsResult<R>) => Promise<R>} body - The work.
 * @returns {Promise<CmsResult<R>>} Filled envelope.
 */
async function enveloped<R>(
  connection: ApiConnection,
  command: string,
  empty: R,
  body: (result: CmsResult<R>) => Promise<R>,
): Promise<CmsResult<R>> {
  const apiVersion = String(connection?.version ?? '');
  const envelope: CmsResult<R> = {
    status: 'failed',
    metadata: { command: `sf ${command}`, apiVersion, plugin },
    diagnostics: { warnings: [], errors: [] },
    result: empty,
  };
  try {
    const orgId = connection?.getAuthInfoFields?.().orgId;
    if (orgId) envelope.metadata.orgId = orgId;
    if (!API_VERSION.test(apiVersion))
      throw new CmsError('INVALID_API_VERSION', `Not a numeric API version: ${apiVersion}`);
    envelope.result = await body(envelope);
    envelope.status = envelope.diagnostics.errors.length === 0 ? 'success' : 'failed';
  } catch (error) {
    envelope.diagnostics.errors.push(toDiagnostic(error));
  }
  return envelope;
}

function resolvedDirectories(
  directories: string[] | undefined,
  projectDirectory: string,
): string[] | undefined {
  return directories?.map((directory) => path.resolve(projectDirectory, directory));
}

function workspaceReference(workspace: CmsWorkspace): { id: string; apiName: string | null } {
  return { id: workspace.id, apiName: workspace.apiName };
}

function writeOptionsOf(
  base: JsonMutationOptions,
  timeoutMs: number | undefined,
): JsonMutationOptions {
  return timeoutMs === undefined ? base : { ...base, timeoutMs };
}

/**
 * The library functions, bound to write transport options (tests pass
 * `allowCallerConnection`; the public module passes none).
 * @param {JsonMutationOptions} writeOptions - Write transport options.
 * @returns {object} deploy, publish, unpublish, remove, retrieve and getItems.
 */
export function createApi(writeOptions: JsonMutationOptions = {}) {
  const lifecycle = (
    action: LifecycleAction,
    connection: ApiConnection,
    options: SelectionOptions & { keepLocalFiles?: boolean },
  ): Promise<CmsResult<LifecycleResult>> => {
    const preview = options?.preview ?? false;
    return enveloped<LifecycleResult>(
      connection,
      `cms ${action}`,
      { workspace: { id: '', apiName: null }, preview, items: [] },
      async (result) => {
        const targets = await parseExactSelection(
          options.metadata,
          resolvedDirectories(options.sourceDirs, options.projectDirectory),
          action,
        );
        const workspace = await resolveWorkspace(connection, options.workspace);
        const outcome: LifecycleResult = {
          workspace: workspaceReference(workspace),
          preview,
          items: [],
        };
        result.result = outcome;
        outcome.items = await runLifecycle(connection, workspace, action, targets, {
          preview,
          diagnostics: result.diagnostics,
          keepLocalFiles: options.keepLocalFiles,
          projectDirectory: options.projectDirectory,
          writeOptions: writeOptionsOf(writeOptions, options.timeoutMs),
          onPlanned: (items) => {
            outcome.items = items;
          },
        });
        return outcome;
      },
    );
  };

  return {
    /**
     * Create or update components from files (`sf cms deploy`). Never publishes.
     * @param {ApiConnection} connection - Org connection (`Org.getConnection()`).
     * @param {DeployOptions} options - Workspace and components.
     * @returns {Promise<CmsResult<DeployResult>>} The `--json` envelope; never throws.
     */
    deploy(connection: ApiConnection, options: DeployOptions): Promise<CmsResult<DeployResult>> {
      const preview = options?.preview ?? false;
      return enveloped<DeployResult>(
        connection,
        'cms deploy',
        { workspace: { id: '', apiName: null }, preview, items: [] },
        async (result) => {
          const sources = await selectSources(
            options.metadata,
            resolvedDirectories(options.sourceDirs, options.projectDirectory),
            options.projectDirectory,
          );
          const workspace = await resolveWorkspace(connection, options.workspace);
          const outcome: DeployResult = {
            workspace: workspaceReference(workspace),
            preview,
            items: [],
          };
          result.result = outcome;
          outcome.items = await deployComponents(connection, workspace, sources, {
            preview,
            diagnostics: result.diagnostics,
            writeOptions: writeOptionsOf(writeOptions, options.timeoutMs),
            ...(options.dataspace === undefined
              ? {}
              : {
                  dataspace: options.dataspace,
                  allowCrossDataspace: options.allowCrossDataspace ?? false,
                }),
          });
          return outcome;
        },
      );
    },

    /**
     * Publish the default variant of each named component (`sf cms publish`).
     * @param {ApiConnection} connection - Org connection (`Org.getConnection()`).
     * @param {SelectionOptions} options - Workspace and components.
     * @returns {Promise<CmsResult<LifecycleResult>>} The `--json` envelope; never throws.
     */
    publish(
      connection: ApiConnection,
      options: SelectionOptions,
    ): Promise<CmsResult<LifecycleResult>> {
      return lifecycle('publish', connection, options);
    },

    /**
     * Take named components back to Draft (`sf cms unpublish`).
     * @param {ApiConnection} connection - Org connection (`Org.getConnection()`).
     * @param {SelectionOptions} options - Workspace and components.
     * @returns {Promise<CmsResult<LifecycleResult>>} The `--json` envelope; never throws.
     */
    unpublish(
      connection: ApiConnection,
      options: SelectionOptions,
    ): Promise<CmsResult<LifecycleResult>> {
      return lifecycle('unpublish', connection, options);
    },

    /**
     * Delete named components and, unless `keepLocalFiles`, their local files (`sf cms delete`).
     * @param {ApiConnection} connection - Org connection (`Org.getConnection()`).
     * @param {RemoveOptions} options - Workspace and components.
     * @returns {Promise<CmsResult<LifecycleResult>>} The `--json` envelope; never throws.
     */
    remove(connection: ApiConnection, options: RemoveOptions): Promise<CmsResult<LifecycleResult>> {
      return lifecycle('delete', connection, options);
    },

    /**
     * Write components of one workspace to files (`sf cms retrieve`).
     * @param {ApiConnection} connection - Org connection (`Org.getConnection()`).
     * @param {RetrieveOptions} options - Workspace and components.
     * @returns {Promise<CmsResult<RetrieveResult>>} The `--json` envelope; never throws.
     */
    retrieve(
      connection: ApiConnection,
      options: RetrieveOptions,
    ): Promise<CmsResult<RetrieveResult>> {
      return enveloped<RetrieveResult>(
        connection,
        'cms retrieve',
        { workspace: { id: '', apiName: null }, outputDirectory: '', items: [] },
        async (result) => {
          const outputDirectory = path.resolve(options.outputDirectory);
          const selection = parseSelection(options.metadata);
          const workspace = await resolveWorkspace(connection, options.workspace);
          const outcome: RetrieveResult = {
            workspace: workspaceReference(workspace),
            outputDirectory,
            items: [],
          };
          result.result = outcome;
          outcome.items = await retrieveComponents(
            connection,
            workspace,
            selection,
            outputDirectory,
            result.diagnostics,
          );
          return outcome;
        },
      );
    },

    /**
     * Whether each component exists in the workspace, its publish state and content key.
     * @param {ApiConnection} connection - Org connection (`Org.getConnection()`).
     * @param {GetItemsOptions} options - Workspace and components.
     * @returns {Promise<CmsResult<GetItemsResult>>} The `--json` envelope; never throws.
     */
    getItems(
      connection: ApiConnection,
      options: GetItemsOptions,
    ): Promise<CmsResult<GetItemsResult>> {
      return enveloped<GetItemsResult>(
        connection,
        'api getItems',
        { workspace: { id: '', apiName: null }, items: [] },
        async () => {
          const byType = new Map<string, Set<string>>();
          for (const reference of options.refs) {
            const handler = handlerOf(reference.type);
            byType.set(
              handler.type,
              (byType.get(handler.type) ?? new Set()).add(reference.apiName),
            );
          }
          const workspace = await resolveWorkspace(connection, options.workspace);
          const found = new Map<string, ItemState>();
          for (const handler of HANDLERS) {
            const names = byType.get(handler.type);
            if (!names) continue;
            const inventory = await inventoryOf(connection, workspace, handler.apiName, [...names]);
            for (const item of inventory) {
              const variant = item.defaultVariant;
              found.set(`${handler.type}:${item.apiName.toLowerCase()}`, {
                type: handler.type,
                apiName: item.apiName,
                exists: true,
                ...(item.contentKey ? { contentKey: item.contentKey } : {}),
                managedContentId: item.managedContentId,
                ...(variant ? { variantId: variant.id } : {}),
                ...(variant?.isPublished === null || variant === undefined
                  ? {}
                  : { isPublished: variant.isPublished }),
                ...(variant?.status ? { status: variant.status } : {}),
              });
            }
          }
          return {
            workspace: workspaceReference(workspace),
            items: options.refs.map(
              (reference) =>
                found.get(`${reference.type}:${reference.apiName.toLowerCase()}`) ?? {
                  type: reference.type,
                  apiName: reference.apiName,
                  exists: false,
                },
            ),
          };
        },
      );
    },
  };
}

/** A flow's content reference, split into its parts. */
export type FlowContentReference = {
  workspaceApiName: string;
  /** CLI type name, such as `email`. */
  type: string;
  /** Salesforce content type, such as `sfdc_cms__email`. */
  contentType: string;
  apiName: string;
};

const NAME = /^[A-Za-z0-9]\w*$/u;
const FLOW_REFERENCE = /^marketing--([A-Za-z0-9]\w*)\.(sfdc_cms__\w+)--([A-Za-z0-9]\w*)$/u;

/**
 * How a flow refers to a component: `marketing--<workspace>.<content type>--<ApiName>`.
 * @param {string} workspaceApiName - Workspace API name.
 * @param {string} type - CLI type name, such as `email`.
 * @param {string} apiName - Component API name.
 * @returns {string} Reference, such as `marketing--Default_Content_Workspace.sfdc_cms__email--Welcome`.
 */
export function flowContentReference(
  workspaceApiName: string,
  type: string,
  apiName: string,
): string {
  const handler = handlerOf(type);
  for (const [what, value] of [
    ['workspace API name', workspaceApiName],
    ['API name', apiName],
  ] as const)
    if (!NAME.test(value))
      throw new CmsError('INVALID_SELECTOR', `Not a valid ${what} for a flow reference: ${value}`);
  return `marketing--${workspaceApiName}.${handler.apiName}--${apiName}`;
}

/**
 * The parts of a flow's content reference.
 * @param {string} reference - Reference as the flow stores it.
 * @returns {FlowContentReference} Workspace, type and API name.
 */
export function parseFlowContentReference(reference: string): FlowContentReference {
  const match = FLOW_REFERENCE.exec(reference);
  if (!match)
    throw new CmsError(
      'INVALID_SELECTOR',
      `Not a flow content reference (marketing--<workspace>.<content type>--<ApiName>): ${reference}`,
    );
  const [, workspaceApiName, contentType, apiName] = match;
  const handler = HANDLERS.find((candidate) => candidate.apiName === contentType);
  if (!handler)
    throw new CmsError(
      'UNKNOWN_TYPE',
      `Unknown content type ${contentType} in flow reference ${reference}`,
    );
  return { workspaceApiName, type: handler.type, contentType, apiName };
}
