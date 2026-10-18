import type { Connection } from '@salesforce/core';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { sourcePathSegment } from '../contracts/source-definition.js';
import type { JsonRequestOptions } from '../transport/json-request.js';
import {
  buildDocumentUpdateMultipart,
  type DocumentUpdateInput,
} from '../transport/multipart-document-update.js';
import type { DeployDocumentCreatePreflightInput } from './deploy-document-create-preflight.js';
import { loadEditableMediaSource } from './editable-media-source.js';
import { getVariant, getWorkspace } from './read.js';
import { assertCanonicalMarketingWorkspace } from './resolve-workspace.js';
import { acquireEditableMediaSource } from './retrieve-media-source.js';
import { enumerateNativeWorkspace } from './retrieve-native-inventory.js';

type DocumentConnection = Pick<Connection, 'request' | 'getApiVersion'> &
  Partial<Pick<Connection, 'accessToken' | 'instanceUrl'>>;
export type DeployDocumentUpdatePreflightInput = DeployDocumentCreatePreflightInput;

/**
 * Observe a bytes-only Document replacement, never journal or mutate the destination.
 * Detached observations detect observed drift, not atomic conflicts or mutation authority.
 * @param {DocumentConnection} connection - Explicit authenticated destination connection.
 * @param {DeployDocumentUpdatePreflightInput} input - Local source and exact destination scope.
 * @param {JsonRequestOptions} options - Bounded read options only.
 * @returns {Promise<object>} Unqualified local intent and fresh complete native observations.
 */
export async function preflightDeployDocumentUpdate(
  connection: DocumentConnection,
  input: DeployDocumentUpdatePreflightInput,
  options: JsonRequestOptions = {},
) {
  const selected = structuredClone(input);
  const requestOptions = { ...options };
  sourcePathSegment(selected.language);
  if (!/^0Zu[A-Za-z0-9]{12}[A-Z0-5]{3}$/u.test(selected.workspaceId))
    throw new TypeError('Document UPDATE requires exact destination workspace ID');
  const source = await loadEditableMediaSource(selected.definitionFile);
  const desired = source.definition;
  if (
    desired.contentType !== 'sfdc_cms__document' ||
    source.source.representation !== 'binary' ||
    source.source.binary.mimeType !== 'text/plain' ||
    desired.language !== selected.language ||
    desired.folderPath.length > 0 ||
    typeof desired.title !== 'string' ||
    !desired.title.trim() ||
    typeof desired.urlName !== 'string' ||
    !/^[a-z0-9-]+$/u.test(desired.urlName)
  )
    throw new TypeError(
      'Document UPDATE requires binary text/plain, exact metadata, root and language',
    );
  const binary = source.source.binary;
  const payload: DocumentUpdateInput = {
    apiName: desired.identity.apiName,
    title: desired.title,
    urlName: desired.urlName,
    contentBody: { 'sfdc_cms:media': { source: { type: 'file' } } },
  };
  // Validate the accepted bytes-only profile and envelope without retaining or sending a body.
  buildDocumentUpdateMultipart(payload, binary.fileName, binary.bytes);
  const workspace = await getWorkspace(connection, selected.workspaceId, requestOptions);
  if (
    workspace.id !== selected.workspaceId ||
    workspace.defaultLanguage !== selected.language ||
    (selected.expectedRootFolderId !== undefined &&
      workspace.rootFolderId !== selected.expectedRootFolderId) ||
    typeof workspace.rootFolderId !== 'string' ||
    !workspace.rootFolderId
  )
    throw new TypeError('Document UPDATE requires exact workspace root and default language');
  await assertCanonicalMarketingWorkspace(
    connection,
    { id: selected.workspaceId, workspace },
    requestOptions,
  );
  const inventory = await enumerateNativeWorkspace(
    connection,
    selected.workspaceId,
    requestOptions,
  );
  if (inventory.records.some((row) => !row.ManagedContent.ApiName))
    throw new TypeError('Document UPDATE collision evidence has unknown parent API name');
  const candidates = inventory.records.filter(
    (row) =>
      row.ManagedContent.ApiName === payload.apiName ||
      row.Name === payload.title ||
      row.UrlName === payload.urlName,
  );
  const row = candidates[0];
  if (
    candidates.length !== 1 ||
    row.ManagedContent.ApiName !== payload.apiName ||
    row.Name !== payload.title ||
    row.UrlName !== payload.urlName ||
    row.ContentTypeFullyQualifiedName !== 'sfdc_cms__document' ||
    row.Language !== selected.language ||
    row.IsPrimary !== true ||
    row.IsPublished !== false ||
    row.ManagedContentVariantStatus !== 'Draft'
  )
    throw new TypeError('Document UPDATE requires one exact native primary unpublished Draft');
  const before = await getVariant(connection, row.Id, requestOptions);
  const acquired = await acquireEditableMediaSource(
    connection,
    {
      workspaceId: selected.workspaceId,
      apiName: payload.apiName,
      language: selected.language,
      contentType: 'sfdc_cms__document',
    },
    requestOptions,
  );
  const actual = acquired.projection.definition;
  if (
    acquired.evidence.contentId !== row.ManagedContentId ||
    acquired.evidence.variantId !== row.Id ||
    actual.title !== payload.title ||
    actual.urlName !== payload.urlName ||
    actual.media.representation !== 'binary' ||
    actual.media.mimeType !== binary.mimeType ||
    acquired.projection.companions.length !== 1
  )
    throw new TypeError('Document UPDATE independent media metadata/identity mismatch');
  const observedBytes = acquired.projection.companions[0].bytes;
  const after = await getVariant(connection, row.Id, requestOptions);
  const media = (after.contentBody as Record<string, { url?: string }> | undefined)?.[
    'sfdc_cms:media'
  ];
  // Acquisition normalizes companion paths; independently preserve the native filename.
  if (
    !isDeepStrictEqual(before, after) ||
    after.managedContentId !== row.ManagedContentId ||
    after.managedContentVariantId !== row.Id ||
    after.contentKey !== row.ManagedContentKey ||
    new URL(media?.url ?? '', connection.instanceUrl ?? 'https://local.invalid').searchParams.get(
      'fileName',
    ) !== binary.fileName
  )
    throw new TypeError('Document UPDATE native filename/identity readback mismatch');
  // The current binary must independently meet the same bounded profile as the selected binary.
  buildDocumentUpdateMultipart(payload, binary.fileName, observedBytes);
  if (
    !isDeepStrictEqual(
      await enumerateNativeWorkspace(connection, selected.workspaceId, requestOptions),
      inventory,
    ) ||
    !isDeepStrictEqual(
      await getWorkspace(connection, selected.workspaceId, requestOptions),
      workspace,
    ) ||
    !isDeepStrictEqual(await getVariant(connection, row.Id, requestOptions), after) ||
    !isDeepStrictEqual(await loadEditableMediaSource(selected.definitionFile), source)
  )
    throw new TypeError('Document UPDATE local or destination evidence drifted');
  if (observedBytes.equals(binary.bytes))
    throw new TypeError('Document UPDATE requires different bytes; use unchanged admission');
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
