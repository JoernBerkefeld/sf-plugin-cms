import type { Connection } from '@salesforce/core';
import {
  getSelectedOperation,
  requestJson,
  type JsonRequestOptions,
  type OperationParameterValues,
} from '../transport/json-request.js';

type CmsJsonValue = boolean | CmsJsonValue[] | CmsRecord | null | number | string;

export type CmsRecord = { readonly [key: string]: CmsJsonValue };

export type CmsPage = {
  items: CmsRecord[];
  page?: number;
  pageSize?: number;
  total?: number;
};

type RequestConnection = Pick<Connection, 'request'>;

function isRecord(value: unknown): value is CmsRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalInteger(record: CmsRecord, key: string): number | undefined {
  const value = record[key];
  return typeof value === 'number' && Number.isInteger(value) ? value : undefined;
}

function readItems(data: unknown): CmsRecord[] {
  if (Array.isArray(data)) return data.filter(isRecord);
  if (!isRecord(data)) return [];
  for (const key of ['items', 'spaces', 'contentSpaces', 'channels']) {
    const value = data[key];
    if (Array.isArray(value)) return value.filter(isRecord);
  }

  const spaceChannels = data.spaceChannels;
  if (Array.isArray(spaceChannels)) {
    return spaceChannels
      .filter(isRecord)
      .map((item) => item.channelSummary)
      .filter(isRecord);
  }

  return [];
}

function toPage(data: unknown): CmsPage {
  const record = isRecord(data) ? data : {};
  const result: CmsPage = { items: readItems(data) };
  const page = optionalInteger(record, 'currentPage') ?? optionalInteger(record, 'page');
  const pageSize = optionalInteger(record, 'pageSize');
  const total =
    optionalInteger(record, 'total') ??
    optionalInteger(record, 'totalCount') ??
    optionalInteger(record, 'totalItems') ??
    optionalInteger(record, 'totalSpaceChannels');
  if (page !== undefined) result.page = page;
  if (pageSize !== undefined) result.pageSize = pageSize;
  if (total !== undefined) result.total = total;
  return result;
}

async function list(
  connection: RequestConnection,
  operationKey: 'workspace.channel.list' | 'workspace.list',
  path: OperationParameterValues,
  query: OperationParameterValues,
  options: JsonRequestOptions,
): Promise<CmsPage> {
  const response = await requestJson<unknown>(
    connection,
    getSelectedOperation(operationKey),
    { path, query },
    options,
  );
  return toPage(response.data);
}

async function get(
  connection: RequestConnection,
  operationKey: 'channel.get' | 'content.get' | 'variant.get' | 'workspace.get',
  path: OperationParameterValues,
  query: OperationParameterValues = {},
  options: JsonRequestOptions = {},
): Promise<CmsRecord> {
  const response = await requestJson<unknown>(
    connection,
    getSelectedOperation(operationKey),
    { path, query },
    options,
  );
  if (!isRecord(response.data)) throw new TypeError(`Unexpected ${operationKey} response shape`);
  return response.data;
}

export function listWorkspaces(
  connection: RequestConnection,
  query: OperationParameterValues = {},
  options: JsonRequestOptions = {},
): Promise<CmsPage> {
  return list(connection, 'workspace.list', {}, query, options);
}

export function getWorkspace(
  connection: RequestConnection,
  contentSpaceId: string,
  options: JsonRequestOptions = {},
): Promise<CmsRecord> {
  return get(connection, 'workspace.get', { contentSpaceId }, {}, options);
}

export function listWorkspaceChannels(
  connection: RequestConnection,
  contentSpaceId: string,
  query: OperationParameterValues = {},
  options: JsonRequestOptions = {},
): Promise<CmsPage> {
  return list(connection, 'workspace.channel.list', { contentSpaceId }, query, options);
}

export function getChannel(
  connection: RequestConnection,
  channelId: string,
  options: JsonRequestOptions = {},
): Promise<CmsRecord> {
  return get(connection, 'channel.get', { channelId }, {}, options);
}

export function getContent(
  connection: RequestConnection,
  contentKeyOrId: string,
  query: OperationParameterValues = {},
  options: JsonRequestOptions = {},
): Promise<CmsRecord> {
  return get(connection, 'content.get', { contentKeyOrId }, query, options);
}

export function getVariant(
  connection: RequestConnection,
  variantId: string,
  options: JsonRequestOptions = {},
): Promise<CmsRecord> {
  return get(connection, 'variant.get', { variantId }, {}, options);
}
