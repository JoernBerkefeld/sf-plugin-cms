import { projectJsonVariant } from '../json-projection.js';
import { jsonPayloadFromSource, logicalReferences } from '../json-source.js';
import type { ContentTypeHandler } from '../types.js';

/**
 * Form (`sfdc_cms__form`): JSON. Block tree with the fields and submit button plus
 * `formsubmission.actions` (runtime placeholders such as `{!$form.id}` stay as text).
 */
export const formHandler: ContentTypeHandler = {
  type: 'form',
  apiName: 'sfdc_cms__form',
  transport: 'json',
  toSource: (native, context) => projectJsonVariant('form', native, context, {}),
  fromSource: (files) => jsonPayloadFromSource(files, {}),
  references: (payload) => logicalReferences(payload.contentBody),
};
