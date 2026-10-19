import type { Connection } from '@salesforce/core';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { sourcePathSegment } from '../contracts/source-definition.js';
import type { JsonRequestOptions } from '../transport/json-request.js';
import {
  buildDocumentCreateMultipart,
  type ImageCreateInput,
} from '../transport/multipart-image-create.js';
import { loadEditableMediaSource } from './editable-media-source.js';
import { getWorkspace } from './read.js';
import { assertCanonicalMarketingWorkspace } from './resolve-workspace.js';
import { enumerateNativeWorkspace } from './retrieve-native-inventory.js';

type DestinationConnection = Pick<Connection, 'request' | 'getApiVersion'>;
export type DeployDocumentCreatePreflightInput = {
  definitionFile: string;
  workspaceId: string;
  language: string;
  expectedRootFolderId?: string;
};

/**
 * Observe bounded portable Document CREATE intent without journal or org mutation authority.
 * Native opaque bytes retain source integrity and safe ASCII filename checks.
 * Executors must independently reacquire observations before any journaled transport call.
 * @param {DestinationConnection} connection - Explicit destination connection.
 * @param {DeployDocumentCreatePreflightInput} input - Local item and exact destination scope.
 * @param {JsonRequestOptions} options - Bounded read options only.
 * @returns {Promise<object>} Detached unqualified source, payload, hashes and destination observations.
 */
export async function preflightDeployDocumentCreate(
  connection: DestinationConnection,
  input: DeployDocumentCreatePreflightInput,
  options: JsonRequestOptions = {},
) {
  const selected = structuredClone(input);
  const requestOptions = { ...options };
  sourcePathSegment(selected.language);
  if (!/^0Zu[A-Za-z0-9]{12}[A-Z0-5]{3}$/u.test(selected.workspaceId))
    throw new TypeError('Document CREATE requires exact destination workspace ID');
  const load = async () => loadEditableMediaSource(selected.definitionFile);
  const source = await load();
  const { definition } = source;
  if (definition.contentType !== 'sfdc_cms__document' || source.source.representation !== 'binary')
    throw new TypeError('Document CREATE requires a portable binary Document source');
  if (definition.language !== selected.language || definition.folderPath.length > 0)
    throw new TypeError('Document CREATE requires exact language and root placement');
  if (typeof definition.title !== 'string' || !definition.title.trim())
    throw new TypeError('Document CREATE requires an explicit nonempty title');
  if (definition.urlName !== undefined && !/^[a-z0-9-]+$/u.test(definition.urlName))
    throw new TypeError('Document CREATE URL name must use lowercase letters, digits or hyphens');
  const { binary } = source.source;
  const metadata = {
    apiName: definition.identity.apiName,
    title: definition.title,
    ...(definition.urlName === undefined ? {} : { urlName: definition.urlName }),
  };
  // Validate existing Document framing locally; the builder does not send a request.
  buildDocumentCreateMultipart(
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
    throw new TypeError('Document CREATE requires exact workspace root and default language');
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
      throw new TypeError('Document CREATE absence unproven: unknown parent API name');
    if (
      row.ManagedContent.ApiName === payload.apiName ||
      row.Name === payload.title ||
      (payload.urlName !== undefined && row.UrlName === payload.urlName)
    )
      throw new TypeError('Document CREATE destination API/title/URL collision');
  }
  if (
    !isDeepStrictEqual(
      await getWorkspace(connection, selected.workspaceId, requestOptions),
      workspace,
    )
  )
    throw new TypeError('Document CREATE destination workspace drifted during preflight');
  if (!isDeepStrictEqual(await load(), source))
    throw new TypeError('Document CREATE local source drifted during preflight');
  const mediaSha256 = createHash('sha256').update(binary.bytes).digest('hex');
  // Bind definition plus exact bytes, not an authoring baseline or permission to mutate.
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
    source,
    payload,
    sourceSha256,
    mediaSha256,
    observations: { workspace, inventory },
  };
}
