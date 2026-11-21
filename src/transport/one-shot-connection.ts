import { Connection as JsforceConnection } from '@jsforce/jsforce-node';
import type { Connection } from '@salesforce/core';
import { CmsRequestError } from './json-request.js';

export type WriteConnection = Pick<Connection, 'request'> &
  Partial<Pick<Connection, 'accessToken' | 'instanceUrl' | 'version'>>;

/**
 * A token-only copy of the org connection for writes: no refresh, so a 401 or a dropped socket
 * never replays the write.
 * @param {WriteConnection} connection - Org connection.
 * @param {string} operationKey - Operation to name in the error.
 * @param {boolean} allowCallerConnection - Use the connection itself when it has no token
 *   (test doubles).
 * @returns {Pick<Connection, 'request'>} Receiver for exactly one write.
 */
export function oneShotConnection(
  connection: WriteConnection,
  operationKey: string,
  allowCallerConnection = false,
): Pick<Connection, 'request'> {
  if (
    typeof connection.accessToken !== 'string' ||
    connection.accessToken.length === 0 ||
    typeof connection.instanceUrl !== 'string' ||
    connection.instanceUrl.length === 0
  ) {
    if (allowCallerConnection) return connection;
    throw new CmsRequestError(
      operationKey,
      'Write transport requires an access token and instance URL',
    );
  }
  return new JsforceConnection({
    accessToken: connection.accessToken,
    instanceUrl: connection.instanceUrl,
    version: connection.version,
  });
}
