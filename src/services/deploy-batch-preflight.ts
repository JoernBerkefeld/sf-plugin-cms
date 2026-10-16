import type { Connection } from '@salesforce/core';
import { isDeepStrictEqual } from 'node:util';
import type { JsonRequestOptions } from '../transport/json-request.js';
import { redactSecrets } from '../transport/redact-secrets.js';
import {
  selectDeploySources,
  type DeployLocalSelection,
  type DeploySourceSelectionFlags,
} from './deploy-source-selection.js';
import { prepareDeployDestination } from './deploy-destination-preparation.js';
import { preflightDeployCreate } from './deploy-create-preflight.js';
import { preflightDeployUpdate } from './deploy-update-executor.js';

export type DeployBatchPreflightInput = {
  sources: DeploySourceSelectionFlags;
  workspaceId: string;
  language: string;
  /** Compare the entire planned selection, not only the next item, when acquiring again. */
  expectedSelection?: DeployLocalSelection;
};
export type DeployBatchPreflight = {
  qualification: 'unqualified';
  selection: DeployLocalSelection;
  preparation: Awaited<ReturnType<typeof prepareDeployDestination>>;
  eligible: boolean;
  blockedReasons: string[];
  items: Array<{
    definitionFile: string;
    proposed: 'create' | 'update' | 'unchanged' | 'blocked';
    blockedReasons: string[];
    create?: Awaited<ReturnType<typeof preflightDeployCreate>>;
    update?: Awaited<ReturnType<typeof preflightDeployUpdate>>;
  }>;
};

/**
 * Preflight every selected source and operation before any batch mutation may begin.
 * All returned snapshots remain unqualified observations; executors must reacquire proof.
 * @param {Connection} connection - Explicit destination connection with central API selection.
 * @param {DeployBatchPreflightInput} input - Local selection flags and exact destination scope.
 * @param {JsonRequestOptions} options - Read timeout/cancellation options only.
 * @returns {Promise<DeployBatchPreflight>} Whole-selection eligibility without files or mutations.
 */
export async function preflightDeployBatch(
  connection: Pick<Connection, 'request' | 'getApiVersion'>,
  input: DeployBatchPreflightInput,
  options: JsonRequestOptions = {},
): Promise<DeployBatchPreflight> {
  const selected = structuredClone(input);
  const requestOptions = { ...options };
  // Complete local admission first; missing companions must prevent even destination reads.
  const selection = await selectDeploySources(selected.sources);
  if (
    selected.expectedSelection !== undefined &&
    !isDeepStrictEqual(selection, selected.expectedSelection)
  )
    throw new TypeError('Batch selection changed since planning');
  const preparation = await prepareDeployDestination(
    connection,
    { selection, workspaceId: selected.workspaceId, language: selected.language },
    requestOptions,
  );
  const result: DeployBatchPreflight = {
    qualification: 'unqualified',
    selection,
    preparation,
    eligible: false,
    blockedReasons: [...preparation.blockedReasons],
    items: selection.items.map((source) => ({
      definitionFile: source.definitionPath,
      proposed: 'blocked',
      blockedReasons: [],
    })),
  };
  // Global inventory/scope failures provide no operation-specific absence or update proof.
  if (result.blockedReasons.length > 0) return result;
  const titles = new Set<string>();
  const urls = new Set<string>();
  for (const [index, source] of selection.items.entries()) {
    const item = result.items[index];
    const prepared = preparation.items[index];
    try {
      if (!prepared || !isDeepStrictEqual(prepared.source, source))
        throw new TypeError('Batch destination selection disagreement');
      item.proposed = prepared.proposed;
      if (prepared.blockedReasons.length > 0 || prepared.proposed === 'blocked')
        throw new TypeError(prepared.blockedReasons.join('; ') || 'Blocked destination item');
      const scope = {
        definitionFile: source.definitionPath,
        workspaceId: selected.workspaceId,
        language: selected.language,
      };
      if (prepared.proposed === 'create') {
        const create = await preflightDeployCreate(connection, scope, requestOptions);
        if (
          !isDeepStrictEqual(create.payload.contentBody, source.contentBody) ||
          create.payload.apiName !== source.targetIdentity.apiName ||
          create.payload.title !== source.definition.title ||
          create.payload.urlName !== source.definition.urlName
        )
          throw new TypeError('Batch CREATE desired intent changed');
        if (
          titles.has(create.payload.title!) ||
          (create.payload.urlName !== undefined && urls.has(create.payload.urlName))
        )
          throw new TypeError('Selected CREATE title/URL collision');
        titles.add(create.payload.title!);
        if (create.payload.urlName !== undefined) urls.add(create.payload.urlName);
        item.create = create;
      } else {
        const update = await preflightDeployUpdate(connection, scope, requestOptions);
        if (
          !isDeepStrictEqual(update.source.items, [source]) ||
          update.item.proposed !== prepared.proposed ||
          !isDeepStrictEqual(update.item.existing, prepared.existing)
        )
          throw new TypeError('Batch UPDATE local or destination intent changed');
        item.update = update;
      }
    } catch (error) {
      item.blockedReasons.push(
        redactSecrets(error instanceof Error ? error.message : 'Batch item preflight failed'),
      );
    }
  }
  // Reselect directories too: additions/removals and selector membership are part of intent.
  try {
    if (!isDeepStrictEqual(await selectDeploySources(selected.sources), selection))
      throw new TypeError('Batch local selection drifted during preflight');
  } catch (error) {
    result.blockedReasons.push(
      redactSecrets(error instanceof Error ? error.message : 'Batch local revalidation failed'),
    );
  }
  result.eligible =
    result.blockedReasons.length === 0 &&
    result.items.every((item) => item.proposed !== 'blocked' && item.blockedReasons.length === 0);
  return result;
}
