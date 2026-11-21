import { projectJsonVariant } from '../json-projection.js';
import { jsonPayloadFromSource, logicalReferences } from '../json-source.js';
import type { ContentTypeHandler } from '../types.js';

/**
 * RCS Message (`sfdc_cms__rcs`): JSON. The whole body (RCS block with message and quick replies, purpose, data providers) stays in the JSON file; no companions, no sender in the body.
 */
export const rcsHandler: ContentTypeHandler = {
  type: 'rcs',
  apiName: 'sfdc_cms__rcs',
  transport: 'json',
  toSource: (native, context) => projectJsonVariant('rcs', native, context, {}),
  fromSource: (files) => jsonPayloadFromSource(files, {}),
  references: (payload) => logicalReferences(payload.contentBody),
};
