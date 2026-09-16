# summary

Safely plan or apply a create-only import into a CMS workspace.

# description

Validates the complete source workspace export locally before any org request, selects one destination workspace by exact ID or exact case-sensitive name, and defaults to a non-mutating dry run. The default profile checks each planned source content key for destination existence, but complete server conflict validation and API-name/URL-name availability are not established; named default-profile apply remains blocked. --native-copy-map instead selects bounded native raw-HTML email/template copies with fresh names and server-generated keys. Native and edited HTML is not resolved, rewritten, sanitized, or scanned through Phase 7. Pass --apply with a new --report-dir to create content.

# examples

- Validate a source export and preflight an exact destination workspace name:

  <%= config.bin %> <%= command.id %> --target-org my-org --workspace-name "Destination" --source-dir ./cms/Source

- Apply to an exact destination workspace ID, select result major 1, and write a durable run report:

  <%= config.bin %> <%= command.id %> --target-org my-org --workspace-id 0Zu... --source-dir ./cms/Source --apply --report-dir ./cms-import-report --contract-version 1 --json

- Preview selected native raw-HTML copies with fresh API and URL names from a JSON map:

  <%= config.bin %> <%= command.id %> --target-org my-org --workspace-id 0ZuTARGET --source-dir ./cms-baseline --native-copy-map ./native-copy-map.json --contract-version 1 --json

- Preview HTML-only companion edits while retaining the unchanged baseline as the source package:

  <%= config.bin %> <%= command.id %> --target-org my-org --workspace-id 0ZuTARGET --source-dir ./cms-baseline --native-copy-map ./native-copy-map.json --editable-dir ./cms-editable --contract-version 1 --json

`--native-copy-map` accepts a nonempty JSON array whose rows contain exactly `sourceContentKey`, `language`, `apiName`, and `urlName`. Each row selects one eligible destination-default-language `sfdc_cms__email` or `sfdc_cms__emailTemplate` variant; only one language per parent is supported. The native profile omits the source content key from CREATE and does not prevalidate destination API-name or URL-name availability: API-name collisions can reject CREATE, while duplicate URLs can create distinct objects. It is create-only and does not update, merge, publish, roll back, or retain source keys.

`--editable-dir` requires `--native-copy-map`. `--source-dir` must remain the unchanged integrity baseline; the companion may change only declared literal HTML files and is not itself an export package. The complete baseline, including unselected items, is integrity-validated. Structured/package reference and non-HTML metadata guards remain active, but native-copy and edited `rawHtml` are treated as opaque literal content through Phase 7. Embedded dependencies, media, references, dynamic syntax, and URLs are not discovered, resolved, rewritten, sanitized, or scanned. Dry-run success is not apply readiness or dependency/safety proof.

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

Unchanged source workspace export containing manifest.json and items/. The editable companion is never the source package.

# flags.native-copy-map.summary

JSON array selecting eligible native raw-HTML email/template variants by sourceContentKey and language, with fresh apiName and urlName values. CREATE uses server-generated keys; destination name availability is not prevalidated.

# flags.editable-dir.summary

Verified HTML-only companion for --native-copy-map. Requires the unchanged --source-dir baseline; opaque rawHtml is not dependency-resolved, sanitized, or scanned through Phase 7.

# flags.apply.summary

Create the planned content after local validation and the profile's bounded preflight checks pass. Dry-run does not establish full conflict or apply readiness.

# flags.allow-partial.summary

Accept an export whose manifest records omissions or incomplete coverage.

# flags.report-dir.summary

New directory for the durable applied-import run report.
