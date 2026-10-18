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
import { preflightDeployImageCreate } from './deploy-image-create-preflight.js';
import { preflightDeployImageUpdate } from './deploy-image-update-preflight.js';
import { admitDeployImageUnchanged } from './deploy-image-unchanged.js';
import { getWorkspace } from './read.js';
import { preflightDeployDocumentCreate } from './deploy-document-create-preflight.js';
import { admitDeployDocumentUnchanged } from './deploy-document-unchanged.js';
import { preflightDeployDocumentUpdate } from './deploy-document-update-preflight.js';
import { enumerateNativeWorkspace } from './retrieve-native-inventory.js';
import { preflightDeployAudioCreate } from './deploy-audio-create-preflight.js';
import { admitDeployAudioUnchanged } from './deploy-audio-unchanged.js';
import { preflightDeployAudioUpdate } from './deploy-audio-update-preflight.js';

export type DeployBatchPreflightInput = {
  sources: DeploySourceSelectionFlags;
  /** Optional root binding for independent reacquisition of a previously observed destination. */
  expectedRootFolderId?: string;
  workspaceId: string;
  language: string;
  /** Compare the entire planned selection, not only the next item, when acquiring again. */
  expectedSelection?: DeployLocalSelection;
};
export type DeployBatchPreflight = {
  qualification: 'unqualified';
  rootFolderId?: string;
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
    imageCreate?: Awaited<ReturnType<typeof preflightDeployImageCreate>>;
    imageUpdate?: Awaited<ReturnType<typeof preflightDeployImageUpdate>>;
    imageUnchanged?: Awaited<ReturnType<typeof admitDeployImageUnchanged>>;
    documentCreate?: Awaited<ReturnType<typeof preflightDeployDocumentCreate>>;
    documentUpdate?: Awaited<ReturnType<typeof preflightDeployDocumentUpdate>>;
    documentUnchanged?: Awaited<ReturnType<typeof admitDeployDocumentUnchanged>>;
    audioCreate?: Awaited<ReturnType<typeof preflightDeployAudioCreate>>;
    audioUpdate?: Awaited<ReturnType<typeof preflightDeployAudioUpdate>>;
    audioUnchanged?: Awaited<ReturnType<typeof admitDeployAudioUnchanged>>;
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
  for (const source of selection.items) {
    if (
      source.definition.contract === 'sf-cms-media-source' &&
      !['sfdc_cms__image', 'sfdc_cms__document', 'sfdc_cms__audio'].includes(
        source.definition.contentType,
      )
    )
      throw new TypeError('Unsupported deploy media content type');
  }
  let rootFolderId = selected.expectedRootFolderId;
  if (selection.items.some((item) => item.definition.contract === 'sf-cms-media-source')) {
    const workspace = await getWorkspace(connection, selected.workspaceId, requestOptions);
    if (
      workspace.id !== selected.workspaceId ||
      typeof workspace.rootFolderId !== 'string' ||
      !workspace.rootFolderId ||
      workspace.defaultLanguage !== selected.language ||
      (rootFolderId !== undefined && workspace.rootFolderId !== rootFolderId)
    )
      throw new TypeError('Image destination workspace root or default language changed');
    rootFolderId = workspace.rootFolderId;
  }
  const preparation = await prepareDeployDestination(
    connection,
    {
      selection,
      workspaceId: selected.workspaceId,
      language: selected.language,
      expectedRootFolderId: rootFolderId,
    },
    requestOptions,
  );
  const result: DeployBatchPreflight = {
    qualification: 'unqualified',
    rootFolderId,
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
      if (
        source.definition.contract === 'sf-cms-media-source' &&
        !['sfdc_cms__image', 'sfdc_cms__document', 'sfdc_cms__audio'].includes(
          source.definition.contentType,
        )
      )
        throw new TypeError('Unsupported deploy media content type');
      item.proposed = prepared.proposed;
      if (prepared.blockedReasons.length > 0 || prepared.proposed === 'blocked')
        throw new TypeError(prepared.blockedReasons.join('; ') || 'Blocked destination item');
      const scope = {
        definitionFile: source.definitionPath,
        workspaceId: selected.workspaceId,
        language: selected.language,
        expectedRootFolderId: rootFolderId,
      };
      switch (source.definition.contentType) {
        case 'sfdc_cms__audio': {
          switch (prepared.proposed) {
            case 'create': {
              const proof = await preflightDeployAudioCreate(connection, scope, requestOptions);
              if (
                !isDeepStrictEqual(proof.source.definition, source.definition) ||
                !isDeepStrictEqual(proof.source.companionPaths, source.companionPaths) ||
                proof.mediaSha256 !== source.mediaSha256 ||
                !isDeepStrictEqual(proof.observations.inventory, prepared.audioInventory)
              )
                throw new TypeError('Batch Audio CREATE selected or destination snapshot changed');
              if (
                titles.has(proof.payload.title!) ||
                (proof.payload.urlName !== undefined && urls.has(proof.payload.urlName))
              )
                throw new TypeError('Selected CREATE title/URL collision');
              titles.add(proof.payload.title!);
              if (proof.payload.urlName !== undefined) urls.add(proof.payload.urlName);
              item.audioCreate = proof;
              break;
            }
            case 'unchanged': {
              const proof = await admitDeployAudioUnchanged(connection, scope, requestOptions);
              if (
                proof.contentId !== prepared.existing?.contentId ||
                proof.variantId !== prepared.existing.variantId
              )
                throw new TypeError('Batch Audio unchanged identity changed');
              if (
                !isDeepStrictEqual(
                  await enumerateNativeWorkspace(connection, selected.workspaceId, requestOptions),
                  prepared.audioInventory,
                )
              )
                throw new TypeError('Batch Audio unchanged destination snapshot changed');
              item.audioUnchanged = proof;
              break;
            }
            case 'update': {
              const proof = await preflightDeployAudioUpdate(connection, scope, requestOptions);
              if (
                !isDeepStrictEqual(proof, prepared.audioUpdate) ||
                proof.mediaSha256 !== source.mediaSha256 ||
                proof.contentId !== prepared.existing?.contentId ||
                proof.variantId !== prepared.existing.variantId
              )
                throw new TypeError('Batch Audio UPDATE selected or destination snapshot changed');
              item.audioUpdate = proof;
              break;
            }
            default: {
              throw new TypeError('Batch Audio operation proof missing');
            }
          }

          break;
        }
        case 'sfdc_cms__document': {
          switch (prepared.proposed) {
            case 'create': {
              const proof = await preflightDeployDocumentCreate(connection, scope, requestOptions);
              if (
                !isDeepStrictEqual(proof.source.definition, source.definition) ||
                !isDeepStrictEqual(proof.source.companionPaths, source.companionPaths) ||
                proof.mediaSha256 !== source.mediaSha256 ||
                !isDeepStrictEqual(proof.observations.inventory, prepared.documentInventory)
              )
                throw new TypeError(
                  'Batch Document CREATE selected or destination snapshot changed',
                );
              if (
                titles.has(proof.payload.title!) ||
                (proof.payload.urlName !== undefined && urls.has(proof.payload.urlName))
              )
                throw new TypeError('Selected CREATE title/URL collision');
              titles.add(proof.payload.title!);
              if (proof.payload.urlName !== undefined) urls.add(proof.payload.urlName);
              item.documentCreate = proof;

              break;
            }
            case 'unchanged': {
              const proof = await admitDeployDocumentUnchanged(connection, scope, requestOptions);
              if (
                proof.contentId !== prepared.existing?.contentId ||
                proof.variantId !== prepared.existing.variantId
              )
                throw new TypeError('Batch Document unchanged identity changed');
              if (
                !isDeepStrictEqual(
                  await enumerateNativeWorkspace(connection, selected.workspaceId, requestOptions),
                  prepared.documentInventory,
                )
              )
                throw new TypeError('Batch Document unchanged destination snapshot changed');
              item.documentUnchanged = proof;

              break;
            }
            case 'update': {
              const proof = await preflightDeployDocumentUpdate(connection, scope, requestOptions);
              if (
                !isDeepStrictEqual(proof, prepared.documentUpdate) ||
                proof.mediaSha256 !== source.mediaSha256 ||
                proof.contentId !== prepared.existing?.contentId ||
                proof.variantId !== prepared.existing.variantId
              )
                throw new TypeError(
                  'Batch Document UPDATE selected or destination snapshot changed',
                );
              item.documentUpdate = proof;
              break;
            }
            default: {
              throw new TypeError('Batch Document operation proof missing');
            }
          }

          break;
        }
        case 'sfdc_cms__image': {
          if (prepared.proposed === 'create') {
            const proof = await preflightDeployImageCreate(connection, scope, requestOptions);
            if (
              !isDeepStrictEqual(proof.source.definition, source.definition) ||
              !isDeepStrictEqual(proof.source.companionPaths, source.companionPaths)
            )
              throw new TypeError('Batch Image CREATE intent changed');
            if (
              titles.has(proof.payload.title!) ||
              (proof.payload.urlName !== undefined && urls.has(proof.payload.urlName))
            )
              throw new TypeError('Selected CREATE title/URL collision');
            titles.add(proof.payload.title!);
            if (proof.payload.urlName !== undefined) urls.add(proof.payload.urlName);
            item.imageCreate = proof;
          } else if (prepared.proposed === 'update') {
            const proof = await preflightDeployImageUpdate(connection, scope, requestOptions);
            if (
              !isDeepStrictEqual(proof.source.definition, source.definition) ||
              proof.mediaSha256 !== source.mediaSha256 ||
              proof.contentId !== prepared.existing?.contentId ||
              proof.variantId !== prepared.existing.variantId
            )
              throw new TypeError('Batch Image UPDATE intent changed');
            item.imageUpdate = proof;
          } else {
            const proof = await admitDeployImageUnchanged(connection, scope, requestOptions);
            if (
              proof.contentId !== prepared.existing?.contentId ||
              proof.variantId !== prepared.existing.variantId
            )
              throw new TypeError('Batch Image unchanged identity changed');
            item.imageUnchanged = proof;
          }

          break;
        }
        default: {
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
        }
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
