import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { Connection } from '@salesforce/core';
import { loadEditableRawHtml } from './editable-raw-html-import.js';
import { assertNativeBody, decodeNativeHtml } from './import-identities.js';
import { loadWorkspaceExport, type WorkspaceImportItem } from './import-workspace.js';
import { updateVariant, type UpdateVariantInput } from './lifecycle-foundation.js';
import { getContent, getVariant, getWorkspace, type CmsRecord } from './read.js';
import { requiredContentIdentifier, requiredVariantIdentifier } from './variant-identity.js';
import {
  getSelectedOperation,
  requestJson,
  type JsonRequestOptions,
} from '../transport/json-request.js';

const EMAIL_TYPE = 'sfdc_cms__email';
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
  readonly contentType: typeof EMAIL_TYPE;
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
      readonly blockers: readonly EmailUpdatePreviewBlocker[];
      readonly status: 'blocked';
    };

export type EmailUpdateEvidence = EmailUpdatePreviewEvidence & {
  readonly postUpdateHash: string;
};

type PreparedEmailUpdate = {
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

function snapshot(detail: CmsRecord, selector: ResolvedEmailSelector): EmailSnapshot {
  const variantId = requiredVariantIdentifier(detail as Record<string, unknown>, 'Email variant');
  const contentId = requiredContentIdentifier(detail as Record<string, unknown>, 'Email parent');
  if (variantId === contentId)
    throw new TypeError('Email parent and variant identities must differ');
  if (contentType(detail) !== EMAIL_TYPE) throw new TypeError('Destination must be an Email');
  if (workspaceId(detail) !== selector.workspaceId)
    throw new TypeError('Email belongs to another workspace');
  const apiName = nonempty(detail.apiName, 'Email apiName');
  if (apiName !== selector.apiName) throw new TypeError('Email apiName does not match selector');
  const language = nonempty(detail.language, 'Email language');
  if (language !== selector.selectedLanguage)
    throw new TypeError('Email language does not match selector');
  if (detail.isPublished !== false || !record(detail.status) || detail.status.status !== 'Draft') {
    throw new TypeError('Email update requires an unpublished Draft variant');
  }
  const title = nonempty(detail.title, 'Email title');
  const urlName = detail.urlName;
  if (urlName !== undefined && typeof urlName !== 'string')
    throw new TypeError('Email urlName is invalid');
  const contentBody = normalizedBody(detail.contentBody);
  assertNativeBody({
    ...(detail as Record<string, unknown>),
    id: variantId,
    contentType: EMAIL_TYPE,
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
          contentTypeFQN: EMAIL_TYPE,
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
): EmailUpdatePreviewEvidence['siblingInventory'] {
  return details
    .filter((detail) => requiredContentIdentifier(detail as Record<string, unknown>) === contentId)
    .map((detail) => {
      const language = nonempty(detail.language, 'Sibling language');
      const sibling = snapshot(detail, { ...selector, selectedLanguage: language });
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

async function resolve(
  connection: RequestConnection,
  selector: ResolvedEmailSelector,
  options: JsonRequestOptions,
): Promise<{ inventory: readonly CmsRecord[]; snapshot: EmailSnapshot }> {
  nonempty(selector.workspaceId, 'workspaceId');
  nonempty(selector.apiName, 'apiName');
  const inventory = await emailInventory(connection, selector, options);
  const matches = inventory.filter(
    (detail) =>
      contentType(detail) === EMAIL_TYPE &&
      detail.apiName === selector.apiName &&
      detail.language === selector.selectedLanguage,
  );
  if (matches.length !== 1) throw new TypeError('Exact Email selector must resolve exactly once');
  return { inventory, snapshot: snapshot(matches[0], selector) };
}

function parentIdentity(
  parent: CmsRecord,
  expectedContentId: string,
  selector: ResolvedEmailSelector,
): void {
  const contentId = requiredContentIdentifier(parent as Record<string, unknown>, 'Email parent');
  if (contentId !== expectedContentId)
    throw new TypeError('Email parent readback identity changed');
  if (contentType(parent) !== EMAIL_TYPE || workspaceId(parent) !== selector.workspaceId) {
    throw new TypeError('Email parent readback scope changed');
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
  const options = input.requestOptions ?? {};
  const selector = await resolveSelector(connection, input.selector, options);
  const source = await loadWorkspaceExport(input.sourceDirectory, { allowPartial: true });
  const initial = await resolve(connection, selector, options);
  const editable = await loadEditableRawHtml(source, input.editableDirectory, [
    initial.snapshot.variantId,
  ]);
  const edited = editable.items[0];
  if (edited.contentType !== EMAIL_TYPE) throw new TypeError('Editable source must be an Email');
  const editedHtml = edited.contentBody.rawHtml;
  if (typeof editedHtml !== 'string') throw new TypeError('Editable Email rawHtml is required');
  const originalHtml = initial.snapshot.contentBody.rawHtml;
  if (typeof originalHtml !== 'string')
    throw new TypeError('Destination Email rawHtml is required');
  const editableEntry = editable.editableSource.entries.find(
    (entry) => entry.variantId === initial.snapshot.variantId,
  );
  if (editableEntry?.originalHtmlSha256 !== hashBytes(originalHtml)) {
    throw new TypeError('Editable Email baseline does not match the destination');
  }
  if (editedHtml === originalHtml) throw new TypeError('Email update must change rawHtml');

  const initialParent = await getContent(connection, initial.snapshot.contentId, {}, options);
  parentIdentity(initialParent, initial.snapshot.contentId, selector);
  const baselineSiblings = siblingInventory(
    initial.inventory,
    initial.snapshot.contentId,
    selector,
  );
  const prewrite = await resolve(connection, selector, options);
  const prewriteParent = await getContent(connection, prewrite.snapshot.contentId, {}, options);
  parentIdentity(prewriteParent, prewrite.snapshot.contentId, selector);
  const prewriteSiblings = siblingInventory(
    prewrite.inventory,
    prewrite.snapshot.contentId,
    selector,
  );
  if (
    prewrite.snapshot.variantId !== initial.snapshot.variantId ||
    prewrite.snapshot.contentId !== initial.snapshot.contentId ||
    prewrite.snapshot.hash !== initial.snapshot.hash ||
    !isDeepStrictEqual(prewriteSiblings, baselineSiblings)
  ) {
    throw new TypeError('Email destination drifted before update');
  }

  const payload: UpdateVariantInput = {
    apiName: prewrite.snapshot.apiName,
    contentBody: { ...prewrite.snapshot.contentBody, rawHtml: editedHtml },
    title: prewrite.snapshot.title,
    ...(prewrite.snapshot.urlName === undefined ? {} : { urlName: prewrite.snapshot.urlName }),
  };
  const identity = connectionIdentity(connection);
  return {
    evidence: {
      apiName: prewrite.snapshot.apiName,
      apiVersion: identity.apiVersion,
      baselineHash: prewrite.snapshot.hash,
      changedFields: ['contentBody.rawHtml'],
      contentId: prewrite.snapshot.contentId,
      contentType: EMAIL_TYPE,
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
  const options = input.requestOptions ?? {};
  const prepared = await prepareEmailUpdate(connection, input);
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
    parentIdentity(parent, prepared.snapshot.contentId, prepared.selector);
    const postVariant = snapshot(
      await getVariant(connection, prepared.snapshot.variantId, options),
      prepared.selector,
    );
    const postInventory = await emailInventory(connection, prepared.selector, options);
    const postSiblings = siblingInventory(
      postInventory,
      prepared.snapshot.contentId,
      prepared.selector,
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
      throw new TypeError('Email update readback did not preserve the bounded contract');
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
