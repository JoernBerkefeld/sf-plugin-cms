# Salesforce CMS Connect REST API: what the 0.x plugin learned

These notes cover what the 0.x `sf-plugin-cms` (frozen `main`, 0.22.0) found out about the CMS Connect REST API. They are input for the v1 rebuild. They describe API behaviour only. The old plugin's local gates and qualification rules appear only where they reveal something about the API.

## How to read this

Each finding carries a source tag:

- **[LIVE: source]**: observed against a real org. The source is a verification-DB entry id (`vdb:<id>`, under `.claude/skills/_verification-db/entries/cms/`) or a plan file plus line.
- **[SPEC]**: read from `resources/openapi/connect-rest-api-cms-v67.yaml` (v67.0, lastUpdated 2026-07-21).
- **[CODE]**: what the old code assumes. It was not proven live unless a LIVE tag is also given.
- **[MOCK]**: seen only in tests.
- **CONTRADICTION**: two sources disagree. These are left unresolved on purpose.

Plan abbreviations:

| Abbreviation | File                                                                      |
| ------------ | ------------------------------------------------------------------------- |
| 7F           | `cms-mcnext-seven-family-mvp.plan.md`                                     |
| RM           | `cms_completion_roadmap_db4bfc5c.plan.md`                                 |
| FIN          | `cms_finalization_b5c0ad04.plan.md`                                       |
| IDX          | `cms_execution_index.plan.md`                                             |
| LC           | `cms_fragment_lifecycle_closure.plan.md`                                  |
| XN           | `cms_fragment_cross_org_nested.plan.md`                                   |
| WF           | `cms_fragment_workflow_acceptance.plan.md`                                |
| L20          | `sf-plugin-cms-0.20-command-lifecycle.plan.md`                            |
| SP           | `sf-plugin-cms_801b96b2.plan.md` and its handovers                        |
| P4           | `sf-plugin-cms_phase4-closure_phase5-handover.md` (reverse-chronological) |

Line numbers are approximate.

Note on the verification DB: every CMS entry in it is about `sfdc_cms__emailFragment` on API 67.0, and the entries are sanitized. They contain no org, workspace or content IDs. Real IDs come from the plans and from test anchors only.

---

## 1. Common endpoints

All paths below are relative to `/services/data/vXX.X`.

| Operation                    | Method and path                                                                                                        | Transport                    | Status                                                                                                                              |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| List workspaces              | `GET /connect/cms/spaces?page=&pageSize=`                                                                              | JSON                         | LIVE (7F L1105)                                                                                                                     |
| Get workspace                | `GET /connect/cms/spaces/{contentSpaceId}`                                                                             | JSON                         | LIVE                                                                                                                                |
| Workspace channels           | `GET /connect/cms/spaces/{contentSpaceId}/channels?page=&pageSize=`                                                    | JSON                         | LIVE (vdb:lifecycle-readiness-blocked-api67)                                                                                        |
| Get channel                  | `GET /connect/cms/channels/{channelId}`                                                                                | JSON                         | LIVE (both channel details were readable, vdb:lifecycle-readiness-blocked-api67)                                                    |
| Get content (parent)         | `GET /connect/cms/contents/{contentKeyOrId}`                                                                           | JSON                         | LIVE. The query params `contentVersion`, `language`, `variantVersion` and `version` exist [SPEC], but the old code never sent them. |
| Get variant                  | `GET /connect/cms/contents/variants/{variantId}`                                                                       | JSON                         | LIVE (used everywhere)                                                                                                              |
| Create content               | `POST /connect/cms/contents`                                                                                           | JSON, or multipart for media | LIVE                                                                                                                                |
| Create variant (translation) | `POST /connect/cms/contents/variants` with body `{contentBody, language, managedContentKeyOrId, title?, urlName?}`     | JSON                         | CODE only (`import-workspace.ts:3664`). Out of v1 scope.                                                                            |
| Update variant               | `PUT /connect/cms/contents/variants/{variantId}`                                                                       | JSON, or multipart for media | LIVE                                                                                                                                |
| Delete                       | `DELETE /connect/cms/contents/variants/{variantId}`                                                                    | none                         | LIVE                                                                                                                                |
| Publish                      | `POST /connect/cms/contents/publish`                                                                                   | JSON                         | LIVE (Email, 2026-10-02; Fragment, 2026-11-01)                                                                                      |
| Unpublish                    | `POST /connect/cms/contents/unpublish`                                                                                 | JSON                         | LIVE                                                                                                                                |
| Folder detail                | `GET /connect/cms/folders/{folderId}?contextContentSpaceId={workspaceId}`                                              | JSON                         | LIVE (vdb:installed-same-org-nested-api67)                                                                                          |
| Folder items                 | `GET /connect/cms/folders/{folderId}/folder-items?itemType=Folders&page=&pageSize=&includeSharedWithSpaceFolder=false` | JSON                         | v68 only; this path is not in the v67 spec. One LIVE call returned 404 (section 9).                                                 |
| Search                       | `GET /connect/cms/items/search?contentSpaceOrFolderIds=&contentTypeFQN=&languages=All&page=&pageSize=&queryTerm=`      | JSON                         | LIVE, with an error case (section 10)                                                                                               |
| SOQL inventory               | `GET /query?q=SELECT … FROM ManagedContentVariant …`                                                                   | JSON                         | LIVE (P4 L2914; vdb:type-only-retrieve-readonly-api67)                                                                              |
| Media bytes                  | `GET https://<instance>/cms/media/<key>?fileHash=&fileName=&version=`                                                  | binary                       | LIVE: 301 to `*.file.force.com`, then 200 (P4 L1241)                                                                                |
| Data graph                   | `GET /ssot/data-graphs/{developerName}`                                                                                | JSON                         | CODE (`web-fragment.ts:321`). v1 calls sf-plugin-data instead.                                                                      |

The spec also defines `/connect/cms/contents/{id}/clone`, `/taxonomy-terms`, folder `/shares` and `/share-targets`, and delivery endpoints. None of these was used for authoring.

### 1.1 JSON create body

`POST /connect/cms/contents` takes `{contentType, contentSpaceOrFolderId, apiName?, title, urlName?, contentBody, contentKey?, externalId?, externalSource?}` [SPEC / CODE `write.ts:13-35`].

- **`contentSpaceOrFolderId`:** the old plugin always passed the workspace `rootFolderId` (RM L262), or a nested folder ID for nested placement. That worked LIVE (vdb:installed-same-org-nested-api67).
- **`contentKey`:** omit it. Salesforce assigns one in the format `MC[A-Z2-7]{26}` [LIVE P4 L2809; 7F L1744].
- **`title`:** marked required in the spec. An Aura capture of a Preference Page create sent no `title`, `urlName` or `contentKey` (7F L1761). That capture is UI traffic, not the REST API.
- **Response:** includes parent ID, `contentKey`, primary variant ID and version [LIVE vdb:installed-create-update-unchanged-api67].

### 1.2 JSON update body

`PUT /connect/cms/contents/variants/{variantId}` takes `{apiName?, title?, urlName?, contentBody}` [SPEC; CODE `lifecycle-foundation.ts:117-131`].

The language is bound through the variant ID and is not sent.

The response carries `contentBody`, `isPublished`, `language`, `managedContentId` and `managedContentVariantId` [CODE validator; LIVE shape].

The PUT keeps parent and variant identity, `contentKey`, language and Draft state [LIVE, many entries]. The server-side `contentVersion`, `lastModifiedDate` and actor always advance. Re-deploying an older body does not restore them [LIVE vdb:installed-same-org-cross-workspace-and-restore-api67].

### 1.3 Publish and unpublish bodies

**Spec.** Both inputs accept `contentIds` or `variantIds` (one of the two is required) and optional `contextContentSpaceId`. Publish also accepts `description` and `includeContentReferences` [SPEC `ManagedContentPublishInput` L5408, `ManagedContentUnpublishInput` L6346].

- Publish was sent as `{variantIds:[id], contextContentSpaceId, includeContentReferences:false}` [LIVE Email 2026-10-02, 7F L1167; CODE `email-publish.ts:759`].
- Unpublish was sent as `{contentIds:[parentId]}` [LIVE 7F L1167, P4 L3293].
  - Sending `includeContentReferences` on unpublish returned **400 `JSON_PARSER_ERROR`**, rejected before any change [LIVE].
  - A Fragment unpublish with `includeContentReferences` omitted worked [LIVE vdb:installed-unpublish-delete-uncertain-api67].
- Both responses contain `deploymentId`, plus `publishDate` or `unpublishDate` [LIVE]. After unpublish, readback shows `isPublished=false`, `status.status=Draft` and an unchanged body.
- Publish response for a landing page: HTTP 201 with `isPublished=true` [LIVE mcn/_landingpage_ entries, 2026-11-19].
- **Checkpoint C5, answered in section 16:** publish and unpublish with `variantIds` target exactly the named variant of a multi-variant item.
- **CONTRADICTION (plans):** 7F L2024 calls publish/unpublish "content-scoped, parent-level", while LC L74 and the code send `variantIds`. The spec allows both.
- No channel field exists on either body. `contextContentSpaceId` names the workspace context, not a channel [SPEC; LC L74].
- Which channels a publish reaches is not established.

### 1.4 Delete

`DELETE /connect/cms/contents/variants/{variantId}` targets a variant (`9Ps…`). There is no parent delete route in the spec, and no revision or cascade switch [SPEC L522-646; L20 L127].

