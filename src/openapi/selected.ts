import type { OperationDescriptor } from './generate.js';

// Operations the bundled v67 schema does not contain; described by hand from the v68 reference.
export const SUPPLEMENTAL_OPERATIONS: readonly OperationDescriptor[] = [
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
