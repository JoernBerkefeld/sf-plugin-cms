import type { Connection } from '@salesforce/core';
import { randomUUID } from 'node:crypto';
import { logApiEvent } from './logging.js';

export const DEFAULT_API_VERSION = 'latest';
export const FALLBACK_API_VERSION = '67.0';

export type CmsApiSelection = {
  requestedVersion: string;
  effectiveApiVersion: string;
  restDataPath: string;
};

type VersionedConnection = { version?: string; getApiVersion?: () => string };
type PolicyConnection = VersionedConnection &
  Pick<Connection, 'request'> &
  Partial<Pick<Connection, 'setApiVersion'>>;

function setVersion(connection: PolicyConnection, version: string): void {
  if (connection.setApiVersion) connection.setApiVersion(version);
  else connection.version = version;
}
type Binding = { selection: CmsApiSelection };
const bindings = new WeakMap<object, Binding>();

export function isNumericApiVersion(value: unknown): value is string {
  return typeof value === 'string' && /^[1-9]\d*\.0$/.test(value);
}

export function apiDataPath(version: string): string {
  if (version === DEFAULT_API_VERSION) return '/services/data/latest';
  if (!isNumericApiVersion(version)) throw new Error(`Invalid CMS API version: ${version}`);
  return `/services/data/v${version}`;
}

export function getCmsApiSelection(connection: VersionedConnection): CmsApiSelection {
  let receiver: object | null = connection;
  while (receiver !== null) {
    const selection = bindings.get(receiver)?.selection;
    if (selection) return { ...selection };
    receiver = Object.getPrototypeOf(receiver) as object | null;
  }
  const version = connection.getApiVersion?.() ?? connection.version;
  if (!version) throw new Error('CMS connection has no API version.');
  return {
    requestedVersion: version,
    effectiveApiVersion: version,
    restDataPath: apiDataPath(version),
  };
}

function bindSelection(connection: PolicyConnection, selection: CmsApiSelection): void {
  const existing = bindings.get(connection);
  if (existing) {
    existing.selection = { ...selection };
    return;
  }
  const binding = { selection: { ...selection } };
  const request = connection.request;
  // Preserve shadow receivers and JSforce's exact StreamPromise (no async wrapper).
  connection.request = function <R = unknown>(
    this: PolicyConnection,
    input: Parameters<Connection['request']>[0],
    options?: Parameters<Connection['request']>[1],
  ) {
    const url = typeof input === 'string' ? input : input.url;
    const current = this.getApiVersion?.() ?? this.version;
    const numericPrefix =
      current && isNumericApiVersion(current) ? apiDataPath(current) : undefined;
    let selectedUrl = url;
    if (numericPrefix && (url === numericPrefix || url.startsWith(`${numericPrefix}/`))) {
      selectedUrl = binding.selection.restDataPath + url.slice(numericPrefix.length);
    } else if (url.startsWith('/') && !url.startsWith('//') && !url.startsWith('/services/')) {
      selectedUrl = binding.selection.restDataPath + url;
    }
    return request.call(
      this,
      typeof input === 'string' ? selectedUrl : { ...input, url: selectedUrl },
      options,
    ) as ReturnType<typeof request<R>>;
  };
  bindings.set(connection, binding);
}

function unsupportedRoute(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const details = error as {
    errorCode?: string;
    name?: string;
    message?: string;
    statusCode?: number;
    status?: number;
  };
  if ([401, 403].includes(details.statusCode ?? details.status ?? 0)) return false;
  const code = details.errorCode ?? details.name;
  if (['INVALID_VERSION', 'INVALID_API_VERSION', 'UNSUPPORTED_API_VERSION'].includes(code ?? '')) {
    return true;
  }
  // NOT_FOUND alone also describes missing records; only Salesforce's route diagnostic qualifies.
  return (
    code === 'NOT_FOUND' && /could not find a match for (?:url|uri)\b/i.test(details.message ?? '')
  );
}

async function preflight(connection: PolicyConnection, version: string): Promise<void> {
  const prefix = apiDataPath(version);
  for (const url of [
    `${prefix}/connect/cms/spaces?pageSize=1`,
    `${prefix}/query?q=${encodeURIComponent('SELECT Id FROM ManagedContentVariant LIMIT 1')}`,
  ]) {
    const event = {
      requestId: randomUUID(),
      startedAt: Date.now(),
      method: 'GET',
      url,
      operationKey: 'api.preflight',
    };
    logApiEvent('request', event);
    try {
      const data = await connection.request({ method: 'GET', url });
      logApiEvent('response', event, data);
    } catch (error) {
      logApiEvent('error', event, error);
      throw error;
    }
  }
}

export async function prepareCmsConnection<T extends PolicyConnection>(
  connection: T,
  requestedVersion: string = DEFAULT_API_VERSION,
): Promise<T> {
  if (requestedVersion !== DEFAULT_API_VERSION) {
    const restDataPath = apiDataPath(requestedVersion);
    setVersion(connection, requestedVersion);
    bindSelection(connection, {
      requestedVersion,
      effectiveApiVersion: requestedVersion,
      restDataPath,
    });
    return connection;
  }

  // Ask the server directly: Core's retrieveMaxApiVersion may return cached auth state.
  const event = {
    requestId: randomUUID(),
    startedAt: Date.now(),
    method: 'GET',
    url: '/services/data',
    operationKey: 'api.discovery',
  };
  logApiEvent('request', event);
  let advertised: unknown;
  try {
    advertised = await connection.request<unknown>({ method: 'GET', url: '/services/data' });
    logApiEvent('response', event, advertised);
  } catch (error) {
    logApiEvent('error', event, error);
    throw error;
  }
  const versions = Array.isArray(advertised)
    ? advertised
        .map((entry: unknown) =>
          typeof entry === 'object' && entry !== null && 'version' in entry
            ? entry.version
            : undefined,
        )
        .filter(isNumericApiVersion)
    : [];
  const highest = versions.toSorted((a, b) => Number(b) - Number(a))[0];
  if (!highest) throw new Error('Salesforce did not advertise a numeric API version.');
  setVersion(connection, highest);
  let restVersion = DEFAULT_API_VERSION;
  let effectiveApiVersion = highest;
  try {
    await preflight(connection, DEFAULT_API_VERSION);
  } catch (error) {
    if (!unsupportedRoute(error)) throw error;
    // Both fallback capabilities must succeed before any caller can perform a mutation.
    await preflight(connection, FALLBACK_API_VERSION);
    setVersion(connection, FALLBACK_API_VERSION);
    restVersion = FALLBACK_API_VERSION;
    effectiveApiVersion = FALLBACK_API_VERSION;
  }
  bindSelection(connection, {
    requestedVersion,
    effectiveApiVersion,
    restDataPath: apiDataPath(restVersion),
  });
  return connection;
}

export function inheritCmsApiSelection(
  source: VersionedConnection,
  target: PolicyConnection,
): void {
  const selection = getCmsApiSelection(source);
  setVersion(target, selection.effectiveApiVersion);
  bindSelection(target, selection);
}
