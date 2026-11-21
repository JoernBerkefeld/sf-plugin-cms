import { projectJsonVariant } from '../json-projection.js';
import { jsonPayloadFromSource, logicalReferences } from '../json-source.js';
import type { ContentTypeHandler, ReferenceDeclarations } from '../types.js';

/**
 * A "Salesforce Record" data source (`lightning:dataProviders[]`, `sfdc_cms__recordDataProvider`)
 * holds the org's RecordType ID; the file keeps the RecordType by SobjectType and DeveloperName.
 * Shared by Form and Form Handler.
 */
export const DATA_SOURCE_DECLARATIONS: ReferenceDeclarations = {
  records: [
    {
      path: ['lightning:dataProviders', '*', 'attributes', 'recordTypeId'],
      sobject: 'RecordType',
      fields: { sobjectType: 'SobjectType', developerName: 'DeveloperName' },
    },
  ],
};

/**
 * Form Handler (`sfdc_cms__formHandler`): JSON. The body is a root block with the field mappings
 * and the data sources; the flow is not part of the CMS item, so the plugin neither reads nor
 * writes it.
 */
export const formHandlerHandler: ContentTypeHandler = {
  type: 'form-handler',
  apiName: 'sfdc_cms__formHandler',
  transport: 'json',
  referenceDeclarations: DATA_SOURCE_DECLARATIONS,
  toSource: (native, context) =>
    projectJsonVariant('form-handler', native, context, {}, DATA_SOURCE_DECLARATIONS),
  fromSource: (files) => jsonPayloadFromSource(files, {}),
  references: (payload) => logicalReferences(payload.contentBody),
};
