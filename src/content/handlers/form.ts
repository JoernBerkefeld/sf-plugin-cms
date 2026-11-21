import { projectJsonVariant } from '../json-projection.js';
import { jsonPayloadFromSource, logicalReferences } from '../json-source.js';
import type { ContentTypeHandler } from '../types.js';
import { DATA_SOURCE_DECLARATIONS } from './form-handler.js';

/**
 * Form (`sfdc_cms__form`): JSON. Block tree with the fields and submit button plus
 * `formsubmission.actions` (runtime placeholders such as `{!$form.id}` stay as text). Data
 * sources keep their RecordType by name, as in the Form Handler.
 */
export const formHandler: ContentTypeHandler = {
  type: 'form',
  apiName: 'sfdc_cms__form',
  transport: 'json',
  referenceDeclarations: DATA_SOURCE_DECLARATIONS,
  toSource: (native, context) =>
    projectJsonVariant('form', native, context, {}, DATA_SOURCE_DECLARATIONS),
  fromSource: (files) => jsonPayloadFromSource(files, {}),
  references: (payload) => logicalReferences(payload.contentBody),
};
