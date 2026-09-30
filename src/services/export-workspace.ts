import type { Connection } from '@salesforce/core';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, open, readdir, readFile, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import {
  assertWorkspaceExportManifest,
  WORKSPACE_EXPORT_MANIFEST_CONTRACT,
  type WorkspaceExportManifest,
} from '../contracts/workspace-export.js';
export type { WorkspaceExportManifest } from '../contracts/workspace-export.js';
import {
  getSelectedOperation,
  requestJson,
  type JsonRequestOptions,
} from '../transport/json-request.js';
import { getPluginVersion } from '../runtime-version.js';
import {
  cleanupOwnedPath,
  publishDirectoryNoClobber,
  type CleanupOptions,
  type DirectoryPublishOptions,
} from './atomic-publish.js';
import { inventoryExportReferences } from './export-references.js';
import {
  preflightEditableExport,
  writeEditableRawHtml,
  type EditablePublishOptions,
} from './editable-raw-html-export.js';
import { getVariant, type CmsRecord } from './read.js';
import {
  downloadExperimentalCmsMedia,
  EXPERIMENTAL_MEDIA_POLICY,
  type ExperimentalMediaDownloadOptions,
} from '../transport/experimental-media.js';
import {
  bindLandingPageTemplatePairs,
  LANDING_PAGE_TEMPLATE_TYPE,
  LANDING_PAGE_TYPE,
  type LandingPagePairSelector,
} from './landing-page-pair-export.js';

const PAGE_SIZE = 250;
const ABSOLUTE_PAGE_CAP = 1000;
const INVENTORY_EXACT_API_NAME_TYPES = new Set([
  'sfdc_cms__emailFragment',
  'sfdc_cms__webFragment',
]);

function mediaByteCap(value: number | undefined, maximum: number, label: string): number {
  const configured = value ?? maximum;
  if (!Number.isSafeInteger(configured) || configured <= 0) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
  return Math.min(configured, maximum);
}

export type WorkspaceExportWarning = {
  code:
    | 'COUNT_MISMATCH'
    | 'DETAIL_FAILED'
    | 'DUPLICATE_VARIANTS'
    | 'OWNERSHIP_MISMATCH'
    | 'PREMATURE_EMPTY_PAGE'
    | 'MEDIA_EXPORT_FAILED'
    | 'REFERENCE_UNRESOLVED'
    | 'REFERENCE_UNSUPPORTED'
    | 'UNSUPPORTED_WILDCARD';
  message: string;
  variantIds?: string[];
};

export type WorkspaceExportEntry = {
  file: string;
  variantId: string;
};

export type ExportWorkspaceResult = {
  destination: string;
  manifest: WorkspaceExportManifest;
  manifestSha256: string;
};

export type ExportWorkspaceOptions = JsonRequestOptions & {
  sourceOrgId?: string;
  pluginVersion?: string;
  generatedAt?: string;
  editableDirectory?: string;
  editablePublish?: EditablePublishOptions;
  selection?: {
    readonly contentType: string;
    readonly apiNames: readonly string[];
  };
  landingPagePairs?: readonly LandingPagePairSelector[];
  atomicPublish?: DirectoryPublishOptions &
    CleanupOptions & {
      readonly makeTemporaryDirectory?: typeof mkdtemp;
    };
  experimentalMedia?: {
    readonly accessToken: string;
    readonly instanceUrl: string;
    readonly fetch?: ExperimentalMediaDownloadOptions['fetch'];
    readonly perImageBytes?: number;
    readonly totalBytes?: number;
  };
};

