import { projectJsonVariant } from '../json-projection.js';
import { jsonPayloadFromSource, logicalReferences } from '../json-source.js';
import type { ContentTypeHandler } from '../types.js';

/**
 * Landing Page (`sfdc_cms__landingPage`): JSON. Like its template, plus `sfdc_cms:template.definition`
 * (the template's bare content key), which the file holds as `{ type, apiName, format }`.
 */
export const landingPageHandler: ContentTypeHandler = {
  type: 'landing-page',
  apiName: 'sfdc_cms__landingPage',
  transport: 'json',
  toSource: (native, context) => projectJsonVariant('landing-page', native, context, {}),
  fromSource: (files) => jsonPayloadFromSource(files, {}),
  references: (payload) => logicalReferences(payload.contentBody),
};