- **Deleting the only variant also deletes the parent.** Afterwards, a variant GET returns **404 `VARIANT_NOT_FOUND`**, a parent GET returns **404 `NOT_FOUND`** ("Managed content not found." in test bodies), and the SOQL inventory is empty [LIVE vdb:installed-delete-preserve-opt-in-api67; Email P4 L3293; Template 7F L1167].
- **CONTRADICTION on the DELETE response itself:**
  - Fragment deletes in vdb:installed-delete-preserve-opt-in-api67 succeeded cleanly.
  - Email Template `<20Y…>` / `<9Ps…>` (2026-10-02): **the DELETE call returned 404 `VARIANT_NOT_FOUND`, yet the item was deleted** (inventory 3 → 2) [LIVE 7F L1167, P4 L3293].
  - vdb:installed-unpublish-delete-uncertain-api67 reported "No ManagedContentVariant found for given input parameter." without recording the HTTP status. Readback then showed the item gone.
  - It is not established whether a successful DELETE can itself answer 404, or whether an earlier or duplicate request had already done the delete. **Treat a DELETE answer of 404 as "unknown, read back".**
- Success status: the docs disagree. The MCN reference says 204; the Connect/headless reference says 200 (DOC, L20 L127). The live success status was not recorded.
- Deleting one variant of a multi-variant item: **never tested.** The plan says delete refuses such items locally, and that rests on assumption, not evidence.

---

## 2. Native response shape (variant and parent)

Fields of a variant from `GET /connect/cms/contents/variants/{id}` [LIVE Audio 2026-10-18, P4 L1239; SPEC `ManagedContentVariant` L3173]:

| Field                                                                                               | Kind                                                                                                      |
| --------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `managedContentVariantId` (`9Ps…`), `managedContentId` (`20Y…`), `managedContentVersionId` (`5OU…`) | runtime IDs                                                                                               |
| `contentKey` (`MC…`, 28 characters)                                                                 | server-assigned key. Stable per item but different per org/workspace, so it is not authored.              |
| `contentSpace` = `{id, resourceUrl}`                                                                | runtime                                                                                                   |
| `folder` = `{id, resourceUrl}` or null                                                              | runtime ID; resolve to a path                                                                             |
| `contentType` = `{fullyQualifiedName, name}` (sometimes a plain string [CODE])                      | type                                                                                                      |
| `contentFqn`                                                                                        | null in live data [LIVE]. Test fixtures show the pattern `marketing--<ws>.sfdc_cms__brand--<api>` [MOCK]. |
| `createdBy`, `createdDate`, `lastModifiedBy`, `lastModifiedDate`                                    | runtime                                                                                                   |
| `status` = `{status: Draft\|Published\|(Revised per L20), label}`, `isPublished` (boolean)          | runtime state                                                                                             |
| `language` (`en_US`, `de`)                                                                          | identity of the variant                                                                                   |
| `apiName`                                                                                           | authored; unique per workspace (section 5.7)                                                              |
| `title`, `urlName`                                                                                  | authored                                                                                                  |
| `contentBody`                                                                                       | authored                                                                                                  |
| `externalId`                                                                                        | null in live data                                                                                         |
| `source` (`User`)                                                                                   | runtime [CODE]                                                                                            |

- The parent `GET /contents/{id}` adds `contentVersion` and `variantVersion` (for example `"1.1"`; the media URL `version` equals `variantVersion`) [LIVE P4 L1239].
- **ID length:** the same IDs come back as 15 or 18 characters depending on the endpoint. The root folder appeared both ways (`<9Pu…>`, P4 L2934-2936). Default-workspace reads returned 15-character workspace IDs, while search returned 18 [LIVE P4 L2946]. **Compare IDs after converting to 18 characters.**
  - A 15-character folder ID worked for GETs. It was not tried on create or update [LIVE vdb:installed-same-org-nested-api67, RM L356].

### 2.1 SOQL inventory

`ManagedContentVariant` exposes `Id, ManagedContentId, ContentTypeFullyQualifiedName, Language, VariantType (Content|Translation), IsPublished, ManagedContentVariantStatus, IsPrimary, Name, UrlName, ManagedContentKey`, plus `ManagedContent.AuthoredManagedContentSpaceId` and `ManagedContent.ApiName` [LIVE P4 L2914; CODE `retrieve-native-inventory.ts:76`]. `ManagedContent` exposes `ContentKey` [LIVE vdb:installed-delete-preserve-opt-in-api67].

- Keyset paging with `Id > :last … LIMIT 2000` works.
- `SELECT ManagedContentId, COUNT(Id) … GROUP BY ManagedContentId LIMIT 1` works. A non-grouped aggregate with LIMIT was rejected as invalid [LIVE P4 L2920].
- **This is the only complete inventory that was proven.** Neither the REST list nor search was proven complete (section 10).

---

## 3. Per type

### 3.1 Email: `sfdc_cms__email` (JSON)

- **Create:** POST JSON [LIVE 7F L1366, two cross-org creates on 2026-09-16].
- **Update:** PUT JSON [LIVE: a rawHtml-only PUT on 2026-10-01, 7F L1374].
  - The old plugin only ever changed `rawHtml` and a few text fields. **Updating full content (blocks, providers) for Email is not proven.** It has been proven only for Fragment.
- **Delete:** see 1.4 [LIVE P4 L3293]. **Publish / unpublish:** see 1.3 [LIVE 2026-10-02, fixture `runowned_unpublish_20261002_015315_c4338300`].
- **Body keys** in a captured shape with synthetic values (`test/fixtures/lifecycle-retrieval.json`, "captured 2026-10-21"):
  - `rawHtml`, `subjectLine`, `preheader`, `messagePurpose`
  - `sfdc_cms:title`, `sfdc_cms:description`, `sfdc_cms:urlName`
  - `lightning:dataProviders`, `lightning:expressions`, `lightning:backgroundImage`, `lightning:brandSource`
  - `sfdc_cms:attachments`, `sfdc_cms:variants`
  - `textContent` and `backgroundColor` are also named in 7F L1123 and P4 L3031.

### 3.2 Email Template: `sfdc_cms__emailTemplate` (JSON)

- **Update:** PUT changing `contentBody.rawHtml` [LIVE 2026-10-02, target org, parent `<20Y…>` / variant `<9Ps…>`, 7F L1163].
  - The same plan line records the apiName as `<contentKey>`, which is in contentKey format. That might be a mislabel.
- **Delete:** LIVE, including the 404 contradiction (1.4).
- **Search lag:** a newly created Draft template stayed missing from wildcard search for the whole acceptance window [LIVE P4 L3299].
- **Immutable fields:** the old plugin treated `subjectLine` and `messagePurpose` as immutable on templates (7F L1123). **This is a plugin assumption; no API rejection was recorded.**
- **Not recorded anywhere:** the full native body keys. They are assumed similar to Email. Record them in W4.

### 3.3 Email Fragment: `sfdc_cms__emailFragment` (JSON). The best-evidenced type.

- **Create, update and unchanged** were proven same-workspace, cross-workspace (same org) and cross-org, at root and in a nested folder [LIVE vdb:installed-create-update-unchanged, installed-cross-org-root, installed-same-org-nested, installed-same-org-cross-workspace-and-restore, source-linked-cross-workspace-root, source-linked-cross-org-root, installed-whole-type-pair-root (all -api67)].
- **Structure:** the API keeps every authored structural block `id` (UUID) and the array order exactly as sent. A two-section composed body (7 IDs, with the sections reordered on update) round-tripped [LIVE vdb:installed-composed-two-section-root-api67].
- **Body shape** (captured live as `CMSF_1026_fragment_create_capture`, `test/services/retrieve-item-source.test.ts:323-399`):
  - Top level: `backgroundColor`, `lightning:brandSource {defaultBrandOption:'sfdcBrand'}`, `lightning:colorScheme`, `lightning:padding`, `lightning:dataProviders[]`, `lightning:expressions[]`, `lightning:backgroundImage`, `sfdc_cms:attachments[]`, `sfdc_cms:variants[]`, `sfdc_cms:title`.
  - `sfdc_cms:block` is a tree of `{definition: 'sfdc_cms/rootContentBlock' | 'lightning/section' | 'lightning/column' | …, id, type:'block', attributes, children}`.
  - Attribute values contain brand expressions such as `{!$brand.spacing.none}`.
  - The body has no `sfdc_cms:urlName`; the URL name exists only in the envelope.
- **Data graph provider**, exactly as captured:
  ```json
  {
    "definition": "sfdc_cms__dataGraphDataProvider",
    "sfdcExpressionKey": "$dataGraph",
    "attributes": { "dataGraphApiName": "Marketing", "dataspace": "default" }
  }
  ```
  Default Brand plus the `Marketing`/`default` graph is the native default seen in both orgs [LIVE RM L83, L336]. Profiles without a provider (empty `lightning:dataProviders`) also exist [LIVE vdb:installed-whole-type-pair-root-api67].
- **Envelope title versus body title:**
  - **Create:** the envelope `title` and body `sfdc_cms:title` were stored as sent, even when they differed (envelope "P", body "P ") [LIVE vdb:native-title-boundaries-api67, attempt 1].
  - **Update:** when the body title changed, the envelope (parent and variant) **took the body title**, whatever envelope title was sent [LIVE vdb:prior-update-uncertain-api67, vdb:installed-create-update-unchanged-api67].
  - **Update with a trailing space:** for an envelope of "S ", the envelope was **saved trimmed** ("S") while the body kept the trailing space [LIVE vdb:native-title-boundaries-api67, attempt 4].
  - **CONTRADICTION / open:** is the rule "the envelope follows the body on PUT" or "the envelope is trimmed on PUT"? Attempts 1-3 kept matching or differing titles; attempts 4 and later did not. Compare titles carefully in `unchanged` detection.
- **Inventory facts:** in one workspace, 7 fragment families had 8 variants, one of them bilingual [LIVE vdb:installed-bounded-partial-retrieve-api67]. Other runs counted different numbers (see open questions).

### 3.4 Image: `sfdc_cms__image` (multipart)

