import { createHash } from 'node:crypto';
import {
  BODY_ENVELOPE_FIELDS,
  recordIdsOf,
  referencedContentKeys,
  referenceFormsOf,
} from '../content/json-projection.js';
import {
  recordReferences,
  resolveRecordReferences,
  resolveReferences,
} from '../content/json-source.js';
import { contentTypeOf } from '../content/registry.js';
import type {
  ContentTypeHandler,
  DeployPayload,
  LogicalReference,
  NativeVariant,
  SourceFiles,
} from '../content/types.js';
import { CmsError, toDiagnostic, type Diagnostic } from '../errors/registry.js';
import {
  CmsRequestError,
  getSelectedOperation,
  isRecord,
  requestJson,
  type RequestConnection,
} from '../transport/json-request.js';
import { requestJsonMutation, type JsonMutationOptions } from '../transport/json-mutation.js';
import { buildAudioUpdateMultipart } from '../transport/multipart-audio-update.js';
import { buildDocumentUpdateMultipart } from '../transport/multipart-document-update.js';
import { createMediaContent, type MediaContentType } from '../transport/multipart-image-create.js';
import {
  buildImageUpdateMultipart,
  sendVariantUpdateMultipart,
} from '../transport/multipart-image-update.js';
import type { MultipartBody } from '../transport/multipart.js';
import type { WriteConnection } from '../transport/one-shot-connection.js';
import { dependencyOrder, type SelectedSource } from './deploy-selection.js';
import { checkDataGraphReferences, dataGraphReferences } from './data-graph-check.js';
import { folderPathCache, folderPlanner, type CreatedFolder } from './folders.js';
import { inventoryOf, type InventoryItem } from './inventory.js';
import { mediaOf } from './media.js';
import { recordResolver } from './record-references.js';
import { referenceResolver, type Diagnostics } from './retrieve.js';
import type { CmsWorkspace } from './workspaces.js';

/**
 * Per-component outcome. Preview: create, update, unchanged, blocked, planned-dependencies.
 * Deploy: created, updated, unchanged, blocked, failed, unknown, not-attempted.
 */
export type DeployOutcome =
  | 'create'
  | 'update'
  | 'unchanged'
  | 'blocked'
  | 'planned-dependencies'
  | 'created'
  | 'updated'
  | 'failed'
  | 'unknown'
  | 'not-attempted';

/** One component of a deploy result. */
export type DeployedItem = {
  type: string;
  apiName: string;
  outcome: DeployOutcome;
  /** For planned-dependencies: what the deploy would do once the dependencies exist. */
  action?: 'create' | 'update';
  /** Fields that differ from the destination (`title`, `contentBody.subjectLine`, `.html`). */
  changes?: string[];
  /** Components this one references that the same deploy creates first (`type:ApiName`). */
  dependencies?: string[];
  /** Code of the reason for blocked, failed, unknown or not-attempted. */
  reason?: string;
  /**
   * Folders of folderPath that a create needs: `create` in preview (and in a blocked run),
   * `created` with the new folder ID once the deploy created it.
   */
  folders?: Array<{ path: string; outcome: 'create' | 'created'; id?: string }>;
  /** Local `<ApiName>.<type>.json`. */
  path: string;
  managedContentId?: string;
  variantId?: string;
  contentKey?: string;
};

/** Result of a deploy run. */
export type DeployResult = {
  workspace: { id: string; apiName: string | null };
  preview: boolean;
  items: DeployedItem[];
};

/** Options of one deploy run. */
export type DeployOptions = {
  preview: boolean;
  diagnostics: Diagnostics;
  /** Write transport options (tests pass `allowCallerConnection`). */
  writeOptions?: JsonMutationOptions;
};

type Planned = {
  source: SelectedSource;
  item: DeployedItem;
  payload?: DeployPayload;
};

type UpdateBuilder = (
  input: Record<string, unknown>,
  filename: string,
  bytes: Uint8Array,
  options: { mimeType?: string },
) => MultipartBody;

