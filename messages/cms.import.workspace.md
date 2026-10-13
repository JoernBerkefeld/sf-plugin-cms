# summary

Safely plan or apply a create-only import into a CMS workspace.

# description

Validates the complete source workspace export locally before any org request, selects one destination workspace by exact ID or exact case-sensitive name, and defaults to a non-mutating dry run. The default profile checks each planned source content key for destination existence, but complete server conflict validation and API-name/URL-name availability are not established; named default-profile apply remains blocked. --native-copy-map instead selects bounded native raw-HTML email/template copies with fresh names and server-generated keys. --landing-page-map consumes paired landing-page/template exports, resolves the destination Draft template plus image and Data Graph prerequisites during preflight, and repeats immutable resolution immediately before CREATE. Source template resolution is title-first; canonical package identity and normalized body hashes are compatibility evidence, not historical provenance. Native and edited HTML is not resolved, rewritten, sanitized, or scanned through Phase 7. Pass --apply with a new --report-dir to create content.

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

`--brand-map` rows contain exact `source` and `target` objects. `source` is `{ "family": "cms", "type": "brand", "apiName": "..." }`; `target` supplies fresh `apiName`, `title`, and lowercase-hyphen `urlName`. The source package must be complete, strictly report-bound, and free of warnings, failures, rejected IDs, dependencies, and external references. Import requires a canonical Marketing workspace, proves complete exact Brand API-name/title/URL absence during dry-run and again immediately before each sequential POST, transports the complete raw body without a client-side shape allowlist, rewrites embedded `sfdc_cms:title` only when present, regenerates UUID-v4 values only for objective block nodes, omits `contentKey`, journals every ordered pending intent before the first mutation, never retries ambiguity, and independently verifies content-key plus variant Draft/unpublished readback. It never assigns the workspace default Brand, publishes, updates, or mutates dependent content.

`--form-map` rows contain exact `source` and `target` objects. `source` is `{ "family": "cms", "type": "form", "apiName": "..." }`; `target` supplies fresh `apiName`, `title`, and lowercase-hyphen `urlName`. The source package must be complete and contain a strict typed Form report for every selected raw item; `--allow-partial` does not permit partial Form packages. Import is limited to canonical Marketing workspaces, proves complete destination Form inventory, rejects exact case-sensitive API-name/title/URL collisions at dry-run and again immediately before CREATE, regenerates every block UUID v4, omits `contentKey`, preserves all other source body semantics, writes pending intent before mutation, and independently verifies returned content-key and variant-ID readbacks as Draft/unpublished. The minimal profile is live-proven; broader providers, blocks, actions, and references are transported without a client-side shape allowlist and remain subject to Salesforce validation. Definitive server errors are surfaced, while ambiguous ownership is never automatically retried. It does not update, publish, unpublish, or submit Forms.

`--form-handler-map` rows use source `{ "family": "cms", "type": "formHandler", "apiName": "..." }` and fresh target `apiName`, title, and lowercase-hyphen `urlName`. The source package must be complete even with `--allow-partial`, strictly loaded, report/raw bijective, and free of dependencies, external references, and warnings. Import regenerates the root UUID v4, omits `contentKey`, requires canonical Marketing workspace evidence, proves complete one-page Form Handler collision inventory twice, journals pending intent before one POST, never retries ambiguity, and independently verifies exact Draft/unpublished content-key and variant readbacks. Runtime submission, populated providers/bindings, UPDATE, publication, and broader lifecycle are unsupported.

`--consent-banner-map` rows use source `{ "family": "cms", "type": "consentBanner", "apiName": "..." }` and fresh target `apiName`, title, and lowercase-hyphen `urlName`. The complete strict package must contain the exact dependency-free Draft/unpublished body with empty providers and only the built-in Reject and Accept actions. Import regenerates every block UUID v4, omits `contentKey`, requires canonical Marketing workspace evidence, proves complete Consent Banner collision inventory during dry-run and immediately before one POST, persists pending intent first, never retries ambiguity, and independently verifies exact content-key and variant readbacks. Publication, site association, consent-configuration mutation, action invocation, UPDATE, and broader lifecycle are unsupported.

