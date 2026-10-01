import { expect } from 'chai';
import {
  buildPreferencePageReadReport,
  normalizePreferencePage,
  PREFERENCE_PAGE_READ_REPORT_FORMAT,
  validatePreferencePageReadReport,
} from '../../src/services/preference-page.js';

const rootId = '10000000-0000-4000-8000-000000000001';
const subscriptionsId = '10000000-0000-4000-8000-000000000002';
const submitId = '10000000-0000-4000-8000-000000000003';

function preferencePage(branded = false): Record<string, unknown> {
  return {
    apiName: 'preference_center',
    contentType: { fullyQualifiedName: 'sfdc_cms__preferencePage' },
    managedContentId: 'content-source-id',
    managedContentVariantId: 'variant-source-id',
    contentId: 'content-source-id',
    contentKey: 'source-page-key',
    contentSpace: { id: 'space-source-id', resourceUrl: '/connect/cms/spaces/space-source-id' },
    contentBody: {
      ...(branded ? { 'lightning:brandSource': { contentKey: 'source-brand-key' } } : {}),
      'lightning:dataProviders': [],
      'sfdc_cms:title': 'Preference Center',
      'sfdc_cms:description': 'Choose the messages you receive.',
      'sfdc_cms:block': {
        id: rootId,
        type: 'block',
        definition: 'sfdc_cms/rootContentBlock',
        children: [
          {
            id: subscriptionsId,
            type: 'block',
            definition: 'sfdc_cms/preferencePageSubscriptionsBlock',
            attributes: {
              subscriptionConfig: {
                engChannelTypeId: 'channel-source-id',
                commSubChannelTypeIds: ['subchannel-b', 'subchannel-a'],
              },
              'lightning:colorScheme': '{!$brand.colorScheme}',
              'lightning:typography': '{!$brand.typography.paragraph.paragraph1}',
            },
            children: [],
          },
          {
            id: submitId,
            type: 'block',
            definition: 'sfdc_cms/preferencePageSubmitBlock',
            attributes: { label: 'Save' },
            children: [],
          },
        ],
      },
    },
    externalId: null,
    isPublished: false,
    language: 'en_US',
    status: { label: 'Draft', status: 'Draft' },
    title: 'Preference Center',
    urlName: 'preference-center',
    contentFqn: null,
    createdBy: { id: 'user' },
    createdDate: '2026-10-01T00:00:00.000Z',
    folder: null,
    lastModifiedBy: { id: 'user' },
    lastModifiedDate: '2026-10-01T00:00:00.000Z',
    managedContentVersionId: 'version-source-id',
  };
}

function reportInput(branded = false) {
  const normalization = normalizePreferencePage(preferencePage(branded));
  expect(normalization).not.to.equal(null);
  return {
    workspaceId: 'space-source-id',
    apiName: 'preference_center',
    variantId: 'variant-source-id',
    rawItemPath: 'items/variant-source-id.json',
    normalization: normalization!,
  };
}

describe('Preference Page strict normalization', () => {
  it('preserves the raw body and ordered channel/subchannel evidence', () => {
    const result = normalizePreferencePage(preferencePage());
    expect(result?.semantic.body).to.deep.equal(preferencePage().contentBody);
    expect(result?.brandContentKey).to.equal(undefined);
    expect(result?.unresolvedReferences).to.deep.equal([
      {
        referenceKey: 'subscription-0:channel',
        kind: 'engagement-channel-type',
        sourceId: 'channel-source-id',
      },
      {
        referenceKey: 'subscription-0:subchannel-0',
        kind: 'communication-subchannel-type',
        sourceId: 'subchannel-b',
      },
      {
        referenceKey: 'subscription-0:subchannel-1',
        kind: 'communication-subchannel-type',
        sourceId: 'subchannel-a',
      },
    ]);
  });

  it('accepts only absent Brand or exact { contentKey }', () => {
    expect(normalizePreferencePage(preferencePage(true))?.brandContentKey).to.equal(
      'source-brand-key',
    );
    for (const brand of [
      { defaultBrandOption: 'sfdcBrand' },
      {},
      { contentKey: '' },
      { contentKey: 'key', extra: true },
    ]) {
      const value = preferencePage();
      (value.contentBody as Record<string, unknown>)['lightning:brandSource'] = brand;
      expect(normalizePreferencePage(value)).to.equal(null);
    }
  });

  it('requires exact Draft/unpublished independent content and variant envelopes', () => {
    const variant = preferencePage();
    variant.contentType = 'sfdc_cms__preferencePage';
    variant.id = variant.managedContentVariantId;
    delete variant.contentId;
    expect(normalizePreferencePage(variant)).to.deep.equal(
      normalizePreferencePage(preferencePage()),
    );
    for (const mutate of [
      (value: Record<string, unknown>) => {
        value.isPublished = true;
      },
      (value: Record<string, unknown>) => {
        value.status = { label: 'Published', status: 'Published' };
      },
      (value: Record<string, unknown>) => {
        value.managedContentId = value.managedContentVariantId;
      },
    ]) {
      const value = preferencePage();
      mutate(value);
      expect(normalizePreferencePage(value)).to.equal(null);
    }
  });
});

describe('Preference Page read reports', () => {
  it('builds and validates exact identity-bound reports', () => {
    const input = reportInput(true);
    const report = buildPreferencePageReadReport(input);
    expect(report.format).to.equal(PREFERENCE_PAGE_READ_REPORT_FORMAT);
    expect(validatePreferencePageReadReport(report, input)).to.equal(true);
    expect(validatePreferencePageReadReport({ ...report, variantId: 'other' })).to.equal(false);
  });

  it('rejects unsafe paths and normalization substitutions', () => {
    const report = buildPreferencePageReadReport(reportInput());
    expect(
      validatePreferencePageReadReport({ ...report, rawItemPath: 'items/../variant.json' }),
    ).to.equal(false);
    expect(
      validatePreferencePageReadReport(report, {
        normalization: structuredClone(report.normalization),
      }),
    ).to.equal(false);
  });
});
