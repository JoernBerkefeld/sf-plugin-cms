# summary

Safely plan or apply a create-only import into a CMS workspace.

# description

Validates an exported workspace package locally, checks every content key for destination conflicts, and defaults to a non-mutating dry run. Pass --apply with a new --report-dir to create content.

# examples

- Validate and preflight an import without creating content:

  <%= config.bin %> <%= command.id %> --target-org my-org --workspace-id 0Zu... --source-dir ./cms-export

- Apply a conflict-free plan and write a durable run report:

  <%= config.bin %> <%= command.id %> --target-org my-org --workspace-id 0Zu... --source-dir ./cms-export --apply --report-dir ./cms-import-report

# flags.target-org.summary

Username or alias of the target Salesforce org.

# flags.api-version.summary

Salesforce API version used for CMS requests.

# flags.workspace-id.summary

Destination CMS workspace ID.

# flags.source-dir.summary

Workspace export directory containing manifest.json and items/.

# flags.apply.summary

Create the planned content after all validation and conflict checks pass.

# flags.allow-partial.summary

Accept an export whose manifest records omissions or incomplete coverage.

# flags.report-dir.summary

New directory for the durable applied-import run report.
