# CMS Salesforce CLI plugin

`sf-plugin-cms` adds the `sf cms` commands to Salesforce CLI. They copy Marketing Cloud CMS
content between a CMS workspace and files on your disk: you retrieve emails, templates,
content blocks, landing pages, forms, media files, messages, brands and more into files, keep
them in Git, edit them, preview what a deploy would change and deploy them to the same workspace, another
workspace or another org. The plugin can also delete, publish and unpublish components.

What it is not:

- **Not a backup, restore or migration tool.** It handles the 24 types in the
  [type overview](#type-overview), not everything a CMS workspace holds.
- **Only the default variant.** Each component is handled in its default variant (usually the
  workspace's default language). Other language variants and custom variants are left alone.
- **Not a sending tool.** Deploy never publishes, and nothing is ever sent or activated.

## Install and sign in

You need Salesforce CLI and Node.js `^22.22.2 || ^24.15.0`. Install the plugin from npm:

```sh
sf plugins install sf-plugin-cms
sf cms --help
```

The plugin is not signed, so Salesforce CLI asks you to confirm the installation.

Sign in to the org with the usual Salesforce CLI login and pass its alias with `--target-org`
(or `-o`):

```sh
sf org login web --alias source
```

Your user needs access to the CMS workspaces you work with. Installing the plugin does not grant
any org access.

## Quick start

```sh
# 0. Find the API name of your workspace
sf cms list workspace -o source

# 1. Retrieve all emails and one image into ./cms/
sf cms retrieve -o source --workspace Default_Content_Workspace -m email -m image:Logo

# 2. Edit the files, then see what a deploy would do (read-only)
sf cms deploy -o target --workspace Default_Content_Workspace -m email:Welcome_Email --preview

# 3. Deploy
sf cms deploy -o target --workspace Default_Content_Workspace -m email:Welcome_Email

# Publish it, or take it back to Draft
sf cms publish -o target --workspace Default_Content_Workspace -m email:Welcome_Email
sf cms unpublish -o target --workspace Default_Content_Workspace -m email:Welcome_Email

# Delete a component by name (preview first)
sf cms delete -o target --workspace Default_Content_Workspace -m email:Old_Email --preview
sf cms delete -o target --workspace Default_Content_Workspace -m email:Old_Email
```

The commands:

| Command                 | What it does                                                         |
| ----------------------- | -------------------------------------------------------------------- |
| `sf cms list workspace` | Lists the CMS workspaces of the org, with API name, ID and language. |
| `sf cms list channel`   | Lists the channels of one workspace.                                 |
| `sf cms retrieve`       | Saves components of one workspace as files under `cms/`.             |
| `sf cms deploy`         | Creates or updates components from files; `--preview` only compares. |
| `sf cms delete`         | Deletes components by name and removes their local files.            |
| `sf cms publish`        | Publishes components by name.                                        |
| `sf cms unpublish`      | Takes published components back to Draft.                            |

Every command has `--help` with all flags, and `--json` for machine-readable output. Every
command except `list workspace` needs `--workspace` with the workspace's API name or ID.

## Type overview

Each row is one content type. The second column is the name you use with `-m`. **Available**
means the plugin has that operation. For every operation the plugin sends the request and shows
Salesforce's answer; if Salesforce refuses an operation for a type, you see its error.

| Type                        | `-m` name               | Salesforce name                 | Retrieve   | Create and update     | Delete     | Publish and unpublish |
| --------------------------- | ----------------------- | ------------------------------- | ---------- | --------------------- | ---------- | --------------------- |
| Email                       | `email`                 | `sfdc_cms__email`               | Available  | Available             | Available  | Available             |
| Email template              | `email-template`        | `sfdc_cms__emailTemplate`       | Available  | Available             | Available  | Available             |
| Email fragment              | `email-fragment`        | `sfdc_cms__emailFragment`       | Available  | Available             | Available  | Available             |
| Image                       | `image`                 | `sfdc_cms__image`               | Available  | Available             | Available  | Available             |
| Document                    | `document`              | `sfdc_cms__document`            | Available  | Available             | Available  | Available             |
| Audio                       | `audio`                 | `sfdc_cms__audio`               | Available  | Available             | Available  | Available             |
| Brand                       | `brand`                 | `sfdc_cms__brand`               | Available  | Available             | Available  | Available             |
| SMS and MMS                 | `sms`                   | `sfdc_cms__sms`                 | Available  | Available             | Available  | Available             |
| Push notification           | `push-notification`     | `sfdc_cms__pushNotification`    | Available  | Available             | Available  | Available             |
| In-app message              | `in-app`                | `sfdc_cms__inApp`               | Available  | Available             | Available  | Available             |
| RCS message                 | `rcs`                   | `sfdc_cms__rcs`                 | Available  | Available             | Available  | Available             |
| WhatsApp session message    | `whatsapp-session`      | `sfdc_cms__whatsappSession`     | Available  | Available             | Available  | Available             |
| Video                       | `video`                 | `sfdc_cms__video`               | Available  | Available             | Available  | Available             |
| Custom font                 | `custom-font`           | `sfdc_cms__customFont`          | Available  | Available             | Available  | Available             |
| Contact card (VCF)          | `vcf`                   | `sfdc_cms__vcf`                 | Available  | Available             | Available  | Available             |
| Content block: landing page | `web-fragment`          | `sfdc_cms__webFragment`         | Available  | Available             | Available  | Available             |
| Consent banner              | `consent-banner`        | `sfdc_cms__consentBanner`       | Available  | Available             | Available  | Available             |
| Form handler                | `form-handler`          | `sfdc_cms__formHandler`         | Available  | Available             | Available  | Available             |
| Form                        | `form`                  | `sfdc_cms__form`                | Available  | Available             | Available  | Available             |
| Landing page template       | `landing-page-template` | `sfdc_cms__landingPageTemplate` | Available  | Available             | Available  | Available             |
| Landing page                | `landing-page`          | `sfdc_cms__landingPage`         | Available  | Available             | Available  | Available             |
| Preference page             | `preference-page`       | `sfdc_cms__preferencePage`      | Not tested | Refused by Salesforce | Not tested | Not tested            |
| Expression                  | `expression`            | `sfdc_cms__expression`          | Available  | Available             | Available  | Available             |
| Tracked link                | `tracked-link`          | `sfdc_cms__trackedLink`         | Available  | Available             | Available  | Available             |

### Not handled

- **Preference page.** The plugin knows the type, but Salesforce refuses to create one through
  the API (`CONTENT_TYPE_DISABLED_FOR_API`), so it cannot be copied.
- **Universal fragment** (`sfdc_cms__fragment`). Its CMS editor never finishes loading, so no
  item exists to model it on.
- **Mobile inbox message** and **SMS DLT template.** Not available in the org.
- **WhatsApp template message.** Needs a connected WhatsApp Business Account.

## How it works

### Files on disk

Retrieve writes one folder per workspace and type under `cms/` in the current directory (or
`--output-dir`). Each component is one JSON file named after its API name. Some types keep
parts of the component in files next to the JSON:

| Type                        | Files                                                                                       |
| --------------------------- | ------------------------------------------------------------------------------------------- |
| Email                       | `cms/<workspace>/email/<ApiName>.email.json`, plus `.email.html` and `.email.txt`           |
| Email template              | `cms/<workspace>/email-template/<ApiName>.email-template.json`, plus `.html` and `.txt`     |
| Email fragment              | `cms/<workspace>/email-fragment/<ApiName>.email-fragment.json`                              |
| Image                       | `cms/<workspace>/image/<ApiName>.image.json`, plus the image, such as `Logo.image.logo.png` |
| Document                    | `cms/<workspace>/document/<ApiName>.document.json`, plus the file                           |
| Audio                       | `cms/<workspace>/audio/<ApiName>.audio.json`, plus the file                                 |
| Brand                       | `cms/<workspace>/brand/<ApiName>.brand.json`                                                |
| SMS and MMS                 | `cms/<workspace>/sms/<ApiName>.sms.json`                                                    |
| Push notification           | `cms/<workspace>/push-notification/<ApiName>.push-notification.json`                        |
| In-app message              | `cms/<workspace>/in-app/<ApiName>.in-app.json`                                              |
| RCS message                 | `cms/<workspace>/rcs/<ApiName>.rcs.json`                                                    |
| WhatsApp session message    | `cms/<workspace>/whatsapp-session/<ApiName>.whatsapp-session.json`                          |
| Video                       | `cms/<workspace>/video/<ApiName>.video.json`, plus the file                                 |
| Custom font                 | `cms/<workspace>/custom-font/<ApiName>.custom-font.json`, plus the font file                |
| Contact card (VCF)          | `cms/<workspace>/vcf/<ApiName>.vcf.json`, plus the `.vcf` file                              |
| Content block: landing page | `cms/<workspace>/web-fragment/<ApiName>.web-fragment.json`                                  |
| Consent banner              | `cms/<workspace>/consent-banner/<ApiName>.consent-banner.json`                              |
| Form handler                | `cms/<workspace>/form-handler/<ApiName>.form-handler.json`                                  |
| Form                        | `cms/<workspace>/form/<ApiName>.form.json`                                                  |
| Landing page template       | `cms/<workspace>/landing-page-template/<ApiName>.landing-page-template.json`                |
| Landing page                | `cms/<workspace>/landing-page/<ApiName>.landing-page.json`                                  |
| Preference page             | `cms/<workspace>/preference-page/<ApiName>.preference-page.json`                            |
| Expression                  | `cms/<workspace>/expression/<ApiName>.expression.json`                                      |
| Tracked link                | `cms/<workspace>/tracked-link/<ApiName>.tracked-link.json`                                  |

- `<workspace>` is the API name of the workspace you retrieved from (its ID if it has no API
  name). It tells you where the files came from; `--workspace` on deploy says where they go. So
  you can deploy the same files into another workspace or org without changing them.
- The HTML body of an email or template is in the `.html` file and its plain-text version in the
  `.txt` file. A media file keeps its original file name after `<ApiName>.<type>.`.
- The JSON holds what you need to recreate the component: its API name, title, URL name, folder
  and content. It has no record IDs, no content keys, no values Salesforce generates and no
  status.
- Retrieve replaces an existing file with what the org has.

### Selecting components

- `-m <type>:<ApiName>` selects one component; repeat `-m` to select several, of any types.
  API names are case-sensitive.
- For retrieve, a bare type (`-m email`) selects every component of that type in the workspace.
  Retrieve without `-m` selects every type.
- Deploy takes `-m <type>:<ApiName>` (it reads the file from `cms/*/<type>/` in the current
  directory) or `--source-dir` (`-d`) with a component file, a type folder, a workspace folder
  or `cms/` itself. If the same component is in more than one workspace folder under `cms/`,
  pick one with `-d` (`SOURCE_AMBIGUOUS`).
- Delete, publish and unpublish always name each component: `-m <type>:<ApiName>` or `-d` with
  one component file. A bare type, a wildcard or a folder is refused (`EXACT_SELECTOR_REQUIRED`).

### Preview first

`--preview` on deploy, delete, publish and unpublish reads the org and reports, per component,
what would happen: `create`, `update`, `unchanged`, `delete`, or `blocked` with the reason. It
never writes to the org and never changes your files (it only writes its log file). When a
component needs another component that the same deploy creates first, the preview cannot
compare it yet and reports `planned-dependencies`. A delete preview lists the local files that
would be removed. Deploy preview also lists the folders it would create.

### Deploy

- **Create or update.** A component whose API name the destination workspace does not have is
  created. One it has gets its default variant updated.
- **Unchanged components are not written.** Deploying the same file again reports `unchanged`.
- **Order.** One deploy can hold components of several types. A component that another one
  references is written first: for example an image before the email that uses it, and a
  template and its content blocks before the landing page. Components that reference each other in a circle are refused
  (`DEPENDENCY_CYCLE`).
- **Nothing is written if anything is blocked.** The plugin plans every component first. If one
  is blocked (for example a reference the destination does not have), no component is written.
- **Stops on the first failure.** A failed or unknown write stops the deploy; later components
  report `not-attempted`. Components already written stay written: there is no rollback.
- **Unknown outcome.** When the plugin cannot tell whether a write happened (for example the
  connection dropped, or Salesforce did not answer in time), the result says `unknown`. Check
  the workspace before you run the deploy again; the plugin never repeats a write by itself.
- **Time for each write.** Each write waits up to 120 seconds for Salesforce's answer; reads
  wait 30 seconds. Updating an email can take Salesforce longer than a minute, and a write
  that runs out of time may still be applied afterwards. `--timeout <seconds>` on deploy,
  delete, publish and unpublish sets a longer or shorter wait for the writes.
- **Read back.** After each write the plugin reads the component once and warns
  `READBACK_DIFFERS` if Salesforce stored something different from the file.
- **Deploy never publishes.** A new component is a Draft. Use `sf cms publish` afterwards.

### Retrieve is lenient, deploy is strict

- Retrieve keeps settings the plugin does not recognise in the file. One failing component never
  stops the others.
- Deploy refuses a file with a setting or a companion file it does not recognise, and names it
  (`UNKNOWN_SETTING`). It does not check values: Salesforce decides whether a value is valid,
  and the plugin shows Salesforce's answer.

### Variants

- Retrieve writes only the default variant. If a component has other variants, it warns
  `OTHER_VARIANTS_SKIPPED` and names them (language code or variant name).
- Deploy creates or updates only the default variant in the destination and warns the same way.
  It never creates, changes or removes other variants.
- Publish and unpublish act on the default variant only, with the same warning.
- Delete refuses a component that has other variants (`HAS_OTHER_VARIANTS`), because Salesforce
  would delete them too. Remove the other variants in the workspace first.
- Languages that the workspace allows but the component has no variant for never cause a
  warning.

### Delete and local files

- `sf cms delete` deletes each named component and then reads it back to confirm it is gone.
  A component the workspace does not have reports `unchanged`.
- Delete cannot be undone. Run it with `--preview` first.
- After a confirmed delete, the component's local files (`<ApiName>.<type>.*` in
  `cms/<workspace>/<type>/`) are removed. Pass `--keep-local-files` to keep them.
- Only regular files inside `cms/` are removed, one at a time. If a file cannot be removed, the
  component stays deleted and the command reports `LOCAL_FILE_REMOVAL_FAILED`: remove that file
  by hand instead of repeating the delete.
- Several components are deleted in reverse order: emails first, brands last. Unpublish uses
  the same order (a landing page before its template and content blocks); publish goes the other
  way.
- Folders are never deleted.
- Deleted components stay in Salesforce's recycle bin. Until the bin is emptied, a component
  with the same API name cannot be created in that workspace again: Salesforce refuses with
  "You can't create multiple files with the same file name".

### Publish and unpublish

- `sf cms publish` publishes the default variant of each named component in the workspace.
  Components it references (for example an image in an email) are not published with it.
- `sf cms unpublish` takes the default variant back to Draft.
- Publishing a landing page or landing page template makes a public URL live. Publish says so
  next to the component, in `--preview` and in the normal output (`note` in `--json`).
- After each request the plugin reads the publish state back and warns `STATE_NOT_CONFIRMED`
  if it does not match yet.
- No channel needs to be chosen; Salesforce decides where published content is delivered.

### Output, JSON and error codes

Human output prints one line per component, such as
`created email:Welcome_Email: cms/Default_Content_Workspace/email/Welcome_Email.email.json`,
then a summary line. The exit code is 0 only when nothing failed.

Every problem carries a plugin error code and a short hint:

```text
email:Welcome_Email: REFERENCE_NOT_IN_DESTINATION: <message>
Hint: <what went wrong and what to do>
```

When Salesforce refuses a request, the message shows its HTTP status, error code and
explanation, and the request ID. With `--json`, the output has `status` (`success` or
`failed`), `diagnostics` with `warnings` and `errors` (each with `code`, `message`, `hint` and,
from Salesforce, `status`, `salesforceErrorCode`, `requestId` and `salesforceErrors`, every
error entry Salesforce answered with all its fields) and the per-component `result`. When
several errors come back, the message shows the first one and says how many more there are.
When no answer came, an error also has `timeoutMs`, `elapsedMs` and `transportError` (for
example `{ "name": "AbortError" }` for the plugin's own timeout, or
`{ "name": "FetchError", "code": "ECONNRESET" }` for a dropped connection). All codes and hints
are in [docs/errors.md](docs/errors.md).

Every command writes a log file under `logs/cms/` in the current directory and prints its path.
It holds each request with the HTTP status and response headers Salesforce answered. `--api log`
also writes the request and response bodies into it, including the raw answer; they can hold
your content.

### API version

The plugin uses Salesforce API `68.0` by default. `--api-version` takes another version such
as `69.0`. Folder listing and folder creation need `68.0` or later.

## Folders and references

### Folders

- `folderPath` in the JSON file is the folder the component lives in, as a list of folder names
  from the workspace root, for example `["Newsletters", "2026"]`. An empty list is the root.
- On create, deploy finds that folder in the destination by name. Folders that are missing are
  created, one level at a time, and listed in the result.
- An existing component is never moved to another folder. If its folder differs from the file,
  deploy warns `FOLDER_NOT_MOVED` and leaves it where it is.
- Two folders with the same name at the same level are refused (`FOLDER_AMBIGUOUS`).

### References between components

- When one component uses another (an image in an email or fragment, a brand), the file names
  it by type and API name, for example `"contentKey": { "type": "image", "apiName": "Logo" }`.
- On deploy, the plugin looks up that component by API name in the destination workspace and
  puts in its key there. So the same file works in every workspace and org.
- A referenced component that the destination does not have is refused before any write
  (`REFERENCE_NOT_IN_DESTINATION`), unless the same deploy creates it first. Deploy the image
  and the email together, or the image first.
- If retrieve finds a reference to something that is not in the same workspace, it keeps the
  original key and warns `REFERENCE_UNRESOLVED`. Such a file can only be deployed back into
  the same workspace.
- Some bodies hold the key in another form: a reusable block on a landing page says
  `"definition": "@cms/<key>"`, and a landing page names its template with the bare key in
  `sfdc_cms:template.definition`. The file keeps the form as well, for example
  `"definition": { "type": "web-fragment", "apiName": "Header", "format": "@cms/<contentKey>" }`,
  and deploy writes the destination key back in that form. These references are checked and
  ordered like any other.

### References to Salesforce records

- Some types point to a Salesforce record instead of a CMS component, such as the Campaign of a
  tracked link. The file names the record by name, for example
  `"campaign": { "sobject": "Campaign", "name": "Spring Launch" }`.
- A record type, as in the data source of a form or form handler, is named by its object and
  developer name instead:
  `"recordTypeId": { "sobject": "RecordType", "sobjectType": "Lead", "developerName": "Lead_Default" }`.
  Record type IDs differ between orgs, and Salesforce fails a create that carries another org's
  ID.
- On deploy, the plugin looks the name up in the destination org (read-only). No record of that
  name is refused before any write (`RECORD_REFERENCE_NOT_FOUND`), and so are several
  (`RECORD_REFERENCE_AMBIGUOUS`). The plugin never creates or changes such records.
- The lookup ignores upper and lower case, like Salesforce does. So `"golden campaign"` in the
  file finds `Golden Campaign`, and the component counts as unchanged. Retrieve writes the
  org's exact spelling.
- If retrieve cannot find the record of an ID, it keeps the ID and warns
  `RECORD_REFERENCE_UNRESOLVED`.
- A record ID left in the file is sent as it is, with the warning `RECORD_REFERENCE_RAW_ID`
  (in preview too): the ID may not exist in the destination org.

### Data graph references

- Emails and fragments can use a data graph for personalization. The file keeps it as
  Salesforce stores it: the data graph's API name and its data space.
- Before writing, deploy checks that the destination org has that data space and that the data
  graph exists in it. If not, the deploy is refused (`DATA_SPACE_NOT_IN_DESTINATION`,
  `DATA_GRAPH_NOT_IN_DESTINATION`).
- A provider without a data space (as in an expression) is checked in `default`.
- Names are compared exactly. In data spaces other than `default`, Salesforce gives data graph
  names a prefix; the file holds that prefixed name, and the plugin does not change it.
- This plugin never creates data spaces or data graphs. Deploy data graphs with
  [sf-plugin-data](https://github.com/JoernBerkefeld/sf-plugin-data) first.

### Merge fields across orgs

- Content deployed into another org keeps its merge fields as they are.
- Merge fields read attributes of the data graph: fields of its main object, or fields of a
  related object (such as an address of the person).
- The destination org needs the same data graph: the same name, in the same data space, with
  every field the merge fields use. Moving content into another data space is not supported yet.
- Salesforce accepts a component whose merge field reads an attribute the data graph does not
  have. The merge field then just shows nothing. So deploy checks this first.
- Before writing, deploy reads the data graph in the destination org (read-only). A missing
  data graph is refused (`DATA_GRAPH_NOT_IN_DESTINATION`), and so is a missing attribute
  (`DATA_GRAPH_ATTRIBUTE_MISSING`), in preview too. The message names the data graph, the data
  space, each missing attribute and the sf-plugin-data command that adds them.
- To fix it, add the attributes to the data graph in the destination org, for example with
  sf-plugin-data: `sf data360 deploy -m data-graph:<name> --dataspace <space> --allow-processing`.
  Then deploy the content again.
- This works for every type with a data graph source: emails, email fragments, landing pages
  and their templates, web fragments, SMS, push, in-app, RCS, WhatsApp session messages and
  expressions.
- Each data graph is read once per deploy, however many components use it.
- Salesforce may refuse to delete a data graph ("Unable to delete Data Graph. Try again
  later.") while deleted CMS items in the recycle bin still use it. This was observed; the cause
  is not proven.

## Per-type notes

### Email

- A code email keeps its HTML in `.email.html` and its plain text in `.email.txt`; subject line
  and preheader are in the JSON.
- An email built with blocks keeps its blocks in the JSON. Images in blocks are references.
- The title and URL name are in the content (`sfdc_cms:title`, `sfdc_cms:urlName`). To deploy a
  copy under a new name, change `apiName` and those two fields.

### Email template

- Like a code email: HTML in `.email-template.html`, plain text in `.email-template.txt`.
- The title is in the content (`sfdc_cms:title`), the URL name in the JSON envelope.

### Email fragment

- The whole fragment, including its blocks, is in the JSON. Block IDs and their order are kept
  exactly.
- Fragments often live in folders and reference images; see
  [Folders and references](#folders-and-references).

### Image

- The JSON holds the title, URL name, alt text and MIME type; the image file sits next to it
  with its original file name.
- Every update uploads the file again, which creates a new file version in Salesforce, even
  when only the alt text or title changed.
- An image that points to an external URL has no file; its JSON holds the URL.

### Document and audio

- Like images: metadata in the JSON, the file next to it with its original name.
- File names may contain letters, digits, spaces, dots, parentheses, `+`, `_` and `-`. A file
  name with other characters cannot be retrieved (`INVALID_FILE_NAME`).
- Audio, video, custom fonts and contact cards need the file type in the JSON
  (`"sfdc_cms:media": { "source": { "mimeType": "audio/x-wav" } }`; retrieve writes it).
  Without it, deploy stops before any write with `MEDIA_MIME_TYPE_MISSING`. Images and
  documents fall back to a default type.

### Video, custom font and contact card

- Like images: metadata in the JSON, the file next to it.
- A custom font without `fallbackFont` gets `"arial"` from Salesforce. Keep
  `"fallbackFont": "arial"` in the file, or the next deploy reports an update.
- A contact card keeps the vCard in the `.vcf` file. Salesforce also stores the vCard text in
  `vcfData`; the JSON leaves it out while it equals the file, and deploy fills it from the file.
  A `vcfData` in the JSON that differs from the file is sent as it is.

### Expression and tracked link

- An expression names a data graph without a data space; deploy checks that the graph exists in
  the `default` data space of the destination.
- A tracked link keeps its Campaign by name (see
  [References to Salesforce records](#references-to-salesforce-records)). It never creates
  Campaigns.
- The short link and its expiry that Salesforce adds when you publish a tracked link are not kept
  in the file. A create would drop them, and Salesforce adds them again on publish.

### Brand

- The whole brand (colors, fonts, spacing, buttons) is in the JSON. Values such as
  `{!$brand.spacing.none}` are part of the brand, not references.
- Brands deploy first, so emails and fragments in the same deploy can use them.

### Content block: landing page, consent banner, form handler and form

- The whole component, including its blocks, is in the JSON. Block IDs and their order are
  kept exactly, like an email fragment.
- An image in a landing page content block is a reference: deploy the image in the same run, or
  make sure the destination workspace has an image with that API name.
- A form handler's JSON holds only its blocks and data sources. The flow that processes
  submissions is not part of the component and is not retrieved or deployed.
- A "Salesforce Record" data source keeps its record type by object and developer name (see
  References to Salesforce records), so the same file deploys into another org.
- Salesforce publishes a form or a form handler only when it has at least one input field and a
  Flow added in the CMS editor. Otherwise publish shows Salesforce's error. The plugin does not
  create input field mappings or Flows.

### Landing page templates and landing pages

- The whole page, including its blocks and SEO settings, is in the JSON.
- References are kept by name: images, embedded content blocks (`@cms/<key>` in Salesforce) and,
  for a landing page, its template (`sfdc_cms:template`). Deploy them in the same run, or make
  sure the destination workspace has them; deploy creates them first.
- A landing page can be created while its template is still a draft.
- In another org, publish the content blocks (web fragments) a page uses before the page. When
  they are in the same run, the plugin publishes them first. The template can stay Draft.
- Publishing a landing page makes its public URL live. Salesforce publishes a page or template
  only after the content blocks it embeds are published: publish them in the same run. Unpublish
  them in one run too: the plugin unpublishes the page first, then its template and content
  blocks (Salesforce refuses to unpublish a content block that a published page uses).
- Preference pages: see [Not handled](#not-handled).

### SMS, push, in-app, RCS and WhatsApp session messages

- The whole message (text, blocks, buttons, quick replies, data providers) is in the JSON. No
  sender, channel, app or WhatsApp account is stored in the message, so nothing has to exist in
  the destination besides the data graph and, for in-app messages, the image.
- An in-app message's image is a reference; deploy the image in the same run or before.
- Publishing changes the content status only; the plugin never sends, schedules or activates
  a message.
- Mobile inbox messages, SMS DLT templates and WhatsApp template messages are not handled (see
  [Not handled](#not-handled)).

## Safety and limits

- Run `--preview` before every deploy, delete, publish and unpublish.
- Use a test workspace or a sandbox first. Deletes cannot be undone.
- Retrieve and delete write and remove files only below `cms/`, and only regular files.
- API names must be letters, digits, underscores or hyphens to be used as file names
  (`INVALID_FILE_NAME`).
- Writes are sent once: no retry and no rollback. After an `unknown` result, check the workspace
  first.
- Media files are downloaded only from Salesforce hosts, and the org's session is never sent
  anywhere else.
- Retrieving every image, document or audio file of a large workspace downloads every file.
  Select components by name where you can.

## Local development

```sh
npm ci
npm run build
npm run lint
npm test
node bin/run.js cms --help
```

`bin/run.js` runs the commands from the checkout without installing them into Salesforce CLI.
The tests run offline and never contact an org.

## More documentation

- [Error codes](docs/errors.md).
- [sf-plugin-cms on sfmc.guide](https://sfmc.guide/tools/sf-plugin-cms/).

Release notes are in GitHub Releases.
