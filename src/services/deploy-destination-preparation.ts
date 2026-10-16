import type { Connection } from '@salesforce/core';
import { isDeepStrictEqual } from 'node:util';
import { sourcePathSegment } from '../contracts/source-definition.js';
import type { JsonValue } from '../contracts/capability-registry.js';
import { getCmsApiSelection } from '../api-policy.js';
import { redactSecrets } from '../transport/redact-secrets.js';
import type { JsonRequestOptions } from '../transport/json-request.js';
import type { DeployLocalItem, DeployLocalSelection } from './deploy-source-selection.js';
import { reassembleEditableItemSource } from './editable-item-source.js';
import { reassembleEditableItemSourceV2 } from './editable-item-source-v2.js';
import {
  acquireEditableEmailSource,
  acquireEditableTemplateSource,
} from './retrieve-item-source.js';
import { enumerateNativeWorkspace, type NativeInventory } from './retrieve-native-inventory.js';
import { getVariant, getWorkspace } from './read.js';
import { decodeNativeHtml } from './import-identities.js';
import { requiredContentIdentifier, requiredVariantIdentifier } from './variant-identity.js';
import { assertCanonicalMarketingWorkspace } from './resolve-workspace.js';

type DestinationConnection = Pick<Connection, 'request' | 'getApiVersion'>;
export type DeployDestinationInput = {
  selection: DeployLocalSelection;
  workspaceId: string;
  language: string;
};
export type DeployPreparedItem = {
  source: DeployLocalItem;
  proposed: 'create' | 'update' | 'unchanged' | 'blocked';
  /** No prepared observation is authorization or a reusable mutation capability. */
  qualification: 'unqualified';
  changedFields: string[];
  blockedReasons: string[];
  desired: { contentBody: Record<string, JsonValue>; title?: string; urlName?: string };
  existing?: {
    variantId: string;
    contentId: string;
    contentBody: Record<string, JsonValue>;
    title?: string;
    urlName?: string;
  };
};
export type DeployDestinationPreparation = {
  workspaceId: string;
  language: string;
  apiVersion: string;
  items: DeployPreparedItem[];
  blockedReasons: string[];
  inventory?: {
    complete: true;
    scope: 'principal-visible-nondeleted-workspace-all-types-languages-statuses';
    recordCount: number;
    pagesRequested: number;
  };
};

function localBody(item: DeployLocalItem): Record<string, JsonValue> {
  const definition = item.definition;
  const body = item.contentBody;
  const reconstructed =
    definition.contractVersion === '2.0.0'
      ? reassembleEditableItemSourceV2(
          definition,
          new Map(
            definition.companions.map((part) => {
              const value = body[part.role];
              if (typeof value !== 'string') throw new TypeError('Missing reconstructed companion');
              return [part.path, Buffer.from(value, 'utf8')];
            }),
          ),
        )
      : reassembleEditableItemSource(definition, body.rawHtml as string);
  if (
    !isDeepStrictEqual(reconstructed, body) ||
    !isDeepStrictEqual(item.targetIdentity, {
      contentType: definition.contentType,
      apiName: definition.identity.apiName,
      language: definition.language,
    })
  )
    throw new TypeError('Local selection identity/body disagreement');
  return reconstructed;
}

function changes(
  left: DeployPreparedItem['desired'],
  right: DeployPreparedItem['desired'],
): string[] {
  const fields = ['title', 'urlName'].filter(
    (key) =>
      !isDeepStrictEqual(left[key as 'title' | 'urlName'], right[key as 'title' | 'urlName']),
  );
  for (const key of new Set([
    ...Object.keys(left.contentBody),
    ...Object.keys(right.contentBody),
  ])) {
    if (!isDeepStrictEqual(left.contentBody[key], right.contentBody[key]))
      fields.push(`contentBody.${key}`);
  }
  return fields.toSorted();
}

