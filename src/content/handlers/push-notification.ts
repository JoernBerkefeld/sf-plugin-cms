import { projectJsonVariant } from '../json-projection.js';
import { jsonPayloadFromSource, logicalReferences } from '../json-source.js';
import type { ContentTypeHandler } from '../types.js';

/**
 * Push Notification Message (`sfdc_cms__pushNotification`): JSON. The whole body (notification block with its actions, byte counters, data providers) stays in the JSON file; no companions, no app reference in the body.
 */
export const pushNotificationHandler: ContentTypeHandler = {
  type: 'push-notification',
  apiName: 'sfdc_cms__pushNotification',
  transport: 'json',
  toSource: (native, context) => projectJsonVariant('push-notification', native, context, {}),
  fromSource: (files) => jsonPayloadFromSource(files, {}),
  references: (payload) => logicalReferences(payload.contentBody),
};
