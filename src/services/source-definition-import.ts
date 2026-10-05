import { createHash } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { assertEditableDirectoryPath } from './editable-raw-html-export.js';
import { replaySourceAdmissionEvidence } from './source-admission-evidence.js';
import {
  enumeratePackageFiles,
  loadWorkspaceExport,
  readStableRegularFile,
  type LoadedWorkspaceExport,
} from './import-workspace.js';
import {
  assertSourceNativeHtml,
  projectSourceDefinitions,
  type SourceDefinitionInputItem,
} from './source-definition.js';

async function validateRoutes(baseline: string, definitions: string): Promise<void> {
  await assertEditableDirectoryPath(baseline, false);
  await assertEditableDirectoryPath(definitions, false);
  const left = path.resolve(baseline).toLowerCase();
  const right = path.resolve(definitions).toLowerCase();
  const contains = (parent: string, child: string): boolean => {
    const relative = path.relative(parent, child);
    return (
      relative === '' ||
      (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))
    );
  };
  if (contains(left, right) || contains(right, left))
    throw new TypeError('Baseline and source-definition directories must not overlap');
}

export type SourceDefinitionEditEvidence = {
  readonly entries: readonly {
    readonly definitionPath: string;
    readonly variantId: string;
    readonly contentId: string;
    readonly originalHtmlSha256?: string;
    readonly currentHtmlSha256?: string;
    readonly changed: boolean;
    readonly literalHtml?: string;
  }[];
};

/**
 * Validate files and edits against original acquired evidence, not baseline admission.
 * This checkpoint cannot establish historical workspace, parent or sibling completeness.
 * It returns detached edit evidence only, never integrity-labelled import payloads.
 * @param {readonly SourceDefinitionInputItem[]} original - Original acquired projection inputs.
 * @param {string} baselineDirectory - Disjoint immutable baseline route.
 * @param {string} definitionDirectory - Existing source tree to inspect.
 * @returns {Promise<SourceDefinitionEditEvidence>} Detached literal HTML and original/current hashes.
 */
export async function validateSourceDefinitionFiles(
  original: readonly SourceDefinitionInputItem[],
  baselineDirectory: string,
  definitionDirectory: string,
): Promise<SourceDefinitionEditEvidence> {
  const projection = projectSourceDefinitions(original);
  if (
    new Set(original.map((item) => item.workspaceId)).size !== 1 ||
    new Set(original.map((item) => item.workspaceApiName)).size !== 1 ||
    new Set(original.map((item) => item.contentType)).size !== 1 ||
    original.some((item) => item.folderPath.length > 0)
  )
    throw new TypeError('Source import requires one workspace/family and root-only placement');
  await validateRoutes(baselineDirectory, definitionDirectory);
  const directory = path.resolve(definitionDirectory);
  const expected = projection.items
    .flatMap((item) =>
      item.htmlPath === undefined ? [item.definitionPath] : [item.definitionPath, item.htmlPath],
    )
    .toSorted();
  const enumerate = async (): Promise<void> => {
    const files = await enumeratePackageFiles(directory, directory);
    if (!isDeepStrictEqual(files, expected))
      throw new TypeError('Source tree contains missing, substituted, or unlisted files');
    for (const file of files) {
      const information = await lstat(path.join(directory, file));
      if (information.nlink !== 1)
        throw new TypeError('Source files must not have hard-link aliases');
    }
  };
  await enumerate();
  const entries: SourceDefinitionEditEvidence['entries'][number][] = [];
  const observed = new Map<string, Buffer>();
  for (const [index, item] of projection.items.entries()) {
    const bytes = await readStableRegularFile(
      path.join(directory, item.definitionPath),
      'Source definition',
    );
    if (!bytes.equals(item.definitionBytes))
      throw new TypeError(
        'Source JSON differs from deterministic original reprojection; only HTML edits are supported',
      );
    observed.set(item.definitionPath, bytes);
    const evidence = projection.evidence[index];
    if (item.htmlPath === undefined) {
      entries.push({ ...evidence, changed: false });
      continue;
    }
    const htmlBytes = await readStableRegularFile(
      path.join(directory, item.htmlPath),
      'Source HTML',
    );
    observed.set(item.htmlPath, htmlBytes);
    let literalHtml: string;
    try {
      literalHtml = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(htmlBytes);
    } catch (error) {
      throw new TypeError('Source HTML must contain valid UTF-8', { cause: error });
    }
    assertSourceNativeHtml(item.definition.contentType, item.definition.contentBody, literalHtml);
    const currentHtmlSha256 = createHash('sha256').update(htmlBytes).digest('hex');
    entries.push({
      ...evidence,
      currentHtmlSha256,
      changed: currentHtmlSha256 !== evidence.originalHtmlSha256,
      literalHtml,
    });
  }
  await assertEditableDirectoryPath(definitionDirectory, false);
  await enumerate();
  for (const [file, bytes] of observed) {
    const current = await readStableRegularFile(path.join(directory, file), 'Source revalidation');
    if (!current.equals(bytes)) throw new TypeError('Source files changed during validation');
  }
  return { entries };
}

export type LoadedSourceDefinitions = {
  readonly sourceManifestSha256: string;
  readonly originals: readonly SourceDefinitionInputItem[];
  readonly edits: SourceDefinitionEditEvidence;
};

