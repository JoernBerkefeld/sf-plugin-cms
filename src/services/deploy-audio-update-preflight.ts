import type { Connection } from '@salesforce/core';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { getCmsApiSelection } from '../api-policy.js';
import { sourcePathSegment } from '../contracts/source-definition.js';
import type { JsonRequestOptions } from '../transport/json-request.js';
import { buildAudioUpdateMultipart } from '../transport/multipart-audio-update.js';
import type { DeployAudioCreatePreflightInput } from './deploy-audio-create-preflight.js';
import { loadEditableMediaSource } from './editable-media-source.js';
import { getVariant, getWorkspace } from './read.js';
import { assertCanonicalMarketingWorkspace } from './resolve-workspace.js';
import { acquireEditableMediaSource } from './retrieve-media-source.js';
import { enumerateNativeWorkspace } from './retrieve-native-inventory.js';

type AudioConnection = Pick<Connection, 'request' | 'getApiVersion'> &
  Partial<Pick<Connection, 'accessToken' | 'instanceUrl'>>;
export type DeployAudioUpdatePreflightInput = DeployAudioCreatePreflightInput;

/**
 * Observe a bytes-only Audio replacement without journaling or mutation authority.
 * The candidate envelope is local and unqualified: native Audio UPDATE remains unproven.
 * @param {AudioConnection} connection - Explicit authenticated destination connection.
 * @param {DeployAudioUpdatePreflightInput} input - Local source and exact destination scope.
 * @param {JsonRequestOptions} options - Bounded read options and boundary cancellation.
 * @returns {Promise<object>} Detached source, candidate payload, hashes and destination observations.
 */
