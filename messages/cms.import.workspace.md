# summary

Safely plan or apply a create-only import into a CMS workspace.

# description

Validates the source workspace export locally before any org request, selects one destination workspace by exact ID or exact case-sensitive name, checks every content key for conflicts, and defaults to a non-mutating dry run. Pass --apply with a new --report-dir to create content.

# examples

- Validate a source export and preflight an exact destination workspace name:

  <%= config.bin %> <%= command.id %> --target-org my-org --workspace-name "Destination" --source-dir ./cms/Source

- Apply to an exact destination workspace ID and write a durable run report:

  <%= config.bin %> <%= command.id %> --target-org my-org --workspace-id 0Zu... --source-dir ./cms/Source --apply --report-dir ./cms-import-report

# flags.target-org.summary

Username or alias of the target Salesforce org.

# flags.api-version.summary

Salesforce API version used for CMS requests.

# flags.workspace-id.summary

Exact destination CMS workspace ID.

# flags.workspace-name.summary

Exact case-sensitive destination CMS workspace name.

# flags.source-dir.summary

Source workspace export containing manifest.json and items/.

# flags.apply.summary

Create the planned content after all validation and conflict checks pass.

# flags.allow-partial.summary

Accept an export whose manifest records omissions or incomplete coverage.

# flags.report-dir.summary

New directory for the durable applied-import run report.
