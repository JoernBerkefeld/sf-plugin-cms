# sf-plugin-cms

Salesforce CLI commands for inspecting Marketing Cloud CMS resources, experimentally exporting a workspace, and safely planning or applying a create-only workspace import through Connect REST API calls. The plugin does not update, overwrite, publish, unpublish, or broadly delete existing CMS content.

## Installation and getting started

### Prerequisites

- Node.js 20 through 24 (`>=20 <25`).
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

Confirm that the plugin loads without making an org request:

```sh
sf cms info
```

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

Checks that the plugin entrypoint loads. This is the safest first command because it does not contact an org.

```sh
sf cms info
```

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

Runs an experimental, read-only, best-effort export of the variants currently observed for one CMS workspace. The destination must not already exist. This output is not a complete or guaranteed backup.

```sh
sf cms export workspace --target-org my-org --workspace-name "Main Site"
sf cms export workspace --target-org my-org --workspace-id 0Zu... --output-dir ./custom-export --json
```

Workspace selector (exactly one required):

- `--workspace-id <id>`: CMS workspace content-space ID. The command validates that the returned workspace ID exactly matches this value.
- `--workspace-name <name>`: exact, case-sensitive workspace name. The command scans bounded zero-based pages, rejects distinct-ID ambiguity, then validates the selected workspace by ID.

`--output-dir <path>` is optional. When omitted, export writes to `./cms/<safe-workspace-name>`. The safe segment preserves Unicode and case, replaces path/control/Windows-invalid characters, and trims unsafe trailing dots or spaces. Empty, dot-only, and Windows reserved device names require an explicit `--output-dir`. An explicit path is used exactly as supplied. The destination must not already exist; missing parents are created.

Every service warning is emitted to stderr. Human output reports the destination and exported-versus-expected counts; `--json` suppresses that human summary and returns one clean structured result.

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

Plans or applies a create-only import from an export package. Dry-run is the default: the command validates the complete local package before authenticating, resolves the destination org and workspace, requires an exact workspace ID plus nonempty `defaultLanguage` and `rootFolderId`, and checks every planned content key for conflicts without sending mutations.

Safe dry run:

```sh
sf cms import workspace --target-org my-org --workspace-name "Destination" --source-dir "./cms/Source"
sf cms import workspace --target-org my-org --workspace-id 0Zu... --source-dir "./cms/Source" --json
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

A successful apply writes:

```text
cms-import-report/
└── workspace-import-run.json
```

The run report binds the run ID to the destination org ID, destination workspace ID, canonical source directory, and source-manifest SHA-256. Before each parent or child mutation it atomically records a `pending` operation containing the exact content key, language, operation kind, destination identity, deterministic request identity, and SHA-256. A response is then recorded as `succeeded` with returned IDs, or a thrown mutation is recorded as `failed` when report storage remains available. Immediate created-parent records remain available for recovery. The run itself is marked `applying`, `completed`, `failed`, or `ownership-uncertain`.

Filesystem report replacement is atomic, but the remote mutation and local report update are not a single atomic transaction. If a mutation returns successfully and its result cannot be durably written, the command raises a distinct ownership-uncertain error and keeps that operation `pending`; the report must not be interpreted as proving that no remote object was created. An existing report directory is never reused, so unresolved operations cannot be treated as resumable progress.

Import limitations and conflicts:

- Import is create-only. Any existing destination content key aborts the entire preflight before mutation; there is no overwrite, update, merge, checkpoint/resume, or cleanup command.
- Every content group must contain exactly one variant matching the destination workspace's `defaultLanguage`. There is no primary-language fallback.
- Child variants are created sequentially after their primary parent. There is no concurrency.
- Media-specific migration is not supported.
- The command does not change publication state; newly created records are expected to remain drafts.
- `--allow-partial` accepts known source omissions but does not make the missing records recoverable.

Recovery guidance:

1. Preserve `workspace-import-run.json` if an apply fails; it is the authoritative local journal for that run.
2. Reconcile every unresolved `pending` operation first, using its exact destination org/workspace, content key, language, operation kind, and request hash. A pending entry means the mutation may have happened even when no returned ID is recorded.
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

## Development

```sh
npm install
npm run lint
npm run build
npm run intake:check
npm test
```

## Contributor notes: experimental workspace export

The experimental export uses the v67 `GET /connect/cms/items/search` operation. The API description requires a non-wildcard `queryTerm`; runtime probing found that `queryTerm=*` returned workspace inventories of 6 and 115 variants, including Draft, Published, and Revised records. This behavior is undocumented and must be retested rather than treated as a stable listing contract.

String-array query values such as `contentSpaceOrFolderIds` and `languages` are serialized as repeated keys. Pagination reconstructs each request from the original filters instead of trusting `nextPageUri`, which was observed to remain present after an empty page. Delivery responses do not prove workspace ownership and exclude drafts. SOQL omitted a known record that remained readable through Connect REST, and CMS `9Pu` folders exposed no child-enumeration operation, so none of those alternatives establishes a complete inventory.

Current shipped export guards are deliberately narrow: one explicit workspace whose lookup ID must match exactly; zero-based paging with `pageSize=250`; at most 1,000 pages and no more than two pages beyond the advertised-count calculation; stop when the advertised count is reached, a page is empty, or a nonempty page adds no new IDs; deduplicate repeated variant IDs; verify `managedContentSpaceId` in search rows and `contentSpace.id` in variant details; record ownership rejections and detail failures; refuse an existing destination; write stable JSON to a temporary sibling directory; remove staging after failure; and rename staging only after all output is written. The command emits all recorded warnings, prints only a compact human summary outside JSON mode, and returns one structured result in JSON mode.

For every API-version upgrade, recheck the operation path and required parameters, wildcard behavior, repeated-key serialization, inventory counts and statuses, empty-page/`nextPageUri` behavior, both ownership fields, draft visibility, delivery coverage, SOQL parity, folder enumeration, duplicate-page handling, and all stop conditions before retaining export support.

Do not market this experimental output as a complete or guaranteed backup. Counts, statuses, and undocumented wildcard behavior can change, and a successful run proves only what that run observed and wrote.