type RequestConnection = Pick<Connection, 'request'>;
type SearchRow = { id: string; managedContentSpaceId: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonemptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function responseItems(value: unknown): unknown[] {
  if (!isRecord(value) || !Array.isArray(value.items)) {
    throw new TypeError('Workspace variant search response must contain an items array.');
  }
  return value.items;
}

function responseCount(value: unknown): number {
  if (isRecord(value)) {
    for (const key of ['total', 'totalCount', 'count']) {
      const count = value[key];
      if (typeof count === 'number' && Number.isInteger(count) && count >= 0) return count;
    }
  }
  throw new TypeError(
    'Workspace variant search response must contain a nonnegative integer count.',
  );
}

function searchRow(value: unknown): SearchRow | undefined {
  if (!isRecord(value)) return undefined;
  return value.type === 'ManagedContentVariantSearchResultRepresentation' &&
    nonemptyString(value.id) &&
    nonemptyString(value.managedContentSpaceId)
    ? { id: value.id, managedContentSpaceId: value.managedContentSpaceId }
    : undefined;
}

function detailWorkspaceId(detail: CmsRecord): string | undefined {
  const contentSpace = detail.contentSpace;
  return isRecord(contentSpace) && nonemptyString(contentSpace.id) ? contentSpace.id : undefined;
}

function jsonBytes(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function sha256(bytes: string | Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu;

export function safeWorkspaceDirectoryName(workspaceName: string): string {
  const replaced = [...workspaceName]
    .map((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 31 || codePoint === 127 || /[\\/<>:"|?*]/u.test(character)
        ? '_'
        : character;
    })
    .join('');
  const safeName = replaced.replaceAll(/[. ]+$/gu, '');
  if (
    safeName.length === 0 ||
    safeName === '.' ||
    safeName === '..' ||
    WINDOWS_RESERVED_NAME.test(safeName)
  ) {
    throw new Error(
      `Workspace name ${workspaceName} cannot be used as a portable directory name. Pass --output-dir explicitly.`,
    );
  }
  return safeName;
}

export function defaultWorkspaceDestination(workspaceName: string): string {
  return path.join('.', 'cms', safeWorkspaceDirectoryName(workspaceName));
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isRecord(error) && error.code === 'ENOENT') return false;
    throw error;
  }
}

function mediaValue(record: CmsRecord): Record<string, unknown> | undefined {
  const body = record.contentBody;
  if (!isRecord(body)) return undefined;
  const media = body['sfdc_cms:media'];
  return isRecord(media) ? media : undefined;
}

function imageEvidence(record: CmsRecord):
  | {
      contentKey: string;
      fileName: string;
      md5: string;
      mimeType: string;
      modifiedAt: string;
      size: number;
      status: string;
      url: string;
      version: string;
    }
  | undefined {
  const contentType = isRecord(record.contentType)
    ? record.contentType.fullyQualifiedName
    : record.contentType;
  if (contentType !== 'sfdc_cms__image') return undefined;
  const media = mediaValue(record);
  const source = isRecord(media?.source) ? media.source : undefined;
  const status = isRecord(record.status) ? record.status.status : undefined;
  const url = media?.url;
  if (
    !nonemptyString(record.contentKey) ||
    !nonemptyString(source?.mimeType) ||
    typeof source.size !== 'number' ||
    !Number.isSafeInteger(source.size) ||
    source.size < 0 ||
    !nonemptyString(status) ||
    !nonemptyString(record.lastModifiedDate) ||
    !nonemptyString(url)
  ) {
    throw new TypeError('Experimental image authoring metadata is incomplete');
  }
  const parsed = new URL(url, 'https://invalid.example');
  const fileName = parsed.searchParams.get('fileName');
  const md5 = parsed.searchParams.get('fileHash');
  const version = parsed.searchParams.get('version');
  if (
    !/^\/cms\/media\/[^/]+$/u.test(parsed.pathname) ||
    [...parsed.searchParams.keys()].toSorted().join(',') !== 'fileHash,fileName,version' ||
    !nonemptyString(fileName) ||
    fileName.includes('/') ||
    fileName.includes('\\') ||
    typeof md5 !== 'string' ||
    !/^[a-f\d]{32}$/iu.test(md5) ||
    !nonemptyString(version)
  ) {
    throw new TypeError('Experimental image authoring URL binding is unsupported');
  }
  return {
    contentKey: record.contentKey,
    fileName,
    md5: md5.toLowerCase(),
    mimeType: source.mimeType,
    modifiedAt: record.lastModifiedDate,
    size: source.size,
    status,
    url,
    version,
  };
}

async function writeExclusive(path: string, value: unknown): Promise<void> {
  const handle = await open(path, 'wx');
  try {
    await handle.writeFile(jsonBytes(value), 'utf8');
  } finally {
    await handle.close();
  }
}

async function assertRegularPackageFiles(
  root: string,
  expectedPaths: ReadonlySet<string>,
): Promise<void> {
  const found = new Set<string>();
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute).split(path.sep).join('/');
      const information = await lstat(absolute);
      if (information.isSymbolicLink()) throw new Error(`Package entry is a symlink: ${relative}`);
      if (information.isDirectory()) {
        await visit(absolute);
      } else if (information.isFile()) {
        if (relative !== 'manifest.json') found.add(relative);
      } else {
        throw new Error(`Package entry is not a regular file or directory: ${relative}`);
      }
    }
  };
  await visit(root);
  if (
    found.size !== expectedPaths.size ||
    [...found].some((itemPath) => !expectedPaths.has(itemPath))
  ) {
    throw new Error('Package regular files do not exactly match manifest items.');
  }
}

