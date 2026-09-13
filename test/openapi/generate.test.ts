import path from 'node:path';
import { expect } from 'chai';
import {
  buildSelectedOperationDescriptors,
  generateSelectedOpenApi,
} from '../../src/openapi/generate.js';
import { intakeOpenApi, OpenApiIntakeError } from '../../src/openapi/intake.js';

const canonicalPath = path.resolve('resources', 'openapi', 'connect-rest-api-cms-v67.yaml');

describe('selected OpenAPI generation', () => {
  it('emits byte-identical results on repeated generation', async () => {
    const first = await generateSelectedOpenApi(canonicalPath);
    const second = await generateSelectedOpenApi(canonicalPath);
    expect(second).to.deep.equal(first);
  });

  it('maps exactly the unambiguous Stage 1 read operations', async () => {
    const { document } = await intakeOpenApi(canonicalPath);
    const descriptors = buildSelectedOperationDescriptors(document as Record<string, unknown>, [
      { localKey: 'workspace.list', operationId: 'getManagedContentSpaceCollection' },
      { localKey: 'workspace.get', operationId: 'getManagedContentSpace' },
      { localKey: 'workspace.channel.list', operationId: 'getManagedContentSpaceChannels' },
      { localKey: 'channel.get', operationId: 'getManagedContentChannel' },
      { localKey: 'content.get', operationId: 'getManagedContentDocument' },
      { localKey: 'variant.get', operationId: 'getManagedContentVariant' },
      { localKey: 'workspace.variant.search', operationId: 'getManagedContentSearchItems' },
    ]);

    expect(
      descriptors.map(({ localKey, operationId, method, path: operationPath }) => ({
        localKey,
        method,
        operationId,
        path: operationPath,
      })),
    ).to.deep.equal([
      {
        localKey: 'channel.get',
        method: 'GET',
        operationId: 'getManagedContentChannel',
        path: '/connect/cms/channels/{channelId}',
      },
      {
        localKey: 'content.get',
        method: 'GET',
        operationId: 'getManagedContentDocument',
        path: '/connect/cms/contents/{contentKeyOrId}',
      },
      {
        localKey: 'variant.get',
        method: 'GET',
        operationId: 'getManagedContentVariant',
        path: '/connect/cms/contents/variants/{variantId}',
      },
      {
        localKey: 'workspace.channel.list',
        method: 'GET',
        operationId: 'getManagedContentSpaceChannels',
        path: '/connect/cms/spaces/{contentSpaceId}/channels',
      },
      {
        localKey: 'workspace.get',
        method: 'GET',
        operationId: 'getManagedContentSpace',
        path: '/connect/cms/spaces/{contentSpaceId}',
      },
      {
        localKey: 'workspace.list',
        method: 'GET',
        operationId: 'getManagedContentSpaceCollection',
        path: '/connect/cms/spaces',
      },
      {
        localKey: 'workspace.variant.search',
        method: 'GET',
        operationId: 'getManagedContentSearchItems',
        path: '/connect/cms/items/search',
      },
    ]);

    expect(descriptors.every(({ requestBodyPresent }) => !requestBodyPresent)).to.equal(true);
    expect(
      descriptors.every(({ responses }) =>
        responses.some(
          ({ mediaTypes, status }) => status === '200' && mediaTypes.includes('application/json'),
        ),
      ),
    ).to.equal(true);
    expect(descriptors.find(({ localKey }) => localKey === 'workspace.channel.list')?.parameters)
      .to.deep.include({ location: 'path', name: 'contentSpaceId', required: true, type: 'string' })
      .and.deep.include({ location: 'query', name: 'pageSize', required: false, type: 'integer' });
    expect(descriptors.find(({ localKey }) => localKey === 'workspace.variant.search')?.parameters)
      .to.deep.include({
        location: 'query',
        name: 'contentSpaceOrFolderIds',
        required: true,
        type: 'string-array',
      })
      .and.deep.include({
        location: 'query',
        name: 'languages',
        required: false,
        type: 'string-array',
      })
      .and.deep.include({ location: 'query', name: 'scope', required: false, type: 'string' });
  });

  it('rejects unsupported array item types', () => {
    const document = {
      components: { schemas: {} },
      paths: {
        '/example': {
          get: {
            operationId: 'getExample',
            parameters: [
              {
                in: 'query',
                name: 'values',
                schema: { items: { type: 'integer' }, type: 'array' },
              },
            ],
            responses: { 200: { content: { 'application/json': {} } } },
          },
        },
      },
    };
    expect(() =>
      buildSelectedOperationDescriptors(document, [
        { localKey: 'example.get', operationId: 'getExample' },
      ]),
    ).to.throw(OpenApiIntakeError, 'unsupported selected parameter type: array');
  });

  it('rejects unknown and duplicate selections', async () => {
    const { document } = await intakeOpenApi(canonicalPath);
    const recordDocument = document as Record<string, unknown>;
    expect(() =>
      buildSelectedOperationDescriptors(recordDocument, [
        { localKey: 'unknown.get', operationId: 'notAnOperation' },
      ]),
    ).to.throw(OpenApiIntakeError, 'selected operation missing: notAnOperation');
    expect(() =>
      buildSelectedOperationDescriptors(recordDocument, [
        { localKey: 'same', operationId: 'getManagedContentSpace' },
        { localKey: 'same', operationId: 'getManagedContentChannel' },
      ]),
    ).to.throw(OpenApiIntakeError, 'duplicate selected operation local key: same');
    expect(() =>
      buildSelectedOperationDescriptors(recordDocument, [
        { localKey: 'workspace.first', operationId: 'getManagedContentSpace' },
        { localKey: 'workspace.second', operationId: 'getManagedContentSpace' },
      ]),
    ).to.throw(OpenApiIntakeError, 'duplicate selected operationId: getManagedContentSpace');
  });

  it('keeps deferred delivery and excluded mutations out of the generated descriptors', async () => {
    const { operations } = await generateSelectedOpenApi(canonicalPath);
    expect(operations).to.not.include('getManagedContentDelivery');
    expect(operations).to.not.include('getManagedContentDeliveryMedia');
    expect(operations).to.not.include('putManagedContentVariant');
    expect(operations).to.not.include('postManagedContentDocumentPublish');
    expect(operations).to.not.include('postManagedContentDocumentUnpublish');
    expect(operations).to.not.include('responseType');
  });
});
