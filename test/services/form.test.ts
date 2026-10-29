import { expect } from 'chai';
import {
  FORM_READ_REPORT_FORMAT,
  assertFormReadback,
  buildFormReadReport,
  classifyFormDependencies,
  formCreatePayload,
  normalizeForm,
  planFormCopies,
  validateFormReadReport,
  type FormActionDescriptor,
} from '../../src/services/form.js';
import { broadFormBody, formBody, formDetail, formItem, formSource } from '../fixtures/form.js';

const generatedIds = [
  '20000000-0000-4000-8000-000000000001',
  '20000000-0000-4000-8000-000000000002',
  '20000000-0000-4000-8000-000000000003',
  '20000000-0000-4000-8000-000000000004',
  '20000000-0000-4000-8000-000000000005',
  '20000000-0000-4000-8000-000000000006',
] as const;
const mapping = [
  {
    source: { family: 'cms', type: 'form', apiName: 'source_form_api' },
    target: { apiName: 'target_form_api', title: 'Target form', urlName: 'target-form' },
  },
];

function actionButton(body: ReturnType<typeof formBody>) {
  return body['sfdc_cms:block'].children[0].children[0].children[0];
}

function deterministicUuid() {
  let index = 0;
  return () => generatedIds[index++];
}

describe('strict Form normalization and reports', () => {
  it('retains the live-proven minimal action profile as accepted evidence', () => {
    const actions: readonly FormActionDescriptor[] = [
      { type: 'custom', name: 'formsubmit' },
      { type: 'built-in', name: 'umaFormSubmissionAction' },
      { type: 'built-in', name: 'showThankYouAction' },
    ];
    expect(actionButton(formBody()).attributes.actions).to.deep.equal(actions);
  });

  it('requires Draft/unpublished exact detail envelopes while accepting an embedded title mismatch', () => {
    const mismatched = formDetail('variant', { title: 'Different top-level title' });
    expect(normalizeForm(mismatched)?.semantic.body['sfdc_cms:title']).to.equal('Contact form');
    expect(() =>
      classifyFormDependencies(formItem({ title: 'Different top-level title' })),
    ).not.to.throw();
    for (const overrides of [
      { isPublished: true },
      { status: { label: 'Published', status: 'Published' } },
      { externalId: 'external' },
      { extra: true },
      { contentType: { fullyQualifiedName: 'sfdc_cms__form', name: 'Form' } },
    ]) {
      expect(normalizeForm(formDetail('variant', overrides))).to.equal(null);
    }
  });

  it('builds a deterministic report with exact items/<variant>.json binding', () => {
    const normalization = normalizeForm(formDetail('variant'))!;
    const input = {
      workspaceId: 'source-space',
      apiName: 'source_form_api',
      variantId: 'variant-form-id',
      rawItemPath: 'items/variant-form-id.json',
      normalization,
    };
    const report = buildFormReadReport(input);
    expect(report.format).to.equal(FORM_READ_REPORT_FORMAT);
    expect(validateFormReadReport(report, input)).to.equal(true);
    for (const invalid of [
      { ...report, rawItemPath: 'items/other.json' },
      { ...report, rawItemPath: '../items/variant-form-id.json' },
      { ...report, extra: true },
      { ...report, normalization: { ...report.normalization, dependencies: [{}] } },
    ]) {
      expect(validateFormReadReport(invalid)).to.equal(false);
    }
  });
});

