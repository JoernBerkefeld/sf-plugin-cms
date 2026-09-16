# summary

Experimentally export one or all CMS workspaces using a read-only, best-effort process.

# description

Exports one Marketing Cloud CMS workspace selected by exact ID or case-insensitive exact name, or preflights and exports all workspaces under a parent directory. Canonical fetched names and casing are preserved. Bulk preflight is global and strict; execution then continues across individual failures and returns a complete aggregate. For a single workspace, --editable-dir can also create a companion containing literal HTML for eligible native email/template variants. The companion is not a backup or standalone import package, and eligibility does not prove that embedded HTML is dependency-free or safe. Embedded HTML is not resolved, rewritten, sanitized, or scanned through Phase 7. This command does not mutate org data.

# examples

- Export by exact workspace name to ./cms/Main Site:

  <%= config.bin %> <%= command.id %> --target-org my-org --workspace-name "Main Site"

- Export by workspace ID to an exact explicit directory:

  <%= config.bin %> <%= command.id %> --target-org my-org --workspace-id 0Zu... --output-dir ./cms-export

- Export all Marketing workspaces beneath ./cms with the v1 JSON aggregate:

  <%= config.bin %> <%= command.id %> --target-org my-org --all --workspace-type Marketing --output-dir ./cms --contract-version 1 --json

- Export an integrity baseline plus an editable HTML companion:

  <%= config.bin %> <%= command.id %> --target-org source-org --workspace-id 0ZuSOURCE --output-dir ./cms-baseline --editable-dir ./cms-editable --json

`--editable-dir` is single-workspace only, cannot be combined with `--all`, and requires explicit `--output-dir`. Both paths must be new, disjoint directories; neither may contain the other, and unsafe or symlink/junction routes are rejected before org access. The baseline is published first and retained if companion creation fails. The companion contains only eligible `sfdc_cms__email` and `sfdc_cms__emailTemplate` variants with string `rawHtml` and no block body. Keep the unchanged baseline for import integrity; the companion permits HTML-only edits and is not a workspace export package. Embedded dependencies and dynamic syntax remain opaque and are not resolved, rewritten, sanitized, or scanned through Phase 7.

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

# flags.editable-dir.summary

New single-workspace companion directory for eligible native email/template HTML. Requires explicit --output-dir; paths must be new and disjoint.

# flags.output-dir.summary

Single: exact new baseline destination. Bulk: parent directory. Defaults to ./cms/<name> or ./cms.
