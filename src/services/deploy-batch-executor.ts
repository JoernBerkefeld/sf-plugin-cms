import type { Connection } from '@salesforce/core';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { JsonRequestOptions } from '../transport/json-request.js';
import { redactSecrets } from '../transport/redact-secrets.js';
import { preflightDeployBatch, type DeployBatchPreflightInput } from './deploy-batch-preflight.js';
import { executeDeployCreate } from './deploy-create-executor.js';
import { executeDeployDocumentCreate } from './deploy-document-create-executor.js';
import {
  preflightDeployDocumentCreate,
  type DeployDocumentCreatePreflightInput,
} from './deploy-document-create-preflight.js';
import { admitDeployDocumentUnchanged } from './deploy-document-unchanged.js';
import { preflightDeployDocumentUpdate } from './deploy-document-update-preflight.js';
import { executeDeployDocumentUpdate } from './deploy-document-update-executor.js';
import { getWorkspace } from './read.js';
import type { DeployBatchPreflight } from './deploy-batch-preflight.js';
import { executeDeployImage } from './deploy-image-executor.js';
import { preflightDeployImageCreate } from './deploy-image-create-preflight.js';
import { preflightDeployImageUpdate } from './deploy-image-update-preflight.js';
import { admitDeployImageUnchanged } from './deploy-image-unchanged.js';
import {
  enumerateNativeWorkspace,
  type NativeInventory,
  type NativeInventoryRow,
} from './retrieve-native-inventory.js';
import { preflightDeployCreate } from './deploy-create-preflight.js';
import { executeDeployUpdate, preflightDeployUpdate } from './deploy-update-executor.js';
import { selectDeploySources, type DeployLocalSelection } from './deploy-source-selection.js';
import {
  rewriteAtomic,
  writeExclusive,
  type WorkspaceImportReportPersistence,
  type WorkspaceImportRunReport,
} from './import-workspace.js';

export type ExecuteDeployBatchInput = DeployBatchPreflightInput & {
  destinationOrgId: string;
  /** Exclusive new batch journal, in an existing caller-owned directory. Never resumed. */
  reportFile: string;
};
export type DeployBatchReport = {
  qualification: 'unqualified';
  runId: string;
  destinationOrgId: string;
  workspaceId: string;
  language: string;
  selection: DeployLocalSelection;
  state: 'applying' | 'completed' | 'blocked' | 'partial';
  blockedReasons: string[];
  items: Array<{
    source: DeployLocalSelection['items'][number];
    proposed: 'create' | 'update' | 'unchanged' | 'blocked';
    reportFile: string;
    outcome: 'unattempted' | 'created' | 'updated' | 'unchanged' | 'failed' | 'uncertain';
    target?: { contentId: string; variantId: string };
    error?: string;
  }>;
  summary: {
    selected: number;
    created: number;
    updated: number;
    unchanged: number;
    completed: number;
    failed: number;
    uncertain: number;
    unattempted: number;
  };
};
export type DeployBatchVerifiedUpdateRow = {
  before: NativeInventoryRow;
  after: NativeInventoryRow;
};

/**
 * Compare complete inventory observations with independently verified CREATE/UPDATE evidence.
 * Shared by all families; this never admits an operation or grants mutation authority.
 * @param {NativeInventory} fresh - Newly acquired complete, unfiltered workspace inventory.
 * @param {NativeInventory} baseline - Complete inventory observed before the registered prefix.
 * @param {NativeInventoryRow[]} verifiedCreatedRows - Detached independently verified prefix rows.
 * @param {DeployBatchVerifiedUpdateRow[]} verifiedUpdatedRows - Exact old/new observations; current UPDATEs preserve all row fields.
 * @returns {NativeInventory} Detached comparable observation with pagination bookkeeping normalized.
 */
