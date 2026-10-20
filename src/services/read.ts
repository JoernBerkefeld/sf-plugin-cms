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

export type CmsCollection = {
  items: CmsRecord[];
  total: number;
};

type RequestConnection = Pick<Connection, 'request'>;

const LIST_PAGE_CAP = 1000;

function aggregateItems(data: unknown, operationKey: string): CmsRecord[] {
  let values: unknown = data;
  if (isRecord(data)) {
    const key = ['items', 'spaces', 'contentSpaces', 'channels', 'spaceChannels'].find(
      (candidate) => Object.hasOwn(data, candidate),
    );
    values = key === undefined ? undefined : data[key];
    if (key === 'spaceChannels' && Array.isArray(values)) {
      values = values.map((item: unknown) => (isRecord(item) ? item.channelSummary : undefined));
    }
  }
  if (!Array.isArray(values) || !values.every(isRecord))
    throw new TypeError(`Unexpected ${operationKey} aggregate response shape`);
  return values as CmsRecord[];
}

async function collect(
  connection: RequestConnection,
  operationKey: 'workspace.channel.list' | 'workspace.list',
  path: OperationParameterValues,
  query: OperationParameterValues,
  options: JsonRequestOptions,
): Promise<CmsCollection> {
  const items = new Map<string, CmsRecord>();
  const foldedIds = new Map<string, string>();
  for (let page = 0; page < LIST_PAGE_CAP; page += 1) {
    const response = await requestJson<unknown>(
      connection,
      getSelectedOperation(operationKey),
      { path, query: { ...query, page } },
      options,
    );
    const records = aggregateItems(response.data, operationKey);
    const hasNext = isRecord(response.data) && Object.hasOwn(response.data, 'nextPageUrl');
    const next = isRecord(response.data) ? response.data.nextPageUrl : undefined;
    if (hasNext && next !== null && (typeof next !== 'string' || next.trim().length === 0))
      throw new TypeError(`Unexpected ${operationKey} nextPageUrl at page ${page}`);
    if (records.length === 0) {
      if (hasNext && next !== null)
        throw new Error(`${operationKey} returned an empty page with nextPageUrl at page ${page}`);
      return { items: [...items.values()], total: items.size };
    }
    let additions = 0;
    for (const record of records) {
      const id = record.id;
      if (typeof id !== 'string' || id.length === 0)
        throw new TypeError(`${operationKey} page ${page} contains a missing or malformed ID`);
      const folded = id.normalize('NFKC').toLocaleLowerCase('en-US');
      const existingId = foldedIds.get(folded);
      if (existingId !== undefined && existingId !== id)
        throw new Error(
          `${operationKey} IDs ${existingId} and ${id} differ only by case or Unicode normalization and are ambiguous`,
        );
      foldedIds.set(folded, id);
      if (!items.has(id)) {
        items.set(id, record);
        additions += 1;
      }
    }
    if (additions === 0) throw new Error(`${operationKey} made no progress at page ${page}`);
    if (hasNext && next === null) return { items: [...items.values()], total: items.size };
  }
  throw new Error(`${operationKey} exceeded the ${LIST_PAGE_CAP}-page safety limit`);
}

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

export function listAllWorkspaces(
  connection: RequestConnection,
  query: OperationParameterValues = {},
  options: JsonRequestOptions = {},
): Promise<CmsCollection> {
  return collect(connection, 'workspace.list', {}, query, options);
}

export function listAllWorkspaceChannels(
  connection: RequestConnection,
  contentSpaceId: string,
  query: OperationParameterValues = {},
  options: JsonRequestOptions = {},
): Promise<CmsCollection> {
  return collect(connection, 'workspace.channel.list', { contentSpaceId }, query, options);
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
