import type { Connection } from '@salesforce/core';
import { isDeepStrictEqual } from 'node:util';
import type { JsonRequestOptions } from '../transport/json-request.js';
import { sourcePathSegment } from '../contracts/source-definition.js';
import { assertSingleDefaultEmailFragmentVariant } from '../contracts/email-fragment-source.js';
import { loadEditableEmailFragmentSource } from './editable-item-source.js';
import { acquireEditableEmailFragmentSource } from './retrieve-item-source.js';
import { enumerateNativeWorkspace } from './retrieve-native-inventory.js';
import { getWorkspace } from './read.js';
import { assertCanonicalMarketingWorkspace } from './resolve-workspace.js';
import type { FragmentDestinationInput } from './deploy-destination-folder-mapping.js';
import {
  resolveEmailFragmentFolder,
  assertEmailFragmentNativeFolder,
} from './resolve-email-fragment-folder.js';
import { getContent, getVariant } from './read.js';

type DestinationConnection = Pick<Connection, 'request' | 'getApiVersion'>;

/** Identity observations only: references, folder mapping and operation preview remain unqualified. */
export type EmailFragmentDestination = {
  qualification: 'unqualified';
  source: Awaited<ReturnType<typeof loadEditableEmailFragmentSource>>;
  workspace: { id: string; apiName: string; defaultLanguage: string; rootFolderId: string };
  folder: Awaited<ReturnType<typeof resolveEmailFragmentFolder>>;
  inventory: Awaited<ReturnType<typeof enumerateNativeWorkspace>>;
  existing?: Awaited<ReturnType<typeof acquireEditableEmailFragmentSource>>;
};

/**
 * Resolve a standalone Fragment against destination-local native identity without mutation authority.
 * This preparatory boundary does not propose CREATE, UPDATE or unchanged until reference/folder proof exists.
 * @param {DestinationConnection} connection - Explicit destination org connection.
 * @param {object} input - Strict source filename and exact destination workspace ID.
 * @param {string} input.definitionFile - Standalone source definition path.
 * @param {string} input.workspaceId - Exact destination workspace ID.
 * @param {JsonRequestOptions} options - Bounded read timeout/cancellation options.
 * @returns {Promise<EmailFragmentDestination>} Detached absence or single-default Draft identity evidence.
 */
export async function resolveEmailFragmentDeployDestination(
  connection: DestinationConnection,
  input: FragmentDestinationInput,
  options: JsonRequestOptions = {},
): Promise<EmailFragmentDestination> {
  const selected = structuredClone(input);
  const requestOptions = { ...options };
  if (
    selected.destinationFolderId !== undefined &&
    !/^9Pu[A-Za-z0-9]{12}(?:[A-Z0-5]{3})?$/u.test(selected.destinationFolderId)
  )
    throw new TypeError('Invalid explicit destination folder ID');
  if (!/^0Zu[A-Za-z0-9]{12}[A-Z0-5]{3}$/u.test(selected.workspaceId))
    throw new TypeError('Exact destination workspace ID is required');
  const source = await loadEditableEmailFragmentSource(selected.definitionFile);
  const workspace = await getWorkspace(connection, selected.workspaceId, requestOptions);
  if (
    workspace.id !== selected.workspaceId ||
    typeof workspace.apiName !== 'string' ||
    typeof workspace.defaultLanguage !== 'string' ||
    typeof workspace.rootFolderId !== 'string' ||
    !/^9Pu[A-Za-z0-9]{12}[A-Z0-5]{3}$/u.test(workspace.rootFolderId)
  )
    throw new TypeError(
      'Destination workspace identity/default language/root evidence is required',
    );
  sourcePathSegment(workspace.apiName);
  sourcePathSegment(workspace.defaultLanguage);
  if (source.definition.language !== workspace.defaultLanguage)
    throw new TypeError('Fragment source must match the exact destination default language');
  await assertCanonicalMarketingWorkspace(
    connection,
    { id: selected.workspaceId, workspace },
    requestOptions,
  );
  const folder = await resolveEmailFragmentFolder(
    connection,
    { id: selected.workspaceId, rootFolderId: workspace.rootFolderId },
    source.definition.folderPath,
    selected.destinationFolderId,
    requestOptions,
  );
  const inventory = await enumerateNativeWorkspace(
    connection,
    selected.workspaceId,
    requestOptions,
  );
  const conflicts = inventory.records.filter(
    (row) => row.ManagedContent.ApiName === source.definition.identity.apiName,
  );
  let existing: EmailFragmentDestination['existing'];
  if (conflicts.length === 0) {
    if (inventory.records.some((row) => !row.ManagedContent.ApiName))
      throw new TypeError('Fragment destination absence is unproven: unknown parent API name');
    if (
      inventory.records.some(
        (row) => row.Name === source.definition.title || row.UrlName === source.definition.urlName,
      )
    )
      throw new TypeError('Fragment destination title/URL collision');
  } else {
    assertSingleDefaultEmailFragmentVariant(
      conflicts.map((row) => ({ ...row, VariantType: row.VariantType ?? '' })),
      workspace.defaultLanguage,
    );
    const row = conflicts[0];
    if (
      row.ContentTypeFullyQualifiedName !== source.definition.contentType ||
      row.IsPublished !== false ||
      row.ManagedContentVariantStatus !== 'Draft'
    )
      throw new TypeError('Fragment destination requires the exact unpublished Draft content type');
    existing = await acquireEditableEmailFragmentSource(
      connection,
      {
        workspaceId: selected.workspaceId,
        apiName: source.definition.identity.apiName,
        language: workspace.defaultLanguage,
      },
      requestOptions,
    );
    if (
      existing.evidence.variantId !== row.Id ||
      existing.evidence.contentId !== row.ManagedContentId ||
      existing.projection.definition.identity.context.workspaceApiName !== workspace.apiName
    )
      throw new TypeError('Fragment destination identity changed during resolution');
    const parent = await getContent(connection, existing.evidence.contentId, {}, requestOptions);
    const variant = await getVariant(connection, existing.evidence.variantId, requestOptions);
    assertEmailFragmentNativeFolder(
      variant.folder,
      parent.folder,
      folder.id,
      workspace.rootFolderId,
    );
    if (!isDeepStrictEqual(existing.projection.definition.folderPath, folder.path))
      throw new TypeError('Fragment existing folder path disagrees with validated destination');
  }
  if (
    !isDeepStrictEqual(await loadEditableEmailFragmentSource(selected.definitionFile), source) ||
    !isDeepStrictEqual(
      await getWorkspace(connection, selected.workspaceId, requestOptions),
      workspace,
    ) ||
    !isDeepStrictEqual(
      await enumerateNativeWorkspace(connection, selected.workspaceId, requestOptions),
      inventory,
    )
  )
    throw new TypeError('Fragment source or destination changed during resolution');
  return {
    qualification: 'unqualified',
    source,
    workspace: {
      id: selected.workspaceId,
      apiName: workspace.apiName,
      defaultLanguage: workspace.defaultLanguage,
      rootFolderId: workspace.rootFolderId,
    },
    folder,
    inventory,
    ...(existing ? { existing } : {}),
  };
}