export async function preflightDeployAudioUpdate(
  connection: AudioConnection,
  input: DeployAudioUpdatePreflightInput,
  options: JsonRequestOptions = {},
) {
  const selected = structuredClone(input);
  const requestOptions = { ...options };
  const checkCancellation = (): void => {
    if (requestOptions.signal?.aborted) throw new TypeError('Audio UPDATE cancelled');
  };
  checkCancellation();
  sourcePathSegment(selected.language);
  if (!/^0Zu[A-Za-z0-9]{12}[A-Z0-5]{3}$/u.test(selected.workspaceId))
    throw new TypeError('Audio UPDATE requires exact destination workspace ID');
  const source = await loadEditableMediaSource(selected.definitionFile);
  checkCancellation();
  const desired = source.definition;
  if (
    desired.contentType !== 'sfdc_cms__audio' ||
    source.source.representation !== 'binary' ||
    desired.language !== selected.language ||
    desired.folderPath.length > 0 ||
    typeof desired.title !== 'string' ||
    !desired.title.trim() ||
    (desired.urlName !== undefined && !/^[a-z0-9-]+$/u.test(desired.urlName))
  )
    throw new TypeError('Audio UPDATE requires portable binary Audio, metadata, root and language');
  const binary = source.source.binary;
  const metadata = {
    title: desired.title,
    ...(desired.urlName === undefined ? {} : { urlName: desired.urlName }),
  };
  // Pure framing validates local intent before any destination GET, without format/size policy.
  const payload = buildAudioUpdateMultipart(metadata, binary.fileName, binary.bytes, {
    mimeType: binary.mimeType,
  }).input;
  const workspace = await getWorkspace(connection, selected.workspaceId, requestOptions);
  checkCancellation();
  if (
    workspace.id !== selected.workspaceId ||
    workspace.defaultLanguage !== selected.language ||
    (selected.expectedRootFolderId !== undefined &&
      workspace.rootFolderId !== selected.expectedRootFolderId) ||
    typeof workspace.rootFolderId !== 'string' ||
    !workspace.rootFolderId
  )
    throw new TypeError('Audio UPDATE requires exact workspace root and default language');
  await assertCanonicalMarketingWorkspace(
    connection,
    { id: selected.workspaceId, workspace },
    requestOptions,
  );
  checkCancellation();
  const inventory = await enumerateNativeWorkspace(
    connection,
    selected.workspaceId,
    requestOptions,
  );
  checkCancellation();
  if (inventory.records.some((row) => !row.ManagedContent.ApiName))
    throw new TypeError('Audio UPDATE collision evidence has unknown parent API name');
  const candidates = inventory.records.filter(
    (row) =>
      row.ManagedContent.ApiName === desired.identity.apiName ||
      row.Name === desired.title ||
      (desired.urlName !== undefined && row.UrlName === desired.urlName),
  );
  const row = candidates[0];
  if (
    candidates.length !== 1 ||
    row.ManagedContent.ApiName !== desired.identity.apiName ||
    row.Name !== desired.title ||
    (row.UrlName ?? undefined) !== desired.urlName ||
    row.ContentTypeFullyQualifiedName !== 'sfdc_cms__audio' ||
    row.Language !== selected.language ||
    row.IsPrimary !== true ||
    row.IsPublished !== false ||
    row.ManagedContentVariantStatus !== 'Draft'
  )
    throw new TypeError('Audio UPDATE requires one exact native primary unpublished Draft');
  const before = await getVariant(connection, row.Id, requestOptions);
  checkCancellation();
  const acquired = await acquireEditableMediaSource(
    connection,
    {
      workspaceId: selected.workspaceId,
      apiName: desired.identity.apiName,
      language: selected.language,
      contentType: 'sfdc_cms__audio',
    },
    requestOptions,
  );
  // Shared binary download has no AbortSignal: check boundaries without expanding its contract.
  checkCancellation();
  const actual = acquired.projection.definition;
  if (
    acquired.evidence.contentId !== row.ManagedContentId ||
    acquired.evidence.variantId !== row.Id ||
    actual.title !== desired.title ||
    actual.urlName !== desired.urlName ||
    actual.media.representation !== 'binary' ||
    actual.media.mimeType !== binary.mimeType ||
    acquired.projection.companions.length !== 1
  )
    throw new TypeError('Audio UPDATE independent media metadata/identity mismatch');
  const observedBytes = acquired.projection.companions[0].bytes;
  const after = await getVariant(connection, row.Id, requestOptions);
  checkCancellation();
  const media = (after.contentBody as Record<string, { url?: string }> | undefined)?.[
    'sfdc_cms:media'
  ];
  // Compare the original native filename, not the independently normalized portable companion.
  if (
    !isDeepStrictEqual(before, after) ||
    after.managedContentId !== row.ManagedContentId ||
    after.managedContentVariantId !== row.Id ||
    after.contentKey !== row.ManagedContentKey ||
    new URL(media?.url ?? '', connection.instanceUrl ?? 'https://local.invalid').searchParams.get(
      'fileName',
    ) !== binary.fileName
  )
    throw new TypeError('Audio UPDATE native filename/identity readback mismatch');
  buildAudioUpdateMultipart(metadata, binary.fileName, observedBytes, {
    mimeType: binary.mimeType,
  });
  if (observedBytes.equals(binary.bytes))
    throw new TypeError('Audio UPDATE requires different bytes; use unchanged admission');
  const finalInventory = await enumerateNativeWorkspace(
    connection,
    selected.workspaceId,
    requestOptions,
  );
  checkCancellation();
  const finalWorkspace = await getWorkspace(connection, selected.workspaceId, requestOptions);
  checkCancellation();
  const finalVariant = await getVariant(connection, row.Id, requestOptions);
  checkCancellation();
  const finalSource = await loadEditableMediaSource(selected.definitionFile);
  checkCancellation();
  if (
    !isDeepStrictEqual(finalInventory, inventory) ||
    !isDeepStrictEqual(finalWorkspace, workspace) ||
    !isDeepStrictEqual(finalVariant, after) ||
    !isDeepStrictEqual(finalSource, source) ||
    getCmsApiSelection(connection).effectiveApiVersion !== inventory.apiVersion
  )
    throw new TypeError('Audio UPDATE local or destination evidence drifted');
  checkCancellation();
  return {
    qualification: 'unqualified' as const,
    operation: 'update' as const,
    definitionFile: source.definitionPath,
    workspaceId: selected.workspaceId,
    rootFolderId: workspace.rootFolderId,
    language: selected.language,
    apiVersion: inventory.apiVersion,
    contentId: row.ManagedContentId,
    contentKey: row.ManagedContentKey,
    variantId: row.Id,
    source,
    payload,
    sourceSha256: createHash('sha256')
      .update(JSON.stringify(desired))
      .update(binary.bytes)
      .digest('hex'),
    mediaSha256: createHash('sha256').update(binary.bytes).digest('hex'),
    destination: {
      workspace,
      inventory,
      variant: after,
      acquisition: acquired,
      mediaSha256: createHash('sha256').update(observedBytes).digest('hex'),
    },
  };
}
