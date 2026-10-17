import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { constants } from 'node:fs';
import { constants as bufferConstants } from 'node:buffer';
import { lstat, mkdir, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import type { BigIntStats } from 'node:fs';
import type { Connection } from '@salesforce/core';
import type {
  ImageUploadApplyOptions,
  ImageUploadApplyResult,
  ImageUploadReport,
  ImageUploadFileIdentity,
  ImageUploadInput,
  ImageUploadPreparation,
  ImageUploadReadServices,
  ImageUploadRootEvidence,
  PlannedImageUploadFile,
} from '../contracts/image-upload.js';
import {
  buildImageCreateMultipart,
  createImageContent,
  type MultipartImageCreateOptions,
  type ManagedContentDocumentBinding,
} from '../transport/multipart-image-create.js';
import { rewriteAtomic } from './import-workspace.js';
import { redactSecrets } from '../transport/redact-secrets.js';
import {
  getSelectedOperation,
  requestJson,
  type JsonRequestOptions,
} from '../transport/json-request.js';
import { getVariant, getWorkspace, type CmsRecord } from './read.js';
import { assertWorkspaceSelector, resolveWorkspace } from './resolve-workspace.js';

export class ImageUploadApplyError extends Error {
  public constructor(
    public readonly report: ImageUploadReport,
    public readonly reportFile: string,
  ) {
    super(report.error ?? 'Image upload failed');
    this.name = 'ImageUploadApplyError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonempty(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/**
 * Full ASCII filename, preserving any extension; separator runs collapse without suffixing.
 * @param {string} filename - Safe full basename, with or without an extension.
 * @returns {{title: string, apiName: string, urlName: string}} Deterministic image names.
 */
export function imageUploadNames(filename: string): {
  title: string;
  apiName: string;
  urlName: string;
} {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9 ._-]*(?![\s\S])/u.test(filename) ||
    /[ .]$/u.test(filename) ||
    filename.includes('..') ||
    /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(filename)
  ) {
    throw new TypeError('Unsafe or unsupported image filename');
  }
  const normalized = filename.toLowerCase();
  const apiName = normalized.replaceAll(/[^a-z0-9]+/gu, '_');
  if (!/^[a-z]/u.test(apiName)) throw new TypeError('Image API name must start with a letter');
  return { title: filename, apiName, urlName: normalized.replaceAll(/[^a-z0-9]+/gu, '-') };
}

function identity(stat: BigIntStats): ImageUploadFileIdentity {
  return {
    dev: String(stat.dev),
    ino: String(stat.ino),
    size: Number(stat.size),
    mtimeNs: String(stat.mtimeNs),
    ctimeNs: String(stat.ctimeNs),
  };
}

function sameIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return JSON.stringify(identity(left)) === JSON.stringify(identity(right));
}

const executeFile = promisify(execFile);

function foldPath(value: string): string {
  return process.platform === 'win32' ? value.toLowerCase() : value;
}

async function assertPlainPath(filePath: string): Promise<void> {
  if (process.platform === 'win32') {
    // Node lstat does not expose every Windows reparse tag; inspect the native attribute bit.
    const literal = filePath.replaceAll("'", "''");
    const script = `$ErrorActionPreference='Stop'; $p='${literal}'; while ($p) { if (([System.IO.File]::GetAttributes($p) -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Reparse point image path' }; $p=[System.IO.Path]::GetDirectoryName($p) }`;
    try {
      await executeFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
        timeout: 10_000,
        windowsHide: true,
      });
    } catch {
      throw new TypeError(
        'Image path contains a symlink or junction, or reparse eligibility cannot be proven',
      );
    }
  }
  let current = filePath;
  for (;;) {
    const stat = await lstat(current);
    if (stat.isSymbolicLink()) throw new TypeError('Image path contains a symlink or junction');
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  // Canonical-path mismatch also rejects redirected/reparse paths not reported as symlinks.
  const canonical = await realpath(filePath);
  if (foldPath(canonical) !== foldPath(filePath)) throw new TypeError('Image path is redirected');
}

