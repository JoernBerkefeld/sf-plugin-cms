import { expect } from 'chai';
import { CMS_CAPABILITY_DECLARATIONS } from '../../src/contracts/capability-registry.js';
import {
  assertStrategyUsage,
  lookupCmsCapability,
  qualifyCmsDependencyFreeProfile,
} from '../../src/services/capability-registry.js';
import {
  resolveCmsPortableIdentity,
  type PortableResolutionRequest,
} from '../../src/services/portable-resolution.js';

import { formHandlerBody, formHandlerDetail } from '../fixtures/form-handler.js';

const brandProfile = CMS_CAPABILITY_DECLARATIONS.find(
  ({ identity }) => identity.type === 'Brand',
)!.identity;

function request(overrides: Partial<PortableResolutionRequest> = {}): PortableResolutionRequest {
  return {
    profile: brandProfile,
    workspace: { workspaceApiName: 'marketing' },
    family: 'cms',
    type: 'Brand',
    apiName: 'main_brand',
    usage: { strategy: 'filtered', calls: 1, items: 1, pages: 1 },
    candidates: [
      {
        workspaceId: '20Y000000000001AAA',
        workspaceApiName: 'marketing',
        family: 'cms',
        type: 'Brand',
        apiName: 'main_brand',
        contentId: '20Y000000000002AAA',
        variantId: '20Y000000000003AAA',
        contentKey: 'brand-content-key',
      },
    ],
    ...overrides,
  };
}