- **Create:** `POST /connect/cms/contents`, `multipart/form-data` [SPEC L393-400; LIVE 2026-10-17 `mcnext-sdo`, P4 L2161, FIN L81].
  - Part 1: `name="ManagedContentInputParam"`, `Content-Type: application/json; charset=UTF-8`. Body: `{apiName, title, urlName?, contentSpaceOrFolderId:<rootFolderId>, contentType:'sfdc_cms__image', contentBody:{'sfdc_cms:media':{source:{type:'file'}}}}`.
  - Part 2: `name="contentData"; filename="<name>"`, `Content-Type:` the MIME (the code defaults to `application/octet-stream; charset=ISO-8859-1`).
  - The spec says binary multipart create is limited to image and document ("`sfdc_cms__doc`", 7F L1644). Audio create nevertheless worked LIVE (3.6).
- **Update:** `PUT /connect/cms/contents/variants/{id}`, multipart.
  - Part 1: `name="ManagedContentVariantInputParam"` (JSON, UTF-8), body `{apiName?, title?, urlName?, contentBody:{'sfdc_cms:media':{source:{type:'file'}}}}`.
  - Part 2: `name="contentData"`.
  - Result: LIVE PASS on 2026-10-17 for a bytes-only update (FIN L81; P4 L2120).
  - **CONTRADICTION (spec versus code):** the spec's PUT schema (L566-596) lists flat multipart fields (`contentData`, `apiName`, `contentBody`, `title`, `urlName`) and no `ManagedContentVariantInputParam` part. The code's part name worked live for Image, Document and Audio.
- **Error (LIVE 2026-10-17, P4 L2163):** a PUT with metadata `{}` plus bytes returned **"Oops. 'name' is required. Enter an appropriate value and try again."** The status code was not recorded. Nothing was changed.
  - The later passing update sent some metadata, but **the exact passing JSON for Image was not recorded.**
  - "name" probably means `title`. That is unconfirmed.
- **Response:** `contentBody['sfdc_cms:media'] = {source:{type:'file', ref:'0sN…', size, mimeType}, url:'/cms/media/<key>?fileHash=<md5>&fileName=<original>&version=<variantVersion>'}`. Each byte update produces a new `ref`, a new `fileHash` and a higher version [LIVE P4 L1680, Document].
  - The native original filename differs from any normalized local filename (FIN L386).
- An Image that points to an external URL (`CMSF_1015_image_url`) is a separate body shape that was never captured (RM L69).
- **Publish / unpublish of Image:** LIVE baseline and readback cells exist in `lifecycle-retrieval.json` (2026-10-21, synthetic IDs), so it appears to have worked. The API answer was not recorded in the verification DB.

### 3.5 Document: `sfdc_cms__document` (multipart)

- **Create:** the same parts as Image, with `contentType:'sfdc_cms__document'`. The default part MIME is `text/plain` [LIVE both orgs 2026-10-18, P4 L1699, L1717-1721].
- **Update** [LIVE 2026-10-18T00:51:43Z, HTTP 200, `PUT …/variants/<9Ps…>`, 667-byte body, P4 L1680]:
  - JSON part, exactly: `{"apiName","title","urlName","contentBody":{"sfdc_cms:media":{"source":{"type":"file"}}}}`.
  - File part `contentData`, `text/plain`.
  - The response had a new `source.ref` (`<0sN…>`), size 62, media version 1.2. Identity, key, language and Draft state were kept.
- **CONTRADICTION (type name):** `sfdc_cms__doc` (7F L1644, quoting the spec) versus `sfdc_cms__document` (FIN L63, the code, and live traffic). Live traffic used `sfdc_cms__document`.
- PDF and non-text MIME types, and documents over 10 MiB: **MOCK only.** The "native 415" in tests was mocked (P4 L123).

### 3.6 Audio: `sfdc_cms__audio` (multipart)

- **Create:** same parts as Image, `contentType:'sfdc_cms__audio'`, explicit MIME (`audio/x-wav`). It binds to the root folder [LIVE 2026-10-18T22:24:53Z, source, P4 L770; cross-org 2026-10-19, target, P4 L737].
- **Update:** multipart PUT whose JSON carries **only `title`, `urlName` and the media source**, with no `apiName` [LIVE 22:38:47Z, 1437 bytes, P4 L757].
  - **CONTRADICTION / open:** Audio update worked without `apiName`, Document update worked with it, and Image failed with `{}`. Which metadata fields the API actually requires is unknown.
- **Read:** native WAV, size 844, `audio/x-wav` [LIVE].
- **Publish / unpublish:** lifecycle cells exist in `lifecycle-retrieval.json`. The API result is not in the verification DB.

### 3.7 Brand: `sfdc_cms__brand` (JSON)

- **Create** [LIVE 2026-10-05, cross-org to target: parent `<20Y…>`, variant `<9Ps…>`, key `<contentKey>`, en_US Draft; P4 L2809, 7F L1057].
  - Readback equals the source except `sfdc_cms:title`.
  - The body has sections for typography, color, spacing, button, provider, title, Einstein brand and variants. `dataProviders` and variants were empty (7F L1710; P4 L2934). A full synthetic body is in `test/fixtures/brand.ts:22-149`.
- **The same `apiName`, title and urlName can be created in a second workspace of the same org.** Both copies stay as Drafts (`Phase_5_Discovery_Brand`: `<20Y…>` in Default_Content_Workspace, copy `<20Y…>` in Cloud_Kicks), so **`apiName` is unique per workspace only** [LIVE ~2026-10-01/02, P4 L3396, 7F L1165].
- **Update works on v68** (section 17). **Not tested:** Brand delete, publish and unpublish, and setting a brand as the workspace default (7F L1710).

### 3.8 Other types (context only)

- **Landing page (`sfdc_cms__landingPage`):** JSON create worked [LIVE Phase 4, 2026-09-30, 7F L1370; also 2026-11-19, mcn entries]. Publish returned 201.
  - The anonymous URL `/lp/landing-page/<urlName>-<contentKey>` returned **403 "URL No Longer Exists"** for about 25 minutes after publish [LIVE mcn entries].
- **Saving AMPscript with invalid syntax in `rawHtml`** returned **`INVALID_API_INPUT`**, errorType `ampscript_syntax_error`, fieldName `rawHtml`, with line and column, and the message "The AMPscript syntax isn't valid. Update the content using the correct syntax and try again." [LIVE mcn/_queryparameter_, _requestparameter_]. Salesforce validates AMPscript on save, so the same is likely for email types. That is unverified.
- **Form, form handler and consent banner:** minimal creates [LIVE 7F L1712].
- **Preference page:** the specialized `PATCH /headless/invoke/platform/custom-preference-page/create-cpp` always publishes and sets defaults (DOC, 7F L1714).

---

## 4. References between components

- **Brand reference in a body:** `lightning:brandSource`.
  - Default brand: `{defaultBrandOption:'sfdcBrand'}` [LIVE, all 13 inspected bodies, vdb:native-reference-shape-capture-blocked-api67].
  - Custom brand: `lightning:brandSource.contentKey` = the brand's contentKey [LIVE observation of a user Draft `<20Y…>` / `<9Ps…>` in `<0Zu…>`, 2026-11-02, IDX L17]. **The full JSON was not captured.**
- **Image reference:** `imageInfo.source = {type:'imageReference', ref:{contentKey}}` [LIVE same observation, IDX L17; CODE `import-identities.ts`].
  - References use **contentKey**, which differs per org and workspace. Cross-workspace deploy must therefore look up the destination contentKey by apiName and rewrite it.
- **Data graph provider:** see 3.3. `dataGraphApiName` and `dataspace` are plain names. Live data has only seen `Marketing` / `default`.
  - The old code checked the graph through `GET /ssot/data-graphs/{name}`, expecting `name`, `dataspaceName` and a ready or active `status` [CODE].
  - Data-space prefixing outside `default` is covered by the sf-plugin-data verification-DB entries, not by CMS entries.
- **Fragments embedded in emails, and nested fragments:** no native shape was captured (vdb:native-reference-shape-capture-blocked-api67, which found zero CMS references in 13 bodies).
- The Aura action `ManagedContentController.getVariantReferences` exists. It returned empty for a reference-free fragment [LIVE HAR, vdb:lifecycle-readiness-blocked-api67]. It is UI-only, not REST.

---

## 5. Workspaces and channels

### 5.1 Workspace list

- `GET /connect/cms/spaces?page=0&pageSize=250` [LIVE].
- `page` is zero-based. The old code paged until it got an empty page or `nextPageUrl === null`.
- **CONTRADICTION (spec versus code):** the spec's `ManagedContentSpaceCollection` (L5856) has only `spaces`, with no `nextPageUrl` or total. Rely on the empty or short last page.

### 5.2 Workspace detail fields

`id` (`0Zu…`), `apiName`, display `name`, `defaultLanguage`, `rootFolderId` (`9Pu…`), `spaceType`, `isEnhancedSpace`, `fullyQualifiedName` [SPEC L3039; LIVE].

- `spaceType` came back as the object `{apiName:'marketing'}` in **lowercase**. The old code expected `Marketing` and broke [LIVE 2026-10-05, P4 L2839, 7F L1077].
  - It can also be a plain string, or be missing from detail (7F L713, L1734).
  - The list showed a blank Type for target `<0Zu…>` (L20 L59).
- `apiName` is not the display name: `Default_Content_Workspace` versus "Content Workspace for Marketing Cloud" [LIVE].
- **The workspace response has no list of enabled languages.** Only `defaultLanguage` is returned [SPEC; P4 L3031].

### 5.3 Channels

- `GET /connect/cms/spaces/{id}/channels` returns `spaceChannels[].channelSummary`, with `currentPageUrl`, `nextPageUrl`, `previousPageUrl` and `totalSpaceChannels` [SPEC L6168].
- One live read returned 2 channels, both "Added", total 2, with no next page [LIVE vdb:lifecycle-readiness-blocked-api67, Cloud_Kicks, LC L74].
- **No channel IDs are recorded anywhere.** How the list ends on a multi-page response is unverified (L20 L69).

---

## 6. Folders and pagination

### 6.1 Folder detail

