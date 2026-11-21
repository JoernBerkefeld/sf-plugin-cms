import { projectJsonVariant } from '../json-projection.js';
import { jsonPayloadFromSource, logicalReferences } from '../json-source.js';
import type { ContentTypeHandler } from '../types.js';

/**
 * Form Handler (`sfdc_cms__formHandler`): JSON. The body is an empty root block; the object mapping is
 * not part of the CMS item, so the plugin neither reads nor writes it.
 */
export const formHandlerHandler: ContentTypeHandler = {
  type: 'form-handler',
  apiName: 'sfdc_cms__formHandler',
  transport: 'json',
  toSource: (native, context) => projectJsonVariant('form-handler', native, context, {}),
  fromSource: (files) => jsonPayloadFromSource(files, {}),
  references: (payload) => logicalReferences(payload.contentBody),
};
