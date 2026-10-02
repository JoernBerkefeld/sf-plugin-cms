import type { Connection } from '@salesforce/core';
import {
  requestEmptyMutation,
  requestJsonMutation,
  type EmptyMutationSuccess,
} from '../transport/json-mutation.js';
import {
  CmsRequestError,
  getSelectedOperation,
  type JsonRequestOptions,
} from '../transport/json-request.js';

type RequestConnection = Pick<Connection, 'request'> &
  Partial<Pick<Connection, 'accessToken' | 'instanceUrl' | 'version'>>;

export type UpdateVariantInput = {
  apiName?: string;
  contentBody?: Readonly<Record<string, unknown>>;
  title?: string;
  urlName?: string;
};

export type UpdatedVariant = {
  contentBody: Readonly<Record<string, unknown>>;
  isPublished: boolean;
  language: string;
  managedContentId: string;
  managedContentVariantId: string;
};

type LifecycleSelector =
  | { contentIds: readonly string[]; variantIds?: never }
  | { contentIds?: never; variantIds: readonly string[] };

type LifecycleRequest = LifecycleSelector & {
  contextContentSpaceId?: string;
  description?: string;
  includeContentReferences?: never;
};

export type PublishContentInput = LifecycleRequest;
export type UnpublishContentInput = LifecycleRequest;

export type PublishContentResponse = {
  deploymentId: string;
  description?: null | string;
  publishDate?: null | string;
};

export type UnpublishContentResponse = {
  deploymentId: string;
  description?: null | string;
  unpublishDate?: null | string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertNonEmptyString(
  value: unknown,
  field: string,
  operationKey: 'content.publish' | 'content.unpublish' | 'variant.delete' | 'variant.update',
): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new CmsRequestError(operationKey, `${field} must be a non-empty string`);
  }
}

function assertKnownFields(
  input: Record<string, unknown>,
  allowed: readonly string[],
  operationKey: 'content.publish' | 'content.unpublish' | 'variant.update',
): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(input).find((key) => !allowedSet.has(key));
  if (unknown !== undefined) {
    throw new CmsRequestError(operationKey, `Unknown request field: ${unknown}`);
  }
}

function assertOptionalString(
  value: unknown,
  field: string,
  operationKey: 'content.publish' | 'content.unpublish' | 'variant.update',
): void {
  if (value !== undefined && typeof value !== 'string') {
    throw new CmsRequestError(operationKey, `${field} must be a string`);
  }
}

function validateLifecycleInput(
  input: LifecycleRequest,
  operationKey: 'content.publish' | 'content.unpublish',
): void {
  if (!isRecord(input))
    throw new CmsRequestError(operationKey, 'Lifecycle request must be an object');
  assertKnownFields(
    input,
    ['contentIds', 'variantIds', 'contextContentSpaceId', 'description'],
    operationKey,
  );
  assertOptionalString(input.contextContentSpaceId, 'contextContentSpaceId', operationKey);
  assertOptionalString(input.description, 'description', operationKey);
  const selectors = [input.contentIds, input.variantIds].filter((value) => value !== undefined);
  if (selectors.length !== 1) {
    throw new CmsRequestError(operationKey, 'Exactly one of contentIds or variantIds is required');
  }
  const [ids] = selectors;
  if (
    !Array.isArray(ids) ||
    ids.length === 0 ||
    ids.some((id) => typeof id !== 'string' || id.length === 0)
  ) {
    throw new CmsRequestError(operationKey, 'Lifecycle selector IDs must be non-empty strings');
  }
}

function validateUpdateInput(input: UpdateVariantInput): void {
  const operationKey = 'variant.update';
  if (!isRecord(input)) throw new CmsRequestError(operationKey, 'Variant update must be an object');
  assertKnownFields(input, ['apiName', 'contentBody', 'title', 'urlName'], operationKey);
  if (Object.keys(input).length === 0) {
    throw new CmsRequestError(operationKey, 'Variant update requires at least one field');
  }
  assertOptionalString(input.apiName, 'apiName', operationKey);
  assertOptionalString(input.title, 'title', operationKey);
  assertOptionalString(input.urlName, 'urlName', operationKey);
  if (input.contentBody !== undefined && !isRecord(input.contentBody)) {
    throw new CmsRequestError(operationKey, 'contentBody must be an object');
  }
}