export function reconcileDeployBatchInventory(
  fresh: NativeInventory,
  baseline: NativeInventory,
  verifiedCreatedRows: readonly NativeInventoryRow[],
  verifiedUpdatedRows: readonly DeployBatchVerifiedUpdateRow[] = [],
): NativeInventory {
  const ids = new Set<string>();
  for (const row of verifiedCreatedRows) {
    if (
      ids.has(row.Id) ||
      baseline.records.some((candidate) => candidate.Id === row.Id) ||
      fresh.records.filter((candidate) => candidate.Id === row.Id).length !== 1 ||
      !isDeepStrictEqual(
        fresh.records.find((candidate) => candidate.Id === row.Id),
        row,
      )
    )
      throw new TypeError('Earlier verified CREATE inventory changed');
    ids.add(row.Id);
  }
  const updatedIds = new Set<string>();
  for (const { before, after } of verifiedUpdatedRows) {
    if (
      ids.has(before.Id) ||
      updatedIds.has(before.Id) ||
      baseline.records.filter((row) => row.Id === before.Id).length !== 1 ||
      fresh.records.filter((row) => row.Id === after.Id).length !== 1 ||
      !isDeepStrictEqual(
        baseline.records.find((row) => row.Id === before.Id),
        before,
      ) ||
      !isDeepStrictEqual(
        fresh.records.find((row) => row.Id === after.Id),
        after,
      ) ||
      // Bytes/rawHtml UPDATEs do not authorize title, URL, lifecycle or identity edits.
      !isDeepStrictEqual(before, after)
    )
      throw new TypeError('Earlier verified UPDATE inventory changed');
    updatedIds.add(before.Id);
  }
  const normalized = structuredClone(fresh);
  normalized.records = normalized.records.filter((row) => !ids.has(row.Id));
  normalized.pagesRequested = baseline.pagesRequested;
  if (!isDeepStrictEqual(normalized, baseline))
    throw new TypeError('Batch workspace inventory changed outside verified CREATE prefix');
  return normalized;
}

/**
 * Reacquire Document boundary observations; this grants no execution or UPDATE authority.
 * The caller must still guard cancellation and durable intent around every callback.
 * @param {Connection} connection - Exact destination connection.
 * @param {DeployBatchPreflightInput} input - Bound selectors and destination.
 * @param {DeployBatchPreflight} baseline - Frozen whole-selection observation.
 * @param {number} index - Exact selected Document index.
 * @param {NativeInventoryRow[]} verifiedCreatedRows - Independently verified prior CREATE rows.
 * @param {JsonRequestOptions} options - Read/cancellation options only.
 * @param {DeployBatchVerifiedUpdateRow[]} verifiedUpdatedRows - Independently verified earlier UPDATE observations.
 * @returns {Promise<void>} Resolves only while local, identity and complete inventory agree.
 */
export async function revalidateDeployBatchDocumentBoundary(
  connection: Pick<Connection, 'request' | 'getApiVersion'>,
  input: DeployBatchPreflightInput,
  baseline: DeployBatchPreflight,
  index: number,
  verifiedCreatedRows: readonly NativeInventoryRow[],
  options: JsonRequestOptions = {},
  verifiedUpdatedRows: readonly DeployBatchVerifiedUpdateRow[] = [],
): Promise<void> {
  const selected = structuredClone(input);
  // Preserve native Buffer proof values; structuredClone would change them to Uint8Array.
  const frozen = baseline;
  const registered = structuredClone(verifiedCreatedRows);
  const updates = structuredClone(verifiedUpdatedRows);
  const requestOptions = { ...options };
  const source = frozen.selection.items[index];
  const proof = frozen.items[index];
  const inventory = frozen.preparation.items[index]?.documentInventory;
  if (
    selected.workspaceId !== frozen.preparation.workspaceId ||
    selected.language !== frozen.preparation.language ||
    source?.definition.contentType !== 'sfdc_cms__document' ||
    !proof ||
    !inventory ||
    !frozen.rootFolderId ||
    (selected.expectedRootFolderId !== undefined &&
      selected.expectedRootFolderId !== frozen.rootFolderId)
  )
    throw new TypeError('Batch Document boundary binding missing');
  const scope: DeployDocumentCreatePreflightInput = {
    definitionFile: source.definitionPath,
    workspaceId: selected.workspaceId,
    language: selected.language,
    expectedRootFolderId: frozen.rootFolderId,
  };
  const checkLocal = async () => {
    if (requestOptions.signal?.aborted) throw new TypeError('Batch Document boundary cancelled');
    if (!isDeepStrictEqual(await selectDeploySources(selected.sources), frozen.selection))
      throw new TypeError('Batch Document local selection changed');
  };
  const checkInventory = async () => {
    reconcileDeployBatchInventory(
      await enumerateNativeWorkspace(connection, selected.workspaceId, requestOptions),
      inventory,
      registered,
      updates,
    );
  };
  await checkLocal();
  await checkInventory();
  if (proof.proposed === 'create' && proof.documentCreate) {
    const fresh = await preflightDeployDocumentCreate(connection, scope, requestOptions);
    fresh.observations.inventory = reconcileDeployBatchInventory(
      fresh.observations.inventory,
      proof.documentCreate.observations.inventory,
      registered,
      updates,
    );
    if (!isDeepStrictEqual(fresh, proof.documentCreate))
      throw new TypeError('Batch Document CREATE intent changed');
  } else if (proof.proposed === 'unchanged' && proof.documentUnchanged) {
    const fresh = await admitDeployDocumentUnchanged(connection, scope, requestOptions);
    if (!isDeepStrictEqual(fresh, proof.documentUnchanged))
      throw new TypeError('Batch Document unchanged identity changed');
  } else if (proof.proposed === 'update' && proof.documentUpdate) {
    const fresh = await preflightDeployDocumentUpdate(connection, scope, requestOptions);
    fresh.destination.inventory = reconcileDeployBatchInventory(
      fresh.destination.inventory,
      proof.documentUpdate.destination.inventory,
      registered,
      updates,
    );
    if (!isDeepStrictEqual(fresh, proof.documentUpdate))
      throw new TypeError('Batch Document UPDATE intent changed');
  } else throw new TypeError('Batch Document operation proof missing');
  await checkInventory();
  const workspace = await getWorkspace(connection, scope.workspaceId, requestOptions);
  if (
    workspace.id !== scope.workspaceId ||
    workspace.rootFolderId !== scope.expectedRootFolderId ||
    workspace.defaultLanguage !== scope.language
  )
    throw new TypeError('Batch Document destination root or default language changed');
  await checkLocal();
}