/** Multipart variant-update body per media type (per-type default part MIME type). */
const MEDIA_UPDATE_BUILDERS: Readonly<Record<string, UpdateBuilder>> = {
  sfdc_cms__image: buildImageUpdateMultipart,
  sfdc_cms__document: buildDocumentUpdateMultipart,
  sfdc_cms__audio: buildAudioUpdateMultipart as UpdateBuilder,
};

/**
 * The envelope of a create/update. A title or urlName the file holds only in the body
 * (`sfdc_cms:title`, `sfdc_cms:urlName`, which win on create) is filled from there.
 * @param {DeployPayload} payload - Payload as the files say.
 * @param {Record<string, unknown>} contentBody - Body to send.
 * @returns {Record<string, string>} apiName, title, urlName.
 */
export function envelopeOf(
  payload: DeployPayload,
  contentBody: Record<string, unknown>,
): Record<string, string> {
  const envelope: Record<string, string> = { apiName: payload.apiName };
  for (const key of ['title', 'urlName'] as const) {
    const value = payload[key] ?? contentBody[BODY_ENVELOPE_FIELDS[key]];
    if (typeof value === 'string') envelope[key] = value;
  }
  return envelope;
}

const referenceKey = (reference: LogicalReference): string =>
  `${reference.type}:${reference.apiName}`;

function sortedJson(value: unknown): string {
  return JSON.stringify(value, (_key, child: unknown) =>
    isRecord(child)
      ? Object.fromEntries(
          Object.keys(child)
            .toSorted()
            .map((key) => [key, child[key]]),
        )
      : child,
  );
}

function digest(content: string | Uint8Array): string {
  return createHash('sha256').update(content).digest('hex');
}

/**
 * Fields in which two component file sets differ: envelope keys, body keys as
 * `contentBody.<key>`, companions by suffix (byte hash). The folder path is not compared:
 * deploy does not move components.
 * @param {SourceFiles} local - Files on disk.
 * @param {SourceFiles} destination - Destination projected through `toSource`.
 * @returns {string[]} Differing fields, sorted; [] = unchanged.
 */
export function sourceDifferences(local: SourceFiles, destination: SourceFiles): string[] {
  const changes: string[] = [];
  const compare = (
    prefix: string,
    left: Record<string, unknown>,
    right: Record<string, unknown>,
  ): void => {
    for (const key of new Set([...Object.keys(left), ...Object.keys(right)]))
      if (sortedJson(left[key]) !== sortedJson(right[key])) changes.push(`${prefix}${key}`);
  };
  const envelopeOf = (document: SourceFiles['document']): Record<string, unknown> =>
    Object.fromEntries(
      Object.entries(document).filter(([key]) => key !== 'contentBody' && key !== 'folderPath'),
    );
  const localBody = local.document.contentBody;
  const destinationBody = destination.document.contentBody;
  const localEnvelope = envelopeOf(local.document);
  const destinationEnvelope = envelopeOf(destination.document);
  compare('', localEnvelope, destinationEnvelope);
  compare('contentBody.', localBody, destinationBody);
  for (const suffix of new Set([
    ...Object.keys(local.companions),
    ...Object.keys(destination.companions),
  ])) {
    const left = local.companions[suffix];
    const right = destination.companions[suffix];
    if (left === undefined || right === undefined || digest(left) !== digest(right))
      changes.push(suffix);
  }
  return changes.toSorted();
}

function componentError(error: unknown, component: string): Diagnostic {
  return { ...toDiagnostic(error), component };
}

function warning(code: string, message: string, component: string): Diagnostic {
  return { ...toDiagnostic(new CmsError(code, message)), component };
}

/**
 * Deploy the selected components into one workspace: plan every component (read the
 * destination, compare, resolve folders and references), stop before any write if one is
 * blocked, then write in order, read each written component back once and compare. Stops on
 * the first failure; a write whose answer never came is `unknown` and never repeated. Only the
 * destination's default variant is written. `preview` stops after the plan. Components are
 * planned and written referenced-first (`dependencyOrder`); a reference cycle is refused
 * (`DEPENDENCY_CYCLE`) before any write.
 * @param {RequestConnection & WriteConnection} connection - Org connection.
 * @param {CmsWorkspace} workspace - Destination workspace.
 * @param {SelectedSource[]} selected - Selected components.
 * @param {DeployOptions} options - Preview flag, diagnostics, write options.
 * @returns {Promise<DeployedItem[]>} One item per component, in order.
 */
