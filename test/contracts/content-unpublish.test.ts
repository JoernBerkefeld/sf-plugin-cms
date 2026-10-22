import { expect } from 'chai';
import { assertContentUnpublishResult } from '../../src/contracts/content-unpublish.js';

const hash = 'a'.repeat(64);
function fixture(contentType = 'sfdc_cms__emailTemplate') {
  const target = {
    workspaceId: 'space',
    apiName: 'native',
    language: 'en_US',
    contentId: 'parent',
    variantId: 'variant',
  };
  const sibling = {
    hash,
    language: target.language,
    isPublished: false,
    status: 'Draft',
    variantId: target.variantId,
  };
  const lifecycle = { isPublished: false, status: { label: 'Draft', status: 'Draft' } };
  return {
    mode: 'apply',
    outcome: 'completed',
    target,
    evidence: {
      selectorScope: 'parent',
      includeContentReferencesOmitted: true,
      activeUseStopsAcknowledged: true,
      baselineHash: hash,
      postUnpublishHash: hash,
      deploymentId: 'deployment',
      inventory: [
        { ...sibling, contentId: target.contentId },
        {
          ...sibling,
          contentId: 'other-parent',
          variantId: 'other-variant',
          language: 'fr',
          isPublished: true,
          status: 'Published',
        },
      ],
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
    reportFile: 'report.json',
  };
}

describe('strict native unpublish completion (execution admission remains closed)', () => {
  it('retains completed evidence under strict local-blocked partial status', () => {
    const result = {
      ...fixture(),
      outcome: 'remote-completed-local-blocked',
      localSource: { outcome: 'blocked', message: 'local changed' },
      blockers: [{ code: 'EMAIL_UNPUBLISH_LOCAL_BLOCKED', message: 'local changed' }],
    };
    expect(() => assertContentUnpublishResult(result, undefined, 'partial')).not.to.throw();
    expect(() =>
      assertContentUnpublishResult(
        { ...result, localReportFile: 'local.json' },
        undefined,
        'partial',
      ),
    ).not.to.throw();
    expect(() => assertContentUnpublishResult(result, undefined, 'success')).to.throw();
    expect(() =>
      assertContentUnpublishResult({
        ...result,
        localSource: { outcome: 'noop', message: 'local changed' },
      }),
    ).to.throw();
    expect(() =>
      assertContentUnpublishResult({
        ...result,
        evidence: { ...result.evidence, deploymentId: '' },
      }),
    ).to.throw();
    expect(() =>
      assertContentUnpublishResult({ ...result, localReportFile: undefined }),
    ).to.throw();
    expect(() =>
      assertContentUnpublishResult({
        ...result,
        blockers: [{ code: 'EMAIL_UNPUBLISH_LOCAL_BLOCKED', message: 'other' }],
      }),
    ).to.throw();
  });
  for (const family of [
    'sfdc_cms__emailTemplate',
    'sfdc_cms__image',
    'sfdc_cms__document',
    'sfdc_cms__audio',
  ]) {
    it(`accepts JSON-only Draft ${family} completion with an unselected Published locale`, () => {
      const serialized = JSON.stringify(fixture(family));
      const result: unknown = JSON.parse(serialized);
      expect(() => assertContentUnpublishResult(result)).not.to.throw();
    });
  }
  it('preserves legacy completed evidence without native additions', () => {
    const result = fixture() as unknown as { evidence: Record<string, unknown> };
    delete result.evidence.nativeEvidence;
    expect(() => assertContentUnpublishResult(result)).not.to.throw();
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
      v.evidence.nativeEvidence.identity.language = 'fr';
    },
    (v: ReturnType<typeof fixture>) => {
      v.evidence.nativeEvidence.canonicalAuthoringHash = 'c'.repeat(64);
    },
    (v: ReturnType<typeof fixture>) => {
      v.evidence.postUnpublishHash = 'c'.repeat(64);
    },
    (v: ReturnType<typeof fixture>) => {
      v.evidence.nativeEvidence.parentLifecycle.isPublished = true;
      v.evidence.nativeEvidence.parentLifecycle.status.status = 'Published';
    },
    (v: ReturnType<typeof fixture>) => {
      v.evidence.nativeEvidence.variantLifecycle.status.status = 'Published';
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
    it('rejects native identity, phase, authoring or reference drift', () => {
      const result = fixture();
      change(result);
      expect(() => assertContentUnpublishResult(result)).to.throw(TypeError);
    });
  }
  it('rejects extra parent variants even when both inventory projections agree', () => {
    const result = fixture();
    const sibling = { ...result.evidence.siblingInventory[0], variantId: 'extra', language: 'de' };
    result.evidence.siblingInventory.push(sibling);
    result.evidence.inventory.push({ ...sibling, contentId: result.target.contentId });
    expect(() => assertContentUnpublishResult(result)).to.throw(/exactly one/u);
    const legacy = result as unknown as { evidence: Record<string, unknown> };
    delete legacy.evidence.nativeEvidence;
    expect(() => assertContentUnpublishResult(legacy)).not.to.throw();
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
      expect(() => assertContentUnpublishResult(result)).to.throw(TypeError);
    });
  }
  for (const addition of [{ nativeEvidence: undefined }, { includeContentReferences: false }]) {
    it('rejects undefined native evidence and explicit reference inclusion policy', () => {
      const result = fixture();
      Object.assign(result.evidence, addition);
      expect(() => assertContentUnpublishResult(result)).to.throw(TypeError);
    });
  }
  it('rejects Template receipts and unknown native fields', () => {
    for (const addition of [
      { mediaReceipt: { sha256: hash, size: 70, mimeType: 'image/png' } },
      { bytes: [] },
    ]) {
      const result = fixture();
      Object.assign(result.evidence.nativeEvidence, addition);
      expect(() => assertContentUnpublishResult(result)).to.throw(TypeError);
    }
  });
});
