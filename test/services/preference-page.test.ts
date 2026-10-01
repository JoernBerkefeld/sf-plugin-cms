import { expect } from 'chai';
import {
  buildPreferencePageReadReport,
  normalizePreferencePage,
  PREFERENCE_PAGE_READ_REPORT_FORMAT,
  validatePreferencePageReadReport,
} from '../../src/services/preference-page.js';

function preferencePage(): Record<string, unknown> {
  return {
    contentType: { fullyQualifiedName: 'sfdc_cms__preferencePage' },
    managedContentId: 'content-source-id',
    managedContentVariantId: 'variant-source-id',
    contentId: 'content-source-id',
    contentSpace: { id: 'space-source-id' },
    contentBody: {
      'lightning:brandSource': { defaultBrandOption: 'sfdcBrand' },
      'lightning:dataProviders': [],
      'sfdc_cms:title': 'Preference Center',
      'sfdc_cms:description': 'Choose the messages you receive.',
      'sfdc_cms:block': {
        id: 'root-source-id',
        type: 'block',
        definition: 'sfdc_cms/rootContentBlock',
        children: [
          {
            id: 'subscriptions-source-id',
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
          },
          {
            id: 'submit-source-id',
            type: 'block',
            definition: 'sfdc_cms/preferencePageSubmitBlock',
            attributes: {
              primaryButtonColorGroup:
                '{!$brand.buttonStyleGroup.primary.lightning:buttonColorGroup}',
              secondaryButtonColorGroup:
                '{!$brand.buttonStyleGroup.secondary.lightning:buttonColorGroup}',
            },
          },
        ],
      },
    },
  };
}

function reportInput() {
  const normalization = normalizePreferencePage(preferencePage());
  expect(normalization).not.to.equal(null);
  return {
    workspaceId: 'workspace-api-id',
    apiName: 'preference-center',
    variantId: 'variant-source-id',
    rawItemPath: 'items/preference-center/preference-page.json',
    normalization: normalization!,
  };
}

