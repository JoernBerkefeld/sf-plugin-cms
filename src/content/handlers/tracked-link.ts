import { projectJsonVariant } from '../json-projection.js';
import { jsonPayloadFromSource, logicalReferences } from '../json-source.js';
import type { ContentTypeHandler, ReferenceDeclarations, SourceFiles } from '../types.js';

/** `campaign` holds a Campaign record ID; the file keeps the Campaign by name. */
const DECLARATIONS: ReferenceDeclarations = {
  records: [{ path: ['campaign'], sobject: 'Campaign' }],
};

/**
 * Body fields Salesforce adds on publish (the short link and its expiry). A create drops them, so
 * they are not kept in the file.
 */
export const TRACKED_LINK_GENERATED_FIELDS: readonly string[] = [
  'expiryTime',
  'rewrittenUrl',
  'sequenceId',
];

/**
 * Tracked Link (`sfdc_cms__trackedLink`): JSON `{ campaign, destinationUrl, utmSource }`. The
 * Campaign is written as `{ sobject, name }` and looked up by name in the destination on deploy.
 */
export const trackedLinkHandler: ContentTypeHandler = {
  type: 'tracked-link',
  apiName: 'sfdc_cms__trackedLink',
  transport: 'json',
  referenceDeclarations: DECLARATIONS,
  toSource(native, context): SourceFiles {
    const files = projectJsonVariant('tracked-link', native, context, {}, DECLARATIONS);
    for (const field of TRACKED_LINK_GENERATED_FIELDS) delete files.document.contentBody[field];
    return files;
  },
  fromSource: (files) => jsonPayloadFromSource(files, {}),
  references: (payload) => logicalReferences(payload.contentBody),
};