`GET /connect/cms/folders/{id}?contextContentSpaceId=<ws>` returns `id`, `folderType` (`System` for the root, else `Standard`), `isShared`, `folderHierarchy[]` (entries with `parentFolderId`, `name`, optionally `contentSpaceId`) [LIVE; CODE `acquire-folder-evidence.ts:110-157`].

- **CONTRADICTION:** one read of `folderHierarchy` ancestors had **no `isShared`**, while the leaf had `isShared:false` (vdb:installed-nested-sharing-contract-blocked-api67). A later run says the ancestors returned `isShared:false` (vdb:installed-same-org-nested-api67). It is unclear whether these were different calls.
- Target nested folders [LIVE API 67, around 2026-11-02, IDX L19]: root `<9Pu…>` → `<9Pu…>` "CMSF_1015_nested_folder1" → `<9Pu…>` "CMSF_1015_nested_folder2". Both are Standard with `isShared:false`.

### 6.2 Child-folder listing

The v67 spec has **no complete child-folder list** (RM L264).

- v68 `folder-items` returned **404 "resource does not exist"** on the target root folder [LIVE 2026-10-30, vdb:cross-org-nested-folder-prerequisite-blocked-api68; XN L29]. This proves neither that the route is missing nor that the folder is empty.
- The Aura `getManagedContentSpaceFolderItems` uses `pageParam` 0, 1, …; where it ends is unproven (RM L291).
- A special `SharedWithSpace` folder reports `isShared:false` (RM L291).
- **For the v1 folder walk (checkpoint C2):** no folder-listing route has been proven. A working alternative is SOQL on folder sObjects (not tried) or folder detail by known ID.

### 6.3 Search pagination

`GET /connect/cms/items/search` [LIVE 2026-10-02/05, 7F L1167, P4 L2946]:

- `count` is the size of **the current page**, not a total.
- `nextPageUri` is present **even on an empty last page**.
- Only a short or empty page signals the end.
- `pageSize` is 1-250, default 25. `queryTerm` is required. `languages` takes up to 10 values or `All` [SPEC L1865].
- Wildcard terms need at least two non-wildcard characters per term (P4 L3219). `*` on its own was used and worked.
- Rows have `type:'ManagedContentVariantSearchResultRepresentation'`, `id` (variant), `managedContentId`, `managedContentSpaceId`, `contentKey`, `language`, `status`, `title`, `urlName`, `folder`, `variantType` [SPEC L6557; CODE].
- Example: an all-language wildcard search returned 34 (source) and 31 (target) variants on page 0, and page 1 was empty [LIVE 7F L1105].
- **Error:** **400 `INVALID_INPUT` "Specify a Library and, optionally, a folder."** on search scoped to two workspaces, and again to one (Child5, 2026-10-31; LC L76, RM L635). Not resolved.
  - **CONTRADICTION:** the same endpoint worked on 2026-10-02/05 with `contentSpaceOrFolderIds=[ws]`.
  - An MCP search rejected an array query parameter with 400; a string worked (P4 L2952). The array encoding may be the cause.
- **Search lag:** see 3.2.

**Recommendation from the evidence:** use SOQL keyset inventory for "list all of a type" and use REST GETs for bodies.

---

## 7. Languages `en_US` and `de`

- All three designated workspaces (source Default_Content_Workspace, source Cloud_Kicks, target Default_Content_Workspace) have `en_US` (the default) and `de` enabled. German is `de`, not `de_DE`. English is always on [user statement, RM L60-61; LIVE vdb:installed-cross-org-root-api67, source-linked-cross-org-root-api67].
- **Bilingual fixture:** `CMSF_1015_contentblock_email` (Fragment, key `<contentKey>`, parent `<20Y…>`), with variants `<9Ps…>` (`en_US`) and `<9Ps…>` (`de`). The visible text "(de_de)" is content, not a locale (RM L81).
- **Inspected bodies:** 10 parents had only `en_US`; 3 had `en_US` plus `de` (vdb:native-reference-shape-capture-blocked-api67, RM L469).
- **Untested:** creating content in a non-default language, creating a `de` variant, and deleting one language variant.
- Languages that are enabled but unused have no effect on create or update into the default language [LIVE: every create was en_US into de-enabled workspaces].
- Search with `languages=All` returns all language variants [LIVE].

---

## 8. Landing Page published-template prerequisite

- **GUI only:** creating a Landing Page in the UI required a **published** Landing Page Template. Fixture `CMSF_1015_landingpage_template` was published so that `CMSF_1015_landingpage` could be created. `CMSF_1015_landingpage_template_unpublished` is based on it (RM L72, L90; IDX L77).
- **API: unconfirmed.** A REST Landing Page create succeeded LIVE (7F L1370; mcn entries 2026-11-19), but the plans do not record the template's state at the time.
- **CONTRADICTION (code versus GUI):** the old code required the _destination_ template to be Draft and unpublished (`landing-page.ts:30-41,405-440`), the opposite of the GUI rule.
- Landing Page is outside v1 parity. This section is kept for the follow-up plan.

---

## 9. Media download (`experimental-media.ts`)

- **Live path:** the variant's `contentBody['sfdc_cms:media'].url` is relative, `/cms/media/<key>?fileHash=<md5>&fileName=<name>&version=<v>`. An authenticated GET on the instance origin returns **301 → `https://*.file.force.com/...` → 200**. The response MIME equals the native `mimeType`, `Content-Length` equals `size`, and the MD5 of the bytes equals `fileHash` [LIVE 2026-10-18, P4 L1241]. This worked on Draft content (FIN L81).
  - **CONTRADICTION:** 7F L1645 said a Draft download was "not established". That was superseded.
  - The documented alternative, `GET /connect/cms/delivery/channels/{channelId}/media/{mediaGuid}/content`, returns `application/octet-stream` and works only for content published to that channel [SPEC/DOC, 7F L1645]. It was not used.
- **Security control kept for v1** [CODE]:
  - Only `https:`, no userinfo, default port only.
  - The first request must be same-origin with the authenticated instance, and the path must start with `/cms/media/`.
  - `redirect:'manual'`; follow 301/302/303/307/308 up to 3 times. Each hop must be the instance origin or a host ending in `.file.force.com` (IDNA-normalized, trailing dot stripped). Anything else stops the download.
  - The bearer token is sent on each hop, including file.force.com hops.
  - The response must not be `text/html` or JSON unless that is the expected MIME. For images, `application/octet-stream` is accepted.
  - The old byte limits (10 MiB per image, 50 MiB in total) are local gates, not API limits. Drop them, except as memory safety.
- A raw `fetch` with automatic redirects behaved unexpectedly (P4 L1686). Use manual redirects.

---

## 10. Errors Salesforce returned

| Status    | errorCode / message                                                                  | Cause                                                                                                              | Source                                              |
| --------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------- |
| 400       | `JSON_PARSER_ERROR` ("Unrecognized field includeContentReferences" in the test body) | `includeContentReferences` sent on unpublish                                                                       | LIVE 7F L1167, P4 L3293                             |
| 404       | `VARIANT_NOT_FOUND`                                                                  | GET of a deleted variant; also **returned by a DELETE that did delete**                                            | LIVE (1.4)                                          |
| 404       | `NOT_FOUND` ("Managed content not found.")                                           | GET of a parent whose last variant was deleted                                                                     | LIVE                                                |
| ?         | "No ManagedContentVariant found for given input parameter."                          | DELETE, or the readback right after it, for a fragment that ended up deleted                                       | LIVE vdb:installed-unpublish-delete-uncertain-api67 |
| ?         | "Oops. 'name' is required. Enter an appropriate value and try again."                | Image multipart PUT with empty metadata `{}`                                                                       | LIVE P4 L2163                                       |
| 400       | `INVALID_INPUT` "Specify a Library and, optionally, a folder."                       | items/search scoped to workspace(s); cause unknown                                                                 | LIVE LC L76                                         |
| 400       | `INVALID_API_INPUT`, errorType `ampscript_syntax_error`, fieldName `rawHtml`         | invalid AMPscript in a landing page body                                                                           | LIVE mcn entries                                    |
| 404       | "resource does not exist"                                                            | v68 `folder-items` on the target root                                                                              | LIVE vdb:…-api68                                    |
| 404 / 400 | —                                                                                    | MCP or headless call with an unsubstituted `{variantId}` placeholder. This is a caller mistake, not API behaviour. | LIVE vdb:native-reference-shape…, title-boundaries  |
| 401       | `INVALID_SESSION_ID`                                                                 | stale copied CLI auth                                                                                              | LIVE P4 L1723, vdb:installed-cross-org-root-api67   |
| 403       | "URL No Longer Exists"                                                               | public landing page URL right after publish                                                                        | LIVE mcn entries                                    |

These codes appear in test bodies only and **were not labelled live**:

- `INVALID_ID_FIELD` "Provide a valid content key, ID, or FQN." The old code matched it exactly for a missing contentKey on `GET /contents/{key}`, which suggests it was seen.
- `NOT_FOUND` "Could not find a match for URL", for an unknown route or version.
- `INVALID_TYPE` "ManagedContentVariant is not supported".
- 415, 429.

The error body is an array of `{errorCode, message}`. The request ID comes from the `sforce-request-id` header [CODE `json-mutation.ts:78`].

---

## 11. API version notes (67 vs 68)

- All proven **writes** used **67.0**. Every verification-DB CMS entry except one is `-api67`.
- The bundled spec is v67.0, OpenAPI 3.0.3, 48 operations.
  - **CONTRADICTION in recorded size:** 243152 bytes (SP 0P1a) versus "243608 bytes / 48 operations / 192 refs" (7F L1115).
- The old default was `latest`, discovered through `GET /services/data`, falling back to 67.0 on version or route errors [CODE `api-policy.ts`].
  - On 2026-10-15 a read qualification ran on `latest` (which resolved to 68.0) and on explicit 68.0: 1,108 GETs, zero HTTP errors (FIN L254, L273). **Reads on 68 are fine; writes on 68 are untested.**
