import { projectJsonVariant } from '../json-projection.js';
import { jsonPayloadFromSource, logicalReferences } from '../json-source.js';
import type { ContentTypeHandler } from '../types.js';

/**
 * Expression (`sfdc_cms__expression`): JSON. The expression groups and the data graph provider
 * stay in the JSON file; the provider names a data graph without `dataspace`, which deploy checks
 * by name in the `default` data space.
 */
export const expressionHandler: ContentTypeHandler = {
  type: 'expression',
  apiName: 'sfdc_cms__expression',
  transport: 'json',
  toSource: (native, context) => projectJsonVariant('expression', native, context, {}),
  fromSource: (files) => jsonPayloadFromSource(files, {}),
  references: (payload) => logicalReferences(payload.contentBody),
};
