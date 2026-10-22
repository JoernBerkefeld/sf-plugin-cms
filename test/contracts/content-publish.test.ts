import { expect } from 'chai';
import { assertContentPublishResult } from '../../src/contracts/content-publish.js';

const hash = 'a'.repeat(64);
function fixture(contentType = 'sfdc_cms__emailTemplate', completed = false) {
  const target = {
    workspaceId: 'space',
    apiName: 'native',
    language: 'en_US',
    contentId: 'parent',
    variantId: 'variant',
  };
  const status = completed ? 'Published' : 'Draft';
  const sibling = {
    hash,
    language: target.language,
    isPublished: completed,
    status,
    variantId: target.variantId,
  };
  const lifecycle = { isPublished: completed, status: { label: status, status } };
  return {
    mode: completed ? 'apply' : 'dry-run',
    outcome: completed ? 'completed' : 'ready',
    target,
    evidence: {
      selectorScope: 'variant',
      includeContentReferences: false,
      ...(completed
        ? { noSendAcknowledged: true, deploymentId: 'deployment', postPublishHash: hash }
        : { noSendAcknowledgementRequired: true }),
      baselineHash: hash,
      inventory: [{ ...sibling, contentId: target.contentId }],
      siblingInventory: [sibling],
      nativeEvidence: {
        contentType,
        identity: { ...target, contentType, contentKey: 'MCNATIVE' },
        canonicalAuthoringHash: hash,
        parentLifecycle: structuredClone(lifecycle),
        variantLifecycle: structuredClone(lifecycle),
        references: [
          {
            referenceId: `ref:${'b'.repeat(64)}`,
            owner: 'cms',
            kind: 'cms.content',
            source: { workspaceId: target.workspaceId, sourceId: target.contentId },
            portableKey: { scheme: 'cms-opaque-v1', value: 'MCNATIVE' },
            required: true,
            resolution: 'included',
          },
        ],
        ...(contentType === 'sfdc_cms__emailTemplate'
          ? {}
          : { mediaReceipt: { sha256: hash, size: 70, mimeType: 'image/png' } }),
      },
    },
    blockers: [],
    ...(completed ? { reportFile: 'report.json' } : {}),
  };
}

describe('strict optional native publish evidence (no execution admission)', () => {
  it('retains completed evidence under strict local-blocked partial status', () => {
    const result = {
      ...fixture('sfdc_cms__emailTemplate', true),
      outcome: 'remote-completed-local-blocked',
      localSource: { outcome: 'blocked', message: 'local changed' },
      blockers: [{ code: 'EMAIL_PUBLISH_LOCAL_BLOCKED', message: 'local changed' }],
    };
    expect(() => assertContentPublishResult(result, undefined, 'partial')).not.to.throw();
    expect(() =>
      assertContentPublishResult(
        { ...result, localReportFile: 'local.json' },
        undefined,
        'partial',
      ),
    ).not.to.throw();
    expect(() => assertContentPublishResult(result, undefined, 'success')).to.throw();
    expect(() =>
      assertContentPublishResult({
        ...result,
        localSource: { outcome: 'noop', message: 'local changed' },
      }),
    ).to.throw();
    expect(() =>
      assertContentPublishResult({ ...result, evidence: { ...result.evidence, deploymentId: '' } }),
    ).to.throw();
    expect(() => assertContentPublishResult({ ...result, localReportFile: undefined })).to.throw();
    expect(() =>
      assertContentPublishResult({
        ...result,
        blockers: [{ code: 'EMAIL_PUBLISH_LOCAL_BLOCKED', message: 'other' }],
      }),
    ).to.throw();
  });
  for (const family of [
    'sfdc_cms__emailTemplate',
    'sfdc_cms__image',
    'sfdc_cms__document',
    'sfdc_cms__audio',
  ]) {
    for (const completed of [false, true]) {
      it(`accepts JSON-only ${family} ${completed ? 'completed' : 'ready'} evidence`, () => {
        const serialized = JSON.stringify(fixture(family, completed));
        const result: unknown = JSON.parse(serialized);
        expect(() => assertContentPublishResult(result)).not.to.throw();
      });
    }
  }
  it('keeps legacy evidence without native additions valid', () => {
    const result = fixture() as unknown as { evidence: Record<string, unknown> };
    delete result.evidence.nativeEvidence;
    expect(() => assertContentPublishResult(result)).not.to.throw();
  });
  for (const change of [
    (v: ReturnType<typeof fixture>) => {
      v.evidence.nativeEvidence.contentType = 'sfdc_cms__email';
    },
    (v: ReturnType<typeof fixture>) => {
      v.evidence.nativeEvidence.identity.contentType = 'sfdc_cms__audio';
    },
    (v: ReturnType<typeof fixture>) => {
      v.evidence.nativeEvidence.identity.contentId = 'foreign';
    },
    (v: ReturnType<typeof fixture>) => {
      v.evidence.nativeEvidence.canonicalAuthoringHash = 'c'.repeat(64);
    },
    (v: ReturnType<typeof fixture>) => {
      v.evidence.nativeEvidence.parentLifecycle.status.status = 'Published';
    },
    (v: ReturnType<typeof fixture>) => {
      v.evidence.nativeEvidence.variantLifecycle.status.label = '';
    },
    (v: ReturnType<typeof fixture>) => {
      v.evidence.nativeEvidence.references[0].source.sourceId = 'foreign';
    },
    (v: ReturnType<typeof fixture>) => {
      v.evidence.nativeEvidence.references[0].resolution = 'unresolved';
    },
    (v: ReturnType<typeof fixture>) => {
      v.evidence.nativeEvidence.references = [];
    },
  ]) {
    it('rejects inconsistent native family, identity, lifecycle, hash or references', () => {
      const result = fixture();
      change(result);
      expect(() => assertContentPublishResult(result)).to.throw(TypeError);
    });
  }
  it('rejects native completed authoring drift without changing legacy result semantics', () => {
    const result = fixture('sfdc_cms__emailTemplate', true);
    result.evidence.postPublishHash = 'b'.repeat(64);
    expect(() => assertContentPublishResult(result)).to.throw(/preserve the authoring hash/u);
  });
  for (const receipt of [
    undefined,
    Buffer.from('bytes'),
    { sha256: hash, size: 0, mimeType: 'image/png' },
    { sha256: hash, size: 70.5, mimeType: 'image/png' },
    { sha256: 'bad', size: 70, mimeType: 'image/png' },
    { sha256: hash, size: 70, mimeType: '' },
    { sha256: hash, size: 70, mimeType: 'image/png', bytes: [1] },
  ]) {
    it('rejects missing, malformed or binary media receipts', () => {
      const result = fixture('sfdc_cms__image');
      Object.assign(result.evidence.nativeEvidence, { mediaReceipt: receipt });
      expect(() => assertContentPublishResult(result)).to.throw(TypeError);
    });
  }
  it('rejects media receipt on Template and unknown native evidence fields', () => {
    const result = fixture();
    Object.assign(result.evidence.nativeEvidence, {
      mediaReceipt: { sha256: hash, size: 70, mimeType: 'image/png' },
    });
    expect(() => assertContentPublishResult(result)).to.throw(TypeError);
    const extra = fixture();
    Object.assign(extra.evidence.nativeEvidence, { bytes: [] });
    expect(() => assertContentPublishResult(extra)).to.throw(TypeError);
  });
  it('rejects explicit undefined optional native evidence', () => {
    const result = fixture();
    Object.assign(result.evidence, { nativeEvidence: undefined });
    expect(() => assertContentPublishResult(result)).to.throw(TypeError);
  });
});
