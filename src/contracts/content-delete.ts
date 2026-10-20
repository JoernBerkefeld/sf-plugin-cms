import { assertExactKeys, assertNonemptyString, type CmsStatus } from './shared.js';
import { assertNativeDeleteResult, type NativeDeleteResult } from './native-content-delete.js';
import type { NativeDeleteTarget } from '../services/delete-native-resolution.js';

export const CONTENT_DELETE_CONTRACT = 'sf-cms-content-delete' as const;

export type ContentDeleteResult = {
  mode: 'preview' | 'execute';
  outcome: 'ready' | 'cancelled' | 'blocked' | 'completed' | 'rejected' | 'partial' | 'uncertain';
  workspaceId: string;
  targets: NativeDeleteTarget[];
  execution: NativeDeleteResult | null;
};

/**
 * Validate the sole public exact-item delete command result.
 * @param {unknown} value - Command result to validate.
 * @param {unknown} [_provenance] - Envelope provenance, validated by the shared boundary.
 * @param {CmsStatus} [status] - Expected envelope status.
 */
export function assertContentDeleteResult(
  value: unknown,
  _provenance?: unknown,
  status?: CmsStatus,
): asserts value is ContentDeleteResult {
  assertExactKeys(value, ['mode', 'outcome', 'workspaceId', 'targets', 'execution'], 'result');
  assertNonemptyString(value.workspaceId, 'result.workspaceId');
  if (value.mode !== 'preview' && value.mode !== 'execute')
    throw new TypeError('Invalid delete mode');
  if (!Array.isArray(value.targets)) throw new TypeError('Invalid delete targets');
  if (value.targets.length > 0)
    assertNativeDeleteResult({
      reportFile: null,
      report: {
        runId: 'validation',
        workspaceId: value.workspaceId,
        apiVersion: 'validation',
        state: 'applying',
        operations: value.targets.map((target: unknown) => ({ target, state: 'unattempted' })),
      },
    });
  let expected: CmsStatus;
  if (value.execution === null) {
    if (!['ready', 'cancelled', 'blocked'].includes(String(value.outcome)))
      throw new TypeError('Delete outcome requires execution evidence');
    if (value.outcome === 'ready' && (value.mode !== 'preview' || value.targets.length === 0))
      throw new TypeError('Ready delete requires selected preview targets');
    if (value.mode === 'preview' && value.execution !== null)
      throw new TypeError('Preview cannot execute');
    expected = value.outcome === 'blocked' ? 'blocked' : 'success';
  } else {
    assertNativeDeleteResult(value.execution);
    if (
      value.mode !== 'execute' ||
      value.execution.report.state === 'applying' ||
      value.outcome !== value.execution.report.state ||
      value.execution.report.workspaceId !== value.workspaceId ||
      JSON.stringify(value.targets) !==
        JSON.stringify(value.execution.report.operations.map(({ target }) => target))
    )
      throw new TypeError('Delete execution does not match command selection');
    expected = 'failed';
    if (value.outcome === 'completed') expected = 'success';
    if (value.outcome === 'blocked') expected = 'blocked';
    if (value.outcome === 'partial') expected = 'partial';
  }
  if (status !== undefined && status !== expected)
    throw new TypeError('Delete envelope status disagrees with outcome');
}