function mediaType(bytes: Buffer): PlannedImageUploadFile['mediaType'] {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255)
    return 'image/jpeg';
  if (['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('ascii'))) return 'image/gif';
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
    bytes.subarray(8, 12).toString('ascii') === 'WEBP'
  )
    return 'image/webp';
  // Signatures are MIME hints only; Salesforce decides whether these bytes are an Image.
  return 'application/octet-stream';
}

async function readImage(filePath: string): Promise<PlannedImageUploadFile> {
  const filename = path.basename(filePath);
  const names = imageUploadNames(filename);
  await assertPlainPath(filePath);
  const before = await lstat(filePath, { bigint: true });
  if (!before.isFile() || before.size <= 0n) {
    throw new TypeError('Image must be a regular nonempty file');
  }
  if (
    before.size > BigInt(Number.MAX_SAFE_INTEGER) ||
    before.size > BigInt(bufferConstants.MAX_LENGTH)
  ) {
    throw new TypeError('Image size cannot be represented by a Buffer');
  }
  const handle = await open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat({ bigint: true });
    if (!sameIdentity(before, opened)) throw new TypeError('Image changed before reading');
    // Read exactly the proven size, never a format-specific allocation or an unbounded read.
    const buffer = Buffer.alloc(Number(before.size));
    let length = 0;
    while (length < buffer.length) {
      const result = await handle.read(buffer, length, buffer.length - length, length);
      if (result.bytesRead === 0) break;
      length += result.bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    await assertPlainPath(filePath);
    const linked = await lstat(filePath, { bigint: true });
    if (
      !sameIdentity(before, after) ||
      !sameIdentity(before, linked) ||
      length !== Number(before.size)
    ) {
      throw new TypeError('Image changed during reading');
    }
    const bytes = buffer;
    const detected = mediaType(bytes);
    return {
      path: filePath,
      filename,
      ...names,
      mediaType: detected,
      bytes,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      identity: identity(before),
    };
  } finally {
    await handle.close();
  }
}

export async function planImageUploadFiles(
  files: readonly string[],
): Promise<PlannedImageUploadFile[]> {
  if (!Array.isArray(files) || files.length === 0)
    throw new TypeError('Specify at least one explicit image file');
  const seenPaths = new Set<string>();
  const seenIdentities = new Set<string>();
  const names = new Set<string>();
  const planned: PlannedImageUploadFile[] = [];
  for (const file of files) {
    if (!nonempty(file)) throw new TypeError('Image path must be nonempty');
    const absolute = path.resolve(file);
    const key = process.platform === 'win32' ? absolute.toLowerCase() : absolute;
    if (seenPaths.has(key)) throw new TypeError('Duplicate image path');
    seenPaths.add(key);
    const image = await readImage(absolute);
    const inode = `${image.identity.dev}:${image.identity.ino}`;
    if (seenIdentities.has(inode)) throw new TypeError('Duplicate image file identity');
    seenIdentities.add(inode);
    for (const field of ['apiName', 'urlName', 'title'] as const) {
      const name = `${field}:${image[field].toLowerCase()}`;
      if (names.has(name)) throw new TypeError(`Batch image ${field} collision`);
      names.add(name);
    }
    planned.push(image);
  }
  return planned;
}

/**
 * SpaceResponse proves rootFolderId is a folder ID and isEnhancedSpace is the eligibility flag.
 * @param {string} workspaceId - Exact selected workspace ID.
 * @param {CmsRecord} workspace - Workspace detail response.
 * @returns {ImageUploadRootEvidence} Proven enhanced-space root binding.
 */
function rootEvidence(workspaceId: string, workspace: CmsRecord): ImageUploadRootEvidence {
  if (
    workspace.id !== workspaceId ||
    workspace.isEnhancedSpace !== true ||
    !nonempty(workspace.rootFolderId) ||
    workspace.rootFolderId === workspaceId
  ) {
    throw new TypeError('Exact enhanced workspace and distinct root folder evidence required');
  }
  return { workspaceId, rootFolderId: workspace.rootFolderId, isEnhancedSpace: true };
}