`--preference-page-map` consumes only typed partial Preference Page packages whose sole incompleteness is exact report-bound `REFERENCE_UNRESOLVED` channel/subchannel evidence. Rows select exact `cms/preferencePage` source API names, assign a fresh target API name, map every source channel and subchannel ID, and include one destination Brand selector if and only if source `{ contentKey }` Brand evidence exists. Destination `EngagementChannelType`, `CommSubscriptionChannelType`, their relationship, and optional workspace-scoped Brand are verified before mutation and again immediately before one non-retried public generic CMS POST. Import preserves body semantics except mapped dependencies, destination identity, and fresh package-wide UUID-v4 block IDs; omits root contentKey/title/urlName; rejects child variants; journals pending intent; and independently verifies exact Draft/unpublished readback. `createCpp`, variant creation, publication, default assignment, consent mutation, and runtime actions are forbidden.

`--email-fragment-map` rows contain exact `source` and `target` objects. `source` must be `{ "family": "cms", "type": "emailFragment", "apiName": "..." }` and resolve exactly once to `sfdc_cms__emailFragment`; missing, ambiguous, wrong-type, and duplicate selections are rejected. `target` contains fresh `contentKey` and `apiName`. Source content keys remain provenance rather than selectors.

`--document-map` opts into exactly one integrity-bound native `sfdc_cms__document` file from a strict v2 experimental-media export. Only exact `text/plain` with an ASCII-only filename ending in lowercase `.txt` is admitted, with a 10 MiB cap; Unicode title and content are allowed. The map selects exact source API name with optional title/workspace/language/server/version bindings and explicit identity strategies: API name/title use `preserve` or `fresh`, while content key/URL name also allow `generated`. Dry-run validates source bytes and destination collisions without CREATE. Apply requires a new report directory, journals pending intent and the request hash before one no-retry CREATE, rechecks evidence, and requires exact native metadata plus created-variant-bound downloaded-byte/hash/size proof. Failed or incomplete attempted CREATE remains ownership-uncertain; reconcile the retained journal before another attempt. No update, overwrite, deletion, publication, activation, rollback, or automatic retry is provided.

An isolated installed development tarball qualified one same-source-org CREATE-only import of a 94-byte `sfdc_cms__document` `text/plain` `.txt` file as an unpublished Draft, with independent exact metadata, SHA-256, MD5, size, and byte readback. This does not qualify cross-org transfer, full workspace restoration, released packages, other Document formats, or broader media families.

JSON uses `sf-cms-workspace-import@1` for default and other bounded profiles, or `sf-cms-workspace-import@2` for `--image-map` and `--document-map`, which require explicit `--contract-version 2`. Profile map flags are mutually exclusive; Document cannot be combined with Image, another profile map, `--editable-dir`, or `--definition-dir`. Package integrity and the independently declared manifest major are validated before org access. Exit 0 means success, 2 means partial with a usable result, and 1 means failed or blocked.

- Preview immutable Brand source definitions with independently authenticated original source and destination orgs:

  <%= config.bin %> <%= command.id %> --target-org target-org --source-org source-org --workspace-id 0ZuTARGET --source-dir ./cms-brand-baseline --definition-dir ./cms-brand-source --brand-map ./brand-import-map.json --contract-version 1 --json

`--definition-dir` admits bounded existing JSON string-leaf and strict dependency-free literal HTML edits only for Email/Email Template with `--native-copy-map`. Brand uses immutable definitions plus `--brand-map` and required `--source-org`; destination identity belongs to the map, not edited definitions. The original manifest-hashed `evidence/brand-source-inventory.v1.json` binds canonical all-language ManagedContentVariant sibling/count/recheck evidence, workspace, parent, raw/report hashes, source org and API version. It retains the sole exact `UNSUPPORTED_WILDCARD` warning; only qualified Brand source mode admits it, while generic Brand import still rejects warnings. Source auth never defaults to target auth, and both connections use the selected `--api-version`, which must match original source evidence. Planning and final pre-CREATE refresh reject source identity/body/sibling/count drift and local baseline/candidate/journal/request drift. Root/default-language Draft CREATE only; exhaustive cross-family target collision inventory validates page-local count, duplicates and bounded termination, then repeats immediately before CREATE. No UPDATE, publication, default assignment, rollback or retry. Immutable Brand SOURCE is live-qualified for one root/default-language Draft CREATE, with independent Draft/unpublished readback, completed source-refresh journal and unchanged source/baseline/definitions. This is bounded fresh packed-candidate proof, not published-package or full B qualification; Image replacement, folder hierarchy, non-default language and full B remain open.

