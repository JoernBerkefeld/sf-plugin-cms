# sf-plugin-cms

Salesforce CLI commands for inspecting Marketing Cloud CMS resources, experimentally exporting a workspace, safely planning or applying a create-only workspace import, and performing narrowly bounded Email UPDATE, PUBLISH, UNPUBLISH, and DELETE lifecycle operations through Connect REST API calls. Email Template UPDATE and DELETE are available only through their stricter version 2 contracts. The plugin does not provide general overwrite, upsert, cross-family lifecycle mutation, or broadly destructive CMS operations.

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

| Command                   | Details                                         |
| ------------------------- | ----------------------------------------------- |
| `sf cms info`             | [Plugin information](#sf-cms-info)              |
| `sf cms list workspace`   | [List workspaces](#sf-cms-list-workspace)       |
| `sf cms get workspace`    | [Get a workspace](#sf-cms-get-workspace)        |
| `sf cms list channel`     | [List workspace channels](#sf-cms-list-channel) |
| `sf cms get channel`      | [Get a channel](#sf-cms-get-channel)            |
| `sf cms get content`      | [Get content](#sf-cms-get-content)              |
| `sf cms get variant`      | [Get a variant](#sf-cms-get-variant)            |
| `sf cms export workspace` | [Export a workspace](#sf-cms-export-workspace)  |
| `sf cms import workspace` | [Import a workspace](#sf-cms-import-workspace)  |
| `sf cms publish content`   | [Publish a Draft Email](#sf-cms-publish-content)       |
| `sf cms unpublish content` | [Unpublish a Published Email](#sf-cms-unpublish-content) |
| `sf cms update content`    | [Update Draft Email HTML](#sf-cms-update-content)       |
| `sf cms delete content`    | [Delete a run-owned Draft Email](#sf-cms-delete-content) |

All org-backed commands require `--target-org <username-or-alias>` (short form `-o`). They use API version `67.0` by default; pass `--api-version <version>` only when you need to override it. Add `--json` for machine-readable Salesforce CLI output. Without `--json`, list commands print compact tables and get commands print formatted JSON records.

### `sf cms info`

Returns the offline `sf-cms-info@1` capability envelope. This is the safest first command because it does not contact an org.

```sh
sf cms info --json
sf cms info --contract-version 1 --json
```

The result advertises command-result versions separately from compatible workspace-package manifest majors. It currently reports API `67.0` as both the default and sole tested version. Bulk export is implemented without media binaries; single-workspace media export is experimental and requires the explicit `--experimental-media` opt-in. The strict v2 image-create profile and the bounded v1 component-create profiles remain experimental. External-reference correlation and import mapping remain experimental because only evidenced CMS reference kinds and explicitly mapped prerequisites can be resolved. Installation alone does not prove org permissions or endpoint availability.

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
sf cms export workspace --target-org my-org --workspace-id 0Zu... --output-dir ./custom-export --experimental-media --json
sf cms export workspace --target-org my-org --workspace-id 0Zu... --output-dir ./template-baseline --email-template-map ./email-templates.json --editable-dir ./template-editable --json
sf cms export workspace --target-org my-org --all --workspace-type Marketing --output-dir ./cms --contract-version 1 --json
```

Choose either single or bulk mode:

- Single mode requires exactly one of `--workspace-id <id>` or `--workspace-name <name>`. Name matching is exact but case-insensitive. Case-only or Unicode-normalization-equivalent duplicates are ambiguous. The canonical fetched workspace name is always used for the default folder, preserving its casing. Image candidates are JSON-only and force an honest partial result by default. `--experimental-media` explicitly opts into the undocumented binary download transport and strict v2 media manifest; only then may Salesforce authorization follow the transport's narrowly validated redirect policy.
- Bulk mode uses `--all`, which is mutually exclusive with both single selectors. Optional `--workspace-type Marketing|Content` is valid only with `--all`; input casing is ignored and output is normalized to `Marketing` or `Content`. `--experimental-media` is incompatible with `--all`; bulk export never enables media binaries.

In single mode, `--output-dir <path>` remains the exact new destination. When omitted, export writes to `./cms/<safe-canonical-workspace-name>`. In bulk mode, `--output-dir` is the parent directory and defaults to `./cms`; each workspace is written beneath it using the canonical fetched name. Safe segments preserve Unicode and case, replace path/control/Windows-invalid characters, and trim unsafe trailing dots or spaces.

Bulk mode performs a strict global preflight before the first workspace export. When `--workspace-type` is supplied, workspace enumeration sends the matching `spaceType` filter to Salesforce, so unrelated workspace families such as Enablement cannot enter the Marketing or Content preflight and block the requested export. The command then enumerates until an empty page, canonicalizes every returned workspace by ID, validates IDs and names, resolves recognized canonical `spaceType` values, applies the type check again, sorts by canonical ID, checks the output parent and every destination, and rejects collisions after sanitization, Unicode normalization, and case folding. If a canonical detail response omits `spaceType`, preflight can use the list response's recognized type only for the same exact workspace ID. A present malformed, null, or unsupported canonical type is rejected, while an explicit contradictory type is filtered out. Any preflight failure creates no destinations and makes no export calls.

After preflight, each workspace export remains atomic. Execution continues after individual failures. Manifest warnings count as successful exports. JSON and human modes both return the complete deterministic aggregate with discovered, selected, succeeded, and failed counts plus per-workspace status, manifest, or redacted single-line error. A partial execution sets a nonzero process exit code only after the aggregate is emitted.

For a strict Email Template UPDATE baseline, `--email-template-map <json-file>` selects one or more exact case-sensitive `sfdc_cms__emailTemplate` API names. The command inventories the complete Template family with wildcard search, resolves every requested name exactly once, writes only those Template variants, and can create the matching `--editable-dir` companion. Unrelated Image media and other-family relationship warnings cannot enter this scoped package. The package still preserves strict hashes, exact item ownership, included parent-content reference evidence, and the normal `UNSUPPORTED_WILDCARD` warning; incomplete family inventory, missing or duplicate API names, detail failures, or ownership drift block publication.

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
- Exactly one destination selector: `--workspace-id <id>` or exact case-insensitive `--workspace-name <name>`. This identity is the destination and is independent of the source workspace recorded in the export manifest.
- `--source-dir <path>`: existing source export package containing `manifest.json` and exactly the mapped `items/*.json` files. Its manifest identifies the source workspace only; it does not select the destination.

Safety flags:

- `--apply`: opt in to mutations. Without it, the command only validates and preflights.
- `--report-dir <path>`: required with `--apply`; the destination must not exist. There is no overwrite mode.
- `--allow-partial`: accept a package whose manifest records omissions or incomplete coverage. Without this flag, partial exports are rejected. Form, Form Handler, and Consent Banner imports always require a complete package and ignore this allowance.

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

#### CMS images (`--image-map`)

Image transfer is an experimental single-workspace workflow built on strict workspace package v2. Export must use `--experimental-media`, which downloads the selected image binaries and records an exact bijection between each image variant, its media descriptor, and its packaged file. Import requires `--contract-version 2` and a nonempty `--image-map` JSON array. One row imports one image; multiple rows import many images sequentially in their deterministic typed-source order.

```json
[
  {
    "source": {
      "family": "cms",
      "type": "image",
      "apiName": "SourceLogo"
    },
    "contentKey": { "strategy": "preserve" },
    "apiName": { "strategy": "fresh", "value": "TargetLogo" },
    "title": { "strategy": "fresh", "value": "Target Logo" },
    "urlName": { "strategy": "generated" }
  }
]
```

```sh
sf cms export workspace --target-org source-org --workspace-id 0ZuSOURCE --output-dir ./cms-images --experimental-media --json
sf cms import workspace --target-org destination-org --workspace-id 0ZuTARGET --source-dir ./cms-images --image-map ./image-map.json --contract-version 2 --json
sf cms import workspace --target-org destination-org --workspace-id 0ZuTARGET --source-dir ./cms-images --image-map ./image-map.json --contract-version 2 --apply --report-dir ./cms-image-report --json
```

Every row selects exactly one integrity-verified `cms/image` item by exact API name, with optional source bindings such as workspace, language, server ID, title, or version. Each of the four identity fields has an explicit strategy: `preserve` submits the evidenced source value, `fresh` submits a different map-provided value, and `generated` omits the value for the server to assign. `title` supports only `preserve` or `fresh`. Every explicitly submitted Enhanced CMS target content key must match `^MC[A-Z2-7]{26}$`: the `MC` prefix followed by exactly 26 uppercase base32 characters (`A`–`Z` or `2`–`7`). Image keys supplied through `preserve` or `fresh` follow the same rule. Duplicate source selections and duplicate non-generated target identity tuples are rejected.

Dry-run validates the complete v2 package, verifies media bytes and hashes, resolves the exact destination workspace, and checks every selected destination identity before reporting the plan. Apply repeats destination checks immediately before each sequential multipart CREATE, records a pending operation before transport, and verifies returned identity, workspace, type, Draft state, authoring metadata, and canonical variant readback. Binary byte proof is reported separately because the authoring readback may not expose original bytes. Multipart filenames are normalized to the declared GIF, JPEG, PNG, or WebP MIME type; missing extensions are added and mismatches are rejected.

Image import is create-only. It has no update fallback, overwrite, publication, rollback, cleanup, or automatic retry. A transport or report-persistence ambiguity leaves ownership uncertain and must be reconciled from `workspace-import-run.json` before any new attempt.

#### Bounded email-fragment copies (`--email-fragment-map`)

Export one or many `sfdc_cms__emailFragment` components by exact API name. The selection file is a nonempty JSON string array; every requested name must resolve exactly once in the selected workspace and exact content type. Only selected variants are packaged, so relationship descriptors owned by unrelated workspace content are excluded while the resulting package retains normal manifest and hash verification.

```json
["ReusableHeader", "ReusableFooter"]
```

```sh
sf cms export workspace --target-org source-org --workspace-id 0ZuSOURCE --output-dir ./cms-email-fragments --email-fragment-map ./email-fragments.json --json
```

For import, `--email-fragment-map <json-file>` opts into the experimental first Phase 4 profile. It supports only dependency-free `sfdc_cms__emailFragment` content whose body exactly matches the evidenced root-content-block → one section → one empty column shape, including the exact accepted layout attributes and empty provider, expression, attachment, and variant arrays. It is not general reusable-block or workspace restoration support.

The mapping file is a nonempty JSON array with exact typed source selectors and fresh target identities:

```json
[
  {
    "source": {
      "family": "cms",
      "type": "emailFragment",
      "apiName": "source_fragment_api"
    },
    "target": {
      "contentKey": "MCAAAAAAAAAAAAAAAAAAAAAAAAAA",
      "apiName": "fresh_fragment_api"
    }
  }
]
```

Each row must select exactly one integrity-verified `sfdc_cms__emailFragment` by API name. Missing, ambiguous, wrong-type, and duplicate selections are rejected; source content keys remain package provenance and are not selectors. The selected item language must equal the destination workspace's default language. Target `contentKey` and `apiName` must be fresh; the source title and URL name are preserved and therefore must also be fresh at the destination. Content-key and exact API-name absence are checked during preflight and rechecked immediately before CREATE, but dry-run still reports that broader server conflict behavior and apply readiness are unverified.

Preview first, then apply once with a new report directory:

```sh
sf cms import workspace --target-org destination-org --workspace-id 0ZuTARGET --source-dir ./cms-baseline --email-fragment-map ./email-fragment-map.json --contract-version 1 --json
sf cms import workspace --target-org destination-org --workspace-id 0ZuTARGET --source-dir ./cms-baseline --email-fragment-map ./email-fragment-map.json --apply --report-dir ./cms-email-fragment-create-report --contract-version 1 --json
```

Apply performs fresh create-only import under the destination root folder. It creates only the destination-default-language parent and leaves it Draft and unpublished. It preserves the source body, title, and URL name while replacing only the mapped `contentKey` and `apiName`; it does not modify the source package. No update, overwrite, publication, activation, send, child-language creation, or automatic retry is supported.

Bodies with nonempty components, references, media, data providers, expressions, attachments, variants, extra fields, or near-match layout definitions/attributes are rejected before mutation. Other email-fragment shapes remain unsupported. The separate `workspace.import.email-fragment-create` capability remains `experimental` because live acceptance covers only this narrow profile, not general email-fragment or workspace restoration.

#### Landing-page content blocks (`--web-fragment-map`)

Export one or many `sfdc_cms__webFragment` components by exact API name with a JSON string array. Every requested name must resolve exactly once in the selected workspace and type; otherwise export fails closed.

```json
["LandingHero", "LandingFooter"]
```

```sh
sf cms export workspace --target-org source-org --workspace-id 0ZuSOURCE --output-dir ./cms-web-fragments --web-fragment-map ./web-fragments.json --json
```

Import uses a nonempty JSON array with exact typed source selection, fresh target identities, and one explicit row for every source Data Graph provider. Preserve names by repeating them, or map both the developer name and data-space developer name explicitly.

```json
[
  {
    "source": {
      "family": "cms",
      "type": "webFragment",
      "apiName": "LandingHero"
    },
    "target": {
      "contentKey": "MCBBBBBBBBBBBBBBBBBBBBBBBBBB",
      "apiName": "LandingHeroTarget"
    },
    "dataGraphs": [
      {
        "sourceDeveloperName": "Marketing",
        "sourceDataSpace": "default",
        "targetDeveloperName": "Marketing",
        "targetDataSpace": "default"
      }
    ]
  }
]
```

```sh
sf cms import workspace --target-org destination-org --workspace-id 0ZuTARGET --source-dir ./cms-web-fragments --web-fragment-map ./web-fragment-map.json --contract-version 1 --json
sf cms import workspace --target-org destination-org --workspace-id 0ZuTARGET --source-dir ./cms-web-fragments --web-fragment-map ./web-fragment-map.json --apply --report-dir ./cms-web-fragment-report --contract-version 1 --json
```

Dry-run proves fresh content-key and API-name availability, then resolves each exact target Data Graph with a named Connect GET at `/services/data/v{version}/ssot/data-graphs/{encodedDeveloperName}` using the connection-selected API version. A prerequisite qualifies only when the response is a non-array object whose nonempty `name` and `dataspaceName` exactly and case-sensitively match the mapped target pair, and whose nonblank status is `ready` or `active` case-insensitively. Apply repeats API-name and Data Graph validation immediately before each CREATE, creates sequentially, and journals every prerequisite mapping, validation result, and mutation in `workspace-import-run.json`. Duplicate target pairs share one request within each validation pass, but dry-run and apply revalidation remain separate. Request failures and malformed, missing, mismatched, or non-ready responses block creation; there is no SOQL, metadata/list fallback, data-space query-parameter reliance, or default Data Graph substitution. The profile creates Draft content only: no update fallback, overwrite, publication, activation, or send is performed. Deploy referenced CMS images before dependent fragments. The bounded packed installed-host acceptance matrix includes fresh Draft CREATE and independent readback for this exact profile; broader web-fragment shapes remain unsupported.

#### Landing-page templates (`--landing-page-template-map`)

Export one or many `sfdc_cms__landingPageTemplate` components by exact API name. The selection file is a nonempty JSON string array; each name must resolve exactly once in the selected workspace and exact content type.

```json
["MCBSUMZKCZFFEU3MZFHAZWVTWNGY"]
```

```sh
sf cms export workspace --target-org source-org --workspace-id 0ZuSOURCE --output-dir ./cms-landing-templates --landing-page-template-map ./landing-page-templates.json --json
```

Import uses exact typed source selection, fresh create identities, explicit mappings for every captured CMS image/web-fragment reference, and explicit mappings for every Data Graph provider. Salesforce derives the template Label as `<target.apiName>--sfdc_cms__landingPageTemplate` and limits it to 80 characters, so `target.apiName` is limited to 49 characters. `targetTitle` is optional and is used only when the exact target API-name lookup succeeds with zero matches; fallback remains exact, type-qualified, workspace-scoped, and must resolve uniquely.

```json
[
  {
    "source": {
      "family": "cms",
      "type": "landingPageTemplate",
      "apiName": "MCBSUMZKCZFFEU3MZFHAZWVTWNGY"
    },
    "target": {
      "contentKey": "MCCCCCCCCCCCCCCCCCCCCCCCCCCC",
      "apiName": "FreshLandingTemplate"
    },
    "cmsDependencies": [
      {
        "sourceContentKey": "MCX2CQNLBTIBHUTDNGOLKCRUZW2Q",
        "sourceType": "image",
        "targetApiName": "TargetLogoImage",
        "targetTitle": "Logo Placeholder"
      }
    ],
    "dataGraphs": [
      {
        "sourceDeveloperName": "Marketing",
        "sourceDataSpace": "default",
        "targetDeveloperName": "Marketing",
        "targetDataSpace": "default"
      }
    ]
  }
]
```

```sh
sf cms import workspace --target-org destination-org --workspace-id 0ZuTARGET --source-dir ./cms-landing-templates --landing-page-template-map ./landing-page-template-map.json --contract-version 1 --json
sf cms import workspace --target-org destination-org --workspace-id 0ZuTARGET --source-dir ./cms-landing-templates --landing-page-template-map ./landing-page-template-map.json --apply --report-dir ./cms-landing-template-report --contract-version 1 --json
```

Dry-run verifies the complete package, fresh destination content key/API name, each exact Data Graph identity, and each exact typed CMS prerequisite. Apply repeats all checks immediately before each sequential CREATE, rewrites only the mapped CMS content keys and bound media URLs, and records CMS/Data Graph prerequisite resolution plus mutation evidence in `workspace-import-run.json`. Any lookup error, missing/ambiguous API name, missing/ambiguous title fallback, wrong type/workspace, unsupported reference shape, or drift blocks creation. Templates remain Draft and unpublished; there is no update, overwrite, upsert, publication, activation, send, or landing-page creation. Deploy images and web fragments first. The bounded packed installed-host acceptance matrix includes fresh Draft CREATE and independent readback for this exact template profile, with prerequisite revalidation and drift checks.

#### Preference Page read reports (`--preference-page-map`)

Export one or more `sfdc_cms__preferencePage` records by exact, case-sensitive API name. The selection file uses the existing nonempty JSON string-array format, and every requested name must resolve exactly once in the selected workspace and exact content type.

```json
["GlobalPreferenceCenter", "RegionalPreferenceCenter"]
```

```sh
sf cms export workspace --target-org source-org --workspace-id 0ZuSOURCE --output-dir ./cms-preference-pages --preference-page-map ./preference-pages.json --json
```

This profile writes both the unchanged raw source item under `items/` and a typed `sf-cms-preference-page-read-report@1` normalization under `reports/preference-pages/`. Engagement-channel and communication-subchannel IDs remain explicit unresolved source references in the typed report. That exact report-bound evidence intentionally makes the export partial, emits warnings, and sets exit status `2` while preserving the unchanged three-field single-export JSON result: `destination`, `manifest`, and `manifestSha256`.

Create-only import uses `--preference-page-map` with `--allow-partial`. Each row selects exact source `{ "family": "cms", "type": "preferencePage", "apiName": "..." }`, supplies one fresh target `apiName`, maps every source engagement-channel and communication-subchannel ID to an explicit destination ID, and supplies exactly one destination Brand selector only when the source body has exact `{ "contentKey": "..." }` Brand evidence. Destination channel/subchannel records and their relationship are verified through SOQL; an optional Brand resolves exactly once inside the canonical Marketing workspace. Import preserves body/style semantics, regenerates package-wide fresh UUID-v4 block IDs, omits root `contentKey`, `title`, and `urlName`, rejects child variants, repeats exact API-name/dependency checks immediately before one non-retried public generic CMS POST, journals pending intent first, and verifies independent content-key plus variant-ID Draft/unpublished readback. It never calls `createCpp`, `variant.create`, publish/unpublish, default assignment, consent mutation, or runtime actions.

#### Brand read reports (`--brand-map`)

Export one or more exact, case-sensitive `sfdc_cms__brand` API names from a selected workspace. The JSON selection file must be a nonempty array of strings, and each requested name must resolve exactly once from a complete Brand inventory.

```json
["Phase_5_Discovery_Brand"]
```

```sh
sf cms export workspace --target-org source-org --workspace-id 0ZuSOURCE --output-dir ./cms-brands --brand-map ./brands.json --json
```

The read-only profile preserves every raw Brand item unchanged under `items/` and writes a strict `sf-cms-brand-read-report@1` report under `reports/brands/`. The typed report separates portable Brand semantics from source content, variant, and workspace provenance. It accepts only the retained Draft/unpublished content and variant envelopes and evidenced typography, color, spacing, button, provider, title, Einstein-brand, and empty variant structures. The retained body contains no external identifiers, so an otherwise complete Brand selection remains complete; unknown fields or shapes fail closed before publication.

Create-only import uses `--brand-map`. Each row selects exact source `{ "family": "cms", "type": "brand", "apiName": "..." }` and supplies fresh destination `apiName`, title, and lowercase-hyphen `urlName`. The package must be complete and strictly report-bound with no warnings, failed/rejected IDs, dependencies, or external references. Import requires the canonical Marketing workspace, proves a complete exact Brand inventory and API-name/title/URL absence during dry-run and again immediately before each sequential POST, transports the complete raw body without using the retained export schema as a speculative CREATE allowlist, updates embedded `sfdc_cms:title` only when present, and regenerates UUID-v4 values only for structurally identified block nodes if any exist. Every ordered request intent is durably journaled before the first mutation; `contentKey` is omitted for server generation; ambiguous writes are never retried; and independent content-key plus variant reads must match the target body and identity as Draft/unpublished. The command never assigns the workspace default Brand, publishes, updates, or mutates dependent content.

Example mapping:

```json
[
  {
    "source": { "family": "cms", "type": "brand", "apiName": "Phase_5_Discovery_Brand" },
    "target": { "apiName": "Imported_Brand", "title": "Imported Brand", "urlName": "imported-brand" }
  }
]
```

```sh
sf cms import workspace --target-org target-org --workspace-id 0ZuTARGET --source-dir ./cms-brands --brand-map ./brand-import-map.json --json
```

#### Evidence-qualified Forms (`--form-map`)

Export selects exact, case-sensitive `sfdc_cms__form` API names from a complete Form inventory. It preserves unchanged raw records and writes strict `sf-cms-form-read-report@1` evidence under `reports/forms/`. Report validation proves exact source identity, Draft/unpublished state, workspace binding, hashes, and raw/report bijection without imposing a client-side Form body allowlist.

Import requires a complete package plus the typed report/raw/descriptor bijection and exact normalization match before authentication; `--allow-partial` does not permit partial Form packages. Mappings select one source API name and provide fresh target `apiName`, `title`, and `urlName`. The destination must have canonical Marketing workspace evidence. Dry-run and immediate pre-POST checks enumerate the complete destination Form inventory and reject exact case-sensitive collisions on all three target names. CREATE omits `contentKey`, regenerates every block UUID v4, otherwise preserves source body semantics without stripping providers, broader blocks, actions, or Flow/Data Graph/Form Handler/source/external references, targets the destination root folder, persists pending intent before mutation, and independently reads the returned content key and variant ID to require exact Draft/unpublished semantics. The minimal one-section/one-column/action-button profile has live proof; broader profiles are accepted for transport but are not yet live-proven, and Salesforce is authoritative at runtime. Definitive server rejection is surfaced; ambiguous mutation ownership is not retried automatically. There is no UPDATE, publish, unpublish, or runtime submit.

#### Evidence-qualified Form Handlers (`--form-handler-map`)

Export selects exact, case-sensitive `sfdc_cms__formHandler` API names only after canonical Marketing-workspace assertion. It preserves unchanged raw records and writes strict `sf-cms-form-handler-read-report@1` evidence under `reports/form-handlers/`. The accepted body is limited to `sfdcBrand`, empty data providers, a title matching the top-level title, and an empty UUID-v4 `sfdc_cms/rootContentBlock`. Populated providers or children and Flow, Data 360/dataGraph, source/external, Form Handler/provider, reference, file, or unknown reference-like objects fail closed recursively.

Import requires a complete package even with `--allow-partial`, one exact report for every raw item, empty dependencies/external references/warnings, and the strict loader marker. Mapping source must be `cms/formHandler` with an exact API name; targets provide fresh `apiName`, title, and `urlName`. The root block receives a fresh UUID v4 and CREATE omits `contentKey`. Canonical Marketing-workspace evidence, complete one-page destination Form Handler inventory, and exact API-name/title/URL collision absence are required during dry-run and repeated immediately before the single POST. A durable pending journal is written first; transport, response, persistence, or readback ambiguity retains known identity and reports `ownership-uncertain` reconciliation semantics without retry. Independent content-key and variant reads must agree exactly as Draft/unpublished. Submission/runtime endpoints, UPDATE, publish/unpublish, populated bindings, and broader lifecycle are excluded.

#### Evidence-qualified Consent Banners (`--consent-banner-map`)

Export selects exact, case-sensitive `sfdc_cms__consentBanner` API names only after canonical Marketing-workspace assertion. It preserves unchanged raw records and writes strict `sf-cms-consent-banner-read-report@1` evidence under `reports/consent-banners/`. The accepted Draft/unpublished body is the exact evidenced three-column layout: one paragraph, one Reject button containing only `sfdc_cms__consentRejectAction`, and one Allow button containing only `sfdc_cms__consentAcceptAction`. Data providers must be empty. Additional or unknown actions and source/org, site, consent-configuration, Data 360/dataGraph, CMS, external, file, provider, and unknown reference-like fields fail closed recursively.

Import requires a complete package even with `--allow-partial`, one exact report for every raw item, empty dependencies/external references/warnings, and the strict loader marker. Mapping source must be `cms/consentBanner` with an exact API name; targets provide fresh `apiName`, title, and `urlName`. Every block receives a fresh UUID v4 and CREATE omits `contentKey`. Canonical Marketing-workspace evidence and complete destination Consent Banner inventory prove exact API-name/title/URL collision absence during dry-run and again immediately before the single POST. Durable pending intent is persisted before mutation; any transport, response, persistence, or readback ambiguity remains `ownership-uncertain` and is never retried. Independent content-key and variant reads must agree exactly as Draft/unpublished. Publication, site association, consent-configuration mutation, runtime action invocation, UPDATE, and broader lifecycle support remain excluded.

#### Paired landing pages and declared templates (`--landing-page-pair-map`)

Use this export-only compatibility baseline when a landing page declares a Landing Page Template relationship. The input is a nonempty array of explicit pairs:

```json
[
  {
    "page": { "apiName": "SourceLandingPage" },
    "template": { "title": "Human Template Label" }
  }
]
```

The page selector is its exact API name. The expected template path is its exact human title/label because the relationship value can be opaque or unreadable. Title lookup is strict: zero or multiple exact matches fail closed, and lookup errors are never treated as zero matches. An optional `template.apiName` may corroborate a separately known API name, but the command never parses, compares, or asks the user to enter the opaque relationship value as a selector.

```sh
sf cms export workspace --target-org source-org --workspace-id 0ZuSOURCE --output-dir ./cms-landing-page-pairs --landing-page-pair-map ./landing-page-pairs.json --json
```

The bounded export retrieves complete exact-type inventories for `sfdc_cms__landingPage` and `sfdc_cms__landingPageTemplate` in the selected workspace, exports only the selected pages and resolved templates, and records deterministic `landingPageTemplatePairs` metadata. Each row binds the requested template title to the resolved canonical template API name, content key, and variant ID, plus the page API name/content key/variant ID. Compatibility is structural: each selected page must contain exactly one declared Landing Page Template relationship descriptor. The descriptor remains retained as a generic unsupported relationship; this baseline does not claim historical provenance and does not parse or compare the opaque relationship value. Multiple pages may bind the same exported template. No import mapping, destination lookup, body rewrite, journaling, or mutation is implemented by this flag.

#### Landing pages (`--landing-page-map`)

Export one or many `sfdc_cms__landingPage` components by exact API name. The selection file is a nonempty JSON string array; each name must resolve exactly once within the selected workspace and exact content type.

```json
["MCJV5RXRKOMRF5HD3OD3OFQSO5C4"]
```

```sh
sf cms export workspace --target-org source-org --workspace-id 0ZuSOURCE --output-dir ./cms-landing-pages --landing-page-map ./landing-pages.json --json
```

The bounded import profile consumes the paired export evidence above. Source template selection is title-first; the independently retained canonical template API name/content key/variant ID and normalized page/template body hashes prove structural compatibility, not historical provenance. The opaque relationship descriptor is bound only through that declared pair; any additional unsupported relationship remains blocking. The outgoing page body receives no template-reference field injection.

The supported page shape retains the exact top-level body fields, the `sfdc_cms__dataGraphDataProvider` with `dataGraphApiName` and `dataspace`, and image blocks whose `source.type` is `imageReference`, whose `source.ref.contentKey` identifies the image, and whose URL begins with `/cms/media/{contentKey}`. Salesforce derives the page Label as `<target.apiName>--sfdc_cms__landingPage` and limits it to 80 characters, so `target.apiName` is limited to 57 characters.

```json
[
  {
    "source": {
      "family": "cms",
      "type": "landingPage",
      "apiName": "MCJV5RXRKOMRF5HD3OD3OFQSO5C4"
    },
    "target": {
      "contentKey": "MCDDDDDDDDDDDDDDDDDDDDDDDDDD",
      "apiName": "FreshLandingPage"
    },
    "imageDependencies": [
      {
        "sourceContentKey": "MCX2CQNLBTIBHUTDNGOLKCRUZW2Q",
        "targetApiName": "TargetLogoImage",
        "targetTitle": "Logo Placeholder"
      }
    ],
    "dataGraphs": [
      {
        "sourceDeveloperName": "Marketing",
        "sourceDataSpace": "default",
        "targetDeveloperName": "Marketing",
        "targetDataSpace": "default"
      }
    ]
  }
]
```

```sh
sf cms import workspace --target-org destination-org --workspace-id 0ZuTARGET --source-dir ./cms-landing-pages --landing-page-map ./landing-page-map.json --contract-version 1 --json
sf cms import workspace --target-org destination-org --workspace-id 0ZuTARGET --source-dir ./cms-landing-pages --landing-page-map ./landing-page-map.json --apply --report-dir ./cms-landing-page-report --contract-version 1 --json
```

Destination template resolution uses the explicitly requested content key, or exact API name with exact-title fallback only after a successful zero-match API-name lookup. The resolved template must remain the same exact type/workspace, Draft, unpublished identity and body at preflight and immediately before CREATE. Image resolution is exact API name first within the destination workspace and `sfdc_cms__image` type; `targetTitle` is considered only after that lookup completes successfully with zero matches. Data Graph developer-name/data-space identity and target page identity are also revalidated.

Dry-run creates no report and performs no mutation, but returns the same `templatePrerequisites` evidence shape as apply preflight. Apply writes `workspace-import-run.json` before any mutation, then rebuilds the outgoing body from immutable source page/template baselines and fresh image/Data Graph resolutions immediately before each CREATE. It fails before CREATE on template status/body/workspace/type drift, image/Data Graph drift, or target page identity drift. Evidence includes the source page and declared source template identities, requested target selector, normalization version/body hashes, relationship descriptor binding, phase timestamps/status/hashes, final request-body SHA-256, and returned IDs. The final packed installed-host acceptance performed exactly one fresh Landing Page CREATE and independent readback, proving the bounded result Draft and unpublished while the source/original content remained unchanged. The acceptance matrix also exercised prerequisite and drift checks. There is no update, overwrite, upsert, publish, activate, send, implicit dependency deployment, or template-reference injection.

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

### `sf cms publish content`

Previews or publishes one exact unpublished Draft `sfdc_cms__email` variant. Selection requires exact `--workspace-id` and `--api-name` values plus exactly one of `--language` or `--default-language`. Dry-run is the default:

```sh
sf cms publish content --target-org my-org --workspace-id 0Zu... --api-name WelcomeEmail --language en_US --json
```

Apply requires a new report directory and an explicit acknowledgement that CMS publication changes lifecycle state but does not send the Email:

```sh
sf cms publish content --target-org my-org --workspace-id 0Zu... --api-name WelcomeEmail --default-language --apply --acknowledge-no-send --report-dir ./cms-publish-report --json
```

The command writes `content-publish-run.json` with pending intent before one non-retried, variant-scoped publish request. Content references are excluded. It then performs bounded read-only convergence checks and independently reconciles the parent, selected variant, siblings, and complete workspace Email inventory. Success requires only the selected variant to become `Published` without body changes. Transport, response, persistence, or readback ambiguity is reported as `ownership-uncertain`; never retry until the recorded workspace, content ID, variant ID, and optional deployment ID are reconciled. This command does not start a Flow, transactional send, journey, or campaign. Other content families and parent-scoped publication remain unsupported; bounded Email DELETE is documented separately below.

### `sf cms unpublish content`

`sf cms unpublish content` mirrors the exact Email selector used by publish: `--workspace-id`, `--api-name`, and exactly one of `--language` or `--default-language`. Dry-run is the default. Apply requires a new `--report-dir`, `--apply`, and `--acknowledge-active-use-stops`; the acknowledgement is checked before org access because unpublish removes the content from active use but does not delete it.

The command accepts only an exact `isPublished=true,status=Published` Email and freshly proves that its parent has exactly one variant. Preview explicitly reports `selectorScope: parent`. Apply writes `content-unpublish-run.json` with durable pending intent before one non-retried parent-scoped request containing only `contentIds`; it sends neither `variantIds`, `contextContentSpaceId`, nor the PUBLISH-only `includeContentReferences` field. Up to five readback attempts independently reconcile the parent, exact variant, single-variant sibling scope, and complete Email inventory. Success requires the sole child to transition to `isPublished=false,status=Draft` while preserving body hash, identity, API name, language, parent, and every unrelated inventory row. A definite HTTP 400 `JSON_PARSER_ERROR` rejection is retained separately from ownership-uncertain transport/readback outcomes, with sanitized status, Salesforce error code/message/request ID when available, request selector, and request-body hash.

The earlier retained live fixture attempt used the now-superseded experimental variant selector (`variantIds` with `contextContentSpaceId`) and returned `ownership-uncertain` without a deployment ID. Fresh reads showed that fixture remained Published with unchanged body and identity. It is retained only as ambiguity evidence and must not receive another mutation.

### `sf cms delete content`

Previews or permanently deletes one exact run-owned, unpublished Draft variant from a sealed family policy. `--content-type sfdc_cms__email` remains the exact default and preserves the `sf-cms-content-delete@1` output shape; ownership may come from this plugin's completed CREATE journal (`workspace-import-run.json`) or a strict `sf-cms-email-delete-ownership@1` report. `--content-type sfdc_cms__emailTemplate` requires `--contract-version 2` and accepts only a strict completed CREATE journal.

Dry-run is the default:

```sh
sf cms delete content --target-org my-org --workspace-id 0Zu... --api-name WelcomeEmail --language en_US --ownership-report ./create-report/workspace-import-run.json --json
```

Email Template preview uses the v2 contract and explicit sealed family:

```sh
sf cms delete content --target-org my-org --contract-version 2 --content-type sfdc_cms__emailTemplate --workspace-id 0Zu... --api-name WelcomeTemplate --language en_US --ownership-report ./create-report/workspace-import-run.json --json
```

Apply additionally requires a new report directory and explicit permanent-delete acknowledgement:

```sh
sf cms delete content --target-org my-org --workspace-id 0Zu... --api-name WelcomeEmail --default-language --ownership-report ./delete-ownership.json --apply --acknowledge-permanent-delete --report-dir ./cms-delete-report --json
```

Before mutation, the command proves exact org/workspace/family/API-name/language/content/variant/request ownership, one selected variant, a single-variant parent, exact Draft/unpublished lifecycle, and an unchanged canonical semantic/body hash against the accepted CREATE baseline. Email Template v2 additionally reloads the journal's source workspace export with integrity verification and blocks missing or changed artifacts, partial or failed exports, dependencies, unresolved or unsupported external references, warnings other than `UNSUPPORTED_WILDCARD`, unsafe raw HTML, or a CREATE body that differs from the selected safe source body except for fresh destination identity fields. It writes `content-delete-run.json` with durable pending intent before exactly one non-retried `DELETE /connect/cms/contents/variants/{variantId}` request. There is no cascade, name-only authorization, parent DELETE fallback, or published-content deletion. Completion first requires a complete stable Email inventory with zero rows matching the exact API name and language, then an exact variant GET failure with HTTP 404, one error entry, and `VARIANT_NOT_FOUND`. Only after those two proofs may an exact parent GET failure with HTTP 404, one error entry, and `NOT_FOUND` be recorded as empirical `parentBehavior: "not-found"`; a retained, identity-matching parent is recorded as `present`. Generic 404s, wrong codes, multiple entries, and transport failures remain ownership-uncertain. The first controlled live Email DELETE is reconciled with this exact absence shape and is public/live-verified. Never retry an ambiguous DELETE until the recorded IDs are reconciled read-only.

### `sf cms update content`

Previews or applies one exact Email-family `contentBody.rawHtml` edit from an editable companion. Omitted `--content-type` preserves `sfdc_cms__email` contract v1 behavior. Email Template requires explicit `--content-type sfdc_cms__emailTemplate --contract-version 2`. Selection requires an exact `--workspace-id`, exact `--api-name`, and exactly one of `--language` or `--default-language`. Both the unchanged export baseline (`--source-dir`) and its strict editable companion (`--editable-dir`) are required. Template v2 additionally requires a complete integrity-verified package with no rejected or failed items, dependencies, unresolved or unsupported references, or warnings other than `UNSUPPORTED_WILDCARD`.

Dry-run is the default:

```sh
sf cms update content --target-org my-org --workspace-id 0Zu... --api-name WelcomeEmail --language en_US --source-dir ./cms-baseline --editable-dir ./cms-editable --json
```

Template v2 preview is explicit:

```sh
sf cms update content --target-org my-org --contract-version 2 --content-type sfdc_cms__emailTemplate --workspace-id 0Zu... --api-name WelcomeTemplate --language en_US --source-dir ./cms-baseline --editable-dir ./cms-editable --json
```

Apply requires a new nonexisting report directory:

```sh
sf cms update content --target-org my-org --workspace-id 0Zu... --api-name WelcomeEmail --default-language --source-dir ./cms-baseline --editable-dir ./cms-editable --apply --report-dir ./cms-update-report --json
```

The command supports only an unpublished Draft Email or the accepted raw-HTML Email Template shape and changes only `rawHtml`. It reloads and reprepares immediately for apply, verifies the independent parent, selected variant, complete sibling inventory, and lifecycle, then atomically persists pending intent before exactly one non-retried variant PUT. Template discovery uses wildcard family search cross-checked against the complete wildcard workspace inventory, with exact per-page count semantics, duplicate rejection, and exact inventory equivalence. Successful apply writes `content-update-run.json` with `completed` evidence (`sf-cms-email-update-run` for Email or `sf-cms-email-template-update-run` for Template). Transport or readback ambiguity writes or retains `ownership-uncertain`/pending evidence with the exact workspace, content ID, variant ID, and payload hash required for read-only reconciliation. Never issue a second PUT until that identity is reconciled. Other families and shapes remain unsupported; there is no upsert or implicit publish/unpublish operation.

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

The supported v0.9.0 integration boundary is the Salesforce CLI subprocess. A consumer such as an MCN orchestrator should:

1. Run `sf cms info --json`, require the needed capability, and choose a mutually supported command-result major.
2. Run bulk export or workspace import with `--contract-version 1 --json`.
3. Consume the returned CMS mappings and rewrite only fields owned by that consumer.

CMS owns CMS artifact identity, source-to-target CMS mappings, import ordering, and CMS-internal reference rewriting. General dependency discovery and closure are unavailable in v0.9.0: default exports preserve only evidenced opaque identity inventory and do not expose a general dependency graph. The bounded web-fragment, landing-page-template, and landing-page profiles resolve only the exact CMS and Data Graph prerequisites declared in their maps and evidenced by their supported shapes. Consumers must not inspect package payloads to reconstruct CMS identity, infer dependencies or mappings, or rewrite CMS-owned references. No public JavaScript API is part of v0.9.0; the CLI JSON boundary is sufficient and avoids a second integration surface.

### Authoritative envelope

`sf cms info --json`, aggregate `sf cms export workspace --all --json`, and `sf cms import workspace --json` return exactly these top-level fields:

```json
{
  "contract": "<operation-contract>",
  "contractVersion": "1.0.0",
  "status": "success",
  "metadata": {
    "operation": "<cms.info|workspace.export.bulk|workspace.import>",
    "plugin": { "name": "sf-plugin-cms", "version": "0.9.0" },
    "apiVersion": "67.0"
  },
  "diagnostics": { "warnings": [], "errors": [] },
  "provenance": {
    "producer": "sf-plugin-cms",
    "sourceOrgId": "<org-id-or-offline>",
    "pluginVersion": "0.9.0",
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
- `workspace.export.dependency-closure` — `unavailable`; v0.9.0 does not provide general relationship discovery or traversal.
- `workspace.export.external-reference-correlation` — `experimental`, embedded contract `sf-cms-external-reference-correlations@1`.
- `workspace.export.experimental-media` — `experimental`, contract `sf-cms-workspace-export@2`; available only for a single workspace with explicit `--experimental-media`.
- `content.delete.email` — `experimental`, contract `sf-cms-content-delete@1`; public/live-verified for one exact run-owned single-variant Draft Email.
- `content.delete.email-template` — `experimental`, contract `sf-cms-content-delete@2`; bounded local/package acceptance is implemented, while a live org mutation remains a future roadmap validation step.
- `content.publish.email` — `experimental`, contract `sf-cms-content-publish@1`.
- `content.unpublish.email` — `experimental`, contract `sf-cms-content-unpublish@1`; local code/package qualification and a one-shot live Published-to-Draft parent-scoped transition are complete.
- `content.update.email-raw-html` — `experimental`, contract `sf-cms-content-update@1`.
- `content.update.email-template-raw-html` — `experimental`, contract `sf-cms-content-update@2`; live-qualified for one exact retained Draft/unpublished Email Template after a ready public preview and exactly one completed non-retried PUT.
- `workspace.import.email-fragment-create` — `experimental`, contract `sf-cms-workspace-import@1`.
- `workspace.import.image-create` — `experimental`, contract `sf-cms-workspace-import@2`.
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

A workspace export package contains `manifest.json` plus regular item files. Packages without image candidates use manifest v1. Paired landing-page exports can additionally contain deterministic `landingPageTemplatePairs` rows that bind each selected page item to a title-resolved canonical template item while retaining the page's generic unsupported relationship descriptor. Image candidates without `--experimental-media` remain JSON entries in a strict v2 manifest with an empty `media` array, no media binary files, a `MEDIA_EXPORT_FAILED` warning, and `partial` completeness. With explicit `--experimental-media`, successful image downloads use the same strict v2 manifest and add bijectively matched `media` descriptors and `cms.media` items. `manifest.json` is the sole package control file and the sole regular file excluded from `items[]`. Every other regular file must occur exactly once in `items[]`; directories are excluded, while symlinks and other special filesystem entries are rejected. Paths are relative POSIX-style paths.

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

Current shipped export guards include an explicit single-workspace mode and a strict bulk preflight. Workspace enumeration is zero-based with `pageSize=250`; a requested Marketing or Content bulk export is filtered server-side with `spaceType`, preventing unrelated workspace families from entering that preflight. Enumeration deduplicates exact IDs, rejects conflicting recognized types for the same ID during bulk preflight, ignores advertised totals as a termination signal, and continues until an empty page. It fails closed on repeated pages, no progress, malformed IDs, case/Unicode-equivalent IDs, or the 1,000-page cap. Bulk preflight canonicalizes every returned workspace with a GET, validates canonical ID and name, prefers recognized canonical `spaceType`, and uses recognized list type evidence only when the canonical detail type is absent and the exact ID matches. It rejects present malformed, null, or unsupported canonical type evidence, filters an explicit contradictory type, sorts by canonical ID, and rejects unsafe or colliding destinations before any export starts.

Per-workspace variant export remains atomic and best-effort: it verifies `managedContentSpaceId` in search rows and `contentSpace.id` in variant details, records ownership rejections and detail failures, refuses an existing destination, writes stable JSON to a temporary sibling directory, removes staging after failure, and renames staging only after all output is written. Bulk execution continues across workspace failures and emits a deterministic complete aggregate in both human and JSON modes.

For every API-version upgrade, recheck the operation path and required parameters, wildcard behavior, repeated-key serialization, inventory counts and statuses, empty-page/`nextPageUri` behavior, both ownership fields, draft visibility, delivery coverage, SOQL parity, folder enumeration, duplicate-page handling, and all stop conditions before retaining export support.

Do not market this experimental output as a complete or guaranteed backup. Counts, statuses, and undocumented wildcard behavior can change, and a successful run proves only what that run observed and wrote.
