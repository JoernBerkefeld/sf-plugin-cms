import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rmdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { Connection } from '@salesforce/core';
import { loadWorkspaceExport, rewriteAtomic } from './import-workspace.js';
import { assertNativeBody, decodeNativeHtml, safeNativeRawHtml } from './import-identities.js';
import { deleteVariantOneShot } from './lifecycle-foundation.js';
import { getContent, getVariant, getWorkspace, type CmsRecord } from './read.js';
import { requiredContentIdentifier, requiredVariantIdentifier } from './variant-identity.js';
import {
  CmsRequestError,
  getSelectedOperation,
  requestJson,
  type JsonRequestOptions,
} from '../transport/json-request.js';

export const EMAIL_CONTENT_TYPE = 'sfdc_cms__email' as const;
export const EMAIL_TEMPLATE_CONTENT_TYPE = 'sfdc_cms__emailTemplate' as const;
export type DeleteContentType = typeof EMAIL_CONTENT_TYPE | typeof EMAIL_TEMPLATE_CONTENT_TYPE;

type DeleteFamilyPolicy = {
  readonly blockerCode:
    'EMAIL_DELETE_PREFLIGHT_BLOCKED' | 'EMAIL_TEMPLATE_DELETE_PREFLIGHT_BLOCKED';
  readonly contentType: DeleteContentType;
  readonly label: 'Email' | 'Email Template';
  readonly ownership: 'email-v1' | 'template-create-v2';
};

const EMAIL_POLICY: DeleteFamilyPolicy = {
  blockerCode: 'EMAIL_DELETE_PREFLIGHT_BLOCKED',
  contentType: EMAIL_CONTENT_TYPE,
  label: 'Email',
  ownership: 'email-v1',
};
const EMAIL_TEMPLATE_POLICY: DeleteFamilyPolicy = {
  blockerCode: 'EMAIL_TEMPLATE_DELETE_PREFLIGHT_BLOCKED',
  contentType: EMAIL_TEMPLATE_CONTENT_TYPE,
  label: 'Email Template',
  ownership: 'template-create-v2',
};

export function deleteFamilyPolicy(contentType: DeleteContentType): DeleteFamilyPolicy {
  return contentType === EMAIL_CONTENT_TYPE ? EMAIL_POLICY : EMAIL_TEMPLATE_POLICY;
}

const PAGE_SIZE = 200;
const MAX_PAGES = 100;
const MAX_READBACK_ATTEMPTS = 5;

type RequestConnection = Pick<Connection, 'request'> &
  Partial<Pick<Connection, 'accessToken' | 'instanceUrl' | 'version'>>;
export type EmailDeleteSelector = {
  readonly apiName: string;
  readonly language?: string;
  readonly useDefaultLanguage?: true;
  readonly workspaceId: string;
};
export type EmailDeleteInput = {
  readonly contentType?: DeleteContentType;
  readonly orgId: string;
  readonly ownershipReport: string;
  readonly requestOptions?: JsonRequestOptions;
  readonly selector: EmailDeleteSelector;
};
type ResolvedSelector = EmailDeleteSelector & { readonly selectedLanguage: string };
type InventoryEntry = {
  readonly apiName: string;
  readonly contentId: string;
  readonly hash: string;
  readonly isPublished: boolean;
  readonly language: string;
  readonly status: string;
  readonly variantId: string;
};
type OwnershipEvidence = {
  readonly baselineHash: string;
  readonly reportFile: string;
  readonly requestSha256: string;
};
type Snapshot = {
  readonly apiName: string;
  readonly contentId: string;
  readonly hash: string;
  readonly language: string;
  readonly variantId: string;
  readonly workspaceId: string;
};
export type EmailDeleteEvidence = Snapshot & {
  readonly apiVersion: string;
  readonly contentType: DeleteContentType;
  readonly inventory: readonly InventoryEntry[];
  readonly org: string;
  readonly ownership: OwnershipEvidence;
  readonly siblingVariantCount: 1;
};
export type EmailDeletePreviewResult =
  | {
      readonly blockers: readonly [];
      readonly evidence: EmailDeleteEvidence;
      readonly status: 'ready';
    }
  | {
      readonly blockers: readonly [
        {
          readonly code:
            'EMAIL_DELETE_PREFLIGHT_BLOCKED' | 'EMAIL_TEMPLATE_DELETE_PREFLIGHT_BLOCKED';
          readonly message: string;
        },
        ...Array<{
          readonly code:
            'EMAIL_DELETE_PREFLIGHT_BLOCKED' | 'EMAIL_TEMPLATE_DELETE_PREFLIGHT_BLOCKED';
          readonly message: string;
        }>,
      ];
      readonly status: 'blocked';
    };
