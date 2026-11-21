/** CLI hints for general error codes. */
export const hints: Readonly<Record<string, string>> = {
  AUTHENTICATION_FAILED:
    'Salesforce rejected the session or the org could not be loaded. Check the org with sf org display, log in again with sf org login web if needed, then rerun.',
  INVALID_API_VERSION:
    '--api-version must be a numeric version such as 68.0. Pass a version the org supports, then rerun.',
  REQUEST_FAILED:
    'Salesforce rejected or did not complete a request. Read the HTTP status, Salesforce error code and request ID in the message, fix the cause such as permissions or limits, then rerun.',
  TARGET_ORG_REQUIRED:
    'No usable target org was found. Pass --target-org <alias or username>, or set a default with sf config set target-org, then rerun.',
  UNEXPECTED_RESPONSE:
    'Salesforce answered with a shape the plugin does not read. Rerun with --api log and report the log file named on stderr.',
};