export async function deployComponents(
  connection: RequestConnection & WriteConnection,
  workspace: CmsWorkspace,
  selected: SelectedSource[],
  options: DeployOptions,
): Promise<DeployedItem[]> {
  const { diagnostics } = options;
  const sources = dependencyOrder(selected, { workspace });
  const folderPath = folderPathCache(connection, workspace);
  const folders = folderPlanner(connection, workspace);
  const references = referenceResolver(connection, workspace);
  const records = recordResolver(connection);
  // Destination record ID per `sobject:name`, filled while planning.
  const recordIds = new Map<string, string>();
  // Destination content key per `type:ApiName` (null = absent); filled by lookups and creates.
  const destinationKeys = new Map<string, string | null>();
  const inventories = new Map<ContentTypeHandler, Map<string, InventoryItem>>();

  const loadKeys = async (wanted: LogicalReference[]): Promise<void> => {
    const byType = new Map<string, string[]>();
    for (const reference of wanted)
      if (!destinationKeys.has(referenceKey(reference)))
        byType.set(reference.type, [...(byType.get(reference.type) ?? []), reference.apiName]);
    for (const [type, names] of byType) {
      for (const name of names) destinationKeys.set(`${type}:${name}`, null);
      for (const found of await inventoryOf(connection, workspace, contentTypeOf(type), names))
        destinationKeys.set(`${type}:${found.apiName}`, found.contentKey);
    }
  };

  const project = async (
    handler: ContentTypeHandler,
    native: NativeVariant,
  ): Promise<{ files: SourceFiles; folderPath: string[] }> => {
    const declarations = handler.referenceDeclarations;
    await references.load(
      referencedContentKeys(native.contentBody, referenceFormsOf(declarations)),
    );
    await records.loadNames(recordIdsOf(native.contentBody, declarations?.records ?? []));
    const path = await folderPath(isRecord(native.folder) ? String(native.folder.id) : undefined);
    const media = await mediaOf(connection, handler, native);
    // Keys outside the workspace stay native keys; the comparison shows them as changes.
    const files = handler.toSource(native, {
      ...(media ? { media } : {}),
      workspace,
      folderPath: path,
      referenceOf: references.referenceOf,
      recordNameOf: records.nameOf,
      warn: () => {},
    });
    return { files, folderPath: path };
  };

  const readVariant = async (variantId: string): Promise<NativeVariant> => {
    const { data } = await requestJson<unknown>(connection, getSelectedOperation('variant.get'), {
      path: { variantId },
    });
    if (!isRecord(data))
      throw new CmsError('UNEXPECTED_RESPONSE', `Variant ${variantId} is not an object`);
    return data as NativeVariant;
  };

  // Plan.
  const plans: Planned[] = [];
  const plannedCreates = new Set<string>();
  for (const source of sources) {
    const { handler, apiName, files } = source;
    const component = `${handler.type}:${apiName}`;
    const item: DeployedItem = {
      type: handler.type,
      apiName,
      outcome: 'blocked',
      path: source.path,
    };
    const plan: Planned = { source, item };
    plans.push(plan);
    try {
      const payload = handler.fromSource(files, { workspace });
      plan.payload = payload;
      let inventory = inventories.get(handler);
      if (!inventory) {
        const names = sources.filter((s) => s.handler === handler).map((s) => s.apiName);
        const found = await inventoryOf(connection, workspace, handler.apiName, names);
        inventory = new Map(found.map((entry) => [entry.apiName, entry]));
        inventories.set(handler, inventory);
      }
      const target = inventory.get(apiName);
      let action: 'create' | 'update';
      if (target) {
        const defaultVariant = target.defaultVariant;
        if (!defaultVariant)
          throw new CmsError(
            'NO_DEFAULT_VARIANT',
            `None of the destination variants (${target.otherVariants.map((v) => v.language ?? v.name).join(', ')}) is primary or in ${workspace.defaultLanguage ?? 'the default language'}`,
          );
        Object.assign(item, {
          managedContentId: target.managedContentId,
          variantId: defaultVariant.id,
          ...(target.contentKey ? { contentKey: target.contentKey } : {}),
        });
        destinationKeys.set(component, target.contentKey);
        if (target.otherVariants.length > 0)
          diagnostics.warnings.push(
            warning(
              'OTHER_VARIANTS_SKIPPED',
              `Compared and deploys the default variant (${defaultVariant.language ?? 'default'}) only; left as they are: ${target.otherVariants.map((v) => v.language ?? v.name ?? v.id).join(', ')}`,
              component,
            ),
          );
        const destination = await project(handler, await readVariant(defaultVariant.id));
        if (destination.folderPath.join('/') !== payload.folderPath.join('/'))
          diagnostics.warnings.push(
            warning(
              'FOLDER_NOT_MOVED',
              `The file says /${payload.folderPath.join('/')}; the component stays in /${destination.folderPath.join('/')}`,
              component,
            ),
          );
        const changes = sourceDifferences(files, destination.files);
        if (changes.length === 0) {
          item.outcome = 'unchanged';
          continue;
        }
        item.changes = changes;
        action = 'update';
      } else {
        const { missing } = await folders.plan(payload.folderPath);
        const existing = payload.folderPath.length - missing.length;
        if (missing.length > 0)
          item.folders = missing.map((_, index) => ({
            path: `/${payload.folderPath.slice(0, existing + index + 1).join('/')}`,
            outcome: 'create',
          }));
        action = 'create';
      }
      const wanted = handler.references(payload).filter((r) => referenceKey(r) !== component);
      await loadKeys(wanted);
      const missing = wanted.filter((r) => !destinationKeys.get(referenceKey(r)));
      const unresolved = missing.filter((r) => !plannedCreates.has(referenceKey(r)));
      if (unresolved.length > 0)
        throw new CmsError(
          'REFERENCE_NOT_IN_DESTINATION',
          `References ${unresolved.map((r) => referenceKey(r)).join(', ')}, which workspace ${workspace.apiName ?? workspace.id} does not have`,
        );
      for (const reference of recordReferences(
        payload.contentBody,
        handler.referenceDeclarations?.records ?? [],
      )) {
        const label = `${reference.sobject} "${reference.name}" (contentBody.${reference.path.join('.')})`;
        const found = await records.idsOf(reference);
        if (found.length === 0)
          throw new CmsError(
            'RECORD_REFERENCE_NOT_FOUND',
            `References ${label}, which the destination org does not have`,
          );
        if (found.length > 1)
          throw new CmsError(
            'RECORD_REFERENCE_AMBIGUOUS',
            `References ${label}, which matches more than one record in the destination org`,
          );
        recordIds.set(`${reference.sobject}:${reference.name}`, found[0]);
      }
      const graphBlocks = await checkDataGraphReferences(
        connection,
        dataGraphReferences(payload.contentBody),
      );
      if (graphBlocks.length > 0)
        throw new CmsError(
          graphBlocks[0].code,
          graphBlocks.map((block) => block.message).join('; '),
        );
      if (action === 'create') plannedCreates.add(component);
      if (missing.length > 0) {
        item.outcome = 'planned-dependencies';
        item.action = action;
        item.dependencies = missing.map((r) => referenceKey(r));
      } else item.outcome = action;
    } catch (error) {
      item.outcome = 'blocked';
      item.reason = toDiagnostic(error).code;
      diagnostics.errors.push(componentError(error, component));
    }
  }
  const items = plans.map((plan) => plan.item);
  if (options.preview) return items;
  if (items.some((item) => item.outcome === 'blocked')) {
    for (const item of items)
      if (item.outcome !== 'blocked' && item.outcome !== 'unchanged')
        Object.assign(item, { outcome: 'not-attempted', reason: 'DEPLOY_BLOCKED' });
    return items;
  }

  // Write.
  let stopped = false;
  for (const { source, item, payload } of plans) {
    if (item.outcome === 'unchanged') continue;
    if (stopped) {
      Object.assign(item, { outcome: 'not-attempted', reason: 'NOT_ATTEMPTED' });
      continue;
    }
    const { handler } = source;
    const component = `${handler.type}:${source.apiName}`;
    const action = item.outcome === 'planned-dependencies' ? item.action! : item.outcome;
    let written = false;
    try {
      const declarations = handler.referenceDeclarations;
      const contentBody = resolveRecordReferences(
        resolveReferences(
          payload!.contentBody,
          (reference) => {
            const key = destinationKeys.get(referenceKey(reference));
            if (!key)
              throw new CmsError(
                'REFERENCE_NOT_IN_DESTINATION',
                `${referenceKey(reference)} was not created before ${component}`,
              );
            return key;
          },
          referenceFormsOf(declarations),
        ) as Record<string, unknown>,
        declarations?.records ?? [],
        (reference) => recordIds.get(`${reference.sobject}:${reference.name}`)!,
      );
      const envelope = envelopeOf(payload!, contentBody);
      const { file } = payload!;
      let createFolder: string | undefined;
      if (action === 'create') {
        const created: CreatedFolder[] = [];
        try {
          createFolder = await folders.ensure(payload!.folderPath, created, options.writeOptions);
        } finally {
          if (created.length > 0)
            item.folders = created.map((folder) => ({ ...folder, outcome: 'created' }));
          else delete item.folders;
        }
      }
      let response: unknown;
      if (file && action === 'create') {
        response = await createMediaContent(
          handler.apiName as MediaContentType,
          connection,
          {
            contentSpaceOrFolderId: createFolder!,
            ...envelope,
            contentBody,
            ...payload!.createOnly,
          },
          file.fileName,
          file.bytes,
          file.mimeType === undefined ? {} : { mimeType: file.mimeType },
        );
      } else if (file) {
        const build = MEDIA_UPDATE_BUILDERS[handler.apiName] ?? buildImageUpdateMultipart;
        response = await sendVariantUpdateMultipart(
          connection,
          item.variantId!,
          build(
            { ...envelope, contentBody },
            file.fileName,
            file.bytes,
            file.mimeType === undefined ? {} : { mimeType: file.mimeType },
          ),
        );
      } else if (action === 'create') {
        ({ data: response } = await requestJsonMutation<unknown>(
          connection,
          getSelectedOperation('content.create'),
          {
            contentType: handler.apiName,
            contentSpaceOrFolderId: createFolder!,
            ...envelope,
            contentBody,
            ...payload!.createOnly,
          },
          {},
          options.writeOptions,
        ));
      } else {
        ({ data: response } = await requestJsonMutation<unknown>(
          connection,
          getSelectedOperation('variant.update'),
          { ...envelope, contentBody },
          { path: { variantId: item.variantId! } },
          options.writeOptions,
        ));
      }
      written = true;
      item.outcome = action === 'create' ? 'created' : 'updated';
      delete item.action;
      if (!isRecord(response) || typeof response.managedContentVariantId !== 'string')
        throw new CmsError(
          'UNEXPECTED_RESPONSE',
          `${action} answered without a variant ID; check the component in the org`,
        );
      Object.assign(item, {
        managedContentId: String(response.managedContentId),
        variantId: response.managedContentVariantId,
        ...(typeof response.contentKey === 'string' ? { contentKey: response.contentKey } : {}),
      });
      if (typeof response.contentKey === 'string')
        destinationKeys.set(component, response.contentKey);
      const readback = await project(handler, await readVariant(item.variantId!));
      const differences = sourceDifferences(source.files, readback.files);
      if (differences.length > 0)
        diagnostics.warnings.push(
          warning(
            'READBACK_DIFFERS',
            `After the ${action}, Salesforce holds different values in: ${differences.join(', ')}`,
            component,
          ),
        );
    } catch (error) {
      stopped = true;
      const diagnostic = componentError(error, component);
      if (!written) {
        const unknown =
          error instanceof CmsRequestError && error.requestSent && !error.statusObserved;
        item.outcome = unknown ? 'unknown' : 'failed';
        item.reason = unknown ? 'UNKNOWN_OUTCOME' : diagnostic.code;
        delete item.action;
        if (unknown) {
          diagnostic.code = 'UNKNOWN_OUTCOME';
          diagnostic.hint = toDiagnostic(new CmsError('UNKNOWN_OUTCOME', '')).hint;
        }
      }
      diagnostics.errors.push(diagnostic);
    }
  }
  return items;
}
