import type { Connection } from '@salesforce/core';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { WorkspaceExportMedia } from '../contracts/workspace-export.js';
import {
  IMAGE_IMPORT_IDENTITY_FIELDS,
  InvalidImageImportMapError,
  type ImageImportFieldPlan,
  type ImageImportIdentityField,
  type WorkspaceImageImportAssetResult,
  type WorkspaceImageImportResultV2,
} from '../contracts/workspace-import.js';
import { CmsRequestError, type JsonRequestOptions } from '../transport/json-request.js';
import {
  buildDocumentCreateMultipart,
  createDocumentContent,
  MAX_IMAGE_BYTES,
  type ManagedContentDocumentBinding,
  type MultipartImageCreateOptions,
  type ImageCreateInput,
} from '../transport/multipart-image-create.js';
import { assertCanonicalContentKey } from './content-key.js';
import { lookupExactCmsVariants } from './cms-prerequisite-lookup.js';
import {
  loadWorkspaceExport,
  readStableRegularFile,
  rewriteAtomic,
  type LoadedWorkspaceExport,
  type WorkspaceImportItem,
} from './import-workspace.js';
import { getContent, getVariant, getWorkspace } from './read.js';
import type { ImageImportApplyResult, ImageImportRunReport } from './image-import.js';
import {
  downloadExperimentalCmsMedia,
  type ExperimentalMediaDownloadOptions,
} from '../transport/experimental-media.js';
import { redactSecrets } from '../transport/redact-secrets.js';

const DOCUMENT_TYPE = 'sfdc_cms__document';

export type DocumentImportApplyOptions = DocumentImportPreflightOptions & {
  readonly reportDirectory: string;
  readonly createOptions?: Pick<MultipartImageCreateOptions, 'timeoutMs' | 'signal'>;
  readonly mediaOptions: Pick<
    ExperimentalMediaDownloadOptions,
    'instanceUrl' | 'accessToken' | 'fetch'
  >;
  readonly reportPersistence?: {
    readonly rewrite: (file: string, report: ImageImportRunReport) => Promise<void>;
  };
};

type RequestConnection = Pick<Connection, 'request'>;
export type PlannedDocumentImport = {
  readonly source: WorkspaceImportItem;
  readonly media: WorkspaceExportMedia;
  readonly identities: Record<ImageImportIdentityField, ImageImportFieldPlan>;
};
export type DocumentImportPreflightOptions = {
  readonly connection: RequestConnection;
  readonly destinationOrgId: string;
  readonly destinationWorkspaceId: string;
  readonly plans: readonly PlannedDocumentImport[];
  readonly requestOptions?: JsonRequestOptions;
  readonly source: LoadedWorkspaceExport;
};
export type DocumentImportPreflightResult = {
  readonly contractResult: WorkspaceImageImportResultV2;
  readonly dryRun: true;
  readonly plans: readonly PlannedDocumentImport[];
};

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function fail(message: string): never {
  throw new InvalidImageImportMapError(message);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  if (Object.keys(value).toSorted().join('\0') !== [...keys].toSorted().join('\0'))
    fail(`${label} contains unsupported or missing fields`);
}

function nonempty(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) fail(`${label} must be nonempty`);
}

