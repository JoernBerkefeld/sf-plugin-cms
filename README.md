# sf-plugin-cms

Salesforce CLI commands for inspecting Marketing Cloud CMS resources, experimentally exporting a workspace, and safely planning or applying a create-only workspace import through Connect REST API calls. The plugin does not update, overwrite, publish, unpublish, or broadly delete existing CMS content.

## Installation and getting started

### Prerequisites

- Node.js 22.19 or later, below Node.js 25 (`>=22.19 <25`).
- The base Salesforce `sf` CLI.
- A Salesforce org with access to the CMS resources you want to read.

A common cross-platform way to install or update Salesforce CLI is with npm:

```sh
npm install --global @salesforce/cli
sf --version
```

Salesforce also provides platform-specific installers if you prefer not to manage the CLI with npm.

### Authenticate an org

Open the browser login flow and assign an alias that you can reuse in CMS commands:

```sh
sf org login web --alias my-org
sf org display --target-org my-org
```

For a sandbox or org that uses a custom login host, add `--instance-url <login-url>` to `sf org login web`.

### Install the plugin

Install the plugin with Salesforce CLI:

```sh
sf plugins install sf-plugin-cms
```

For contributor work or local development from a source checkout, run these commands from the repository's `sf-plugin-cms` directory:

```sh
npm install
npm run compile
sf plugins link .
```

Linked ESM plugins use the compiled files. Run `npm run compile` again after source changes, or keep `npm run compile -- --watch` running while developing.

Confirm that the plugin loads and inspect its frozen machine-contract capabilities without making an org request:

```sh
sf cms info --json
```

Machine consumers should run this command first and select a mutually supported command-result major before invoking an org-backed operation.

## Command reference

