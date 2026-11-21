import { projectJsonVariant } from '../json-projection.js';
import { jsonPayloadFromSource, logicalReferences } from '../json-source.js';
import type { ContentTypeHandler } from '../types.js';

/**
 * Brand (`sfdc_cms__brand`): JSON. The whole body (typography, colors, spacing, buttons, …)
 * stays in the JSON file; there are no companion files.
 */
export const brandHandler: ContentTypeHandler = {
  type: 'brand',
  apiName: 'sfdc_cms__brand',
  transport: 'json',
  toSource: (native, context) => projectJsonVariant('brand', native, context, {}),
  fromSource: (files) => jsonPayloadFromSource(files, {}),
  references: (payload) => logicalReferences(payload.contentBody),
};
