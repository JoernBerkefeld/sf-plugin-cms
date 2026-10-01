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

- Export exact Preference Pages as raw items plus typed read reports:

  <%= config.bin %> <%= command.id %> --target-org source-org --workspace-id 0ZuSOURCE --output-dir ./cms-preference-pages --preference-page-map ./preference-pages.json --json

Preference Page selection is exact and case-sensitive by API name. The read/export-only output retains raw source records and writes typed reports while leaving engagement-channel and communication-subchannel IDs as unresolved source references. Therefore expected runs are partial and exit 2. This profile has no CREATE/import support and performs no publication, default assignment, consent mutation, or other org write.

- Export exact Brands as unchanged raw items plus typed read reports:

  <%= config.bin %> <%= command.id %> --target-org source-org --workspace-id 0ZuSOURCE --output-dir ./cms-brands --brand-map ./brands.json --json

Brand selection is exact and case-sensitive by API name. The read-only output preserves each raw record and adds a strict `sf-cms-brand-read-report@1` report under `reports/brands/`, separating portable Brand semantics from source provenance. Only the retained Draft/unpublished Brand shape is accepted. There is no Brand CREATE/import, publication, workspace-default assignment, or other org write.

- Export exact Forms as unchanged raw items plus strict typed reports:

  <%= config.bin %> <%= command.id %> --target-org source-org --workspace-id 0ZuSOURCE --output-dir ./cms-forms --form-map ./forms.json --json

Form selection is exact and case-sensitive by API name. Draft/unpublished source identity, workspace binding, and report/raw integrity are validated while the Form body is preserved without a client-side profile allowlist. Reports use `sf-cms-form-read-report@1` under `reports/forms/`. The minimal profile is live-proven; broader bodies can be exported for transport but are not claimed as live-compatible.

- Export exact Form Handlers as unchanged raw items plus strict typed reports:

  <%= config.bin %> <%= command.id %> --target-org source-org --workspace-id 0ZuSOURCE --output-dir ./cms-form-handlers --form-handler-map ./form-handlers.json --json

Form Handler selection is exact and case-sensitive by API name and requires canonical Marketing-workspace evidence before export requests. The accepted Draft/unpublished body has only the canonical brand source, empty data providers, matching title, and an empty UUID-v4 root block. Reports use `sf-cms-form-handler-read-report@1` under `reports/form-handlers/`; populated bindings, children, and reference-like objects fail closed.

- Export exact Consent Banners as unchanged raw items plus strict typed reports:

  <%= config.bin %> <%= command.id %> --target-org source-org --workspace-id 0ZuSOURCE --output-dir ./cms-consent-banners --consent-banner-map ./consent-banners.json --json

Consent Banner selection is exact and case-sensitive by API name and requires canonical Marketing-workspace evidence. Reports use `sf-cms-consent-banner-read-report@1` under `reports/consent-banners/`. Only the evidenced dependency-free Draft/unpublished body with empty providers and the exact Reject and Accept actions is accepted; additional actions and site, consent-config, Data 360, CMS, external, source, provider, file, or unknown references fail closed.

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

# flags.email-fragment-map.summary

JSON file containing a nonempty array of exact `sfdc_cms__emailFragment` API names. Every name must resolve exactly once.

# flags.web-fragment-map.summary

JSON file containing a nonempty array of exact `sfdc_cms__webFragment` API names. Every name must resolve exactly once.

# flags.landing-page-template-map.summary

JSON file containing a nonempty array of exact `sfdc_cms__landingPageTemplate` API names. Every name must resolve exactly once.

# flags.landing-page-map.summary

JSON file containing a nonempty array of exact `sfdc_cms__landingPage` API names. Every name must resolve exactly once.

# flags.preference-page-map.summary

JSON file containing a nonempty array of exact `sfdc_cms__preferencePage` API names. Every name must resolve exactly once. This read/export-only profile retains each raw item and adds a typed `sf-cms-preference-page-read-report@1` report. Engagement-channel and communication-subchannel IDs remain unresolved source references, so expected exports are partial and exit with status 2. There is no Preference Page CREATE/import flag, publication, default assignment, consent mutation, or other org write.

# flags.brand-map.summary

JSON file containing a nonempty array of exact `sfdc_cms__brand` API names. Every name must resolve exactly once. This read-only profile preserves each raw item and adds a strict `sf-cms-brand-read-report@1` report. Typed Brand reports cannot be imported, and the capability performs no CREATE, publication, workspace-default Brand assignment, or other org write.

# flags.form-map.summary

JSON file containing a nonempty array of exact case-sensitive `sfdc_cms__form` API names. Every name must resolve exactly once. The profile preserves unchanged Draft/unpublished raw items and emits strict `sf-cms-form-read-report@1` evidence under `reports/forms/` without imposing a client-side Form body allowlist.

# flags.form-handler-map.summary

JSON file containing a nonempty array of exact case-sensitive `sfdc_cms__formHandler` API names. The profile preserves unchanged raw items and emits strict `sf-cms-form-handler-read-report@1` evidence under `reports/form-handlers/`; only the evidenced dependency-free minimal Draft shape is accepted.

# flags.consent-banner-map.summary

JSON file containing a nonempty array of exact case-sensitive `sfdc_cms__consentBanner` API names. The profile preserves unchanged raw items and emits strict `sf-cms-consent-banner-read-report@1` evidence under `reports/consent-banners/`; only the exact evidenced dependency-free Draft shape and built-in Reject/Accept actions are accepted.

# flags.landing-page-pair-map.summary

JSON file containing one or more explicit page/template pairs. Each page is selected by exact `sfdc_cms__landingPage` API name. Each source template is resolved by exact human title/label with strict zero/one/many behavior; an optional independently known API name can corroborate the resolved canonical template identity but is never derived from the opaque page relationship value. The package records the requested title plus the resolved template API name, content key, and variant ID.

# flags.editable-dir.summary

New single-workspace companion directory for eligible native email/template HTML. Requires explicit --output-dir; paths must be new and disjoint.

# flags.output-dir.summary

Single: exact new baseline destination. Bulk: parent directory. Defaults to ./cms/<name> or ./cms.
