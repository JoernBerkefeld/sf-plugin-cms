import { expect } from 'chai';
import {
  assertNativeDeleteResult,
  type NativeDeleteResult,
} from '../../src/contracts/native-content-delete.js';

function result(): NativeDeleteResult {
  return {
    reportFile: null,
    report: {
      runId: 'run',
      workspaceId: 'workspace',
      apiVersion: '67.0',
      state: 'completed',
      operations: [
        {
          state: 'completed',
          exactVariantAbsent: true,
          target: {
            contentId: 'parent',
            variantId: 'variant',
            apiName: null,
            contentType: 'sfdc_cms__document',
            language: 'de',
            variantType: 'Translation',
            isPrimary: false,
            isPublished: true,
            status: 'Published',
            version: { variantVersion: 2 },
          },
        },
      ],
    },
  };
}
describe('native delete result contract', () => {
  it('accepts truthful journal-free results and optional persistence errors without erasing completion', () => {
    assertNativeDeleteResult(result());
    assertNativeDeleteResult({
      ...result(),
      reportFile: 'report.json',
      persistenceError: 'Disk unavailable',
    });
  });
  it('accepts exact local outcomes only on independently completed remote operations', () => {
    for (const localSource of [
      { outcome: 'noop', removed: [], remaining: [] },
      { outcome: 'deleted', removed: ['file'], remaining: [] },
      { outcome: 'blocked', removed: [], remaining: ['file'], message: 'Changed' },
      { outcome: 'partial', removed: ['html'], remaining: ['definition'], message: 'Locked' },
    ] as const) {
      const value = result();
      value.report.operations[0].localSource = structuredClone(localSource) as never;
      assertNativeDeleteResult(value);
    }
    for (const localSource of [
      { outcome: 'deleted', removed: [], remaining: [] },
      { outcome: 'noop', removed: ['file'], remaining: [] },
      { outcome: 'blocked', removed: [], remaining: [] },
      { outcome: 'partial', removed: ['file'], remaining: ['file'], message: 'Locked' },
      { outcome: 'deleted', removed: ['file'], remaining: [], extra: true },
    ]) {
      const value = result();
      value.report.operations[0].localSource = localSource as never;
      expect(() => assertNativeDeleteResult(value)).to.throw(TypeError);
    }
    const value = result();
    value.report.operations[0] = {
      target: value.report.operations[0].target,
      state: 'uncertain',
      localSource: { outcome: 'noop', removed: [], remaining: [] },
    };
    value.report.state = 'uncertain';
    expect(() => assertNativeDeleteResult(value)).to.throw(TypeError);
  });
  it('rejects malformed identity, state, classification, version and ownership-era evidence', () => {
    const changes: Array<(value: NativeDeleteResult) => void> = [
      (value) => {
        value.report.operations[0].target.variantType = 'Variation' as never;
      },
      (value) => {
        value.report.operations[0].target.contentType = 'sfdc_cms__video' as never;
      },
      (value) => {
        value.report.operations[0].target.contentType = 'sfdc_cms__brand' as never;
      },
      (value) => {
        value.report.operations[0].target.variantId = 'parent';
      },
      (value) => {
        value.report.operations[0].target.language = '';
      },
      (value) => {
        value.report.operations[0].target.version.variantVersion = -1;
      },
      (value) => {
        value.report.operations[0].target.version.versionNumber = '';
      },
      (value) => {
        value.report.operations[0].target.version = { unknown: 'x' } as never;
      },
      (value) => {
        delete value.report.operations[0].exactVariantAbsent;
      },
      (value) => {
        value.report.state = 'uncertain';
      },
      (value) => {
        value.report.operations.push(structuredClone(value.report.operations[0]));
      },
      (value) => {
        (value as unknown as Record<string, unknown>).ownershipReport = 'old.json';
      },
    ];
    for (const change of changes) {
      const value = result();
      change(value);
      expect(() => assertNativeDeleteResult(value)).to.throw(TypeError);
    }
  });
  it('requires ordered completed prefix, active stop and unattempted suffix', () => {
    const value = result();
    const target = { ...value.report.operations[0].target, variantId: 'second' };
    value.report.operations.push({ target, state: 'uncertain', error: 'Lost response' });
    value.report.state = 'uncertain';
    assertNativeDeleteResult(value);
    value.report.operations.push({
      target: { ...target, variantId: 'third' },
      state: 'unattempted',
    });
    assertNativeDeleteResult(value);
    value.report.operations[2].state = 'blocked';
    expect(() => assertNativeDeleteResult(value)).to.throw(TypeError);
  });
});
