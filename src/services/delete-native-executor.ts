import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { Connection } from '@salesforce/core';
import {
  assertNativeDeleteResult,
  type NativeDeleteReport,
  type NativeDeleteResult,
} from '../contracts/native-content-delete.js';
import { assertEditableDirectoryPath } from './editable-raw-html-export.js';
import {
  resolveNativeDeleteSelection,
  type NativeDeleteResolution,
} from './delete-native-resolution.js';
import { rewriteAtomic } from './import-workspace.js';
import { deleteVariantOneShot } from './lifecycle-foundation.js';
import { getContent, getVariant } from './read.js';
import { requiredContentIdentifier } from './variant-identity.js';
import { enumerateNativeWorkspace } from './retrieve-native-inventory.js';
import { CmsRequestError, type JsonRequestOptions } from '../transport/json-request.js';
import { redactSecrets } from '../transport/redact-secrets.js';

export type NativeDeleteApplyOptions = {
  resolution: NativeDeleteResolution;
  reportDirectory?: string;
  reportDirectoryAllocated?: true;
  requestOptions?: JsonRequestOptions;
  reportPersistence?: { rewrite: typeof rewriteAtomic };
};
export class NativeDeleteApplyError extends Error {
  public constructor(
    public readonly result: NativeDeleteResult,
    cause: unknown,
  ) {
    super('Native delete stopped; retain exact identities and reconcile read-only, never replay', {
      cause,
    });
    this.name = 'NativeDeleteApplyError';
  }
}
function message(error: unknown): string {
  return redactSecrets(error instanceof Error ? error.message : String(error)).slice(0, 1024);
}

/**
 * Execute only explicitly selected, fresh identity-bound native targets, sequentially and without replay.
 * @param {Pick<Connection, 'request' | 'getApiVersion'>} connection - Selected org connection.
 * @param {NativeDeleteApplyOptions} options - Exact resolution and optional persistence.
 * @returns {Promise<NativeDeleteResult>} In-memory outcomes retained on success and error.
 */
export async function applyNativeDelete(
  connection: Pick<Connection, 'request' | 'getApiVersion'>,
  options: NativeDeleteApplyOptions,
): Promise<NativeDeleteResult> {
  const resolution = structuredClone(options.resolution);
  if (
    resolution.items.length === 0 ||
    resolution.inventory.complete !== true ||
    resolution.items.some(
      (item) =>
        item.requiresLanguageSelection ||
        item.selected.length === 0 ||
        item.selected.some(
          (target) =>
            target.contentId !== item.contentId ||
            target.contentType !== item.contentType ||
            !item.available.some((available) => isDeepStrictEqual(available, target)),
        ),
    )
  )
    throw new TypeError('Explicit resolved native delete targets required');
  const report: NativeDeleteReport = {
    runId: randomUUID(),
    workspaceId: resolution.workspaceId,
    apiVersion: resolution.apiVersion,
    state: 'applying',
    operations: resolution.items.flatMap((item) =>
      item.selected.map((target) => ({ target, state: 'unattempted' as const })),
    ),
  };
  const result: NativeDeleteResult = { report, reportFile: null };
  assertNativeDeleteResult(result);
  const requestOptions = options.requestOptions ?? {};
  let active = report.operations[0];
  let dispatched = false;
  const persist = async (): Promise<void> => {
    if (result.reportFile !== null)
      await (options.reportPersistence?.rewrite ?? rewriteAtomic)(result.reportFile, report);
  };
  try {
    if (options.reportDirectory !== undefined) {
      if (!options.reportDirectory.trim()) throw new TypeError('New report directory required');
      const directory = path.resolve(options.reportDirectory);
      await assertEditableDirectoryPath(path.dirname(directory), false);
      if (!options.reportDirectoryAllocated) await mkdir(directory);
      await assertEditableDirectoryPath(directory, false);
      if (options.reportDirectoryAllocated) {
        const entries = await readdir(directory);
        if (entries.length > 0)
          throw new TypeError('Allocated delete report directory must be empty');
      }
      result.reportFile = path.join(directory, 'content-delete-run.json');
      const handle = await open(result.reportFile, 'wx');
      try {
        await handle.writeFile(`${JSON.stringify(report, null, 2)}\n`);
        await handle.sync();
      } finally {
        await handle.close();
      }
    }
    for (const operation of report.operations) {
      active = operation;
      dispatched = false;
      operation.state = 'pending';
      await persist();
      if (
        result.reportFile !== null &&
        !isDeepStrictEqual(JSON.parse(await readFile(result.reportFile, 'utf8')), report)
      )
        throw new TypeError('Delete durable intent changed');
      // Re-resolve the exact parent, all ordinary locales and classifications immediately before dispatch.
      const item = resolution.items.find(
        (candidate) => candidate.contentId === operation.target.contentId,
      )!;
      const fresh = await resolveNativeDeleteSelection(
        connection,
        {
          workspaceId: report.workspaceId,
          selection: { 'content-type': [item.contentType], 'content-key-or-id': [item.contentId] },
          languages: ['*'],
        },
        requestOptions,
      );
      const completed = new Set(
        report.operations
          .filter((candidate) => candidate.state === 'completed')
          .map((candidate) => candidate.target.variantId),
      );
      const expected = item.available.filter((target) => !completed.has(target.variantId));
      if (
        fresh.apiVersion !== report.apiVersion ||
        !isDeepStrictEqual(fresh.items[0].available, expected)
      )
        throw new TypeError('Native delete target or sibling identity drifted');
      if (
        result.reportFile !== null &&
        !isDeepStrictEqual(JSON.parse(await readFile(result.reportFile, 'utf8')), report)
      )
        throw new TypeError('Delete durable intent changed during preflight');
      if (requestOptions.signal?.aborted) throw new TypeError('Delete cancelled before dispatch');
      dispatched = true;
      try {
        await deleteVariantOneShot(connection, operation.target.variantId, requestOptions);
      } catch (error) {
        // Even a lost response permits only read-only reconciliation, never a second DELETE.
        try {
          await reconcile(
            connection,
            resolution,
            operation.target.variantId,
            completed,
            requestOptions,
          );
        } catch {
          /* Original dispatch evidence remains authoritative. */
        }
        operation.state =
          error instanceof CmsRequestError &&
          error.operationKey === 'variant.delete' &&
          error.statusObserved &&
          [400, 403, 404].includes(error.status ?? 0)
            ? 'rejected'
            : 'uncertain';
        throw error;
      }
      operation.parentBehavior = await reconcile(
        connection,
        resolution,
        operation.target.variantId,
        completed,
        requestOptions,
      );
      operation.state = 'completed';
      operation.exactVariantAbsent = true;
      dispatched = false;
      await persist();
    }
    report.state = 'completed';
    await persist();
    return result;
  } catch (error) {
    if (active.state === 'completed') {
      result.persistenceError = message(error);
      active = report.operations.find((operation) => operation.state === 'unattempted') ?? active;
    }
    if (active.state === 'pending' || active.state === 'unattempted')
      active.state = dispatched ? 'uncertain' : 'blocked';
    if (active.state !== 'completed') active.error = message(error);
    const stopped = report.operations.find((operation) => operation.state !== 'completed');
    report.state = 'completed';
    if (stopped) {
      if (stopped.state === 'uncertain') report.state = 'uncertain';
      else if (report.operations.some((operation) => operation.state === 'completed'))
        report.state = 'partial';
      else report.state = stopped.state === 'rejected' ? 'rejected' : 'blocked';
    }
    try {
      await persist();
    } catch (persistenceError) {
      result.persistenceError = message(persistenceError);
    }
    throw new NativeDeleteApplyError(result, error);
  }
}

