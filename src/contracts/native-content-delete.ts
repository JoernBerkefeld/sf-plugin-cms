import { assertExactKeys, assertNonemptyString } from './shared.js';
import type { NativeDeleteTarget } from '../services/delete-native-resolution.js';
import { RETRIEVE_CONTENT_TYPES } from '../services/retrieve-selection.js';

export type NativeDeleteOperation = {
  target: NativeDeleteTarget;
  state: 'unattempted' | 'pending' | 'completed' | 'blocked' | 'rejected' | 'uncertain';
  exactVariantAbsent?: true;
  parentBehavior?: 'present' | 'not-found';
  error?: string;
};
export type NativeDeleteReport = {
  runId: string;
  workspaceId: string;
  apiVersion: string;
  state: 'applying' | 'completed' | 'blocked' | 'rejected' | 'partial' | 'uncertain';
  operations: NativeDeleteOperation[];
};
export type NativeDeleteResult = {
  report: NativeDeleteReport;
  reportFile: string | null;
  persistenceError?: string;
};

/**
 * Validate the executor's native-target result without legacy ownership or acknowledgement fields.
 * @param {unknown} value - Executor result to validate.
 */
export function assertNativeDeleteResult(value: unknown): asserts value is NativeDeleteResult {
  assertExactKeys(
    value,
    [
      'report',
      'reportFile',
      ...(record(value) && value.persistenceError !== undefined ? ['persistenceError'] : []),
    ],
    'delete result',
  );
  if (value.reportFile !== null) assertNonemptyString(value.reportFile, 'reportFile');
  if (value.persistenceError !== undefined)
    assertNonemptyString(value.persistenceError, 'persistenceError');
  const report = value.report;
  assertExactKeys(report, ['runId', 'workspaceId', 'apiVersion', 'state', 'operations'], 'report');
  for (const field of ['runId', 'workspaceId', 'apiVersion'])
    assertNonemptyString(report[field], field);
  if (!Array.isArray(report.operations) || report.operations.length === 0)
    throw new TypeError('Delete operations required');
  const ids = new Set<string>();
  for (const operation of report.operations) {
    assertExactKeys(
      operation,
      [
        'target',
        'state',
        ...(operation.exactVariantAbsent === undefined ? [] : ['exactVariantAbsent']),
        ...(operation.error === undefined ? [] : ['error']),
        ...(operation.parentBehavior === undefined ? [] : ['parentBehavior']),
      ],
      'operation',
    );
    const target = operation.target;
    assertExactKeys(
      target,
      [
        'contentId',
        'variantId',
        'contentType',
        'apiName',
        'language',
        'variantType',
        'isPrimary',
        'isPublished',
        'status',
        'version',
      ],
      'target',
    );
    for (const field of ['contentId', 'variantId', 'language', 'status'])
      assertNonemptyString(target[field], field);
    if (target.apiName !== null) assertNonemptyString(target.apiName, 'apiName');
    if (
      !(RETRIEVE_CONTENT_TYPES as readonly unknown[]).includes(target.contentType) ||
      !['Content', 'Translation'].includes(String(target.variantType)) ||
      typeof target.isPrimary !== 'boolean' ||
      typeof target.isPublished !== 'boolean' ||
      target.contentId === target.variantId ||
      ids.has(String(target.variantId))
    )
      throw new TypeError('Invalid native delete target');
    ids.add(String(target.variantId));
    if (!record(target.version)) throw new TypeError('Invalid version evidence');
    assertExactKeys(target.version, Object.keys(target.version), 'version');
    for (const [key, version] of Object.entries(target.version)) {
      if (key === 'managedContentVersionId' || key === 'versionNumber')
        assertNonemptyString(version, key);
      else if (
        !['contentVersion', 'variantVersion'].includes(key) ||
        typeof version !== 'number' ||
        !Number.isSafeInteger(version) ||
        version < 0
      )
        throw new TypeError('Invalid version evidence');
    }
    if (
      !['unattempted', 'pending', 'completed', 'blocked', 'rejected', 'uncertain'].includes(
        String(operation.state),
      ) ||
      (operation.state === 'completed') !== (operation.exactVariantAbsent === true)
    )
      throw new TypeError('Invalid delete operation state');
    if (
      operation.parentBehavior !== undefined &&
      !['present', 'not-found'].includes(String(operation.parentBehavior))
    )
      throw new TypeError('Invalid parent observation');
    if (operation.error !== undefined) assertNonemptyString(operation.error, 'error');
  }
  const states = report.operations.map((operation: NativeDeleteOperation) => operation.state);
  const stop = states.findIndex((state: string) => state !== 'completed');
  let expected = 'completed';
  if (stop !== -1) {
    expected = states[stop];
    if (states[stop] === 'pending' || states[stop] === 'unattempted') expected = 'applying';
    else if (states[stop] === 'uncertain') expected = 'uncertain';
    else if (stop > 0) expected = 'partial';
  }
  if (
    report.state !== expected ||
    (stop !== -1 && states.slice(stop + 1).some((state: string) => state !== 'unattempted'))
  )
    throw new TypeError('Invalid sequential delete report');
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
