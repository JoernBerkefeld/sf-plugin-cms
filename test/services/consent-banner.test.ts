import { expect } from 'chai';
import {
  CONSENT_BANNER_READ_REPORT_FORMAT,
  assertConsentBannerReadback,
  buildConsentBannerReadReport,
  classifyConsentBannerDependencies,
  consentBannerCreatePayload,
  normalizeConsentBanner,
  planConsentBannerCopies,
  validateConsentBannerReadReport,
} from '../../src/services/consent-banner.js';
import {
  consentBannerBody,
  consentBannerDetail,
  consentBannerItem,
  consentBannerSource,
} from '../fixtures/consent-banner.js';

const mapping = [
  {
    source: { family: 'cms', type: 'consentBanner', apiName: 'source_consent_banner_api' },
    target: {
      apiName: 'target_consent_banner_api',
      title: 'Target consent banner',
      urlName: 'target-consent-banner',
    },
  },
];
const generatedIds = Array.from(
  { length: 8 },
  (_, index) => `30000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
);

describe('strict Consent Banner normalization and reports', () => {
  it('normalizes exact content and variant envelopes identically', () => {
    const content = normalizeConsentBanner(consentBannerDetail('content'));
    const variant = normalizeConsentBanner(consentBannerDetail('variant'));
    expect(content).to.deep.equal(variant);
    expect(content?.dependencies).to.deep.equal([]);
    expect(content?.references).to.deep.equal([]);
  });

  it('rejects unknown actions, providers, and forbidden references', () => {
    const providerBody = consentBannerBody();
    providerBody['lightning:dataProviders'].push({} as never);
    expect(
      normalizeConsentBanner(consentBannerDetail('variant', { contentBody: providerBody })),
    ).to.equal(null);

    const actionBody = consentBannerBody();
    const root = actionBody['sfdc_cms:block'];
    const section = root.children[0];
    const rejectButton = section.children[1].children[0] as ReturnType<
      typeof consentBannerBody
    >['sfdc_cms:block']['children'][number]['children'][number]['children'][number] & {
      attributes: {
        'lightning:click': { actions: Array<{ attributes: object; definition: string }> };
      };
    };
    rejectButton.attributes['lightning:click'].actions.push({
      attributes: {},
      definition: 'unknownAction',
    });
    expect(
      normalizeConsentBanner(consentBannerDetail('variant', { contentBody: actionBody })),
    ).to.equal(null);

    for (const forbidden of [
      { site: {} },
      { consentConfig: {} },
      { dataGraph: {} },
      { externalSource: {} },
      { ref: {} },
      { nested: { type: 'UnknownReference' } },
    ]) {
      const body = { ...consentBannerBody(), ...forbidden } as never;
      expect(
        normalizeConsentBanner(consentBannerDetail('variant', { contentBody: body })),
      ).to.equal(null);
      expect(() =>
        classifyConsentBannerDependencies(consentBannerItem({ contentBody: body })),
      ).to.throw();
    }
  });

  it('builds an exact identity-bound report', () => {
    const normalization = normalizeConsentBanner(consentBannerDetail())!;
    const input = {
      workspaceId: 'source-space',
      apiName: 'source_consent_banner_api',
      variantId: 'variant-consent-banner-id',
      rawItemPath: 'items/variant-consent-banner-id.json',
      normalization,
    };
    const report = buildConsentBannerReadReport(input);
    expect(report.format).to.equal(CONSENT_BANNER_READ_REPORT_FORMAT);
    expect(validateConsentBannerReadReport(report, input)).to.equal(true);
    expect(
      validateConsentBannerReadReport({ ...report, rawItemPath: 'items/other.json' }),
    ).to.equal(false);
  });
});

describe('strict Consent Banner planning and readback', () => {
  it('plans fresh identity and recursively regenerates every block UUID', () => {
    const ids = [...generatedIds];
    const result = planConsentBannerCopies(consentBannerSource(), mapping, () => ids.shift()!);
    const serialized = JSON.stringify(result.items[0].contentBody);
    for (const id of generatedIds) expect(serialized).to.include(id);
    expect(result.items[0].contentBody['sfdc_cms:title']).to.equal('Target consent banner');
    expect(result.targets[0]).to.deep.equal({
      sourceApiName: 'source_consent_banner_api',
      apiName: 'target_consent_banner_api',
      title: 'Target consent banner',
      urlName: 'target-consent-banner',
    });
  });

  it('rejects reused source IDs and duplicate generated block IDs', () => {
    const sourceIds = ['10000000-0000-4000-8000-000000000001', ...generatedIds.slice(1)];
    expect(() =>
      planConsentBannerCopies(consentBannerSource(), mapping, () => sourceIds.shift()!),
    ).to.throw('fresh unique UUID v4');

    const duplicateIds = [...generatedIds];
    duplicateIds[1] = duplicateIds[0];
    expect(() =>
      planConsentBannerCopies(consentBannerSource(), mapping, () => duplicateIds.shift()!),
    ).to.throw('fresh unique UUID v4');
  });

  it('requires exact mapping and fresh target identities', () => {
    for (const rows of [
      [],
      [{ ...mapping[0], source: { ...mapping[0].source, type: 'form' } }],
      [{ ...mapping[0], target: { ...mapping[0].target, apiName: 'source_consent_banner_api' } }],
      [{ ...mapping[0], target: { ...mapping[0].target, title: 'Consent banner' } }],
      [{ ...mapping[0], target: { ...mapping[0].target, urlName: 'consent-banner' } }],
    ]) {
      expect(() => planConsentBannerCopies(consentBannerSource(), rows)).to.throw();
    }
  });

  it('omits contentKey and verifies exact independent readback', () => {
    const ids = [...generatedIds];
    const planned = planConsentBannerCopies(consentBannerSource(), mapping, () => ids.shift()!)
      .items[0];
    const payload = consentBannerCreatePayload(planned, 'target-root');
    expect(payload).not.to.have.property('contentKey');
    const common = {
      apiName: planned.apiName,
      contentBody: planned.contentBody,
      contentKey: 'MCAAAAAAAAAAAAAAAAAAAAAAAAAA',
      contentSpace: { id: 'target-space', resourceUrl: '/connect/cms/spaces/target-space' },
      managedContentId: 'target-content-id',
      managedContentVariantId: 'target-variant-id',
      title: planned.title,
      urlName: planned.urlName,
    };
    const content = consentBannerDetail('content', { ...common, contentId: 'target-content-id' });
    const variant = consentBannerDetail('variant', { ...common, id: 'target-variant-id' });
    const semantic = normalizeConsentBanner(content)!.semantic;
    expect(
      assertConsentBannerReadback(content, variant, {
        workspaceId: 'target-space',
        apiName: planned.apiName!,
        title: planned.title,
        urlName: planned.urlName!,
        contentId: 'target-content-id',
        variantId: 'target-variant-id',
        semantic,
      }).semantic,
    ).to.deep.equal(semantic);
  });
});