export async function exportWorkspace(
  connection: RequestConnection,
  workspaceId: string,
  destination: string,
  options: ExportWorkspaceOptions = {},
): Promise<ExportWorkspaceResult> {
  if (!nonemptyString(workspaceId)) throw new TypeError('workspaceId must be a nonempty string');
  if (!nonemptyString(destination)) throw new TypeError('destination must be a nonempty string');
  const mediaCaps =
    options.experimentalMedia === undefined
      ? undefined
      : {
          perImageBytes: mediaByteCap(
            options.experimentalMedia.perImageBytes,
            EXPERIMENTAL_MEDIA_POLICY.perImageBytes,
            'Experimental media per-image byte cap',
          ),
          totalBytes: mediaByteCap(
            options.experimentalMedia.totalBytes,
            EXPERIMENTAL_MEDIA_POLICY.totalBytes,
            'Experimental media total byte cap',
          ),
        };
  if (options.editableDirectory !== undefined) {
    await preflightEditableExport(destination, options.editableDirectory);
  }
  if (await exists(destination))
    throw new Error(`Export destination already exists: ${destination}`);
  const selection = options.selection;
  if (selection !== undefined && options.landingPagePairs !== undefined) {
    throw new TypeError('Component export selection modes are mutually exclusive');
  }
  if (options.landingPagePairs !== undefined && options.landingPagePairs.length === 0) {
    throw new TypeError('Landing-page pair selection requires one or more pairs');
  }
  if (selection !== undefined) {
    if (!nonemptyString(selection.contentType) || !Array.isArray(selection.apiNames)) {
      throw new TypeError('Component export selection is malformed');
    }
    if (
      selection.apiNames.length === 0 ||
      selection.apiNames.some((value) => !nonemptyString(value))
    ) {
      throw new TypeError('Component export selection requires one or more exact API names');
    }
    if (new Set(selection.apiNames).size !== selection.apiNames.length) {
      throw new TypeError('Component export API names must be unique');
    }
  }

  const warnings: WorkspaceExportWarning[] = [
    {
      code: 'UNSUPPORTED_WILDCARD',
      message: 'Wildcard search is unsupported and this export is experimental best-effort.',
    },
  ];
  const rejected = new Set<string>();
  const ownershipMismatchIds = new Set<string>();
  const duplicateIds = new Set<string>();
  const candidates = new Map<string, SearchRow>();
  let expectedCount = 0;
  let pagesRequested = 0;
  const pairSelection = options.landingPagePairs;
  const inventoryExactApiNames =
    selection !== undefined && INVENTORY_EXACT_API_NAME_TYPES.has(selection.contentType);
  let inventoryExceedsPageCapacity = false;
  const searchTypes =
    pairSelection === undefined
      ? [selection?.contentType]
      : [LANDING_PAGE_TYPE, LANDING_PAGE_TEMPLATE_TYPE];

  for (const searchType of searchTypes) {
    let searchExpectedCount = 0;
    let page = 0;
    let pageLimit = 1;
    let searchCandidateCount = 0;
    while (page < pageLimit) {
      const response = await requestJson<unknown>(
        connection,
        getSelectedOperation('workspace.variant.search'),
        {
          query: {
            contentSpaceOrFolderIds: [workspaceId],
            ...(searchType === undefined ? {} : { contentTypeFQN: searchType }),
            languages: ['All'],
            page,
            pageSize: PAGE_SIZE,
            queryTerm:
              pairSelection !== undefined || selection === undefined || inventoryExactApiNames
                ? '*'
                : selection.apiNames.join(' '),
          },
        },
        options,
      );
      pagesRequested += 1;
      const items = responseItems(response.data);
      if (page === 0) {
        searchExpectedCount = responseCount(response.data);
        expectedCount += searchExpectedCount;
        inventoryExceedsPageCapacity ||= searchExpectedCount > ABSOLUTE_PAGE_CAP * PAGE_SIZE;
        pageLimit = Math.min(
          ABSOLUTE_PAGE_CAP,
          Math.max(1, Math.ceil(searchExpectedCount / PAGE_SIZE) + 2),
        );
      }

      let additions = 0;
      for (const item of items) {
        const row = searchRow(item);
        if (!row) continue;
        if (row.managedContentSpaceId !== workspaceId) {
          rejected.add(row.id);
          ownershipMismatchIds.add(row.id);
          continue;
        }
        if (candidates.has(row.id)) {
          duplicateIds.add(row.id);
        } else {
          candidates.set(row.id, row);
          searchCandidateCount += 1;
          additions += 1;
        }
      }

      if (searchCandidateCount >= searchExpectedCount) break;
      if (items.length === 0) {
        if (searchCandidateCount < searchExpectedCount) {
          warnings.push({
            code: 'PREMATURE_EMPTY_PAGE',
            message: `Search returned an empty page before the advertised count was satisfied.`,
          });
        }
        break;
      }
      if (additions === 0) break;
      page += 1;
    }
    if (pairSelection !== undefined && searchCandidateCount !== searchExpectedCount) {
      throw new TypeError(
        `Landing-page pair export requires a complete ${searchType} inventory for the requested workspace.`,
      );
    }
  }

  if (duplicateIds.size > 0) {
    warnings.push({
      code: 'DUPLICATE_VARIANTS',
      message: 'Duplicate variant IDs were ignored.',
      variantIds: [...duplicateIds].toSorted(),
    });
  }
  if (candidates.size !== expectedCount) {
    warnings.push({
      code: 'COUNT_MISMATCH',
      message: `Advertised ${expectedCount} variants but found ${candidates.size}.`,
    });
  }

  const details = new Map<string, CmsRecord>();
  const failedIds: string[] = [];
  for (const variantId of [...candidates.keys()].toSorted()) {
    try {
      const detail = await getVariant(connection, variantId, options);
      if (detailWorkspaceId(detail) === workspaceId) {
        details.set(variantId, detail);
      } else {
        rejected.add(variantId);
        ownershipMismatchIds.add(variantId);
      }
    } catch {
      failedIds.push(variantId);
      warnings.push({
        code: 'DETAIL_FAILED',
        message: `Variant detail request failed for ${variantId}.`,
        variantIds: [variantId],
      });
    }
  }

  if (ownershipMismatchIds.size > 0) {
    warnings.push({
      code: 'OWNERSHIP_MISMATCH',
      message: 'Variants outside the requested workspace were rejected.',
      variantIds: [...ownershipMismatchIds].toSorted(),
    });
  }

  if (inventoryExactApiNames && selection !== undefined) {
    const validInventoryDetails = [...details.values()].filter((detail) => {
      const contentType = isRecord(detail.contentType)
        ? detail.contentType.fullyQualifiedName
        : detail.contentType;
      return contentType === selection.contentType && nonemptyString(detail.apiName);
    });
    if (
      inventoryExceedsPageCapacity ||
      candidates.size !== expectedCount ||
      ownershipMismatchIds.size > 0 ||
      failedIds.length > 0 ||
      validInventoryDetails.length !== expectedCount
    ) {
      throw new TypeError(
        `Exact component API names require a complete ${selection.contentType} inventory for the requested workspace.`,
      );
    }
  }

  const landingPageTemplatePairs =
    pairSelection === undefined ? undefined : bindLandingPageTemplatePairs(pairSelection, details);
  if (landingPageTemplatePairs !== undefined) {
    const selectedIds = new Set(
      landingPageTemplatePairs.flatMap(({ page, template }) => [
        page.variantId,
        template.variantId,
      ]),
    );
    for (const variantId of details.keys()) {
      if (!selectedIds.has(variantId)) details.delete(variantId);
    }
  }

  if (selection !== undefined) {
    const selected = new Map(selection.apiNames.map((apiName) => [apiName, [] as string[]]));
    for (const [variantId, detail] of details) {
      const contentType = isRecord(detail.contentType)
        ? detail.contentType.fullyQualifiedName
        : detail.contentType;
      if (contentType !== selection.contentType || !nonemptyString(detail.apiName)) continue;
      selected.get(detail.apiName)?.push(variantId);
    }
    for (const [apiName, matches] of selected) {
      if (matches.length !== 1) {
        throw new TypeError(
          `Exact component API name must resolve once for ${selection.contentType}: ${apiName}`,
        );
      }
    }
    const selectedIds = new Set([...selected.values()].flat());
    for (const variantId of details.keys()) {
      if (!selectedIds.has(variantId)) details.delete(variantId);
    }
  }

  const entries = [...details.keys()].toSorted().map((variantId) => ({
    file: `items/${variantId}.json`,
    variantId,
  }));
  const referenceInventory = inventoryExportReferences(workspaceId, details);
  warnings.push(...referenceInventory.warnings);
  const completeness =
    warnings.some(({ code }) => code !== 'UNSUPPORTED_WILDCARD') ||
    rejected.size > 0 ||
    failedIds.length > 0
      ? 'partial'
      : 'complete';
  const manifestItems = entries.map((entry) => {
    const referenceId = referenceInventory.itemReferenceIds.get(entry.variantId);
    return {
      path: entry.file,
      sha256: sha256(jsonBytes(details.get(entry.variantId))),
      kind: 'cms.content',
      ...(referenceId === undefined ? {} : { referenceId }),
    };
  });
  const mediaCandidates = [...details.entries()].flatMap(([variantId, detail]) => {
    const evidence = imageEvidence(detail);
    return evidence === undefined ? [] : [{ variantId, evidence }];
  });
  const selectedExpectedCount = selection === undefined ? expectedCount : selection.apiNames.length;
  const manifest: WorkspaceExportManifest = {
    schemaVersion: mediaCandidates.length > 0 ? 2 : 1,
    mode: 'experimental-best-effort',
    workspaceId,
    search: {
      contentSpaceOrFolderIds: [workspaceId],
      languages: ['All'],
      pageSize: PAGE_SIZE,
      queryTerm: '*',
    },
    expectedCount: landingPageTemplatePairs === undefined ? selectedExpectedCount : details.size,
    foundCount: selection === undefined ? candidates.size : details.size,
    exportedCount: entries.length,
    pagesRequested,
    entries,
    rejectedVariantIds: [...rejected].toSorted(),
    failedVariantIds: failedIds.toSorted(),
    warnings,
    contract: WORKSPACE_EXPORT_MANIFEST_CONTRACT,
    contractVersion: mediaCandidates.length > 0 ? '2.0.0' : '1.0.0',
    ...(mediaCandidates.length === 0 ? {} : { media: [] }),
    provenance: {
      producer: 'sf-plugin-cms',
      sourceOrgId: options.sourceOrgId ?? 'unknown-org',
      sourceWorkspaceId: workspaceId,
      pluginVersion: options.pluginVersion ?? getPluginVersion(),
      generatedAt: options.generatedAt ?? new Date().toISOString(),
    },
    completeness,
    dependencies: referenceInventory.dependencies,
    ...(landingPageTemplatePairs === undefined ? {} : { landingPageTemplatePairs }),
    externalReferences: referenceInventory.externalReferences,
    items: manifestItems,
  };
  if (mediaCandidates.length > 0 && options.experimentalMedia === undefined) {
    warnings.push({
      code: 'MEDIA_EXPORT_FAILED',
      message:
        'Image candidate JSON was exported without media binaries because --experimental-media was not enabled.',
      variantIds: mediaCandidates.map(({ variantId }) => variantId),
    });
    manifest.completeness = 'partial';
  }

  if (options.editableDirectory !== undefined) {
    await preflightEditableExport(destination, options.editableDirectory);
  }
  const parent = path.dirname(destination);
  await mkdir(parent, { recursive: true });
  const temporary = await (options.atomicPublish?.makeTemporaryDirectory ?? mkdtemp)(
    path.join(parent, `.${path.basename(destination)}.tmp-`),
  );
  try {
    await mkdir(path.join(temporary, 'items'));
    for (const entry of entries) {
      await writeExclusive(path.join(temporary, entry.file), details.get(entry.variantId));
    }
    if (mediaCandidates.length > 0 && options.experimentalMedia !== undefined) {
      await mkdir(path.join(temporary, 'media'));
      let totalBytes = 0;
      for (const { variantId, evidence } of mediaCandidates) {
        const mediaPath = `media/${variantId}-${evidence.fileName}`;
        try {
          const remainingTotal = mediaCaps!.totalBytes - totalBytes;
          if (!Number.isSafeInteger(remainingTotal) || remainingTotal <= 0) {
            throw new TypeError('Experimental media total byte cap is exhausted');
          }
          const downloaded = await downloadExperimentalCmsMedia(
            new URL(evidence.url, options.experimentalMedia.instanceUrl),
            {
              accessToken: options.experimentalMedia.accessToken,
              expectedMd5: evidence.md5,
              expectedMimeType: evidence.mimeType,
              expectedSize: evidence.size,
              fetch: options.experimentalMedia.fetch,
              instanceUrl: options.experimentalMedia.instanceUrl,
              maxBytes: Math.min(mediaCaps!.perImageBytes, remainingTotal),
              outputFile: path.join(temporary, mediaPath),
            },
          );
          if (downloaded.bytes > mediaCaps!.totalBytes - totalBytes) {
            throw new TypeError('Experimental media total byte accounting exceeded the cap');
          }
          totalBytes += downloaded.bytes;
          const current = imageEvidence(await getVariant(connection, variantId, options));
          if (current === undefined || JSON.stringify(current) !== JSON.stringify(evidence)) {
            throw new TypeError('Experimental image authoring metadata changed during export');
          }
          manifest.media!.push({
            variantId,
            contentKey: evidence.contentKey,
            path: mediaPath,
            sha256: downloaded.sha256,
            md5: downloaded.md5,
            bytes: downloaded.bytes,
            mimeType: downloaded.mimeType,
            fileName: evidence.fileName,
            sourceStatus: evidence.status,
            sourceModifiedAt: evidence.modifiedAt,
            sourceVersion: evidence.version,
            sourceUrl: evidence.url,
            transport: 'experimental-undocumented-authoring-media',
          });
          manifest.items.push({
            path: mediaPath,
            sha256: downloaded.sha256,
            kind: 'cms.media',
          });
        } catch (error) {
          await unlink(path.join(temporary, mediaPath)).catch(() => {});
          warnings.push({
            code: 'MEDIA_EXPORT_FAILED',
            message: `Experimental image export failed for ${variantId}: ${error instanceof Error ? error.message : String(error)}`,
            variantIds: [variantId],
          });
          manifest.completeness = 'partial';
          break;
        }
      }
    }
    assertWorkspaceExportManifest(manifest);
    await assertRegularPackageFiles(temporary, new Set(manifest.items.map(({ path }) => path)));
    await writeExclusive(path.join(temporary, 'manifest.json'), manifest);
    await publishDirectoryNoClobber(temporary, destination, options.atomicPublish);
  } catch (error) {
    await cleanupOwnedPath(temporary, error, options.atomicPublish);
  }

  const manifestSha256 = sha256(await readFile(path.join(destination, 'manifest.json')));
  if (options.editableDirectory !== undefined) {
    try {
      await assertRegularPackageFiles(destination, new Set(manifest.items.map(({ path }) => path)));
      if (manifestSha256 !== sha256(jsonBytes(manifest)))
        throw new Error('Published manifest changed');
      const rawItems = [];
      for (const [index, entry] of entries.entries()) {
        const bytes = await readFile(path.join(destination, entry.file));
        if (sha256(bytes) !== manifest.items[index].sha256)
          throw new Error('Published variant changed');
        rawItems.push({
          variantId: entry.variantId,
          raw: JSON.parse(bytes.toString('utf8')) as CmsRecord,
        });
      }
      await writeEditableRawHtml(
        rawItems,
        manifestSha256,
        options.editableDirectory,
        options.editablePublish,
      );
    } catch (error) {
      throw new Error(
        `Baseline export retained at ${destination}; editable output unavailable: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }
  return { destination, manifest, manifestSha256 };
}