describe('strict Form copy planning and readback', () => {
  it('plans detached fresh identities and recursively regenerates every block UUID', () => {
    const loaded = formSource();
    const before = structuredClone(loaded);
    const result = planFormCopies(loaded, mapping, deterministicUuid());
    expect(result.targets).to.deep.equal([
      {
        sourceApiName: 'source_form_api',
        apiName: 'target_form_api',
        title: 'Target form',
        urlName: 'target-form',
      },
    ]);
    expect(result.items[0]).to.include({
      apiName: 'target_form_api',
      contentKey: 'MCBBBBBBBBBBBBBBBBBBBBBBBBBB',
      title: 'Target form',
      urlName: 'target-form',
    });
    expect(result.items[0].contentBody['sfdc_cms:title']).to.equal('Target form');
    const body = result.items[0].contentBody as ReturnType<typeof formBody>;
    expect([
      body['sfdc_cms:block'].id,
      body['sfdc_cms:block'].children[0].id,
      body['sfdc_cms:block'].children[0].children[0].id,
      actionButton(body).id,
    ]).to.deep.equal(generatedIds.slice(0, 4));
    expect(loaded).to.deep.equal(before);
  });

  it('rejects malformed mappings, ambiguous selection, stale names, contentKey, and invalid generated IDs', () => {
    const duplicate = formItem({ id: 'duplicate', contentKey: 'other-key' });
    for (const [source, rows] of [
      [formSource(), []],
      [
        formSource(),
        [{ source: mapping[0].source, target: { ...mapping[0].target, contentKey: 'x' } }],
      ],
      [formSource(), [{ ...mapping[0], source: { ...mapping[0].source, type: 'emailFragment' } }]],
      [
        formSource(),
        [{ ...mapping[0], target: { ...mapping[0].target, apiName: 'source_form_api' } }],
      ],
      [formSource(), [{ ...mapping[0], target: { ...mapping[0].target, title: 'Contact form' } }]],
      [
        formSource(),
        [{ ...mapping[0], target: { ...mapping[0].target, urlName: 'contact-form' } }],
      ],
      [{ ...formSource(), items: [formItem(), duplicate] }, mapping],
      [formSource(), [mapping[0], mapping[0]]],
    ] as const) {
      expect(() => planFormCopies(source, rows, deterministicUuid())).to.throw();
    }
    expect(() => planFormCopies(formSource(), mapping, () => 'not-a-uuid')).to.throw('UUID v4');
    const sourceBlockId = (formSource().items[0].contentBody as ReturnType<typeof formBody>)[
      'sfdc_cms:block'
    ].id;
    expect(() => planFormCopies(formSource(), mapping, () => sourceBlockId)).to.throw(
      'fresh unique UUID v4',
    );
    expect(() =>
      planFormCopies(
        { ...formSource(), integrity: { ...formSource().integrity, verified: false } },
        mapping,
      ),
    ).to.throw('integrity');
  });

  it('preserves broad Form semantics through payload construction except identity and block IDs', () => {
    const sourceBody = broadFormBody();
    const planned = planFormCopies(
      formSource(formItem({ contentBody: sourceBody })),
      mapping,
      deterministicUuid(),
    ).items[0];
    const payload = formCreatePayload(planned, 'target-root');
    const expectedBody = structuredClone(sourceBody) as Record<string, unknown>;
    expectedBody['sfdc_cms:title'] = 'Target form';
    let generatedIndex = 0;
    const setExpectedIds = (value: unknown): void => {
      if (Array.isArray(value)) {
        for (const child of value) setExpectedIds(child);
        return;
      }
      if (value === null || typeof value !== 'object') return;
      const candidate = value as Record<string, unknown>;
      if (candidate.type === 'block') candidate.id = generatedIds[generatedIndex++];
      for (const child of Object.values(candidate)) setExpectedIds(child);
    };
    setExpectedIds(expectedBody);
    expect(planned.contentKey).to.equal('MCBBBBBBBBBBBBBBBBBBBBBBBBBB');
    expect(payload).to.deep.equal({
      apiName: 'target_form_api',
      contentBody: expectedBody,
      contentSpaceOrFolderId: 'target-root',
      contentType: 'sfdc_cms__form',
      title: 'Target form',
      urlName: 'target-form',
    });
    expect(payload).not.to.have.property('contentKey');
  });

  it('requires exact semantic equality across target content and variant readback envelopes', () => {
    const planned = planFormCopies(formSource(), mapping, deterministicUuid()).items[0];
    const body = planned.contentBody;
    const common = {
      apiName: planned.apiName,
      contentBody: body,
      contentKey: 'MCAAAAAAAAAAAAAAAAAAAAAAAAAA',
      contentSpace: { id: 'target-space', resourceUrl: '/connect/cms/spaces/target-space' },
      managedContentId: 'target-content-id',
      managedContentVariantId: 'target-variant-id',
      title: planned.title,
      urlName: planned.urlName,
    };
    const content = formDetail('content', { ...common, contentId: 'target-content-id' });
    const variant = formDetail('variant', { ...common, id: 'target-variant-id' });
    const expected = {
      workspaceId: 'target-space',
      apiName: 'target_form_api',
      title: 'Target form',
      urlName: 'target-form',
      contentId: 'target-content-id',
      variantId: 'target-variant-id',
      semantic: normalizeForm(content)!.semantic,
    };
    expect(assertFormReadback(content, variant, expected).semantic).to.deep.equal(
      expected.semantic,
    );

    const changedBody = structuredClone(body) as ReturnType<typeof formBody>;
    actionButton(changedBody).attributes.actions.reverse();
    expect(() =>
      assertFormReadback(content, { ...variant, contentBody: changedBody }, expected),
    ).to.throw();
    expect(() =>
      assertFormReadback(content, variant, { ...expected, workspaceId: 'other' }),
    ).to.throw();
    expect(() =>
      assertFormReadback(content, variant, { ...expected, variantId: 'other' }),
    ).to.throw();
  });
});