/**
 * Execute the Document item branch only after fresh whole-selection preflight.
 * @param {Connection} connection - Exact destination connection.
 * @param {object} input - Bound source, destination and exclusive item path.
 * @param {string} operation - Explicit Document CREATE, UPDATE or unchanged; never Image fallback.
 * @param {Function} boundary - Fresh whole-batch intent, source and inventory callback.
 * @param {JsonRequestOptions} options - Read/cancellation options.
 * @param {WorkspaceImportReportPersistence} persistence - Existing item journal persistence seam.
 * @returns {Promise<object>} Verified item outcome; uncertainty is never returned as completed.
 */
export async function executeDeployBatchDocumentItem(
  connection: Pick<Connection, 'request' | 'getApiVersion'>,
  input: Parameters<typeof executeDeployDocumentCreate>[1],
  operation: DeployBatchReport['items'][number]['proposed'],
  boundary: () => Promise<void>,
  options: JsonRequestOptions = {},
  persistence?: WorkspaceImportReportPersistence,
): Promise<{
  target: { contentId: string; variantId: string };
  outcome: 'created' | 'updated' | 'unchanged';
}> {
  if (operation === 'blocked') throw new TypeError('Blocked Document operation');
  await boundary();
  if (operation === 'update') {
    const result = await executeDeployDocumentUpdate(
      connection,
      input,
      options,
      persistence,
      boundary,
    );
    const updated = result.report.operations[0];
    if (
      result.report.state !== 'completed' ||
      result.report.createdParents.length > 0 ||
      result.report.operations.length !== 1 ||
      updated.state !== 'succeeded' ||
      updated.operationKind !== 'update-variant' ||
      updated.result?.contentId !== result.preflight.contentId ||
      updated.result?.variantId !== result.preflight.variantId
    )
      throw new TypeError('Document UPDATE journal incomplete');
    return {
      target: { contentId: result.preflight.contentId, variantId: result.preflight.variantId },
      outcome: 'updated',
    };
  }
  if (operation === 'unchanged') {
    const result = await admitDeployDocumentUnchanged(connection, input, options);
    await boundary();
    return {
      target: { contentId: result.contentId, variantId: result.variantId },
      outcome: 'unchanged',
    };
  }
  const result = await executeDeployDocumentCreate(
    connection,
    input,
    options,
    persistence,
    boundary,
  );
  if (result.report.state !== 'completed' || result.report.createdParents.length !== 1)
    throw new TypeError('Document journal incomplete');
  const created = result.report.createdParents[0];
  return {
    target: { contentId: created.contentId, variantId: created.primaryVariantId },
    outcome: 'created',
  };
}

export type DeployBatchPersistence = {
  rewrite: (file: string, report: DeployBatchReport) => Promise<void>;
  item?: WorkspaceImportReportPersistence;
};

