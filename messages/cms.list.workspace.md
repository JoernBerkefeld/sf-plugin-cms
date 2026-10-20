# summary

List Marketing Cloud CMS workspaces.

# description

Lists all CMS workspaces by default. Supply --page or --page-size to select one page.

# examples

- List workspaces:

  <%= config.bin %> <%= command.id %> --target-org my-org

# flags.target-org.summary

Username or alias of the target Salesforce org.

# flags.api-version.summary

Salesforce API version used for CMS requests.

# flags.name-fragment.summary

Return workspaces whose names contain this value.

# flags.page.summary

One-based page number (first page is 1).

# flags.page-size.summary

Maximum items requested per page.
