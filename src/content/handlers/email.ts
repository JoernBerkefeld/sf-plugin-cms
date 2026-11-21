import { projectJsonVariant } from '../json-projection.js';
import { jsonPayloadFromSource, logicalReferences } from '../json-source.js';
import type { ContentTypeHandler } from '../types.js';

/** Body fields of email types that are written as their own files. */
export const EMAIL_COMPANIONS = { rawHtml: '.html', textContent: '.txt' } as const;

/**
 * Email (`sfdc_cms__email`): JSON. A code email keeps its HTML and plain text next to the JSON;
 * a block email keeps its `sfdc_cms:block` tree in the JSON body.
 */
export const emailHandler: ContentTypeHandler = {
  type: 'email',
  apiName: 'sfdc_cms__email',
  transport: 'json',
  toSource: (native, context) => projectJsonVariant('email', native, context, EMAIL_COMPANIONS),
  fromSource: (files) => jsonPayloadFromSource(files, EMAIL_COMPANIONS),
  references: (payload) => logicalReferences(payload.contentBody),
};
