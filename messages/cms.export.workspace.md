# summary

Experimentally export a CMS workspace using a read-only, best-effort process.

# description

Reads a Marketing Cloud CMS workspace and writes the variants observed by an experimental, best-effort search. This is not a complete or guaranteed backup and does not mutate org data.

# examples

- Export the variants observed for one workspace into a new directory:

  <%= config.bin %> <%= command.id %> --target-org my-org --workspace-id 0Zu... --output-dir ./cms-export

# flags.target-org.summary

Username or alias of the target Salesforce org.

# flags.api-version.summary

Salesforce API version used for CMS requests.

# flags.workspace-id.summary

CMS workspace content-space ID.

# flags.output-dir.summary

New directory to receive the experimental best-effort export.
