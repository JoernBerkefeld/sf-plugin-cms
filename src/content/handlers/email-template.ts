import { projectJsonVariant } from '../json-projection.js';
import { jsonPayloadFromSource, logicalReferences } from '../json-source.js';
import type { ContentTypeHandler } from '../types.js';
import { EMAIL_COMPANIONS } from './email.js';

/** Email Template (`sfdc_cms__emailTemplate`): JSON, same body layout as Email. */
export const emailTemplateHandler: ContentTypeHandler = {
  type: 'email-template',
  apiName: 'sfdc_cms__emailTemplate',
  transport: 'json',
  toSource: (native, context) =>
    projectJsonVariant('email-template', native, context, EMAIL_COMPANIONS),
  fromSource: (files) => jsonPayloadFromSource(files, EMAIL_COMPANIONS),
  references: (payload) => logicalReferences(payload.contentBody),
};
