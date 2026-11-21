import { projectJsonVariant } from '../json-projection.js';
import type { ContentTypeHandler } from '../types.js';
import { EMAIL_COMPANIONS } from './email.js';

/** Email Template (`sfdc_cms__emailTemplate`): JSON, same body layout as Email. */
export const emailTemplateHandler: ContentTypeHandler = {
  type: 'email-template',
  apiName: 'sfdc_cms__emailTemplate',
  transport: 'json',
  toSource: (native, context) =>
    projectJsonVariant('email-template', native, context, EMAIL_COMPANIONS),
};
