import { projectJsonVariant } from '../json-projection.js';
import { jsonPayloadFromSource, logicalReferences } from '../json-source.js';
import type { ContentTypeHandler } from '../types.js';

/**
 * Consent Banner (`sfdc_cms__consentBanner`): JSON. Block tree with the accept/reject buttons and the
 * banner layout keys (color scheme, alignment, padding, width) in one JSON file.
 */
export const consentBannerHandler: ContentTypeHandler = {
  type: 'consent-banner',
  apiName: 'sfdc_cms__consentBanner',
  transport: 'json',
  toSource: (native, context) => projectJsonVariant('consent-banner', native, context, {}),
  fromSource: (files) => jsonPayloadFromSource(files, {}),
  references: (payload) => logicalReferences(payload.contentBody),
};
