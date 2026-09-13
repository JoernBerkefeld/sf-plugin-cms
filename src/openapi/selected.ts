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