export type EmailDeleteCompletedEvidence = EmailDeleteEvidence & {
  readonly exactVariantAbsent: true;
  readonly parentBehavior: 'not-found' | 'present';
  readonly parentIdentityPreserved?: true;
  readonly postInventory: readonly InventoryEntry[];
  readonly selectedInventoryMatches: 0;
};
type Prepared = {
  readonly evidence: EmailDeleteEvidence;
  readonly policy: DeleteFamilyPolicy;
  readonly selector: ResolvedSelector;
  readonly snapshot: Snapshot;
};
export type EmailDeleteMutationErrorEvidence = {
  readonly classification: 'definite-pre-mutation-rejection' | 'ownership-uncertain';
  readonly errorCode?: string;
  readonly httpStatus?: number;
  readonly requestId?: string;
  readonly requestSelector?: string;
  readonly salesforceMessage?: string;
};

export class EmailDeleteOutcomeUnknownError extends Error {
  public constructor(
    public readonly workspaceId: string,
    public readonly apiName: string,
    public readonly language: string,
    public readonly contentId: string,
    public readonly variantId: string,
    public readonly reportFile: string,
    public readonly mutationError: EmailDeleteMutationErrorEvidence,
    cause: unknown,
  ) {
    super(
      'Email delete outcome is unknown; never retry and perform fresh read-only reconciliation',
      {
        cause,
      },
    );
    this.name = 'EmailDeleteOutcomeUnknownError';
  }
}

