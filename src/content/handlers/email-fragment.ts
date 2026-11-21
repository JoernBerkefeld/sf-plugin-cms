import { projectJsonVariant } from '../json-projection.js';
import { jsonPayloadFromSource, logicalReferences } from '../json-source.js';
import type { ContentTypeHandler } from '../types.js';

/**
 * Email Fragment (`sfdc_cms__emailFragment`): JSON. The whole authored body (block tree with its
 * block IDs and order, data providers, brand source) stays in the JSON file; references to other
 * components are `{ type, apiName }`, data graph providers keep `dataGraphApiName` / `dataspace`.
 */
export const emailFragmentHandler: ContentTypeHandler = {
  type: 'email-fragment',
  apiName: 'sfdc_cms__emailFragment',
  transport: 'json',
  toSource: (native, context) => projectJsonVariant('email-fragment', native, context, {}),
  fromSource: (files) => jsonPayloadFromSource(files, {}),
  references: (payload) => logicalReferences(payload.contentBody),
};
