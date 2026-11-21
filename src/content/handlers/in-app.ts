import { projectJsonVariant } from '../json-projection.js';
import { jsonPayloadFromSource, logicalReferences } from '../json-source.js';
import type { ContentTypeHandler } from '../types.js';

/**
 * In-App Message (`sfdc_cms__inApp`): JSON. The whole body (in-app block tree with title, message, media, buttons and container style) stays in the JSON file; the media image is a `{ type, apiName }` reference.
 */
export const inAppHandler: ContentTypeHandler = {
  type: 'in-app',
  apiName: 'sfdc_cms__inApp',
  transport: 'json',
  toSource: (native, context) => projectJsonVariant('in-app', native, context, {}),
  fromSource: (files) => jsonPayloadFromSource(files, {}),
  references: (payload) => logicalReferences(payload.contentBody),
};
