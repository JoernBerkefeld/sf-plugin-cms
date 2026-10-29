import path from 'node:path';
import { expect } from 'chai';
import { readFile } from 'node:fs/promises';
import {
  buildSelectedOperationDescriptors,
  generateSelectedOpenApi,
} from '../../src/openapi/generate.js';
import { intakeOpenApi } from '../../src/openapi/intake.js';
import { SELECTED_OPERATION_CONFIG, SUPPLEMENTAL_OPERATIONS } from '../../src/openapi/selected.js';
import { SELECTED_OPERATIONS } from '../../src/generated/operations.js';

const canonicalPath = path.resolve('resources', 'openapi', 'connect-rest-api-cms-v67.yaml');

describe('selected OpenAPI generation', () => {
  it('adds only the locally identified v68 excerpt supplement and preserves the v67 inventory', async () => {
    const intake = await intakeOpenApi(canonicalPath);
    const original = buildSelectedOperationDescriptors(
      intake.document as Record<string, unknown>,
      SELECTED_OPERATION_CONFIG,
    );
    expect(original).to.have.length(14);
    expect(
      SELECTED_OPERATIONS.filter(({ localKey }) => localKey !== 'folder.items.list'),
    ).to.deep.equal(original);
    expect(SELECTED_OPERATIONS).to.have.length(15);
    const supplemental = SELECTED_OPERATIONS.find(
      ({ localKey }) => localKey === 'folder.items.list',
    );
    expect(supplemental).to.deep.equal(SUPPLEMENTAL_OPERATIONS[0]);
    expect(supplemental).to.include({
      method: 'GET',
      path: '/connect/cms/folders/{folderId}/folder-items',
      minimumApiVersion: '68.0',
      operationId: 'local:folder.items.list',
    });
    expect(supplemental).to.have.nested.property('provenance.sourceKind', 'rendered-excerpt');
    expect(supplemental).to.have.nested.property('provenance.documentedApiVersion', '68.0');
    expect(supplemental).to.have.nested.property(
      'provenance.operationIdentity',
      'local-descriptor',
    );
    expect(supplemental).to.have.nested.property(
      'provenance.sourceUrl',
      'https://developer.salesforce.com/docs/platform/connect-rest-api/references/connect-rest-api-cms',
    );
    expect(supplemental?.parameters.map(({ name }) => name)).to.not.include('queryTerm');
  });

  it('deterministically emits the checked-in mixed-source selection', async () => {
    const first = await generateSelectedOpenApi(canonicalPath);
    expect(await generateSelectedOpenApi(canonicalPath)).to.deep.equal(first);
    expect(await readFile(path.resolve('src/generated/operations.ts'), 'utf8')).to.equal(
      first.operations,
    );
  });
  it('keeps deferred delivery and excluded mutations out of the generated descriptors', async () => {
    const { operations } = await generateSelectedOpenApi(canonicalPath);
    expect(operations).to.not.include('getManagedContentDelivery');
    expect(operations).to.not.include('getManagedContentDeliveryMedia');
    expect(operations).to.include('putManagedContentVariant');
    expect(operations).to.include('postManagedContentPublish');
    expect(operations).to.include('postManagedContentUnpublish');
    expect(operations).to.not.include('responseType');
  });
});
