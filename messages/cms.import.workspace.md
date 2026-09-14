# summary

Safely plan or apply a create-only import into a CMS workspace.

# description

Validates the source workspace export locally before any org request, selects one destination workspace by exact ID or exact case-sensitive name, checks every content key for conflicts, and defaults to a non-mutating dry run. Pass --apply with a new --report-dir to create content.

# examples

- Validate a source export and preflight an exact destination workspace name:

  <%= config.bin %> <%= command.id %> --target-org my-org --workspace-name "Destination" --source-dir ./cms/Source

- Apply to an exact destination workspace ID, select result major 1, and write a durable run report:

  <%= config.bin %> <%= command.id %> --target-org my-org --workspace-id 0Zu... --source-dir ./cms/Source --apply --report-dir ./cms-import-report --contract-version 1 --json

JSON uses `sf-cms-workspace-import@1`. Package integrity and the independently declared manifest major are validated before org access. Exit 0 means success, 2 means partial with a usable result, and 1 means failed or blocked.

# flags.target-org.summary

Username or alias of the target Salesforce org.

# flags.contract-version.summary

Machine contract major version (supported: 1). Unsupported majors return a blocked contract envelope before package or org access.

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