- `folder-items` is v68 only and is missing from the v67 spec. Its one live call returned 404 (6.2).
- The `/services/data/v68.0/cms/deployments` route appears in metadata but was never exercised (vdb:lifecycle-readiness-blocked-api67).

---

## 12. Fixture inventory

Kept outside this repository (org and record IDs).

## 13. Open questions and contradictions (summary)

1. **DELETE answer.** A DELETE can return 404 `VARIANT_NOT_FOUND`, or "No ManagedContentVariant found…", even though the item ends up deleted. Is that a real API quirk or a duplicate call? The success status is also undocumented-consistent: 200 or 204.
2. **Deleting one variant of a multi-variant item.** Never tested.
3. **Publish and unpublish with `variantIds` on multi-variant items** (checkpoint C5). The spec allows it; it was never tested live.
4. **Multipart update part name.** The spec has flat fields; the code's `ManagedContentVariantInputParam` worked live.
5. **Metadata required on a media PUT.** Image `{}` failed with "'name' is required", Audio passed without `apiName`, and Document passed with `apiName`. The passing Image body was not recorded.
6. **Envelope and body title.** Create keeps a difference; update makes the envelope follow the body; a trailing space is trimmed on update.
7. **items/search.** It returned 400 `INVALID_INPUT` "Specify a Library…" on 2026-10-31 but worked on 2026-10-02/05.
8. **Child-folder listing.** v68 `folder-items` returned 404 and no v67 route exists. The `isShared` readings on ancestors disagree.
9. **Document type name:** `sfdc_cms__doc` (spec quote) versus `sfdc_cms__document` (live).
10. **Landing Page template.** The GUI requires a published template; the old code required a Draft one; the API rule is unknown.
11. **Workspace list pagination.** The spec has no `nextPageUrl`; the code expected one.
12. **Fragment family counts drift between runs:** 6/8 with 2 bilingual (2026-10-28), 7/8 with 1 bilingual (2026-10-31), 13/16 with 3 bilingual across two workspaces. The workspace for each count is not stated.
13. **The 7F L1163 "apiName" `MC3I6LC7…`** looks like a contentKey. Resolved in section 14: UI-created items have the content key as apiName.
14. **Email Template body keys** and the reason templates were treated as immutable: body keys resolved in section 14; immutability still unrecorded.
15. **Custom Brand reference JSON** and nested-fragment references: not captured.
16. **Channel IDs** and channel pagination end: not recorded.
17. **v68 writes**, and the `/cms/deployments` route: untested.
18. **Spec size:** 243152 versus 243608 bytes.
19. **Where `CMSF_1015_nested_document` lives** (which org), and IDs for the other name-only `CMSF_1015_*` fixtures. These need a read-only lookup in W1/W2.

---

## 14. Retrieve findings (W2a, 2026-11-21, API 68.0, read-only on `isolated-source`)

All [LIVE vdb:variant.retrieve-raw-text-and-email-bodies-api68].

- **Connect REST HTML-encodes response strings.** Without a header, `<`, `>`, `&`, `"` and `'` come back as `&lt;`, `&gt;`, `&amp;`, `&quot;`, `&#39;` in every string of a variant GET (`rawHtml`, block `text` attributes). With the request header **`X-Chatter-Entity-Encoding: false`** the same GET returns the stored text unchanged. v1 sends it on every read. The `content_readonly` MCP server returns the encoded form. Writes and write responses with this header: not yet tried (W2b). The old plugin's heuristic decoding (`editable-raw-html.ts`, `import-identities.ts`) was a workaround for this. Items written by that plugin store the encoded text itself (the header then still shows `&lt;`), so it is content, not transport.
- **Email body, two shapes.** A code email has top-level `rawHtml`, `textContent`, `subjectLine`, `preheader?`, `messagePurpose`, `sfdc_cms:title`, `sfdc_cms:urlName`, `lightning:brandSource`, `lightning:dataProviders`, `lightning:expressions`, `lightning:backgroundImage`, `sfdc_cms:attachments`, `sfdc_cms:variants`. A block email (created in the UI) has no top-level `rawHtml`; it has `backgroundColor` and a `sfdc_cms:block` tree (`lightning/section` > `lightning/column` > `lightning/image|heading|paragraph|button|html`), where `lightning/html` carries `rawHtml` as an attribute and images carry `imageInfo.source = {type:'imageReference', ref:{contentKey}}` plus a derived `imageInfo.url` (`/cms/media/<key>?fileName=&fileHash=`). Its data provider was `sfdc_cms__unifiedIndividualDataProvider` with `attributes.objectApiName`.
- **Email Template body keys** (resolves question 14): `rawHtml`, `textContent?`, `subjectLine?`, `preheader?`, `messagePurpose`, `sfdc_cms:title`, `sfdc_cms:description?`, `lightning:dataProviders`, `lightning:expressions`, `lightning:backgroundImage`, `sfdc_cms:attachments`, `sfdc_cms:variants`. No `sfdc_cms:urlName` and, in the samples, no `lightning:brandSource`. Templates with `subjectLine` exist, so it is not create-forbidden.
- **`apiName` equals the content key for UI-created items** (`ManagedContent.ApiName` = `ManagedContentKey`, `MC…`). This explains question 13: such an apiName is real, not a mislabel.
- **`contentFqn` is filled on v68 variant GETs**: `marketing--<workspaceApiName>.<contentType>--<apiName>` (section 2 said null).
- **Variant GET `contentType`** has only `fullyQualifiedName`; the parent GET adds `name` (`Email`).
- **Second-language variants:** the `de` variant of a bilingual item has `VariantType = Content` (not `Translation`) and `IsPrimary = false`; the `en_US` one is `IsPrimary = true`. v1 takes `IsPrimary` as the default variant.
- **SOQL filters that work:** `ManagedContent.AuthoredManagedContentSpaceId = '<18-char>'`, `ContentTypeFullyQualifiedName = …`, `ManagedContent.ApiName IN (…)`, `ManagedContentKey IN (…) AND IsPrimary = true`, keyset `Id > …`. `ManagedContent` exposes `ContentKey`, `ApiName`, `AuthoredManagedContentSpaceId`.
- **Folder detail:** `folderHierarchy` lists the ancestors from the root (`folderType: System`, `parentFolderId: null`) down to the parent, without the folder itself; the root's own hierarchy is `[]`. The root folder's name is `<workspace name>_marketing`.
- Inventory: whole Email type retrieved without errors.

## 15. Deploy findings (W2b, 2026-11-21, API 68.0, live on both orgs)

All [LIVE vdb:content.deploy-email-and-template-api68]. Writes were agent-owned `CMSV1_*` fixtures only.

- **Writes and `X-Chatter-Entity-Encoding`.** A JSON create (`POST /connect/cms/contents`) or variant PUT stores the body exactly as sent, with or without the header: `<`, `>`, `&`, quotes and an already-encoded `&amp;` all read back unchanged through a raw GET. The header only changes the **response**: without it the write answer is entity-encoded like a GET; with it the answer is raw. v1 sends the header on every JSON write too.
- **Create response** is a full variant representation (`managedContentVariantId`, `managedContentId`, `contentKey`, `folder {id, name, path}`, `status`, `contentBody`, …), not just IDs.
- **Checkpoint C3 (identity on create):** create keeps the given `apiName` and `urlName` and assigns a new `contentKey` (none sent). The same `apiName` and `urlName` were accepted in a second workspace of the same org and in a workspace of the other org; each copy got its own content key. So identity across workspaces and orgs = `{ type, apiName }` per destination workspace; content keys are never authored.
- **Update:** `PUT /connect/cms/contents/variants/{id}` with `{apiName, title, urlName, contentBody}` changed `subjectLine` / `preheader` and `rawHtml` of a code email and a template; identity, content key, language and Draft state stayed; re-retrieve was byte-identical to the edited files; the next deploy found nothing to write.
- **Folder listing works on v68** (resolves section 6.2 / open question 8): `GET /connect/cms/folders/{folderId}/folder-items?itemType=Folders&page=&pageSize=` answers `{folderId, folderItems[], parentFolderId}`; each item has `isFolder`, `managedContentOrFolderId`, `title`, `folderSummary.folderType` (`SharedWithSpace` for "Shared with Workspace", `Standard` otherwise, sometimes `hasChildFolders`). There is no next-page field; with `pageSize=1` each child came exactly once and later pages were empty, so the end is the first short or empty page. Without `itemType` the list also holds content items (`contentSummary`). Works on the root folders of all three designated workspaces and on a nested folder; the v67 path answers 404 `NOT_FOUND`. The earlier 404 was not reproduced on v68. v1 resolves `folderPath` by walking this list by name; folder **creation** is not built yet (W5).

## 16. Lifecycle findings (W3, 2026-11-21, API 68.0, live on both orgs)

All [LIVE vdb:content.lifecycle-publish-unpublish-delete-api68]. Writes were agent-owned `CMSV1_*` fixtures only.

