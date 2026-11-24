import type { CmsResult } from './command-base.js';
import type { Diagnostic } from './errors/registry.js';

/** Exit codes of Salesforce's CLI rules: success, failure, partial success, still in progress. */
export type ExitCode = 0 | 1 | 68 | 69;

/** Item outcomes that mean the component was changed or written. */
const WRITTEN = new Set(['created', 'updated', 'deleted', 'published', 'unpublished', 'retrieved']);

/**
 * Whether an error means Salesforce may still be working: no answer within the client timeout,
 * or a publish/unpublish whose readback did not confirm the new state.
 * @param {Diagnostic} error - Error diagnostic.
 * @returns {boolean} True for an outcome that is still open.
 */
function inProgress(error: Diagnostic): boolean {
  return (
    error.code === 'STATE_NOT_CONFIRMED' ||
    (error.code === 'UNKNOWN_OUTCOME' && error.transportError?.name === 'AbortError')
  );
}

/**
 * The exit code of a command result: 0 when nothing failed and nothing is open; 1 when something
 * failed and no other component was written; 68 when something failed and another component was
 * written; 69 when nothing failed but an outcome is still open. A failure wins over an open one.
 * @param {CmsResult<unknown>} envelope - Result of a command or library function.
 * @returns {ExitCode} Exit code.
 */
export function exitCodeOf(envelope: CmsResult<unknown>): ExitCode {
  const errors = envelope.diagnostics.errors;
  if (envelope.status === 'success' && errors.length === 0) return 0;
  const failures = errors.filter((error) => !inProgress(error));
  if (failures.length === 0) return errors.length > 0 ? 69 : 1;
  const failed = new Set(failures.map((error) => error.component));
  const result = envelope.result as { items?: unknown } | null | undefined;
  const items = Array.isArray(result?.items) ? (result.items as unknown[]) : [];
  const writtenElsewhere = items.some((item) => {
    const { type, apiName, outcome } = (item ?? {}) as Record<string, unknown>;
    return typeof outcome === 'string' && WRITTEN.has(outcome) && !failed.has(`${type}:${apiName}`);
  });
  return writtenElsewhere ? 68 : 1;
}