async function reconcile(
  connection: Pick<Connection, 'request' | 'getApiVersion'>,
  resolution: NativeDeleteResolution,
  variantId: string,
  completed: ReadonlySet<string>,
  options: JsonRequestOptions,
): Promise<'present' | 'not-found'> {
  let absent = false;
  try {
    await getVariant(connection, variantId, options);
  } catch (error) {
    if (
      !(error instanceof CmsRequestError) ||
      error.operationKey !== 'variant.get' ||
      error.status !== 404 ||
      !error.statusObserved ||
      error.errorCode !== 'VARIANT_NOT_FOUND' ||
      error.errorEntryCount !== 1
    )
      throw error;
    absent = true;
  }
  if (!absent) throw new TypeError('Exact native variant absence was not observed');
  const inventory = await enumerateNativeWorkspace(connection, resolution.workspaceId, options);
  if (inventory.records.some((row) => row.Id === variantId))
    throw new TypeError('Native inventory still contains deleted target');
  // Observe the selected items' remaining ordinary identities, without claiming history/reference preservation.
  for (const item of resolution.items) {
    const expected = item.available.filter(
      (target) => target.variantId !== variantId && !completed.has(target.variantId),
    );
    const actual = inventory.records.filter((row) => row.ManagedContentId === item.contentId);
    if (
      actual.length !== expected.length ||
      expected.some(
        (target) =>
          !actual.some(
            (row) =>
              row.Id === target.variantId &&
              row.Language === target.language &&
              row.VariantType === target.variantType &&
              row.ContentTypeFullyQualifiedName === target.contentType &&
              row.ManagedContent.ApiName === target.apiName,
          ),
      )
    )
      throw new TypeError('Remaining selected-item native identities changed after DELETE');
  }
  const selected = resolution.items
    .flatMap((item) => item.selected)
    .find((target) => target.variantId === variantId)!;
  try {
    const parent = await getContent(connection, selected.contentId, {}, options);
    const type =
      typeof parent.contentType === 'object' && parent.contentType !== null
        ? (parent.contentType as Record<string, unknown>).fullyQualifiedName
        : parent.contentType;
    if (
      requiredContentIdentifier(parent) !== selected.contentId ||
      (parent.contentSpace as Record<string, unknown> | undefined)?.id !== resolution.workspaceId ||
      type !== selected.contentType
    )
      throw new TypeError('Parent readback identity changed');
    return 'present';
  } catch (error) {
    if (
      !(error instanceof CmsRequestError) ||
      error.operationKey !== 'content.get' ||
      error.status !== 404 ||
      !error.statusObserved ||
      error.errorCode !== 'NOT_FOUND' ||
      error.errorEntryCount !== 1
    )
      throw error;
    return 'not-found';
  }
}
