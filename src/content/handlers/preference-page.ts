import { projectJsonVariant } from '../json-projection.js';
import { jsonPayloadFromSource, logicalReferences } from '../json-source.js';
import type { ContentTypeHandler } from '../types.js';

/**
 * Preference Page (`sfdc_cms__preferencePage`): JSON. Whole body in one JSON file, like the other
 * block types; image and `@cms/` references are logical values.
 */
export const preferencePageHandler: ContentTypeHandler = {
  type: 'preference-page',
  apiName: 'sfdc_cms__preferencePage',
  transport: 'json',
  toSource: (native, context) => projectJsonVariant('preference-page', native, context, {}),
  fromSource: (files) => jsonPayloadFromSource(files, {}),
  references: (payload) => logicalReferences(payload.contentBody),
};
