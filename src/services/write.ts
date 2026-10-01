import type { Connection } from '@salesforce/core';
import {
  requestEmptyMutation,
  requestJsonMutation,
  type EmptyMutationSuccess,
  type JsonMutationBody,
} from '../transport/json-mutation.js';
import { getSelectedOperation, type JsonRequestOptions } from '../transport/json-request.js';
import type { CmsRecord } from './read.js';

type RequestConnection = Pick<Connection, 'request'>;

type StandardCreateContentInput = JsonMutationBody & {
  apiName?: string;
  contentBody: Readonly<Record<string, unknown>>;
  contentKey?: string;
  contentSpaceOrFolderId: string;
  contentType: string;
  externalId?: string;
  externalSource?: Readonly<Record<string, unknown>>;
  title: string;
  urlName?: string;
};

export type PreferencePageCreateContentInput = JsonMutationBody & {
  apiName: string;
  contentBody: Readonly<Record<string, unknown>>;
  contentSpaceOrFolderId: string;
  contentType: 'sfdc_cms__preferencePage';
  contentKey?: never;
  title?: never;
  urlName?: never;
};

export type CreateContentInput = StandardCreateContentInput | PreferencePageCreateContentInput;

export type CreateVariantInput = JsonMutationBody & {
  contentBody: Readonly<Record<string, unknown>>;
  language: string;
  managedContentKeyOrId: string;
  title?: string;
  urlName?: string;
};

function isRecord(value: unknown): value is CmsRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function create(
  connection: RequestConnection,
  operationKey: 'content.create' | 'variant.create',
  body: CreateContentInput | CreateVariantInput,
  options: JsonRequestOptions,
): Promise<CmsRecord> {
  const response = await requestJsonMutation<unknown>(
    connection,
    getSelectedOperation(operationKey),
    body,
    {},
    { ...options, allowCallerConnection: true },
  );
  if (!isRecord(response.data)) throw new TypeError(`Unexpected ${operationKey} response shape`);
  return response.data;
}

export function createContent(
  connection: RequestConnection,
  body: CreateContentInput,
  options: JsonRequestOptions = {},
): Promise<CmsRecord> {
  return create(connection, 'content.create', body, options);
}

export function createVariant(
  connection: RequestConnection,
  body: CreateVariantInput,
  options: JsonRequestOptions = {},
): Promise<CmsRecord> {
  return create(connection, 'variant.create', body, options);
}

export function deleteVariant(
  connection: RequestConnection,
  variantId: string,
  options: JsonRequestOptions = {},
): Promise<EmptyMutationSuccess> {
  return requestEmptyMutation(
    connection,
    getSelectedOperation('variant.delete'),
    { path: { variantId } },
    { ...options, allowCallerConnection: true },
  );
}
