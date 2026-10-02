import { createHash, randomUUID } from 'node:crypto';
import { mkdir, rmdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { Connection } from '@salesforce/core';
import { rewriteAtomic } from './import-workspace.js';
import { publishContent } from './lifecycle-foundation.js';
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
const MAX_READBACK_ATTEMPTS = 5;

type RequestConnection = Pick<Connection, 'request'> &
  Partial<Pick<Connection, 'accessToken' | 'instanceUrl' | 'version'>>;
export type EmailPublishSelector = {
  readonly apiName: string;
  readonly language?: string;
  readonly useDefaultLanguage?: true;
  readonly workspaceId: string;
};
export type EmailPublishInput = {
  readonly requestOptions?: JsonRequestOptions;
  readonly selector: EmailPublishSelector;
};
type ResolvedSelector = EmailPublishSelector & { readonly selectedLanguage: string };
type Lifecycle = { readonly isPublished: boolean; readonly status: string };
type Snapshot = {
  readonly apiName: string;
  readonly contentId: string;
  readonly hash: string;
  readonly language: string;
  readonly lifecycle: Lifecycle;
  readonly variantId: string;
  readonly workspaceId: string;
};
export type EmailPublishEvidence = {
  readonly apiName: string;
  readonly apiVersion: string;
  readonly baselineHash: string;
  readonly contentId: string;
  readonly contentType: typeof EMAIL_TYPE;
  readonly language: string;
  readonly lifecycle: Lifecycle;
  readonly org: string;
  readonly inventory: readonly InventoryEntry[];
  readonly siblingInventory: readonly {
    readonly hash: string;
    readonly language: string;
    readonly isPublished: boolean;
    readonly status: string;
    readonly variantId: string;
  }[];
  readonly variantId: string;
  readonly workspaceId: string;
};
export type EmailPublishPreviewResult =
  | {
      readonly blockers: readonly [];
      readonly evidence: EmailPublishEvidence;
      readonly status: 'ready';
    }
  | {
      readonly blockers: readonly [
        { readonly code: 'EMAIL_PUBLISH_PREFLIGHT_BLOCKED'; readonly message: string },
        ...Array<{ readonly code: 'EMAIL_PUBLISH_PREFLIGHT_BLOCKED'; readonly message: string }>,
      ];
      readonly status: 'blocked';
    };
export type EmailPublishCompletedEvidence = EmailPublishEvidence & {
  readonly deploymentId: string;
  readonly postPublishHash: string;
  readonly publishDate?: string;
};
type Prepared = {
  readonly evidence: EmailPublishEvidence;
  readonly inventoryBaseline: readonly InventoryEntry[];
  readonly selector: ResolvedSelector;
  readonly snapshot: Snapshot;
};
type InventoryEntry = {
  readonly contentId: string;
  readonly hash: string;
  readonly isPublished: boolean;
  readonly language: string;
  readonly status: string;
  readonly variantId: string;
};

export class EmailPublishOutcomeUnknownError extends Error {
  public constructor(
    public readonly contentId: string,
    public readonly variantId: string,
    public readonly deploymentId: string | undefined,
    cause: unknown,
  ) {
    super('Email publish outcome is unknown; perform fresh read-only reconciliation', { cause });
    this.name = 'EmailPublishOutcomeUnknownError';
  }
}
export class EmailPublishPreflightBlockedError extends Error {
  public constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = 'EmailPublishPreflightBlockedError';
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
function workspaceId(value: CmsRecord): string {
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
function lifecycle(value: CmsRecord): Lifecycle {
  if (typeof value.isPublished !== 'boolean' || !record(value.status))
    throw new TypeError('Email lifecycle is invalid');
  return { isPublished: value.isPublished, status: nonempty(value.status.status, 'Email status') };
}
function snapshot(detail: CmsRecord, selector: ResolvedSelector): Snapshot {
  const variantId = requiredVariantIdentifier(detail as Record<string, unknown>, 'Email variant');
  const contentId = requiredContentIdentifier(detail as Record<string, unknown>, 'Email parent');
  if (
    variantId === contentId ||
    contentType(detail) !== EMAIL_TYPE ||
    workspaceId(detail) !== selector.workspaceId
  )
    throw new TypeError('Email identity or scope is invalid');
  const apiName = nonempty(detail.apiName, 'Email apiName');
  const language = nonempty(detail.language, 'Email language');
  if (apiName !== selector.apiName || language !== selector.selectedLanguage)
    throw new TypeError('Email selector does not match');
  return {
    apiName,
    contentId,
    hash: hash({
      apiName,
      contentBody: detail.contentBody,
      title: detail.title,
      urlName: detail.urlName,
    }),
    language,
    lifecycle: lifecycle(detail),
    variantId,
    workspaceId: selector.workspaceId,
  };
}
async function resolveSelector(
  connection: RequestConnection,
  selector: EmailPublishSelector,
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
async function inventory(
  connection: RequestConnection,
  selector: ResolvedSelector,
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
    const observedCount = responseCount(response.data);
    if (expected === undefined) expected = observedCount;
    else if (observedCount !== expected)
      throw new TypeError('Email search inventory changed during pagination');
    const items = responseItems(response.data);
    for (const item of items) {
      if (!record(item) || item.type !== 'ManagedContentVariantSearchResultRepresentation')
        continue;
      if (item.managedContentSpaceId !== selector.workspaceId)
        throw new TypeError('Email search returned an out-of-workspace result');
      ids.add(nonempty(item.id, 'Email search variant id'));
    }
    if (ids.size >= expected || items.length === 0) break;
  }
  if (expected === undefined || ids.size !== expected)
    throw new TypeError('Email search did not produce a complete stable inventory');
  return Promise.all([...ids].toSorted().map((id) => getVariant(connection, id, options)));
}
function inventoryEvidence(
  details: readonly CmsRecord[],
  selector: ResolvedSelector,
): readonly InventoryEntry[] {
  return details
    .map((detail) => {
      if (contentType(detail) !== EMAIL_TYPE || workspaceId(detail) !== selector.workspaceId) {
        throw new TypeError('Email inventory scope changed');
      }
      const life = lifecycle(detail);
      return {
        contentId: requiredContentIdentifier(detail as Record<string, unknown>),
        hash: hash({
          apiName: detail.apiName,
          contentBody: detail.contentBody,
          title: detail.title,
          urlName: detail.urlName,
        }),
        isPublished: life.isPublished,
        language: nonempty(detail.language, 'Email inventory language'),
        status: life.status,
        variantId: requiredVariantIdentifier(detail as Record<string, unknown>),
      };
    })
    .toSorted((left, right) => left.variantId.localeCompare(right.variantId));
}
function siblings(
  details: readonly CmsRecord[],
  contentId: string,
): EmailPublishEvidence['siblingInventory'] {
  return details
    .filter((detail) => requiredContentIdentifier(detail as Record<string, unknown>) === contentId)
    .map((detail) => {
      const life = lifecycle(detail);
      return {
        hash: hash({
          apiName: detail.apiName,
          contentBody: detail.contentBody,
          title: detail.title,
          urlName: detail.urlName,
        }),
        language: nonempty(detail.language, 'Sibling language'),
        isPublished: life.isPublished,
        status: life.status,
        variantId: requiredVariantIdentifier(detail as Record<string, unknown>),
      };
    })
    .toSorted((a, b) =>
      `${a.variantId}\0${a.language}`.localeCompare(`${b.variantId}\0${b.language}`),
    );
}
async function resolve(
  connection: RequestConnection,
  selector: ResolvedSelector,
  options: JsonRequestOptions,
): Promise<{ inventory: readonly CmsRecord[]; snapshot: Snapshot }> {
  const items = await inventory(connection, selector, options);
  const matches = items.filter(
    (item) =>
      contentType(item) === EMAIL_TYPE &&
      item.apiName === selector.apiName &&
      item.language === selector.selectedLanguage,
  );
  if (matches.length !== 1) throw new TypeError('Exact Email selector must resolve exactly once');
  return { inventory: items, snapshot: snapshot(matches[0], selector) };
}
function parentIdentity(parent: CmsRecord, expectedId: string, selector: ResolvedSelector): void {
  if (
    requiredContentIdentifier(parent as Record<string, unknown>, 'Email parent') !== expectedId ||
    contentType(parent) !== EMAIL_TYPE ||
    workspaceId(parent) !== selector.workspaceId
  )
    throw new TypeError('Email parent readback scope changed');
}
async function prepare(connection: RequestConnection, input: EmailPublishInput): Promise<Prepared> {
  const options = input.requestOptions ?? {};
  const selector = await resolveSelector(connection, input.selector, options);
  const initial = await resolve(connection, selector, options);
  if (initial.snapshot.lifecycle.isPublished || initial.snapshot.lifecycle.status !== 'Draft')
    throw new TypeError('Email publish requires an unpublished Draft variant');
  parentIdentity(
    await getContent(connection, initial.snapshot.contentId, {}, options),
    initial.snapshot.contentId,
    selector,
  );
  const baselineInventory = inventoryEvidence(initial.inventory, selector);
  const baselineSiblings = siblings(initial.inventory, initial.snapshot.contentId);
  const prewrite = await resolve(connection, selector, options);
  parentIdentity(
    await getContent(connection, prewrite.snapshot.contentId, {}, options),
    prewrite.snapshot.contentId,
    selector,
  );
  if (
    prewrite.snapshot.hash !== initial.snapshot.hash ||
    prewrite.snapshot.variantId !== initial.snapshot.variantId ||
    !isDeepStrictEqual(inventoryEvidence(prewrite.inventory, selector), baselineInventory) ||
    !isDeepStrictEqual(siblings(prewrite.inventory, prewrite.snapshot.contentId), baselineSiblings)
  )
    throw new TypeError('Email destination drifted before publish');
  return {
    inventoryBaseline: baselineInventory,
    selector,
    snapshot: prewrite.snapshot,
    evidence: {
      apiName: prewrite.snapshot.apiName,
      apiVersion: nonempty(connection.version, 'Connection API version'),
      baselineHash: prewrite.snapshot.hash,
      contentId: prewrite.snapshot.contentId,
      contentType: EMAIL_TYPE,
      language: prewrite.snapshot.language,
      lifecycle: prewrite.snapshot.lifecycle,
      org: nonempty(connection.instanceUrl, 'Connection instanceUrl'),
      inventory: baselineInventory,
      siblingInventory: baselineSiblings,
      variantId: prewrite.snapshot.variantId,
      workspaceId: prewrite.snapshot.workspaceId,
    },
  };
}
function blocker(
  error: unknown,
): { code: 'EMAIL_PUBLISH_PREFLIGHT_BLOCKED'; message: string } | undefined {
  return error instanceof TypeError
    ? { code: 'EMAIL_PUBLISH_PREFLIGHT_BLOCKED', message: error.message }
    : undefined;
}
export async function previewDraftEmailPublish(
  connection: RequestConnection,
  input: EmailPublishInput,
): Promise<EmailPublishPreviewResult> {
  try {
    const prepared = await prepare(connection, input);
    return { blockers: [], evidence: prepared.evidence, status: 'ready' };
  } catch (error) {
    const found = blocker(error);
    if (!found) throw error;
    return { blockers: [found], status: 'blocked' };
  }
}
async function execute(
  connection: RequestConnection,
  prepared: Prepared,
  options: JsonRequestOptions,
): Promise<EmailPublishCompletedEvidence> {
  let deploymentId: string | undefined;
  let publishDate: string | undefined;
  try {
    const response = await publishContent(
      connection,
      {
        variantIds: [prepared.snapshot.variantId],
        contextContentSpaceId: prepared.snapshot.workspaceId,
      },
      options,
    );
    deploymentId = response.deploymentId;
    publishDate = response.publishDate ?? undefined;
  } catch (error) {
    throw new EmailPublishOutcomeUnknownError(
      prepared.snapshot.contentId,
      prepared.snapshot.variantId,
      undefined,
      error,
    );
  }
  try {
    const expectedInventory = prepared.inventoryBaseline.map((item) =>
      item.variantId === prepared.snapshot.variantId
        ? { ...item, isPublished: true, status: 'Published' }
        : item,
    );
    const expectedSiblings = prepared.evidence.siblingInventory.map((sibling) =>
      sibling.variantId === prepared.snapshot.variantId
        ? { ...sibling, isPublished: true, status: 'Published' }
        : sibling,
    );
    for (let attempt = 0; attempt < MAX_READBACK_ATTEMPTS; attempt += 1) {
      const post = await resolve(connection, prepared.selector, options);
      parentIdentity(
        await getContent(connection, prepared.snapshot.contentId, {}, options),
        prepared.snapshot.contentId,
        prepared.selector,
      );
      const postInventory = inventoryEvidence(post.inventory, prepared.selector);
      const postSiblings = siblings(post.inventory, prepared.snapshot.contentId);
      if (
        post.snapshot.hash === prepared.snapshot.hash &&
        post.snapshot.lifecycle.isPublished &&
        post.snapshot.lifecycle.status === 'Published' &&
        isDeepStrictEqual(postInventory, expectedInventory) &&
        isDeepStrictEqual(postSiblings, expectedSiblings)
      ) {
        return {
          ...prepared.evidence,
          deploymentId,
          inventory: postInventory,
          ...(publishDate === undefined ? {} : { publishDate }),
          postPublishHash: post.snapshot.hash,
          siblingInventory: postSiblings,
        };
      }
    }
    throw new TypeError('Email publish readback did not preserve the bounded contract');
  } catch (error) {
    throw new EmailPublishOutcomeUnknownError(
      prepared.snapshot.contentId,
      prepared.snapshot.variantId,
      deploymentId,
      error,
    );
  }
}
export async function applyDraftEmailPublishWithReport(
  connection: RequestConnection,
  input: EmailPublishInput,
  reportDirectory: string,
  options: { rewriteReport?: typeof rewriteAtomic } = {},
): Promise<{ evidence: EmailPublishCompletedEvidence; reportFile: string }> {
  const directory = path.resolve(reportDirectory);
  try {
    await stat(directory);
    throw new EmailPublishPreflightBlockedError('Content publish report directory already exists');
  } catch (error) {
    if (error instanceof EmailPublishPreflightBlockedError) throw error;
    if (!record(error) || error.code !== 'ENOENT')
      throw new EmailPublishPreflightBlockedError(
        'Content publish report directory cannot be safely claimed',
        error,
      );
  }
  let prepared: Prepared;
  try {
    prepared = await prepare(connection, input);
  } catch (error) {
    const found = blocker(error);
    if (!found) throw error;
    throw new EmailPublishPreflightBlockedError(found.message, error);
  }
  try {
    await mkdir(directory);
  } catch (error) {
    throw new EmailPublishPreflightBlockedError(
      'Content publish report directory cannot be safely claimed',
      error,
    );
  }
  const reportFile = path.join(directory, 'content-publish-run.json');
  const rewrite = options.rewriteReport ?? rewriteAtomic;
  const pending = {
    contract: 'sf-cms-email-publish-run',
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
    intent: { includeContentReferences: false, selectorScope: 'variant' },
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
    throw new EmailPublishPreflightBlockedError(
      'Content publish pending intent could not be durably written',
      error,
    );
  }
  try {
    const evidence = await execute(connection, prepared, input.requestOptions ?? {});
    try {
      await rewrite(reportFile, { ...pending, evidence, state: 'completed' });
    } catch (error) {
      throw new EmailPublishOutcomeUnknownError(
        prepared.snapshot.contentId,
        prepared.snapshot.variantId,
        evidence.deploymentId,
        error,
      );
    }
    return { evidence, reportFile };
  } catch (error) {
    if (error instanceof EmailPublishOutcomeUnknownError) {
      try {
        await rewrite(reportFile, {
          ...pending,
          reconciliation: {
            ...pending.reconciliation,
            ...(error.deploymentId === undefined ? {} : { deploymentId: error.deploymentId }),
          },
          state: 'ownership-uncertain',
        });
      } catch {
        /* Pending report remains durable evidence. */
      }
    }
    throw error;
  }
}
