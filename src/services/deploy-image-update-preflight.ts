import type { Connection } from '@salesforce/core';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { sourcePathSegment } from '../contracts/source-definition.js';
import type { JsonRequestOptions } from '../transport/json-request.js';
import { buildImageUpdateMultipart } from '../transport/multipart-image-update.js';
import type { DeployImageCreatePreflightInput } from './deploy-image-create-preflight.js';
import { loadEditableMediaSource } from './editable-media-source.js';
import { getVariant, getWorkspace } from './read.js';
import { assertCanonicalMarketingWorkspace } from './resolve-workspace.js';
import { acquireEditableMediaSource } from './retrieve-media-source.js';
import { enumerateNativeWorkspace } from './retrieve-native-inventory.js';

type ImageConnection = Pick<Connection, 'request' | 'getApiVersion'> &
  Partial<Pick<Connection, 'accessToken' | 'instanceUrl'>>;
export type DeployImageUpdatePreflightInput = DeployImageCreatePreflightInput;

/**
 * Observe a bytes-only Image replacement without journaling or destination mutation.
 * Evidence detects observed drift only; it is not an authoring baseline or atomic conflict guard.
 * @param {ImageConnection} connection - Explicit authenticated destination connection.
 * @param {DeployImageUpdatePreflightInput} input - Local source and exact destination scope.
 * @param {JsonRequestOptions} options - Bounded destination read options.
 * @returns {Promise<object>} Detached desired bytes and independently observed destination evidence.
 */
export async function preflightDeployImageUpdate(
  connection: ImageConnection,
  input: DeployImageUpdatePreflightInput,
  options: JsonRequestOptions = {},
) {
  const selected = structuredClone(input);
  const requestOptions = { ...options };
  sourcePathSegment(selected.language);
  if (!/^0Zu[A-Za-z0-9]{12}[A-Z0-5]{3}$/u.test(selected.workspaceId))
    throw new TypeError('Image UPDATE requires exact destination workspace ID');
  const source = await loadEditableMediaSource(selected.definitionFile);
  const desired = source.definition;
  if (
    desired.contentType !== 'sfdc_cms__image' ||
    source.source.representation !== 'binary' ||
    desired.language !== selected.language ||
    desired.folderPath.length > 0 ||
    typeof desired.title !== 'string' ||
    !desired.title.trim()
  )
    throw new TypeError('Image UPDATE requires portable binary Image, title, root and language');
  const binary = source.source.binary;
  // Preserve the unchanged title using the documented binary UPDATE field, not apiName/name.
  const payload = { title: desired.title };
  buildImageUpdateMultipart(payload, binary.fileName, binary.bytes, {
    mimeType: binary.mimeType,
  });
  const workspace = await getWorkspace(connection, selected.workspaceId, requestOptions);
  if (
    workspace.id !== selected.workspaceId ||
    workspace.defaultLanguage !== selected.language ||
    (selected.expectedRootFolderId !== undefined &&
      workspace.rootFolderId !== selected.expectedRootFolderId) ||
    typeof workspace.rootFolderId !== 'string' ||
    !workspace.rootFolderId
  )
    throw new TypeError('Image UPDATE requires exact workspace root and default language');
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
    throw new TypeError('Image UPDATE collision evidence has unknown parent API name');
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
    row.ContentTypeFullyQualifiedName !== 'sfdc_cms__image' ||
    row.Language !== selected.language ||
    row.IsPrimary !== true ||
    row.IsPublished !== false ||
    row.ManagedContentVariantStatus !== 'Draft'
  )
    throw new TypeError('Image UPDATE requires one exact native Draft identity and metadata');
  const before = await getVariant(connection, row.Id, requestOptions);
  const acquired = await acquireEditableMediaSource(
    connection,
    {
      workspaceId: selected.workspaceId,
      apiName: desired.identity.apiName,
      language: selected.language,
      contentType: 'sfdc_cms__image',
    },
    requestOptions,
  );
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
    throw new TypeError('Image UPDATE independent media metadata/identity mismatch');
  const observedBytes = acquired.projection.companions[0].bytes;
  // Acquisition normalizes companion paths; preserve the original native filename separately.
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
    throw new TypeError('Image UPDATE native filename/identity readback mismatch');
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
    throw new TypeError('Image UPDATE local or destination evidence drifted');
  if (observedBytes.equals(binary.bytes))
    throw new TypeError('Image UPDATE requires different bytes; use unchanged admission');
  const mediaSha256 = createHash('sha256').update(binary.bytes).digest('hex');
  const sourceSha256 = createHash('sha256')
    .update(JSON.stringify(desired))
    .update(binary.bytes)
    .digest('hex');
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
    sourceSha256,
    mediaSha256,
    destination: {
      workspace,
      inventory,
      variant: after,
      acquisition: acquired,
      mediaSha256: createHash('sha256').update(observedBytes).digest('hex'),
    },
  };
}
