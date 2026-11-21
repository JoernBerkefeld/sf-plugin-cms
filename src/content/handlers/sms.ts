import { projectJsonVariant } from '../json-projection.js';
import { jsonPayloadFromSource, logicalReferences } from '../json-source.js';
import type { ContentTypeHandler } from '../types.js';

/**
 * SMS and MMS (`sfdc_cms__sms`): JSON. The whole body (message text, purpose, MMS and URL shortening switches, data providers) stays in the JSON file; no companions, no sender or channel in the body.
 */
export const smsHandler: ContentTypeHandler = {
  type: 'sms',
  apiName: 'sfdc_cms__sms',
  transport: 'json',
  toSource: (native, context) => projectJsonVariant('sms', native, context, {}),
  fromSource: (files) => jsonPayloadFromSource(files, {}),
  references: (payload) => logicalReferences(payload.contentBody),
};