describe('CMS runtime capability and portable resolution', () => {
  it('qualifies only dependency-free Template bodies and strict empty-root Handler envelopes', () => {
    const template = CMS_CAPABILITY_DECLARATIONS.find(
      ({ identity }) => identity.type === 'Email Template',
    )!.identity;
    const handler = CMS_CAPABILITY_DECLARATIONS.find(
      ({ identity }) => identity.type === 'Form Handler',
    )!.identity;
    const detail = {
      contentType: 'sfdc_cms__emailTemplate',
      externalId: null,
      contentBody: {
        'sfdc_cms:title': 'Template',
        messagePurpose: 'marketing',
        rawHtml: '<p>Welcome</p>',
        'lightning:dataProviders': [],
      },
    };
    expect(qualifyCmsDependencyFreeProfile(template, detail)).to.equal(true);
    for (const body of [
      { ...detail.contentBody, 'lightning:dataProviders': [{}] },
      { ...detail.contentBody, ref: { contentKey: 'dependency' } },
      { ...detail.contentBody, unknown: true },
      { ...detail.contentBody, rawHtml: '<img src="cms://unresolved">' },
      { ...detail.contentBody, rawHtml: '{{dynamic}}' },
    ])
      expect(qualifyCmsDependencyFreeProfile(template, { ...detail, contentBody: body })).to.equal(
        false,
      );
    expect(
      qualifyCmsDependencyFreeProfile(template, { ...detail, externalId: 'external' }),
    ).to.equal(false);
    expect(qualifyCmsDependencyFreeProfile(handler, formHandlerDetail())).to.equal(true);
    for (const body of [
      { ...formHandlerBody(), 'lightning:dataProviders': [{}] },
      {
        ...formHandlerBody(),
        'sfdc_cms:block': { ...formHandlerBody()['sfdc_cms:block'], children: [{}] },
      },
      { ...formHandlerBody(), flow: {} },
    ])
      expect(
        qualifyCmsDependencyFreeProfile(
          handler,
          formHandlerDetail('variant', { contentBody: body }),
        ),
      ).to.equal(false);
    expect(
      qualifyCmsDependencyFreeProfile(handler, formHandlerDetail('variant', { extra: true })),
    ).to.equal(false);
    expect(
      qualifyCmsDependencyFreeProfile(
        { ...handler, profile: 'dependency-free' },
        formHandlerDetail(),
      ),
    ).to.equal(false);
  });

  it('requires profile evidence and language before resolving new profiles', () => {
    for (const type of ['Email Template', 'Form Handler']) {
      const profile = CMS_CAPABILITY_DECLARATIONS.find(
        ({ identity }) => identity.type === type,
      )!.identity;
      const missing = request({
        profile,
        type,
        candidates: [{ ...request().candidates[0], type }],
      });
      expect(resolveCmsPortableIdentity(missing)).to.deep.equal({
        available: false,
        reason: 'incomplete-context',
      });
      expect(
        resolveCmsPortableIdentity({
          ...missing,
          language: 'en_US',
          candidates: [{ ...missing.candidates[0], language: 'en_US' }],
        }),
      ).to.deep.equal({ available: false, reason: 'unknown-profile' });
    }
  });
  it('looks up only one exact canonical profile identity', () => {
    const result = lookupCmsCapability(brandProfile);
    expect(result.available).to.equal(true);
    if (result.available) {
      expect(result.declaration).to.equal(CMS_CAPABILITY_DECLARATIONS[0]);
    }
    expect(lookupCmsCapability({ ...brandProfile, profile: 'unknown-profile' })).to.deep.equal({
      available: false,
      reason: 'unknown-profile',
    });
  });

  it('returns explicit unavailable results for unknown and blocked profiles', () => {
    expect(
      resolveCmsPortableIdentity(request({ profile: { ...brandProfile, provider: 'other' } })),
    ).to.deep.equal({ available: false, reason: 'unknown-profile' });
    expect(lookupCmsCapability(brandProfile, 'resolve')).to.deep.equal({
      available: false,
      reason: 'operation-blocked',
    });
  });

  it('binds strict Handler profile evidence to the resolved candidate identity', () => {
    const detail = formHandlerDetail();
    const profile = CMS_CAPABILITY_DECLARATIONS.find(
      ({ identity }) => identity.type === 'Form Handler',
    )!.identity;
    const candidate = {
      ...request().candidates[0],
      type: 'Form Handler',
      apiName: detail.apiName as string,
      language: detail.language as string,
      workspaceId: 'source-space',
      contentId: detail.managedContentId as string,
      variantId: detail.managedContentVariantId as string,
      contentKey: detail.contentKey as string,
      detail,
    };
    const input = request({
      profile,
      type: 'Form Handler',
      apiName: candidate.apiName,
      language: candidate.language,
      candidates: [candidate],
    });
    expect(resolveCmsPortableIdentity(input).available).to.equal(true);
    expect(
      resolveCmsPortableIdentity({
        ...input,
        candidates: [{ ...candidate, contentId: 'different-content' }],
      }).available,
    ).to.equal(false);
  });

  it('rejects missing or mismatched selected folder evidence for both new profiles', () => {
    for (const type of ['Email Template', 'Form Handler']) {
      const profile = CMS_CAPABILITY_DECLARATIONS.find(
        ({ identity }) => identity.type === type,
      )!.identity;
      const detail =
        type === 'Form Handler'
          ? formHandlerDetail()
          : {
              apiName: 'template',
              language: 'en_US',
              contentKey: 'template-key',
              managedContentId: 'parent',
              managedContentVariantId: 'variant',
              contentSpace: { id: 'source-space' },
              contentType: 'sfdc_cms__emailTemplate',
              externalId: null,
              contentBody: {
                'sfdc_cms:title': 'Template',
                messagePurpose: 'marketing',
                rawHtml: '<p>Welcome</p>',
              },
              folder: { id: 'folder-id', apiName: 'offers' },
            };
      Object.assign(detail.folder as object, { apiName: 'offers' });
      const candidate = {
        ...request().candidates[0],
        type,
        apiName: detail.apiName as string,
        language: 'en_US',
        workspaceId: 'source-space',
        contentId: detail.managedContentId as string,
        variantId: detail.managedContentVariantId as string,
        contentKey: detail.contentKey as string,
        folderId: 'folder-id',
        folderApiName: 'offers',
        detail,
      };
      const input = request({
        profile,
        type,
        apiName: candidate.apiName,
        language: 'en_US',
        folderApiName: 'offers',
        candidates: [candidate],
      });
      expect(resolveCmsPortableIdentity(input).available).to.equal(true);
      for (const folderId of ['unrelated-folder', undefined]) {
        expect(
          resolveCmsPortableIdentity({ ...input, candidates: [{ ...candidate, folderId }] })
            .available,
        ).to.equal(false);
      }
    }
  });

  it('separates portable identity from server evidence without source locator leakage', () => {
    const result = resolveCmsPortableIdentity(request());
    expect(result.available).to.equal(true);
    if (!result.available) return;
    expect(result.portableIdentity).to.deep.equal({
      family: 'cms',
      type: 'Brand',
      apiName: 'main_brand',
      context: { workspaceApiName: 'marketing' },
    });
    expect(JSON.stringify(result.portableIdentity)).not.to.match(
      /20Y00000000000[123]AAA|brand-content-key|workspaceId|contentId|variantId|contentKey/u,
    );
    expect(result.evidence).to.deep.equal({
      workspace: { kind: 'salesforce-id', value: '20Y000000000001AAA' },
      content: { kind: 'salesforce-id', value: '20Y000000000002AAA' },
      variant: { kind: 'salesforce-id', value: '20Y000000000003AAA' },
      contentKey: { kind: 'content-key', value: 'brand-content-key' },
    });
  });

  it('blocks missing or ambiguous workspace, folder, and language context', () => {
    expect(
      resolveCmsPortableIdentity(request({ workspace: { workspaceApiName: '' } })),
    ).to.deep.equal({ available: false, reason: 'incomplete-context' });
    expect(
      resolveCmsPortableIdentity(
        request({
          candidates: [
            {
              ...request().candidates[0],
              folderApiName: 'offers',
              folderId: '20Y000000000004AAA',
            },
          ],
        }),
      ),
    ).to.deep.equal({ available: false, reason: 'incomplete-context' });
    expect(
      resolveCmsPortableIdentity(
        request({
          folderApiName: 'offers',
          candidates: [{ ...request().candidates[0], folderApiName: 'offers' }],
        }),
      ),
    ).to.deep.equal({ available: false, reason: 'incomplete-context' });
    expect(
      resolveCmsPortableIdentity(
        request({ candidates: [request().candidates[0], request().candidates[0]] }),
      ),
    ).to.deep.equal({ available: false, reason: 'ambiguous-identity' });

    const emailProfile = CMS_CAPABILITY_DECLARATIONS.find(
      ({ identity }) => identity.type === 'Email',
    )!.identity;
    expect(
      resolveCmsPortableIdentity(
        request({
          profile: emailProfile,
          type: 'Email',
          usage: { strategy: 'filtered', calls: 1, items: 1, pages: 1 },
          candidates: [{ ...request().candidates[0], type: 'Email' }],
        }),
      ),
    ).to.deep.equal({ available: false, reason: 'incomplete-context' });
  });

  it('enforces exact strategy and every declared hard bound', () => {
    const declaration = CMS_CAPABILITY_DECLARATIONS[0].retrieval;
    expect(() =>
      assertStrategyUsage(declaration, {
        strategy: 'targeted',
        calls: 1,
        items: 1,
        pages: 1,
      }),
    ).to.throw('strategy');
    for (const usage of [
      { strategy: 'filtered' as const, calls: 21, items: 1, pages: 1 },
      { strategy: 'filtered' as const, calls: 1, items: 501, pages: 1 },
      { strategy: 'filtered' as const, calls: 1, items: 1, pages: 11 },
    ]) {
      expect(() => resolveCmsPortableIdentity(request({ usage }))).to.throw('hard bound');
    }
  });
});
