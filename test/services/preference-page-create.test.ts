import { expect } from 'chai';
import {
  planPreferencePageCopies,
  preferencePageCreatePayload,
} from '../../src/services/preference-page.js';
import type {
  LoadedWorkspaceExport,
  WorkspaceImportItem,
} from '../../src/services/import-workspace.js';

const ids = [
  '10000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000002',
  '10000000-0000-4000-8000-000000000003',
];

function item(branded = false, suffix = branded ? 'branded' : 'unbranded'): WorkspaceImportItem {
  return {
    apiName: `source_${suffix}`,
    contentBody: {
      ...(branded ? { 'lightning:brandSource': { contentKey: 'source-brand-key' } } : {}),
      'lightning:dataProviders': [],
      'sfdc_cms:title': 'Preferences',
      'sfdc_cms:description': 'Choose subscriptions.',
      'sfdc_cms:block': {
        id: ids[0],
        type: 'block',
        definition: 'sfdc_cms/rootContentBlock',
        children: [
          {
            id: ids[1],
            type: 'block',
            definition: 'sfdc_cms/preferencePageSubscriptionsBlock',
            attributes: {
              subscriptionConfig: {
                engChannelTypeId: 'source-channel',
                commSubChannelTypeIds: ['source-sub-a', 'source-sub-b'],
              },
              'lightning:colorScheme': '{!$brand.colorScheme}',
            },
            children: [],
          },
          {
            id: ids[2],
            type: 'block',
            definition: 'sfdc_cms/preferencePageSubmitBlock',
            attributes: { label: 'Save' },
            children: [],
          },
        ],
      },
    },
    contentKey: `source-page-key-${suffix}`,
    contentSpace: { id: 'source-space' },
    contentType: 'sfdc_cms__preferencePage',
    id: `source-variant-${suffix}`,
    language: 'en_US',
    title: 'Preferences',
  };
}

function source(items: WorkspaceImportItem[]): LoadedWorkspaceExport {
  return {
    integrity: {
      listedItemCount: items.length,
      verifiedItemCount: items.length,
      unlistedFileCount: 0,
      verified: true,
    },
    isPartial: true,
    items,
    manifest: {
      schemaVersion: 1,
      mode: 'experimental-best-effort',
      workspaceId: 'source-space',
      search: {
        contentSpaceOrFolderIds: ['source-space'],
        languages: ['All'],
        pageSize: 250,
        queryTerm: '*',
      },
      expectedCount: items.length,
      foundCount: items.length,
      exportedCount: items.length,
      pagesRequested: 1,
      entries: items.map(({ id }) => ({ file: `items/${id}.json`, variantId: id })),
      rejectedVariantIds: [],
      failedVariantIds: [],
      warnings: [
        { code: 'REFERENCE_UNRESOLVED', message: 'mapped', variantIds: items.map(({ id }) => id) },
      ],
      contract: 'sf-cms-workspace-export',
      contractVersion: '1.0.0',
      provenance: {
        producer: 'sf-plugin-cms',
        sourceOrgId: 'source-org',
        sourceWorkspaceId: 'source-space',
        pluginVersion: '0.7.0',
        generatedAt: '2026-10-01T00:00:00.000Z',
      },
      completeness: 'partial',
      dependencies: [],
      externalReferences: [],
      items: [],
    },
    manifestSha256: 'a'.repeat(64),
    sourceDirectory: 'synthetic',
  };
}

function mapping(apiName: string, target: string, brand?: object) {
  return {
    source: { family: 'cms', type: 'preferencePage', apiName },
    target: { apiName: target },
    channels: [{ sourceId: 'source-channel', targetId: 'target-channel' }],
    subchannels: [
      { sourceId: 'source-sub-a', targetId: 'target-sub-a' },
      { sourceId: 'source-sub-b', targetId: 'target-sub-b' },
    ],
    ...(brand === undefined ? {} : { brand }),
  };
}

