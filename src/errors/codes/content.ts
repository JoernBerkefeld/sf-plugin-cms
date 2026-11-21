/** CLI hints for content selection, retrieve and source-file error codes. */
export const hints: Readonly<Record<string, string>> = {
  UNKNOWN_TYPE:
    'The -m value names a type the plugin does not handle. Use one of the types listed in the error message, as type or type:ApiName, then rerun.',
  INVALID_SELECTOR:
    'A -m value must be type or type:ApiName, such as email or email:Welcome_Email. Fix the value, then rerun.',
  COMPONENT_NOT_FOUND:
    'No component of that type and API name exists in the workspace. Check the API name (case-sensitive) and --workspace, then rerun.',
  NO_DEFAULT_VARIANT:
    'The component has no primary variant and none in the workspace default language, so the plugin cannot tell which one to write. Check the component in the CMS workspace.',
  OTHER_VARIANTS_SKIPPED:
    'Only the default variant is retrieved, deployed, published or unpublished; the other variants named in the message stay as they are in the org.',
  REFERENCE_UNRESOLVED:
    'The body references a content key that is not a component of this workspace; it was kept as the native content key. A deploy into another workspace cannot resolve it.',
  RECORD_REFERENCE_UNRESOLVED:
    'The body holds a Salesforce record ID (such as a Campaign or a record type) that was not found in the org; it was kept as the ID. A deploy into another org cannot resolve it.',
  INVALID_FILE_NAME:
    'The API name cannot be used as a file name. Rename the component in the CMS workspace to letters, digits, underscores or hyphens, then rerun.',
  MEDIA_FILE_MISSING:
    'A media component needs its file next to the JSON, named <ApiName>.<type>.<file name>. Add the file (or retrieve the component again), then rerun.',
  MEDIA_DOWNLOAD_FAILED:
    'The file of a media component could not be downloaded from Salesforce, or it did not match its size, MIME type or hash. The message names the reason; rerun, or check the component in the CMS workspace.',
  INVALID_SOURCE_FILE:
    'A local source file is not a valid component file. Fix or remove the file named in the message, then rerun.',
};