function assertOptionalNullableString(
  record: Record<string, unknown>,
  field: string,
  operationKey: 'content.publish' | 'content.unpublish',
): void {
  const value = record[field];
  if (value !== undefined && value !== null && typeof value !== 'string') {
    throw new CmsRequestError(operationKey, `Unexpected ${field} response shape`);
  }
}

function lifecycleTransportOptions(options: JsonRequestOptions): JsonRequestOptions {
  return {
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  };
}

function validateUpdatedVariant(data: unknown): UpdatedVariant {
  const operationKey = 'variant.update';
  if (!isRecord(data) || !isRecord(data.contentBody) || typeof data.isPublished !== 'boolean') {
    throw new CmsRequestError(operationKey, 'Unexpected variant.update response shape');
  }
  assertNonEmptyString(data.language, 'language', operationKey);
  assertNonEmptyString(data.managedContentId, 'managedContentId', operationKey);
  assertNonEmptyString(data.managedContentVariantId, 'managedContentVariantId', operationKey);
  return data as UpdatedVariant;
}

function validateLifecycleResponse(
  data: unknown,
  operationKey: 'content.publish' | 'content.unpublish',
): PublishContentResponse | UnpublishContentResponse {
  if (!isRecord(data)) {
    throw new CmsRequestError(operationKey, `Unexpected ${operationKey} response shape`);
  }
  assertNonEmptyString(data.deploymentId, 'deploymentId', operationKey);
  assertOptionalNullableString(data, 'description', operationKey);
  assertOptionalNullableString(
    data,
    operationKey === 'content.publish' ? 'publishDate' : 'unpublishDate',
    operationKey,
  );
  return data as PublishContentResponse | UnpublishContentResponse;
}

export async function updateVariant(
  connection: RequestConnection,
  variantId: string,
  body: UpdateVariantInput,
  options: JsonRequestOptions = {},
): Promise<UpdatedVariant> {
  assertNonEmptyString(variantId, 'variantId', 'variant.update');
  validateUpdateInput(body);
  const response = await requestJsonMutation<unknown>(
    connection,
    getSelectedOperation('variant.update'),
    body,
    { path: { variantId } },
    lifecycleTransportOptions(options),
  );
  return validateUpdatedVariant(response.data);
}

export function deleteVariantOneShot(
  connection: RequestConnection,
  variantId: string,
  options: JsonRequestOptions = {},
): Promise<EmptyMutationSuccess> {
  assertNonEmptyString(variantId, 'variantId', 'variant.delete');
  return requestEmptyMutation(
    connection,
    getSelectedOperation('variant.delete'),
    { path: { variantId } },
    lifecycleTransportOptions(options),
  );
}

export async function publishContent(
  connection: RequestConnection,
  input: PublishContentInput,
  options: JsonRequestOptions = {},
): Promise<PublishContentResponse> {
  validateLifecycleInput(input, 'content.publish');
  const response = await requestJsonMutation<unknown>(
    connection,
    getSelectedOperation('content.publish'),
    {
      ...(input.contentIds === undefined ? {} : { contentIds: input.contentIds }),
      ...(input.variantIds === undefined ? {} : { variantIds: input.variantIds }),
      ...(input.contextContentSpaceId === undefined
        ? {}
        : { contextContentSpaceId: input.contextContentSpaceId }),
      ...(input.description === undefined ? {} : { description: input.description }),
      includeContentReferences: false,
    },
    {},
    lifecycleTransportOptions(options),
  );
  return validateLifecycleResponse(response.data, 'content.publish') as PublishContentResponse;
}

export async function unpublishContent(
  connection: RequestConnection,
  input: UnpublishContentInput,
  options: JsonRequestOptions = {},
): Promise<UnpublishContentResponse> {
  validateLifecycleInput(input, 'content.unpublish');
  const response = await requestJsonMutation<unknown>(
    connection,
    getSelectedOperation('content.unpublish'),
    {
      ...(input.contentIds === undefined ? {} : { contentIds: input.contentIds }),
      ...(input.variantIds === undefined ? {} : { variantIds: input.variantIds }),
      ...(input.contextContentSpaceId === undefined
        ? {}
        : { contextContentSpaceId: input.contextContentSpaceId }),
      ...(input.description === undefined ? {} : { description: input.description }),
    },
    {},
    lifecycleTransportOptions(options),
  );
  return validateLifecycleResponse(response.data, 'content.unpublish') as UnpublishContentResponse;
}