# flags.source-org.summary

Independent original source org alias or username; required only with --brand-map and --definition-dir. Never defaults to --target-org; org ID and selected API version must match original evidence.

# flags.definition-dir.summary

Baseline-bound source tree: bounded existing JSON string-leaf and strict literal HTML edits for Email/Email Template via --native-copy-map; immutable Brand via --brand-map and --source-org with canonical evidence and live refresh. Root/default-language Draft CREATE only; Image source definitions unsupported.

# flags.target-org.summary

Username or alias of the target Salesforce org.

# flags.contract-version.summary

Machine contract major version (default: 1; --image-map and --document-map require explicit 2). Unsupported profile majors return a blocked contract envelope before package or org access.

# flags.api-version.summary

Salesforce API version used for CMS requests.

# flags.workspace-id.summary

Exact destination CMS workspace ID.

# flags.workspace-name.summary

Exact case-insensitive destination CMS workspace name.

# flags.source-dir.summary

Unchanged source workspace export containing manifest.json and items/. The editable companion is never the source package.

# flags.native-copy-map.summary

JSON array selecting eligible native raw-HTML email/template variants by sourceContentKey and language, with fresh apiName and urlName values. CREATE uses server-generated keys; destination name availability is not prevalidated.

# flags.email-fragment-map.summary

JSON array selecting exact typed cms/emailFragment API names with fresh target contentKey and apiName values. Source content keys remain provenance.

# flags.document-map.summary

JSON array selecting exactly one strict v2 cms/document text/plain .txt with an ASCII-only filename and explicit identity strategies; requires --contract-version 2. CREATE only; Unicode title/content allowed. Qualified only for one same-source-org 94-byte Draft in an isolated installed development tarball.

# flags.editable-dir.summary

Verified HTML-only companion for --native-copy-map. Requires the unchanged --source-dir baseline; opaque rawHtml is not dependency-resolved, sanitized, or scanned through Phase 7.

# flags.landing-page-map.summary

JSON array selecting paired cms/landingPage sources, fresh page identities, an exact Draft destination template selector, and explicit image/Data Graph prerequisite mappings. The source pair is title-first; canonical package identity proves compatibility, not provenance.

# flags.brand-map.summary

JSON array selecting typed `cms/brand` sources by exact case-sensitive API name and assigning fresh target apiName, title, and urlName values. Complete package/report integrity, canonical Marketing destination evidence, complete repeated collision inventory, faithful body transport, durable all-intent journaling, and independent Draft readback are required.

# flags.form-map.summary

JSON array selecting `cms/form` sources by exact case-sensitive API name and assigning fresh target apiName, title, and urlName values. Complete package/report integrity, canonical Marketing destination evidence, complete collision inventory, fresh block UUIDs, and exact Draft readback are required; Form body compatibility is decided by Salesforce at runtime.

# flags.form-handler-map.summary

JSON array selecting evidence-qualified `cms/formHandler` sources by exact case-sensitive API name and assigning fresh target apiName, title, and urlName values. Only the strict empty-provider, empty-root profile is accepted; canonical Marketing destination evidence and complete repeated collision inventory are required.

# flags.consent-banner-map.summary

JSON array selecting evidence-qualified `cms/consentBanner` sources by exact case-sensitive API name and assigning fresh target apiName, title, and urlName values. Only the exact dependency-free Reject/Accept Draft profile is accepted; canonical Marketing destination evidence and complete repeated collision inventory are required.

# flags.preference-page-map.summary

JSON array selecting strict typed `cms/preferencePage` sources by exact API name, a fresh target API name, exact source-to-destination channel/subchannel ID rows, and an optional explicit destination Brand selector only when source Brand evidence exists.

# flags.apply.summary

Create the planned content after local validation and the profile's bounded preflight checks pass. Landing-page apply writes the initial journal before mutation, then re-resolves every prerequisite and rebuilds the request from immutable source baselines. Dry-run writes no report and does not establish full conflict or apply readiness.

# flags.allow-partial.summary

Accept recorded omissions. Brand, Form, Form Handler, and Consent Banner always require complete packages; Preference Page permits only exact typed report-bound unresolved channel/subchannel evidence.

# flags.report-dir.summary

New directory for the durable applied-import run report.