async function collisionInventory(
  workspaceId: string,
  services: ImageUploadReadServices,
): Promise<CmsRecord[]> {
  const rows: unknown[] = [];
  const pageIds = new Set<string>();
  let expected: number | undefined;
  let complete = false;
  for (let page = 0; page < 1000; page += 1) {
    const response = await services.searchVariants(workspaceId, page);
    if (!isRecord(response) || !Array.isArray(response.items))
      throw new TypeError('Malformed image collision inventory');
    const totals = [response.total, response.totalCount].filter((value) => value !== undefined);
    if (
      totals.some((value) => !Number.isSafeInteger(value) || Number(value) < 0) ||
      new Set(totals).size > 1 ||
      response.items.length > 250 ||
      (response.count !== undefined &&
        (!Number.isSafeInteger(response.count) || response.count !== response.items.length))
    ) {
      throw new TypeError('Complete collision inventory cannot be proven');
    }
    // count describes the returned page; total/totalCount, when supplied, describe the inventory.
    if (totals.length > 0) {
      const total = Number(totals[0]);
      if (total > 250_000 || (expected !== undefined && total !== expected))
        throw new TypeError('Collision inventory total changed or exceeds finite bound');
      expected = total;
    } else if (response.count === undefined || expected !== undefined) {
      throw new TypeError('Complete collision inventory cannot be proven');
    }
    for (const row of response.items) {
      if (!isRecord(row) || !nonempty(row.id) || pageIds.has(row.id))
        throw new TypeError('Collision inventory duplicate or missing ID');
      pageIds.add(row.id);
    }
    rows.push(...response.items);
    if (response.items.length < 250) {
      if (expected !== undefined && rows.length !== expected)
        throw new TypeError('Collision inventory incomplete');
      complete = true;
      break;
    }
    if (expected !== undefined && rows.length > expected)
      throw new TypeError('Collision inventory exceeds total');
  }
  if (!complete) throw new TypeError('Collision inventory exceeded page cap without completion');
  const ids = new Set<string>();
  const details: CmsRecord[] = [];
  for (const row of rows) {
    if (
      !isRecord(row) ||
      !nonempty(row.id) ||
      ids.has(row.id) ||
      row.managedContentSpaceId !== workspaceId
    ) {
      throw new TypeError('Collision inventory identity is ambiguous');
    }
    ids.add(row.id);
    const detail = await services.getVariant(row.id);
    if (
      detail.id !== row.id ||
      !isRecord(detail.contentSpace) ||
      detail.contentSpace.id !== workspaceId ||
      !nonempty(detail.apiName) ||
      !nonempty(detail.title) ||
      !nonempty(detail.urlName)
    ) {
      throw new TypeError('Collision inventory detail identity is incomplete');
    }
    details.push(detail);
  }
  return details;
}

/**
 * All-or-nothing preparation; rejects rather than returning any ready intent on a failed preflight.
 * @param {ImageUploadInput} input - Explicit paths and exact workspace selector.
 * @param {ImageUploadReadServices} services - Read-only workspace and inventory services.
 * @returns {Promise<ImageUploadPreparation>} Complete preparation or rejection without intents.
 */
export async function prepareImageUpload(
  input: ImageUploadInput,
  services: ImageUploadReadServices,
): Promise<ImageUploadPreparation> {
  assertWorkspaceSelector(input);
  const files = await planImageUploadFiles(input.files);
  const selector = { workspaceId: input.workspaceId, workspaceName: input.workspaceName };
  const resolved = await services.resolveWorkspace(selector);
  if (input.workspaceId !== undefined && resolved.id !== input.workspaceId) {
    throw new TypeError('Resolved workspace does not match the exact selected ID');
  }
  const root = rootEvidence(resolved.id, resolved.workspace);
  const inventory = await collisionInventory(root.workspaceId, services);
  for (const file of files) {
    for (const field of ['apiName', 'title', 'urlName'] as const) {
      if (
        inventory.some(
          (detail) => String(detail[field]).toLowerCase() === file[field].toLowerCase(),
        )
      ) {
        throw new TypeError(`Destination image ${field} collision`);
      }
    }
  }
  const repeated = rootEvidence(root.workspaceId, await services.getWorkspace(root.workspaceId));
  if (repeated.rootFolderId !== root.rootFolderId)
    throw new TypeError('Workspace root changed during preparation');
  return {
    ready: true,
    root,
    intents: files.map((file) => ({
      action: 'create',
      file,
      input: {
        contentSpaceOrFolderId: root.rootFolderId,
        title: file.title,
        apiName: file.apiName,
        urlName: file.urlName,
      },
    })),
  };
}

