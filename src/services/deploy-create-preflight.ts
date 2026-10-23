import type { Connection } from '@salesforce/core';
import { isDeepStrictEqual } from 'node:util';
import type { JsonRequestOptions } from '../transport/json-request.js';
import { sourcePathSegment } from '../contracts/source-definition.js';
import { assertNativeBody } from './import-identities.js';
import { createPayload, type WorkspaceImportItem } from './import-workspace.js';
import { brandCreatePayload } from './brand.js';
import { assertSourceDefinition } from '../contracts/source-definition.js';
import { selectDeploySources } from './deploy-source-selection.js';
import { enumerateNativeWorkspace } from './retrieve-native-inventory.js';
import { getWorkspace } from './read.js';
import { assertCanonicalMarketingWorkspace } from './resolve-workspace.js';
import type { CreateContentInput } from './write.js';

type DestinationConnection = Pick<Connection, 'request' | 'getApiVersion'>;
export type DeployCreatePreflightInput = {
  definitionFile: string;
  workspaceId: string;
  language: string;
  /** Brand item executor admission; selection alone never authorizes CREATE. */
  includeUnqualifiedBrands?: boolean;
};
export type DeployCreatePreflight = {
  /** Detached observation only: never a mutation capability or whole-selection approval. */
  qualification: 'unqualified';
  definitionFile: string;
  workspaceId: string;
  rootFolderId: string;
  language: string;
  apiVersion: string;
  payload: CreateContentInput;
};

/**
 * Acquire a single portable CREATE candidate without accepting caller bodies or absence proof.
 * This is read-only; execution must reacquire absence immediately before its journaled POST.
 * @param {DestinationConnection} connection - Explicit destination org connection.
 * @param {DeployCreatePreflightInput} input - Local definition and exact destination scope.
 * @param {JsonRequestOptions} options - Bounded read timeout/cancellation options.
 * @returns {Promise<DeployCreatePreflight>} Unqualified payload observation, never apply authority.
 */
export async function preflightDeployCreate(
  connection: DestinationConnection,
  input: DeployCreatePreflightInput,
  options: JsonRequestOptions = {},
): Promise<DeployCreatePreflight> {
  const selected = structuredClone(input);
  const requestOptions = { ...options };
  sourcePathSegment(selected.language);
  if (!/^0Zu[A-Za-z0-9]{12}[A-Z0-5]{3}$/u.test(selected.workspaceId))
    throw new TypeError('CREATE requires exact destination workspace ID');
  const load = async () =>
    selectDeploySources(
      { 'source-dir': [selected.definitionFile] },
      { includeUnqualifiedBrands: selected.includeUnqualifiedBrands === true },
    );
  const source = await load();
  const item = source.items[0];
  const definition = item.definition;
  if (definition.language !== selected.language || definition.folderPath.length > 0)
    throw new TypeError('CREATE requires exact language and root placement');
  if (
    typeof definition.title !== 'string' ||
    definition.title !== item.contentBody['sfdc_cms:title']
  )
    throw new TypeError('CREATE requires explicit title matching native body title');
  if (definition.urlName !== undefined && !/^[a-z0-9-]+$/u.test(definition.urlName))
    throw new TypeError('CREATE URL name must use lowercase letters, digits or hyphens');
  const bodyUrl = item.contentBody['sfdc_cms:urlName'];
  if (bodyUrl !== undefined && bodyUrl !== definition.urlName)
    throw new TypeError('CREATE requires matching explicit native URL name');
  // Portable admission is not CREATE admission: reuse the existing native CREATE profile.
  // Keep textContent and structured supported fields intact; never silently strip a field.
  const brand = definition.contentType === 'sfdc_cms__brand';
  if (brand) assertSourceDefinition(definition);
  else
    assertNativeBody({
      contentType: definition.contentType,
      contentBody: item.contentBody,
    } as unknown as WorkspaceImportItem);
  const workspace = await getWorkspace(connection, selected.workspaceId, requestOptions);
  if (
    workspace.id !== selected.workspaceId ||
    workspace.defaultLanguage !== selected.language ||
    typeof workspace.rootFolderId !== 'string' ||
    workspace.rootFolderId.length === 0
  )
    throw new TypeError('CREATE requires exact workspace root and default language');
  await assertCanonicalMarketingWorkspace(
    connection,
    { id: selected.workspaceId, workspace },
    requestOptions,
  );
  const primary = {
    apiName: definition.identity.apiName,
    contentType: definition.contentType,
    title: definition.title,
    contentBody: structuredClone(item.contentBody),
    ...(definition.urlName === undefined ? {} : { urlName: definition.urlName }),
  } as WorkspaceImportItem;
  const payload = brand
    ? brandCreatePayload(primary, workspace.rootFolderId)
    : createPayload({ primary }, workspace.rootFolderId);
  // No family, language, or status filter: API names belong to parents, not variants.
  const inventory = await enumerateNativeWorkspace(
    connection,
    selected.workspaceId,
    requestOptions,
  );
  for (const row of inventory.records) {
    if (!row.ManagedContent.ApiName)
      throw new TypeError('CREATE absence unproven: unknown parent API name');
    if (
      row.ManagedContent.ApiName === payload.apiName ||
      row.Name === payload.title ||
      (payload.urlName !== undefined && row.UrlName === payload.urlName)
    )
      throw new TypeError('CREATE destination API/title/URL collision');
  }
  const freshWorkspace = await getWorkspace(connection, selected.workspaceId, requestOptions);
  if (!isDeepStrictEqual(freshWorkspace, workspace))
    throw new TypeError('CREATE destination workspace drifted during preflight');
  if (!isDeepStrictEqual(await load(), source))
    throw new TypeError('CREATE local source drifted during preflight');
  return {
    qualification: 'unqualified',
    definitionFile: item.definitionPath,
    workspaceId: selected.workspaceId,
    rootFolderId: workspace.rootFolderId,
    language: selected.language,
    apiVersion: inventory.apiVersion,
    payload,
  };
}
