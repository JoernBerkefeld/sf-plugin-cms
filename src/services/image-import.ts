import type { Connection } from '@salesforce/core';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, open } from 'node:fs/promises';
import path from 'node:path';
import type { WorkspaceExportMedia } from '../contracts/workspace-export.js';
import {
  IMAGE_IMPORT_IDENTITY_FIELDS,
  InvalidImageImportMapError,
  type ComponentStableIdentity,
  type ImageImportFieldPlan,
  type ImageImportIdentityField,
  type ImageImportStrategy,
  type WorkspaceImageImportAssetResult,
  type WorkspaceImageImportResultV2,
} from '../contracts/workspace-import.js';
import {
  CmsRequestError,
  getSelectedOperation,
  requestJson,
  type JsonRequestOptions,
} from '../transport/json-request.js';
import {
  readStableRegularFile,
  rewriteAtomic,
  type LoadedWorkspaceExport,
  type WorkspaceImportItem,
} from './import-workspace.js';
import { getContent, getVariant, getWorkspace } from './read.js';
import {
  buildImageCreateMultipart,
  createImageContent,
  type ImageCreateInput,
  type ManagedContentDocumentBinding,
  type MultipartImageCreateOptions,
} from '../transport/multipart-image-create.js';

export type ImageImportMapField = {
  readonly strategy: ImageImportStrategy;
  readonly value?: string;
};
export type ImageImportMapRow = {
  readonly source: ComponentStableIdentity;
  readonly contentKey: ImageImportMapField;
  readonly apiName: ImageImportMapField;
  readonly title: ImageImportMapField;
  readonly urlName: ImageImportMapField;
};
export type PlannedImageImport = {
  readonly source: WorkspaceImportItem;
  readonly media: WorkspaceExportMedia;
  readonly identities: Record<ImageImportIdentityField, ImageImportFieldPlan>;
};

type RequestConnection = Pick<Connection, 'request'>;

export type ImageImportPreflightOptions = {
  readonly connection: RequestConnection;
  readonly destinationOrgId: string;
  readonly destinationWorkspaceId: string;
  readonly plans: readonly PlannedImageImport[];
  readonly requestOptions?: JsonRequestOptions;
  readonly source: LoadedWorkspaceExport;
};

export type ImageImportPreflightResult = {
  readonly contractResult: WorkspaceImageImportResultV2;
  readonly dryRun: true;
  readonly plans: readonly PlannedImageImport[];
};

export type ImageImportOperation = {
  readonly operationId: string;
  readonly requestIdentity: string;
  readonly requestSha256: string;
  readonly sourceApiName: string;
  readonly destinationApiName: string;
  readonly destinationOrgId: string;
  readonly destinationWorkspaceId: string;
  readonly runId: string;
  state: 'pending' | 'succeeded' | 'failed';
  error?: string;
  result?: {
    readonly contentKey: string;
    readonly contentId: string;
    readonly variantId: string;
  };
};

export type ImageImportRunReport = {
  readonly runId: string;
  readonly sourceDirectory: string;
  readonly sourceManifestSha256: string;
  readonly destinationOrgId: string;
  readonly destinationWorkspaceId: string;
  readonly operations: ImageImportOperation[];
  state: 'applying' | 'completed' | 'failed' | 'ownership-uncertain';
};

export type ImageImportReportPersistence = {
  readonly rewrite: (file: string, report: ImageImportRunReport) => Promise<void>;
};

export type ImageImportApplyOptions = ImageImportPreflightOptions & {
  readonly reportDirectory: string;
  readonly reportPersistence?: ImageImportReportPersistence;
  readonly createOptions?: MultipartImageCreateOptions;
};

export type ImageImportApplyResult = {
  readonly contractResult: WorkspaceImageImportResultV2;
  readonly dryRun: false;
  readonly report: ImageImportRunReport;
  readonly reportFile: string;
};

