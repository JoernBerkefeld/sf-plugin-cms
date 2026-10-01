import { expect } from 'chai';
import {
  FORM_HANDLER_READ_REPORT_FORMAT,
  assertFormHandlerReadback,
  buildFormHandlerReadReport,
  classifyFormHandlerDependencies,
  formHandlerCreatePayload,
  normalizeFormHandler,
  planFormHandlerCopies,
  validateFormHandlerReadReport,
} from '../../src/services/form-handler.js';
import {
  formHandlerBody,
  formHandlerDetail,
  formHandlerItem,
  formHandlerSource,
} from '../fixtures/form-handler.js';

const mapping = [
  {
    source: { family: 'cms', type: 'formHandler', apiName: 'source_form_handler_api' },
    target: {
      apiName: 'target_form_handler_api',
      title: 'Target form handler',
      urlName: 'target-form-handler',
    },
  },
];
const generatedId = '20000000-0000-4000-8000-000000000001';

describe('strict Form Handler normalization and reports', () => {
  it('normalizes exact content and variant envelopes identically', () => {
    const content = normalizeFormHandler(formHandlerDetail('content'));
    const variant = normalizeFormHandler(formHandlerDetail('variant'));
    expect(content).to.deep.equal(variant);
    expect(content?.dependencies).to.deep.equal([]);
    expect(content?.references).to.deep.equal([]);
  });

  it('rejects populated providers or children and every forbidden reference class', () => {
    const mutations = [
      (body: ReturnType<typeof formHandlerBody>) =>
        (body['lightning:dataProviders'] as unknown[]).push({}),
      (body: ReturnType<typeof formHandlerBody>) =>
        (body['sfdc_cms:block'].children as unknown[]).push({}),
      (body: ReturnType<typeof formHandlerBody>) => Object.assign(body, { flow: {} }),
      (body: ReturnType<typeof formHandlerBody>) => Object.assign(body, { dataGraph: {} }),
      (body: ReturnType<typeof formHandlerBody>) => Object.assign(body, { source: {} }),
      (body: ReturnType<typeof formHandlerBody>) => Object.assign(body, { externalSource: {} }),
      (body: ReturnType<typeof formHandlerBody>) => Object.assign(body, { formHandler: {} }),
      (body: ReturnType<typeof formHandlerBody>) => Object.assign(body, { provider: {} }),
      (body: ReturnType<typeof formHandlerBody>) => Object.assign(body, { ref: {} }),
      (body: ReturnType<typeof formHandlerBody>) => Object.assign(body, { references: [] }),
      (body: ReturnType<typeof formHandlerBody>) => Object.assign(body, { file: {} }),
      (body: ReturnType<typeof formHandlerBody>) =>
        Object.assign(body, { nested: { type: 'UnknownReference' } }),
    ];
    for (const mutate of mutations) {
      const body = formHandlerBody();
      mutate(body);
      expect(normalizeFormHandler(formHandlerDetail('variant', { contentBody: body }))).to.equal(
        null,
      );
      expect(() =>
        classifyFormHandlerDependencies(formHandlerItem({ contentBody: body })),
      ).to.throw();
    }
  });

  it('requires exact Draft unpublished envelopes and matching title', () => {
    for (const overrides of [
      { isPublished: true },
      { status: { label: 'Published', status: 'Published' } },
      { title: 'Mismatch' },
      { externalId: 'external' },
      { extra: true },
    ]) {
      expect(normalizeFormHandler(formHandlerDetail('variant', overrides))).to.equal(null);
    }
  });

  it('builds a deterministic exact report', () => {
    const normalization = normalizeFormHandler(formHandlerDetail())!;
    const input = {
      workspaceId: 'source-space',
      apiName: 'source_form_handler_api',
      variantId: 'variant-form-handler-id',
      rawItemPath: 'items/variant-form-handler-id.json',
      normalization,
    };
    const report = buildFormHandlerReadReport(input);
    expect(report.format).to.equal(FORM_HANDLER_READ_REPORT_FORMAT);
    expect(validateFormHandlerReadReport(report, input)).to.equal(true);
    expect(validateFormHandlerReadReport({ ...report, rawItemPath: 'items/other.json' })).to.equal(
      false,
    );
  });
});

