import type { Connection } from '@salesforce/core';
import { isDeepStrictEqual } from 'node:util';
import { sourcePathSegment } from '../contracts/source-definition.js';
import type { JsonRequestOptions } from '../transport/json-request.js';
import { buildDocumentCreateMultipart } from '../transport/multipart-image-create.js';
import type { DeployDocumentCreatePreflightInput } from './deploy-document-create-preflight.js';
import { loadEditableMediaSource } from './editable-media-source.js';
import { getVariant, getWorkspace } from './read.js';
import { assertCanonicalMarketingWorkspace } from './resolve-workspace.js';
import { acquireEditableMediaSource } from './retrieve-media-source.js';
import { enumerateNativeWorkspace } from './retrieve-native-inventory.js';

type DocumentConnection = Pick<Connection, 'request' | 'getApiVersion'> &
  Partial<Pick<Connection, 'accessToken' | 'instanceUrl'>>;
export type DeployDocumentUnchangedInput = DeployDocumentCreatePreflightInput;
export type DeployDocumentUnchangedResult = {
  qualification: 'unqualified';
  operation: 'unchanged';
  contentId: string;
  contentKey: string;
  variantId: string;
};

/**
 * Observe exact unchanged Document content without mutation or UPDATE authority.
 * Safe native MIME and opaque nonempty bytes retain identity and integrity checks.
 * @param {DocumentConnection} connection - Explicit authenticated destination connection.
 * @param {DeployDocumentUnchangedInput} input - Local source and exact destination scope.
 * @param {JsonRequestOptions} options - Bounded read options only.
 * @returns {Promise<DeployDocumentUnchangedResult>} Unqualified read-only identity proof.
 */
export async function admitDeployDocumentUnchanged(
  connection: DocumentConnection,
  input: DeployDocumentUnchangedInput,
  options: JsonRequestOptions = {},
): Promise<DeployDocumentUnchangedResult> {
  const selected = structuredClone(input);
  const requestOptions = { ...options };
  sourcePathSegment(selected.language);
  if (!/^0Zu[A-Za-z0-9]{12}[A-Z0-5]{3}$/u.test(selected.workspaceId))
    throw new TypeError('Document unchanged requires exact destination workspace ID');
  const source = await loadEditableMediaSource(selected.definitionFile);
  const desired = source.definition;
  if (
    desired.contentType !== 'sfdc_cms__document' ||
    source.source.representation !== 'binary' ||
    desired.language !== selected.language ||
    desired.folderPath.length > 0 ||
    typeof desired.title !== 'string' ||
    !desired.title.trim() ||
    (desired.urlName !== undefined && !/^[a-z0-9-]+$/u.test(desired.urlName))
  )
    throw new TypeError(
      'Document unchanged requires portable binary Document, metadata, root and language',
    );
  const binary = source.source.binary;
  // Reuse the current local framing profile without sending a request.
  buildDocumentCreateMultipart(
    {
      apiName: desired.identity.apiName,
      title: desired.title,
      contentSpaceOrFolderId: selected.workspaceId,
    },
    binary.fileName,
    binary.bytes,
    { mimeType: binary.mimeType },
  );
  const workspace = await getWorkspace(connection, selected.workspaceId, requestOptions);
  if (
    workspace.id !== selected.workspaceId ||
    workspace.defaultLanguage !== selected.language ||
    (selected.expectedRootFolderId !== undefined &&
      workspace.rootFolderId !== selected.expectedRootFolderId) ||
    typeof workspace.rootFolderId !== 'string' ||
    !workspace.rootFolderId
  )
    throw new TypeError('Document unchanged requires exact workspace root and default language');
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
    throw new TypeError('Document unchanged collision evidence has unknown parent API name');
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
    row.ContentTypeFullyQualifiedName !== 'sfdc_cms__document' ||
    row.Language !== selected.language ||
    row.IsPrimary !== true ||
    row.IsPublished !== false ||
    row.ManagedContentVariantStatus !== 'Draft'
  )
    throw new TypeError('Document unchanged requires one exact native primary unpublished Draft');
  const before = await getVariant(connection, row.Id, requestOptions);
  const acquired = await acquireEditableMediaSource(
    connection,
    {
      workspaceId: selected.workspaceId,
      apiName: desired.identity.apiName,
      language: selected.language,
      contentType: 'sfdc_cms__document',
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
    acquired.projection.companions.length !== 1 ||
    !acquired.projection.companions[0].bytes.equals(binary.bytes)
  )
    throw new TypeError('Document unchanged independent media readback mismatch');
  // Acquisition normalizes companion paths: independently bind the original native filename.
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
    throw new TypeError('Document unchanged native filename/identity readback mismatch');
  if (
    !isDeepStrictEqual(
      await enumerateNativeWorkspace(connection, selected.workspaceId, requestOptions),
      inventory,
    ) ||
    !isDeepStrictEqual(
      await getWorkspace(connection, selected.workspaceId, requestOptions),
      workspace,
    ) ||
    !isDeepStrictEqual(await loadEditableMediaSource(selected.definitionFile), source)
  )
    throw new TypeError('Document unchanged local or destination evidence drifted');
  return {
    qualification: 'unqualified',
    operation: 'unchanged',
    contentId: row.ManagedContentId,
    contentKey: row.ManagedContentKey,
    variantId: row.Id,
  };
}
