import type { OperationDescriptor } from './generate.js';

// Local descriptor identity: the rendered excerpt does not expose an upstream operationId.
// This is a narrow supplement, not a replacement for the complete bundled v67 schema.
export const SUPPLEMENTAL_OPERATIONS: readonly OperationDescriptor[] = [
  {
    localKey: 'folder.items.list',
    method: 'GET',
    operationId: 'local:folder.items.list',
    minimumApiVersion: '68.0',
    provenance: {
      sourceUrl:
        'https://developer.salesforce.com/docs/platform/connect-rest-api/references/connect-rest-api-cms',
      documentedApiVersion: '68.0',
      sourceKind: 'rendered-excerpt',
      operationIdentity: 'local-descriptor',
    },
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
    // The excerpt names the response collection but does not expose a status/media schema.
    responses: [],
  },
];

export type SelectedOperationConfig = {
  localKey: string;
  operationId: string;
};

export const SELECTED_OPERATION_CONFIG: readonly SelectedOperationConfig[] = [
  {
    localKey: 'channel.get',
    operationId: 'getManagedContentChannel',
  },
  {
    localKey: 'content.create',
    operationId: 'postManagedContentDocumentCreate',
  },
  {
    localKey: 'content.get',
    operationId: 'getManagedContentDocument',
  },
  {
    localKey: 'content.publish',
    operationId: 'postManagedContentPublish',
  },
  {
    localKey: 'content.unpublish',
    operationId: 'postManagedContentUnpublish',
  },
  {
    localKey: 'folder.get',
    operationId: 'getManagedContentSpaceFolder',
  },
  {
    localKey: 'variant.create',
    operationId: 'postManagedContentVariantCreate',
  },
  {
    localKey: 'variant.delete',
    operationId: 'deleteManagedContentVariant',
  },
  {
    localKey: 'variant.get',
    operationId: 'getManagedContentVariant',
  },
  {
    localKey: 'variant.update',
    operationId: 'putManagedContentVariant',
  },
  {
    localKey: 'workspace.channel.list',
    operationId: 'getManagedContentSpaceChannels',
  },
  {
    localKey: 'workspace.get',
    operationId: 'getManagedContentSpace',
  },
  {
    localKey: 'workspace.list',
    operationId: 'getManagedContentSpaceCollection',
  },
  {
    localKey: 'workspace.variant.search',
    operationId: 'getManagedContentSearchItems',
  },
];

export const DEFERRED_STAGE_1_CAPABILITIES = {
  'content.list': 'No bounded unfiltered enhanced-workspace content enumeration is evidenced.',
  'delivery.get':
    'Delivery is not clearly required for the Stage 1 workspace, channel, content, and variant read slice.',
  'delivery.media.get': 'Media delivery is not clearly required for the Stage 1 read slice.',
  'variant.list': 'No independent or stable embedded variant collection is evidenced.',
} as const;