describe('Preference Page semantic normalization', () => {
  it('normalizes content and variant shapes deterministically without portable source IDs', () => {
    const content = preferencePage();
    const variant = structuredClone(content);
    variant.contentType = 'sfdc_cms__preferencePage';
    variant.id = variant.managedContentVariantId;
    delete variant.contentId;

    const contentResult = normalizePreferencePage(content);
    const variantResult = normalizePreferencePage(variant);

    expect(contentResult).to.deep.equal(variantResult);
    expect(contentResult?.semantic.blocks.map(({ definition }) => definition)).to.deep.equal([
      'sfdc_cms/preferencePageSubscriptionsBlock',
      'sfdc_cms/preferencePageSubmitBlock',
    ]);
    expect(contentResult?.semantic.blocks[0].attributes.subscriptionConfig).to.deep.equal({
      communicationSubchannelReferences: [
        'subscription-0:subchannel-0',
        'subscription-0:subchannel-1',
      ],
      engagementChannelReference: 'subscription-0:channel',
    });
    const syntheticSourceIds = [
      'content-source-id',
      'variant-source-id',
      'space-source-id',
      'root-source-id',
      'subscriptions-source-id',
      'submit-source-id',
      'channel-source-id',
      'subchannel-b',
      'subchannel-a',
    ];
    const assertNoSourceIds = (value: unknown): void => {
      if (typeof value === 'string') {
        expect(syntheticSourceIds).not.to.include(value);
        return;
      }
      if (Array.isArray(value)) {
        for (const entry of value) assertNoSourceIds(entry);
        return;
      }
      if (value !== null && typeof value === 'object') {
        for (const entry of Object.values(value)) assertNoSourceIds(entry);
      }
    };
    assertNoSourceIds(contentResult?.semantic);
    expect(contentResult?.provenance).to.deep.equal({
      managedContentId: 'content-source-id',
      managedContentVariantId: 'variant-source-id',
      contentSpaceId: 'space-source-id',
    });
  });

  it('accepts the observed live variant envelope without a top-level id', () => {
    const live = preferencePage();
    delete live.contentId;
    Object.assign(live, {
      apiName: 'preference-center',
      contentFqn: null,
      contentKey: 'source-key',
      createdDate: '2026-08-17T12:29:33.000Z',
      externalId: null,
      isPublished: true,
      language: 'en_US',
      lastModifiedDate: '2026-08-17T12:39:48.000Z',
      managedContentVersionId: 'version-source-id',
      status: { status: 'Published' },
      title: 'Preference Center',
      urlName: 'preference-center',
    });
    (live.contentSpace as Record<string, unknown>).resourceUrl = '/connect/cms/spaces/space';
    expect(normalizePreferencePage(live)).not.to.equal(null);
  });

  it('excludes unrelated and administrative content types', () => {
    const value = preferencePage();
    value.contentType = { fullyQualifiedName: 'sfdc_cms__landingPage' };
    expect(normalizePreferencePage(value)).to.equal(null);
  });

  it('fails closed on missing, contradictory, or malformed discriminator fields', () => {
    for (const mutate of [
      (value: Record<string, unknown>) => delete value.managedContentId,
      (value: Record<string, unknown>) => delete value.managedContentVariantId,
      (value: Record<string, unknown>) => delete value.contentSpace,
      (value: Record<string, unknown>) => {
        value.managedContentVariantId = value.managedContentId;
      },
      (value: Record<string, unknown>) => {
        value.contentId = 'contradictory-content-id';
      },
      (value: Record<string, unknown>) => {
        value.id = 'contradictory-variant-id';
      },
      (value: Record<string, unknown>) => {
        value.contentBody = { 'sfdc_cms:block': {} };
      },
    ]) {
      const value = preferencePage();
      mutate(value);
      expect(normalizePreferencePage(value)).to.equal(null);
    }
  });

  it('accepts observed presentation attributes but excludes them from portable semantics', () => {
    const result = normalizePreferencePage(preferencePage());
    expect(result?.semantic.blocks[0].attributes).to.have.all.keys('subscriptionConfig');
    expect(result?.semantic.blocks[1].attributes).to.deep.equal({});
  });

  it('rejects arbitrary identifier-shaped fields at evidenced object boundaries', () => {
    for (const mutate of [
      (value: Record<string, unknown>) => {
        value.externalSourceId = 'outer-source-id';
      },
      (value: Record<string, unknown>) => {
        value.id = 'outer-source-id';
      },
      (value: Record<string, unknown>) => {
        const type = value.contentType as Record<string, unknown>;
        type.contentTypeId = 'type-source-id';
      },
      (value: Record<string, unknown>) => {
        const space = value.contentSpace as Record<string, unknown>;
        space.workspaceId = 'workspace-source-id';
      },
      (value: Record<string, unknown>) => {
        const body = value.contentBody as Record<string, unknown>;
        body.managedContentVersionId = 'version-source-id';
      },
    ]) {
      const value = preferencePage();
      mutate(value);
      expect(normalizePreferencePage(value)).to.equal(null);
    }

    const variant = preferencePage();
    variant.contentType = 'sfdc_cms__preferencePage';
    variant.id = variant.managedContentVariantId;
    delete variant.contentId;
    variant.contentId = 'outer-source-id';
    expect(normalizePreferencePage(variant)).to.equal(null);
  });

  it('rejects malformed root and submit shapes', () => {
    for (const mutate of [
      (value: Record<string, unknown>) => {
        const body = value.contentBody as Record<string, unknown>;
        const root = body['sfdc_cms:block'] as Record<string, unknown>;
        root.attributes = {};
      },
      (value: Record<string, unknown>) => {
        const body = value.contentBody as Record<string, unknown>;
        const root = body['sfdc_cms:block'] as Record<string, unknown>;
        root.children = {};
      },
      (value: Record<string, unknown>) => {
        const body = value.contentBody as Record<string, unknown>;
        const root = body['sfdc_cms:block'] as Record<string, unknown>;
        const submit = (root.children as Array<Record<string, unknown>>)[1];
        submit.attributes = { label: ['Save'] };
      },
      (value: Record<string, unknown>) => {
        const body = value.contentBody as Record<string, unknown>;
        const root = body['sfdc_cms:block'] as Record<string, unknown>;
        const submit = (root.children as Array<Record<string, unknown>>)[1];
        submit.children = [{}];
      },
    ]) {
      const value = preferencePage();
      mutate(value);
      expect(normalizePreferencePage(value)).to.equal(null);
    }
  });

  it('fails closed on malformed channel reference shapes', () => {
    for (const config of [
      { engChannelTypeId: ['channel-source-id'], commSubChannelTypeIds: ['subchannel-a'] },
      { engChannelTypeId: 'channel-source-id', commSubChannelTypeIds: 'subchannel-a' },
      { engChannelTypeId: 'channel-source-id', commSubChannelTypeIds: ['subchannel-a', 7] },
    ]) {
      const value = preferencePage();
      const body = value.contentBody as Record<string, unknown>;
      const root = body['sfdc_cms:block'] as Record<string, unknown>;
      const subscription = (root.children as Array<Record<string, unknown>>)[0];
      subscription.attributes = { subscriptionConfig: config };
      expect(normalizePreferencePage(value)).to.equal(null);
    }
  });

  it('returns ordered unresolved channel and subchannel references', () => {
    expect(normalizePreferencePage(preferencePage())?.unresolvedReferences).to.deep.equal([
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

  it('rejects non-empty data providers instead of leaking provider identifiers', () => {
    for (const provider of [
      { definition: 'provider/b', providerId: 'provider-source-id' },
      { definition: 'provider/b', contentId: 'content-source-id' },
      { definition: 'provider/b', managedContentId: 'managed-content-source-id' },
    ]) {
      const value = preferencePage();
      const body = value.contentBody as Record<string, unknown>;
      body['lightning:dataProviders'] = [provider];
      expect(normalizePreferencePage(value)).to.equal(null);
    }
  });

  it('rejects extra block and brand fields instead of leaking semantic attributes', () => {
    for (const mutate of [
      (value: Record<string, unknown>) => {
        const body = value.contentBody as Record<string, unknown>;
        const brand = body['lightning:brandSource'] as Record<string, unknown>;
        brand.providerId = 'provider-source-id';
      },
      (value: Record<string, unknown>) => {
        const body = value.contentBody as Record<string, unknown>;
        const root = body['sfdc_cms:block'] as Record<string, unknown>;
        root.contentId = 'content-source-id';
      },
      (value: Record<string, unknown>) => {
        const body = value.contentBody as Record<string, unknown>;
        const root = body['sfdc_cms:block'] as Record<string, unknown>;
        const subscription = (root.children as Array<Record<string, unknown>>)[0];
        const attributes = subscription.attributes as Record<string, unknown>;
        attributes.managedContentId = 'managed-content-source-id';
      },
      (value: Record<string, unknown>) => {
        const body = value.contentBody as Record<string, unknown>;
        const root = body['sfdc_cms:block'] as Record<string, unknown>;
        const submit = (root.children as Array<Record<string, unknown>>)[1];
        const attributes = submit.attributes as Record<string, unknown>;
        attributes.providerId = 'provider-source-id';
      },
    ]) {
      const value = preferencePage();
      mutate(value);
      expect(normalizePreferencePage(value)).to.equal(null);
    }
  });

  it('rejects unsupported definitions and malformed evidenced block shapes', () => {
    for (const mutate of [
      (block: Record<string, unknown>) => {
        block.definition = 'sfdc_cms/unsupportedBlock';
      },
      (block: Record<string, unknown>) => {
        block.children = [{}];
      },
      (block: Record<string, unknown>) => {
        delete block.id;
      },
      (block: Record<string, unknown>) => {
        block.attributes = [];
      },
      (block: Record<string, unknown>) => {
        block.extra = true;
      },
    ]) {
      const value = preferencePage();
      const body = value.contentBody as Record<string, unknown>;
      const root = body['sfdc_cms:block'] as Record<string, unknown>;
      const subscription = (root.children as Array<Record<string, unknown>>)[0];
      mutate(subscription);
      expect(normalizePreferencePage(value)).to.equal(null);
    }
  });
});

describe('Preference Page read reports', () => {
  it('builds deterministic valid content and variant reports', () => {
    const contentInput = reportInput();
    const variant = preferencePage();
    variant.contentType = 'sfdc_cms__preferencePage';
    variant.id = variant.managedContentVariantId;
    delete variant.contentId;
    const variantNormalization = normalizePreferencePage(variant);
    expect(variantNormalization).to.deep.equal(contentInput.normalization);

    const contentReport = buildPreferencePageReadReport(contentInput);
    const variantReport = buildPreferencePageReadReport({
      ...contentInput,
      normalization: variantNormalization!,
    });
    expect(contentReport).to.deep.equal(variantReport);
    expect(contentReport.format).to.equal(PREFERENCE_PAGE_READ_REPORT_FORMAT);
    expect(validatePreferencePageReadReport(contentReport)).to.equal(true);
  });

  it('binds exact workspace, API, variant, raw path, and normalization identity', () => {
    const input = reportInput();
    const report = buildPreferencePageReadReport(input);
    for (const expected of [
      { workspaceId: 'other-workspace' },
      { apiName: 'other-api-name' },
      { variantId: 'other-variant' },
      { rawItemPath: 'items/other.json' },
      { normalization: structuredClone(input.normalization) },
    ]) {
      expect(validatePreferencePageReadReport(report, expected)).to.equal(false);
    }
    expect(validatePreferencePageReadReport(report, input)).to.equal(true);

    expect(validatePreferencePageReadReport({ ...report, variantId: 'other-variant' })).to.equal(
      false,
    );
  });

  it('rejects unsafe or non-item JSON raw paths', () => {
    for (const rawItemPath of [
      '',
      'preference.json',
      '/items/preference.json',
      'items/../preference.json',
      'items/./preference.json',
      'items//preference.json',
      String.raw`items\preference.json`,
      'items/preference.txt',
      'C:/items/preference.json',
    ]) {
      expect(
        validatePreferencePageReadReport({
          ...buildPreferencePageReadReport(reportInput()),
          rawItemPath,
        }),
      ).to.equal(false);
    }
  });

  it('rejects extra report and nested normalization fields', () => {
    const report = buildPreferencePageReadReport(reportInput());
    expect(validatePreferencePageReadReport({ ...report, extra: true })).to.equal(false);

    const nestedExtra = structuredClone(report) as unknown as Record<string, unknown>;
    const normalization = nestedExtra.normalization as Record<string, unknown>;
    const provenance = normalization.provenance as Record<string, unknown>;
    provenance.extra = true;
    expect(validatePreferencePageReadReport(nestedExtra)).to.equal(false);
  });

  it('rejects malformed normalization and changed unresolved-reference ordering', () => {
    const report = buildPreferencePageReadReport(reportInput());
    const malformed = structuredClone(report) as unknown as Record<string, unknown>;
    const malformedNormalization = malformed.normalization as Record<string, unknown>;
    const semantic = malformedNormalization.semantic as Record<string, unknown>;
    const blocks = semantic.blocks as Array<Record<string, unknown>>;
    const attributes = blocks[0].attributes as Record<string, unknown>;
    attributes.subscriptionConfig = {
      engagementChannelReference: 'missing-evidence',
      communicationSubchannelReferences: [],
    };
    expect(validatePreferencePageReadReport(malformed)).to.equal(false);

    const reordered = structuredClone(report) as unknown as Record<string, unknown>;
    const reorderedNormalization = reordered.normalization as Record<string, unknown>;
    const unresolved = reorderedNormalization.unresolvedReferences as unknown[];
    reorderedNormalization.unresolvedReferences = unresolved.toReversed();
    expect(validatePreferencePageReadReport(reordered)).to.equal(false);
  });

  it('keeps source IDs only in provenance and unresolved evidence', () => {
    const report = buildPreferencePageReadReport(reportInput());
    const serialized = JSON.stringify(report);
    for (const sourceId of [
      'content-source-id',
      'variant-source-id',
      'space-source-id',
      'channel-source-id',
      'subchannel-b',
      'subchannel-a',
    ]) {
      expect(serialized).to.include(sourceId);
    }

    const portable = JSON.stringify({
      semantic: report.normalization.semantic,
      workspaceId: report.workspaceId,
      apiName: report.apiName,
      rawItemPath: report.rawItemPath,
    });
    for (const sourceId of [
      'content-source-id',
      'variant-source-id',
      'space-source-id',
      'channel-source-id',
      'subchannel-b',
      'subchannel-a',
    ]) {
      expect(portable).not.to.include(sourceId);
    }
  });
});
