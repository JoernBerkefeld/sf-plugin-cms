import type { OperationDescriptor } from './generate.js';

// Operations the bundled v67 schema does not contain; described by hand (folder items and folder
// create from the v68 reference, SOQL from the REST API: the only complete content inventory, the
// Data 360 data space list, data graph read and identity resolution ruleset list for the data
// graph provider check and the cross-data-space deploy).
export const SUPPLEMENTAL_OPERATIONS: readonly OperationDescriptor[] = [
  {
    localKey: 'data-graph.get',
    method: 'GET',
    operationId: 'local:data-graph.get',
    parameters: [{ location: 'path', name: 'dataGraphName', required: true, type: 'string' }],
    path: '/ssot/data-graphs/{dataGraphName}',
    requestBodyMediaTypes: [],
    requestBodyPresent: false,
    responses: [],
  },
  {
    localKey: 'data-space.list',
    method: 'GET',
    operationId: 'local:data-space.list',
    parameters: [
      { location: 'query', name: 'batchSize', required: false, type: 'integer' },
      { location: 'query', name: 'offset', required: false, type: 'integer' },
    ],
    path: '/ssot/data-spaces',
    requestBodyMediaTypes: [],
    requestBodyPresent: false,
    responses: [],
  },
  {
    localKey: 'identity-resolution.list',
    method: 'GET',
    operationId: 'local:identity-resolution.list',
    parameters: [],
    path: '/ssot/identity-resolutions',
    requestBodyMediaTypes: [],
    requestBodyPresent: false,
    responses: [],
  },
  {
    localKey: 'folder.create',
    method: 'POST',
    operationId: 'local:folder.create',
    parameters: [],
    path: '/connect/cms/folders',
    requestBodyMediaTypes: ['application/json'],
    requestBodyPresent: true,
    responses: [],
  },
  {
    localKey: 'folder.items.list',
    method: 'GET',
    operationId: 'local:folder.items.list',
    parameters: [
      { location: 'path', name: 'folderId', required: true, type: 'string' },
      { location: 'query', name: 'includeSharedWithSpaceFolder', required: false, type: 'boolean' },
      { location: 'query', name: 'itemType', required: false, type: 'string' },
      { location: 'query', name: 'page', required: false, type: 'integer' },
      { location: 'query', name: 'pageSize', required: false, type: 'integer' },
    ],
    path: '/connect/cms/folders/{folderId}/folder-items',
    requestBodyMediaTypes: [],
    requestBodyPresent: false,
    responses: [],
  },
  {
    localKey: 'soql.query',
    method: 'GET',
    operationId: 'local:soql.query',
    parameters: [{ location: 'query', name: 'q', required: true, type: 'string' }],
    path: '/query',
    requestBodyMediaTypes: [],
    requestBodyPresent: false,
    responses: [],
  },
];

export type SelectedOperationConfig = {
  localKey: string;
  operationId: string;
};

/** Operations taken from the bundled schema, by operationId, with the plugin's local key. */
export const SELECTED_OPERATION_CONFIG: readonly SelectedOperationConfig[] = [
  { localKey: 'channel.get', operationId: 'getManagedContentChannel' },
  { localKey: 'content.create', operationId: 'postManagedContentDocumentCreate' },
  { localKey: 'content.get', operationId: 'getManagedContentDocument' },
  { localKey: 'content.publish', operationId: 'postManagedContentPublish' },
  { localKey: 'content.unpublish', operationId: 'postManagedContentUnpublish' },
  { localKey: 'folder.get', operationId: 'getManagedContentSpaceFolder' },
  { localKey: 'variant.create', operationId: 'postManagedContentVariantCreate' },
  { localKey: 'variant.delete', operationId: 'deleteManagedContentVariant' },
  { localKey: 'variant.get', operationId: 'getManagedContentVariant' },
  { localKey: 'variant.update', operationId: 'putManagedContentVariant' },
  { localKey: 'workspace.channel.list', operationId: 'getManagedContentSpaceChannels' },
  { localKey: 'workspace.get', operationId: 'getManagedContentSpace' },
  { localKey: 'workspace.list', operationId: 'getManagedContentSpaceCollection' },
  { localKey: 'workspace.variant.search', operationId: 'getManagedContentSearchItems' },
];
