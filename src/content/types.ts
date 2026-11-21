import type { Diagnostic } from '../errors/registry.js';
import type { CmsWorkspace } from '../services/workspaces.js';

/** A component another component points to: resolved by API name in the destination workspace. */
export type LogicalReference = { type: string; apiName: string };

/**
 * The component JSON, `<ApiName>.<type>.json`. It holds what is needed to recreate the default
 * variant: no record IDs, generated values or status. Native fields the plugin does not know
 * stay as top-level keys.
 */
export type SourceDocument = {
  apiName: string;
  /** Left out when the body holds it as `sfdc_cms:title` (the body wins on create). */
  title?: string;
  /** Left out when the body holds it as `sfdc_cms:urlName`. */
  urlName?: string;
  /** Folder names from below the workspace root down to the component's folder; [] = root. */
  folderPath: string[];
  /** The native body; references are `contentKey: { type, apiName }`, companions are left out. */
  contentBody: Record<string, unknown>;
  [field: string]: unknown;
};

/**
 * One component on disk: the JSON document plus companion files next to it. A companion's key
 * is the file-name suffix after `<ApiName>.<type>` (such as `.html`); its value is text (UTF-8)
 * or bytes.
 */
export type SourceFiles = {
  type: string;
  document: SourceDocument;
  companions: Record<string, string | Uint8Array>;
};

/** A variant as `GET /connect/cms/contents/variants/{id}` returns it (raw text). */
export type NativeVariant = Record<string, unknown> & {
  apiName?: string;
  contentBody?: Record<string, unknown>;
  folder?: { id?: string } | null;
};

/** What `toSource` gets besides the native variant; the pipeline resolves it beforehand. */
export type RetrieveContext = {
  workspace: CmsWorkspace;
  /** Logical path of the variant's folder (see SourceDocument.folderPath). */
  folderPath: string[];
  /** The component a content key of this workspace names, if any. */
  referenceOf: (contentKey: string) => LogicalReference | undefined;
  /** Record a warning for this component (the pipeline adds the component name). */
  warn: (warning: Omit<Diagnostic, 'component'>) => void;
  /** Media types: the uploaded file, downloaded by the pipeline beforehand. */
  media?: MediaFile;
};

/** The binary of a media component: its native file name and bytes. */
export type MediaFile = { fileName: string; bytes: Uint8Array };

/**
 * Deploy payload of one component, as the files say: the create/update fields with logical
 * references (`contentKey: { type, apiName }`) and the folder path still unresolved.
 */
export type DeployPayload = {
  apiName: string;
  title?: string;
  urlName?: string;
  folderPath: string[];
  /** Native body with companions put back; references are still logical. */
  contentBody: Record<string, unknown>;
  /** Other envelope fields of the file (`externalId`, `externalSource`), sent on create. */
  createOnly: Record<string, unknown>;
  /** Media types: the file to upload (multipart create/update) and its part MIME type. */
  file?: MediaFile & { mimeType?: string };
};

/** Deploy-side context: the destination workspace. */
export type DeployContext = { workspace: CmsWorkspace };

/**
 * Everything type-specific about one content type. Adding a type = one handler file, its golden
 * fixtures and one entry in the registry. No lifecycle flags: delete/publish/unpublish always
 * send the request and report Salesforce's answer.
 */
export interface ContentTypeHandler {
  /** CLI name used in `-m`, folder and file names: `sfdc_cms__emailTemplate` -> `email-template`. */
  readonly type: string;
  /** Salesforce content type, such as `sfdc_cms__email`. */
  readonly apiName: string;
  readonly transport: 'json' | 'multipart';
  /** Retrieve projection: native default variant -> files. Pure; no I/O. */
  toSource(native: NativeVariant, context: RetrieveContext): SourceFiles;
  /**
   * Deploy payload from files, references unresolved. Pure. Throws UNKNOWN_SETTING for a field
   * or companion file the type does not have.
   */
  fromSource(files: SourceFiles, context: DeployContext): DeployPayload;
  /** What must exist in the destination for the payload, distinct, in body order. */
  references(payload: DeployPayload): LogicalReference[];
}