export class EmailDeletePreflightBlockedError extends Error {
  public constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = 'EmailDeletePreflightBlockedError';
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function nonempty(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${label} is required`);
  return value;
}
function contentType(value: CmsRecord): unknown {
  return record(value.contentType) ? value.contentType.fullyQualifiedName : value.contentType;
}
function contentWorkspaceId(value: CmsRecord): string {
  if (!record(value.contentSpace)) throw new TypeError('Email contentSpace is required');
  return nonempty(value.contentSpace.id, 'Email contentSpace.id');
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
  return createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex');
}
function bodyHash(value: CmsRecord, policy: DeleteFamilyPolicy): string {
  const contentBody = structuredClone(value.contentBody) as Record<string, unknown>;
  if (
    policy.contentType === EMAIL_TEMPLATE_CONTENT_TYPE &&
    record(contentBody) &&
    typeof contentBody.rawHtml === 'string'
  )
    contentBody.rawHtml = decodeNativeHtml(contentBody.rawHtml);
  return hash({
    apiName: value.apiName,
    contentBody,
    title: value.title,
    urlName: value.urlName,
  });
}
function lifecycle(value: CmsRecord): { isPublished: boolean; status: string } {
  if (typeof value.isPublished !== 'boolean' || !record(value.status))
    throw new TypeError('Email lifecycle is invalid');
  return { isPublished: value.isPublished, status: nonempty(value.status.status, 'Email status') };
}
function snapshot(
  detail: CmsRecord,
  selector: ResolvedSelector,
  policy: DeleteFamilyPolicy,
): Snapshot {
  const variantId = requiredVariantIdentifier(
    detail as Record<string, unknown>,
    `${policy.label} variant`,
  );
  const contentId = requiredContentIdentifier(
    detail as Record<string, unknown>,
    `${policy.label} parent`,
  );
  if (
    variantId === contentId ||
    contentType(detail) !== policy.contentType ||
    contentWorkspaceId(detail) !== selector.workspaceId
  )
    throw new TypeError(`${policy.label} identity or scope is invalid`);
  const apiName = nonempty(detail.apiName, `${policy.label} apiName`);
  const language = nonempty(detail.language, `${policy.label} language`);
  if (apiName !== selector.apiName || language !== selector.selectedLanguage)
    throw new TypeError(`${policy.label} selector does not match`);
  const life = lifecycle(detail);
  if (life.isPublished || life.status !== 'Draft')
    throw new TypeError(`${policy.label} delete requires exact isPublished=false,status=Draft`);
  return {
    apiName,
    contentId,
    hash: bodyHash(detail, policy),
    language,
    variantId,
    workspaceId: selector.workspaceId,
  };
}
async function resolveSelector(
  connection: RequestConnection,
  selector: EmailDeleteSelector,
  options: JsonRequestOptions,
): Promise<ResolvedSelector> {
  nonempty(selector.workspaceId, 'workspaceId');
  nonempty(selector.apiName, 'apiName');
  if ((selector.language === undefined) === (selector.useDefaultLanguage !== true))
    throw new TypeError('Specify language or useDefaultLanguage');
  if (selector.language !== undefined)
    return { ...selector, selectedLanguage: nonempty(selector.language, 'Email language') };
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
function searchContentType(value: Record<string, unknown>): unknown {
  return record(value.contentType) ? value.contentType.developerName : value.contentType;
}
async function searchInventory(
  connection: RequestConnection,
  selector: ResolvedSelector,
  policy: DeleteFamilyPolicy,
  options: JsonRequestOptions,
  includeFamilyFilter: boolean,
): Promise<{ readonly expected: number; readonly ids: ReadonlySet<string> }> {
  const ids = new Set<string>();
  const seenIds = new Set<string>();
  let observedItems = 0;
  let completed = false;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const response = await requestJson<unknown>(
      connection,
      getSelectedOperation('workspace.variant.search'),
      {
        query: {
          contentSpaceOrFolderIds: [selector.workspaceId],
          ...(includeFamilyFilter ? { contentTypeFQN: policy.contentType } : {}),
          languages: ['All'],
          page,
          pageSize: PAGE_SIZE,
          queryTerm: '*',
        },
      },
      options,
    );
    const items = responseItems(response.data);
    if (responseCount(response.data) !== items.length)
      throw new TypeError(`${policy.label} search page count does not match its items`);
    observedItems += items.length;
    for (const item of items) {
      if (!record(item) || item.type !== 'ManagedContentVariantSearchResultRepresentation')
        throw new TypeError(`${policy.label} search returned an unsupported result`);
      if (item.managedContentSpaceId !== selector.workspaceId)
        throw new TypeError(`${policy.label} search returned an out-of-workspace result`);
      const id = nonempty(item.id, `${policy.label} search variant id`);
      const itemContentType = searchContentType(item);
      if (typeof itemContentType !== 'string' || itemContentType.length === 0)
        throw new TypeError(`${policy.label} search content type is invalid`);
      if (seenIds.has(id))
        throw new TypeError(`${policy.label} search returned a duplicate variant`);
      seenIds.add(id);
      if (includeFamilyFilter && itemContentType !== policy.contentType)
        throw new TypeError(`${policy.label} family search returned a different content type`);
      if (includeFamilyFilter || itemContentType === policy.contentType) ids.add(id);
    }
    if (items.length < PAGE_SIZE) {
      completed = true;
      break;
    }
  }
  if (!completed)
    throw new TypeError(`${policy.label} search exceeded the bounded pagination limit`);
  return { expected: observedItems, ids };
}
async function inventory(
  connection: RequestConnection,
  selector: ResolvedSelector,
  policy: DeleteFamilyPolicy,
  options: JsonRequestOptions,
): Promise<readonly CmsRecord[]> {
  const familySearch = await searchInventory(connection, selector, policy, options, true);
  let ids = familySearch.ids;
  if (policy.contentType === EMAIL_TEMPLATE_CONTENT_TYPE) {
    const workspaceSearch = await searchInventory(connection, selector, policy, options, false);
    if (
      workspaceSearch.ids.size !== familySearch.ids.size ||
      [...workspaceSearch.ids].some((id) => !familySearch.ids.has(id))
    )
      throw new TypeError(
        'Email Template family search disagrees with complete workspace inventory',
      );
    ids = workspaceSearch.ids;
  }
  return Promise.all([...ids].toSorted().map((id) => getVariant(connection, id, options)));
}
function inventoryEvidence(
  details: readonly CmsRecord[],
  selector: ResolvedSelector,
  policy: DeleteFamilyPolicy,
): readonly InventoryEntry[] {
  return details
    .map((detail) => {
      if (
        contentType(detail) !== policy.contentType ||
        contentWorkspaceId(detail) !== selector.workspaceId
      )
        throw new TypeError(`${policy.label} inventory scope changed`);
      const life = lifecycle(detail);
      return {
        apiName: nonempty(detail.apiName, 'Email inventory apiName'),
        contentId: requiredContentIdentifier(detail as Record<string, unknown>),
        hash: bodyHash(detail, policy),
        isPublished: life.isPublished,
        language: nonempty(detail.language, 'Email inventory language'),
        status: life.status,
        variantId: requiredVariantIdentifier(detail as Record<string, unknown>),
      };
    })
    .toSorted((left, right) => left.variantId.localeCompare(right.variantId));
}
function parentIdentity(
  parent: CmsRecord,
  expectedId: string,
  selector: ResolvedSelector,
  policy: DeleteFamilyPolicy,
): void {
  if (
    requiredContentIdentifier(parent as Record<string, unknown>, `${policy.label} parent`) !==
      expectedId ||
    contentType(parent) !== policy.contentType ||
    contentWorkspaceId(parent) !== selector.workspaceId
  )
    throw new TypeError(`${policy.label} parent readback scope changed`);
}
function parseJson(value: string, label: string): unknown {
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new TypeError(`${label} is not valid JSON`, { cause: error });
  }
}
async function ownershipEvidence(
  input: EmailDeleteInput,
  selector: ResolvedSelector,
  selected: Snapshot,
  policy: DeleteFamilyPolicy,
): Promise<OwnershipEvidence> {
  const reportFile = path.resolve(input.ownershipReport);
  const report = parseJson(await readFile(reportFile, 'utf8'), 'Ownership report');
  if (!record(report)) throw new TypeError('Ownership report must be an object');
  if (report.contract === 'sf-cms-email-delete-ownership') {
    if (policy.ownership !== 'email-v1')
      throw new TypeError('Email Template delete rejects Email delete ownership reports');
    if (report.contractVersion !== '1.0.0' || report.state !== 'completed')
      throw new TypeError('Ownership report contract or state is invalid');
    const identity = report.identity;
    if (!record(identity)) throw new TypeError('Ownership report identity is invalid');
    const expected = {
      orgId: input.orgId,
      workspaceId: selector.workspaceId,
      family: policy.contentType,
      apiName: selector.apiName,
      language: selector.selectedLanguage,
      contentId: selected.contentId,
      variantId: selected.variantId,
    };
    for (const [key, value] of Object.entries(expected))
      if (identity[key] !== value) throw new TypeError(`Ownership report ${key} does not match`);
    const requestIdentity = nonempty(report.requestIdentity, 'Ownership requestIdentity');
    const requestSha256 = nonempty(report.requestSha256, 'Ownership requestSha256');
    if (hash(requestIdentity) !== requestSha256)
      throw new TypeError('Ownership request identity hash does not match');
    const baselineHash = nonempty(report.baselineHash, 'Ownership baselineHash');
    return { baselineHash, reportFile, requestSha256 };
  }
  if (
    report.state !== 'completed' ||
    report.destinationOrgId !== input.orgId ||
    report.destinationWorkspaceId !== selector.workspaceId
  )
    throw new TypeError('CREATE journal org, workspace, or state does not match');
  if (
    policy.ownership === 'template-create-v2' &&
    (typeof report.sourceDirectory !== 'string' || typeof report.sourceManifestSha256 !== 'string')
  )
    throw new TypeError('Email Template delete requires a strict completed CREATE journal');
  if (!Array.isArray(report.operations) || !Array.isArray(report.createdParents))
    throw new TypeError('CREATE journal operations or createdParents are invalid');
  const operations = report.operations.filter(
    (operation) =>
      record(operation) &&
      operation.state === 'succeeded' &&
      operation.operationKind === 'create-parent' &&
      operation.destinationOrgId === input.orgId &&
      operation.destinationWorkspaceId === selector.workspaceId &&
      operation.language === selector.selectedLanguage &&
      record(operation.result) &&
      operation.result.contentId === selected.contentId &&
      operation.result.primaryVariantId === selected.variantId,
  );
  const parents = report.createdParents.filter(
    (parent) =>
      record(parent) &&
      parent.contentId === selected.contentId &&
      parent.primaryVariantId === selected.variantId &&
      Array.isArray(parent.childVariantIds) &&
      parent.childVariantIds.length === 0,
  );
  if (operations.length !== 1 || parents.length !== 1)
    throw new TypeError('CREATE journal must prove exactly one matching parent operation');
  const operation = operations[0] as Record<string, unknown>;
  const requestIdentity = nonempty(operation.requestIdentity, 'CREATE requestIdentity');
  const requestSha256 = nonempty(operation.requestSha256, 'CREATE requestSha256');
  const observedRequestSha256 =
    policy.ownership === 'template-create-v2'
      ? createHash('sha256').update(requestIdentity).digest('hex')
      : hash(requestIdentity);
  if (observedRequestSha256 !== requestSha256)
    throw new TypeError('CREATE request identity hash does not match');
  const parts = requestIdentity.split('\0');
  if (
    parts.length !== 4 ||
    parts[0] !== 'create-parent' ||
    parts[1] !== operation.contentKey ||
    parts[2] !== selector.selectedLanguage
  )
    throw new TypeError('CREATE request identity shape does not match');
  const payload = parseJson(parts[3], 'CREATE request payload');
  if (!record(payload)) throw new TypeError('CREATE request payload is invalid');
  if (
    (payload.contentSpaceId ?? payload.contentSpaceOrFolderId) !== selector.workspaceId ||
    payload.apiName !== selector.apiName ||
    payload.contentType !== policy.contentType
  )
    throw new TypeError('CREATE request payload identity does not match');
  if (policy.ownership === 'template-create-v2') {
    const source = await loadWorkspaceExport(report.sourceDirectory as string, {
      allowPartial: true,
    });
    if (source.manifestSha256 !== report.sourceManifestSha256)
      throw new TypeError('Email Template source manifest changed since CREATE');
    if (
      source.isPartial ||
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
      source.integrity.listedItemCount !== source.integrity.verifiedItemCount
    )
      throw new TypeError('Email Template source package is not strict and complete');
    const sourceItem = source.items.filter(
      (item) =>
        item.contentType === policy.contentType &&
        item.language === selector.selectedLanguage &&
        operation.contentKey === item.contentKey,
    );
    if (sourceItem.length !== 1)
      throw new TypeError('Email Template CREATE source item must resolve exactly once');
    assertNativeBody(sourceItem[0]);
    const sourceRawHtml = sourceItem[0].contentBody.rawHtml;
    if (typeof sourceRawHtml !== 'string' || !safeNativeRawHtml(sourceRawHtml))
      throw new TypeError('Email Template source rawHtml is unsafe');
    const expectedBody = {
      ...sourceItem[0].contentBody,
      rawHtml: decodeNativeHtml(sourceRawHtml),
    };
    if (!isDeepStrictEqual(payload.contentBody, expectedBody))
      throw new TypeError('Email Template CREATE body differs from the safe source body');
  }
  const baselineHash = hash({
    apiName: payload.apiName,
    contentBody: payload.contentBody,
    title: payload.title,
    urlName: payload.urlName,
  });
  return { baselineHash, reportFile, requestSha256 };
}
async function prepare(connection: RequestConnection, input: EmailDeleteInput): Promise<Prepared> {
  nonempty(input.orgId, 'orgId');
  nonempty(input.ownershipReport, 'ownershipReport');
  const policy = deleteFamilyPolicy(input.contentType ?? EMAIL_CONTENT_TYPE);
  const options = input.requestOptions ?? {};
  const selector = await resolveSelector(connection, input.selector, options);
  const initialDetails = await inventory(connection, selector, policy, options);
  const initialInventory = inventoryEvidence(initialDetails, selector, policy);
  const matches = initialDetails.filter(
    (item) =>
      contentType(item) === policy.contentType &&
      item.apiName === selector.apiName &&
      item.language === selector.selectedLanguage,
  );
  if (matches.length !== 1)
    throw new TypeError(`Exact ${policy.label} selector must resolve exactly once`);
  const selected = snapshot(matches[0], selector, policy);
  const siblings = initialInventory.filter((item) => item.contentId === selected.contentId);
  if (siblings.length !== 1)
    throw new TypeError(`${policy.label} delete requires a single-variant parent`);
  parentIdentity(
    await getContent(connection, selected.contentId, {}, options),
    selected.contentId,
    selector,
    policy,
  );
  const ownership = await ownershipEvidence(input, selector, selected, policy);
  if (ownership.baselineHash !== selected.hash)
    throw new TypeError(`${policy.label} semantic body changed since the accepted CREATE baseline`);
  const freshDetails = await inventory(connection, selector, policy, options);
  const freshInventory = inventoryEvidence(freshDetails, selector, policy);
  const freshMatches = freshDetails.filter(
    (item) =>
      contentType(item) === policy.contentType &&
      item.apiName === selector.apiName &&
      item.language === selector.selectedLanguage,
  );
  if (freshMatches.length !== 1)
    throw new TypeError(`${policy.label} destination drifted before delete`);
  const fresh = snapshot(freshMatches[0], selector, policy);
  parentIdentity(
    await getContent(connection, fresh.contentId, {}, options),
    fresh.contentId,
    selector,
    policy,
  );
  if (
    fresh.variantId !== selected.variantId ||
    fresh.contentId !== selected.contentId ||
    fresh.hash !== selected.hash ||
    JSON.stringify(freshInventory) !== JSON.stringify(initialInventory)
  )
    throw new TypeError(`${policy.label} destination drifted before delete`);
  return {
    policy,
    selector,
    snapshot: fresh,
    evidence: {
      ...fresh,
      apiVersion: nonempty(connection.version, 'Connection API version'),
      contentType: policy.contentType,
      inventory: freshInventory,
      org: nonempty(connection.instanceUrl, 'Connection instanceUrl'),
      ownership,
      siblingVariantCount: 1,
    },
  };
}
function blocker(
  error: unknown,
  policy: DeleteFamilyPolicy,
):
  | {
      code: 'EMAIL_DELETE_PREFLIGHT_BLOCKED' | 'EMAIL_TEMPLATE_DELETE_PREFLIGHT_BLOCKED';
      message: string;
    }
  | undefined {
  if (error instanceof TypeError) return { code: policy.blockerCode, message: error.message };
  if (record(error) && error.code === 'ENOENT')
    return { code: policy.blockerCode, message: 'Ownership report does not exist' };
  return undefined;
}
export async function previewDraftEmailDelete(
  connection: RequestConnection,
  input: EmailDeleteInput,
): Promise<EmailDeletePreviewResult> {
  try {
    const prepared = await prepare(connection, input);
    return { blockers: [], evidence: prepared.evidence, status: 'ready' };
  } catch (error) {
    const found = blocker(error, deleteFamilyPolicy(input.contentType ?? EMAIL_CONTENT_TYPE));
    if (!found) throw error;
    return { blockers: [found], status: 'blocked' };
  }
}
function mutationErrorEvidence(error: unknown): EmailDeleteMutationErrorEvidence {
  const definite =
    error instanceof CmsRequestError &&
    error.operationKey === 'variant.delete' &&
    (error.status === 400 || error.status === 403 || error.status === 404);
  return {
    classification: definite ? 'definite-pre-mutation-rejection' : 'ownership-uncertain',
    ...(error instanceof CmsRequestError && error.errorCode !== undefined
      ? { errorCode: error.errorCode }
      : {}),
    ...(error instanceof CmsRequestError && error.status !== undefined
      ? { httpStatus: error.status }
      : {}),
    ...(error instanceof CmsRequestError && error.requestId !== undefined
      ? { requestId: error.requestId }
      : {}),
    ...(error instanceof CmsRequestError && error.requestSelector !== undefined
      ? { requestSelector: error.requestSelector }
      : {}),
    ...(error instanceof CmsRequestError && error.responseMessage !== undefined
      ? { salesforceMessage: error.responseMessage }
      : {}),
  };
}
function isProvenVariantAbsence(error: unknown): boolean {
  return (
    record(error) &&
    error.operationKey === 'variant.get' &&
    error.status === 404 &&
    error.statusObserved === true &&
    error.errorCode === 'VARIANT_NOT_FOUND' &&
    error.errorEntryCount === 1
  );
}
function isProvenParentAbsence(error: unknown): boolean {
  return (
    record(error) &&
    error.operationKey === 'content.get' &&
    error.status === 404 &&
    error.statusObserved === true &&
    error.errorCode === 'NOT_FOUND' &&
    error.errorEntryCount === 1
  );
}
async function reconcile(
  connection: RequestConnection,
  prepared: Prepared,
  options: JsonRequestOptions,
): Promise<EmailDeleteCompletedEvidence | undefined> {
  for (let attempt = 0; attempt < MAX_READBACK_ATTEMPTS; attempt += 1) {
    const postDetails = await inventory(connection, prepared.selector, prepared.policy, options);
    const postInventory = inventoryEvidence(postDetails, prepared.selector, prepared.policy);
    const selectedMatches = postInventory.filter(
      (item) =>
        item.apiName === prepared.snapshot.apiName && item.language === prepared.snapshot.language,
    );
    if (selectedMatches.length > 0) continue;
    let exactVariantAbsent = false;
    try {
      await getVariant(connection, prepared.snapshot.variantId, options);
    } catch (error) {
      if (!isProvenVariantAbsence(error)) throw error;
      exactVariantAbsent = true;
    }
    if (!exactVariantAbsent) continue;
    try {
      const parent = await getContent(connection, prepared.snapshot.contentId, {}, options);
      parentIdentity(parent, prepared.snapshot.contentId, prepared.selector, prepared.policy);
      return {
        ...prepared.evidence,
        exactVariantAbsent: true,
        parentBehavior: 'present',
        parentIdentityPreserved: true,
        postInventory,
        selectedInventoryMatches: 0,
      };
    } catch (error) {
      if (!isProvenParentAbsence(error)) throw error;
      return {
        ...prepared.evidence,
        exactVariantAbsent: true,
        parentBehavior: 'not-found',
        postInventory,
        selectedInventoryMatches: 0,
      };
    }
  }
  return undefined;
}
async function execute(
  connection: RequestConnection,
  prepared: Prepared,
  reportFile: string,
  options: JsonRequestOptions,
): Promise<EmailDeleteCompletedEvidence> {
  try {
    await deleteVariantOneShot(connection, prepared.snapshot.variantId, options);
  } catch (error) {
    throw new EmailDeleteOutcomeUnknownError(
      prepared.snapshot.workspaceId,
      prepared.snapshot.apiName,
      prepared.snapshot.language,
      prepared.snapshot.contentId,
      prepared.snapshot.variantId,
      reportFile,
      mutationErrorEvidence(error),
      error,
    );
  }
  try {
    const evidence = await reconcile(connection, prepared, options);
    if (evidence !== undefined) return evidence;
    throw new TypeError('Email delete readback did not prove bounded absence');
  } catch (error) {
    throw new EmailDeleteOutcomeUnknownError(
      prepared.snapshot.workspaceId,
      prepared.snapshot.apiName,
      prepared.snapshot.language,
      prepared.snapshot.contentId,
      prepared.snapshot.variantId,
      reportFile,
      mutationErrorEvidence(error),
      error,
    );
  }
}
export async function applyDraftEmailDeleteWithReport(
  connection: RequestConnection,
  input: EmailDeleteInput,
  reportDirectory: string,
  options: { rewriteReport?: typeof rewriteAtomic } = {},
): Promise<{ evidence: EmailDeleteCompletedEvidence; reportFile: string }> {
  const directory = path.resolve(reportDirectory);
  try {
    await stat(directory);
    throw new EmailDeletePreflightBlockedError('Content delete report directory already exists');
  } catch (error) {
    if (error instanceof EmailDeletePreflightBlockedError) throw error;
    if (!record(error) || error.code !== 'ENOENT')
      throw new EmailDeletePreflightBlockedError(
        'Content delete report directory cannot be safely claimed',
        error,
      );
  }
  let prepared: Prepared;
  try {
    prepared = await prepare(connection, input);
  } catch (error) {
    const found = blocker(error, deleteFamilyPolicy(input.contentType ?? EMAIL_CONTENT_TYPE));
    if (!found) throw error;
    throw new EmailDeletePreflightBlockedError(found.message, error);
  }
  try {
    await mkdir(directory);
  } catch (error) {
    throw new EmailDeletePreflightBlockedError(
      'Content delete report directory cannot be safely claimed',
      error,
    );
  }
  const reportFile = path.join(directory, 'content-delete-run.json');
  const rewrite = options.rewriteReport ?? rewriteAtomic;
  const pending = {
    contract: 'sf-cms-email-delete-run',
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
    intent: { cascade: false, selectorScope: 'variant' },
    evidence: prepared.evidence,
    reconciliation: {
      contentId: prepared.snapshot.contentId,
      variantId: prepared.snapshot.variantId,
      workspaceId: prepared.snapshot.workspaceId,
    },
  } as const;
  try {
    await rewrite(reportFile, pending);
  } catch (error) {
    try {
      await rmdir(directory);
    } catch {
      /* Best effort only. */
    }
    throw new EmailDeletePreflightBlockedError(
      'Content delete pending intent could not be durably written',
      error,
    );
  }
  try {
    const evidence = await execute(connection, prepared, reportFile, input.requestOptions ?? {});
    try {
      await rewrite(reportFile, { ...pending, evidence, state: 'completed' });
    } catch (error) {
      throw new EmailDeleteOutcomeUnknownError(
        prepared.snapshot.workspaceId,
        prepared.snapshot.apiName,
        prepared.snapshot.language,
        prepared.snapshot.contentId,
        prepared.snapshot.variantId,
        reportFile,
        { classification: 'ownership-uncertain' },
        error,
      );
    }
    return { evidence, reportFile };
  } catch (error) {
    if (error instanceof EmailDeleteOutcomeUnknownError) {
      try {
        await rewrite(reportFile, {
          ...pending,
          mutationError: error.mutationError,
          state:
            error.mutationError.classification === 'definite-pre-mutation-rejection'
              ? 'rejected-before-mutation'
              : 'ownership-uncertain',
        });
      } catch {
        /* Pending report remains durable evidence. */
      }
    }
    throw error;
  }
}
