import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  SOURCE_DEFINITION_CONTRACT,
  SOURCE_DEFINITION_VERSION,
  SOURCE_PROFILES,
  serializeSourceDefinition,
  sourcePathSegment,
  type SourceDefinition,
} from '../contracts/source-definition.js';
import type { JsonValue } from '../contracts/capability-registry.js';
import { assertNativeBody, decodeNativeHtml, safeNativeRawHtml } from './import-identities.js';
import type { WorkspaceImportItem } from './import-workspace.js';
import { normalizeBrand } from './brand.js';
import {
  requiredContentIdentifier,
  requiredVariantIdentifier,
  variantIdentity,
} from './variant-identity.js';

export type SourceDefinitionInputItem = {
  readonly workspaceApiName: string;
  readonly workspaceId: string;
  readonly apiName: string;
  readonly contentType: string;
  readonly folderPath: readonly string[];
  readonly variantId: string;
  readonly raw: Readonly<Record<string, unknown>>;
  readonly parent: Readonly<Record<string, unknown>>;
  readonly siblings: {
    readonly complete: true;
    readonly variants: readonly Readonly<Record<string, unknown>>[];
  };
};
export type SourceDefinitionProjection = {
  readonly items: readonly {
    readonly definition: SourceDefinition;
    readonly definitionPath: string;
    readonly htmlPath?: string;
    readonly definitionBytes: Buffer;
    readonly htmlBytes?: Buffer;
  }[];
  readonly evidence: readonly {
    readonly definitionPath: string;
    readonly variantId: string;
    readonly contentId: string;
    readonly originalHtmlSha256?: string;
  }[];
};

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function sameBrandFolder(left: unknown, right: unknown): boolean {
  if (isDeepStrictEqual(left, right)) return true;
  if (!record(left) || !record(right)) return false;
  if (
    Object.keys(left).length !== 2 ||
    Object.keys(right).length !== 2 ||
    !Object.keys(left).every((key) => key === 'id' || key === 'resourceUrl') ||
    !Object.keys(right).every((key) => key === 'id' || key === 'resourceUrl') ||
    typeof left.id !== 'string' ||
    !/^9Pu[A-Za-z0-9]{12}[A-Z0-5]{3}$/u.test(left.id) ||
    right.id !== left.id ||
    typeof left.resourceUrl !== 'string' ||
    typeof right.resourceUrl !== 'string'
  )
    return false;
  const pattern = /^(\/services\/data\/v\d+\.\d+\/connect\/cms\/folders\/)([A-Za-z0-9]+)$/u;
  const leftUrl = pattern.exec(left.resourceUrl);
  const rightUrl = pattern.exec(right.resourceUrl);
  return (
    leftUrl !== null &&
    rightUrl !== null &&
    leftUrl[1] === rightUrl[1] &&
    [left.id, left.id.slice(0, 15)].includes(leftUrl[2]) &&
    [left.id, left.id.slice(0, 15)].includes(rightUrl[2])
  );
}
function nativeType(raw: Readonly<Record<string, unknown>>): unknown {
  return record(raw.contentType) ? raw.contentType.fullyQualifiedName : raw.contentType;
}

/**
 * Validate original or edited literal HTML without GET decoding or the released opaque bypass.
 * @param {string} contentType - Exact native Email/Template FQN.
 * @param {Readonly<Record<string, unknown>>} contentBody - Unchanged native metadata body.
 * @param {string} literalHtml - Original decoded or edited literal companion text.
 */
export function assertSourceNativeHtml(
  contentType: string,
  contentBody: Readonly<Record<string, unknown>>,
  literalHtml: string,
): void {
  if (
    typeof literalHtml !== 'string' ||
    literalHtml.startsWith('\uFEFF') ||
    !safeNativeRawHtml(literalHtml)
  )
    throw new TypeError('Unsupported source native rawHtml or dependency/personalization');
  assertNativeBody({
    contentType,
    contentBody: { ...contentBody, rawHtml: literalHtml },
  } as unknown as WorkspaceImportItem);
}

/**
 * Project verified original variants; callers still own integrity, ancestry and inventory evidence acquisition.
 * @param {readonly SourceDefinitionInputItem[]} input - Original variants with complete exact context evidence.
 * @returns {SourceDefinitionProjection} Deterministic flat files and detached source evidence.
 */
