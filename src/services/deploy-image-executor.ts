import type { JsonRequestOptions } from '../transport/json-request.js';
import {
  executeDeployImageCreate,
  type ExecuteDeployImageCreateInput,
} from './deploy-image-create-executor.js';
import { executeDeployImageUpdate } from './deploy-image-update-executor.js';
import { admitDeployImageUnchanged } from './deploy-image-unchanged.js';
import type { WorkspaceImportReportPersistence } from './import-workspace.js';

export type ExecuteDeployImageInput = ExecuteDeployImageCreateInput & {
  operation: 'create' | 'update' | 'unchanged';
};

/**
 * Route explicit narrow Image intent through independently evidenced operation engines.
 * Each selected service independently reacquires its evidence; rejection never selects another mode.
 * @param {object} connection - Explicit authenticated destination connection.
 * @param {ExecuteDeployImageInput} input - Explicit operation, local source, scope and new journal.
 * @param {JsonRequestOptions} options - Request timeout and cancellation controls.
 * @param {WorkspaceImportReportPersistence} persistence - Existing mutation journal persistence seam.
 * @param {Function} beforeMutation - Internal batch boundary forwarded to mutation engines only.
 * @returns {Promise<object>} Existing unqualified journal result or read-only unchanged evidence.
 */
export async function executeDeployImage(
  connection: Parameters<typeof executeDeployImageCreate>[0],
  input: ExecuteDeployImageInput,
  options: JsonRequestOptions = {},
  persistence?: WorkspaceImportReportPersistence,
  beforeMutation?: () => Promise<void>,
): Promise<
  | Awaited<ReturnType<typeof executeDeployImageCreate>>
  | Awaited<ReturnType<typeof admitDeployImageUnchanged>>
> {
  switch (input.operation) {
    case 'create': {
      return executeDeployImageCreate(connection, input, options, persistence, beforeMutation);
    }
    case 'update': {
      return executeDeployImageUpdate(connection, input, options, persistence, beforeMutation);
    }
    case 'unchanged': {
      return admitDeployImageUnchanged(connection, input, options);
    }
    default: {
      throw new TypeError('Unsupported Image deploy operation');
    }
  }
}
