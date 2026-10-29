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
        ...(contentType === 'sfdc_cms__emailFragment'
          ? { fragmentVersion: 'version', fragmentPrerequisites: [] }
          : {}),
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
        ...(['sfdc_cms__emailTemplate', 'sfdc_cms__emailFragment'].includes(contentType)
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
  it('rejects missing, mapped, failed or foreign Fragment prerequisite receipts', () => {
    const prerequisite = {
      sourceDeveloperName: 'CustomerGraph',
      sourceDataSpace: 'default',
      targetDeveloperName: 'CustomerGraph',
      targetDataSpace: 'default',
      resolution: 'preserved',
      validationStatus: 'passed',
      validationEvidence: {
        url: '/ssot/data-graphs/CustomerGraph',
        name: 'CustomerGraph',
        dataspaceName: 'default',
        status: 'Ready',
      },
    };
    const result = fixture('sfdc_cms__emailFragment');
    const evidence = result.evidence.nativeEvidence as unknown as Record<string, unknown>;
    evidence.fragmentPrerequisites = [prerequisite];
    expect(() => assertContentPublishResult(result)).not.to.throw();
    for (const change of [
      { fragmentVersion: '' },
      { fragmentPrerequisites: undefined },
      { fragmentPrerequisites: [{ ...prerequisite, resolution: 'mapped' }] },
      { fragmentPrerequisites: [{ ...prerequisite, targetDeveloperName: 'Foreign' }] },
      { fragmentPrerequisites: [{ ...prerequisite, validationStatus: 'failed' }] },
      {
        fragmentPrerequisites: [
          {
            ...prerequisite,
            validationEvidence: { ...prerequisite.validationEvidence, name: 'Foreign' },
          },
        ],
      },
      {
        fragmentPrerequisites: [
          {
            ...prerequisite,
            validationEvidence: { ...prerequisite.validationEvidence, status: 'Pending' },
          },
        ],
      },
    ]) {
      expect(() =>
        assertContentPublishResult({
          ...result,
          evidence: { ...result.evidence, nativeEvidence: { ...evidence, ...change } },
        }),
      ).to.throw();
    }
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
});
