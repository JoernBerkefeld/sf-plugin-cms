import { projectJsonVariant } from '../json-projection.js';
import { jsonPayloadFromSource, logicalReferences } from '../json-source.js';
import type { ContentTypeHandler } from '../types.js';

/**
 * Content Block: Landing Page (`sfdc_cms__webFragment`): JSON. The block tree (block IDs and order), data
 * providers and brand source stay in one JSON file; image references are `{ type, apiName }`.
 */
export const webFragmentHandler: ContentTypeHandler = {
  type: 'web-fragment',
  apiName: 'sfdc_cms__webFragment',
  transport: 'json',
  toSource: (native, context) => projectJsonVariant('web-fragment', native, context, {}),
  fromSource: (files) => jsonPayloadFromSource(files, {}),
  references: (payload) => logicalReferences(payload.contentBody),
};
