/** CLI hints for workspace and channel error codes. */
export const hints: Readonly<Record<string, string>> = {
  WORKSPACE_NOT_FOUND:
    'No CMS workspace with that API name or ID is visible to this user. Run sf cms list workspace to see the API names and IDs, then rerun with one of them.',
  WORKSPACE_AMBIGUOUS:
    'More than one workspace matches that value. Pass the workspace ID (0Zu...) instead, as shown by sf cms list workspace.',
};
