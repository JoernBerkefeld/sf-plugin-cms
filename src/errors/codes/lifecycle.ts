/** CLI hints for delete, publish and unpublish codes. */
export const hints: Readonly<Record<string, string>> = {
  EXACT_SELECTOR_REQUIRED:
    'Delete, publish and unpublish take exact components only: -m type:ApiName or --source-dir with a component file. A bare type, a wildcard or a folder is refused. Name each component, then rerun.',
  HAS_OTHER_VARIANTS:
    'The component has variants besides the default one, and deleting it would delete them too. Remove the other variants in the CMS workspace first, then rerun.',
  LIFECYCLE_BLOCKED:
    'Another component of this run was blocked, so nothing was sent. Fix the blocked component, then rerun.',
  DELETE_NOT_CONFIRMED:
    'Salesforce still returns the component after the delete. Check it in the CMS workspace before running the delete again.',
  DELETE_ANSWER_IGNORED:
    'Salesforce answered the delete with an error, but reading the component back shows it is gone, so it counts as deleted.',
  STATE_NOT_CONFIRMED:
    'Salesforce accepted the request, but reading the component back does not show the expected publish state yet. Check it in the CMS workspace.',
  LOCAL_FILE_REMOVAL_FAILED:
    'The component was deleted in the org, but a local file could not be removed. Remove the file named in the message by hand; do not repeat the delete.',
};
