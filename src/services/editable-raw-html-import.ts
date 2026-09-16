import { createHash } from 'node:crypto';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { assertEditableDirectoryPath } from './editable-raw-html-export.js';
import { projectEditableRawHtml, type EditableRawItem } from './editable-raw-html.js';
import {
  enumeratePackageFiles,
  loadWorkspaceExport,
  readStableRegularFile,
  type LoadedWorkspaceExport,
  type WorkspaceImportItem,
} from './import-workspace.js';

export type EditableHtmlEvidence = {
  readonly contract: 'sf-cms-editable-raw-html';
  readonly sourceManifestSha256: string;
  readonly entries: readonly {
    readonly variantId: string;
    readonly originalHtmlSha256: string;
    readonly currentHtmlSha256: string;
    readonly changed: boolean;
  }[];
};

export type LoadedEditableRawHtml = {
  readonly items: readonly WorkspaceImportItem[];
  readonly literalHtmlVariantIds: ReadonlySet<string>;
  readonly editableSource: EditableHtmlEvidence;
};

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function utf8(bytes: Buffer, label: string): string {
  if (bytes.subarray(0, 3).equals(Buffer.from('\uFEFF', 'utf8'))) {
    throw new TypeError(`${label} must be UTF-8 without a BOM`);
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (error) {
    throw new TypeError(`${label} must contain valid UTF-8`, { cause: error });
  }
}

/**
 * Reverify the complete original export and reconstruct only declared literal HTML sidecars.
 * Metadata and descriptor expectations always come from original raw JSON, not editable hashes.
 * @param {LoadedWorkspaceExport} source - Complete original integrity-loaded package (not a selected/proposed view).
 * @param {string} editableDirectory - Separate companion directory.
 * @param {readonly string[]} selectedVariantIds - Selected original variants; defaults to the complete editable subset.
 * @returns {Promise<LoadedEditableRawHtml>} Detached selected items, literal-input provenance, and all-companion edit inventory.
 */
export async function loadEditableRawHtml(
  source: LoadedWorkspaceExport,
  editableDirectory: string,
  selectedVariantIds?: readonly string[],
): Promise<LoadedEditableRawHtml> {
  if (!source.integrity.verified) throw new TypeError('Source integrity must be verified first');
  await assertEditableDirectoryPath(source.sourceDirectory, false);
  // Recheck all baseline files, including unselected items, before reading any editable input.
  const baseline = await loadWorkspaceExport(source.sourceDirectory, {
    allowPartial: source.isPartial,
  });
  if (baseline.manifestSha256 !== source.manifestSha256) {
    throw new TypeError('Original source manifest changed since integrity loading');
  }
  const rawItems: EditableRawItem[] = [];
  for (const entry of baseline.manifest.entries) {
    const bytes = await readStableRegularFile(
      path.join(baseline.sourceDirectory, entry.file),
      `Original item ${entry.variantId}`,
    );
    const declared = baseline.manifest.items.find((item) => item.path === entry.file);
    if (sha256(bytes) !== declared?.sha256) {
      throw new TypeError(`Original item ${entry.variantId} failed SHA-256 verification`);
    }
    rawItems.push({
      variantId: entry.variantId,
      raw: JSON.parse(bytes.toString()) as Record<string, unknown>,
    });
  }
  const projection = projectEditableRawHtml(rawItems, baseline.manifestSha256);
  await assertEditableDirectoryPath(editableDirectory, false);
  const directory = path.resolve(editableDirectory);
  const files = await enumeratePackageFiles(directory, directory);
  const expectedFiles = [
    'editable.json',
    ...projection.items.flatMap((item) => [item.metadataPath, item.htmlPath]),
  ].toSorted();
  if (!isDeepStrictEqual(files, expectedFiles)) {
    throw new TypeError(
      'Editable companion contains missing, substituted, or unlisted regular files',
    );
  }
  const descriptorBytes = await readStableRegularFile(
    path.join(directory, 'editable.json'),
    'Editable descriptor',
  );
  const descriptor: unknown = JSON.parse(utf8(descriptorBytes, 'Editable descriptor'));
  if (!isDeepStrictEqual(descriptor, projection.descriptor)) {
    throw new TypeError('Editable descriptor does not match the verified original baseline');
  }
  const html = new Map<string, string>();
  const entries: EditableHtmlEvidence['entries'][number][] = [];
  for (const item of projection.items) {
    const metadata = await readStableRegularFile(
      path.join(directory, item.metadataPath),
      `Editable metadata ${item.variantId}`,
    );
    if (!metadata.equals(item.metadataBytes)) {
      throw new TypeError(
        `Editable metadata ${item.variantId} differs from the original baseline; only HTML edits are supported`,
      );
    }
    const bytes = await readStableRegularFile(
      path.join(directory, item.htmlPath),
      `Editable HTML ${item.variantId}`,
    );
    html.set(item.variantId, utf8(bytes, `Editable HTML ${item.variantId}`));
    const originalHtmlSha256 = sha256(item.htmlBytes);
    const currentHtmlSha256 = sha256(bytes);
    entries.push({
      variantId: item.variantId,
      originalHtmlSha256,
      currentHtmlSha256,
      changed: currentHtmlSha256 !== originalHtmlSha256,
    });
  }
  const selected = selectedVariantIds ?? projection.items.map((item) => item.variantId);
  if (new Set(selected).size !== selected.length)
    throw new TypeError('Duplicate selected editable variant');
  const items = selected.map((id) => {
    const original = baseline.items.find((item) => item.id === id);
    const rawHtml = html.get(id);
    if (!original || rawHtml === undefined)
      throw new TypeError(`Selected variant ${id} is missing from the editable companion`);
    const detached = structuredClone(original);
    return { ...detached, contentBody: { ...detached.contentBody, rawHtml } };
  });
  return {
    items,
    literalHtmlVariantIds: new Set(selected),
    editableSource: {
      contract: 'sf-cms-editable-raw-html',
      sourceManifestSha256: baseline.manifestSha256,
      entries,
    },
  };
}
