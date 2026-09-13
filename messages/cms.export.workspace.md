# summary

Experimentally export a CMS workspace using a read-only, best-effort process.

# description

Selects one Marketing Cloud CMS workspace by exact ID or exact case-sensitive name and writes the variants observed by an experimental, best-effort search. Without --output-dir, the new destination is ./cms/<safe-workspace-name>. This is not a complete or guaranteed backup and does not mutate org data.

# examples

- Export by exact workspace name to ./cms/Main Site:

  <%= config.bin %> <%= command.id %> --target-org my-org --workspace-name "Main Site"

- Export by workspace ID to an exact explicit directory:

  <%= config.bin %> <%= command.id %> --target-org my-org --workspace-id 0Zu... --output-dir ./cms-export

# flags.target-org.summary

Username or alias of the target Salesforce org.

# flags.api-version.summary

Salesforce API version used for CMS requests.

# flags.workspace-id.summary

Exact CMS workspace content-space ID.

# flags.workspace-name.summary

Exact case-sensitive CMS workspace name.

# flags.output-dir.summary

Exact new destination directory; defaults to ./cms/<safe-workspace-name>.
