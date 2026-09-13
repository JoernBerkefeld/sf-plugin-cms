import { expect } from 'chai';
import { SELECTED_OPERATIONS } from '../../src/generated/operations.js';

describe('selected OpenAPI operations', () => {
  it('selects only the requested Stage 2 mutation allowlist', () => {
    const mutations = SELECTED_OPERATIONS.filter(({ method }) => method !== 'GET');

    expect(
      mutations.map(({ localKey, method, operationId }) => ({ localKey, method, operationId })),
    ).to.deep.equal([
      {
        localKey: 'content.create',
        method: 'POST',
        operationId: 'postManagedContentDocumentCreate',
      },
      {
        localKey: 'variant.create',
        method: 'POST',
        operationId: 'postManagedContentVariantCreate',
      },
      {
        localKey: 'variant.delete',
        method: 'DELETE',
        operationId: 'deleteManagedContentVariant',
      },
    ]);
    expect(mutations.some(({ method }) => method === 'PUT')).to.equal(false);
    expect(mutations.some(({ operationId }) => /publish|unpublish/iu.test(operationId))).to.equal(
      false,
    );
  });

  it('generates the narrow JSON request-body metadata deterministically', () => {
    const contentCreate = SELECTED_OPERATIONS.find(({ localKey }) => localKey === 'content.create');
    const variantCreate = SELECTED_OPERATIONS.find(({ localKey }) => localKey === 'variant.create');
    const variantDelete = SELECTED_OPERATIONS.find(({ localKey }) => localKey === 'variant.delete');

    expect(contentCreate?.requestBodyMediaTypes).to.deep.equal([
      'application/json',
      'multipart/form-data',
    ]);
    expect(variantCreate?.requestBodyMediaTypes).to.deep.equal(['application/json']);
    expect(variantDelete).to.include({
      path: '/connect/cms/contents/variants/{variantId}',
      requestBodyPresent: false,
    });
    expect(variantDelete?.requestBodyMediaTypes).to.deep.equal([]);
  });
});
