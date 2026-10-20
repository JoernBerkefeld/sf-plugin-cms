# sf-plugin-cms

Download supported Salesforce CMS content to your computer, edit it in your editor, and preview changes before saving supported Email, Image, Document or Audio content back to Salesforce. Saving creates or updates **Drafts**: it does not publish or send them.

The `sf content …` spellings used here are aliases, with identical flags and behavior to their canonical commands: `sf cms retrieve content`, `sf cms deploy content`, `sf cms upload`, `sf cms publish content`, `sf cms unpublish content` and `sf cms delete content`. For discovery and information, `sf content list workspace`, `sf content list channel` and `sf content info` correspond to `sf cms list workspace`, `sf cms list channel` and `sf cms info`.

This is a plugin for the Salesforce `sf` command-line tool. It is **not a complete CMS backup or restore tool**. Start with one simple, dependency-free HTML Email or Email Template; builder-based content, references, folders and additional variants can prevent an item from being supported.

- [Install and sign in](#installation-and-getting-started)
- [Download, edit and save one Email](#download-edit-and-save-one-email)
- [Check support for each content type](#content-type-support)
- [Download, edit and save one PNG Image](#download-edit-and-save-one-png-image)
- [Upload several local images](#upload-several-local-images)
- [Understand results and recover safely](#understand-results)

## Content type support

**Retrieve** means `sf content retrieve`. **Create** and **Update** mean `sf content deploy`. **Delete** means `sf content delete`.

**Available (limited)** means implemented with the restrictions below, not universal or fully qualified support. **Planned** means unavailable now and subject to API discovery and operation-specific qualification; no release version or date is promised. **Not supported** in the Delete column also means no delete rollout is committed in the current roadmap. “Not verified” is deliberately not a guessed API name.

| Type label                                 | Type API name                   | Retrieve support    | Create support          | Update support         | Delete support               |
| ------------------------------------------ | ------------------------------- | ------------------- | ----------------------- | ---------------------- | ---------------------------- |
| Audio                                      | `sfdc_cms__audio`               | Available (limited) | Available (unqualified) | Available (bytes only) | Available (API-led)           |
| Brand                                      | `sfdc_cms__brand`               | Planned             | Planned                 | Planned                | Not supported                |
| Consent Banner                             | `sfdc_cms__consentBanner`       | Planned             | Planned                 | Planned                | Not supported                |
| Contact Card (VCF)                         | Not verified                    | Planned             | Planned                 | Planned                | Not supported                |
| Content Block: Email (Email Fragment)      | `sfdc_cms__emailFragment`       | Planned             | Planned                 | Planned                | Not supported                |
| Content Block: Landing Page (Web Fragment) | `sfdc_cms__webFragment`         | Planned             | Planned                 | Planned                | Not supported                |
| Custom Font                                | Not verified                    | Planned             | Planned                 | Planned                | Not supported                |
| Document                                   | `sfdc_cms__document`            | Available (limited) | Available (API-led)  | Available (bytes only) | Available (API-led)           |
| Email                                      | `sfdc_cms__email`               | Available (limited) | Available (limited)     | Available (HTML only)  | Available (API-led) |
| Email Template                             | `sfdc_cms__emailTemplate`       | Available (limited) | Available (limited)     | Available (HTML only)  | Available (API-led) |
| Expression                                 | Not verified                    | Planned             | Planned                 | Planned                | Not supported                |
| Form                                       | `sfdc_cms__form`                | Planned             | Planned                 | Planned                | Not supported                |
| Form Handler                               | `sfdc_cms__formHandler`         | Planned             | Planned                 | Planned                | Not supported                |
| Image                                      | `sfdc_cms__image`               | Available (limited) | Available (API-led)     | Available (bytes only) | Available (API-led)           |
| In-App Message                             | Not verified                    | Planned             | Planned                 | Planned                | Not supported                |
| Landing Page                               | `sfdc_cms__landingPage`         | Planned             | Planned                 | Planned                | Not supported                |
| Landing Page Template                      | `sfdc_cms__landingPageTemplate` | Planned             | Planned                 | Planned                | Not supported                |
| Preference Page                            | `sfdc_cms__preferencePage`      | Planned             | Planned                 | Planned                | Not supported                |
| Push Notification Message                  | Not verified                    | Planned             | Planned                 | Planned                | Not supported                |
| RCS Message                                | Not verified                    | Planned             | Planned                 | Planned                | Not supported                |
| SMS and MMS                                | Not verified                    | Planned             | Planned                 | Planned                | Not supported                |
| Tracked Link                               | Not verified                    | Planned             | Planned                 | Planned                | Not supported                |
| Video                                      | `sfdc_cms__video`               | Planned             | Planned                 | Planned                | Not supported                |
| WhatsApp Session Message                   | Not verified                    | Planned             | Planned                 | Planned                | Not supported                |
| WhatsApp Template Message                  | Not verified                    | Planned             | Planned                 | Planned                | Not supported                |

Salesforce documents a 25 MB Image limit.

Current operation limits:

- Retrieve admits only supported root-level, single-variant Email, Email Template, Image, Document and Audio shapes in an explicitly selected workspace; language defaults to that workspace's default. Images can have downloaded native media or external URL-only evidence; retrieving them does not make them deployable.
- Deploy admits dependency-free raw-HTML Email/Email Template sources, API-led binary Images, API-led binary Documents and binary Audio for CREATE, bytes-only UPDATE or exact unchanged. Create makes an unpublished Draft. Existing Email/Template update changes **HTML only** and requires an eligible Draft; differing JSON metadata or text companions block the whole selection. Image deploy requires a Marketing workspace, its default language and root placement; existing Images require one unpublished primary Draft and exact metadata, filename and MIME. Only the binary bytes may change. Additional variants, non-root placement and unresolved dependencies remain blocked. Authoring-baseline conflict and sibling-aware update safeguards are not integrated into deploy.
- Delete executes exact selected items/languages for the five public families, with API-led acceptance or rejection and fresh native identity/readback checks. It requires no ownership paperwork or Draft-only admission; local files remain untouched and historical revision/reference preservation is unproven.
- Offline `sf content info --json` labels Email/Template/Image retrieval and deletion **experimental**; Document/Audio retrieval, deploy and loose-image upload are also listed. Narrow installed Email/Template and same-org PNG Image evidence does not qualify every source shape. Cross-org Image acceptance is pending; loose-image upload has no live-upload proof. Internal family profiles do not add public operation support.

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

Open the browser login flow, assign an alias and confirm the authenticated org:

```sh
sf org login web --alias isolated-source
sf org display --target-org isolated-source
```

For a sandbox or org that uses a custom login host, add `--instance-url <login-url>` to `sf org login web`.

### Choose a default org

Run the following project-local configuration commands **only inside a valid Salesforce project containing `sfdx-project.json`**:

```sh
sf config set target-org=isolated-source
sf config get target-org
```

Outside a Salesforce project, pass `--target-org isolated-source` on each org-backed command, or explicitly choose a global default for commands without a project-local default:

```sh
sf config set target-org=isolated-source --global
sf config get target-org
```

A project-local default overrides the global default. Explicit `-o` / `--target-org` overrides the configured default for that command only, without changing either default. For example, read workspaces from another authenticated org alias:

```sh
sf content list workspace --target-org isolated-target
```

### Install the plugin

Install the plugin with Salesforce CLI:

```sh
sf plugins install sf-plugin-cms
```

Confirm that the plugin loads without contacting an org:

```sh
sf content info
```

If Salesforce CLI asks whether you trust this unsigned plugin, check the package name before confirming. Installation does not grant CMS permissions; your signed-in user still needs access to the chosen workspace.

## Download, edit and save one Email

Run these commands from a folder where you want to keep your project, using the default org configured above. First find your workspace:

```sh
sf content list workspace
```

This lists one page; use `--page 1` for the next page if needed. In the examples below, replace `Marketing` with your workspace name and `Welcome` with the exact **API name** of an eligible Email, not its display title. Quote workspace names containing spaces. Choose a simple raw-HTML Email without dependencies and with only one variant; unsupported shapes are blocked rather than converted approximately.

### 1. Download the Email

```sh
sf content retrieve --workspace-name Marketing -m email:Welcome
```

This reads Salesforce and writes local source files under `./cms/` in the current directory; it does not change Salesforce. Retrieve uses the workspace default language automatically. Use `--language en_US` to select another language or `--output-dir ./project` to choose a different project root.

### 2. Edit its HTML

The command prints a `Definition:` path. Keep that JSON file and its declared companions together. Open the `.html` companion listed in the definition, make a small HTML change and save it. Do not change the identity fields or JSON metadata for this first update; changing existing-item JSON metadata or text content is not supported by deploy.

The next examples assume the printed definition is `./cms/Marketing/email/Welcome.cms-email.json`. **Replace that entire path with your actual printed path**: the directory uses the workspace API name, which can differ from its display name. Paths containing spaces need quotes.

### 3. Preview the change

```sh
sf content deploy --workspace-name Marketing --default-language -m email:Welcome --preview
```

Deploy executes by default; use `--preview` for authenticated read-only preflight with no org mutations, content writes or report allocation. Existing diagnostic invocation logs remain enabled. Preview rejects `--report` and `--report-dir` before org access. Check that the proposal is UPDATE for the expected item, or unchanged if the supported content already matches. A CREATE proposal means no matching destination was found; stop if you intended to update an existing Email. Resolve any blockers before continuing. Preview does not guarantee a later apply will succeed.

### 4. Apply deliberately

```sh
sf content deploy --workspace-name Marketing --default-language -m email:Welcome --report
```

Reporting is opt-in: `--report` creates an exclusive per-run directory at `./logs/cms/reports/<timestamp>-<unique-id>/` relative to the invocation cwd. `--report-dir <path>` implies reporting and overrides that location with an exact directory that must **not already exist** (its parent must exist). Neither option means no report files/directories or hidden replacement journals. Keep reports when requested; without them there is no crash-surviving structured operation journal. The command checks the whole selection again before writes. This saves a Draft; it does not publish, activate or send anything. A failure can leave earlier successful changes in place: there is no automatic rollback or retry.

To create supported content in another workspace or org, use its explicit destination selectors and preview first. Only qualified source shapes are admitted; source IDs do not choose the destination.

## Download, edit and save one PNG Image

This PNG walkthrough is an example, not a format restriction; other binary Images use the same API-led admission and retain their declared MIME and companion filename. Select a root-level, single-variant native PNG Image in a Marketing workspace and its default language. Existing targets must be unpublished primary Drafts with their native filename already exactly `<apiName>.cms-image.media.png`. Retrieval normalizes the companion filename, so retrieval alone does not prove deploy eligibility. A native filename mismatch blocks deploy; filename and metadata updates are unsupported. Download it first:

```sh
sf content retrieve --workspace-name Marketing -m image:Hero
sf content deploy --workspace-name Marketing --default-language -m image:Hero --preview
```

Replace the example path with the printed `Definition:` path. Keep the `sf-cms-media-source@1` definition and its declared `.cms-image.media.png` companion together. An unchanged preview makes zero writes. To update, edit **only the PNG companion bytes**, preserving its filename, MIME, JSON metadata and identity. Preview again and require UPDATE for the intended unpublished primary Draft before applying:

```sh
sf content deploy --workspace-name Marketing --default-language -m image:Hero --report-dir ./hero-report
```

Use a fresh, nonexisting report directory for each apply. A missing destination proposes Draft CREATE; preview with explicit destination selectors first. This profile requires nonempty binary Image bytes with a safe declared MIME and companion path; API-led format and size acceptance applies as described above. For this Image workflow, URL-only sources, nested folders, multiple variants, published targets and metadata-changing UPDATE remain unsupported. Documents use the separate bounded CREATE/bytes-only UPDATE/exact unchanged profile below. Apply independently verifies exact bytes and stable native identity; unchanged requires matching metadata and bytes. Read-only drift checks are not an authoring-baseline conflict guard.

Installed ordinary primary same-org acceptance covers actual PNG retrieval, portable CREATE, unchanged, bytes-only UPDATE and final unchanged, with exact byte readbacks, stable identity and 75 preexisting items unchanged. This is narrow development-artifact evidence, not released-package qualification. **Cross-org Image acceptance is pending**; do not infer it from Email/Template acceptance or loose-file upload.

## Upload several local images

Use this separate API-led workflow for loose Image files, not for deploying retrieved Image definitions. Repeat `--file` for each image:

```sh
sf content upload --workspace-name Marketing --file ./Logo.png --file "./Summer Banner.jpg" --preview
```

This is a preview; without `--preview`, upload creates Drafts by default. Titles keep the full filename including its extension; API and URL names are derived from it. Unsafe names, invalid files or destination collisions block the upload; existing images are not overwritten. Reporting is optional; `--report-dir` alone enables it at a fresh directory:

```sh
sf content upload --workspace-name Marketing --file ./Logo.png --file "./Summer Banner.jpg" --report-dir ./reports/images-001
```

Only a proven enhanced-workspace root is supported. Upload remains unqualified: tests and packed CLI previews are retained, but no live upload has been performed. Metadata readback is not binary-byte proof. A successful preview is not proof that Salesforce will accept CREATE.

## Understand results

### Diagnostic logs and sensitive content

CMS commands automatically write one diagnostic log under `logs/cms/` in the current working directory, for example `2026-10-19T21.11.00.000Z.log` (UTC ISO timestamp with colons replaced by dots). The header records the installed plugin version and exact received command tokens, subject to secret redaction; it does not reconstruct your shell's original quoting. The log includes terminal diagnostics, warnings, errors and stack traces. Native tables are the exception to terminal text mirroring: their complete rows and columns are recorded as structured data, not a duplicate rendered table. Logging failures produce a diagnostic warning rather than changing the command outcome.

Add `--api log` to opt in to request/response payload details at the instrumented CMS API boundaries. Without it, payload details are not enabled, but request metadata and errors can still contain sensitive information. This is not a raw HTTP wire capture: unavailable SDK status/raw-body evidence is labeled unavailable, and binary downloads/multipart files are represented by metadata rather than dumped bytes.

Secret redaction targets recognized credentials; it is **not comprehensive PII redaction**. Logs, API payloads, retrieved sources and reports may contain customer content or other sensitive data. **Inspect before sharing** and apply your organization's access and retention policies. Add `logs/cms/` to the **consuming project's `.gitignore`**; ignoring this plugin repository's logs does not protect other projects. Consider excluding retrieved customer content and reports from version control too.

- **Preview / dry-run:** no Salesforce writes. You still need to sign in because destination checks read Salesforce.
- **Unchanged:** the supported content already matches; no write is needed.
- **Blocked:** a safety, selection, permission or unsupported-content check prevented the operation. Read the diagnostics and fix the cause rather than adding `--apply` to bypass it.
- **Partial:** some items completed, others did not. Inspect each item and the remaining/unattempted list; do not assume the entire batch succeeded.
- **Failed or uncertain / ownership-uncertain:** preserve the report. A request may have reached Salesforce even when its result could not be confirmed. Reconcile the recorded destination identities read-only before trying again; **do not retry blindly**.

Deploy apply stops at the first failure or uncertain outcome. Retrieve can leave partial local progress. Neither workflow provides automatic rollback or resume. To download again over differing local files, first back up or commit your edits; only then consider retrieve's explicit `--overwrite` option. It is not a general folder cleanup.

A deploy report is not proof that no remote change occurred: remote mutation and local journal persistence are not one atomic transaction. If a write may have reached Salesforce but its result cannot be durably recorded or verified, preserve the returned outcomes and, when reporting was enabled, `content-deploy-run.json` and its per-item reports. Reconcile pending or uncertain entries read-only using the available destination org/workspace, content/variant identities and request evidence, even when no returned ID was saved. Without reporting, interruption loses the in-memory structured journal; diagnostic logs may be insufficient for reconciliation. Do not replay a completed write or retry an unresolved one. After reconciliation, correct blockers and preview again; if reporting is wanted choose a new nonexisting report directory. These journals are not a resume mechanism.

For scripts, add `--json` and inspect both the exit code and item diagnostics: `0` means success, `2` means partial, and `1` means blocked/failed for command-owned results. CLI parsing/authentication errors can use Salesforce CLI's own error format. Use `sf content <command> --help` for installed flags.

## Command reference

| Command                     | Details                                                                                       |
| --------------------------- | --------------------------------------------------------------------------------------------- |
| `sf content info`           | [Plugin information](#sf-content-info)                                                        |
| `sf content list workspace` | [List workspaces](#sf-content-list-workspace)                                                 |
| `sf content list channel`   | [List workspace channels](#sf-content-list-channel)                                           |
| `sf content retrieve`       | [Retrieve supported Email, Template, Image, Document and Audio sources](#sf-content-retrieve) |
| `sf content deploy`         | [Deploy supported Email, Template, Image, Document and Audio sources](#sf-content-deploy)     |
| `sf content upload`  | [Upload local images](#sf-content-upload)                                              |
| `sf content publish`        | [Publish a Draft Email](#sf-content-publish)                                                  |
| `sf content unpublish`      | [Unpublish a Published Email](#sf-content-unpublish)                                          |
| `sf content delete`         | [Delete exact items and languages](#sf-content-delete)                                          |

All eight org-backed commands use your configured Salesforce CLI default org when `--target-org <username-or-alias>` (short form `-o`) is omitted. An explicit `-o` overrides that default; without either, the standard Salesforce CLI org-resolution error applies. Offline `content info` needs no org. Org defaults do not supply or broaden workspace, language, source, mutation or ownership selectors. They prefer the `/services/data/latest` REST routes by default, while keeping a numeric Core/JSforce connection version. Read-only CMS and native-query capability checks run before command operations; only an explicit unsupported-version or missing-route response permits a temporary `67.0` fallback. Authentication, permission and transport failures do not trigger fallback. Pass `--api-version <numeric-version>` to select a numbered API explicitly (without automatic fallback), or `--api-version latest` to request the default policy. Add `--json` for machine-readable Salesforce CLI output. Without `--json`, list commands print compact tables; other commands render their command-specific human-readable output.

### `sf content retrieve`

Retrieve supported Emails, Email Templates, Images, Documents and Audio into a local project. With a configured default org, the minimal command is:

```sh
sf content retrieve --workspace-name "Content Workspace for Marketing Cloud"
```

It selects all five currently admitted types in the workspace default language and writes under `./cms/<workspaceAPI>/` relative to the current directory. The workspace API name can differ from its display name. Unsupported items are reported as blocked, not silently omitted; this is not a complete workspace backup. Override the org with `--target-org`, language with `--language`, and project root with `--output-dir`. This command reads the org and writes selected local files only; use the separate bounded `deploy content` workflow below for supported Email/Template, Image, Document or Audio CREATE, UPDATE and unchanged operations. All-of-type selection expands the requested scope, not the supported source shapes.

```sh
# One exact API name, or several exact names.
sf content retrieve --workspace-name Marketing -m email:Welcome
sf content retrieve --workspace-name Marketing -m email:Welcome -m email:Reminder
# Type alone selects all of that type; repeat for several types. No --all is needed.
sf content retrieve --workspace-name Marketing -m email
sf content retrieve --workspace-name Marketing -m email -m emailTemplate
# Mix exact members of different types.
sf content retrieve --workspace-name Marketing -m email:Welcome -m emailTemplate:Welcome_Template
# Native content key or parent content ID, not a variant ID; select a non-default language.
sf content retrieve --workspace-id 0ZuSOURCE --content-type email --content-key-or-id CONTENT_KEY --content-key-or-id PARENT_CONTENT_ID --language en_US
# Explicitly permit replacing differing selected local files.
sf content retrieve --workspace-name Marketing -m email:Welcome --overwrite
```

Names, keys, IDs and paths above are illustrative; use identities visible in your own workspace.

Type selectors accept exact friendly names or their `sfdc_cms__`-qualified names only for families admitted by that operation: retrieve, deploy and delete accept `email`, `emailTemplate`, `image`, `document`, `audio`. For example, `emailTemplate` and `sfdc_cms__emailTemplate` select the same family. Case and whitespace are not normalized. Aliases do not enable unsupported operations or alter canonical API identifiers and portable contracts.

- Required scope: exactly one `--workspace-id -w` / `--workspace-name -W`. Omitted `--target-org -o` uses the configured default org; omitted language uses the workspace default, as does `--default-language -L`. Use `--language -l` to override it, never together with `-L`. Omitted `--output-dir -d` uses the current directory as project root. Blank selectors/paths and conflicting workspace/language selectors block. No selection flags means all currently admitted types, not all CMS families. Explicit `-t` still requires a member selector or `-a`; `-a` alone is invalid.
- Choose exactly one selector style: repeatable `--metadata -m`, or separate flags. Metadata accepts exact short or qualified `Type` (all of that type) or `Type:ApiName` (exact name), splitting only at the first colon. It cannot be mixed with `--content-type`, `--api-name`, `--content-key-or-id`, or `--all`. Empty/unknown types and empty names are invalid; no wildcard or comma-separated selector syntax is provided.
- Separate flags require `--content-type -t` plus exactly one of repeatable `--api-name -n`, repeatable `--content-key-or-id -i`, or `--all -a`. Name/key/ID mode requires one distinct type; `--all` accepts repeated types. Selectors are exact and case-sensitive; native selectors match the content key or parent content ID, never the variant ID. Overlapping selectors resolve each native variant once; distinct parents colliding on a portable output identity are blocked even with overwrite.
- `--all` selects only the named types in the explicit workspace/language, not all workspaces, languages, dependencies, or CMS families. Explicit missing/ambiguous members remain blocked even alongside a type-wide selector; a completely enumerated empty type succeeds with zero selected items.
- Admission uses native `ManagedContentVariant` inventory through the selected CMS REST API route, not search-index completeness. Read-only workspace, Email/Template detail and native-query requests through `latest` have bounded two-org qualification resolving to API `68.0`; newer explicit numeric versions are not artificially rejected. It covers principal-visible, nondeleted records, across all languages/statuses, with independent unfiltered parent-sibling reads and GET-detail binding. Keyset reads require empty terminal pages, grouped-count parity and matching repeat reads; limits are 1,000 pages, 250,000 rows and fewer than 2,000 parent groups per scope. This is not an atomic snapshot or evidence about inaccessible/deleted content; scope, count or detail drift blocks retrieval.
- Native GET provenance `source: "User"` is normalized only when both parent and variant agree; unknown, conflicting or one-sided provenance blocks retrieval. Provenance is not editable content and is omitted from portable source; original body and detached source identities remain checked.
- Only the qualified native raw-HTML Email/Email Template profiles are eligible: exact selected language, one independently proven native variant across all sibling languages/statuses, supported body/envelope fields, and reconstructable dependency-free HTML. Folder evidence must be null or the workspace's distinct proven root folder ID in both parent and variant; unknown/non-root placement is blocked. Additional variants, unresolved references/personalization, unsupported components or shapes, and missing/ambiguous identities are not silently dropped. This is not support for every Email shape, folder hierarchy, or multivariant content. Legacy Email and other families remain unsupported, except the bounded Image, Document and Audio retrieval described below.
- **Bounded Image retrieval:** `sfdc_cms__image` uses the same exact-name, native key/parent ID, all-of-type and mixed metadata selectors. For example, `sf content retrieve --workspace-name Marketing -m email:Welcome -m image:Hero`. Root-level, single-variant Images are bound to native parent/variant/workspace evidence and written under `cms/<workspaceApiName>/image/<apiName>.cms-image.json` using `sf-cms-media-source@1`. Native media is downloaded as a declared binary companion (for PNG, `<apiName>.cms-image.media.png`) and verified against its native byte/MIME/hash evidence; external media remains explicitly URL-only without fetching. Resolved identity drift blocks local writing. Binary Images use API-led admission for CREATE, bytes-only UPDATE or unchanged under the deployment safeguards below; URL-only evidence remains undeployable.
- **Bounded Document retrieval:** `sfdc_cms__document` uses the same selectors, native identity/workspace evidence, root/single-variant admission and overwrite controls. Native Document bytes and safe declared MIME are preserved without UTF-8 conversion or a source-level 10 MiB cap in `cms/<workspaceApiName>/document/<apiName>.cms-document.media.<suffix>`, referenced by `<apiName>.cms-document.json` using `sf-cms-media-source@1`. The companion suffix comes from safe native filename evidence, or `bin` when unavailable; safe same-stem paths, nonempty bytes and native size/hash integrity remain required. Explicit download budgets still bind. Salesforce determines native format and size acceptance; local admission does not establish native acceptance for every format or size. External media stays explicitly URL-only and is not deployable. Retrieval alone does not prove deployment eligibility. Document retrieval, CREATE, bytes-only UPDATE and exact unchanged remain unqualified. Bounded two-org development-artifact acceptance covers the tested text/plain profile; released-package verification remains separate.
- **Bounded Audio retrieval:** `audio` selects `sfdc_cms__audio` with the same selector and overwrite controls. Native root-level, default-language, single-primary Audio is written as `cms/<workspaceApiName>/audio/<apiName>.cms-audio.json` with its declared binary companion, preserving exact bytes and native identity/integrity evidence. Audio deployment implements CREATE, bytes-only UPDATE and exact unchanged, all unqualified. Bounded two-org development-artifact acceptance covers the tested 844-byte WAV profile: CREATE, bytes-only UPDATE, zero-write unchanged and public retrieval with independent native identity, inventory and exact-byte readbacks. This does not establish general-format or released-package qualification; retrieval alone does not prove deploy eligibility.
- Writes portable v2 JSON under `cms/<workspaceApiName>/email/<apiName>.cms-email.json` or `cms/<workspaceApiName>/emailTemplate/<apiName>.cms-email-template.json`, with same-stem `.html` and, when present, `.txt` companions. These are editable source files, not a workspace backup manifest. Source IDs remain detached retrieval evidence, not deployable identity. Only the bounded Email/Template deploy workflow below accepts these portable sources; this layout alone does not prove that an item is deployable.
- Existing differing selected files require `--overwrite -x`, including during all-of-type retrieval; unchanged retrieval leaves their bytes stable. Only files owned by each selected item may be replaced or removed; unrelated and remote-absent local items are retained. Local writes are not an item/batch transaction: an I/O failure can leave partial local progress. There is no rollback or project-wide cleanup.
- Complete native selection is resolved before local writes. Independent item admission/write failures may allow other selected items to complete; fatal authentication/scope read failures stop further acquisition and retain unattempted identities. A complete inventory does not mean every selected item passes strict source admission.
- JSON uses `sf-cms-content-retrieve@1` with the established seven-key CMS envelope. The same batch-shaped result for one or many items contains `scope`, `selection`, native `resolution` when available (inventory proof and unresolved selectors), `items` (identity, `operation: retrieve`, outcome, absolute path receipt, detached source evidence, diagnostics), `summary`, and `unattempted`. Successful items are `retrieved` or `unchanged`; blocked scope leaves selections unattempted. Success exits `0` (including a proven empty type); mixed completion exits `2` with `partial`; no completed items with blockers exits `1`. CI must inspect both exit status and item/summary diagnostics, not treat a partial batch as complete. Result content and file receipts contain no generated timestamps; envelope provenance records the invocation time.
- Qualification is limited to installed development-tarball retrieval across two orgs with `latest` and explicit `68.0`, including selector, overwrite and all-of-selected-types cases. Strict source admission still blocks unsupported items; `RETRIEVE_SOURCE_BLOCKED` does not expose a specific subcause. This evidence does not qualify arbitrary business content or every source shape, and does not establish released-package qualification or publication.

### `sf content deploy`

Deploy portable v2 Email/Email Template definitions or `sf-cms-media-source@1` binary Image/Document/Audio definitions and their declared companions to an explicitly selected destination. Documents support CREATE, bytes-only UPDATE and exact unchanged, all unqualified; bounded two-org development-artifact acceptance covers the tested text/plain profile. Installed same-org and cross-org development-tarball acceptance covers the bounded Email/Template workflow, not general CMS upsert. Image acceptance covers only the installed same-org ordinary primary PNG workflow; cross-org Image acceptance is pending. Publication and installation verification are separate from that operation-specific evidence; the conservative runtime qualification labels remain unchanged.

```sh
# Preview one retrieved item in the source org; diagnostic logs remain enabled.
sf content deploy --target-org source-org --workspace-name Marketing --default-language --source-dir ./cms/Marketing/email/Welcome.cms-email.json --preview --json
# After editing its HTML file, preview the target org.
sf content deploy --target-org target-org --workspace-name Marketing --default-language --source-dir ./cms/Marketing/email/Welcome.cms-email.json --preview --json
# Apply a local Email/Template subset with an exclusive new report directory.
sf content deploy --target-org target-org --workspace-name Marketing --default-language -m email -m emailTemplate --report --json
# Preview Audio with the configured default org; support remains unqualified.
sf content deploy --workspace-name Marketing --default-language -m audio:Intro --preview --json
```

- Use the configured default org or override it with `--target-org -o`; require exactly one `--workspace-id -w` / `--workspace-name -W`, and exactly one `--language -l` / `--default-language -L`. Choose repeatable `--metadata -m Type[:ApiName]` or repeatable `--source-dir -d`, never both. For example, `sf content deploy -W Marketing -L -m email:Welcome` selects one item without an explicit path. Metadata selects only the conventional `cms/<destination workspace API name>/<type>/` subtree under the invocation directory after resolving the destination workspace; a requested missing exact member blocks preflight. No selectors means an error, not all local content. Source-dir accepts definition files or directories, including repeated overlapping paths; directory traversal finds recognized definitions, not arbitrary JSON or standalone companions. Optional repeatable `--content-type -t` filters apply only to source-dir. Both modes retain the existing same-stem companion and no-follow path guards. `--definition-file` is not supported. Overlapping paths deduplicate; distinct definitions targeting one identity block deployment.
- Deploy executes by default; `--apply` and `-a` are removed with no compatibility route. `--preview` performs only local validation and authenticated read-only preflight, with no org mutations, content writes or report allocation; diagnostic invocation logs remain enabled. Preview rejects either reporting option before org access. `--report` opts into an exclusive `./logs/cms/reports/<timestamp>-<unique-id>/` run directory under invocation cwd; `--report-dir -r` implies reporting at that exact fresh directory instead. Both together use the custom path. Neither means no report files/directories or hidden journals; no crash-surviving structured journal is available. No start/preview subcommands exist.
- Match exact destination workspace, type, API name, and language using native inventory. No match proposes Draft CREATE, one supported match proposes UPDATE or unchanged, and ambiguous/conflicting matches block. Detached retrieval IDs never choose the destination. Only dependency-free raw-HTML Email/Email Template shapes, API-led binary Images, binary Audio and API-led binary Documents with independently proven root placement and a single native variant are admitted; unresolved references, additional variants, non-root folders and other families remain unsupported. Existing Documents may propose bytes-only UPDATE or exact unchanged; metadata, filename, MIME, language and type changes remain unsupported. There is no dependency auto-inclusion or general reference-mapping workflow in this command.
- Email/Template CREATE uses admitted portable metadata and reconstructed supported HTML/text fields and creates an unpublished Draft. Existing-target Email/Template UPDATE supports **`rawHtml` only**, preserves the destination identity and other fields, and requires an eligible Draft. Differing JSON metadata or `.txt` bytes on an existing target block the **entire selection** before any write; they are not silently discarded or called unchanged. Equal supported content reports unchanged with zero writes. The local v2 loader's ability to reassemble text or JSON is not proof those fields can be updated.
- **Bounded Document deployment:** root placement in a canonical Marketing workspace and its default language, opaque nonempty runtime-representable bytes, safe native MIME and a safe ASCII companion filename are required. Document admission has no client format whitelist, UTF-8 conversion, suffix restriction or 10 MiB cap; Salesforce determines format and size acceptance. Explicit caller download budgets still bind. A missing destination proposes one unpublished Draft CREATE. An existing Document must be a single-primary unpublished Draft with unchanged metadata, native filename, MIME, language and type. Exact metadata, native filename, MIME and bytes report unchanged with zero writes; only differing bytes may propose UPDATE. All other Document differences block the whole selection before mutation. Document UPDATE never falls back to Image transport. Independent native identity and exact-byte readback are required for CREATE and UPDATE completion; UPDATE journals record a succeeded update operation with zero created parents. Bounded two-org development-artifact acceptance covers the tested text/plain profile; released-package verification remains separate.
- **Audio deployment (unqualified):** binary Audio requires root placement in a canonical Marketing workspace and its default language, nonempty bytes, a safe declared MIME and companion path. Bytes and MIME are preserved without conversion; Salesforce determines format and size acceptance. A missing destination proposes unpublished Draft CREATE. An existing Audio target must be one unpublished primary Draft with unchanged metadata, native filename, MIME, language and type. Exact matching bytes report unchanged with zero writes; only bytes may change for UPDATE. CREATE/UPDATE completion requires independent native identity and exact-byte readback. Bounded two-org development-artifact acceptance covers the tested 844-byte WAV profile for CREATE, bytes-only UPDATE, zero-write unchanged and public retrieval. Independent native identity, inventory and exact-byte readbacks passed; this is not general-format or released-package qualification.
- The upcoming **0.19.0** implementation removes invented Document format/size gates across retrieval, source loading, CREATE and bytes-only UPDATE. Salesforce determines native acceptance; safe paths/MIME, nonempty runtime-representable bytes, explicit caller budgets and identity/integrity checks still bind. Expanded-format and released-package qualification remain separate. Video deployment remains closed; 0.20 qualification and local sync are deferred.
- Whole-selection preflight completes before mutation, including source/companion validity, duplicate identities, unsupported differences, destination admission and operation-specific checks. Execution reacquires source/destination proof, retains intent and outcomes in memory, executes sequentially and independently reads back native parent/detail and intended content. When reporting is enabled, sanitized intent is persisted before dispatch; allocation or initial persistence failure blocks dispatch. The optional batch journal is `content-deploy-run.json`, with per-item reports referenced from its entries. Stop at the first failure or uncertain outcome; report verified prior successes and remaining unattempted items. No automatic retry, rollback, resume, deletion, publication, activation or sending is performed.
- The `sf-cms-content-deploy@1` envelope reports mode, scope, selection, proposed operations, actual per-item outcomes/readbacks, report paths, summary counts and unattempted items. Success exits `0`; mixed completion is `partial`/exit `2`; blocked/failed with no completed items exits `1`. CI must inspect returned status and uncertain/unattempted counts (and durable reports when enabled), not equate a planned write with a completed one. Runtime emits `qualification: "unqualified"`, `DEPLOY_UNQUALIFIED` and conservative help text; bounded installed evidence does not broaden those labels. Dry-run itself never proves a later mutation.
- Installed development-tarball qualification covers source and target Email/Template CREATE, raw-HTML UPDATE, unchanged/repeated-update zero writes, mixed update/unchanged, whole-selection JSON/text blockers and malformed/missing/duplicate selection blockers, with independent exact readbacks. This is narrow installed qualification, not released-package qualification, universal shape support, or authorization to replay retained Draft fixtures.

### `sf content upload`

Upload explicit local images directly, without an export package or JSON input map. Repeat `--file` once per image in upload order; quote paths containing spaces. Select exactly one workspace by ID or exact case-insensitive name. Execution is the default. `--preview` performs local validation plus read-only root/collision preflight with no mutations, content writes or report allocation; diagnostic invocation logs remain enabled. Preview rejects `--report` and `--report-dir` before org access. The old `upload images` routes and `--apply` flag are not supported.

```sh
sf content upload --workspace-name "Main Site" --file "./Banner with spaces.PNG" --file ./Logo.jpg --preview
sf content upload --workspace-id 0ZuTARGET --file ./Logo.jpg --report --json
```

- Only a proven enhanced workspace with a distinct root folder is eligible. The CREATE target is its exact `rootFolderId`, never its workspace ID or a guessed folder.
- The title is the **full filename including extension**. Lowercase API and URL names use that same full filename: separator runs become underscores or hyphens respectively (`Banner with spaces.PNG` → `banner_with_spaces_png` / `banner-with-spaces-png`). No truncation, suffixing, or collision renaming occurs.
- Explicit regular, nonempty Image files use API-led admission without a format whitelist or client size cap. Recognized signatures provide MIME hints only; unfamiliar bytes use `application/octet-stream`. Extension and signature disagreement is not a local format gate. Filenames may contain only ASCII letters, digits, spaces, periods, underscores, and hyphens, must start with a letter after derivation, and cannot contain consecutive periods or reserved Windows device basenames. Unsafe names, symlinks/junctions, redirected paths, duplicate paths/file identities, and batch naming collisions fail closed. There is no client-side name-length cap, truncation, decoder-level image validity, or malware guarantee; filesystem and Salesforce name limits remain authoritative and can reject a file or CREATE.
- Exact title/API-name/URL-name destination collisions, compared case-insensitively across all workspace content families, fail the complete batch preflight. Complete workspace collision inventory is bounded to 1,000 pages of 250 records; inability to prove completeness blocks upload. No overwrite or updates are supported.
- Execution revalidates local identity/hash, root and collisions before sequential CREATEs, stopping at the first failure or uncertainty without retries, rollback or resume. It creates Drafts only; no publication or activation occurs. Reports are opt-in: `--report` allocates `./logs/cms/reports/<timestamp>-<unique-id>/` relative to invocation cwd; `--report-dir` implies reporting at that exact fresh directory and overrides the default. Enabled reporting records pending intent before dispatch; allocation or initial persistence failure blocks dispatch. Neither flag means no report files/directories or hidden journals and no crash-surviving structured journal.
- The seven-key `sf-cms-images-upload` envelope uses contract version `1.0.0` (internally selected). Results contain `mode` (`execute` or `preview`), `outcome`, distinct `target`, ordered immutable `intents` (names, media type, size, SHA-256; never bytes), `byteProof: "unavailable"`, nullable `reportFile`, and in-memory `report` operation evidence. Outcomes are `ready`, `completed`, `blocked`, `failed`, or `ownership-uncertain`; blocked/failed exit `1`, success exits `0`. Invalid local inputs are rejected before authentication where possible. Resolving a workspace and proving destination collisions requires authenticated reads even in dry-run.
- When enabled, reports live at `image-upload-run.json`; a fallback failure report may be used if the normal report cannot persist. Without reporting, success and typed failures still return in-memory operation states and known remote identities. `ownership-uncertain` means CREATE may have succeeded: inspect returned operation identities and reconcile the destination before any new execution; inspect durable reports only when enabled. The CLI does not expose arbitrary transport error bodies. Metadata readback is **not binary-byte proof**; downloaded bytes are not verified.

This independent feature's qualification consists of controlled-transport service/command tests and packed CLI dry-runs, but **no live image upload has been performed**. A successful dry-run does not prove that Salesforce will accept a later CREATE.

### `sf content info`

Returns the offline `sf-cms-info@1` capability envelope. This is the safest first command because it does not contact an org.

```sh
sf content info --json
```

The current info contract lists the nine public commands and Email, Email Template, Image, Document and Audio retrieval capabilities. Audio capability entries are `content.retrieve.audio`, `content.deploy.audio.create`, `content.deploy.audio.update` and `content.deploy.audio.unchanged`, all **unqualified**; bounded two-org development-artifact acceptance covers the tested 844-byte WAV profile, not general-format or released-package qualification. Do not infer native qualification from capability discovery or command availability. Document capability entries are `content.retrieve.document`, `content.deploy.document.create`, `content.deploy.document.update` and `content.deploy.document.unchanged`, all **unqualified**; bounded two-org development-artifact acceptance covers the tested text/plain profile; released-package verification remains separate. Portable deploy covers Email/Email Template create/update/unchanged, binary Image and Audio create/bytes-only-update/unchanged and API-led binary Document create/bytes-only-update/exact unchanged. All deploy operations remain **unqualified** in runtime capability output; Image evidence is same-org only, with cross-org acceptance pending. Loose-image upload is a separate unqualified CREATE workflow, not portable Image deployment. Authoring-baseline and sibling-aware update safeguards are not integrated into deploy.

`contracts.commandResults` describes only public commands with CMS-owned envelopes; list workspace/channel retain their existing bounded page results. The family registry is available as `internalRegistry` with `scope: "internal-engine-only"`, including its fixture identity and provider-package bounds. Those internal retrieval/reference profiles do not extend public retrieve/deploy family support or accept workspace export packages through those commands. There is one current info contract; `--contract-version 2` blocks.

Info reports `latest` as the default REST preference and `67.0` as the tested fallback baseline. Operation-specific API qualification is not broadened by capability discovery. Installation alone does not prove org permissions or endpoint availability.

`--contract-version <major>` defaults to `1`. Any unsupported major returns a `blocked` `sf-cms-info` envelope with diagnostic code `UNSUPPORTED_CONTRACT_VERSION` and exit `1`, without org access.

### `sf content list workspace`

Lists one bounded page of CMS workspaces. Use `--name-fragment` to filter workspace names, and use `--page` with `--page-size` to request a specific page.

```sh
sf content list workspace
sf content list workspace --name-fragment Marketing
sf content list workspace --page 1 --page-size 25 --json
```

Key flags:

- `--name-fragment <text>`: return workspaces whose names contain the value.
- `--page <number>`: zero-based page number; the first page is `0`.
- `--page-size <number>`: maximum number of items requested for that page; must be at least `1`.

The command requests only the selected page; it does not automatically follow subsequent pages.

### `sf content list channel`

Lists one bounded page of channels assigned to a specific workspace.

```sh
sf content list channel --workspace-id 0Zu...
sf content list channel --workspace-id 0Zu... --page 1 --page-size 25
```

Key flags:

- `--workspace-id <id>`: required CMS workspace content-space ID.
- `--page <number>`: zero-based page number.
- `--page-size <number>`: maximum number of channels requested; must be at least `1`.

The command requests only the selected page; it does not automatically follow subsequent pages.

## Additional public lifecycle commands

### `sf content publish`

Previews or publishes one exact unpublished Draft `sfdc_cms__email` variant. Selection requires exact `--workspace-id` and `--api-name` values plus exactly one of `--language` or `--default-language`. Dry-run is the default:

```sh
sf content publish --workspace-id 0Zu... --api-name WelcomeEmail --language en_US --json
```

Apply requires a new report directory and an explicit acknowledgement that CMS publication changes lifecycle state but does not send the Email:

```sh
sf content publish --workspace-id 0Zu... --api-name WelcomeEmail --default-language --apply --acknowledge-no-send --report-dir ./cms-publish-report --json
```

The command writes `content-publish-run.json` with pending intent before one non-retried, variant-scoped publish request. Content references are excluded. It then performs bounded read-only convergence checks and independently reconciles the parent, selected variant, siblings, and complete workspace Email inventory. Success requires only the selected variant to become `Published` without body changes. Transport, response, persistence, or readback ambiguity is reported as `ownership-uncertain`; never retry until the recorded workspace, content ID, variant ID, and optional deployment ID are reconciled. This command does not start a Flow, transactional send, journey, or campaign. Other content families and parent-scoped publication remain unsupported; bounded Email DELETE is documented separately below.

### `sf content unpublish`

`sf content unpublish` mirrors the exact Email selector used by publish: `--workspace-id`, `--api-name`, and exactly one of `--language` or `--default-language`. Dry-run is the default. Apply requires a new `--report-dir`, `--apply`, and `--acknowledge-active-use-stops`; the acknowledgement is checked before org access because unpublish removes the content from active use but does not delete it.

The command accepts only an exact `isPublished=true,status=Published` Email and freshly proves that its parent has exactly one variant. Preview explicitly reports `selectorScope: parent`. Apply writes `content-unpublish-run.json` with durable pending intent before one non-retried parent-scoped request containing only `contentIds`; it sends neither `variantIds`, `contextContentSpaceId`, nor the PUBLISH-only `includeContentReferences` field. Up to five readback attempts independently reconcile the parent, exact variant, single-variant sibling scope, and complete Email inventory. Success requires the sole child to transition to `isPublished=false,status=Draft` while preserving body hash, identity, API name, language, parent, and every unrelated inventory row. A definite HTTP 400 `JSON_PARSER_ERROR` rejection is retained separately from ownership-uncertain transport/readback outcomes, with sanitized status, Salesforce error code/message/request ID when available, request selector, and request-body hash.

An ambiguous unpublish result is not authorization to retry: preserve its journal and reconcile the exact recorded identities read-only before any further mutation.

### `sf content delete`

Execution is the default for exact `email`, `emailTemplate`, `image`, `document` and `audio` items, including ordinary existing content not created by this plugin. Repeat `-m/--metadata Type:ApiName` to select exact items. No selector, type-only selectors and wildcard item selectors (including `Type:*`) are errors before org access in execution and preview. Alternatively specify `--content-type` with an exact `--api-name` or repeated `--content-key-or-id` parent IDs/keys. There is no implicit family default, all-items mode or type-wide delete.

```sh
sf content delete --workspace-id 0Zu... -m email:WelcomeEmail --preview --json
sf content delete --workspace-id 0Zu... -m emailTemplate:WelcomeTemplate --language en_US --json
sf content delete --workspace-id 0Zu... -m image:Banner -m audio:Intro --language "*" --report --json
```

Language choices come from actual item inventory, not workspace language configuration. A sole actual language is automatic. For multiple languages, repeat `--language` for a subset, use `--language "*"` for all actual languages of the explicitly selected items, or choose interactively from a multi-selection prompt with All first. JSON, CI and non-TTY ambiguity fails with an explicit-language instruction. Empty selection or cancellation performs no mutation. Unsupported/unknown native classifications or multiple native identities for the same locale block deletion rather than guessing that every native variant represents a language.

No ownership report, public contract-version selector, permanent-delete acknowledgement or client Draft/unpublished-only admission is required. Salesforce may reject any requested target or state; a rejection is reported honestly. The single `sf-cms-content-delete@1` command result contains `mode`, `outcome`, `workspaceId`, exact native `targets` and optional `execution` evidence. It is an early-access shape, not a compatibility promise for the former delete output.

Each selected Content/Translation target receives fresh exact identity, state, observed version and sibling checks before one sequential, non-retried native variant DELETE. Readback independently checks exact variant absence, remaining visible native identities and parent presence/absence. Last-language parent disappearance is an observation, not an explicit parent-delete request. Historical revisions, references and other collateral effects are not proven preserved; this is not a general non-cascading guarantee. There is no automatic unpublish, parent-delete fallback, replay, rollback or local synchronization/deletion. Saved local content remains untouched.

Reporting is opt-in. `--report` allocates `./logs/cms/reports/<timestamp>-<unique-id>/` under invocation cwd; `--report-dir` alone implies reporting at that exact fresh directory and overrides the default location. Enabled reporting writes `content-delete-run.json`, including pending intent before dispatch. Without either flag there are no report files/directories, no hidden journal and no crash-surviving structured journal. In-memory outcomes remain available on success, rejection, partial completion and uncertainty. Persistence failure blocks dispatch where possible and retains known outcomes after possible mutation; inspect returned identities and reconcile read-only before any new execution, never automatically retry. Later operations remain explicitly unattempted after a stop.

Preview rejects `--report` and `--report-dir` before org access and allocates no mutation report; it performs only validation and read-only preflight. Diagnostic invocation logs remain enabled, so preview is not a promise of zero filesystem writes overall.

## Common flags and output

- `--target-org <username-or-alias>` / `-o <username-or-alias>` selects the authenticated org. When omitted, all eight org-backed CMS commands use the configured Salesforce CLI default org; an explicit value overrides it.
- `--api-version <numeric-version|latest>` overrides the default `latest` CMS REST preference. An explicit numeric selection never falls back automatically. API selection is settled by read-only capability checks before command operations; failed mutations are never replayed at a fallback version.
- `--json` returns the command result in Salesforce CLI JSON mode for scripts and automation.
- `--page` is zero-based, and `--page-size` controls only the requested page size. Run another command with the next page number to continue paging.

Use `sf <command> --help` to inspect the installed command's current flags, for example:

```sh
sf content retrieve --help
```

## Versioned machine contracts

### Integration boundary and ownership

The supported integration boundary is the Salesforce CLI subprocess. Automation should:

1. Run `sf content info --json` and require the needed public capability. Info has one current contract, `sf-cms-info@1`; its `internalRegistry` is not public operation support.
2. Invoke only a public command and its documented `--contract-version` and `--json` options.
3. Consume only the documented results of those public commands. Do not expect workspace-import mappings, import ordering or general reference resolution from retrieve/deploy.

No public JavaScript API is promised; use only the CLI commands and their documented JSON results.

### Authoritative envelope

`sf content info --json` returns exactly these top-level fields. Placeholder plugin versions below are illustrative, not release identifiers; actual output reports the installed plugin version.

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
- `content.deploy.image.create|update|unchanged` — three separate `unqualified` capabilities, contract `sf-cms-content-deploy@1`; API-led binary Image admission, root/default language, bytes-only UPDATE of an eligible unpublished primary Draft. Cross-org Image acceptance is pending.
- `content.retrieve.document` — `unqualified`, contract `sf-cms-content-retrieve@1`; opaque bytes with safe native MIME and integrity evidence.
- `content.deploy.document.create`, `content.deploy.document.update` and `content.deploy.document.unchanged` — `unqualified`, contract `sf-cms-content-deploy@1`; API-led opaque binary CREATE, bytes-only UPDATE and exact unchanged. Bounded two-org development-artifact acceptance covers the tested text/plain profile; released-package verification remains separate. Metadata, native filename, MIME, language and type updates are unsupported.
- `content.retrieve.audio` — `unqualified`, contract `sf-cms-content-retrieve@1`; bounded binary Audio retrieval.
- `content.deploy.audio.create`, `content.deploy.audio.update` and `content.deploy.audio.unchanged` — `unqualified`, contract `sf-cms-content-deploy@1`; CREATE, bytes-only UPDATE and exact unchanged. Bounded two-org development-artifact acceptance covers the tested 844-byte WAV profile; general-format and released-package qualification remain separate.
- `images.upload.create` — `unqualified`, contract `sf-cms-images-upload@1`; loose files only, not portable Image deploy.
- `content.delete.email` and `content.delete.email-template` — `experimental`; `content.delete.image`, `content.delete.document` and `content.delete.audio` — `unqualified`. All use the single `sf-cms-content-delete@1` command shape; client family admission is not live API/state qualification.
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