export function projectSourceDefinitions(
  input: readonly SourceDefinitionInputItem[],
): SourceDefinitionProjection {
  if (!Array.isArray(input) || input.length === 0)
    throw new TypeError('Source selection must not be empty');
  const identities = new Set<string>();
  const aliases = new Set<string>();
  const result: Array<{
    item: SourceDefinitionProjection['items'][number];
    evidence: SourceDefinitionProjection['evidence'][number];
  }> = [];
  for (const selected of input) {
    sourcePathSegment(selected.workspaceApiName);
    sourcePathSegment(selected.apiName);
    if (!Array.isArray(selected.folderPath))
      throw new TypeError('Evidenced folderPath is required');
    const identity = `${selected.workspaceApiName}\0${selected.apiName}`;
    const alias = identity.toLowerCase();
    if (identities.has(identity) || aliases.has(alias))
      throw new TypeError('Duplicate workspace/API-name source identity or case alias');
    identities.add(identity);
    aliases.add(alias);
    const profile = SOURCE_PROFILES.find(
      (candidate) => candidate.contentType === selected.contentType,
    );
    if (!profile) throw new TypeError('Unsupported source family');
    const raw = selected.raw;
    const contentId = requiredContentIdentifier(raw);
    const variantId = requiredVariantIdentifier(raw);
    variantIdentity(raw, selected.variantId);
    if (
      variantId === contentId ||
      raw.apiName !== selected.apiName ||
      nativeType(raw) !== selected.contentType ||
      !record(raw.contentSpace) ||
      raw.contentSpace.id !== selected.workspaceId ||
      !selected.workspaceId
    )
      throw new TypeError('Source variant identity/scope disagreement');
    if (
      requiredContentIdentifier(selected.parent) !== contentId ||
      nativeType(selected.parent) !== selected.contentType ||
      !record(selected.parent.contentSpace) ||
      selected.parent.contentSpace.id !== selected.workspaceId
    )
      throw new TypeError('Source parent identity/scope disagreement');
    if (
      selected.siblings?.complete !== true ||
      selected.siblings.variants.length !== 1 ||
      !isDeepStrictEqual(selected.siblings.variants[0], raw)
    )
      throw new TypeError('Complete single exact native sibling evidence is required');
    // Unknown envelope semantics cannot silently disappear into a portable projection.
    const envelopeFields = new Set([
      'id',
      'managedContentVariantId',
      'contentId',
      'managedContentId',
      'contentKey',
      'apiName',
      'contentType',
      'contentSpace',
      'contentBody',
      'language',
      'title',
      'urlName',
      'externalId',
      'externalSource',
      'isPublished',
      'status',
      'folder',
    ]);
    const brand = profile.type === 'Brand';
    if (brand && (!normalizeBrand(raw) || !normalizeBrand(selected.parent)))
      throw new TypeError('Unsupported source Brand envelope/body');
    if (!brand && Object.keys(raw).some((key) => !envelopeFields.has(key)))
      throw new TypeError('Unsupported source variant envelope');
    const parentFields = new Set([
      'id',
      'managedContentId',
      'contentId',
      'contentKey',
      'apiName',
      'contentType',
      'contentSpace',
      'title',
      'urlName',
      'folder',
      'isPublished',
      'status',
    ]);
    if (!brand && Object.keys(selected.parent).some((key) => !parentFields.has(key)))
      throw new TypeError('Unsupported source parent envelope');
    if (!record(raw.contentBody)) throw new TypeError('Native inline body is required');
    let html: string | undefined;
    if (brand) {
      if (
        !isDeepStrictEqual(
          normalizeBrand(raw)?.semantic,
          normalizeBrand(selected.parent)?.semantic,
        ) ||
        raw.apiName !== selected.parent.apiName ||
        raw.language !== selected.parent.language ||
        raw.urlName !== selected.parent.urlName ||
        raw.externalId !== null ||
        selected.parent.externalId !== null ||
        !isDeepStrictEqual(
          normalizeBrand(raw)?.provenance,
          normalizeBrand(selected.parent)?.provenance,
        ) ||
        raw.contentKey !== selected.parent.contentKey ||
        !sameBrandFolder(raw.folder, selected.parent.folder)
      )
        throw new TypeError('Source Brand parent semantic/placement disagreement');
    } else {
      if (typeof raw.contentBody.rawHtml !== 'string')
        throw new TypeError('Native rawHtml body is required');
      assertNativeBody({ ...raw, contentType: selected.contentType } as WorkspaceImportItem);
      html = decodeNativeHtml(raw.contentBody.rawHtml);
      assertSourceNativeHtml(selected.contentType, raw.contentBody, html);
    }
    const body = structuredClone(raw.contentBody);
    if (!brand) delete body.rawHtml;
    const stem = `${selected.apiName}.cms-${profile.token}`;
    const directory = `cms/${selected.workspaceApiName}/${profile.directory}`;
    const definition: SourceDefinition = {
      contract: SOURCE_DEFINITION_CONTRACT,
      contractVersion: SOURCE_DEFINITION_VERSION,
      identity: {
        family: 'cms',
        type: profile.type,
        apiName: selected.apiName,
        context: { workspaceApiName: selected.workspaceApiName },
      },
      contentType: selected.contentType,
      contentBody: body as Record<string, JsonValue>,
      language: raw.language as string,
      ...(raw.title === undefined ? {} : { title: raw.title as string }),
      ...(raw.urlName === undefined ? {} : { urlName: raw.urlName as string }),
      folderPath: [...selected.folderPath],
      companions: brand ? {} : { rawHtml: `${stem}.html` },
    };
    const definitionPath = `${directory}/${stem}.json`;
    const htmlBytes = html === undefined ? undefined : Buffer.from(html, 'utf8');
    result.push({
      item: {
        definition,
        definitionPath,
        ...(htmlBytes === undefined ? {} : { htmlPath: `${directory}/${stem}.html`, htmlBytes }),
        definitionBytes: Buffer.from(serializeSourceDefinition(definition), 'utf8'),
      },
      evidence: {
        definitionPath,
        variantId,
        contentId,
        ...(htmlBytes === undefined
          ? {}
          : {
              originalHtmlSha256: createHash('sha256').update(htmlBytes).digest('hex'),
            }),
      },
    });
  }
  result.sort((left, right) => {
    if (left.item.definitionPath < right.item.definitionPath) return -1;
    return left.item.definitionPath > right.item.definitionPath ? 1 : 0;
  });
  return {
    items: result.map(({ item }) => item),
    evidence: result.map(({ evidence }) => evidence),
  };
}