// JSON.parse validates syntax; the token pass additionally rejects ambiguous duplicate keys.
function strictJson(bytes: Buffer, label: string): unknown {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch (error) {
    throw new TypeError(`${label} must contain valid UTF-8`, { cause: error });
  }
  if (text.startsWith('\uFEFF')) throw new TypeError(`${label} must not contain a BOM`);
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch (error) {
    throw new TypeError(`${label} must contain valid JSON`, { cause: error });
  }
  const tokens = text.match(
    /"(?:[^"\\]|\\.)*"|[{}[\]:,]|-?\d+(?:\.\d+)?(?:[Ee][+-]?\d+)?|true|false|null/gu,
  )!;
  const containers: (Set<string> | undefined)[] = [];
  for (const [index, token] of tokens.entries()) {
    switch (token) {
      case '{': {
        containers.push(new Set());
        break;
      }
      case '[': {
        containers.push(undefined);
        break;
      }
      case '}':
      case ']': {
        containers.pop();
        break;
      }
      default: {
        if (token.startsWith('"') && tokens[index + 1] === ':') {
          const key = JSON.parse(token) as string;
          const keys = containers.at(-1)!;
          if (keys.has(key)) throw new TypeError(`${label} contains duplicate JSON keys`);
          keys.add(key);
        }
      }
    }
  }
  return value;
}

/**
 * Admit source files only through pinned original package bytes and historical evidence replay.
 * This is unsigned manifest integrity, not a claim of Salesforce authorship or authenticity.
 * @param {LoadedWorkspaceExport} source - Previously integrity-loaded original package.
 * @param {string} definitionDirectory - Separate existing source-definition directory.
 * @returns {Promise<LoadedSourceDefinitions>} Detached original inputs and validated literal edits.
 */
export async function loadSourceDefinitions(
  source: LoadedWorkspaceExport,
  definitionDirectory: string,
): Promise<LoadedSourceDefinitions> {
  if (!source.integrity.verified) throw new TypeError('Original source integrity must be verified');
  // Pin caller binding before the first asynchronous operation; never use caller item payloads.
  const sourceDirectory = source.sourceDirectory;
  const sourceManifestSha256 = source.manifestSha256;
  const profile = source.manifest.brandReports?.length ? 'brand' : 'general';
  const verifyBaseline = async (): Promise<LoadedWorkspaceExport> => {
    await validateRoutes(sourceDirectory, definitionDirectory);
    const baseline = await loadWorkspaceExport(sourceDirectory, { profile });
    if (baseline.manifestSha256 !== sourceManifestSha256)
      throw new TypeError('Original source manifest changed since integrity loading');
    for (const file of ['manifest.json', ...baseline.manifest.items.map((item) => item.path)]) {
      const information = await lstat(path.join(baseline.sourceDirectory, file));
      if (information.nlink !== 1)
        throw new TypeError('Original baseline files must not have hard-link aliases');
    }
    return baseline;
  };
  const baseline = await verifyBaseline();
  const evidencePath = 'evidence/source-admission.v1.json';
  const candidates = baseline.manifest.items.filter(
    (item) => item.kind === 'cms.source-admission' || item.path === evidencePath,
  );
  if (candidates.length === 0)
    throw new TypeError(
      'Source admission evidence unavailable: original workspace API name, parent GET records and complete sibling inventory cannot be reconstructed; re-export with --definition-dir (source definitions are not proof)',
    );
  const artifact = candidates[0];
  if (
    candidates.length !== 1 ||
    artifact.path !== evidencePath ||
    artifact.kind !== 'cms.source-admission' ||
    artifact.referenceId !== undefined
  )
    throw new TypeError(
      'Source admission requires exactly one canonical evidence artifact without referenceId',
    );
  const readOriginal = async (file: string, sha256: string): Promise<Buffer> => {
    const bytes = await readStableRegularFile(
      path.join(baseline.sourceDirectory, file),
      'Original source bytes',
    );
    if (createHash('sha256').update(bytes).digest('hex') !== sha256)
      throw new TypeError(`Original source ${file} failed SHA-256 verification`);
    return bytes;
  };
  const evidence = strictJson(
    await readOriginal(artifact.path, artifact.sha256),
    'Source admission evidence',
  );
  const rawItems = new Map<string, Readonly<Record<string, unknown>>>();
  for (const entry of baseline.manifest.entries) {
    const declared = baseline.manifest.items.find((item) => item.path === entry.file)!;
    const raw = strictJson(
      await readOriginal(entry.file, declared.sha256),
      'Original source entry',
    );
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw))
      throw new TypeError('Original source entry must be a JSON object');
    rawItems.set(entry.file, raw as Readonly<Record<string, unknown>>);
  }
  const originals = replaySourceAdmissionEvidence(evidence, baseline.manifest, rawItems);
  const edits = await validateSourceDefinitionFiles(
    originals,
    sourceDirectory,
    definitionDirectory,
  );
  await verifyBaseline();
  const current = await validateSourceDefinitionFiles(
    originals,
    sourceDirectory,
    definitionDirectory,
  );
  if (!isDeepStrictEqual(edits, current))
    throw new TypeError('Source files changed during admission');
  return structuredClone({ sourceManifestSha256, originals, edits });
}
