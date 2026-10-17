# sf-plugin-cms

Download supported Salesforce CMS content to your computer, edit it in your editor, and preview changes before saving supported Email or narrow PNG Image content back to Salesforce. Saving creates or updates **Drafts**: it does not publish or send them.

This is a plugin for the Salesforce `sf` command-line tool. It is **not a complete CMS backup or restore tool**. Start with one simple, dependency-free HTML Email or Email Template; builder-based content, references, folders and additional variants can prevent an item from being supported.

- [Install and sign in](#installation-and-getting-started)
- [Download, edit and save one Email](#download-edit-and-save-one-email)
- [Check support for each content type](#content-type-support)
- [Download, edit and save one PNG Image](#download-edit-and-save-one-png-image)
- [Upload several local images](#upload-several-local-images)
- [Understand results and recover safely](#understand-results)

## Content type support

**Retrieve** means `sf cms retrieve content`. **Create** and **Update** mean `sf cms deploy content`. **Delete** means `sf cms delete content`—not general deletion in Salesforce. Loose-file image upload is separate and is **not** Image create support through deploy.

**Available (limited)** means implemented with the restrictions below, not universal or fully qualified support. **Planned** means unavailable now and subject to API discovery and operation-specific qualification; no release version or date is promised. **Not supported** in the Delete column also means no delete rollout is committed in the current roadmap. “Not verified” is deliberately not a guessed API name.

| Type label                                 | Type API name                   | Retrieve support    | Create support       | Update support         | Delete support               |
| ------------------------------------------ | ------------------------------- | ------------------- | -------------------- | ---------------------- | ---------------------------- |
| Audio                                      | `sfdc_cms__audio`               | Planned             | Planned              | Planned                | Not supported                |
| Brand                                      | `sfdc_cms__brand`               | Planned             | Planned              | Planned                | Not supported                |
| Consent Banner                             | `sfdc_cms__consentBanner`       | Planned             | Planned              | Planned                | Not supported                |
| Contact Card (VCF)                         | Not verified                    | Planned             | Planned              | Planned                | Not supported                |
| Content Block: Email (Email Fragment)      | `sfdc_cms__emailFragment`       | Planned             | Planned              | Planned                | Not supported                |
| Content Block: Landing Page (Web Fragment) | `sfdc_cms__webFragment`         | Planned             | Planned              | Planned                | Not supported                |
| Custom Font                                | Not verified                    | Planned             | Planned              | Planned                | Not supported                |
| Document                                   | `sfdc_cms__document`            | Planned             | Planned              | Planned                | Not supported                |
| Email                                      | `sfdc_cms__email`               | Available (limited) | Available (limited)  | Available (HTML only)  | Available (owned Draft only) |
| Email Template                             | `sfdc_cms__emailTemplate`       | Available (limited) | Available (limited)  | Available (HTML only)  | Available (owned Draft only) |
| Expression                                 | Not verified                    | Planned             | Planned              | Planned                | Not supported                |
| Form                                       | `sfdc_cms__form`                | Planned             | Planned              | Planned                | Not supported                |
| Form Handler                               | `sfdc_cms__formHandler`         | Planned             | Planned              | Planned                | Not supported                |
| Image                                      | `sfdc_cms__image`               | Available (limited) | Available (PNG only) | Available (bytes only) | Not supported                |
| In-App Message                             | Not verified                    | Planned             | Planned              | Planned                | Not supported                |
| Landing Page                               | `sfdc_cms__landingPage`         | Planned             | Planned              | Planned                | Not supported                |
| Landing Page Template                      | `sfdc_cms__landingPageTemplate` | Planned             | Planned              | Planned                | Not supported                |
| Preference Page                            | `sfdc_cms__preferencePage`      | Planned             | Planned              | Planned                | Not supported                |
| Push Notification Message                  | Not verified                    | Planned             | Planned              | Planned                | Not supported                |
| RCS Message                                | Not verified                    | Planned             | Planned              | Planned                | Not supported                |
| SMS and MMS                                | Not verified                    | Planned             | Planned              | Planned                | Not supported                |
| Tracked Link                               | Not verified                    | Planned             | Planned              | Planned                | Not supported                |
| Video                                      | `sfdc_cms__video`               | Planned             | Planned              | Planned                | Not supported                |
| WhatsApp Session Message                   | Not verified                    | Planned             | Planned              | Planned                | Not supported                |
| WhatsApp Template Message                  | Not verified                    | Planned             | Planned              | Planned                | Not supported                |

Current operation limits:

- Retrieve admits only supported root-level, single-variant Email, Email Template and Image shapes in an explicitly selected workspace and language. Images can have downloaded native media or external URL-only evidence; retrieving them does not make them deployable.
- Deploy admits dependency-free raw-HTML Email/Email Template sources and a narrow binary PNG Image profile. Create makes an unpublished Draft. Existing Email/Template update changes **HTML only** and requires an eligible Draft; differing JSON metadata or text companions block the whole selection. Image deploy requires a Marketing workspace, its default language and root placement; existing Images require one unpublished primary Draft and exact metadata, filename and MIME. Only the PNG bytes may change. Additional variants, non-root placement and unresolved dependencies remain blocked. Authoring-baseline conflict and sibling-aware update safeguards are not integrated into deploy.
- Delete requires strict ownership evidence, unchanged content, an unpublished Draft and a single-variant parent. It is not deletion by name alone. Email Template additionally requires its strict completed CREATE journal and unchanged source artifacts. A normal portable deploy report is not automatically accepted as delete ownership evidence.
- Offline `sf cms info --json` labels retrieval/deletion **experimental** and deploy/loose-image upload **unqualified**. Narrow installed Email/Template and same-org PNG Image evidence does not qualify every source shape. Cross-org Image acceptance is pending; loose-image upload has no live-upload proof. Internal family profiles do not add public operation support.

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

Confirm that the plugin loads without contacting an org:

```sh
sf cms info
```

If Salesforce CLI asks whether you trust this unsigned plugin, check the package name before confirming. Installation does not grant CMS permissions; your signed-in user still needs access to the chosen workspace.

## Download, edit and save one Email

Run these commands from a folder where you want to keep your project. Replace `my-org` with the login alias you chose. First find your workspace:

```sh
sf cms list workspace --target-org my-org
```

This lists one page; use `--page 1` for the next page if needed. In the examples below, replace `Marketing` with your workspace name and `Welcome` with the exact **API name** of an eligible Email, not its display title. Quote workspace names containing spaces. Choose a simple raw-HTML Email without dependencies and with only one variant; unsupported shapes are blocked rather than converted approximately.

### 1. Download the Email

```sh
sf cms retrieve content --target-org my-org --workspace-name Marketing --content-type sfdc_cms__email --api-name Welcome --default-language --output-dir ./project
```

This reads Salesforce and writes local source files; it does not change Salesforce. `--default-language` explicitly chooses the workspace default language. Use `--language en_US` instead if that is your intended language.

### 2. Edit its HTML

The command prints a `Definition:` path. Keep that JSON file and its declared companions together. Open the `.html` companion listed in the definition, make a small HTML change and save it. Do not change the identity fields or JSON metadata for this first update; changing existing-item JSON metadata or text content is not supported by deploy.

The next examples assume the printed definition is `./project/cms/Marketing/email/Welcome.cms-email.json`. **Replace that entire path with your actual printed path**: the directory uses the workspace API name, which can differ from its display name. Paths containing spaces need quotes.

### 3. Preview the change

```sh
sf cms deploy content --target-org my-org --workspace-name Marketing --default-language --definition-file ./project/cms/Marketing/email/Welcome.cms-email.json
```

There is no `--dry-run` flag: leaving out `--apply` means preview. Preview performs authenticated reads but no Salesforce writes and creates no report directory. Check that the proposal is UPDATE for the expected item, or unchanged if the supported content already matches. A CREATE proposal means no matching destination was found; stop if you intended to update an existing Email. Resolve any blockers before continuing. Preview does not guarantee a later apply will succeed.

### 4. Apply deliberately

```sh
sf cms deploy content --target-org my-org --workspace-name Marketing --default-language --definition-file ./project/cms/Marketing/email/Welcome.cms-email.json --apply --report-dir ./reports/welcome-001
```

The report directory must **not already exist**. Choose a fresh name for each apply, and keep the reports. The command checks the whole selection again before writes. This saves a Draft; it does not publish, activate or send anything. A failure can leave earlier successful changes in place: there is no automatic rollback or retry.

To create supported content in another workspace or org, use its explicit destination selectors and preview first. Only qualified source shapes are admitted; source IDs do not choose the destination.

## Download, edit and save one PNG Image

Select a root-level, single-variant native PNG Image in a Marketing workspace and its default language. Existing targets must be unpublished primary Drafts with their native filename already exactly `<apiName>.cms-image.media.png`. Retrieval normalizes the companion filename, so retrieval alone does not prove deploy eligibility. A native filename mismatch blocks deploy; filename and metadata updates are unsupported. Download it first:

```sh
sf cms retrieve content -o my-org -W Marketing -t sfdc_cms__image -n Hero -L -d ./project
sf cms deploy content -o my-org -W Marketing -L -f ./project/cms/Marketing/image/Hero.cms-image.json --json
```

Replace the example path with the printed `Definition:` path. Keep the `sf-cms-media-source@1` definition and its declared `.cms-image.media.png` companion together. An unchanged preview makes zero writes. To update, edit **only the PNG companion bytes**, preserving its filename, MIME, JSON metadata and identity. Preview again and require UPDATE for the intended unpublished primary Draft before applying:

```sh
sf cms deploy content -o my-org -W Marketing -L -f ./project/cms/Marketing/image/Hero.cms-image.json --apply --report-dir ./reports/hero-001 --json
```

Use a fresh, nonexisting report directory for each apply. A missing destination proposes Draft CREATE; preview with explicit destination selectors first. This profile requires a nonempty signature-matching PNG of at most **10 MiB**. URL-only sources, other image formats, nested folders, multiple variants, published targets and metadata-changing UPDATE remain unsupported. Apply independently verifies exact bytes and stable native identity; unchanged requires matching metadata and bytes. Read-only drift checks are not an authoring-baseline conflict guard.

Installed ordinary primary same-org acceptance covers actual PNG retrieval, portable CREATE, unchanged, bytes-only UPDATE and final unchanged, with exact byte readbacks, stable identity and 75 preexisting items unchanged. This is narrow development-artifact evidence, not released-package qualification. **Cross-org Image acceptance is pending**; do not infer it from Email/Template acceptance or loose-file upload.

## Upload several local images

Use this separate workflow for loose PNG, JPEG, GIF or WebP files (up to 10 MiB each), not for deploying retrieved Image definitions. Repeat `--file` for each image:

```sh
sf cms upload images --target-org my-org --workspace-name Marketing --file ./Logo.png --file "./Summer Banner.jpg"
```

This is a preview. Titles keep the full filename including its extension; API and URL names are derived from it. Unsafe names, unsupported files or destination collisions block the upload; existing images are not overwritten. To deliberately create Drafts, use a fresh report directory:

```sh
sf cms upload images --target-org my-org --workspace-name Marketing --file ./Logo.png --file "./Summer Banner.jpg" --apply --report-dir ./reports/images-001
```

Only a proven enhanced-workspace root is supported. Upload remains unqualified: tests and packed CLI previews are retained, but no live upload has been performed. Metadata readback is not binary-byte proof. A successful preview is not proof that Salesforce will accept CREATE.

## Understand results

- **Preview / dry-run:** no Salesforce writes. You still need to sign in because destination checks read Salesforce.
- **Unchanged:** the supported content already matches; no write is needed.
- **Blocked:** a safety, selection, permission or unsupported-content check prevented the operation. Read the diagnostics and fix the cause rather than adding `--apply` to bypass it.
- **Partial:** some items completed, others did not. Inspect each item and the remaining/unattempted list; do not assume the entire batch succeeded.
- **Failed or uncertain / ownership-uncertain:** preserve the report. A request may have reached Salesforce even when its result could not be confirmed. Reconcile the recorded destination identities read-only before trying again; **do not retry blindly**.

Deploy apply stops at the first failure or uncertain outcome. Retrieve can leave partial local progress. Neither workflow provides automatic rollback or resume. To download again over differing local files, first back up or commit your edits; only then consider retrieve's explicit `--overwrite` option. It is not a general folder cleanup.

A deploy report is not proof that no remote change occurred: remote mutation and local journal persistence are not one atomic transaction. If a write may have reached Salesforce but its result cannot be durably recorded or verified, preserve `content-deploy-run.json` and its per-item reports. Reconcile pending or uncertain entries read-only using the recorded destination org/workspace, content/variant identities and request evidence, even when no returned ID was saved. Do not replay a completed write or retry an unresolved one. After reconciliation, correct blockers, choose a new nonexisting report directory and preview again; journals are not a resume mechanism.

For scripts, add `--json` and inspect both the exit code and item diagnostics: `0` means success, `2` means partial, and `1` means blocked/failed for command-owned results. CLI parsing/authentication errors can use Salesforce CLI's own error format. Use `sf cms <command> --help` for installed flags.

## Command reference

| Command                    | Details                                                                          |
| -------------------------- | -------------------------------------------------------------------------------- |
| `sf cms info`              | [Plugin information](#sf-cms-info)                                               |
| `sf cms list workspace`    | [List workspaces](#sf-cms-list-workspace)                                        |
| `sf cms list channel`      | [List workspace channels](#sf-cms-list-channel)                                  |
| `sf cms retrieve content`  | [Retrieve supported Email, Template and Image sources](#sf-cms-retrieve-content) |
| `sf cms deploy content`    | [Bounded Email/Template deployment](#sf-cms-deploy-content)                      |
| `sf cms upload images`     | [Upload local images](#sf-cms-upload-images)                                     |
| `sf cms publish content`   | [Publish a Draft Email](#sf-cms-publish-content)                                 |
| `sf cms unpublish content` | [Unpublish a Published Email](#sf-cms-unpublish-content)                         |
| `sf cms delete content`    | [Delete a run-owned Draft Email](#sf-cms-delete-content)                         |

All org-backed commands require `--target-org <username-or-alias>` (short form `-o`). They prefer the `/services/data/latest` REST routes by default, while keeping a numeric Core/JSforce connection version. Read-only CMS and native-query capability checks run before command operations; only an explicit unsupported-version or missing-route response permits a temporary `67.0` fallback. Authentication, permission and transport failures do not trigger fallback. Pass `--api-version <numeric-version>` to select a numbered API explicitly (without automatic fallback), or `--api-version latest` to request the default policy. Add `--json` for machine-readable Salesforce CLI output. Without `--json`, list commands print compact tables; other commands render their command-specific human-readable output.

### `sf cms retrieve content`

Retrieve one or several supported Emails, Email Templates or Images (`sfdc_cms__email`, `sfdc_cms__emailTemplate` or `sfdc_cms__image`) into an explicit project root. This command reads the org and writes selected local files only; use the separate bounded `deploy content` workflow below to preview or apply supported Email/Template or binary PNG Image changes. All-of-type selection expands the requested scope, not the supported source shapes.

```sh
# One exact API name.
sf cms retrieve content --target-org my-org --workspace-name Marketing --content-type sfdc_cms__email --api-name Welcome --default-language --output-dir ./project --json
# Repeat --api-name within one type.
sf cms retrieve content -o my-org -W Marketing -t sfdc_cms__email -n Welcome -n Reminder -L -d ./project --json
# Native content key or parent content ID, not a variant ID; repeat -i as needed.
sf cms retrieve content -o my-org -w 0ZuSOURCE -t sfdc_cms__email -i CONTENT_KEY -i PARENT_CONTENT_ID -l en_US -d ./project --json
# All items of the explicitly selected types in one workspace/language.
sf cms retrieve content -o my-org -W Marketing -t sfdc_cms__email -t sfdc_cms__emailTemplate -a -L -d ./project --json
# Mixed-type exact selection, or Type alone for all of that type.
sf cms retrieve content -o my-org -W Marketing -m sfdc_cms__email:Welcome -m sfdc_cms__emailTemplate:Welcome_Template -L -d ./project --json
sf cms retrieve content -o my-org -W Marketing -m sfdc_cms__email -L -d ./project --json
# Explicitly permit replacing differing selected local files.
sf cms retrieve content -o my-org -W Marketing -t sfdc_cms__email -n Welcome -L -d ./project -x --json
```

Names, keys, IDs and paths above are illustrative; use identities visible in your own workspace.

- Required scope: explicit `--target-org -o`, exactly one `--workspace-id -w` / `--workspace-name -W`, exactly one `--language -l` / `--default-language -L`, and `--output-dir -d`. No configured default org or implicit directory/language scope is used.
- Choose exactly one selector style: repeatable `--metadata -m`, or separate flags. Metadata accepts qualified `Type` (all of that type) or `Type:ApiName` (exact name), splitting only at the first colon. It cannot be mixed with `--content-type`, `--api-name`, `--content-key-or-id`, or `--all`. Empty/unknown types and empty names are invalid; no wildcard or comma-separated selector syntax is provided.
- Separate flags require `--content-type -t` plus exactly one of repeatable `--api-name -n`, repeatable `--content-key-or-id -i`, or `--all -a`. Name/key/ID mode requires one distinct type; `--all` accepts repeated types. Selectors are exact and case-sensitive; native selectors match the content key or parent content ID, never the variant ID. Overlapping selectors resolve each native variant once; distinct parents colliding on a portable output identity are blocked even with overwrite.
- `--all` selects only the named types in the explicit workspace/language, not all workspaces, languages, dependencies, or CMS families. Explicit missing/ambiguous members remain blocked even alongside a type-wide selector; a completely enumerated empty type succeeds with zero selected items.
- Admission uses native `ManagedContentVariant` inventory through the selected CMS REST API route, not search-index completeness. Read-only workspace, Email/Template detail and native-query requests through `latest` have bounded two-org qualification resolving to API `68.0`; newer explicit numeric versions are not artificially rejected. It covers principal-visible, nondeleted records, across all languages/statuses, with independent unfiltered parent-sibling reads and GET-detail binding. Keyset reads require empty terminal pages, grouped-count parity and matching repeat reads; limits are 1,000 pages, 250,000 rows and fewer than 2,000 parent groups per scope. This is not an atomic snapshot or evidence about inaccessible/deleted content; scope, count or detail drift blocks retrieval.
- Native GET provenance `source: "User"` is normalized only when both parent and variant agree; unknown, conflicting or one-sided provenance blocks retrieval. Provenance is not editable content and is omitted from portable source; original body and detached source identities remain checked.
- Only the qualified native raw-HTML Email/Email Template profiles are eligible: exact selected language, one independently proven native variant across all sibling languages/statuses, supported body/envelope fields, and reconstructable dependency-free HTML. Folder evidence must be null or the workspace's distinct proven root folder ID in both parent and variant; unknown/non-root placement is blocked. Additional variants, unresolved references/personalization, unsupported components or shapes, and missing/ambiguous identities are not silently dropped. This is not support for every Email shape, folder hierarchy, or multivariant content. Legacy Email and other families remain unsupported, except the bounded Image retrieval described below.
- **Bounded Image retrieval:** `sfdc_cms__image` uses the same exact-name, native key/parent ID, all-of-type and mixed metadata selectors. For example, `sf cms retrieve content -o my-org -W Marketing -m sfdc_cms__email:Welcome -m sfdc_cms__image:Hero -L -d ./project --json`. Root-level, single-variant Images are bound to native parent/variant/workspace evidence and written under `cms/<workspaceApiName>/image/<apiName>.cms-image.json` using `sf-cms-media-source@1`. Native media is downloaded as a declared binary companion (for PNG, `<apiName>.cms-image.media.png`) and verified against its native byte/MIME/hash evidence; external media remains explicitly URL-only without fetching. Resolved identity drift blocks local writing. Only the bounded binary PNG profile described under deploy is eligible for CREATE, bytes-only UPDATE or unchanged; retrieving other media formats or URL-only evidence does not make them deployable. Document is not admitted by this command.
- Writes portable v2 JSON under `cms/<workspaceApiName>/email/<apiName>.cms-email.json` or `cms/<workspaceApiName>/emailTemplate/<apiName>.cms-email-template.json`, with same-stem `.html` and, when present, `.txt` companions. These are editable source files, not a workspace backup manifest. Source IDs remain detached retrieval evidence, not deployable identity. Only the bounded Email/Template deploy workflow below accepts these portable sources; this layout alone does not prove that an item is deployable.
- Existing differing selected files require `--overwrite -x`, including during all-of-type retrieval; unchanged retrieval leaves their bytes stable. Only files owned by each selected item may be replaced or removed; unrelated and remote-absent local items are retained. Local writes are not an item/batch transaction: an I/O failure can leave partial local progress. There is no rollback or project-wide cleanup.
- Complete native selection is resolved before local writes. Independent item admission/write failures may allow other selected items to complete; fatal authentication/scope read failures stop further acquisition and retain unattempted identities. A complete inventory does not mean every selected item passes strict source admission.
- JSON uses `sf-cms-content-retrieve@1` with the established seven-key CMS envelope. The same batch-shaped result for one or many items contains `scope`, `selection`, native `resolution` when available (inventory proof and unresolved selectors), `items` (identity, `operation: retrieve`, outcome, absolute path receipt, detached source evidence, diagnostics), `summary`, and `unattempted`. Successful items are `retrieved` or `unchanged`; blocked scope leaves selections unattempted. Success exits `0` (including a proven empty type); mixed completion exits `2` with `partial`; no completed items with blockers exits `1`. CI must inspect both exit status and item/summary diagnostics, not treat a partial batch as complete. Result content and file receipts contain no generated timestamps; envelope provenance records the invocation time.
- Qualification is limited to installed development-tarball retrieval across two orgs with `latest` and explicit `68.0`, including selector, overwrite and all-of-selected-types cases. Strict source admission still blocks unsupported items; `RETRIEVE_SOURCE_BLOCKED` does not expose a specific subcause. This evidence does not qualify arbitrary business content or every source shape, and does not establish released-package qualification or publication.

### `sf cms deploy content`

Deploy portable v2 Email/Email Template definitions or `sf-cms-media-source@1` binary PNG Image definitions and their declared companions to an explicitly selected destination. Installed same-org and cross-org development-tarball acceptance covers the bounded Email/Template workflow, not general CMS upsert. Image acceptance covers only the installed same-org ordinary primary PNG workflow; cross-org Image acceptance is pending. Publication and installation verification are separate from that operation-specific evidence; the conservative runtime qualification labels remain unchanged.

```sh
# Preview one retrieved item in the source org; no writes or report files.
sf cms deploy content --target-org source-org --workspace-name Marketing --default-language --definition-file ./project/cms/Marketing/email/Welcome.cms-email.json --json
# After editing its HTML file, preview the target org.
sf cms deploy content -o target-org -W Marketing -L -f ./project/cms/Marketing/email/Welcome.cms-email.json --json
# Apply a local Email/Template subset with an exclusive new report directory.
sf cms deploy content -o target-org -W Marketing -L -d ./project/cms/Marketing -m sfdc_cms__email -m sfdc_cms__emailTemplate --apply --report-dir ./reports/deploy-001 --json
```

- Require explicit `--target-org -o`, exactly one `--workspace-id -w` / `--workspace-name -W`, and exactly one `--language -l` / `--default-language -L`. Choose repeatable `--definition-file -f` or repeatable `--source-dir -d`, never both. Directory selection recursively finds recognized definitions, not arbitrary JSON or standalone companions; it never defaults to the current directory. Optional repeatable `--content-type -t` or `--metadata -m` filters are mutually exclusive and directory-only. Metadata accepts `Type` or exact `Type:ApiName`; a requested missing member blocks preflight. Overlapping paths deduplicate; distinct definitions targeting one identity block deployment.
- Dry-run is the default: authenticated destination reads, no org writes, and no report directory. `--apply -a` requires a **new** `--report-dir -r`; report directories are forbidden for dry-run. Stable package versions are permitted: the command does not require a prerelease version or a version-based mutation opt-in.
- Match exact destination workspace, type, API name, and language using native inventory. No match proposes Draft CREATE, one supported match proposes UPDATE or unchanged, and ambiguous/conflicting matches block. Detached retrieval IDs never choose the destination. Only dependency-free raw-HTML Email/Email Template shapes and the bounded PNG Image profile with independently proven root placement and a single native variant are admitted; unresolved references, additional variants, non-root folders and other families remain unsupported. There is no dependency auto-inclusion or general reference-mapping workflow in this command.
- Email/Template CREATE uses admitted portable metadata and reconstructed supported HTML/text fields and creates an unpublished Draft. Existing-target Email/Template UPDATE supports **`rawHtml` only**, preserves the destination identity and other fields, and requires an eligible Draft. Differing JSON metadata or `.txt` bytes on an existing target block the **entire selection** before any write; they are not silently discarded or called unchanged. Equal supported content reports unchanged with zero writes. The local v2 loader's ability to reassemble text or JSON is not proof those fields can be updated.
- Whole-selection preflight completes before mutation, including source/companion validity, duplicate identities, unsupported differences, destination admission and operation-specific checks. Apply reacquires source/destination proof, journals intent before each write, executes sequentially and independently reads back native parent/detail and intended content. The batch journal is `content-deploy-run.json`, with per-item reports referenced from its entries. Stop at the first failure or uncertain outcome; report verified prior successes and remaining unattempted items. No automatic retry, rollback, resume, deletion, publication, activation or sending is performed.
- The `sf-cms-content-deploy@1` envelope reports mode, scope, selection, proposed operations, actual per-item outcomes/readbacks, report paths, summary counts and unattempted items. Success exits `0`; mixed completion is `partial`/exit `2`; blocked/failed with no completed items exits `1`. CI must inspect status, uncertain/unattempted counts and journals, not equate a planned write with a completed one. Runtime emits `qualification: "unqualified"`, `DEPLOY_UNQUALIFIED` and conservative help text; bounded installed evidence does not broaden those labels. Dry-run itself never proves a later mutation.
- Installed development-tarball qualification covers source and target Email/Template CREATE, raw-HTML UPDATE, unchanged/repeated-update zero writes, mixed update/unchanged, whole-selection JSON/text blockers and malformed/missing/duplicate selection blockers, with independent exact readbacks. This is narrow installed qualification, not released-package qualification, universal shape support, or authorization to replay retained Draft fixtures.

### `sf cms upload images`

Upload explicit local images directly, without an export package or JSON input map. Repeat `--file` once per image in upload order; quote paths containing spaces. Select exactly one workspace by ID or exact case-insensitive name. Dry-run is the default and performs local validation plus read-only root/collision preflight; it does not create anything.

```sh
sf cms upload images --target-org my-org --workspace-name "Main Site" --file "./Banner with spaces.PNG" --file ./Logo.jpg
sf cms upload images --target-org my-org --workspace-id 0ZuTARGET --file ./Logo.jpg --apply --report-dir ./image-upload-report --json
```

- Only a proven enhanced workspace with a distinct root folder is eligible. The CREATE target is its exact `rootFolderId`, never its workspace ID or a guessed folder.
- The title is the **full filename including extension**. Lowercase API and URL names use that same full filename: separator runs become underscores or hyphens respectively (`Banner with spaces.PNG` → `banner_with_spaces_png` / `banner-with-spaces-png`). No truncation, suffixing, or collision renaming occurs.
- Explicit regular, nonempty PNG, JPEG (`.jpg` or `.jpeg`), GIF, and WebP files up to **10 MiB each** are supported. Signatures must match extensions; extensions are case-insensitive. Filenames may contain only ASCII letters, digits, spaces, periods, underscores, and hyphens, must start with a letter after derivation, and cannot contain consecutive periods or reserved Windows device basenames. Unsafe names, symlinks/junctions, redirected paths, duplicate paths/file identities, and batch naming collisions fail closed. There is no client-side name-length cap, truncation, decoder-level image validity, or malware guarantee; filesystem and Salesforce name limits remain authoritative and can reject a file or CREATE.
- Exact title/API-name/URL-name destination collisions, compared case-insensitively across all workspace content families, fail the complete batch preflight. Complete workspace collision inventory is bounded to 1,000 pages of 250 records; inability to prove completeness blocks upload. No overwrite or updates are supported.
- `--apply` requires a **new** `--report-dir`. Every intent is durably recorded before sequential CREATEs, with local identity/hash and root/collision revalidation. Apply stops at the first failure without retries, rollback, or resume. It creates Drafts only; no publication or activation occurs.
- The seven-key `sf-cms-images-upload` envelope uses contract version `1.0.0` (`--contract-version 1`). Results contain `mode`, `outcome`, distinct `target`, ordered immutable `intents` (names, media type, size, SHA-256; never bytes), `byteProof: "unavailable"`, and `reportFile`. Outcomes are `ready`, `completed`, `blocked`, `failed`, or `ownership-uncertain`; blocked/failed exit `1`, success exits `0`. Invalid local inputs are rejected before authentication where possible. Resolving a workspace and proving destination collisions requires authenticated reads even in dry-run.
- Apply reports live at `image-upload-run.json`; a fallback failure journal may be used if the normal journal cannot persist. Failure output retains the durable report path. `ownership-uncertain` means CREATE may have succeeded: inspect that report and reconcile destination ownership before any new apply. The CLI does not expose arbitrary transport error bodies. Metadata readback is **not binary-byte proof**; downloaded bytes are not verified.

This independent feature's qualification consists of controlled-transport service/command tests and packed CLI dry-runs, but **no live image upload has been performed**. A successful dry-run does not prove that Salesforce will accept a later CREATE.

### `sf cms info`

Returns the offline `sf-cms-info@1` capability envelope. This is the safest first command because it does not contact an org.

```sh
sf cms info --json
sf cms info --contract-version 1 --json
```

The current contract lists the nine public commands and their actual operation support. Retrieve covers bounded Email, Email Template, and Image profiles. Portable deploy covers Email/Email Template create/update/unchanged and narrow PNG Image create/bytes-only-update/unchanged. All remain **unqualified** in runtime capability output; Image evidence is same-org only, with cross-org acceptance pending. Loose-image upload is a separate unqualified CREATE workflow, not portable Image deployment. Authoring-baseline and sibling-aware update safeguards are not integrated into deploy.

`contracts.commandResults` describes only public commands with CMS-owned envelopes; list workspace/channel retain their existing bounded page results. The family registry is available as `internalRegistry` with `scope: "internal-engine-only"`, including its fixture identity and provider-package bounds. Those internal retrieval/reference profiles do not extend public retrieve/deploy family support or accept workspace export packages through those commands. There is one current info contract; `--contract-version 2` blocks.

Info reports `latest` as the default REST preference and `67.0` as the tested fallback baseline. Operation-specific API qualification is not broadened by capability discovery. Installation alone does not prove org permissions or endpoint availability.

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

## Additional public lifecycle commands

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

An ambiguous unpublish result is not authorization to retry: preserve its journal and reconcile the exact recorded identities read-only before any further mutation.

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

Before mutation, the command proves exact org/workspace/family/API-name/language/content/variant/request ownership, one selected variant, a single-variant parent, exact Draft/unpublished lifecycle, and an unchanged canonical semantic/body hash against the accepted CREATE baseline. Email Template v2 additionally reloads the journal's source workspace export with integrity verification and blocks missing or changed artifacts, partial or failed exports, dependencies, unresolved or unsupported external references, warnings other than `UNSUPPORTED_WILDCARD`, unsafe raw HTML, or a CREATE body that differs from the selected safe source body except for fresh destination identity fields. It writes `content-delete-run.json` with durable pending intent before exactly one non-retried `DELETE /connect/cms/contents/variants/{variantId}` request. There is no cascade, name-only authorization, parent DELETE fallback, or published-content deletion. Completion first requires a complete stable Email inventory with zero rows matching the exact API name and language, then an exact variant GET failure with HTTP 404, one error entry, and `VARIANT_NOT_FOUND`. Only after those two proofs may an exact parent GET failure with HTTP 404, one error entry, and `NOT_FOUND` be recorded as empirical `parentBehavior: "not-found"`; a retained, identity-matching parent is recorded as `present`. Generic 404s, wrong codes, multiple entries, and transport failures remain ownership-uncertain. Controlled live Email DELETE qualification is limited to this exact reconciled absence shape. Never retry an ambiguous DELETE until the recorded IDs are reconciled read-only.

## Common flags and output

- `--target-org <username-or-alias>` / `-o <username-or-alias>` selects the authenticated org. There is no implicit default for org-backed CMS commands.
- `--api-version <numeric-version|latest>` overrides the default `latest` CMS REST preference. An explicit numeric selection never falls back automatically. API selection is settled by read-only capability checks before command operations; failed mutations are never replayed at a fallback version.
- `--json` returns the command result in Salesforce CLI JSON mode for scripts and automation.
- `--page` is zero-based, and `--page-size` controls only the requested page size. Run another command with the next page number to continue paging.

Use `sf <command> --help` to inspect the installed command's current flags, for example:

```sh
sf cms retrieve content --help
```

## Versioned machine contracts

### Integration boundary and ownership

The supported integration boundary is the Salesforce CLI subprocess. Automation should:

1. Run `sf cms info --json` and require the needed public capability. Info has one current contract, `sf-cms-info@1`; its `internalRegistry` is not public operation support.
2. Invoke only a public command and its documented `--contract-version` and `--json` options.
3. Consume only the documented results of those public commands. Do not expect workspace-import mappings, import ordering or general reference resolution from retrieve/deploy.

No public JavaScript API is promised; use only the CLI commands and their documented JSON results.

### Authoritative envelope

`sf cms info --json` returns exactly these top-level fields. Placeholder plugin versions below are illustrative, not release identifiers; actual output reports the installed plugin version.

```json
{
  "contract": "<operation-contract>",
  "contractVersion": "1.0.0",
  "status": "success",
  "metadata": {
    "operation": "<cms.info|content.retrieve|content.deploy|images.upload>",
    "plugin": { "name": "sf-plugin-cms", "version": "<installed-plugin-version>" },
    "apiVersion": "67.0"
  },
  "diagnostics": { "warnings": [], "errors": [] },
  "provenance": {
    "producer": "sf-plugin-cms",
    "sourceOrgId": "<org-id-or-offline>",
    "pluginVersion": "<installed-plugin-version>",
    "command": "sf cms <operation>",
    "generatedAt": "<ISO-8601>"
  },
  "result": {}
}
```

Statuses are `success`, `partial`, `failed`, or `blocked`. Diagnostics contain bounded, redacted entries shaped as `{ code, message, scope?, reference?, retryable? }`. `result` is `null` only when a failed or blocked command has no usable operation result.

Where exposed by a command, `--contract-version <major>` selects its envelope/result major and defaults to `1`. Info supports only its current major `1`; retrieve/deploy emit fixed major `1` envelopes without that flag.

### Exact operation results

`sf-cms-info@1` reports plugin/API versions, `commands`, `contracts.commandResults`, public `capabilities`, and the separately scoped `internalRegistry`.

- `content.retrieve.email`, `content.retrieve.email-template`, `content.retrieve.image` — `experimental`, contract `sf-cms-content-retrieve@1`.
- `content.deploy.email.create|update|unchanged` and `content.deploy.email-template.create|update|unchanged` — six separate `unqualified` capabilities, contract `sf-cms-content-deploy@1`.
- `content.deploy.image.create|update|unchanged` — three separate `unqualified` capabilities, contract `sf-cms-content-deploy@1`; binary PNG only, root/default language, bytes-only UPDATE of an eligible unpublished primary Draft. Cross-org Image acceptance is pending.
- `images.upload.create` — `unqualified`, contract `sf-cms-images-upload@1`; loose files only, not portable Image deploy.
- `content.delete.email` and `content.delete.email-template` — `experimental`, contracts `sf-cms-content-delete@1` and `sf-cms-content-delete@2` respectively; existing operation-specific qualification is unchanged.
- `content.publish.email` and `content.unpublish.email` — `experimental`, contracts `sf-cms-content-publish@1` and `sf-cms-content-unpublish@1`.

### Exit codes and automation

- Exit `0`: command-owned contract status `success`.
- Exit `2`: contract status `partial`; usable aggregate/result data is still returned.
- Exit `1`: command-owned status `failed` or `blocked`.
- Salesforce CLI framework parse, configuration, or authentication failures can retain the framework's standard JSON/error shape and exit behavior; they are outside the command-result contract.

Automation should parse stdout JSON and inspect the process exit code. It must not infer status by scraping stderr. Human and JSON modes report the same status, counts, and artifact paths.

## Development

For contributor work from this repository's plugin directory:

```sh
npm install --no-workspaces
npm run compile --no-workspaces
sf plugins link .
```

Linked ESM plugins use compiled files. Compile again after source edits, or use `npm run compile --no-workspaces -- --watch`.

Contributor scratch directories belong under the operating system temp directory and use `cms-<purpose>-` or `sf-plugin-cms-<purpose>-` prefixes. On this Windows development machine, verify that process-local `TEMP`, Node's `os.tmpdir()`, and any configured `TMP` / `TMPDIR` resolve to `F:\Temp` before running tests; correct only the current process environment if needed. Run verification suites one at a time. Recursive fixture cleanup is limited to registered descendants of newly created, marked run roots; never sweep old temp directories. Destination-adjacent atomic publication staging is output-in-progress, not a scratch root, and remains beside its destination to preserve same-volume publication.

The [demo project](test/demo-project) depicts an **imaginary result of a future retrieve-all operation**, not a shipped command's output or an import-ready export. Its external test-only [inventory](test/fixtures/demo-project-inventory.json) distinguishes current portable Email, Email Template, and immutable Brand shapes from **proposed, not implemented** Image, landing page/template, fragment, form/handler, and consent banner source formats. The fictional campaign uses flat `cms/Demo_Workspace/<family>/<apiName>.cms-<token>` files, same-stem HTML/media companions, inline structured content, and metadata-only logical `folderPath` values. Current-contract examples use root folders and the demo's default language; proposed examples illustrate logical hierarchy without adding physical folder, language, or variant directories.

The 11 representative families are **not** the complete Marketing workspace catalog. The external [UI-label coverage checklist](test/fixtures/demo-project-ui-coverage.json) accounts for all 25 supplied labels, separating evidenced API mappings and bounded provider profiles from unresolved mapping/support; unrepresented types do not receive invented source files. The exact display labels **Content Block: Email** and **Content Block: Landing Page** correspond to native `emailFragment` and `webFragment`. Existing directories, `email-fragment`/`web-fragment` file tokens, and provider identity vocabulary remain compatible. Neither test-only metadata file is retrieved content or a requirement for user projects. The demo root includes only a minimal `sfdx-project.json` with `packageDirectories: []`, plus CMS source artifacts—no MCNext/core samples or placeholder vendor manifests. This fixture convention does not require every standalone CMS operation to run in a Salesforce project.

The demo is source-only: it has **no integrity-bound baseline or admission evidence** and must not be passed to import/deploy as a qualified export. The SVG companion is a proposed local-media illustration, not proof of lossless Image support. Folder enumeration/admission, builder fidelity, dependencies, and broader family contracts remain explicit inventory gaps; variants and non-default languages are out of scope. `test/demo-project.test.ts` checks current definitions with the existing validators and proposed files only for fixture shape, inventory coverage, and companions—not production admission or rendering.

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