function fieldPlan(
  raw: unknown,
  field: ImageImportIdentityField,
  item: WorkspaceImportItem,
): ImageImportFieldPlan {
  if (!record(raw)) fail(`${field} strategy must be an object`);
  exactKeys(raw, ['strategy', ...(raw.value === undefined ? [] : ['value'])], field);
  const strategy = raw.strategy;
  if (strategy !== 'preserve' && strategy !== 'fresh' && strategy !== 'generated')
    fail(`${field} strategy is unsupported`);
  const source = typeof item[field] === 'string' ? item[field] : undefined;
  if (strategy === 'generated') {
    if (field === 'title' || field === 'apiName' || raw.value !== undefined)
      fail(`${field} generated strategy is unsupported or has a value`);
    return { strategy, ...(source === undefined ? {} : { source }) };
  }
  const submitted = strategy === 'preserve' ? source : raw.value;
  nonempty(submitted, `${field} ${strategy} value`);
  if (strategy === 'preserve' && raw.value !== undefined) fail(`${field} preserve must omit value`);
  if (strategy === 'fresh' && submitted === source)
    fail(`${field} fresh value must differ from source`);
  if (field === 'contentKey')
    assertCanonicalContentKey(
      submitted,
      'Document contentKey',
      (message) => new InvalidImageImportMapError(message),
    );
  if (field === 'urlName' && !/^[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?(?![\s\S])/u.test(submitted))
    fail('Document urlName must be lowercase alphanumeric/hyphen and at most 80 characters');
  return { strategy, ...(source === undefined ? {} : { source }), submitted };
}

function assertDocumentEvidence(
  source: LoadedWorkspaceExport,
  item: WorkspaceImportItem,
  media: WorkspaceExportMedia,
): void {
  const body = item.contentBody;
  const native = body['sfdc_cms:media'];
  if (!record(native) || !record(native.source)) fail('Document native file evidence is missing');
  exactKeys(body, ['sfdc_cms:media'], 'Document body');
  exactKeys(native, ['source', 'url'], 'Document media');
  exactKeys(native.source, ['type', 'ref', 'size', 'mimeType'], 'Document media source');
  nonempty(native.source.ref, 'Document native file ref');
  if (
    native.source.type !== 'file' ||
    native.source.mimeType !== 'text/plain' ||
    media.mimeType !== 'text/plain'
  )
    fail('Document import admits only native file text/plain');
  if (
    media.variantId !== item.id ||
    media.contentKey !== item.contentKey ||
    item.contentSpace.id !== source.manifest.workspaceId
  )
    fail('Document descriptor is not bound to source variant/content key/workspace');
  if (media.bytes !== native.source.size || media.bytes <= 0 || media.bytes > MAX_IMAGE_BYTES)
    fail('Document byte size is inconsistent or exceeds the 10 MiB cap');
  const status = item.status;
  if (
    !record(status) ||
    status.status !== media.sourceStatus ||
    item.lastModifiedDate !== media.sourceModifiedAt
  )
    fail('Document descriptor status/modified evidence is not bound to source');
  if (native.url !== media.sourceUrl || typeof native.url !== 'string')
    fail('Document source URL is not bound');
  const url = new URL(native.url, 'https://invalid.example');
  if (
    !/^\/cms\/media\/[^/]+$/u.test(url.pathname) ||
    [...url.searchParams.keys()].toSorted().join(',') !== 'fileHash,fileName,version' ||
    url.searchParams.get('fileName') !== media.fileName ||
    url.searchParams.get('fileHash')?.toLowerCase() !== media.md5 ||
    url.searchParams.get('version') !== media.sourceVersion
  )
    fail('Document native filename/hash/version URL evidence is not bound');
  if (!media.fileName.endsWith('.txt')) fail('Document filename must end in lowercase .txt');
  const declared = source.manifest.items.find(({ path: file }) => file === media.path);
  if (declared?.kind !== 'cms.media' || declared.sha256 !== media.sha256)
    fail('Document binary manifest binding is missing');
  assertCanonicalContentKey(
    item.contentKey,
    'Document source contentKey',
    (message) => new InvalidImageImportMapError(message),
  );
}

/**
 * Select explicitly mapped Documents without relaxing the general import policy.
 * @param {LoadedWorkspaceExport} source - Strictly loaded package.
 * @param {unknown} input - Explicit Document identity map.
 * @returns {PlannedDocumentImport[]} Narrow source-bound plans.
 */
export function planDocumentImports(
  source: LoadedWorkspaceExport,
  input: unknown,
): PlannedDocumentImport[] {
  if (source.manifest.schemaVersion !== 2 || !source.integrity.verified)
    fail('Document import requires verified strict manifest v2');
  if (!Array.isArray(input) || input.length !== 1)
    fail('Document map must select exactly one Document');
  const raw: unknown = input[0];
  if (!record(raw)) fail('Document map row must be an object');
  exactKeys(raw, ['source', ...IMAGE_IMPORT_IDENTITY_FIELDS], 'Document map row');
  if (!record(raw.source)) fail('Document selector must be an object');
  const selector = raw.source;
  exactKeys(
    selector,
    [
      'family',
      'type',
      'apiName',
      ...['title', 'workspaceId', 'language', 'serverId', 'version'].filter(
        (key) => selector[key] !== undefined,
      ),
    ],
    'Document selector',
  );
  if (selector.family !== 'cms' || selector.type !== 'document')
    fail('Document map must explicitly select cms/document');
  nonempty(selector.apiName, 'Document source API name');
  const matches = source.items.filter(
    (item) => item.contentType === DOCUMENT_TYPE && item.apiName === selector.apiName,
  );
  if (matches.length !== 1) fail('Document source API name must match exactly one native Document');
  const item = matches[0];
  for (const [key, actual] of Object.entries({
    title: item.title,
    workspaceId: item.contentSpace.id,
    language: item.language,
    serverId: item.id,
    version: item.managedContentVersionId,
  })) {
    if (selector[key] !== undefined && selector[key] !== actual)
      fail(`Document selector ${key} binding does not match`);
  }
  if (
    source.manifest.dependencies.length > 0 ||
    source.manifest.externalReferences.some(
      (reference) =>
        reference.source.sourceId === item.id ||
        (reference.required && reference.resolution !== 'included'),
    ) ||
    'references' in item ||
    'referencesList' in item ||
    (item.externalSource !== undefined && item.externalSource !== null) ||
    (item.externalId !== undefined && item.externalId !== null)
  )
    fail('Document external references and unresolved package dependencies are blocked');
  const media = source.manifest.media?.filter((descriptor) => descriptor.variantId === item.id);
  if (media?.length !== 1) fail('Document source must have exactly one bound media descriptor');
  assertDocumentEvidence(source, item, media[0]);
  const identities = Object.fromEntries(
    IMAGE_IMPORT_IDENTITY_FIELDS.map((field) => [field, fieldPlan(raw[field], field, item)]),
  ) as PlannedDocumentImport['identities'];
  const plan = { source: item, media: media[0], identities };
  buildDocumentCreateMultipart(
    documentCreateInput(plan, 'validation-workspace'),
    media[0].fileName,
    new Uint8Array(1),
  );
  return [plan];
}

/**
 * Build only the supported native Document CREATE identity envelope.
 * @param {PlannedDocumentImport} plan - Admitted identity plan.
 * @param {string} workspaceId - Exact destination workspace.
 * @returns {ImageCreateInput} Multipart identity input without source refs.
 */
export function documentCreateInput(
  plan: PlannedDocumentImport,
  workspaceId: string,
): ImageCreateInput {
  return {
    apiName: plan.identities.apiName.submitted!,
    title: plan.identities.title.submitted!,
    contentSpaceOrFolderId: workspaceId,
    ...(plan.identities.contentKey.submitted === undefined
      ? {}
      : { contentKey: plan.identities.contentKey.submitted }),
    ...(plan.identities.urlName.submitted === undefined
      ? {}
      : { urlName: plan.identities.urlName.submitted }),
  };
}

/**
 * Revalidate the entire package and selected bytes before destination access.
 * @param {LoadedWorkspaceExport} source - Previously verified package.
 * @param {readonly PlannedDocumentImport[]} plans - Previously admitted single selection.
 * @returns {Promise<Buffer>} Hash/MD5/size verified Document bytes.
 */
export async function readDocumentImportBytes(
  source: LoadedWorkspaceExport,
  plans: readonly PlannedDocumentImport[],
): Promise<Buffer> {
  const fresh = await loadWorkspaceExport(source.sourceDirectory, {
    profile: 'general',
    allowPartial: source.isPartial,
  });
  if (!isDeepStrictEqual(fresh, source)) fail('Document source package changed after validation');
  if (plans.length !== 1) fail('Document preflight requires exactly one plan');
  const plan = plans[0];
  const row = {
    source: {
      family: 'cms',
      type: 'document',
      apiName: plan.source.apiName,
      serverId: plan.source.id,
    },
    ...Object.fromEntries(
      IMAGE_IMPORT_IDENTITY_FIELDS.map((field) => [
        field,
        {
          strategy: plan.identities[field].strategy,
          ...(plan.identities[field].strategy === 'fresh'
            ? { value: plan.identities[field].submitted }
            : {}),
        },
      ]),
    ),
  };
  if (!isDeepStrictEqual(planDocumentImports(fresh, [row]), plans))
    fail('Document plan changed after admission');
  const bytes = await readStableRegularFile(
    path.join(fresh.sourceDirectory, ...plan.media.path.split('/')),
    'Document binary',
  );
  if (
    bytes.length !== plan.media.bytes ||
    createHash('sha256').update(bytes).digest('hex') !== plan.media.sha256 ||
    createHash('md5').update(bytes).digest('hex') !== plan.media.md5
  )
    fail('Document local binary SHA-256/MD5/size verification failed');
  buildDocumentCreateMultipart(
    documentCreateInput(plan, 'validation-workspace'),
    plan.media.fileName,
    bytes,
  );
  return bytes;
}

/**
 * Check exact Document destination scope and collision evidence without mutation.
 * @param {DocumentImportPreflightOptions} options - Source, single plan and destination.
 * @returns {Promise<DocumentImportPreflightResult>} Existing v2 planned result contract.
 */
export async function preflightDocumentImports(
  options: DocumentImportPreflightOptions,
): Promise<DocumentImportPreflightResult> {
  nonempty(options.destinationOrgId, 'destinationOrgId');
  nonempty(options.destinationWorkspaceId, 'destinationWorkspaceId');
  await readDocumentImportBytes(options.source, options.plans);
  const workspace = await getWorkspace(
    options.connection,
    options.destinationWorkspaceId,
    options.requestOptions,
  );
  if (workspace.id !== options.destinationWorkspaceId)
    fail('Document destination workspace binding mismatch');
  const plan = options.plans[0];
  const input = documentCreateInput(plan, options.destinationWorkspaceId);
  const matches = await lookupExactCmsVariants(
    options.connection,
    options.destinationWorkspaceId,
    DOCUMENT_TYPE,
    input.apiName!,
    (detail) => {
      nonempty(detail.apiName, 'Document destination API name');
      return detail.apiName === input.apiName;
    },
    options.requestOptions,
  );
  if (matches.length > 0) fail('Document destination API name already exists or is ambiguous');
  if (input.contentKey !== undefined) {
    try {
      await getContent(options.connection, input.contentKey, {}, options.requestOptions);
      fail('Document destination content key already exists');
    } catch (error) {
      if (!(
        error instanceof CmsRequestError &&
        error.operationKey === 'content.get' &&
        (error.status === 404 ||
          ((error.status === 400 || error.status === undefined) &&
            error.errorEntryCount === 1 &&
            error.errorCode === 'INVALID_ID_FIELD' &&
            error.responseMessage === 'Provide a valid content key, ID, or FQN.'))
      ))
        throw error;
    }
  }
  const asset: WorkspaceImageImportAssetResult = {
    source: {
      family: 'cms',
      type: 'document',
      apiName: plan.source.apiName!,
      title: plan.source.title,
      workspaceId: plan.source.contentSpace.id,
      language: plan.source.language,
      serverId: plan.source.id,
    },
    resolution: {
      method: 'explicit-map',
      target: {
        family: 'cms',
        type: 'document',
        apiName: input.apiName!,
        workspaceId: options.destinationWorkspaceId,
      },
    },
    identities: plan.identities,
    binary: {
      path: plan.media.path,
      sha256: plan.media.sha256,
      md5: plan.media.md5,
      bytes: plan.media.bytes,
      mimeType: plan.media.mimeType,
    },
    metadataReadback: 'not-attempted',
    byteProof: 'unavailable',
    operationStatus: 'planned',
    reportStatus: 'not-created',
  };
  return {
    dryRun: true,
    plans: options.plans,
    contractResult: {
      sourcePackage: {
        manifestSha256: options.source.manifestSha256,
        workspaceId: options.source.manifest.workspaceId,
        manifestVersion: 2,
      },
      target: { orgId: options.destinationOrgId, workspaceId: options.destinationWorkspaceId },
      status: 'planned',
      assets: [asset],
    },
  };
}

async function assertReportParent(directory: string, sourceDirectory: string): Promise<void> {
  nonempty(directory, 'reportDirectory');
  const resolved = path.resolve(directory);
  const relative = path.relative(path.resolve(sourceDirectory), resolved);
  if (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  )
    fail('Document report directory must be outside the source package');
  let current = path.dirname(resolved);
  for (;;) {
    const metadata = await lstat(current);
    if (
      !metadata.isDirectory() ||
      metadata.isSymbolicLink() ||
      path.resolve(await realpath(current)).toLowerCase() !== current.toLowerCase()
    )
      fail('Document report parent must not contain links or reparse points');
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

async function writeDocumentIntent(file: string, report: ImageImportRunReport): Promise<void> {
  const handle = await open(file, 'wx');
  try {
    await handle.writeFile(`${JSON.stringify(report, null, 2)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function rewriteDocumentReport(file: string, report: ImageImportRunReport): Promise<void> {
  await rewriteAtomic(file, report, {
    openPath: async (temporary, flags) => {
      const handle = await open(temporary, flags);
      return {
        writeFile: async (value, encoding) => {
          await handle.writeFile(value, encoding);
          await handle.sync();
        },
        close: async () => handle.close(),
      };
    },
  });
}

function verifyDocumentReadback(
  detail: Record<string, unknown>,
  input: ImageCreateInput,
  binding: ManagedContentDocumentBinding,
  plan: PlannedDocumentImport,
  instanceUrl: string,
): { returned: Record<ImageImportIdentityField, string>; url: URL } {
  const returned = Object.fromEntries(
    IMAGE_IMPORT_IDENTITY_FIELDS.map((field) => {
      nonempty(detail[field], `Document readback ${field}`);
      return [field, detail[field]];
    }),
  ) as Record<ImageImportIdentityField, string>;
  const type = record(detail.contentType)
    ? detail.contentType.fullyQualifiedName
    : detail.contentType;
  if (
    !record(detail.contentSpace) ||
    detail.contentSpace.id !== input.contentSpaceOrFolderId ||
    type !== DOCUMENT_TYPE ||
    detail.managedContentId !== binding.managedContentId ||
    detail.managedContentVariantId !== binding.managedContentVariantId ||
    returned.contentKey !== binding.contentKey ||
    returned.apiName !== input.apiName ||
    returned.title !== input.title ||
    (input.contentKey !== undefined && returned.contentKey !== input.contentKey) ||
    (input.urlName !== undefined && returned.urlName !== input.urlName) ||
    detail.isPublished !== false ||
    !record(detail.status) ||
    detail.status.status !== 'Draft'
  )
    fail('Document metadata identity/parent/variant/workspace/Draft verification failed');
  assertCanonicalContentKey(
    binding.contentKey,
    'created Document contentKey',
    (message) => new InvalidImageImportMapError(message),
  );
  if (!record(detail.contentBody)) fail('Document readback body is missing');
  exactKeys(detail.contentBody, ['sfdc_cms:media'], 'Document readback body');
  const native = detail.contentBody['sfdc_cms:media'];
  if (!record(native) || !record(native.source)) fail('Document readback native file is missing');
  exactKeys(native, ['source', 'url'], 'Document readback media');
  exactKeys(native.source, ['type', 'ref', 'size', 'mimeType'], 'Document readback source');
  nonempty(native.source.ref, 'Document created native ref');
  if (
    native.source.type !== 'file' ||
    native.source.mimeType !== 'text/plain' ||
    native.source.size !== plan.media.bytes
  )
    fail('Document native metadata MIME/size mismatch');
  nonempty(native.url, 'Document created media URL');
  const url = new URL(native.url, instanceUrl);
  if (
    url.pathname !== `/cms/media/${binding.contentKey}` ||
    [...url.searchParams.keys()].toSorted().join(',') !== 'fileHash,fileName,version' ||
    url.searchParams.get('fileName') !== plan.media.fileName ||
    url.searchParams.get('fileHash')?.toLowerCase() !== plan.media.md5 ||
    !url.searchParams.get('version')
  )
    fail('Document created media URL binding mismatch');
  return { returned, url };
}

/**
 * Create one Document only after durable intent; prove exact native metadata and bytes independently.
 * @param {DocumentImportApplyOptions} options - Admitted package, destination and exclusive journal directory.
 * @returns {Promise<ImageImportApplyResult>} Existing v2 contract with exact byte proof.
 */
export async function applyDocumentImports(
  options: DocumentImportApplyOptions,
): Promise<ImageImportApplyResult> {
  const preflight = await preflightDocumentImports(options);
  await assertReportParent(options.reportDirectory, options.source.sourceDirectory);
  nonempty(options.mediaOptions.accessToken, 'Document download accessToken');
  const instance = new URL(options.mediaOptions.instanceUrl);
  if (
    instance.protocol !== 'https:' ||
    instance.username ||
    instance.password ||
    (instance.port && instance.port !== '443')
  )
    fail('Document readback requires a safe authenticated HTTPS instance');
  const plan = options.plans[0];
  const bytes = await readDocumentImportBytes(options.source, options.plans);
  const input = documentCreateInput(plan, options.destinationWorkspaceId);
  const multipart = buildDocumentCreateMultipart(input, plan.media.fileName, bytes);
  const requestSha256 = createHash('sha256').update(multipart.body).digest('hex');
  const runId = randomUUID();
  const requestIdentity = `create-document\u0000${input.apiName}\u0000${requestSha256}`;
  const operation = {
    operationId: createHash('sha256').update(`${runId}\u0000${requestIdentity}`).digest('hex'),
    requestIdentity,
    requestSha256,
    sourceApiName: plan.source.apiName!,
    destinationApiName: input.apiName!,
    destinationOrgId: options.destinationOrgId,
    destinationWorkspaceId: options.destinationWorkspaceId,
    runId,
    state: 'pending' as 'pending' | 'succeeded' | 'failed',
    result: undefined as { contentKey: string; contentId: string; variantId: string } | undefined,
    error: undefined as string | undefined,
  };
  const report: ImageImportRunReport = {
    runId,
    sourceDirectory: options.source.sourceDirectory,
    sourceManifestSha256: options.source.manifestSha256,
    destinationOrgId: options.destinationOrgId,
    destinationWorkspaceId: options.destinationWorkspaceId,
    operations: [operation],
    state: 'applying',
  };
  const directory = path.resolve(options.reportDirectory);
  await mkdir(directory);
  const reportFile = path.join(directory, 'workspace-import-run.json');
  await writeDocumentIntent(reportFile, report);
  const rewrite = options.reportPersistence?.rewrite ?? rewriteDocumentReport;
  let attempted = false;
  try {
    // Persist the pending intent before rechecking both destination and source immediately before POST.
    await rewrite(reportFile, report);
    await preflightDocumentImports(options);
    const currentBytes = await readDocumentImportBytes(options.source, options.plans);
    if (
      !currentBytes.equals(bytes) ||
      createHash('sha256')
        .update(
          buildDocumentCreateMultipart(
            documentCreateInput(plan, options.destinationWorkspaceId),
            plan.media.fileName,
            currentBytes,
            { boundaryFactory: () => multipart.boundary },
          ).body,
        )
        .digest('hex') !== requestSha256
    )
      fail('Document submitted request changed after durable intent');
    attempted = true;
    report.state = 'ownership-uncertain';
    const binding = await createDocumentContent(
      options.connection,
      input,
      plan.media.fileName,
      currentBytes,
      {
        ...options.createOptions,
        boundaryFactory: () => multipart.boundary,
      },
    );
    operation.result = {
      contentKey: binding.contentKey,
      contentId: binding.managedContentId,
      variantId: binding.managedContentVariantId,
    };
    await rewrite(reportFile, report);
    const detail = await getVariant(
      options.connection,
      binding.managedContentVariantId,
      options.requestOptions,
    );
    const { returned, url } = verifyDocumentReadback(
      detail,
      input,
      binding,
      plan,
      options.mediaOptions.instanceUrl,
    );
    const outputFile = path.join(directory, 'document-readback.txt');
    const download = await downloadExperimentalCmsMedia(url, {
      ...options.mediaOptions,
      outputFile,
      contentType: DOCUMENT_TYPE,
      expectedMd5: plan.media.md5,
      expectedMimeType: plan.media.mimeType,
      expectedSize: bytes.length,
    });
    const readback = await readStableRegularFile(outputFile, 'Document downloaded readback');
    if (
      !readback.equals(bytes) ||
      download.sha256 !== plan.media.sha256 ||
      download.md5 !== plan.media.md5 ||
      download.bytes !== bytes.length
    )
      fail('Document downloaded bytes/SHA-256/MD5/size do not equal submitted bytes');
    operation.state = 'succeeded';
    report.state = 'completed';
    await rewrite(reportFile, report);
    const asset: WorkspaceImageImportAssetResult = {
      ...preflight.contractResult.assets[0],
      resolution: {
        ...preflight.contractResult.assets[0].resolution!,
        target: {
          ...preflight.contractResult.assets[0].resolution!.target,
          title: returned.title,
          serverId: binding.managedContentVariantId,
        },
      },
      mutation: {
        requestSha256,
        contentId: binding.managedContentId,
        variantId: binding.managedContentVariantId,
      },
      identities: Object.fromEntries(
        IMAGE_IMPORT_IDENTITY_FIELDS.map((field) => [
          field,
          { ...plan.identities[field], returned: returned[field] },
        ]),
      ) as PlannedDocumentImport['identities'],
      metadataReadback: 'passed',
      byteProof: 'passed',
      operationStatus: 'succeeded',
      reportStatus: 'recorded',
    };
    return {
      dryRun: false,
      report,
      reportFile,
      contractResult: { ...preflight.contractResult, status: 'completed', assets: [asset] },
    };
  } catch (error) {
    // A POST attempt is never retried and cannot be claimed absent, even when evidence persistence fails.
    report.state = attempted ? 'ownership-uncertain' : 'failed';
    operation.state = attempted ? 'pending' : 'failed';
    operation.error = redactSecrets(error instanceof Error ? error.message : String(error)).slice(
      0,
      1024,
    );
    try {
      await rewrite(reportFile, report);
    } catch {
      /* Last durable pending intent remains the reconciliation source. */
    }
    if (error instanceof Error)
      Object.defineProperty(error, 'documentImportEvidence', {
        value: { report, reportFile },
        enumerable: false,
      });
    throw error;
  }
}