type DestinationImageCandidate = {
  readonly apiName: string;
  readonly id: string;
  readonly workspaceId: string;
};

const IMAGE_TYPE = 'sfdc_cms__image';
const SEARCH_PAGE_SIZE = 250;
const SEARCH_PAGE_CAP = 1000;
const IMAGE_MIME_EXTENSIONS: Readonly<Record<string, readonly string[]>> = {
  'image/gif': ['gif'],
  'image/jpeg': ['jpg', 'jpeg'],
  'image/png': ['png'],
  'image/webp': ['webp'],
};
const IMAGE_MIME_DEFAULT_EXTENSION: Readonly<Record<string, string>> = {
  'image/gif': 'gif',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

export function normalizeImageMultipartFilename(fileName: string, mimeType: string): string {
  const allowed = IMAGE_MIME_EXTENSIONS[mimeType];
  const defaultExtension = IMAGE_MIME_DEFAULT_EXTENSION[mimeType];
  if (allowed === undefined || defaultExtension === undefined) {
    throw new TypeError(`Image import MIME type is unsupported: ${mimeType}`);
  }
  const extension = path.extname(fileName).slice(1).toLowerCase();
  if (extension.length === 0) return `${fileName}.${defaultExtension}`;
  if (!allowed.includes(extension)) {
    throw new TypeError('Image import filename extension does not match MIME type');
  }
  return fileName;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function fail(message: string): never {
  throw new InvalidImageImportMapError(message);
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  if (Object.keys(value).toSorted().join('\0') !== [...expected].toSorted().join('\0')) {
    fail(`${label} must contain exactly ${expected.join(', ')}`);
  }
}

function nonempty(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) fail(`${label} must be nonempty`);
}

function sourceValue(
  item: WorkspaceImportItem,
  field: ImageImportIdentityField,
): string | undefined {
  const value = item[field];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function validateField(
  raw: unknown,
  field: ImageImportIdentityField,
  item: WorkspaceImportItem,
): ImageImportFieldPlan {
  if (!record(raw)) fail(`${field} strategy must be an object`);
  exactKeys(raw, ['strategy', ...(raw.value === undefined ? [] : ['value'])], field);
  const strategy = raw.strategy;
  if (!['preserve', 'fresh', 'generated'].includes(strategy as string)) {
    fail(`${field} strategy is unsupported`);
  }
  if (field === 'title' && strategy === 'generated') fail('title does not support generated');
  const source = sourceValue(item, field);
  if (strategy === 'preserve') {
    if (raw.value !== undefined) fail(`${field} preserve must not provide a value`);
    if (source === undefined)
      fail(`${field} cannot be preserved because the source value is missing`);
    return { strategy, source, submitted: source } as ImageImportFieldPlan;
  }
  if (strategy === 'fresh') {
    nonempty(raw.value, `${field} fresh value`);
    if (raw.value === source) fail(`${field} fresh value must differ from the source`);
    return {
      strategy,
      ...(source === undefined ? {} : { source }),
      submitted: raw.value,
    } as ImageImportFieldPlan;
  }
  if (raw.value !== undefined) fail(`${field} generated must omit value`);
  return { strategy, ...(source === undefined ? {} : { source }) } as ImageImportFieldPlan;
}

function stableIdentity(plan: PlannedImageImport): string {
  return ['contentKey', 'apiName', 'urlName']
    .map((field) => {
      const value = plan.identities[field as ImageImportIdentityField];
      return value.strategy === 'generated' ? '' : (value.submitted ?? '');
    })
    .join('\0');
}

export function planImageImports(
  source: LoadedWorkspaceExport,
  input: unknown,
): PlannedImageImport[] {
  if (source.manifest.schemaVersion !== 2)
    fail('Image import requires a strict manifest v2 package');
  if (!Array.isArray(input) || input.length === 0) fail('Image map must be a nonempty array');
  const media = new Map(
    (source.manifest.media ?? []).map((descriptor) => [descriptor.variantId, descriptor]),
  );
  const selected = new Set<string>();
  const targets = new Set<string>();
  const plans: PlannedImageImport[] = [];
  for (const [index, raw] of input.entries()) {
    if (!record(raw)) fail(`Image map row ${index} must be an object`);
    exactKeys(raw, ['source', ...IMAGE_IMPORT_IDENTITY_FIELDS], `Image map row ${index}`);
    if (!record(raw.source)) fail(`Image map row ${index}.source must be an object`);
    const selector = raw.source;
    exactKeys(
      selector,
      [
        'family',
        'type',
        'apiName',
        ...(selector.title === undefined ? [] : ['title']),
        ...(selector.workspaceId === undefined ? [] : ['workspaceId']),
        ...(selector.language === undefined ? [] : ['language']),
        ...(selector.serverId === undefined ? [] : ['serverId']),
        ...(selector.version === undefined ? [] : ['version']),
      ],
      `Image map row ${index}.source`,
    );
    if (selector.family !== 'cms' || selector.type !== 'image') {
      fail(`Image map row ${index}.source must select cms/image`);
    }
    nonempty(selector.apiName, `Image map row ${index}.source.apiName`);
    for (const key of ['title', 'workspaceId', 'language'] as const) {
      if (selector[key] !== undefined)
        nonempty(selector[key], `Image map row ${index}.source.${key}`);
    }
    if (selector.serverId !== undefined)
      nonempty(selector.serverId, `Image map row ${index}.source.serverId`);
    if (selector.version !== undefined)
      nonempty(selector.version, `Image map row ${index}.source.version`);
    const selectionKey = `${selector.family}\0${selector.type}\0${selector.apiName}`;
    if (selected.has(selectionKey))
      fail(`Duplicate component source identity: ${selector.apiName}`);
    const matches = source.items.filter(
      (item) => item.contentType === 'sfdc_cms__image' && item.apiName === selector.apiName,
    );
    if (matches.length !== 1) {
      fail(`Typed source API name must match exactly one manifest entry: ${selector.apiName}`);
    }
    const item = matches[0];
    if (selector.serverId !== undefined && selector.serverId !== item.id) {
      fail(`Source API name and server ID binding do not match: ${selector.apiName}`);
    }
    const descriptor = media.get(item.id);
    if (descriptor === undefined || item.contentType !== 'sfdc_cms__image') {
      fail(`Image map source is non-image or has no bound media: ${selector.apiName}`);
    }
    if (descriptor.contentKey !== item.contentKey)
      fail('Image media descriptor contentKey is not bound to its item');
    const identities = Object.fromEntries(
      IMAGE_IMPORT_IDENTITY_FIELDS.map((field) => [field, validateField(raw[field], field, item)]),
    ) as Record<ImageImportIdentityField, ImageImportFieldPlan>;
    const plan = { source: item, media: descriptor, identities };
    const identity = stableIdentity(plan);
    if (targets.has(identity)) fail('Duplicate planned target stable identity');
    selected.add(selectionKey);
    targets.add(identity);
    plans.push(plan);
  }
  return plans.toSorted((left, right) =>
    `${left.source.apiName}\0${left.source.contentKey}\0${left.source.id}`.localeCompare(
      `${right.source.apiName}\0${right.source.contentKey}\0${right.source.id}`,
    ),
  );
}

function destinationApiName(plan: PlannedImageImport): string {
  const field = plan.identities.apiName;
  if (field.strategy === 'generated' || field.submitted === undefined) {
    throw new TypeError('Destination image API name must be preserved or explicitly fresh');
  }
  return field.submitted;
}

function destinationContentKey(plan: PlannedImageImport): string | undefined {
  const field = plan.identities.contentKey;
  return field.strategy === 'generated' ? undefined : field.submitted;
}

function isSalesforceMissingContentKey(error: unknown): boolean {
  return (
    error instanceof CmsRequestError &&
    error.operationKey === 'content.get' &&
    (error.status === 404 ||
      (error.status === 400 &&
        error.errorCode === 'INVALID_ID_FIELD' &&
        error.message === 'Provide a valid content key, ID, or FQN.'))
  );
}

async function assertContentKeyAvailable(
  connection: RequestConnection,
  contentKey: string,
  requestOptions: JsonRequestOptions,
): Promise<void> {
  try {
    await getContent(connection, contentKey, {}, requestOptions);
    throw new TypeError(`Destination image content key already exists: ${contentKey}`);
  } catch (error) {
    if (!isSalesforceMissingContentKey(error)) throw error;
  }
}

function searchItems(value: unknown): unknown[] {
  if (!record(value) || !Array.isArray(value.items)) {
    throw new TypeError('Destination image search must return an items array');
  }
  return value.items;
}

function searchCount(value: unknown): number {
  if (record(value)) {
    for (const key of ['total', 'totalCount', 'count']) {
      const count = value[key];
      if (typeof count === 'number' && Number.isInteger(count) && count >= 0) return count;
    }
  }
  throw new TypeError('Destination image search must return a nonnegative count');
}

function searchCandidate(value: unknown, workspaceId: string): DestinationImageCandidate {
  if (
    !record(value) ||
    value.type !== 'ManagedContentVariantSearchResultRepresentation' ||
    typeof value.id !== 'string' ||
    value.id.length === 0 ||
    value.managedContentSpaceId !== workspaceId
  ) {
    throw new TypeError('Destination image search returned ambiguous workspace/type evidence');
  }
  return { apiName: '', id: value.id, workspaceId };
}

function detailType(value: Record<string, unknown>): unknown {
  return record(value.contentType) ? value.contentType.fullyQualifiedName : value.contentType;
}

async function exactApiNameMatches(
  connection: RequestConnection,
  workspaceId: string,
  apiName: string,
  requestOptions: JsonRequestOptions,
): Promise<DestinationImageCandidate[]> {
  const candidates = new Map<string, DestinationImageCandidate>();
  const pageFingerprints = new Set<string>();
  let expectedCount: number | undefined;
  for (let page = 0; page < SEARCH_PAGE_CAP; page += 1) {
    const response = await requestJson<unknown>(
      connection,
      getSelectedOperation('workspace.variant.search'),
      {
        query: {
          contentSpaceOrFolderIds: [workspaceId],
          contentTypeFQN: IMAGE_TYPE,
          languages: ['All'],
          page,
          pageSize: SEARCH_PAGE_SIZE,
          queryTerm: apiName,
        },
      },
      requestOptions,
    );
    const items = searchItems(response.data);
    const count = searchCount(response.data);
    if (expectedCount === undefined) expectedCount = count;
    else if (count !== expectedCount) {
      throw new TypeError('Destination image search count changed during preflight');
    }
    const fingerprint = JSON.stringify(items);
    if (pageFingerprints.has(fingerprint)) {
      throw new TypeError('Destination image search repeated page content');
    }
    pageFingerprints.add(fingerprint);
    for (const item of items) {
      const candidate = searchCandidate(item, workspaceId);
      if (candidates.has(candidate.id)) {
        throw new TypeError('Destination image search returned a duplicate variant identity');
      }
      candidates.set(candidate.id, candidate);
    }
    if (items.length === 0 || candidates.size >= count) break;
    if (page === SEARCH_PAGE_CAP - 1) {
      throw new TypeError('Destination image search exceeded the page safety limit');
    }
  }
  if (expectedCount === undefined || candidates.size !== expectedCount) {
    throw new TypeError('Destination image search did not satisfy its advertised count');
  }

  const matches: DestinationImageCandidate[] = [];
  for (const candidate of candidates.values()) {
    const detail = await getVariant(connection, candidate.id, requestOptions);
    const contentSpace = detail.contentSpace;
    if (
      !record(contentSpace) ||
      contentSpace.id !== workspaceId ||
      detailType(detail) !== IMAGE_TYPE ||
      typeof detail.apiName !== 'string'
    ) {
      throw new TypeError(
        'Destination image detail did not preserve workspace/type/API-name scope',
      );
    }
    if (detail.apiName === apiName) matches.push({ ...candidate, apiName });
  }
  return matches;
}

function sourceIdentity(plan: PlannedImageImport): ComponentStableIdentity {
  return {
    family: 'cms',
    type: 'image',
    apiName: plan.source.apiName!,
    title: plan.source.title,
    workspaceId: plan.source.contentSpace.id as string,
    language: plan.source.language,
    serverId: plan.source.id,
  };
}

function plannedAsset(
  plan: PlannedImageImport,
  destinationWorkspaceId: string,
): WorkspaceImageImportAssetResult {
  const apiName = destinationApiName(plan);
  return {
    source: sourceIdentity(plan),
    resolution: {
      method: 'explicit-map',
      target: {
        family: 'cms',
        type: 'image',
        apiName,
        workspaceId: destinationWorkspaceId,
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
}

/**
 * Validate every planned image against exact destination scope without mutation.
 * @param {ImageImportPreflightOptions} options - Verified source, plans, destination, and transport.
 * @returns {Promise<ImageImportPreflightResult>} Dry-run evidence after every row passes.
 */
export async function preflightImageImports(
  options: ImageImportPreflightOptions,
): Promise<ImageImportPreflightResult> {
  nonempty(options.destinationOrgId, 'destinationOrgId');
  nonempty(options.destinationWorkspaceId, 'destinationWorkspaceId');
  if (options.plans.length === 0) throw new TypeError('Image preflight requires planned images');
  if (!options.source.integrity.verified) throw new TypeError('Source integrity must be verified');
  const workspace = await getWorkspace(
    options.connection,
    options.destinationWorkspaceId,
    options.requestOptions,
  );
  if (workspace.id !== options.destinationWorkspaceId) {
    throw new TypeError('Destination workspace readback did not match the requested workspace');
  }

  const checks = await Promise.all(
    options.plans.map(async (plan) => {
      const apiName = destinationApiName(plan);
      const matches = await exactApiNameMatches(
        options.connection,
        options.destinationWorkspaceId,
        apiName,
        options.requestOptions ?? {},
      );
      if (matches.length > 1) {
        throw new TypeError(`Destination image API name is ambiguous: ${apiName}`);
      }
      if (matches.length === 1) {
        throw new TypeError(`Destination image API name already exists: ${apiName}`);
      }
      const contentKey = destinationContentKey(plan);
      if (contentKey !== undefined) {
        await assertContentKeyAvailable(
          options.connection,
          contentKey,
          options.requestOptions ?? {},
        );
      }
      return plannedAsset(plan, options.destinationWorkspaceId);
    }),
  );

  return {
    contractResult: {
      sourcePackage: {
        manifestSha256: options.source.manifestSha256,
        workspaceId: options.source.manifest.workspaceId,
        manifestVersion: 2,
      },
      target: {
        orgId: options.destinationOrgId,
        workspaceId: options.destinationWorkspaceId,
      },
      status: 'planned',
      assets: checks.toSorted((left, right) =>
        `${left.source.family}\0${left.source.type}\0${left.source.apiName}`.localeCompare(
          `${right.source.family}\0${right.source.type}\0${right.source.apiName}`,
        ),
      ),
    },
    dryRun: true,
    plans: options.plans,
  };
}

async function assertImageIdentityAvailable(
  connection: RequestConnection,
  workspaceId: string,
  plan: PlannedImageImport,
  requestOptions: JsonRequestOptions,
): Promise<void> {
  const apiName = destinationApiName(plan);
  const matches = await exactApiNameMatches(connection, workspaceId, apiName, requestOptions);
  if (matches.length > 0) {
    throw new TypeError(`Destination image API name already exists: ${apiName}`);
  }
  const contentKey = destinationContentKey(plan);
  if (contentKey !== undefined) {
    await assertContentKeyAvailable(connection, contentKey, requestOptions);
  }
}

function createInput(plan: PlannedImageImport, workspaceId: string): ImageCreateInput {
  const input: ImageCreateInput = {
    apiName: destinationApiName(plan),
    contentSpaceOrFolderId: workspaceId,
    title: plan.identities.title.submitted!,
  };
  const contentKey = destinationContentKey(plan);
  if (contentKey !== undefined) input.contentKey = contentKey;
  if (plan.identities.urlName.submitted !== undefined) {
    input.urlName = plan.identities.urlName.submitted;
  }
  return input;
}

function mutationOperation(
  report: ImageImportRunReport,
  plan: PlannedImageImport,
  requestSha256: string,
): ImageImportOperation {
  const requestIdentity = `create-image\u0000${destinationApiName(plan)}\u0000${requestSha256}`;
  return {
    operationId: createHash('sha256')
      .update(`${report.runId}\u0000${requestIdentity}`)
      .digest('hex'),
    requestIdentity,
    requestSha256,
    sourceApiName: plan.source.apiName!,
    destinationApiName: destinationApiName(plan),
    destinationOrgId: report.destinationOrgId,
    destinationWorkspaceId: report.destinationWorkspaceId,
    runId: report.runId,
    state: 'pending',
  };
}

async function writeExclusive(file: string, value: unknown): Promise<void> {
  const handle = await open(file, 'wx');
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
  } finally {
    await handle.close();
  }
}

function returnedField(
  detail: Record<string, unknown>,
  field: 'apiName' | 'contentKey' | 'title' | 'urlName',
): string {
  const value = detail[field];
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`Image readback is missing ${field}`);
  }
  return value;
}

function verifyImageReadback(
  detail: Record<string, unknown>,
  input: ImageCreateInput,
  binding: ManagedContentDocumentBinding,
): Record<ImageImportIdentityField, string> {
  const contentSpace = detail.contentSpace;
  const status = detail.status;
  const returned = {
    apiName: returnedField(detail, 'apiName'),
    contentKey: returnedField(detail, 'contentKey'),
    title: returnedField(detail, 'title'),
    urlName: returnedField(detail, 'urlName'),
  };
  if (
    !record(contentSpace) ||
    contentSpace.id !== input.contentSpaceOrFolderId ||
    detailType(detail) !== IMAGE_TYPE ||
    detail.id !== binding.managedContentVariantId ||
    returned.apiName !== input.apiName ||
    returned.contentKey !== binding.contentKey ||
    returned.title !== input.title ||
    (input.contentKey !== undefined && returned.contentKey !== input.contentKey) ||
    (input.urlName !== undefined && returned.urlName !== input.urlName) ||
    detail.isPublished !== false ||
    !record(status) ||
    status.status !== 'Draft'
  ) {
    throw new TypeError('Image authoring metadata readback identity or Draft verification failed');
  }
  return returned;
}

function completedAsset(
  planned: WorkspaceImageImportAssetResult,
  returned: Record<ImageImportIdentityField, string>,
  binding: ManagedContentDocumentBinding,
  requestSha256: string,
): WorkspaceImageImportAssetResult {
  return {
    ...planned,
    resolution: {
      ...planned.resolution!,
      target: {
        ...planned.resolution!.target,
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
        { ...planned.identities[field], returned: returned[field] },
      ]),
    ) as Record<ImageImportIdentityField, ImageImportFieldPlan>,
    metadataReadback: 'passed',
    byteProof: 'unavailable',
    operationStatus: 'succeeded',
    reportStatus: 'recorded',
  };
}

/**
 * Apply verified image plans sequentially with durable mutation evidence.
 * @param {ImageImportApplyOptions} options - Verified source, destination, plans, and report path.
 * @returns {Promise<ImageImportApplyResult>} Completed v2 evidence and durable report.
 */
export async function applyImageImports(
  options: ImageImportApplyOptions,
): Promise<ImageImportApplyResult> {
  const preflight = await preflightImageImports(options);
  nonempty(options.reportDirectory, 'reportDirectory');
  await mkdir(path.resolve(options.reportDirectory));
  const reportFile = path.join(path.resolve(options.reportDirectory), 'workspace-import-run.json');
  const report: ImageImportRunReport = {
    runId: randomUUID(),
    sourceDirectory: options.source.sourceDirectory,
    sourceManifestSha256: options.source.manifestSha256,
    destinationOrgId: options.destinationOrgId,
    destinationWorkspaceId: options.destinationWorkspaceId,
    operations: [],
    state: 'applying',
  };
  await writeExclusive(reportFile, report);
  const rewrite = options.reportPersistence?.rewrite ?? rewriteAtomic;
  const completed: WorkspaceImageImportAssetResult[] = [];
  try {
    for (const plan of options.plans) {
      await assertImageIdentityAvailable(
        options.connection,
        options.destinationWorkspaceId,
        plan,
        options.requestOptions ?? {},
      );
      const mediaFile = path.join(options.source.sourceDirectory, ...plan.media.path.split('/'));
      const bytes = await readStableRegularFile(mediaFile, `Image media ${plan.media.path}`);
      if (
        bytes.byteLength !== plan.media.bytes ||
        createHash('sha256').update(bytes).digest('hex') !== plan.media.sha256 ||
        createHash('md5').update(bytes).digest('hex') !== plan.media.md5
      ) {
        throw new TypeError(
          `Image media evidence changed after package verification: ${plan.media.path}`,
        );
      }
      const input = createInput(plan, options.destinationWorkspaceId);
      const filename = normalizeImageMultipartFilename(plan.media.fileName, plan.media.mimeType);
      const boundary = `sf-plugin-cms-${randomBytes(24).toString('hex')}`;
      const multipart = buildImageCreateMultipart(input, filename, bytes, {
        boundaryFactory: () => boundary,
      });
      const requestSha256 = createHash('sha256').update(multipart.body).digest('hex');
      const operation = mutationOperation(report, plan, requestSha256);
      report.operations.push(operation);
      await rewrite(reportFile, report);
      let binding: ManagedContentDocumentBinding;
      try {
        binding = await createImageContent(options.connection, input, filename, bytes, {
          ...options.createOptions,
          boundaryFactory: () => boundary,
        });
      } catch (error) {
        operation.error = error instanceof Error ? error.message : String(error);
        report.state = 'ownership-uncertain';
        await rewrite(reportFile, report);
        throw error;
      }
      operation.result = {
        contentKey: binding.contentKey,
        contentId: binding.managedContentId,
        variantId: binding.managedContentVariantId,
      };
      report.state = 'ownership-uncertain';
      await rewrite(reportFile, report);
      const detail = await getVariant(
        options.connection,
        binding.managedContentVariantId,
        options.requestOptions,
      );
      const returned = verifyImageReadback(detail, input, binding);
      operation.state = 'succeeded';
      report.state = 'applying';
      await rewrite(reportFile, report);
      const planned = preflight.contractResult.assets.find(
        ({ source }) => source.apiName === plan.source.apiName,
      )!;
      completed.push(completedAsset(planned, returned, binding, requestSha256));
    }
    report.state = 'completed';
    await rewrite(reportFile, report);
  } catch (error) {
    if (report.state !== 'ownership-uncertain') report.state = 'failed';
    try {
      await rewrite(reportFile, report);
    } catch {
      // Preserve the primary error; the last durable report is the reconciliation source of truth.
    }
    throw error;
  }
  return {
    contractResult: {
      ...preflight.contractResult,
      status: 'completed',
      assets: completed.toSorted((left, right) =>
        left.source.apiName.localeCompare(right.source.apiName),
      ),
    },
    dryRun: false,
    report,
    reportFile,
  };
}
