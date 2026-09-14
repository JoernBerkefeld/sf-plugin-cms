# summary

Experimentally export one or all CMS workspaces using a read-only, best-effort process.

# description

Exports one Marketing Cloud CMS workspace selected by exact ID or case-insensitive exact name, or preflights and exports all workspaces under a parent directory. Canonical fetched names and casing are preserved. Bulk preflight is global and strict; execution then continues across individual failures and returns a complete aggregate. This is not a complete or guaranteed backup and does not mutate org data.

# examples

- Export by exact workspace name to ./cms/Main Site:

  <%= config.bin %> <%= command.id %> --target-org my-org --workspace-name "Main Site"

- Export by workspace ID to an exact explicit directory:

  <%= config.bin %> <%= command.id %> --target-org my-org --workspace-id 0Zu... --output-dir ./cms-export

- Export all Marketing workspaces beneath ./cms with the v1 JSON aggregate:

  <%= config.bin %> <%= command.id %> --target-org my-org --all --workspace-type Marketing --output-dir ./cms --contract-version 1 --json

Bulk JSON uses `sf-cms-workspace-export-set@1`. Exit 0 means success, 2 means partial with a usable aggregate, and 1 means failed or blocked. Unsupported contract majors block before org access.

# flags.target-org.summary

Username or alias of the target Salesforce org.

# flags.api-version.summary

Salesforce API version used for CMS requests.

# flags.contract-version.summary

Machine contract major version (supported: 1). Unsupported majors return a blocked contract envelope before org access.

# flags.all.summary

Export every CMS workspace after a strict global preflight.

# flags.workspace-id.summary

Exact CMS workspace content-space ID.

# flags.workspace-name.summary

Exact case-insensitive CMS workspace name.

# flags.workspace-type.summary

Bulk-only workspace type filter: Marketing or Content (case-insensitive).

# flags.output-dir.summary

Single: exact new destination. Bulk: parent directory. Defaults to ./cms/<name> or ./cms.
