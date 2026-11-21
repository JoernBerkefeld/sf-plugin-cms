/** CLI hints for deploy error and warning codes. */
export const hints: Readonly<Record<string, string>> = {
  UNKNOWN_SETTING:
    'The source file has a field or companion file this type does not have. Remove or rename the setting named in the message, then rerun.',
  SOURCE_NOT_FOUND:
    'No local file matches the -m value or --source-dir path. Check the name (case-sensitive) and that the file is under cms/<workspace>/<type>/, then rerun.',
  SOURCE_AMBIGUOUS:
    'The same component exists in more than one workspace folder under cms/. Pick one with --source-dir, then rerun.',
  INVALID_SOURCE_PATH:
    'A --source-dir path must be a cms/ folder, a folder below it, or a component file cms/<workspace>/<type>/<ApiName>.<type>.json (or one of its companions).',
  REFERENCE_NOT_IN_DESTINATION:
    'The component references another component that the destination workspace does not have and this deploy does not create. Deploy that component first or add it to this deploy, then rerun.',
  DATA_SPACE_NOT_IN_DESTINATION:
    'A data graph provider of the component names a data space the destination org does not have. Create the data space there (or change the provider), then rerun.',
  DATA_GRAPH_NOT_IN_DESTINATION:
    'A data graph provider of the component names a data graph the destination data space does not have. Deploy the data graph there first (for example with sf-plugin-data), then rerun.',
  FOLDER_AMBIGUOUS:
    'Several folders in the destination have that name at the same level, so the plugin cannot tell which one to use. Rename one of them in the workspace, then rerun.',
  FOLDER_NOT_MOVED:
    'Deploy does not move existing components between folders; the component stays in the folder named in the message.',
  READBACK_DIFFERS:
    'Salesforce stored the component differently from the file in the fields named in the message. Retrieve it to see what was stored.',
  DEPLOY_BLOCKED:
    'Another component of this deploy was blocked, so nothing was written. Fix the blocked component, then rerun.',
  NOT_ATTEMPTED:
    'An earlier component failed or its outcome is unknown, so this one was not written. Fix the earlier problem, then rerun.',
  UNKNOWN_OUTCOME:
    'The request was sent but no answer came back, so the plugin cannot tell whether Salesforce applied it. Check the component in the org (sf cms retrieve) before running the command again; the plugin never repeats such a request.',
};