/**
 * Execute a frozen whole-selection intent sequentially, stopping on the first failure.
 * Capability acceptance remains unqualified; no retry, resume, rollback or publication.
 * @param {Connection} connection - Explicit destination connection; UPDATE needs token/instance URL.
 * @param {ExecuteDeployBatchInput} input - Local selectors, exact destination and exclusive batch journal.
 * @param {JsonRequestOptions} options - Timeout/cancellation options only.
 * @param {DeployBatchPersistence} persistence - Internal persistence failure-injection seam.
 * @returns {Promise<object>} Unqualified report; item journals remain reconciliation authority.
 */
export async function executeDeployBatch(
  connection: Pick<Connection, 'request' | 'getApiVersion'>,
  input: ExecuteDeployBatchInput,
  options: JsonRequestOptions = {},
  persistence?: DeployBatchPersistence,
): Promise<{ qualification: 'unqualified'; reportFile: string; report: DeployBatchReport }> {
  const selected = structuredClone(input);
  const requestOptions = { ...options };
  if (!/^00D[A-Za-z0-9]{12}[A-Z0-5]{3}$/u.test(selected.destinationOrgId))
    throw new TypeError('Batch requires exact destination org ID');
  // Never accept a caller's eligibility, payload, or operation-specific proof.
  const selection = await selectDeploySources(selected.sources);
  for (const source of selection.items) {
    if (
      source.definition.contract === 'sf-cms-media-source' &&
      !['sfdc_cms__image', 'sfdc_cms__document'].includes(source.definition.contentType)
    )
      throw new TypeError('Unsupported deploy media content type');
  }
  const initialInventory = await enumerateNativeWorkspace(
    connection,
    selected.workspaceId,
    requestOptions,
  );
  const baseline = await preflightDeployBatch(connection, selected, requestOptions);
  const verifiedCreatedRows: NativeInventoryRow[] = [];
  const verifiedUpdatedRows: DeployBatchVerifiedUpdateRow[] = [];
  const reselect = () => selectDeploySources(selected.sources);
  const reportFile = path.resolve(selected.reportFile);
  const runId = randomUUID();
  const report: DeployBatchReport = {
    qualification: 'unqualified',
    runId,
    destinationOrgId: selected.destinationOrgId,
    workspaceId: selected.workspaceId,
    language: selected.language,
    selection: baseline.selection,
    state: baseline.eligible ? 'applying' : 'blocked',
    blockedReasons: [
      ...baseline.blockedReasons,
      ...baseline.items.flatMap((item) => item.blockedReasons),
    ],
    items: baseline.items.map((item, index) => ({
      source: baseline.selection.items[index],
      proposed: item.proposed,
      reportFile: `${reportFile}.${runId}.${index + 1}.json`,
      outcome: 'unattempted',
    })),
    summary: {
      selected: baseline.items.length,
      created: 0,
      updated: 0,
      unchanged: 0,
      completed: 0,
      failed: 0,
      uncertain: 0,
      unattempted: baseline.items.length,
    },
  };
  await writeExclusive(reportFile, report);
  const rewrite = persistence?.rewrite ?? rewriteAtomic;
  const recount = () => {
    for (const outcome of [
      'created',
      'updated',
      'unchanged',
      'failed',
      'uncertain',
      'unattempted',
    ] as const)
      report.summary[outcome] = report.items.filter((item) => item.outcome === outcome).length;
    report.summary.completed =
      report.summary.created + report.summary.updated + report.summary.unchanged;
  };
  let active: DeployBatchReport['items'][number] | undefined;
  try {
    if (!baseline.eligible) return { qualification: 'unqualified', reportFile, report };
    await rewrite(reportFile, report);
    for (const [index, item] of report.items.entries()) {
      active = undefined;
      const scope = {
        definitionFile: item.source.definitionPath,
        workspaceId: selected.workspaceId,
        language: selected.language,
        expectedRootFolderId: baseline.rootFolderId,
      };
      const checkInventory = async () => {
        try {
          reconcileDeployBatchInventory(
            await enumerateNativeWorkspace(connection, selected.workspaceId, requestOptions),
            initialInventory,
            verifiedCreatedRows,
            verifiedUpdatedRows,
          );
        } catch (error) {
          if (
            item.source.definition.contentType === 'sfdc_cms__image' &&
            item.proposed === 'update' &&
            error instanceof TypeError &&
            error.message === 'Batch workspace inventory changed outside verified CREATE prefix'
          )
            throw new TypeError('Batch Image UPDATE intent changed', { cause: error });
          throw error;
        }
      };
      const boundary = async () => {
        if (
          item.source.definition.contract === 'sf-cms-media-source' &&
          !['sfdc_cms__image', 'sfdc_cms__document'].includes(item.source.definition.contentType)
        )
          throw new TypeError('Unsupported deploy media content type');
        if (requestOptions.signal?.aborted) throw new TypeError('Batch cancelled before execution');
        if (!isDeepStrictEqual(await reselect(), baseline.selection))
          throw new TypeError('Batch selection changed before execution');
        if (
          JSON.stringify(JSON.parse(await readFile(reportFile, 'utf8'))) !== JSON.stringify(report)
        )
          throw new TypeError('Batch durable intent changed before execution');
        await checkInventory();
        const proof = baseline.items[index];
        if (item.source.definition.contentType === 'sfdc_cms__document') {
          await revalidateDeployBatchDocumentBoundary(
            connection,
            selected,
            baseline,
            index,
            verifiedCreatedRows,
            requestOptions,
            verifiedUpdatedRows,
          );
        } else if (item.source.definition.contentType === 'sfdc_cms__image') {
          if (item.proposed === 'create') {
            const fresh = await preflightDeployImageCreate(connection, scope, requestOptions);
            if (!isDeepStrictEqual(fresh, proof.imageCreate))
              throw new TypeError('Batch Image CREATE intent changed');
          } else if (item.proposed === 'update') {
            const fresh = await preflightDeployImageUpdate(connection, scope, requestOptions);
            if (proof.imageUpdate)
              fresh.destination.inventory = reconcileDeployBatchInventory(
                fresh.destination.inventory,
                proof.imageUpdate.destination.inventory,
                verifiedCreatedRows,
                verifiedUpdatedRows,
              );
            if (!isDeepStrictEqual(fresh, proof.imageUpdate))
              throw new TypeError('Batch Image UPDATE intent changed');
          } else {
            const fresh = await admitDeployImageUnchanged(connection, scope, requestOptions);
            if (!isDeepStrictEqual(fresh, proof.imageUnchanged))
              throw new TypeError('Batch Image unchanged intent changed');
          }
        } else {
          const fresh =
            item.proposed === 'create'
              ? await preflightDeployCreate(connection, scope, requestOptions)
              : await preflightDeployUpdate(connection, scope, requestOptions);
          // Full records were checked above; normalize only the registered prefix count
          // and pagination in the UPDATE preparation's aggregate observation.
          if ('prepared' in fresh && fresh.prepared.inventory && proof.update?.prepared.inventory) {
            fresh.prepared.inventory.recordCount -= verifiedCreatedRows.length;
            fresh.prepared.inventory.pagesRequested =
              proof.update.prepared.inventory.pagesRequested;
          }
          if (!isDeepStrictEqual(fresh, (proof.create ?? proof.update)!))
            throw new TypeError('Batch operation intent changed before execution');
        }
        await checkInventory();
        if (!isDeepStrictEqual(await reselect(), baseline.selection))
          throw new TypeError('Batch selection changed at execution boundary');
        if (requestOptions.signal?.aborted)
          throw new TypeError('Batch cancelled at execution boundary');
        if (
          JSON.stringify(JSON.parse(await readFile(reportFile, 'utf8'))) !== JSON.stringify(report)
        )
          throw new TypeError('Batch durable intent changed at execution boundary');
      };
      await boundary();
      if (
        item.source.definition.contract === 'sf-cms-media-source' &&
        !['sfdc_cms__image', 'sfdc_cms__document'].includes(item.source.definition.contentType)
      )
        throw new TypeError('Unsupported deploy media content type');
      active = item;
      const itemInput = {
        ...scope,
        destinationOrgId: selected.destinationOrgId,
        reportFile: item.reportFile,
      };
      if (item.source.definition.contentType === 'sfdc_cms__document') {
        const result = await executeDeployBatchDocumentItem(
          connection,
          itemInput,
          item.proposed,
          boundary,
          requestOptions,
          persistence?.item,
        );
        item.target = result.target;
        item.outcome = result.outcome;
      } else if (item.source.definition.contentType === 'sfdc_cms__image') {
        if (item.proposed === 'blocked') throw new TypeError('Blocked Image operation');
        const result = await executeDeployImage(
          connection,
          { ...itemInput, operation: item.proposed },
          requestOptions,
          persistence?.item,
          boundary,
        );
        if ('report' in result) {
          if (result.report.state !== 'completed') throw new TypeError('Image journal incomplete');
          if (item.proposed === 'create') {
            const created = result.report.createdParents[0];
            item.target = { contentId: created.contentId, variantId: created.primaryVariantId };
            item.outcome = 'created';
          } else {
            const updated = result.report.operations[0].result!;
            item.target = { contentId: updated.contentId!, variantId: updated.variantId! };
            item.outcome = 'updated';
          }
        } else {
          await boundary();
          item.target = { contentId: result.contentId, variantId: result.variantId };
          item.outcome = 'unchanged';
        }
      } else if (item.proposed === 'create') {
        const result = await executeDeployCreate(
          connection,
          itemInput,
          requestOptions,
          persistence?.item,
          boundary,
        );
        const created = result.report.createdParents[0];
        item.target = { contentId: created.contentId, variantId: created.primaryVariantId };
        item.outcome = 'created';
      } else {
        const result = await executeDeployUpdate(
          connection,
          itemInput,
          requestOptions,
          persistence?.item,
          boundary,
        );
        item.target = result.target;
        item.outcome = result.outcome;
      }
      if (item.outcome === 'created') {
        const inventory = await enumerateNativeWorkspace(
          connection,
          selected.workspaceId,
          requestOptions,
        );
        const row = inventory.records.find((candidate) => candidate.Id === item.target!.variantId);
        if (
          !row ||
          row.ManagedContentId !== item.target!.contentId ||
          row.ManagedContent.ApiName !== item.source.targetIdentity.apiName
        )
          throw new TypeError('Verified CREATE inventory binding missing');
        reconcileDeployBatchInventory(
          inventory,
          initialInventory,
          [...verifiedCreatedRows, row],
          verifiedUpdatedRows,
        );
        verifiedCreatedRows.push(structuredClone(row));
      } else if (item.outcome === 'updated') {
        // Item success alone cannot authorize erasing any native inventory drift.
        const journal = JSON.parse(
          await readFile(item.reportFile, 'utf8'),
        ) as WorkspaceImportRunReport;
        const operation = journal.operations[0];
        if (
          journal.state !== 'completed' ||
          journal.createdParents.length > 0 ||
          journal.operations.length !== 1 ||
          operation.state !== 'succeeded' ||
          operation.operationKind !== 'update-variant' ||
          operation.result?.contentId !== item.target?.contentId ||
          operation.result?.variantId !== item.target?.variantId
        )
          throw new TypeError('Verified UPDATE journal binding missing');
        const inventory = await enumerateNativeWorkspace(
          connection,
          selected.workspaceId,
          requestOptions,
        );
        const before = initialInventory.records.find((row) => row.Id === item.target?.variantId);
        const after = inventory.records.find((row) => row.Id === item.target?.variantId);
        if (
          !before ||
          !after ||
          before.ManagedContentId !== item.target?.contentId ||
          before.ManagedContent.ApiName !== item.source.targetIdentity.apiName
        )
          throw new TypeError('Verified UPDATE inventory binding missing');
        const transition = { before, after };
        reconcileDeployBatchInventory(inventory, initialInventory, verifiedCreatedRows, [
          ...verifiedUpdatedRows,
          transition,
        ]);
        verifiedUpdatedRows.push(structuredClone(transition));
      }
      // Mark verified outcomes before summary persistence: failures must not erase the prefix.
      active = undefined;
      recount();
      await rewrite(reportFile, report);
    }
    report.state = 'completed';
    await rewrite(reportFile, report);
  } catch (error) {
    const message = redactSecrets(
      error instanceof Error ? error.message : 'Batch execution failed',
    );
    report.blockedReasons.push(message);
    if (active) {
      active.error = message;
      // Missing/unreadable/pending journals cannot establish that no mutation occurred.
      active.outcome = active.proposed === 'unchanged' ? 'failed' : 'uncertain';
      try {
        const journal = JSON.parse(
          await readFile(active.reportFile, 'utf8'),
        ) as WorkspaceImportRunReport;
        if (
          journal.runId &&
          journal.state === 'failed' &&
          journal.operations.every((operation) => operation.state === 'failed')
        )
          active.outcome = 'failed';
      } catch {
        // Preserve uncertainty and the exact exclusive item path for manual reconciliation.
      }
    }
    recount();
    report.state = report.summary.completed > 0 ? 'partial' : 'blocked';
    try {
      await rewrite(reportFile, report);
    } catch {
      report.blockedReasons.push(
        'Batch summary persistence failed; inspect per-item journals before any new run',
      );
    }
  }
  return { qualification: 'unqualified', reportFile, report };
}
