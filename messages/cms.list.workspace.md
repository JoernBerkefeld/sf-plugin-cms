# summary

List Marketing Cloud CMS workspaces.
# description

Lists one bounded page of CMS workspaces through the authenticated Salesforce connection.

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

Zero-based page number.

# flags.page-size.summary

Maximum items requested per page.
