# summary

List channels assigned to a CMS workspace.

# description

Lists all channels for an explicit workspace by default. Supply --page or --page-size to select one page.

# examples

- List workspace channels:

  <%= config.bin %> <%= command.id %> --target-org my-org --workspace-id 0Zu...

# flags.target-org.summary

Username or alias of the target Salesforce org.

# flags.api-version.summary

Salesforce API version used for CMS requests.

# flags.workspace-id.summary

CMS workspace content-space ID.

# flags.page.summary

One-based page number (first page is 1).

# flags.page-size.summary

Maximum items requested per page.
