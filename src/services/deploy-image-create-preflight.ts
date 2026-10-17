import type { Connection } from '@salesforce/core';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { sourcePathSegment } from '../contracts/source-definition.js';
import type { JsonRequestOptions } from '../transport/json-request.js';
import {
  buildImageCreateMultipart,
  type ImageCreateInput,
} from '../transport/multipart-image-create.js';
import { loadEditableMediaSource } from './editable-media-source.js';
import { getWorkspace } from './read.js';
import { assertCanonicalMarketingWorkspace } from './resolve-workspace.js';
import { enumerateNativeWorkspace } from './retrieve-native-inventory.js';

type DestinationConnection = Pick<Connection, 'request' | 'getApiVersion'>;
export type DeployImageCreatePreflightInput = {
  definitionFile: string;
  workspaceId: string;
  language: string;
  /** Destination root binding retained through every independently reacquired proof. */
  expectedRootFolderId?: string;
};

/**
 * Observe portable binary Image CREATE intent without allocating a journal or mutating an org.
 * Executors must independently reacquire this evidence before their journaled transport call.
 * @param {DestinationConnection} connection - Explicit destination connection.
 * @param {DeployImageCreatePreflightInput} input - Local item and exact destination scope.
 * @param {JsonRequestOptions} options - Bounded read options only.
 * @returns {Promise<object>} Detached unqualified source, metadata payload and drift hash.
 */
export async function preflightDeployImageCreate(
  connection: DestinationConnection,
  input: DeployImageCreatePreflightInput,
  options: JsonRequestOptions = {},
) {
  const selected = structuredClone(input);
  const requestOptions = { ...options };
  sourcePathSegment(selected.language);
  if (!/^0Zu[A-Za-z0-9]{12}[A-Z0-5]{3}$/u.test(selected.workspaceId))
    throw new TypeError('Image CREATE requires exact destination workspace ID');
  const load = async () => loadEditableMediaSource(selected.definitionFile);
  const source = await load();
  const { definition } = source;
  if (definition.contentType !== 'sfdc_cms__image' || source.source.representation !== 'binary')
    throw new TypeError('Image CREATE requires a portable binary Image source');
  if (definition.language !== selected.language || definition.folderPath.length > 0)
    throw new TypeError('Image CREATE requires exact language and root placement');
  if (typeof definition.title !== 'string' || !definition.title.trim())
    throw new TypeError('Image CREATE requires an explicit nonempty title');
  if (definition.urlName !== undefined && !/^[a-z0-9-]+$/u.test(definition.urlName))
    throw new TypeError('Image CREATE URL name must use lowercase letters, digits or hyphens');
  const { binary } = source.source;
  const metadata = {
    apiName: definition.identity.apiName,
    title: definition.title,
    ...(definition.urlName === undefined ? {} : { urlName: definition.urlName }),
  };
  // Validate transport framing locally before any destination read, without sending bytes.
  buildImageCreateMultipart(
    { ...metadata, contentSpaceOrFolderId: selected.workspaceId },
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
    workspace.rootFolderId.length === 0
  )
    throw new TypeError('Image CREATE requires exact workspace root and default language');
  await assertCanonicalMarketingWorkspace(
    connection,
    { id: selected.workspaceId, workspace },
    requestOptions,
  );
  const payload: ImageCreateInput = {
    ...metadata,
    contentSpaceOrFolderId: workspace.rootFolderId,
  };
  const inventory = await enumerateNativeWorkspace(
    connection,
    selected.workspaceId,
    requestOptions,
  );
  for (const row of inventory.records) {
    if (!row.ManagedContent.ApiName)
      throw new TypeError('Image CREATE absence unproven: unknown parent API name');
    if (
      row.ManagedContent.ApiName === payload.apiName ||
      row.Name === payload.title ||
      (payload.urlName !== undefined && row.UrlName === payload.urlName)
    )
      throw new TypeError('Image CREATE destination API/title/URL collision');
  }
  if (
    !isDeepStrictEqual(
      await getWorkspace(connection, selected.workspaceId, requestOptions),
      workspace,
    )
  )
    throw new TypeError('Image CREATE destination workspace drifted during preflight');
  if (!isDeepStrictEqual(await load(), source))
    throw new TypeError('Image CREATE local source drifted during preflight');
  // Bind desired metadata and exact bytes, not source paths, org IDs or an authoring baseline.
  const sourceSha256 = createHash('sha256')
    .update(JSON.stringify(definition))
    .update(binary.bytes)
    .digest('hex');
  return {
    qualification: 'unqualified' as const,
    definitionFile: source.definitionPath,
    workspaceId: selected.workspaceId,
    rootFolderId: workspace.rootFolderId,
    language: selected.language,
    apiVersion: inventory.apiVersion,
    source: { ...source, source: source.source },
    payload,
    sourceSha256,
  };
}
