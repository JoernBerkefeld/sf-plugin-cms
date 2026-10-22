import path from 'node:path';
import type { Connection } from '@salesforce/core';
import type { ContentLifecycleLocalOutcome } from '../contracts/content-publish.js';
import type { JsonRequestOptions } from '../transport/json-request.js';
import { rewriteAtomic } from './import-workspace.js';
import { resolveWorkspace } from './resolve-workspace.js';
import {
  assertLifecycleLocalSynchronizationEligible,
  inspectLifecycleLocalSource,
  synchronizeLifecycleLocalSource,
  type LifecycleLocalSourceInspection,
} from './lifecycle-local-source.js';

type Target = {
  workspaceId: string;
  apiName: string;
  language: string;
  contentId: string;
  variantId: string;
};
export type EmailLifecycleLocalCompletion = {
  localSource?: ContentLifecycleLocalOutcome;
  localReportFile?: string;
};

/**
 * Inspect the exact portable Email identity before allocating reports or dispatching mutations.
 * @param {Pick<Connection, 'request'>} connection - Selected read connection.
 * @param {string | undefined} projectRoot - Captured absolute portable source root.
 * @param {Target} target - Independently resolved exact Email identity.
 * @param {JsonRequestOptions} [requestOptions] - Bounded read options.
 * @returns {Promise<LifecycleLocalSourceInspection | undefined>} Qualified snapshots or disabled admission.
 */
export async function inspectEmailLifecycleLocalSource(
  connection: Pick<Connection, 'request'>,
  projectRoot: string | undefined,
  target: Target,
  requestOptions?: JsonRequestOptions,
): Promise<LifecycleLocalSourceInspection | undefined> {
  if (projectRoot === undefined) return undefined;
  let workspace: Awaited<ReturnType<typeof resolveWorkspace>>;
  try {
    workspace = await resolveWorkspace(
      connection,
      { workspaceId: target.workspaceId },
      requestOptions,
    );
  } catch (error) {
    throw new TypeError('Local source workspace identity could not be resolved', { cause: error });
  }
  const workspaceApiName = workspace.workspace.apiName;
  if (typeof workspaceApiName !== 'string' || !workspaceApiName.trim())
    throw new TypeError('Workspace API name unavailable; local source identity cannot be proven');
  const inspection = await inspectLifecycleLocalSource(projectRoot, {
    workspaceApiName,
    contentType: 'sfdc_cms__email',
    apiName: target.apiName,
    language: target.language,
  });
  assertLifecycleLocalSynchronizationEligible(inspection);
  return inspection;
}

/**
 * Revalidate local snapshots only after the executor has durably confirmed remote completion.
 * @param {'publish' | 'unpublish'} operation - Independently completed operation.
 * @param {string | undefined} projectRoot - Original absolute portable source root.
 * @param {LifecycleLocalSourceInspection | undefined} inspection - Pre-dispatch snapshots.
 * @param {Target} target - Exact completed executor target.
 * @param {string} reportFile - Completed executor-owned report, never modified here.
 * @param {typeof rewriteAtomic} [rewrite] - Local sidecar persistence writer.
 * @returns {Promise<EmailLifecycleLocalCompletion>} Local truth with a path only after successful persistence.
 */
export async function completeEmailLifecycleLocalSource(
  operation: 'publish' | 'unpublish',
  projectRoot: string | undefined,
  inspection: LifecycleLocalSourceInspection | undefined,
  target: Target,
  reportFile: string,
  rewrite: typeof rewriteAtomic = rewriteAtomic,
): Promise<EmailLifecycleLocalCompletion> {
  if (projectRoot === undefined || inspection === undefined) return {};
  const result = await synchronizeLifecycleLocalSource(projectRoot, inspection, {
    outcome: operation === 'publish' ? 'published' : 'unpublished',
    identity: inspection.identity,
  });
  let localSource: ContentLifecycleLocalOutcome =
    result.outcome === 'blocked'
      ? { outcome: 'blocked', message: result.message ?? 'Local synchronization blocked' }
      : {
          outcome: 'noop',
          reason: result.reason === 'missing-copy' ? 'missing-copy' : 'retrieval-equivalent',
        };
  const localReportFile = path.join(path.dirname(reportFile), `content-${operation}-local.json`);
  const persist = async () =>
    rewrite(localReportFile, {
      contract: 'sf-cms-email-lifecycle-local-outcome',
      contractVersion: '1.0.0',
      operation,
      target,
      reportFile,
      remoteOutcome: 'completed',
      localSource,
    });
  try {
    await persist();
    return { localSource, localReportFile };
  } catch (error) {
    localSource = {
      outcome: 'blocked',
      message: `Remote completed; local outcome persistence failed: ${error instanceof Error ? error.message : 'unknown persistence failure'}`,
    };
    try {
      await persist();
      return { localSource, localReportFile };
    } catch {
      // The executor's completed report remains authoritative; no local durability is claimed.
      return { localSource };
    }
  }
}
