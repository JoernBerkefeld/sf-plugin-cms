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
        localKey: 'content.publish',
        method: 'POST',
        operationId: 'postManagedContentPublish',
      },
      {
        localKey: 'content.unpublish',
        method: 'POST',
        operationId: 'postManagedContentUnpublish',
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
      {
        localKey: 'variant.update',
        method: 'PUT',
        operationId: 'putManagedContentVariant',
      },
    ]);
  });

  it('generates the narrow JSON request-body metadata deterministically', () => {
    const contentCreate = SELECTED_OPERATIONS.find(({ localKey }) => localKey === 'content.create');
    const publish = SELECTED_OPERATIONS.find(({ localKey }) => localKey === 'content.publish');
    const unpublish = SELECTED_OPERATIONS.find(({ localKey }) => localKey === 'content.unpublish');
    const variantCreate = SELECTED_OPERATIONS.find(({ localKey }) => localKey === 'variant.create');
    const variantDelete = SELECTED_OPERATIONS.find(({ localKey }) => localKey === 'variant.delete');
    const variantUpdate = SELECTED_OPERATIONS.find(({ localKey }) => localKey === 'variant.update');

    expect(contentCreate?.requestBodyMediaTypes).to.deep.equal([
      'application/json',
      'multipart/form-data',
    ]);
    expect(publish?.requestBodyMediaTypes).to.deep.equal(['application/json']);
    expect(unpublish?.requestBodyMediaTypes).to.deep.equal(['application/json']);
    expect(variantCreate?.requestBodyMediaTypes).to.deep.equal(['application/json']);
    expect(variantUpdate?.requestBodyMediaTypes).to.deep.equal(['multipart/form-data']);
    expect(variantDelete).to.include({
      path: '/connect/cms/contents/variants/{variantId}',
      requestBodyPresent: false,
    });
    expect(variantDelete?.requestBodyMediaTypes).to.deep.equal([]);
  });
});
