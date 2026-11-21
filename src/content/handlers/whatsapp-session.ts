import { projectJsonVariant } from '../json-projection.js';
import { jsonPayloadFromSource, logicalReferences } from '../json-source.js';
import type { ContentTypeHandler } from '../types.js';

/**
 * WhatsApp Session Message (`sfdc_cms__whatsappSession`): JSON. The whole body (content block, message type, data providers) stays in the JSON file; no companions, no WhatsApp account in the body.
 */
export const whatsappSessionHandler: ContentTypeHandler = {
  type: 'whatsapp-session',
  apiName: 'sfdc_cms__whatsappSession',
  transport: 'json',
  toSource: (native, context) => projectJsonVariant('whatsapp-session', native, context, {}),
  fromSource: (files) => jsonPayloadFromSource(files, {}),
  references: (payload) => logicalReferences(payload.contentBody),
};
