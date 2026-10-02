import { createHash, randomUUID } from 'node:crypto';
import { mkdir, rmdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { Connection } from '@salesforce/core';
import { loadEditableRawHtml } from './editable-raw-html-import.js';
import { assertNativeBody, decodeNativeHtml } from './import-identities.js';
import {
  loadWorkspaceExport,
  rewriteAtomic,
  type WorkspaceImportItem,
} from './import-workspace.js';
import { updateVariant, type UpdateVariantInput } from './lifecycle-foundation.js';
import { getContent, getVariant, getWorkspace, type CmsRecord } from './read.js';
import { requiredContentIdentifier, requiredVariantIdentifier } from './variant-identity.js';
import {
  getSelectedOperation,
  requestJson,
  type JsonRequestOptions,
} from '../transport/json-request.js';

export const EMAIL_UPDATE_CONTENT_TYPE = 'sfdc_cms__email' as const;
export const EMAIL_TEMPLATE_UPDATE_CONTENT_TYPE = 'sfdc_cms__emailTemplate' as const;
export type UpdateContentType =
  typeof EMAIL_UPDATE_CONTENT_TYPE | typeof EMAIL_TEMPLATE_UPDATE_CONTENT_TYPE;
const PAGE_SIZE = 200;
const MAX_PAGES = 100;

type RequestConnection = Pick<Connection, 'request'> &
  Partial<Pick<Connection, 'accessToken' | 'instanceUrl' | 'version'>>;

type EmailSnapshot = {
  readonly apiName: string;
  readonly contentBody: Readonly<Record<string, unknown>>;
  readonly contentId: string;
  readonly hash: string;
  readonly language: string;
  readonly lifecycle: { readonly isPublished: false; readonly status: 'Draft' };
  readonly title: string;
  readonly urlName?: string;
  readonly variantId: string;
  readonly workspaceId: string;
};

export type EmailUpdateSelector = {
  readonly apiName: string;
  readonly language?: string;
  readonly useDefaultLanguage?: true;
  readonly workspaceId: string;
};

type ResolvedEmailSelector = EmailUpdateSelector & { readonly selectedLanguage: string };

export type EmailUpdateInput = {
  readonly contentType?: UpdateContentType;
  readonly editableDirectory: string;
  readonly requestOptions?: JsonRequestOptions;
  readonly selector: EmailUpdateSelector;
  readonly sourceDirectory: string;
};

export type EmailUpdatePreviewEvidence = {
  readonly apiName: string;
  readonly apiVersion: string;
  readonly baselineHash: string;
  readonly changedFields: readonly ['contentBody.rawHtml'];
  readonly contentId: string;
  readonly contentType: UpdateContentType;
  readonly language: string;
  readonly lifecycle: { readonly isPublished: false; readonly status: 'Draft' };
  readonly org: string;
  readonly payloadHash: string;
  readonly siblingInventory: readonly {
    readonly hash: string;
    readonly language: string;
    readonly lifecycle: { readonly isPublished: false; readonly status: 'Draft' };
    readonly variantId: string;
  }[];
  readonly variantId: string;
  readonly workspaceId: string;
};

export type EmailUpdatePreviewBlocker = {
  readonly code: 'EMAIL_UPDATE_PREFLIGHT_BLOCKED';
  readonly message: string;
};

export type EmailUpdatePreviewResult =
  | {
      readonly blockers: readonly [];
      readonly evidence: EmailUpdatePreviewEvidence;
      readonly status: 'ready';
    }
  | {
      readonly blockers: readonly [EmailUpdatePreviewBlocker, ...EmailUpdatePreviewBlocker[]];
      readonly status: 'blocked';
    };

export type EmailUpdateEvidence = EmailUpdatePreviewEvidence & {
  readonly postUpdateHash: string;
};

export type EmailUpdateRunReport = {
  readonly contract: 'sf-cms-email-template-update-run' | 'sf-cms-email-update-run';
  readonly contractVersion: '1.0.0';
  readonly runId: string;
  readonly state: 'completed' | 'ownership-uncertain' | 'pending';
  readonly target: {
    readonly apiName: string;
    readonly contentId: string;
    readonly language: string;
    readonly variantId: string;
    readonly workspaceId: string;
  };
  readonly intent: {
    readonly changedFields: readonly ['contentBody.rawHtml'];
    readonly payloadHash: string;
  };
  readonly evidence: EmailUpdatePreviewEvidence | EmailUpdateEvidence;
  readonly reconciliation: {
    readonly contentId: string;
    readonly payloadHash: string;
    readonly variantId: string;
    readonly workspaceId: string;
  };
};

type PreparedEmailUpdate = {
  readonly contentType: UpdateContentType;
  readonly evidence: EmailUpdatePreviewEvidence;
  readonly payload: UpdateVariantInput;
  readonly selector: ResolvedEmailSelector;
  readonly snapshot: EmailSnapshot;
};

export class EmailUpdateOutcomeUnknownError extends Error {
  public readonly contentId: string;
  public readonly payloadHash: string;
  public readonly variantId: string;

  public constructor(contentId: string, variantId: string, payloadHash: string, cause: unknown) {
    super('Email update outcome is unknown; perform fresh read-only reconciliation', { cause });
    this.name = 'EmailUpdateOutcomeUnknownError';
    this.contentId = contentId;
    this.variantId = variantId;
    this.payloadHash = payloadHash;
  }
}

export class EmailUpdatePreflightBlockedError extends Error {
  public constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = 'EmailUpdatePreflightBlockedError';
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonempty(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${label} is required`);
  return value;
}

function contentType(recordValue: CmsRecord): unknown {
  return record(recordValue.contentType)
    ? recordValue.contentType.fullyQualifiedName
    : recordValue.contentType;
}

function workspaceId(recordValue: CmsRecord): string {
  if (!record(recordValue.contentSpace)) throw new TypeError('Email contentSpace is required');
  return nonempty(recordValue.contentSpace.id, 'Email contentSpace.id');
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => canonical(item));
  if (!record(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .toSorted()
      .map((key) => [key, canonical(value[key])]),
  );
}

function hash(value: unknown): string {
  return hashBytes(JSON.stringify(canonical(value)));
}

function hashBytes(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function normalizedBody(value: unknown): Readonly<Record<string, unknown>> {
  if (!record(value)) throw new TypeError('Email contentBody is required');
  const body = structuredClone(value);
  if (typeof body.rawHtml === 'string') body.rawHtml = decodeNativeHtml(body.rawHtml);
  return body;
}

function familyLabel(contentTypeValue: UpdateContentType): 'Email' | 'Email Template' {
  return contentTypeValue === EMAIL_TEMPLATE_UPDATE_CONTENT_TYPE ? 'Email Template' : 'Email';
}

function snapshot(
  detail: CmsRecord,
  selector: ResolvedEmailSelector,
  selectedContentType: UpdateContentType,
): EmailSnapshot {
  const label = familyLabel(selectedContentType);
  const variantId = requiredVariantIdentifier(
    detail as Record<string, unknown>,
    `${label} variant`,
  );
  const contentId = requiredContentIdentifier(detail as Record<string, unknown>, `${label} parent`);
  if (variantId === contentId)
    throw new TypeError(`${label} parent and variant identities must differ`);
  if (contentType(detail) !== selectedContentType)
    throw new TypeError(`Destination must be an ${label}`);
  if (workspaceId(detail) !== selector.workspaceId)
    throw new TypeError(`${label} belongs to another workspace`);
  const apiName = nonempty(detail.apiName, `${label} apiName`);
  if (apiName !== selector.apiName) throw new TypeError(`${label} apiName does not match selector`);
  const language = nonempty(detail.language, `${label} language`);
  if (language !== selector.selectedLanguage)
    throw new TypeError(`${label} language does not match selector`);
  if (detail.isPublished !== false || !record(detail.status) || detail.status.status !== 'Draft') {
    throw new TypeError(`${label} update requires an unpublished Draft variant`);
  }
  const title = nonempty(detail.title, `${label} title`);
  const urlName = detail.urlName;
  if (urlName !== undefined && typeof urlName !== 'string')
    throw new TypeError(`${label} urlName is invalid`);
  const contentBody = normalizedBody(detail.contentBody);
  assertNativeBody({
    ...(detail as Record<string, unknown>),
    id: variantId,
    contentType: selectedContentType,
    contentBody,
  } as WorkspaceImportItem);
  const semantic = { apiName, contentBody, title, ...(urlName === undefined ? {} : { urlName }) };
  return {
    apiName,
    contentBody,
    contentId,
    hash: hash(semantic),
    language,
    lifecycle: { isPublished: false, status: 'Draft' },
    title,
    ...(urlName === undefined ? {} : { urlName }),
    variantId,
    workspaceId: selector.workspaceId,
  };
}

async function resolveSelector(
  connection: RequestConnection,
  selector: EmailUpdateSelector,
  options: JsonRequestOptions,
): Promise<ResolvedEmailSelector> {
  nonempty(selector.workspaceId, 'workspaceId');
  nonempty(selector.apiName, 'apiName');
  if ((selector.language === undefined) === (selector.useDefaultLanguage !== true)) {
    throw new TypeError('Specify language or useDefaultLanguage');
  }
  if (selector.language !== undefined) {
    return { ...selector, selectedLanguage: nonempty(selector.language, 'Email language') };
  }
  const workspace = await getWorkspace(connection, selector.workspaceId, options);
  const observedId = workspace.id ?? workspace.contentSpaceId ?? workspace.managedContentSpaceId;
  if (observedId !== selector.workspaceId) throw new TypeError('Workspace identity does not match');
  return {
    ...selector,
    selectedLanguage: nonempty(workspace.defaultLanguage, 'Workspace defaultLanguage'),
  };
}

function responseItems(data: unknown): unknown[] {
  if (!record(data) || !Array.isArray(data.items))
    throw new TypeError('Email search items are invalid');
  return data.items;
}

function responseCount(data: unknown): number {
  if (!record(data)) throw new TypeError('Email search count is invalid');
  for (const key of ['total', 'totalCount', 'count']) {
    const value = data[key];
    if (typeof value === 'number' && Number.isInteger(value) && value >= 0) return value;
  }
  throw new TypeError('Email search count is invalid');
}

function templatePageCount(data: unknown): number {
  if (!record(data)) throw new TypeError('Email Template search page count is invalid');
  const value = data.count;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0)
    throw new TypeError('Email Template search page count is invalid');
  return value;
}

async function emailInventory(
  connection: RequestConnection,
  selector: ResolvedEmailSelector,
  options: JsonRequestOptions,
): Promise<readonly CmsRecord[]> {
  const ids = new Set<string>();
  let expected: number | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const response = await requestJson<unknown>(
      connection,
      getSelectedOperation('workspace.variant.search'),
      {
        query: {
          contentSpaceOrFolderIds: [selector.workspaceId],
          contentTypeFQN: EMAIL_UPDATE_CONTENT_TYPE,
          languages: ['All'],
          page,
          pageSize: PAGE_SIZE,
          queryTerm: '*',
        },
      },
      options,
    );
    if (expected === undefined) expected = responseCount(response.data);
    const items = responseItems(response.data);
    for (const item of items) {
      if (!record(item) || item.type !== 'ManagedContentVariantSearchResultRepresentation')
        continue;
      if (item.managedContentSpaceId !== selector.workspaceId) {
        throw new TypeError('Email search returned an out-of-workspace result');
      }
      ids.add(nonempty(item.id, 'Email search variant id'));
    }
    if (ids.size >= expected) break;
    if (items.length === 0) break;
  }
  if (expected === undefined || ids.size !== expected) {
    throw new TypeError('Email search did not produce a complete stable inventory');
  }
  const details: CmsRecord[] = [];
  for (const id of [...ids].toSorted()) details.push(await getVariant(connection, id, options));
  return details;
}

function siblingInventory(
  details: readonly CmsRecord[],
  contentId: string,
  selector: ResolvedEmailSelector,
  selectedContentType: UpdateContentType,
): EmailUpdatePreviewEvidence['siblingInventory'] {
  return details
    .filter((detail) => requiredContentIdentifier(detail as Record<string, unknown>) === contentId)
    .map((detail) => {
      const language = nonempty(detail.language, 'Sibling language');
      const sibling = snapshot(
        detail,
        { ...selector, selectedLanguage: language },
        selectedContentType,
      );
      return {
        hash: sibling.hash,
        language,
        lifecycle: sibling.lifecycle,
        variantId: sibling.variantId,
      };
    })
    .toSorted((left, right) =>
      `${left.variantId}\u0000${left.language}`.localeCompare(
        `${right.variantId}\u0000${right.language}`,
      ),
    );
}

function searchContentType(value: Record<string, unknown>): unknown {
  return record(value.contentType) ? value.contentType.developerName : value.contentType;
}

async function templateSearchIds(
  connection: RequestConnection,
  selector: ResolvedEmailSelector,
  options: JsonRequestOptions,
  familyScoped: boolean,
): Promise<ReadonlySet<string>> {
  const ids = new Set<string>();
  const seen = new Set<string>();
  let complete = false;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const response = await requestJson<unknown>(
      connection,
      getSelectedOperation('workspace.variant.search'),
      {
        query: {
          contentSpaceOrFolderIds: [selector.workspaceId],
          ...(familyScoped ? { contentTypeFQN: EMAIL_TEMPLATE_UPDATE_CONTENT_TYPE } : {}),
          languages: ['All'],
          page,
          pageSize: PAGE_SIZE,
          queryTerm: '*',
        },
      },
      options,
    );
    const items = responseItems(response.data);
    if (templatePageCount(response.data) !== items.length)
      throw new TypeError('Email Template search page count does not match its items');
    for (const item of items) {
      if (!record(item) || item.type !== 'ManagedContentVariantSearchResultRepresentation')
        throw new TypeError('Email Template search returned an unsupported result');
      if (item.managedContentSpaceId !== selector.workspaceId)
        throw new TypeError('Email Template search returned an out-of-workspace result');
      const id = nonempty(item.id, 'Email Template search variant id');
      if (seen.has(id)) throw new TypeError('Email Template search returned a duplicate variant');
      seen.add(id);
      const foundContentType = searchContentType(item);
      if (typeof foundContentType !== 'string' || foundContentType.length === 0)
        throw new TypeError('Email Template search content type is invalid');
      if (familyScoped && foundContentType !== EMAIL_TEMPLATE_UPDATE_CONTENT_TYPE)
        throw new TypeError('Email Template family search returned a different content type');
      if (familyScoped || foundContentType === EMAIL_TEMPLATE_UPDATE_CONTENT_TYPE) ids.add(id);
    }
    if (items.length < PAGE_SIZE) {
      complete = true;
      break;
    }
  }
  if (!complete) throw new TypeError('Email Template search exceeded the bounded pagination limit');
  return ids;
}

async function templateInventory(
  connection: RequestConnection,
  selector: ResolvedEmailSelector,
  options: JsonRequestOptions,
): Promise<readonly CmsRecord[]> {
  const familyIds = await templateSearchIds(connection, selector, options, true);
  const workspaceIds = await templateSearchIds(connection, selector, options, false);
  if (familyIds.size !== workspaceIds.size || [...familyIds].some((id) => !workspaceIds.has(id)))
    throw new TypeError('Email Template family search disagrees with complete workspace inventory');
  return Promise.all([...familyIds].toSorted().map((id) => getVariant(connection, id, options)));
}

async function resolve(
  connection: RequestConnection,
  selector: ResolvedEmailSelector,
  selectedContentType: UpdateContentType,
  options: JsonRequestOptions,
): Promise<{ inventory: readonly CmsRecord[]; snapshot: EmailSnapshot }> {
  nonempty(selector.workspaceId, 'workspaceId');
  nonempty(selector.apiName, 'apiName');
  const inventory =
    selectedContentType === EMAIL_TEMPLATE_UPDATE_CONTENT_TYPE
      ? await templateInventory(connection, selector, options)
      : await emailInventory(connection, selector, options);
  const matches = inventory.filter(
    (detail) =>
      contentType(detail) === selectedContentType &&
      detail.apiName === selector.apiName &&
      detail.language === selector.selectedLanguage,
  );
  const label = familyLabel(selectedContentType);
  if (matches.length !== 1)
    throw new TypeError(`Exact ${label} selector must resolve exactly once`);
  return { inventory, snapshot: snapshot(matches[0], selector, selectedContentType) };
}

function parentIdentity(
  parent: CmsRecord,
  expectedContentId: string,
  selector: ResolvedEmailSelector,
  selectedContentType: UpdateContentType,
): void {
  const label = familyLabel(selectedContentType);
  const contentId = requiredContentIdentifier(parent as Record<string, unknown>, `${label} parent`);
  if (contentId !== expectedContentId)
    throw new TypeError(`${label} parent readback identity changed`);
  if (contentType(parent) !== selectedContentType || workspaceId(parent) !== selector.workspaceId) {
    throw new TypeError(`${label} parent readback scope changed`);
  }
}

function connectionIdentity(connection: RequestConnection): { apiVersion: string; org: string } {
  return {
    apiVersion: nonempty(connection.version, 'Connection API version'),
    org: nonempty(connection.instanceUrl, 'Connection instanceUrl'),
  };
}

async function prepareEmailUpdate(
  connection: RequestConnection,
  input: EmailUpdateInput,
): Promise<PreparedEmailUpdate> {
  const selectedContentType = input.contentType ?? EMAIL_UPDATE_CONTENT_TYPE;
  const label = familyLabel(selectedContentType);
  const options = input.requestOptions ?? {};
  const selector = await resolveSelector(connection, input.selector, options);
  const source = await loadWorkspaceExport(input.sourceDirectory);
  if (
    selectedContentType === EMAIL_TEMPLATE_UPDATE_CONTENT_TYPE &&
    (source.isPartial ||
      source.manifest.completeness !== 'complete' ||
      source.manifest.expectedCount !== source.manifest.exportedCount ||
      source.manifest.foundCount !== source.manifest.exportedCount ||
      source.manifest.entries.length !== source.manifest.exportedCount ||
      source.manifest.failedVariantIds.length > 0 ||
      source.manifest.rejectedVariantIds.length > 0 ||
      source.manifest.dependencies.length > 0 ||
      source.manifest.externalReferences.some(
        (reference) =>
          reference.resolution === 'unresolved' || reference.resolution === 'unsupported',
      ) ||
      source.manifest.warnings.some((warning) => warning.code !== 'UNSUPPORTED_WILDCARD') ||
      !source.integrity.verified ||
      source.integrity.unlistedFileCount !== 0 ||
      source.integrity.listedItemCount !== source.integrity.verifiedItemCount)
  )
    throw new TypeError('Email Template source package is not strict and complete');
  const initial = await resolve(connection, selector, selectedContentType, options);
  if (selectedContentType === EMAIL_TEMPLATE_UPDATE_CONTENT_TYPE) {
    const matchingSourceItems = source.items.filter(
      (item) => item.id === initial.snapshot.variantId,
    );
    if (matchingSourceItems.length !== 1)
      throw new TypeError(
        'Email Template source package must contain the selected variant exactly once',
      );
    const sourceSnapshot = snapshot(
      matchingSourceItems[0] as CmsRecord,
      selector,
      selectedContentType,
    );
    if (!isDeepStrictEqual(sourceSnapshot, initial.snapshot))
      throw new TypeError('Email Template source package baseline does not match the destination');
  }
  const editable = await loadEditableRawHtml(source, input.editableDirectory, [
    initial.snapshot.variantId,
  ]);
  const edited = editable.items[0];
  if (edited.contentType !== selectedContentType)
    throw new TypeError(`Editable source must be an ${label}`);
  const editedHtml = edited.contentBody.rawHtml;
  if (typeof editedHtml !== 'string') throw new TypeError(`Editable ${label} rawHtml is required`);
  const originalHtml = initial.snapshot.contentBody.rawHtml;
  if (typeof originalHtml !== 'string')
    throw new TypeError(`Destination ${label} rawHtml is required`);
  const editableEntry = editable.editableSource.entries.find(
    (entry) => entry.variantId === initial.snapshot.variantId,
  );
  if (editableEntry?.originalHtmlSha256 !== hashBytes(originalHtml)) {
    throw new TypeError(`Editable ${label} baseline does not match the destination`);
  }
  if (editedHtml === originalHtml) throw new TypeError(`${label} update must change rawHtml`);

  const initialParent = await getContent(connection, initial.snapshot.contentId, {}, options);
  parentIdentity(initialParent, initial.snapshot.contentId, selector, selectedContentType);
  const baselineSiblings = siblingInventory(
    initial.inventory,
    initial.snapshot.contentId,
    selector,
    selectedContentType,
  );
  const prewrite = await resolve(connection, selector, selectedContentType, options);
  const prewriteParent = await getContent(connection, prewrite.snapshot.contentId, {}, options);
  parentIdentity(prewriteParent, prewrite.snapshot.contentId, selector, selectedContentType);
  const prewriteSiblings = siblingInventory(
    prewrite.inventory,
    prewrite.snapshot.contentId,
    selector,
    selectedContentType,
  );
  if (
    prewrite.snapshot.variantId !== initial.snapshot.variantId ||
    prewrite.snapshot.contentId !== initial.snapshot.contentId ||
    prewrite.snapshot.hash !== initial.snapshot.hash ||
    !isDeepStrictEqual(prewriteSiblings, baselineSiblings)
  ) {
    throw new TypeError(`${label} destination drifted before update`);
  }

  const payload: UpdateVariantInput = {
    apiName: prewrite.snapshot.apiName,
    contentBody: { ...prewrite.snapshot.contentBody, rawHtml: editedHtml },
    title: prewrite.snapshot.title,
    ...(prewrite.snapshot.urlName === undefined ? {} : { urlName: prewrite.snapshot.urlName }),
  };
  const identity = connectionIdentity(connection);
  return {
    contentType: selectedContentType,
    evidence: {
      apiName: prewrite.snapshot.apiName,
      apiVersion: identity.apiVersion,
      baselineHash: prewrite.snapshot.hash,
      changedFields: ['contentBody.rawHtml'],
      contentId: prewrite.snapshot.contentId,
      contentType: selectedContentType,
      language: prewrite.snapshot.language,
      lifecycle: prewrite.snapshot.lifecycle,
      org: identity.org,
      payloadHash: hash(payload),
      siblingInventory: prewriteSiblings,
      variantId: prewrite.snapshot.variantId,
      workspaceId: prewrite.snapshot.workspaceId,
    },
    payload,
    selector,
    snapshot: prewrite.snapshot,
  };
}

function previewBlocker(error: unknown): EmailUpdatePreviewBlocker | undefined {
  if (!(error instanceof TypeError)) return undefined;
  return { code: 'EMAIL_UPDATE_PREFLIGHT_BLOCKED', message: error.message };
}

export async function previewDraftEmailUpdateFromEditableHtml(
  connection: RequestConnection,
  input: EmailUpdateInput,
): Promise<EmailUpdatePreviewResult> {
  try {
    const prepared = await prepareEmailUpdate(connection, input);
    return { blockers: [], evidence: prepared.evidence, status: 'ready' };
  } catch (error) {
    const blocker = previewBlocker(error);
    if (blocker === undefined) throw error;
    return { blockers: [blocker], status: 'blocked' };
  }
}

export async function updateDraftEmailFromEditableHtml(
  connection: RequestConnection,
  input: EmailUpdateInput,
): Promise<EmailUpdateEvidence> {
  const prepared = await prepareEmailUpdate(connection, input);
  return executePreparedEmailUpdate(connection, prepared, input.requestOptions ?? {});
}

async function executePreparedEmailUpdate(
  connection: RequestConnection,
  prepared: PreparedEmailUpdate,
  options: JsonRequestOptions,
): Promise<EmailUpdateEvidence> {
  try {
    await updateVariant(connection, prepared.snapshot.variantId, prepared.payload, options);
  } catch (error) {
    throw new EmailUpdateOutcomeUnknownError(
      prepared.snapshot.contentId,
      prepared.snapshot.variantId,
      prepared.evidence.payloadHash,
      error,
    );
  }

  try {
    const parent = await getContent(connection, prepared.snapshot.contentId, {}, options);
    parentIdentity(parent, prepared.snapshot.contentId, prepared.selector, prepared.contentType);
    const postVariant = snapshot(
      await getVariant(connection, prepared.snapshot.variantId, options),
      prepared.selector,
      prepared.contentType,
    );
    const postInventory =
      prepared.contentType === EMAIL_TEMPLATE_UPDATE_CONTENT_TYPE
        ? await templateInventory(connection, prepared.selector, options)
        : await emailInventory(connection, prepared.selector, options);
    const postSiblings = siblingInventory(
      postInventory,
      prepared.snapshot.contentId,
      prepared.selector,
      prepared.contentType,
    );
    const expectedBody = prepared.payload.contentBody;
    const expectedPostSiblings = prepared.evidence.siblingInventory.map((sibling) =>
      sibling.variantId === prepared.snapshot.variantId
        ? { ...sibling, hash: postVariant.hash }
        : sibling,
    );
    if (
      postVariant.contentId !== prepared.snapshot.contentId ||
      postVariant.variantId !== prepared.snapshot.variantId ||
      postVariant.language !== prepared.snapshot.language ||
      !isDeepStrictEqual(postVariant.lifecycle, prepared.snapshot.lifecycle) ||
      postVariant.apiName !== prepared.snapshot.apiName ||
      postVariant.title !== prepared.snapshot.title ||
      postVariant.urlName !== prepared.snapshot.urlName ||
      !isDeepStrictEqual(postVariant.contentBody, expectedBody) ||
      !isDeepStrictEqual(postSiblings, expectedPostSiblings)
    ) {
      throw new TypeError(
        `${familyLabel(prepared.contentType)} update readback did not preserve the bounded contract`,
      );
    }
    return {
      ...prepared.evidence,
      postUpdateHash: postVariant.hash,
      siblingInventory: postSiblings,
    };
  } catch (error) {
    throw new EmailUpdateOutcomeUnknownError(
      prepared.snapshot.contentId,
      prepared.snapshot.variantId,
      prepared.evidence.payloadHash,
      error,
    );
  }
}

export async function applyDraftEmailUpdateWithReport(
  connection: RequestConnection,
  input: EmailUpdateInput,
  reportDirectory: string,
  options: { rewriteReport?: typeof rewriteAtomic } = {},
): Promise<{ evidence: EmailUpdateEvidence; reportFile: string }> {
  const resolvedReportDirectory = path.resolve(reportDirectory);
  try {
    await stat(resolvedReportDirectory);
    throw new EmailUpdatePreflightBlockedError('Content update report directory already exists');
  } catch (error) {
    if (error instanceof EmailUpdatePreflightBlockedError) throw error;
    if (!record(error) || error.code !== 'ENOENT') {
      throw new EmailUpdatePreflightBlockedError(
        'Content update report directory cannot be safely claimed',
        error,
      );
    }
  }

  let prepared: PreparedEmailUpdate;
  try {
    prepared = await prepareEmailUpdate(connection, input);
  } catch (error) {
    const blocker = previewBlocker(error);
    if (blocker === undefined) throw error;
    throw new EmailUpdatePreflightBlockedError(blocker.message, error);
  }

  try {
    await mkdir(resolvedReportDirectory);
  } catch (error) {
    throw new EmailUpdatePreflightBlockedError(
      'Content update report directory cannot be safely claimed',
      error,
    );
  }
  const reportFile = path.join(resolvedReportDirectory, 'content-update-run.json');
  const reconciliation = {
    contentId: prepared.snapshot.contentId,
    payloadHash: prepared.evidence.payloadHash,
    variantId: prepared.snapshot.variantId,
    workspaceId: prepared.snapshot.workspaceId,
  };
  const pending: EmailUpdateRunReport = {
    contract:
      prepared.contentType === EMAIL_TEMPLATE_UPDATE_CONTENT_TYPE
        ? 'sf-cms-email-template-update-run'
        : 'sf-cms-email-update-run',
    contractVersion: '1.0.0',
    runId: randomUUID(),
    state: 'pending',
    target: {
      apiName: prepared.snapshot.apiName,
      contentId: prepared.snapshot.contentId,
      language: prepared.snapshot.language,
      variantId: prepared.snapshot.variantId,
      workspaceId: prepared.snapshot.workspaceId,
    },
    intent: {
      changedFields: ['contentBody.rawHtml'],
      payloadHash: prepared.evidence.payloadHash,
    },
    evidence: prepared.evidence,
    reconciliation,
  };
  const rewriteReport = options.rewriteReport ?? rewriteAtomic;
  try {
    await rewriteReport(reportFile, pending);
  } catch (error) {
    try {
      await rmdir(resolvedReportDirectory);
    } catch {
      // Best effort only; no report or ownership claim was made.
    }
    throw new EmailUpdatePreflightBlockedError(
      'Content update pending intent could not be durably written',
      error,
    );
  }
  try {
    const evidence = await executePreparedEmailUpdate(
      connection,
      prepared,
      input.requestOptions ?? {},
    );
    try {
      await rewriteReport(reportFile, { ...pending, evidence, state: 'completed' });
    } catch (error) {
      throw new EmailUpdateOutcomeUnknownError(
        prepared.snapshot.contentId,
        prepared.snapshot.variantId,
        prepared.evidence.payloadHash,
        error,
      );
    }
    return { evidence, reportFile };
  } catch (error) {
    if (error instanceof EmailUpdateOutcomeUnknownError) {
      try {
        await rewriteReport(reportFile, { ...pending, state: 'ownership-uncertain' });
      } catch {
        // The existing pending report remains the durable ownership-uncertain evidence.
      }
    }
    throw error;
  }
}