describe('Preference Page CREATE planning', () => {
  it('preserves absent Brand, maps channel IDs, and omits root key/title/urlName', () => {
    const generated = [
      '20000000-0000-4000-8000-000000000001',
      '20000000-0000-4000-8000-000000000002',
      '20000000-0000-4000-8000-000000000003',
    ];
    const plan = planPreferencePageCopies(
      source([item()]),
      [mapping('source_unbranded', 'target_page')],
      () => generated.shift()!,
    );
    const planned = plan.items[0];
    expect(planned.contentBody).not.to.have.property('lightning:brandSource');
    const root = planned.contentBody['sfdc_cms:block'] as Record<string, unknown>;
    const children = root.children as Array<Record<string, unknown>>;
    const config = (children[0].attributes as Record<string, unknown>).subscriptionConfig;
    expect(config).to.deep.equal({
      engChannelTypeId: 'target-channel',
      commSubChannelTypeIds: ['target-sub-a', 'target-sub-b'],
    });
    expect([root.id, children[0].id, children[1].id]).to.deep.equal([
      '20000000-0000-4000-8000-000000000001',
      '20000000-0000-4000-8000-000000000002',
      '20000000-0000-4000-8000-000000000003',
    ]);
    const payload = preferencePageCreatePayload(planned, 'destination-root');
    expect(payload).to.have.all.keys(
      'apiName',
      'contentBody',
      'contentSpaceOrFolderId',
      'contentType',
    );
  });

  it('requires Brand selector exactly when source has a Brand key', () => {
    expect(() =>
      planPreferencePageCopies(source([item(true)]), [mapping('source_branded', 'target_page')]),
    ).to.throw('requires exactly one destination Brand selector');
    expect(() =>
      planPreferencePageCopies(source([item()]), [
        mapping('source_unbranded', 'target_page', { apiName: 'brand' }),
      ]),
    ).to.throw('must not supply a Brand mapping');
    expect(() =>
      planPreferencePageCopies(source([item(true)]), [
        mapping('source_branded', 'target_page', { apiName: 'target_brand' }),
      ]),
    ).not.to.throw();
    for (const invalid of [
      { apiName: 'target_brand', contentKey: '' },
      { apiName: '', contentKey: 'target-brand-key' },
      { apiName: 'target_brand', contentKey: 'target-brand-key' },
      { contentKey: 'target-brand-key', extra: true },
    ]) {
      expect(() =>
        planPreferencePageCopies(source([item(true)]), [
          mapping('source_branded', 'target_page', invalid),
        ]),
      ).to.throw('requires exactly one destination Brand selector');
    }
  });

  it('requires package-wide consistent repeated dependency mappings', () => {
    const first = item(false, 'one');
    const second = item(false, 'two');
    expect(() =>
      planPreferencePageCopies(source([first, second]), [
        mapping('source_one', 'target_one'),
        mapping('source_two', 'target_two'),
      ]),
    ).not.to.throw();

    const channelConflict = mapping('source_two', 'target_two');
    channelConflict.channels[0].targetId = 'different-channel';
    expect(() =>
      planPreferencePageCopies(source([first, second]), [
        mapping('source_one', 'target_one'),
        channelConflict,
      ]),
    ).to.throw('channel source ID maps inconsistently across pages');

    const subchannelConflict = mapping('source_two', 'target_two');
    subchannelConflict.subchannels[0].targetId = 'different-subchannel';
    expect(() =>
      planPreferencePageCopies(source([first, second]), [
        mapping('source_one', 'target_one'),
        subchannelConflict,
      ]),
    ).to.throw('subchannel source ID maps inconsistently across pages');
  });

  it('rejects incomplete mappings and non-fresh package-wide UUIDs', () => {
    const bad = mapping('source_unbranded', 'target_page');
    bad.subchannels.pop();
    expect(() => planPreferencePageCopies(source([item()]), [bad])).to.throw('cover exactly');
    expect(() =>
      planPreferencePageCopies(
        source([item()]),
        [mapping('source_unbranded', 'target_page')],
        () => ids[0],
      ),
    ).to.throw('fresh package-wide unique UUID v4');
  });
});