async function revalidateUpload(
  preparation: ImageUploadPreparation,
  services: ImageUploadReadServices,
): Promise<ImageUploadPreparation> {
  const fresh = await prepareImageUpload(
    {
      workspaceId: preparation.root.workspaceId,
      files: preparation.intents.map(({ file }) => file.path),
    },
    services,
  );
  if (
    JSON.stringify(fresh.root) !== JSON.stringify(preparation.root) ||
    fresh.intents.length !== preparation.intents.length
  )
    throw new TypeError('Upload root or batch drift');
  for (const [index, intent] of fresh.intents.entries()) {
    const prior = preparation.intents[index];
    if (
      prior.action !== 'create' ||
      JSON.stringify(intent.input) !== JSON.stringify(prior.input) ||
      JSON.stringify(intent.file.identity) !== JSON.stringify(prior.file.identity) ||
      intent.file.sha256 !== prior.file.sha256 ||
      !intent.file.bytes.equals(prior.file.bytes) ||
      intent.file.mediaType !== prior.file.mediaType ||
      intent.file.filename !== prior.file.filename
    ) {
      throw new TypeError('Upload file, bytes, or intent drift');
    }
  }
  return fresh;
}

function verifyUploadReadback(
  detail: CmsRecord,
  binding: ManagedContentDocumentBinding,
  preparation: ImageUploadPreparation,
  index: number,
): void {
  const input = preparation.intents[index].input;
  if (!isRecord(detail.folder) || detail.folder.id !== preparation.root.rootFolderId)
    throw new TypeError('Authoritative root folder membership readback missing or mismatched');
  if (
    !isRecord(detail.contentSpace) ||
    detail.contentSpace.id !== preparation.root.workspaceId ||
    !isRecord(detail.contentType) ||
    detail.contentType.fullyQualifiedName !== 'sfdc_cms__image' ||
    detail.managedContentId !== binding.managedContentId ||
    detail.managedContentVariantId !== binding.managedContentVariantId ||
    detail.contentKey !== binding.contentKey ||
    detail.title !== input.title ||
    detail.apiName !== input.apiName ||
    detail.urlName !== input.urlName ||
    detail.isPublished !== false ||
    !isRecord(detail.status) ||
    detail.status.status !== 'Draft'
  ) {
    throw new TypeError('Image readback identity or Draft mismatch');
  }
}

/**
 * Execute only unchanged root uploads; stop permanently at the first uncertain mutation.
 * @param {ImageUploadApplyOptions} options - Prepared files, read dependencies, multipart transport and new report directory.
 * @returns {Promise<ImageUploadApplyResult>} Durable completed report, without downloaded byte proof.
 */