describe('strict Form Handler planning and readback', () => {
  it('plans fresh target identity and regenerates the root UUID only', () => {
    const source = formHandlerSource();
    const before = structuredClone(source);
    const result = planFormHandlerCopies(source, mapping, () => generatedId);
    expect(result.targets).to.deep.equal([
      {
        sourceApiName: 'source_form_handler_api',
        apiName: 'target_form_handler_api',
        title: 'Target form handler',
        urlName: 'target-form-handler',
      },
    ]);
    expect(result.items[0].contentBody['sfdc_cms:title']).to.equal('Target form handler');
    expect((result.items[0].contentBody['sfdc_cms:block'] as Record<string, unknown>).id).to.equal(
      generatedId,
    );
    expect(source).to.deep.equal(before);
  });

  it('rejects generated UUIDs that collide anywhere in the package', () => {
    const sourceId = (
      formHandlerSource().items[0].contentBody['sfdc_cms:block'] as Record<string, unknown>
    ).id as string;
    expect(() => planFormHandlerCopies(formHandlerSource(), mapping, () => sourceId)).to.throw(
      'fresh unique UUID v4',
    );
    expect(() =>
      planFormHandlerCopies(
        {
          ...formHandlerSource(),
          items: [
            formHandlerSource().items[0],
            formHandlerItem({
              id: 'variant-2',
              apiName: 'source_form_handler_api_2',
              contentKey: 'MCBBBBBBBBBBBBBBBBBBBBBBBBBB',
              title: 'Second handler',
              urlName: 'second-handler',
              contentBody: formHandlerBody('Second handler'),
            }),
          ],
        },
        [
          mapping[0],
          {
            source: { family: 'cms', type: 'formHandler', apiName: 'source_form_handler_api_2' },
            target: {
              apiName: 'target_form_handler_api_2',
              title: 'Target handler 2',
              urlName: 'target-handler-2',
            },
          },
        ],
        () => generatedId,
      ),
    ).to.throw('fresh unique UUID v4');
  });

  it('requires exact cms/formHandler mapping and fresh identities', () => {
    for (const rows of [
      [],
      [{ ...mapping[0], source: { ...mapping[0].source, type: 'form' } }],
      [{ ...mapping[0], target: { ...mapping[0].target, apiName: 'source_form_handler_api' } }],
      [{ ...mapping[0], target: { ...mapping[0].target, title: 'External form handler' } }],
      [{ ...mapping[0], target: { ...mapping[0].target, urlName: 'external-form-handler' } }],
    ]) {
      expect(() => planFormHandlerCopies(formHandlerSource(), rows, () => generatedId)).to.throw();
    }
    expect(() => planFormHandlerCopies(formHandlerSource(), mapping, () => 'invalid')).to.throw(
      'UUID v4',
    );
  });

  it('omits contentKey from CREATE and verifies independent exact readback', () => {
    const planned = planFormHandlerCopies(formHandlerSource(), mapping, () => generatedId).items[0];
    const payload = formHandlerCreatePayload(planned, 'target-root');
    expect(payload).not.to.have.property('contentKey');
    expect(payload.contentType).to.equal('sfdc_cms__formHandler');
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
    const content = formHandlerDetail('content', { ...common, contentId: 'target-content-id' });
    const variant = formHandlerDetail('variant', { ...common, id: 'target-variant-id' });
    const semantic = normalizeFormHandler(content)!.semantic;
    expect(
      assertFormHandlerReadback(content, variant, {
        workspaceId: 'target-space',
        apiName: planned.apiName!,
        title: planned.title,
        urlName: planned.urlName!,
        contentId: 'target-content-id',
        variantId: 'target-variant-id',
        semantic,
      }).semantic,
    ).to.deep.equal(semantic);
    expect(() =>
      assertFormHandlerReadback(content, variant, {
        workspaceId: 'other',
        apiName: planned.apiName!,
        title: planned.title,
        urlName: planned.urlName!,
        contentId: 'target-content-id',
        variantId: 'target-variant-id',
        semantic,
      }),
    ).to.throw();
  });
});
