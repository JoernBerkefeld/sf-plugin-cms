import { projectJsonVariant } from '../json-projection.js';
import { jsonPayloadFromSource, logicalReferences } from '../json-source.js';
import type { ContentTypeHandler } from '../types.js';

/** Publish note of landing pages and their templates. */
export const PUBLIC_URL_NOTE = 'Publishing makes a public URL live; unpublish takes it offline.';

/**
 * Landing Page Template (`sfdc_cms__landingPageTemplate`): JSON. The block tree, SEO properties and data
 * providers stay in one JSON file; images are `{ type, apiName }`, embedded web fragments
 * (`@cms/<key>`) are `{ type, apiName, format }`.
 */
export const landingPageTemplateHandler: ContentTypeHandler = {
  type: 'landing-page-template',
  apiName: 'sfdc_cms__landingPageTemplate',
  transport: 'json',
  publishNote: PUBLIC_URL_NOTE,
  toSource: (native, context) => projectJsonVariant('landing-page-template', native, context, {}),
  fromSource: (files) => jsonPayloadFromSource(files, {}),
  references: (payload) => logicalReferences(payload.contentBody),
};
