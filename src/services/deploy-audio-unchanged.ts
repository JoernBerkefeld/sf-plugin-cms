import type { Connection } from '@salesforce/core';
import { isDeepStrictEqual } from 'node:util';
import { getCmsApiSelection } from '../api-policy.js';
import { sourcePathSegment } from '../contracts/source-definition.js';
import type { JsonRequestOptions } from '../transport/json-request.js';
import { buildAudioCreateMultipart } from '../transport/multipart-image-create.js';
import type { DeployAudioCreatePreflightInput } from './deploy-audio-create-preflight.js';
import { loadEditableMediaSource } from './editable-media-source.js';
import { getVariant, getWorkspace } from './read.js';
import { assertCanonicalMarketingWorkspace } from './resolve-workspace.js';
import { acquireEditableMediaSource } from './retrieve-media-source.js';
import { enumerateNativeWorkspace } from './retrieve-native-inventory.js';

type AudioConnection = Pick<Connection, 'request' | 'getApiVersion'> &
  Partial<Pick<Connection, 'accessToken' | 'instanceUrl'>>;
export type DeployAudioUnchangedInput = DeployAudioCreatePreflightInput;
export type DeployAudioUnchangedResult = {
  qualification: 'unqualified';
  operation: 'unchanged';
  contentId: string;
  contentKey: string;
  variantId: string;
};

/**
 * Observe exact unchanged portable binary Audio without journal or mutation authority.
 * Opaque bytes and explicit MIME are local framing evidence, not platform qualification.
 * @param {AudioConnection} connection - Explicit authenticated destination connection.
 * @param {DeployAudioUnchangedInput} input - Local source and exact destination scope.
 * @param {JsonRequestOptions} options - Bounded read options and boundary cancellation.
 * @returns {Promise<DeployAudioUnchangedResult>} Unqualified identity after exact readback.
 */
export async function admitDeployAudioUnchanged(
  connection: AudioConnection,
  input: DeployAudioUnchangedInput,
  options: JsonRequestOptions = {},
): Promise<DeployAudioUnchangedResult> {
  const selected = structuredClone(input);
  const requestOptions = { ...options };
  const checkCancellation = (): void => {
    if (requestOptions.signal?.aborted) throw new TypeError('Audio unchanged cancelled');
  };
  checkCancellation();
  sourcePathSegment(selected.language);
  if (!/^0Zu[A-Za-z0-9]{12}[A-Z0-5]{3}$/u.test(selected.workspaceId))
    throw new TypeError('Audio unchanged requires exact destination workspace ID');
  const source = await loadEditableMediaSource(selected.definitionFile);
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
    throw new TypeError(
      'Audio unchanged requires portable binary Audio, metadata, root and language',
    );
  const binary = source.source.binary;
  // Validate safe local framing before any destination GET; no format or size qualification.
  buildAudioCreateMultipart(
    {
      apiName: desired.identity.apiName,
      title: desired.title,
      ...(desired.urlName === undefined ? {} : { urlName: desired.urlName }),
      contentSpaceOrFolderId: selected.workspaceId,
    },
    binary.fileName,
    binary.bytes,
    { mimeType: binary.mimeType },
  );
  checkCancellation();
  const workspace = await getWorkspace(connection, selected.workspaceId, requestOptions);
  if (
    workspace.id !== selected.workspaceId ||
    workspace.defaultLanguage !== selected.language ||
    (selected.expectedRootFolderId !== undefined &&
      workspace.rootFolderId !== selected.expectedRootFolderId) ||
    typeof workspace.rootFolderId !== 'string' ||
    !workspace.rootFolderId
  )
    throw new TypeError('Audio unchanged requires exact workspace root and default language');
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
    throw new TypeError('Audio unchanged collision evidence has unknown parent API name');
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
    throw new TypeError('Audio unchanged requires one exact native primary unpublished Draft');
  const before = await getVariant(connection, row.Id, requestOptions);
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
  // The shared binary download has no AbortSignal: cancellation is checked at boundaries only.
  checkCancellation();
  const actual = acquired.projection.definition;
  if (
    acquired.evidence.contentId !== row.ManagedContentId ||
    acquired.evidence.variantId !== row.Id ||
    actual.title !== desired.title ||
    actual.urlName !== desired.urlName ||
    actual.media.representation !== 'binary' ||
    actual.media.mimeType !== binary.mimeType ||
    acquired.projection.companions.length !== 1 ||
    !acquired.projection.companions[0].bytes.equals(binary.bytes)
  )
    throw new TypeError('Audio unchanged independent media readback mismatch');
  // Projection normalizes paths; independently bind the original native URL filename and key.
  const after = await getVariant(connection, row.Id, requestOptions);
  const media = (after.contentBody as Record<string, { url?: string }> | undefined)?.[
    'sfdc_cms:media'
  ];
  if (
    !isDeepStrictEqual(before, after) ||
    after.managedContentId !== row.ManagedContentId ||
    after.managedContentVariantId !== row.Id ||
    after.contentKey !== row.ManagedContentKey ||
    new URL(media?.url ?? '', connection.instanceUrl ?? 'https://local.invalid').searchParams.get(
      'fileName',
    ) !== binary.fileName
  )
    throw new TypeError('Audio unchanged native filename/identity readback mismatch');
  if (
    !isDeepStrictEqual(
      await enumerateNativeWorkspace(connection, selected.workspaceId, requestOptions),
      inventory,
    ) ||
    !isDeepStrictEqual(
      await getWorkspace(connection, selected.workspaceId, requestOptions),
      workspace,
    ) ||
    !isDeepStrictEqual(await loadEditableMediaSource(selected.definitionFile), source) ||
    getCmsApiSelection(connection).effectiveApiVersion !== inventory.apiVersion
  )
    throw new TypeError('Audio unchanged local or destination evidence drifted');
  checkCancellation();
  return {
    qualification: 'unqualified',
    operation: 'unchanged',
    contentId: row.ManagedContentId,
    contentKey: row.ManagedContentKey,
    variantId: row.Id,
  };
}