async function prepareItem(
  connection: DestinationConnection,
  item: DeployLocalItem,
  input: DeployDestinationInput,
  inventory: NativeInventory,
  options: JsonRequestOptions,
): Promise<DeployPreparedItem> {
  const prepared: DeployPreparedItem = {
    source: item,
    proposed: 'blocked',
    qualification: 'unqualified',
    changedFields: [],
    blockedReasons: [],
    desired: {
      contentBody: structuredClone(item.contentBody),
      ...(item.definition.title === undefined ? {} : { title: item.definition.title }),
      ...(item.definition.urlName === undefined ? {} : { urlName: item.definition.urlName }),
    },
  };
  try {
    localBody(item);
    const identity = item.targetIdentity;
    if (!['sfdc_cms__email', 'sfdc_cms__emailTemplate'].includes(identity.contentType))
      throw new TypeError('Unsupported deploy content type');
    if (identity.language !== input.language || item.definition.folderPath.length > 0)
      throw new TypeError('Deploy requires exact destination language and root placement');
    // API names are parent-level: do not narrow conflict detection by family or language.
    const conflicts = inventory.records.filter(
      (row) => row.ManagedContent.ApiName === identity.apiName,
    );
    if (conflicts.length === 0) {
      // Null API names cannot establish absence; never infer a safe new parent from them.
      if (inventory.records.some((row) => !row.ManagedContent.ApiName))
        throw new TypeError(
          'Workspace inventory has unknown parent API names; absence is unproven',
        );
      prepared.proposed = 'create';
      return prepared;
    }
    if (
      conflicts.length !== 1 ||
      conflicts[0].ContentTypeFullyQualifiedName !== identity.contentType ||
      conflicts[0].Language !== identity.language
    )
      throw new TypeError(
        'Destination parent conflict, ambiguous identity or unsupported siblings',
      );
    const row = conflicts[0];
    if (row.IsPublished || row.ManagedContentVariantStatus !== 'Draft')
      throw new TypeError('Existing destination requires an unpublished Draft');
    // Reuse fresh native/detail/parent/sibling binding and strict supported-envelope projection.
    const acquire =
      identity.contentType === 'sfdc_cms__email'
        ? acquireEditableEmailSource
        : acquireEditableTemplateSource;
    const existing = await acquire(
      connection,
      {
        workspaceId: input.workspaceId,
        apiName: identity.apiName,
        language: input.language,
      },
      options,
    );
    if (
      existing.evidence.contentId !== row.ManagedContentId ||
      existing.evidence.variantId !== row.Id
    )
      throw new TypeError('Destination identity changed since workspace inventory');
    const projection = existing.projection;
    const baseline = {
      contentBody: reassembleEditableItemSourceV2(
        projection.definition,
        new Map(projection.companions.map((part) => [part.path, part.bytes])),
      ),
      ...(projection.definition.title === undefined ? {} : { title: projection.definition.title }),
      ...(projection.definition.urlName === undefined
        ? {}
        : { urlName: projection.definition.urlName }),
    };
    // Projection admission alone is not lifecycle admission: verify a fresh final detail too.
    const fresh = await getVariant(connection, row.Id, options);
    const status = fresh.status as Record<string, unknown> | null;
    const body = fresh.contentBody as Record<string, unknown> | null;
    const space = fresh.contentSpace as Record<string, unknown> | null;
    const type = fresh.contentType as Record<string, unknown> | string | null;
    if (
      requiredVariantIdentifier(fresh) !== row.Id ||
      requiredContentIdentifier(fresh) !== row.ManagedContentId ||
      fresh.apiName !== identity.apiName ||
      fresh.language !== input.language ||
      space?.id !== input.workspaceId ||
      fresh.contentKey !== row.ManagedContentKey ||
      (typeof type === 'object' ? type?.fullyQualifiedName : type) !== identity.contentType ||
      fresh.isPublished !== false ||
      status?.status !== 'Draft' ||
      typeof body?.rawHtml !== 'string' ||
      !isDeepStrictEqual(
        {
          ...body,
          rawHtml: decodeNativeHtml(body.rawHtml),
        },
        baseline.contentBody,
      ) ||
      fresh.title !== baseline.title ||
      fresh.urlName !== baseline.urlName
    )
      throw new TypeError('Destination detail or lifecycle changed during preparation');
    prepared.existing = { ...existing.evidence, ...baseline };
    prepared.changedFields = changes(prepared.desired, baseline);
    if (prepared.changedFields.length === 0) prepared.proposed = 'unchanged';
    else if (isDeepStrictEqual(prepared.changedFields, ['contentBody.rawHtml']))
      prepared.proposed = 'update';
    else throw new TypeError('Unsupported update fields: ' + prepared.changedFields.join(', '));
  } catch (error) {
    prepared.blockedReasons.push(
      redactSecrets(error instanceof Error ? error.message : 'Destination preparation failed'),
    );
  }
  return prepared;
}

/**
 * Prepare destination observations only; never writes files or invokes mutation transports.
 * All CREATE/UPDATE proposals remain unqualified pending operation-specific acceptance.
 * @param {DestinationConnection} connection - Explicit destination org with selected CMS API policy.
 * @param {DeployDestinationInput} input - Admitted local selection and exact destination workspace/language.
 * @param {JsonRequestOptions} options - Read timeout/cancellation options, never supplied inventory.
 * @returns {Promise<DeployDestinationPreparation>} Detached proposals and explicit blockers, not apply authority.
 */
export async function prepareDeployDestination(
  connection: DestinationConnection,
  input: DeployDestinationInput,
  options: JsonRequestOptions = {},
): Promise<DeployDestinationPreparation> {
  const selected = structuredClone(input);
  const requestOptions = { ...options };
  const result: DeployDestinationPreparation = {
    workspaceId: selected.workspaceId,
    language: selected.language,
    apiVersion: '',
    items: [],
    blockedReasons: [],
  };
  try {
    sourcePathSegment(selected.language);
    if (!/^0Zu[A-Za-z0-9]{12}[A-Z0-5]{3}$/u.test(selected.workspaceId))
      throw new TypeError('Exact destination workspace ID is required');
    if (selected.selection.items.length === 0)
      throw new TypeError('Deploy source selection is empty');
    const identities = new Set<string>();
    for (const item of selected.selection.items) {
      localBody(item);
      const key = item.targetIdentity.apiName;
      if (identities.has(key))
        throw new TypeError('Selected sources collide at destination parent API name');
      identities.add(key);
    }
    result.apiVersion = getCmsApiSelection(connection).effectiveApiVersion;
    const workspace = await getWorkspace(connection, selected.workspaceId, requestOptions);
    if (workspace.id !== selected.workspaceId)
      throw new TypeError('Destination workspace identity mismatch');
    sourcePathSegment(workspace.apiName);
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
    result.inventory = {
      complete: true,
      scope: 'principal-visible-nondeleted-workspace-all-types-languages-statuses',
      recordCount: inventory.records.length,
      pagesRequested: inventory.pagesRequested,
    };
    for (const item of selected.selection.items)
      result.items.push(await prepareItem(connection, item, selected, inventory, requestOptions));
  } catch (error) {
    result.blockedReasons.push(
      redactSecrets(error instanceof Error ? error.message : 'Destination preparation failed'),
    );
  }
  return result;
}