| Command | Details |
|---|---|
| `sf cms info` | [Plugin information](#sf-cms-info) |
| `sf cms list workspace` | [List workspaces](#sf-cms-list-workspace) |
| `sf cms get workspace` | [Get a workspace](#sf-cms-get-workspace) |
| `sf cms list channel` | [List workspace channels](#sf-cms-list-channel) |
| `sf cms get channel` | [Get a channel](#sf-cms-get-channel) |
| `sf cms get content` | [Get content](#sf-cms-get-content) |
| `sf cms get variant` | [Get a variant](#sf-cms-get-variant) |
| `sf cms export workspace` | [Export a workspace](#sf-cms-export-workspace) |
| `sf cms import workspace` | [Import a workspace](#sf-cms-import-workspace) |

All org-backed commands require `--target-org <username-or-alias>` (short form `-o`). They use API version `67.0` by default; pass `--api-version <version>` only when you need to override it. Add `--json` for machine-readable Salesforce CLI output. Without `--json`, list commands print compact tables and get commands print formatted JSON records.

### `sf cms info`

Returns the offline `sf-cms-info@1` capability envelope. This is the safest first command because it does not contact an org.

```sh
sf cms info --json
sf cms info --contract-version 1 --json
```

The result advertises command-result versions separately from compatible workspace-package manifest majors. It currently reports API `67.0` as both the default and sole tested version. Bulk export is implemented; external-reference correlation and import mapping remain experimental because only evidenced CMS reference kinds can be resolved. Installation alone does not prove org permissions or endpoint availability.

`--contract-version <major>` defaults to `1`. Any unsupported major returns a `blocked` `sf-cms-info` envelope with diagnostic code `UNSUPPORTED_CONTRACT_VERSION` and exit `1`, without org access.

### `sf cms list workspace`

Lists one bounded page of CMS workspaces. Use `--name-fragment` to filter workspace names, and use `--page` with `--page-size` to request a specific page.

```sh
sf cms list workspace --target-org my-org
sf cms list workspace --target-org my-org --name-fragment Marketing
sf cms list workspace --target-org my-org --page 0 --page-size 25 --json
```

Key flags:

- `--name-fragment <text>`: return workspaces whose names contain the value.
- `--page <number>`: zero-based page number; the first page is `0`.
- `--page-size <number>`: maximum number of items requested for that page; must be at least `1`.

The command requests only the selected page; it does not automatically follow subsequent pages.

### `sf cms get workspace`

Retrieves one workspace by its CMS content-space ID.

```sh
sf cms get workspace --target-org my-org --workspace-id 0Zu...
sf cms get workspace --target-org my-org --workspace-id 0Zu... --json
```

Required selector: `--workspace-id <id>`.

### `sf cms list channel`

Lists one bounded page of channels assigned to a specific workspace.

```sh
sf cms list channel --target-org my-org --workspace-id 0Zu...
sf cms list channel --target-org my-org --workspace-id 0Zu... --page 0 --page-size 25
```

Key flags:

- `--workspace-id <id>`: required CMS workspace content-space ID.
- `--page <number>`: zero-based page number.
- `--page-size <number>`: maximum number of channels requested; must be at least `1`.

The command requests only the selected page; it does not automatically follow subsequent pages.

### `sf cms get channel`

Retrieves one CMS channel by its identifier.

```sh
sf cms get channel --target-org my-org --channel-id 0ap...
sf cms get channel --target-org my-org --channel-id 0ap... --json
```

Required selector: `--channel-id <id>`.

### `sf cms get content`

Retrieves a CMS content document by content key or ID. Optional selectors are passed directly to the CMS content request when you need a particular language or version.

```sh
sf cms get content --target-org my-org --content-key-or-id news-banner
sf cms get content --target-org my-org --content-key-or-id news-banner --language en-US
sf cms get content --target-org my-org --content-key-or-id news-banner --content-version 3 --variant-version 2 --version 1 --json
```

Key flags:

- `--content-key-or-id <value>`: required content key or content identifier.
- `--content-version <value>`: select a content version.
- `--language <value>`: select a content language.
- `--variant-version <value>`: select a variant version.
- `--version <value>`: select a document version.

The selector values are strings and are optional except for `--content-key-or-id`. Use only the selectors required by the content record you want.

### `sf cms get variant`

Retrieves one CMS content variant by its identifier.

```sh
sf cms get variant --target-org my-org --variant-id 0aV...
sf cms get variant --target-org my-org --variant-id 0aV... --json
```

Required selector: `--variant-id <id>`.

### `sf cms export workspace`

Runs an experimental, read-only, best-effort export of the variants currently observed for one CMS workspace or every workspace. This output is not a complete or guaranteed backup.

```sh
sf cms export workspace --target-org my-org --workspace-name "Main Site"
sf cms export workspace --target-org my-org --workspace-id 0Zu... --output-dir ./custom-export --json
sf cms export workspace --target-org my-org --all --workspace-type Marketing --output-dir ./cms --contract-version 1 --json
```

Choose either single or bulk mode:

- Single mode requires exactly one of `--workspace-id <id>` or `--workspace-name <name>`. Name matching is exact but case-insensitive. Case-only or Unicode-normalization-equivalent duplicates are ambiguous. The canonical fetched workspace name is always used for the default folder, preserving its casing.
- Bulk mode uses `--all`, which is mutually exclusive with both single selectors. Optional `--workspace-type Marketing|Content` is valid only with `--all`; input casing is ignored and output is normalized to `Marketing` or `Content`.

In single mode, `--output-dir <path>` remains the exact new destination. When omitted, export writes to `./cms/<safe-canonical-workspace-name>`. In bulk mode, `--output-dir` is the parent directory and defaults to `./cms`; each workspace is written beneath it using the canonical fetched name. Safe segments preserve Unicode and case, replace path/control/Windows-invalid characters, and trim unsafe trailing dots or spaces.

Bulk mode performs a strict global preflight before the first workspace export: it enumerates until an empty page, canonicalizes every workspace by ID, validates IDs and names, resolves recognized canonical `spaceType` values, applies the optional type filter, sorts by canonical ID, checks the output parent and every destination, and rejects collisions after sanitization, Unicode normalization, and case folding. If a canonical detail response omits `spaceType`, preflight can use the list response's recognized type only for the same exact workspace ID. A present malformed, null, or unsupported canonical type is rejected, while an explicit contradictory canonical `Content` type is filtered out. Any preflight failure creates no destinations and makes no export calls.

After preflight, each workspace export remains atomic. Execution continues after individual failures. Manifest warnings count as successful exports. JSON and human modes both return the complete deterministic aggregate with discovered, selected, succeeded, and failed counts plus per-workspace status, manifest, or redacted single-line error. A partial execution sets a nonzero process exit code only after the aggregate is emitted.

This bulk command is also the delegation target for tools such as `sf-plugin-mcnext` that need a complete CMS workspace handoff without duplicating CMS export logic; no `sf-plugin-mcnext` changes are required.

Export layout:

```text
cms/
└── Main Site/
    ├── manifest.json
    └── items/
        └── <variant-id>.json
```

`manifest.json` records the source workspace, search provenance, counts, warnings, rejected IDs, failed IDs, and the exact item-file mapping. Each item file contains one observed variant representation. Treat the package as best-effort evidence from that run, not as a guaranteed backup.

### `sf cms import workspace`

Plans or applies a create-only import from an export package. Dry-run is the default: the command validates the complete local package before authenticating, resolves the destination org and workspace, and requires an exact workspace ID plus nonempty `defaultLanguage` and `rootFolderId`. The default profile checks every planned source content key for conflicts without sending mutations. The opt-in native-copy profile below instead requests server-generated keys.

Safe dry run:

```sh
sf cms import workspace --target-org my-org --workspace-name "Destination" --source-dir "./cms/Source"
sf cms import workspace --target-org my-org --workspace-id 0Zu... --source-dir "./cms/Source" --contract-version 1 --json
```

Explicit apply:

```sh
sf cms import workspace --target-org my-org --workspace-name "Destination" --source-dir "./cms/Source" --apply --report-dir ./cms-import-report
```

Required flags:

- `--target-org <username-or-alias>`: explicit destination org; no implicit target is accepted.
- Exactly one destination selector: `--workspace-id <id>` or exact case-sensitive `--workspace-name <name>`. This identity is the destination and is independent of the source workspace recorded in the export manifest.
- `--source-dir <path>`: existing source export package containing `manifest.json` and exactly the mapped `items/*.json` files. Its manifest identifies the source workspace only; it does not select the destination.

Safety flags:

- `--apply`: opt in to mutations. Without it, the command only validates and preflights.
- `--report-dir <path>`: required with `--apply`; the destination must not exist. There is no overwrite mode.
- `--allow-partial`: accept a package whose manifest records omissions or incomplete coverage. Without this flag, partial exports are rejected.

A successful default-profile dry-run is a read-only proposal, not a deploy-ready result. It preserves named content and checks destination content-key absence, but reports `SERVER_CONFLICT_CHECK_UNVERIFIED` and `APPLY_READINESS_UNVERIFIED` warnings. Named proposals additionally report `NAME_AVAILABILITY_UNVERIFIED`: destination API-name/URL-name availability is not established, and default-profile named apply remains blocked. Package-wide reference and media checks still apply to default-profile dry-runs; no target mappings are claimed as resolved.

#### Native raw-HTML copies (`--native-copy-map`)

`--native-copy-map <json-file>` opts into a bounded create-only profile for selected raw-HTML `sfdc_cms__email` and `sfdc_cms__emailTemplate` content. It is not general workspace restoration. Phase 1 users deliberately select content they believe is reference-free; a successful dry-run does not prove that embedded HTML has no dependencies. The file must contain a nonempty JSON array; each row has exactly these four string fields:

```json
[
  {
    "sourceContentKey": "SOURCE_CONTENT_KEY",
    "language": "en-US",
    "apiName": "CopiedEmail",
    "urlName": "copied-email"
  }
]
```

Replace the example source key and language with an exact pair from the integrity-verified package. Each row selects exactly one existing variant, with only one language per distinct parent; selection may be a subset of the package, but the entire package must pass integrity validation. The selected language must equal the destination workspace's default language. `sourceContentKey`, `language`, and `apiName` use letters, digits, underscores, or hyphens without whitespace; `urlName` uses only lowercase letters, digits, or hyphens. API and URL names must be fresh relative to all source items and the other rows in this run.

Native selection excludes a `cms.relationship` descriptor from reference preflight only when it exactly matches exporter evidence and is unambiguously owned by an unselected variant. References owned by selected variants, or with ambiguous or unproven ownership, remain subject to blocking preflight checks. Full-package integrity validation still includes unselected items, and the original manifest, source hash, integrity counts, and complete reference reporting are retained; excluding a descriptor from preflight does not resolve it. Default-profile imports retain package-wide reference preflight.

Partial source packages still require explicit `--allow-partial`, including for native selection. The read-only selection diagnostic returned contract status `partial`, exit code `2`, an empty `errors` array, and a non-null import result while retaining the original unsupported references and readiness warnings. This demonstrates that the selected proposal passed planning/preflight, not apply authorization, apply readiness, or full-package restore proof.

Save the array outside the source package, for example as `./native-copy-map.json`. Preview first, then explicitly apply with a new report directory:

```sh
sf cms import workspace --target-org my-org --workspace-name "Destination" --source-dir ./cms/Source --native-copy-map ./native-copy-map.json --contract-version 1 --json
sf cms import workspace --target-org my-org --workspace-name "Destination" --source-dir ./cms/Source --native-copy-map ./native-copy-map.json --apply --report-dir ./cms-native-copy-report --contract-version 1 --json
```

The native profile omits `contentKey` from CREATE and uses the returned server-generated identity; source keys are not retained as target keys. It submits the selected fresh API/URL names and remaps the email body's `sfdc_cms:urlName`, without modifying source files or existing records. Destination API-name/URL-name availability is not prevalidated: an API-name collision can reject CREATE, while duplicate URLs can create distinct objects. A dry-run neither allocates target identities nor proves that a later apply will succeed.

The supported body requires nonempty `sfdc_cms:title`, `subjectLine`, `messagePurpose`, and `rawHtml`. Optional supported strings are `sfdc_cms:description`, `preheader`, `textContent`, and `backgroundColor`, plus the email body's URL name. Only empty provider/expression/attachment/variant arrays and the exact observed default background/brand settings are accepted. Unknown fields, non-null external-provider metadata, unsafe non-HTML metadata strings, and structured/package media or reference forms remain rejected. Temporarily through Phase 7, the retained raw-HTML danger scanner is bypassed and nonempty `rawHtml` is accepted as opaque literal content: embedded dependencies, media, references, dynamic syntax, and URLs are not discovered, resolved, rewritten, sanitized, or rejected. This is not dependency or safety validation; enabling the retained type-aware scanner is deferred to Phase 8. Encoded native GET HTML is decoded once for CREATE, while literal edited sidecar HTML is not decoded again. Successful apply reads the created content back and verifies generated identities, destination, language, type, names, Draft/unpublished state, and submitted body fields.

Historical native-copy evidence includes local compiled public-command execution with real flag parsing and org connections for owned email/template probes, including a separate cross-org native CREATE acceptance with independent readbacks. That evidence concerns the unedited native-copy path, not live installed editable HTML transfer. Separate packed CLI tests do not establish live installed-host acceptance against Salesforce. No general workspace migration, custom-key CREATE, general reference/media transport, non-default-language copying, or every allowed-field live profile is proven. The MCNext orchestrator is not wired to this native-copy flag; its integration remains a separate slice.

#### Editable HTML companion (`--editable-dir`)

For local HTML editing, keep two separate directories: the unchanged workspace export is the integrity/provenance baseline, and an opt-in companion contains literal HTML beside its variant metadata. Export with both explicit destinations:

```sh
sf cms export workspace --target-org source-org --workspace-id 0ZuSOURCE --output-dir ./cms-baseline --editable-dir ./cms-editable --json
```

Replace the example org aliases and workspace IDs with your own. `--editable-dir` is single-workspace only, cannot be combined with `--all`, and requires explicit `--output-dir`. Both destinations must be new, disjoint directories: neither may contain the other. Unsafe paths and symlink/junction routes are rejected before org access. The baseline is published first; if companion creation fails (including when there are no eligible variants), the command fails with a **baseline retained / editable output unavailable** message. Keep that baseline: this is not a two-directory transaction, and a successful baseline is not deleted on companion failure.

```text
cms-baseline/
├── manifest.json
└── items/<variant-id>.json
cms-editable/
├── editable.json
└── items/
    ├── <variant-id>.json
    └── <variant-id>.html
```

The companion includes only `sfdc_cms__email` / `sfdc_cms__emailTemplate` variants with string `contentBody.rawHtml` and no `sfdc_cms:block`. Other content remains solely in the baseline. Distinct variant IDs keep languages and parents separate. Export eligibility is a raw-shape test, not proof that the HTML is dependency-free or safe. Builder/block-based content, arbitrary metadata editing, and structured media/reference transport are not supported; embedded HTML dependencies and dynamic syntax remain opaque while the retained scanner is bypassed until Phase 8.

1. Open `./cms-editable/items/<variant-id>.html` in your editor and change only the HTML. It is literal UTF-8, not a JSON-escaped document; save without a BOM. Do not edit the baseline, `editable.json`, or the adjacent metadata JSON, and do not add or rename files. The metadata retains the original variant fields except `contentBody.rawHtml`.
2. Save `./native-copy-map.json` outside both directories using the four-field array shown above. Select the exact original content key and language, with fresh API/URL names. Only one destination-default-language variant per parent can be selected; every selected variant must have a companion HTML file.
3. Preview the reconstructed HTML with the default dry-run:

```sh
sf cms import workspace --target-org destination-org --workspace-id 0ZuTARGET --source-dir ./cms-baseline --editable-dir ./cms-editable --native-copy-map ./native-copy-map.json --contract-version 1 --json
```

4. Review the result, then explicitly request fresh CREATE with a new report directory outside both input directories:

```sh
sf cms import workspace --target-org destination-org --workspace-id 0ZuTARGET --source-dir ./cms-baseline --editable-dir ./cms-editable --native-copy-map ./native-copy-map.json --apply --report-dir ./cms-editable-create-report --contract-version 1 --json
```

For a partial baseline, add `--allow-partial` to both import commands only after accepting its recorded omissions. A `partial` result can exit `2` with usable data; inspect the result and diagnostics rather than treating dry-run as apply readiness. No `--dry-run` flag is needed. Import `--editable-dir` requires `--native-copy-map`, and `--source-dir` always points to the original baseline, never the companion. CREATE generates new target keys; this is not UPDATE or publication, and destination name availability is not guaranteed by dry-run.

Import verifies the entire baseline, including unselected items, before checking the companion against metadata and hashes derived from that baseline. Only declared HTML contents may differ; recalculating a descriptor hash cannot authorize a metadata edit. No manual checksum updates or repacking are needed. Selected literal HTML replaces only `rawHtml` and is not decoded as a GET response again. Structured/package reference checks and all non-HTML metadata guards still apply, but the opaque HTML itself is not scanned. Existing explicit native identity/URL mapping still applies; neither input directory is rewritten.

`EDITABLE_HTML_INPUT` appears on successful dry-run/apply results even if no HTML changed. It separates selected modifications planned/applied from changes across **all** companion entries. Original source-manifest hashes, integrity counts, and reference inventory continue to describe only the unchanged baseline, not the edited payload; HTML edits do not establish CMS reference rewriting. Before the first editable CREATE, the initial durable `workspace-import-run.json` includes `editableSource` with the companion contract, original `sourceManifestSha256`, and every companion variant's `originalHtmlSha256`, `currentHtmlSha256`, and `changed` value. Its pending operations also bind the exact reconstructed CREATE payloads through `requestSha256`. All-companion evidence does not mean all entries were selected or created; use the operations and returned identities to determine what happened.

The companion is **not** an `sf-cms-workspace-export` package and must not be supplied as MCNext migration artifact evidence. Default exports, workspace-package v1, and existing CLI JSON result shapes remain unchanged. MCNext does not consume this editable directory or gain editable-transfer support from its presence.

Controlled-transport installed CLI tests cover export, HTML editing, dry-run, fresh CREATE, readback, and journal evidence for email/template content. **Live installed editable transfer is still unproven:** the 2026-09-16 attempt stopped on Salesforce session-refresh maintenance before export or mutation. Historical native-copy acceptance is separate evidence, not proof of edited HTML transfer.

#### Run reports and recovery

A successful apply writes:

```text
cms-import-report/
└── workspace-import-run.json
```

The run report binds the run ID to the destination org ID, destination workspace ID, canonical source directory, and source-manifest SHA-256. Before each parent or child mutation it atomically records a `pending` operation containing the content key, language, operation kind, destination identity, deterministic request identity, and SHA-256. For native copies, that pre-request content key is the source key, not a predicted target key. Returned native identities are durably recorded as `contentKey`, `contentId`, and `primaryVariantId` before response semantic checks and readback verification. Native POST errors, including `DUPLICATE_VALUE`, leave the operation pending and the run ownership-uncertain; there is no automatic retry or update fallback. In the default profile, a response is recorded as `succeeded` with returned IDs, or a thrown mutation is recorded as `failed` when report storage remains available. Immediate created-parent records remain available for recovery. The run itself is marked `applying`, `completed`, `failed`, or `ownership-uncertain`.

Filesystem report replacement is atomic, but the remote mutation and local report update are not a single atomic transaction. If a mutation returns successfully and its result cannot be durably written, the command raises a distinct ownership-uncertain error and keeps that operation `pending`; the report must not be interpreted as proving that no remote object was created. An existing report directory is never reused, so unresolved operations cannot be treated as resumable progress.

Import limitations and conflicts:

- Import is create-only. In the default profile, any existing destination content key aborts the entire preflight before mutation. Native copies use server-generated keys instead. Neither profile supports overwrite, update, merge, checkpoint/resume, or a cleanup command.
- Every content group must contain exactly one variant matching the destination workspace's `defaultLanguage`. There is no primary-language fallback; native copies select only that language and create no additional-language children.
- Default-profile child variants are created sequentially after their primary parent. There is no concurrency, automatic rollback, or full-package transaction; a later failure can leave earlier created drafts.
- Media-specific migration is not supported.
- The command does not change publication state; newly created records are expected to remain drafts.
- `--allow-partial` accepts known source omissions but does not make the missing records recoverable.

Recovery guidance:

1. Preserve `workspace-import-run.json` if an apply fails; it is the authoritative local journal for that run.
2. Reconcile every unresolved `pending` operation first, using its exact destination org/workspace, content key, language, operation kind, and request hash. For native copies, distinguish the recorded source key from any returned generated target identity. A pending entry means the mutation may have happened even when no returned ID is recorded; neither a POST error nor a failed readback proves that no draft exists. Do not retry blindly.
3. Inspect and verify each `succeeded` operation and immediate created-parent record in the exact destination org and workspace before taking action.
4. Remove only records proven to belong to that run, beginning with recorded variants. Do not infer IDs or delete by broad search, workspace, title, or content-key pattern.
5. If ownership or deletion is uncertain, stop and record the leftovers for manual review. Never modify workspace/channel configuration or publish content as recovery.
6. This journal is not a resume mechanism. After reconciliation, correct the source or destination conflict, choose a new nonexisting report directory, and run dry-run again before any new apply attempt.

In JSON mode the command returns exactly one structured command result. Human plan lines are suppressed; warnings and failures remain structured Salesforce CLI output, and transport errors redact authorization, cookies, tokens, and signed URL parameters.

## Common flags and output

- `--target-org <username-or-alias>` / `-o <username-or-alias>` selects the authenticated org. There is no implicit default for org-backed CMS commands.
- `--api-version <version>` overrides the default CMS request API version, currently `67.0`.
- `--json` returns the command result in Salesforce CLI JSON mode for scripts and automation.
- `--page` is zero-based, and `--page-size` controls only the requested page size. Run another command with the next page number to continue paging.

Use `sf <command> --help` to inspect the installed command's current flags, for example:

```sh
sf cms get content --help
```

## Versioned machine contracts

### Integration boundary and ownership

The supported v0.4.0 integration boundary is the Salesforce CLI subprocess. A consumer such as an MCN orchestrator should:

1. Run `sf cms info --json`, require the needed capability, and choose a mutually supported command-result major.
2. Run bulk export or workspace import with `--contract-version 1 --json`.
3. Consume the returned CMS mappings and rewrite only fields owned by that consumer.

CMS owns CMS artifact identity, source-to-target CMS mappings, import ordering, and CMS-internal reference rewriting. Dependency discovery and closure are unavailable in v0.4.0: exports preserve only evidenced opaque identity inventory and do not expose dependency edges. Consumers must not inspect package payloads to reconstruct CMS identity, infer dependencies or mappings, or rewrite CMS-owned references. No public JavaScript API is part of v0.4.0; the CLI JSON boundary is sufficient and avoids a second integration surface.

### Authoritative envelope

`sf cms info --json`, aggregate `sf cms export workspace --all --json`, and `sf cms import workspace --json` return exactly these top-level fields:

```json
{
  "contract": "<operation-contract>",
  "contractVersion": "1.0.0",
  "status": "success",
  "metadata": {
    "operation": "<cms.info|workspace.export.bulk|workspace.import>",
    "plugin": { "name": "sf-plugin-cms", "version": "0.3.1" },
    "apiVersion": "67.0"
  },
  "diagnostics": { "warnings": [], "errors": [] },
  "provenance": {
    "producer": "sf-plugin-cms",
    "sourceOrgId": "<org-id-or-offline>",
    "pluginVersion": "0.3.1",
    "command": "sf cms <operation>",
    "generatedAt": "<ISO-8601>"
  },
  "result": {}
}
```

Statuses are `success`, `partial`, `failed`, or `blocked`. Diagnostics contain bounded, redacted entries shaped as `{ code, message, scope?, reference?, retryable? }`. `result` is `null` only when a failed or blocked command has no usable operation result. Aggregate export provenance additionally contains deterministic `exportSetId`.

The `--contract-version <major>` flag selects the command envelope/result major and defaults to `1`; it does not select the independently declared package-manifest version. Unsupported command-result majors block with `UNSUPPORTED_CONTRACT_VERSION` before org access. Import also validates the package-declared manifest major before org access and blocks unsupported packages with `UNSUPPORTED_PACKAGE_VERSION`.

### Exact operation results

`sf-cms-info@1` reports plugin/API versions, supported command results, supported package manifests, result-to-manifest compatibility, and these capability IDs:

- `workspace.export.bulk` — `implemented`, contract `sf-cms-workspace-export-set@1`.
- `workspace.export.dependency-closure` — `unavailable`; v0.4.0 does not discover or traverse CMS relationships.
- `workspace.export.external-reference-correlation` — `experimental`, embedded contract `sf-cms-external-reference-correlations@1`.
- `workspace.import.mapping` — `experimental`, contract `sf-cms-workspace-import@1`.

`sf-cms-workspace-export-set@1` contains `workspaceType`, a portable `outputDirectory`, selection and summary counts, `externalReferenceCorrelations`, and deterministic per-workspace entries. Workspace entries include canonical source identity, `success|partial|failed` status, relative artifact/manifest paths and hashes when finalized, and structured diagnostics. Any finalized omission or unresolved/unsupported reference makes that workspace and aggregate partial.

The correlation table exists only at `result.externalReferenceCorrelations`. Each `sf-cms-external-reference-correlations@1` row has exactly five fields:

```json
{
  "sourceWorkspaceId": "0Zu...",
  "sourceReference": "<exact opaque value>",
  "referenceKind": "cms.content",
  "referenceId": "ref:<sha256>",
  "packageManifestSha256": "<64 lowercase hex>"
}
```

`sourceReference` is serialized unchanged and matched by exact string equality only—no trimming, case folding, decoding, hashing, or fuzzy matching. Rows bind to a canonical CMS reference, source workspace, and verified package manifest. Envelope provenance binds the entire set to its producer, source org, plugin version, and export-set identity. Duplicate or conflicting correlations block the contract. Unresolved and unsupported values appear only as diagnostics/references and never as correlation rows or resolved mappings.

`sf-cms-workspace-import@1` contains the verified source package identity, explicit target org/workspace, integrity counts, deterministic mappings, and unresolved/unsupported references. A resolved mapping supplies `target.targetReference`; consumers must use that value rather than derive one from IDs. Rewriting is limited to the evidenced CMS-owned `contentBody.*.ref.contentKey` shape. `cmsReferencesRewritten: true` is reported only when every required target mapping was available before the outgoing mutation and inspection of the exact outgoing parent and variant payloads proves that no relevant source key remains. Forward, self, and unknown references stay unresolved or unsupported. Dry-run remains truthful and does not claim target resolution that requires a mutation.

### Package layout and integrity

A v1 workspace export package contains `manifest.json` plus regular item files. `manifest.json` is the sole package control file and the sole regular file excluded from `items[]`. Every other regular file must occur exactly once in `items[]`; directories are excluded, while symlinks and other special filesystem entries are rejected. Paths are relative POSIX-style paths.

Each item records exactly `{ path, sha256, kind, referenceId? }`, with lowercase SHA-256 calculated over the finalized exact file bytes. Import independently validates the manifest major, enumerates the package, rejects missing, substituted, duplicate-path, or unlisted files, and verifies every item hash. Only after the listed set and hashes are verified does it hash the exact `manifest.json` bytes and use that hash as package identity.

Opaque reference descriptors remain CMS-owned identity inventory. Their portable values must not be interpreted by consumers, and `dependencies` remains empty because relationship discovery is unavailable. Only evidenced kinds can be `included` or become resolved mappings; unresolved or unsupported relationship classes are emitted only when the exported payload actually contains that evidence. This experimental export proves only the artifacts observed during that run and is not a complete backup.

### Exit codes and automation

- Exit `0`: command-owned contract status `success`.
- Exit `2`: contract status `partial`; usable aggregate/result data is still returned.
- Exit `1`: command-owned status `failed` or `blocked`.
- Salesforce CLI framework parse, configuration, or authentication failures can retain the framework's standard JSON/error shape and exit behavior; they are outside the command-result contract.

Automation should parse stdout JSON and inspect the process exit code. It must not infer status by scraping stderr. Human and JSON modes report the same status, counts, and artifact paths.

## Development

```sh
npm install --no-workspaces
npm run lint:fix
npm run lint
npm run build
npm run intake:check
npm run generate:check
npm test
npm run validate:package
```

## Contributor notes: experimental workspace export

The experimental export uses the v67 `GET /connect/cms/items/search` operation. The API description requires a non-wildcard `queryTerm`; runtime probing found that `queryTerm=*` returned workspace inventories of 6 and 115 variants, including Draft, Published, and Revised records. This behavior is undocumented and must be retested rather than treated as a stable listing contract.

String-array query values such as `contentSpaceOrFolderIds` and `languages` are serialized as repeated keys. Pagination reconstructs each request from the original filters instead of trusting `nextPageUri`, which was observed to remain present after an empty page. Delivery responses do not prove workspace ownership and exclude drafts. SOQL omitted a known record that remained readable through Connect REST, and CMS `9Pu` folders exposed no child-enumeration operation, so none of those alternatives establishes a complete inventory.

Current shipped export guards include an explicit single-workspace mode and a strict bulk preflight. Workspace enumeration is zero-based with `pageSize=250`, deduplicates exact IDs, rejects conflicting recognized types for the same ID during bulk preflight, ignores advertised totals as a termination signal, and continues until an empty page. It fails closed on repeated pages, no progress, malformed IDs, case/Unicode-equivalent IDs, or the 1,000-page cap. Bulk preflight canonicalizes every workspace with a GET, validates canonical ID and name, prefers recognized canonical `spaceType`, and uses recognized list type evidence only when the canonical detail type is absent and the exact ID matches. It rejects present malformed, null, or unsupported canonical type evidence, filters an explicit contradictory `Content` type, sorts by canonical ID, and rejects unsafe or colliding destinations before any export starts.

Per-workspace variant export remains atomic and best-effort: it verifies `managedContentSpaceId` in search rows and `contentSpace.id` in variant details, records ownership rejections and detail failures, refuses an existing destination, writes stable JSON to a temporary sibling directory, removes staging after failure, and renames staging only after all output is written. Bulk execution continues across workspace failures and emits a deterministic complete aggregate in both human and JSON modes.

For every API-version upgrade, recheck the operation path and required parameters, wildcard behavior, repeated-key serialization, inventory counts and statuses, empty-page/`nextPageUri` behavior, both ownership fields, draft visibility, delivery coverage, SOQL parity, folder enumeration, duplicate-page handling, and all stop conditions before retaining export support.

Do not market this experimental output as a complete or guaranteed backup. Counts, statuses, and undocumented wildcard behavior can change, and a successful run proves only what that run observed and wrote.