- **Checkpoint C5 (variant-targeted lifecycle): yes.** `POST /connect/cms/contents/publish` with `{variantIds:[<primary>], contextContentSpaceId, includeContentReferences:false}` published only the `en_US` primary of an item that also had a `de` variant; `de` stayed Draft. `POST /connect/cms/contents/unpublish` with `{variantIds:[id], contextContentSpaceId}` unpublished only the named variant. v1 publishes/unpublishes the default variant and warns `OTHER_VARIANTS_SKIPPED`; only delete refuses components with other variants.
- **Unpublish of the primary while another variant is published** answers **400 `INVALID_API_INPUT`** ("Your content wasn't unpublished"), with or without `contextContentSpaceId`, and changes nothing. After the other variant was unpublished, the same call answered 201. v1 sends it and shows the answer.
- **Unpublish body:** `variantIds` plus `contextContentSpaceId` works (201 with `deploymentId`, `unpublishDate`). Publish answers 201 with `deploymentId`, `description: "#DEPLOYED"`, `publishDate`. Republishing an already published item answered 201 again.
- **Channels: none to choose.** Neither body has a channel field. After a publish in the workspace context, the email appeared in the delivery list of the workspace channel "Marketing Messages" (type `UserPermission`), not in "Marketing Landing Pages" (`Community`); the email template showed `Published` in the workspace but was in neither delivery list. After unpublish the email left the delivery list. No channel decision is needed for email/template.
- **Delete:** on all 7 single-variant deletes (both orgs) the `DELETE /contents/variants/{id}` answer was a success; readback: variant GET 404 `VARIANT_NOT_FOUND`, parent GET 404 `NOT_FOUND` ("Managed content with content key or Id … was not found."), SOQL no rows. The 404-on-success case from section 1.4 did not recur, so v1 still confirms by readback and treats a DELETE error with a confirmed absence as `deleted` (warning `DELETE_ANSWER_IGNORED`).
- **Delete of a non-primary variant** answered **204** and left the item with its primary variant. (v1 does not use this; delete refuses multi-variant components.)
- **Translation variant create** (`POST /contents/variants`, used only for the C5 probe): `managedContentKeyOrId` needs the content key (an 18-character `20Y…` ID was refused with 400 `ILLEGAL_QUERY_PARAMETER_VALUE`, "18 vs 15"); the body accepts only translatable fields (`subjectLine`, `preheader`, `rawHtml`, `textContent` worked; `lightning:*`, `messagePurpose` and `sfdc_cms:*` were refused with 400 `INVALID_FIELD`).
- **Create: body `sfdc_cms:title` / `sfdc_cms:urlName` win over the envelope.** A create whose envelope said a new title/urlName but whose body still held the old `sfdc_cms:title` / `sfdc_cms:urlName` stored the body values (plugin readback warned `READBACK_DIFFERS title, urlName`). Relevant for deploy (W2b area): a copied file must change both.
- Independent checks: SOQL on `ManagedContentVariant` and the `content_readonly` / `sobjects` MCP servers after each step; Chrome CMS workspace list showed Published after publish and Draft after unpublish, and no CMSV1 email/template after delete.

## 17. Brand findings (W6, 2026-11-21, API 68.0, live on both orgs)

All [LIVE vdb:content.deploy-brand-api68]. Writes were agent-owned `CMSV1_*` fixtures only.

- **Shape.** A Brand variant body is plain JSON: `baseFontFamily`, `baseFontSize`, `borderRadius`, `borderWeight`, `buttonStyleGroup` (primary/secondary/tertiary), `colorScheme`, `fontFamily`, `fontSize`, `fontWeight`, `letterSpacing`, `shadows` (newer brands only), `spacing`, `typography`, `lightning:dataProviders` (empty), `sfdc_cms:einsteinBrandProperties`, `sfdc_cms:title`, `sfdc_cms:variants` (empty). Values reference other brand tokens as `{!$brand.<path>}` strings, which are content, not component references. None of the four brands in the designated source workspace held a `contentKey` (no logo or image reference), so the handler has no companions and, in practice, no references. Newer brands carry more `colorScheme`, `borderRadius` and `fontWeight` keys than older ones; both shapes round-trip unchanged.
- **Envelope:** no fields beyond apiName, title, urlName and the runtime fields; `contentFqn` is `marketing--<workspace>.sfdc_cms__brand--<apiName>`.
- **Create** (`POST /connect/cms/contents`, `contentType: sfdc_cms__brand`, root folder, body taken from an existing brand) works in a second workspace of the same org and in the other org; each copy is a Draft with its own content key; readback equals the file.
- **Unchanged:** the redeploy read 8 GETs and sent no write.
- **Update** (`PUT /connect/cms/contents/variants/{id}` with `{apiName, title, urlName, contentBody}`) is accepted: a changed `colorScheme.primaryAccent` and `baseFontSize` were stored, identity, content key and Draft state stayed, re-retrieve equals the edited file, the next deploy found nothing to write. Checkpoint C4 did not fire for update.
- **UI:** the CMS workspace lists the brand as type Brand, English (default), Draft; its preview renders the changed primary color. The UI also offers a "German" entry in the language list of the item although only the `en_US` variant exists (workspace-enabled language, no variant).

## 18. Media findings (W4, 2026-11-21, API 68.0, live on both orgs)

All [LIVE vdb:content.deploy-media-image-document-audio-api68]. Writes were agent-owned `CMSV1_*` fixtures only (generated PNG 73 bytes, text 61 bytes, WAV 444 bytes).

- **Native shape.** `contentBody['sfdc_cms:media'] = {source: {type: 'file', ref, size, fileSize?, mimeType}, url: '/cms/media/<key>?version=<v>&fileHash=<md5>&fileName=<name>'}`, plus `altText` on images. No `sfdc_cms:title` / `sfdc_cms:urlName` in media bodies, so title and urlName stay in the envelope. The native file name exists only as the `fileName` URL parameter; system images can have a name without extension. An external-URL image has `source = {type: 'url', url, mimeType: null, fileSize: null}` and `url` equal to `source.url`.
- **Create.** `POST /connect/cms/contents`, multipart: part `ManagedContentInputParam` (JSON `{apiName, title, urlName, contentSpaceOrFolderId, contentType, contentBody: {altText?, 'sfdc_cms:media': {source: {type: 'file'}}}}`) and part `contentData` (`filename` = native name, `Content-Type` = MIME). Works on v68 for all three types, in a second workspace and in the other org; `sfdc_cms__document` is the type name (resolves question 9). The stored file keeps the sent name, MIME type and bytes (md5 = `fileHash`).
- **Update (resolves questions 4 and 5).** `PUT /connect/cms/contents/variants/{id}`, multipart: part `ManagedContentVariantInputParam` with `{apiName, title, urlName, contentBody}` plus `contentData`. Sending these three envelope fields every time worked for Image, Document and Audio; the earlier "'name' is required" error came from an empty JSON part. A bytes-only change and a metadata-only change (title, altText; same bytes re-sent) both worked; each PUT stores a new file version (`version` 1.1 → 1.2 → 1.3), identity, content key and Draft stay.
- **Download.** The authenticated `/cms/media/…` GET answered 301 to `*.file.force.com`, then 200 with the native MIME type and the exact bytes (md5 = `fileHash`, length = `size`), also for Drafts in all three workspaces.
- **Publish / unpublish** of an Image with `{variantIds, contextContentSpaceId}` work (Published, then Draft). **Delete** of a single-variant media item works; readback 404.
- **Block email with an image reference (W2b open question).** A create whose `imageInfo` holds only `source = {type: 'imageReference', ref: {contentKey}}` (no `url`) is accepted; Salesforce fills `imageInfo.url` (`/cms/media/<key>?fileName=&fileHash=`) itself. Salesforce strips a leading `<!doctype html>` from a `lightning/html` block's `rawHtml` attribute (readback differed until the file matched).
- **UI:** the item page shows the image preview, alt text, file type (`png`, `text`, `wav`) and size, a player for audio, and the status (Draft/Published). It shows the title, not the native file name. The audio page shows a label error "The requested label 'sfdc_cms__contentManifestType.contentManifestType_title' doesn't exist." (UI only).

## 19. Email Fragment, folders and data graph findings (W5, 2026-11-21, API 68.0, live on both orgs)

All [LIVE vdb:content.deploy-email-fragment-folders-api68]. Writes were agent-owned `CMSV1_*` components and folders only; the `CMSF_1015_*` fixtures were read only.

- **Fragment shape.** A user fragment retrieved read-only (bilingual, so `OTHER_VARIANTS_SKIPPED` named `de`) has the body keys of section 3.3 plus `sfdc_cms:urlName` in the body on v68 (section 3.3 said the body has none). Its data provider is the `Marketing` / `default` data graph. The whole body stays in one JSON file (no companions).
- **Block IDs and order.** Create and update store every block `id` and the array order exactly as sent: a fragment created with freshly generated block IDs, then updated with two column children swapped, read back with the same IDs in the new order; the same IDs were kept in all three copies (two workspaces, two orgs). Re-retrieve after the update was byte-identical to the edited file; the next deploy wrote nothing.
- **Image reference in a fragment.** `lightning/image` with `imageInfo.source = {type: 'imageReference', ref: {contentKey}}` and no `url`: create accepted, Salesforce fills `imageInfo.url`. Each copy points at the image of its own workspace (content key rewritten by API name). Deploying the fragment alone into a workspace without that image is refused before any write (`REFERENCE_NOT_IN_DESTINATION`); deploying the image and the fragment in one run creates the image first (preview: `planned-dependencies`) and rewrites the key.
- **Folder create (resolves the W2b open point).** `POST /connect/cms/folders` with `{name, parentFolderId}` (v68; not in the v67 spec) creates a `Standard` folder and answers the folder detail (`id`, `name`, `parentFolderId`, `folderType`, `folderHierarchy`, `isShared: false`). Nested paths are created one level at a time. The new folder is listed by `folder-items` right away, so a redeploy resolves the path and reports `unchanged` without a `FOLDER_NOT_MOVED` warning. Worked in two workspaces of the source org and in the target org. `DELETE /connect/cms/folders/{id}` removed an empty probe folder; a GET of it then answered `INSUFFICIENT_ACCESS` (not 404). The plugin never deletes folders.
- **Folder delete (clean-up, 2026-11-21).** `DELETE /connect/cms/folders/{id}` on empty nested folders (inner first) worked in two workspaces of the source org and in the target org. Afterwards a GET of the folder (REST and the `get_cms_folder` MCP tool alike) answers `INSUFFICIENT_ACCESS`, never 404; the parent's `folder-items` no longer lists it, which is the reliable confirmation. `sf api request rest -X DELETE` (CLI 2.151.7) fails locally with "No 'mode' found in 'body' entry" before sending; a jsforce `connection.request({ method: 'DELETE' })` works.
- **Data spaces.** `GET /ssot/data-spaces?batchSize=&offset=` answers `{dataSpaces: [{name, label, prefix?, status, id}], totalSize, currentPageUrl}`; the source org has `default` and `dataspace2` (prefix `ds2`), the target only `default`.
- **Data graph read.** `GET /ssot/data-graphs/{name}` answers the graph with `dataspaceName`, `status` (`ready`) and more. A graph that does not exist answers **HTTP 400 `INTERNAL_ERROR` "Data Graph not found with name <name>"**, not 404; the plugin treats exactly that answer as missing and any other error as a failed check. `Marketing` exists in `default` in both orgs, so nothing had to be recorded as missing. A provider naming a missing graph or data space was refused before any write in preview and in a real deploy (`DATA_GRAPH_NOT_IN_DESTINATION`, `DATA_SPACE_NOT_IN_DESTINATION`), with no folder created.
- **Lifecycle.** Publish (`#DEPLOYED`, `publishDate`), unpublish and delete of a single-variant fragment worked; readback 404 `VARIANT_NOT_FOUND`; the folder it lived in stays (empty).
- **UI:** the workspace lists `CMSV1_f1` as a folder; inside `CMSV1_f2` the fragment shows as "Content Block: Email", English (default), Published after publish; its page shows the location `CMSV1_f2`, the referenced image above the edited paragraph, and the status. After delete the folder is empty.