export async function applyImageUpload(
  options: ImageUploadApplyOptions,
): Promise<ImageUploadApplyResult> {
  // Detach all mutable caller objects before any asynchronous work.
  const cloned = structuredClone(options.preparation);
  const preparation: ImageUploadPreparation = {
    ...cloned,
    intents: cloned.intents.map((intent) => ({
      ...intent,
      file: { ...intent.file, bytes: Buffer.from(intent.file.bytes) },
    })),
  };
  if (preparation.ready !== true || preparation.intents.length === 0)
    throw new TypeError('Nonempty ready upload preparation required');
  if (!nonempty(options.reportDirectory)) throw new TypeError('New report directory required');
  await mkdir(path.resolve(options.reportDirectory));
  let reportFile = path.join(path.resolve(options.reportDirectory), 'image-upload-run.json');
  const report: ImageUploadReport = {
    runId: randomUUID(),
    root: preparation.root,
    state: 'applying',
    operations: preparation.intents.map(({ file, input }) => {
      const { bytes, ...evidence } = file;
      void bytes;
      return { file: evidence, input, state: 'planned', byteProof: 'unavailable' };
    }),
  };
  // Every ordered intent is recorded exclusively before any mutation; fsync before closing.
  const initial = await open(reportFile, 'wx');
  try {
    await initial.writeFile(`${JSON.stringify(report, null, 2)}\n`);
    await initial.sync();
  } finally {
    await initial.close();
  }
  const rewrite = async (): Promise<void> => {
    await (options.reportPersistence?.rewrite ?? rewriteAtomic)(reportFile, report);
    const handle = await open(reportFile, 'r+');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  };
  let mutationUncertain = false;
  try {
    await revalidateUpload(preparation, options.services);
    for (const [index, operation] of report.operations.entries()) {
      // Recheck every remaining file and complete collision scope immediately before each POST.
      const remaining = { ...preparation, intents: preparation.intents.slice(index) };
      const fresh = await revalidateUpload(remaining, options.services);
      const intent = fresh.intents[0];
      const boundary = `sf-plugin-cms-${randomBytes(24).toString('hex')}`;
      const createOptions: MultipartImageCreateOptions = {
        ...options.createOptions,
        mimeType: intent.file.mediaType,
        boundaryFactory: () => boundary,
      };
      const multipart = buildImageCreateMultipart(
        intent.input,
        intent.file.filename,
        intent.file.bytes,
        createOptions,
      );
      operation.requestSha256 = createHash('sha256').update(multipart.body).digest('hex');
      operation.state = 'pending';
      report.state = 'ownership-uncertain';
      await rewrite();
      mutationUncertain = true;
      const binding = await createImageContent(
        options.connection,
        intent.input,
        intent.file.filename,
        intent.file.bytes,
        createOptions,
      );
      operation.binding = binding;
      await rewrite();
      const parent = await options.services.getContent(binding.managedContentId);
      verifyUploadReadback(parent, binding, preparation, index);
      const variant = await options.services.getVariant(binding.managedContentVariantId);
      verifyUploadReadback(variant, binding, preparation, index);
      operation.state = 'succeeded';
      report.state = 'applying';
      await rewrite();
      mutationUncertain = false;
    }
    report.state = 'completed';
    await rewrite();
  } catch (error) {
    report.state = mutationUncertain ? 'ownership-uncertain' : 'failed';
    report.error = redactSecrets(error instanceof Error ? error.message : String(error)).slice(
      0,
      1024,
    );
    try {
      await rewrite();
    } catch {
      // Independent exclusive fallback retains known bindings when the normal journal fails.
      const fallbackFile = path.join(path.dirname(reportFile), `failure-${randomUUID()}.json`);
      try {
        const fallback = await open(fallbackFile, 'wx');
        try {
          await fallback.writeFile(`${JSON.stringify(report, null, 2)}\n`);
          await fallback.sync();
          reportFile = fallbackFile;
        } finally {
          await fallback.close();
        }
      } catch {
        // Retain the original durable journal path even if fallback persistence fails.
      }
    }
    throw new ImageUploadApplyError(report, reportFile);
  }
  return { report, reportFile };
}

/**
 * Existing read transports only; bounded unfiltered All-language search, never an export/package write.
 * @param {Pick<Connection, 'request'>} connection - Existing CMS request connection.
 * @param {JsonRequestOptions} options - Read transport options.
 * @returns {ImageUploadReadServices} Read-only dependencies for preparation.
 */
export function imageUploadReadServices(
  connection: Pick<Connection, 'request'>,
  options: JsonRequestOptions = {},
): ImageUploadReadServices {
  return {
    resolveWorkspace: async (selector) => resolveWorkspace(connection, selector, options),
    getWorkspace: async (id) => getWorkspace(connection, id, options),
    getVariant: async (id) => getVariant(connection, id, options),
    searchVariants: async (id, page = 0) => {
      const response = await requestJson<unknown>(
        connection,
        getSelectedOperation('workspace.variant.search'),
        {
          query: {
            contentSpaceOrFolderIds: [id],
            languages: ['All'],
            page,
            pageSize: 250,
            queryTerm: '*',
          },
        },
        options,
      );
      return response.data;
    },
  };
}