## 20. Parity findings (W7, 2026-11-21, API 68.0, installed tarball, live on both orgs)

All [LIVE vdb:content.parity-installed-tarball-api68]. Writes were agent-owned `CMSV1P_*` components only, deleted afterwards.

- **Publish and unpublish accepted for every parity type.** `{variantIds, contextContentSpaceId}` (publish also `includeContentReferences: false`) published and unpublished a single-variant Brand, Document and Audio item as well as Image, Email, Email Template and Email Fragment (SOQL `IsPublished` / `ManagedContentVariantStatus` Published, then Draft). Checkpoint C4 did not fire for any parity type.
- **Brand delete accepted.** `DELETE /contents/variants/{id}` removed a single-variant Brand; readback `VARIANT_NOT_FOUND`. All 7 deletes answered success (no `DELETE_ANSWER_IGNORED`).
- **Installed tarball:** the packed plugin, installed into an isolated Salesforce CLI state, behaves like the linked build: zero writes on unchanged redeploys, the fragment with a nested folder and an image created in the same run deploys after the image, and re-retrieve equals the edited files byte for byte.

## 21. Remaining Marketing types (X0)

Discovery for the 21 remaining Marketing types of `cms_v1_more_types_20261121.plan.md` (2026-11-21, API 68.0, `isolated-source` read-only plus Chrome on the CMS UI; [LIVE vdb:content.discovery-remaining-marketing-types-api68]). `sf cms retrieve` cannot read these types yet (`UNKNOWN_TYPE`, no handler), so the variants were read with a raw `GET /connect/cms/contents/variants/{id}` and the header `X-Chatter-Entity-Encoding: false`, one existing item per type. Sanitized copies are in `test/fixtures/native/<type>.variant.json` (placeholder IDs; content keys `MCGOLDENXZERO…`; a landing page's template key and the reusable block key point at the template and web fragment fixtures).

### 21.1 Availability

`get_content_types_for_workspace` lists all 21 types in source `Default_Content_Workspace`, source `Cloud_Kicks` and target `Default_Content_Workspace` (34 types each, same list). The type list is no proof that the UI can create a type (see 21.4).

Existing items (SOQL, source / target): every source sample lives in source `Default_Content_Workspace`; the target holds one each of web fragment, consent banner, form handler, form, landing page template and landing page only. Preference Page: 0 / 0, so no native sample exists.

### 21.2 Shapes and transport

- **Media family: Video, Custom Font, Contact Card (VCF).** `contentBody['sfdc_cms:media'] = {source: {type: 'file', ref: <0sN…>, size, fileSize?, mimeType}, url: '/cms/media/<key>?version=&fileHash=&fileName='}` and no `sfdc_cms:title`, exactly like Image/Document/Audio, so `mediaHandler(type, apiName)` fits (multipart, binary companion named after `fileName`). MIME types seen: `video/mp4`, `font/ttf`, `text/vcard`. The Custom Font guide documents the same multipart create (`ManagedContentInputParam` + `contentData`) and an external `source: {type: 'url', url}` form. **VCF also carries `vcfData`** (the vCard text) next to `sfdc_cms:media` (the same vCard as a file); which one wins on create/update is open (X1 checkpoint).
- **Block family: Web Fragment, Consent Banner, Form Handler, Form, Landing Page Template, Landing Page.** JSON. `sfdc_cms:block` tree like Email Fragment (block IDs, `lightning/*` blocks, brand tokens `{!$brand.…}` as content), `lightning:brandSource`, `lightning:dataProviders`, `sfdc_cms:title`. Extra top-level keys: consent banner `lightning:colorScheme`, `lightning:horizontalAlignment`, `lightning:verticalAlignment`, `lightning:padding`, `maxWidth`, `minWidth` (buttons carry `sfdc_cms__consentAcceptAction` / `…RejectAction`); form `formsubmission.actions[]` (`sfdc_cms/umaFormSubmissionAction` with `{!$form.id}` / `{!$form.fields}` / `{!$page.id}` placeholders, `sfdc_cms/showThankYouAction`) and a submit button with `sfdc_cms/customEventAction`; landing page and template `sfdc_cms:seoProperties` (`isIndexed`, `title`), `sfdc_cms:description`, `sfdc_cms:urlName`, `sfdc_cms:variants`, `lightning:backgroundImage`, `lightning:expressions`. **Form Handler** (UI fixture) has an empty root block only: no field mapping, object, flow or form reference in the body.
- **Messaging family: SMS and MMS, Push, In-App, RCS, WhatsApp Session.** JSON, no companions needed: SMS `messageContent`, `messagePurpose`, `enableMmsMedia`, `enableUrlShortening`; Push `notificationType`, `notificationBlock` (`sfdc_cms__pushNotificationBasic`, `sfdc_cms__pushNotificationActions` with `actionUrl`), `totalBytes` / `usedBytes` (strings); In-App `inAppType`, `inAppImageLayoutType`, `inAppBlock` (title/message/media/buttons/container style sub-blocks); RCS `rcsType`, `messagePurpose`, `rcsBlock` (`message`, `quickReplies[]`); WhatsApp Session `messageType`, `contentBlock` (`sfdc_cms__whatsappMessageTypeText`). All carry the `Marketing` / `default` data graph provider, `lightning:expressions`, `sfdc_cms:variants`, `sfdc_cms:title`. **No sender, channel, app, keyword or account ID appears in any messaging body.**
- **Expression:** JSON `{expression: {expressionGroups: [{name, resource: '{!$dataGraph.<field>}'}]}, lightning:dataProviders}`; its data graph provider has `dataGraphApiName` but **no `dataspace`**.
- **Tracked Link:** JSON `{campaign, destinationUrl, utmSource}`; no `sfdc_cms:title`.
- `apiName` equals the content key for the UI-created Push, WhatsApp Session and Expression samples (section 14).

### 21.3 References

| Type                  | Field path                                                                     | Value kind                                       | Target                       | contentKey? |
| --------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------ | ---------------------------- | ----------- |
| Landing Page          | `sfdc_cms:template.definition`                                                 | bare content key `MC…` under key `definition`    | Landing Page Template        | **no (K4)** |
| Landing Page, LP Tpl. | block `sfdc_cms/reusableContentBlock` → `attributes.content.definition`        | string `@cms/<content key>`                      | Web Fragment                 | **no (K4)** |
| LP, LP Tpl., In-App   | `…imageInfo.source.ref.contentKey`, In-App `…media…link.source.ref.contentKey` | `contentKey: "MC…"` (+ derived `url`)            | Image                        | yes         |
| Tracked Link          | `campaign`                                                                     | Campaign record ID (`701…`)                      | Campaign sObject (not CMS)   | **no (K4)** |
| all block/messaging   | `lightning:dataProviders[].attributes.dataGraphApiName` / `dataspace`          | API names                                        | Data 360 data graph / space  | n/a (check) |
| Expression            | same, `dataspace` missing                                                      | API name only                                    | data graph                   | n/a (K4)    |
| Video, Font, VCF      | `sfdc_cms:media.source.ref`                                                    | `0sN…` file ID, derived                          | own file (dropped, as media) | n/a         |
| Form                  | `formsubmission.actions[].attributes.*`                                        | `{!$form.id}`, `{!$page.id}` runtime expressions | none                         | n/a         |
| all                   | `lightning:brandSource`                                                        | `defaultBrandOption: sfdcBrand` in all samples   | (Brand by `contentKey`)      | yes         |

The template's and the landing page's `@cms/…` block is the same item; the page body copies the template's block tree and adds `sfdc_cms:template`. No email in the source workspace embeds a fragment (39 email/template/fragment bodies, zero `@cms/` or `reusableContentBlock`), so whether emails embed Email Fragments / Universal Fragments the same way is unverified. Form ↔ Form Handler and Form/Consent Banner embedded in a landing page: no sample holds such a link.

### 21.4 Universal Fragment, Mobile Inbox, SMS DLT Template, WhatsApp Template (UI create)

Tried in the source `Default_Content_Workspace` UI (Add → Content), Draft only; **no item was created**:

- **Universal Fragment:** offered in the create dialog; the editor (`contentEditor.app?…contentTypeFQN=sfdc_cms__fragment&mode=create`) stays on "Loading…" (over a minute, also after a reload; the Aura `ContentEditorApp.appInit` request stays pending, Save disabled). Blocked.
- **WhatsApp Template Message:** editor loads; warning "We couldn't find a WhatsApp Business Account. Link a WhatsApp Business Account through Meta's Business Manager and try again."; WhatsApp Business Account and Language are disabled; Save → "WhatsApp Business Account is required. Language is required. Template is required." Blocked (K3, no WABA).
- **Mobile Inbox Message** and **SMS Message Template (DLT):** **not offered** in the create dialog although the type API lists them; the editor URL with their type answers "Looks like you don't have permission to access that content, or the content was deleted." Blocked (missing mobile app / DLT setup or feature not enabled; the UI does not say which).

### 21.5 Lifecycle as the UI shows it (read-only)

Every sample page has **Edit**, a workflow **Start** ("Basic Approval Request"; not on messaging types) and a menu with **Publish** (Unpublish when published), **Delete**, **Copy to another folder**; **Preview** for landing page, template, video and all messaging types; **Edit Details** for In-App and RCS; **Create Content** for a landing page template. Tabs: URL (landing page), Embed (form), Code Snippet (form handler: "After you publish the form, return here to find the code block to embed it on an external site"), Performance (landing page, SMS, push, in-app, WhatsApp session, tracked link). **No Send, Activate or Schedule action on any type**; publish side effects of messaging types are still to be observed live (K2).

### 21.6 Per-type summary

| Type                  | Transport       | References (contentKey?)                                            | Prerequisites / side effects                                           | Blocked      |
| --------------------- | --------------- | ------------------------------------------------------------------- | ---------------------------------------------------------------------- | ------------ |
| Video                 | multipart media | none                                                                | none                                                                   | no           |
| Custom Font           | multipart media | none                                                                | none                                                                   | no           |
| Contact Card (VCF)    | multipart media | none                                                                | `vcfData` duplicates the file (precedence open)                        | no           |
| Web Fragment          | JSON            | image (yes), data graph                                             | none                                                                   | no           |
| Consent Banner        | JSON            | data graph (empty in samples)                                       | none                                                                   | no           |
| Form Handler          | JSON            | none in body                                                        | mapping/flow configured outside the body (K5); snippet after publish   | no (K5 open) |
| Form                  | JSON            | data graph                                                          | embed code after publish                                               | no           |
| Landing Page Template | JSON            | image (yes), web fragment (`@cms/`, **no**)                         | org perms Landing Page Templates + CMS Templates (guide); publish = K1 | no           |
| Landing Page          | JSON            | template (`definition`, **no**), web fragment (**no**), image (yes) | UI needs a published template (section 8); public URL on publish (K1)  | no           |
| Preference Page       | JSON (assumed)  | unknown (no sample)                                                 | create publishes (section 3.8, K1)                                     | no sample    |
| SMS and MMS           | JSON            | data graph                                                          | MMS media off in sample                                                | no           |
| SMS DLT Template      | —               | —                                                                   | not offered in UI; editor "no permission"                              | **yes**      |
| Push Notification     | JSON            | data graph                                                          | none in body                                                           | no           |
| In-App                | JSON            | image (yes), data graph                                             | none in body                                                           | no           |
| Mobile Inbox          | —               | —                                                                   | not offered in UI; editor "no permission"                              | **yes**      |
| RCS                   | JSON            | data graph                                                          | none in body                                                           | no           |
| WhatsApp Session      | JSON            | data graph                                                          | none in body                                                           | no           |
| WhatsApp Template     | —               | —                                                                   | no WhatsApp Business Account                                           | **yes**      |
| Expression            | JSON            | data graph without `dataspace` (K4)                                 | none                                                                   | no           |
| Tracked Link          | JSON            | Campaign record ID (**no**, K4)                                     | a Campaign of the same name must exist in the destination              | no           |
| Universal Fragment    | —               | —                                                                   | UI editor never finishes loading                                       | **yes**      |

All 21 types are listed for all three designated workspaces.

### 21.7 Proposed registry order (28 handlers)

brand, image, document, audio, video, custom-font, vcf, expression, tracked-link, fragment, email-fragment, email-template, email, web-fragment, consent-banner, form-handler, form, landing-page-template, landing-page, preference-page, sms, sms-dlt-template, push-notification, in-app, inbox, rcs, whatsapp-session, whatsapp-template.

Links behind it: everything may reference Brand and Image (`contentKey`); landing page → template (`sfdc_cms:template`) and → web fragment (`@cms/`), template → web fragment and image; in-app → image; SMS/MMS media may reference image/video/audio; expressions and tracked links can be used by emails, pages and messages (no live sample yet), and a universal fragment by any channel, so those go before the channel types. Deploy order still comes from `dependencyOrder`; the registry is the tie-break.

### 21.8 Pipeline changes needed (K4), proposed, not implemented

1. **Content keys outside `contentKey` (Landing Page, Landing Page Template; likely emails embedding fragments).** Extend the reference walk in `json-projection.ts` / `json-source.ts` with two value forms: a `definition` string `@cms/<key>` and the bare key in `sfdc_cms:template.definition`. On retrieve replace the string by a logical value (for example `{ "type": "web-fragment", "apiName": "…", "format": "@cms/" }`), include it in `references()`, and write it back as `@cms/<destination key>` / `<destination key>` on deploy. Smallest change: one list of `{ key, pattern, format }` entries next to `CONTENT_KEY`.
2. **Record IDs (Tracked Link `campaign`).** Retrieve stores the Campaign by name, deploy looks the name up in the destination by SOQL and blocks (`REFERENCE_NOT_IN_DESTINATION`) when it is missing or not unique. Smallest change: an optional `RetrieveContext.recordName(id)` and `DeployContext.recordId(sObject, name)` so the handler stays pure; only the tracked-link handler uses them.
3. **Data graph provider without `dataspace` (Expression).** `data-graph-check.ts` skips such providers today, so a missing graph is not caught. Smallest change: check the graph by name when `dataspace` is absent (or treat it as `default`, after a live check of what Salesforce assumes).

Not K4 (handler-level or checkpoints): VCF `vcfData` versus file (X1); Form Handler mapping outside the body (K5); preference page create publishing (K1); messaging publish side effects (K2); the four blocked types (K3).

### 21.9 K4 implemented (2026-11-21)

- **Reference forms.** Besides `contentKey`, every type now recognises `definition: "@cms/<key>"` anywhere and the bare key in `sfdc_cms:template.definition`. The file holds `{ type, apiName, format }` (`format` `@cms/<contentKey>` or `<contentKey>`); deploy writes the destination key back in that format. They count for references, deploy order and `REFERENCE_NOT_IN_DESTINATION`. A handler adds forms with `referenceDeclarations.forms`.
- **Record references.** A handler declares body paths holding record IDs (`referenceDeclarations.records`, such as `{ path: ['campaign'], sobject: 'Campaign' }`). Retrieve reads the name by ID (`SELECT Id, Name FROM Campaign WHERE Id IN (…)`) and writes `{ sobject, name }`; deploy reads the ID by name (`… WHERE Name = '…' LIMIT 2`) and refuses before any write: none `RECORD_REFERENCE_NOT_FOUND`, several `RECORD_REFERENCE_AMBIGUOUS`. An ID without a record stays and warns `RECORD_REFERENCE_UNRESOLVED`. Live, read-only: the source tracked link's Campaign `701aj…` is "All Email Marketing"; by name it is one record in each org (source `701aj…`, target `701fj…`, different IDs); the source ID does not exist in the target. SOQL `Name =` is case-insensitive.
- **Data graph without `dataspace`** (Expression) is checked by graph name in `default`.

## 22.X2a Content Block: Landing Page, Consent Banner, Form Handler, Form (X2a, 2026-11-21, API 68.0, live on both orgs)

All [LIVE vdb:content.deploy-web-blocks-api68]. Writes were agent-owned `CMSX2_*` components only (an image, a web fragment, a consent banner, a form handler and a form, built from the source samples with new block IDs), deleted afterwards in all three workspaces; the samples were read only.

- **Handlers.** All four are plain JSON handlers on the existing pipeline (`web-fragment`, `consent-banner`, `form-handler`, `form`), whole body in one JSON file, no companions, no reference declarations. No pipeline change (K4) was needed.
- **Round trip.** Create, redeploy unchanged (zero writes: only GETs in the log), update (title, a column padding, the form's thank-you message), re-retrieve equal to the edited files, in source `Default_Content_Workspace`; create and unchanged in `Cloud_Kicks` and in the target `Default_Content_Workspace`. No `READBACK_DIFFERS`.
- **Image in a web fragment.** A `lightning/image` block with `imageInfo.source = {type: 'imageReference', ref: {contentKey}, mimeType, size}` and no `url` was accepted; Salesforce fills `url`. Deploying the image and the fragment in one run creates the image first (`planned-dependencies`); each copy points at the image of its own workspace (target key differs).
- **Data graph.** The web fragment and form samples use the `Marketing` / `default` provider; the consent banner and form handler samples have none. The check passed in both orgs.
- **Publish.** Web fragment and consent banner: publish, unpublish accepted (SOQL Published, then Draft). A web fragment whose referenced image is still Draft publishes (`includeContentReferences: false`). **Form handler and form: Salesforce refuses publish for the samples' shape** with HTTP 400 `INVALID_API_INPUT` "We couldn't publish the form handler because it has one or more errors: A form handler requires at least one input component." (form: "A form requires at least one input component."). Unpublish of the unpublished items answers 400 `INVALID_API_INPUT` "This content isn't published." Delete of all four (and the image) accepted.
- **Form handler mapping (K5).** The editor's settings panel shows Data Source ("maps user data into Salesforce via a data source", Add Data Source), Details, Submission Redirect, Flow (New Flow) and Code Snippet. The source samples have no data source and no fields (empty root block, `lightning:dataProviders: []`), and "Usage Info" lists no other records. So the field mapping, once configured, would sit in the body as a data provider plus input blocks; the flow is a separate Flow. Creating an input component (and so a publishable form or form handler) needs that mapping, which is the K5 checkpoint: not done. `MarketingForm` (not createable) has no records.
- **UI.** Created items show as "Content Block: Landing Page", "Consent Banner", "Form Handler", "Form", Draft, with the edited titles; after publish web fragment and consent banner show Published, after unpublish Draft; after delete the item page answers "You do not have the level of access necessary…".
