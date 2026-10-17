import path from 'node:path';
import { Flags } from '@salesforce/sf-plugins-core';
import { getCmsApiSelection } from '../../../api-policy.js';
import { apiVersionFlag, CmsCommand, targetOrgFlag } from '../../../command-base.js';
import { type CmsEnvelope, type CmsStatus } from '../../../contracts/shared.js';
import { prepareEditableSourceSelection } from '../../../services/retrieve-item-source.js';
import type { NativeRetrieveResolution } from '../../../services/retrieve-native-resolution.js';
import {
  normalizeRetrieveSelection,
  type RetrieveSelection,
} from '../../../services/retrieve-selection.js';
import {
  writeEditableItemSource,
  type ItemSourceWriteReceipt,
} from '../../../services/write-item-source.js';
import { assertWorkspaceSelector, resolveWorkspace } from '../../../services/resolve-workspace.js';

type Identity = {
  contentType: string;
  apiName: string | null;
  language: string | null;
  selector?: string;
  selectorKind?: 'api-name' | 'content-key-or-id' | 'all';
  variantId?: string;
};
export type RetrieveContentResult = {
  scope: {
    targetOrg: string;
    workspaceId: string | null;
    workspaceName: string | null;
    language: string | null;
    defaultLanguage: boolean;
    outputDir: string;
  };
  selection: { contentTypes: string[]; apiNames: string[]; groups?: RetrieveSelection['groups'] };
  resolution?: Pick<NativeRetrieveResolution, 'inventory' | 'unresolved'>;
  items: Array<{
    identity: Identity;
    operation: 'retrieve';
    outcome: 'retrieved' | 'unchanged' | 'blocked';
    paths: ItemSourceWriteReceipt | null;
    evidence: { variantId: string; contentId: string } | null;
    diagnostics: string[];
  }>;
  summary: {
    selected: number;
    retrieved: number;
    unchanged: number;
    blocked: number;
    unattempted: number;
  };
  unattempted: Identity[];
};

export default class RetrieveContent extends CmsCommand<CmsEnvelope<RetrieveContentResult>> {
  public static readonly summary =
    'Retrieve selected editable Emails, Email Templates, Images and Documents into an explicit local project.';
  public static readonly description =
    'Select Email, Email Template, Image or Document types by exact API names, native content keys/parent IDs, all-of-type, or repeatable metadata Type[:ApiName]. Metadata is exclusive of separate selectors. Resolves complete native inventory before local writes; each supported root-level, single-variant item is acquired independently. Writes portable Email JSON and HTML/text companions or media JSON with downloaded Image or UTF-8 text/plain Document bytes. Document deployment remains blocked. External media remains explicitly URL-only. Differing local files require --overwrite. Retrieval never mutates the org. Portable Image deployment admits binary Image sources with safe MIME and paths; Salesforce determines format and size acceptance, with live qualification pending. URL-only sources and Documents are not deployable.';
  public static readonly examples = [
    '<%= config.bin %> cms retrieve content -o my-org -W Marketing -t sfdc_cms__email -n Welcome -L -d ./project --json',
    '<%= config.bin %> cms retrieve content -o my-org -w 0ZuSOURCE -t sfdc_cms__email -i CONTENT_KEY -l en_US -d ./project -x',
    '<%= config.bin %> cms retrieve content -o my-org -W Marketing -m sfdc_cms__email -m sfdc_cms__emailTemplate:Welcome_Template -L -d ./project --json',
  ];
  public static readonly flags = {
    'target-org': targetOrgFlag,
    'api-version': apiVersionFlag,
    'workspace-id': Flags.string({
      char: 'w',
      summary: 'Exact source workspace ID; choose ID or name.',
    }),
    'workspace-name': Flags.string({
      char: 'W',
      summary: 'Exact case-insensitive source workspace name; choose ID or name.',
    }),
    'content-type': Flags.string({
      char: 't',
      multiple: true,
      multipleNonGreedy: true,
      summary:
        'sfdc_cms__email, sfdc_cms__emailTemplate, sfdc_cms__image or sfdc_cms__document; repeat for --all.',
    }),
    'api-name': Flags.string({
      char: 'n',
      multiple: true,
      multipleNonGreedy: true,
      summary: 'Exact API name; repeat within one qualified content type.',
    }),
    'content-key-or-id': Flags.string({
      char: 'i',
      multiple: true,
      multipleNonGreedy: true,
      summary: 'Exact native content key or parent ID (not variant ID); repeat within one type.',
    }),
    metadata: Flags.string({
      char: 'm',
      multiple: true,
      multipleNonGreedy: true,
      summary: 'Qualified Type or Type:ApiName; repeat. Exclusive of separate selection flags.',
    }),
    all: Flags.boolean({
      char: 'a',
      summary: 'Retrieve all items of the explicitly selected types.',
    }),
    language: Flags.string({
      char: 'l',
      summary: 'Explicit language; choose this or --default-language.',
    }),
    'default-language': Flags.boolean({
      char: 'L',
      default: false,
      summary: 'Explicitly select the workspace default language.',
    }),
    'output-dir': Flags.directory({
      char: 'd',
      required: true,
      exists: false,
      summary: 'Explicit project root for selected JSON and companions.',
    }),
    overwrite: Flags.boolean({
      char: 'x',
      default: false,
      summary: 'Permit replacing differing files owned by each selected item.',
    }),
  };

  protected prepareSources = prepareEditableSourceSelection;
  protected writeSource = writeEditableItemSource;
  protected resolveSourceWorkspace = resolveWorkspace;

  public async run(): Promise<CmsEnvelope<RetrieveContentResult>> {
    const { flags } = await this.parse(RetrieveContent);
    let orgId = 'unresolved-org';
    const result: RetrieveContentResult = {
      scope: {
        targetOrg: flags['target-org'],
        workspaceId: flags['workspace-id'] ?? null,
        workspaceName: flags['workspace-name'] ?? null,
        language: flags.language ?? null,
        defaultLanguage: flags['default-language'],
        outputDir: path.resolve(flags['output-dir']),
      },
      selection: { contentTypes: [], apiNames: [] },
      items: [],
      summary: { selected: 0, retrieved: 0, unchanged: 0, blocked: 0, unattempted: 0 },
      unattempted: [],
    };
    const finish = (
      status: CmsStatus,
      code?: string,
      message?: string,
    ): CmsEnvelope<RetrieveContentResult> => {
      result.summary.unattempted = result.unattempted.length;
      const envelope: CmsEnvelope<RetrieveContentResult> = {
        contract: 'sf-cms-content-retrieve',
        contractVersion: '1.0.0',
        status,
        metadata: {
          operation: 'content.retrieve',
          plugin: { name: 'sf-plugin-cms', version: this.pluginVersion },
          apiVersion: flags['api-version'],
        },
        provenance: {
          producer: 'sf-plugin-cms',
          sourceOrgId: orgId,
          pluginVersion: this.pluginVersion,
          command: 'sf cms retrieve content',
          generatedAt: new Date().toISOString(),
        },
        diagnostics: {
          warnings: [],
          errors: code ? [{ code, message: message!, retryable: false }] : [],
        },
        result,
      };
      if (!this.jsonEnabled()) {
        this.log(
          `Retrieve: ${status}; retrieved ${result.summary.retrieved}, unchanged ${result.summary.unchanged}, blocked ${result.summary.blocked}, unattempted ${result.summary.unattempted}.`,
        );
        for (const item of result.items)
          if (item.paths) this.log(`Definition: ${item.paths.definitionPath}`);
        if (message) this.log(message);
      }
      return this.finishEnvelope(envelope, assertRetrieveContentResult);
    };
    let selection: RetrieveSelection;
    try {
      assertWorkspaceSelector({
        workspaceId: flags['workspace-id'],
        workspaceName: flags['workspace-name'],
      });
      if (
        !flags['target-org'].trim() ||
        !flags['output-dir'].trim() ||
        flags.language?.trim() === '' ||
        flags['workspace-id']?.trim() === '' ||
        flags['workspace-name']?.trim() === ''
      )
        throw new Error('empty selector');
      if ((flags.language !== undefined) === flags['default-language'])
        throw new Error('language selector');
      selection = normalizeRetrieveSelection(flags);
    } catch {
      return finish(
        'blocked',
        'RETRIEVE_SELECTION_INVALID',
        'Specify an explicit org/output, one workspace ID/name and one language/default-language choice. Use supported Email/Email Template/Image/Document types with exactly one selection mode; metadata is exclusive of separate selectors.',
      );
    }
    result.selection = {
      contentTypes: selection.groups.map((group) => group.contentType),
      apiNames: selection.groups.flatMap((group) => group.apiNames),
      ...(selection.mode === 'api-name' ? {} : { groups: structuredClone(selection.groups) }),
    };
    result.unattempted = selection.groups.flatMap((group) => [
      ...group.apiNames.map((apiName) => ({
        contentType: group.contentType,
        apiName,
        language: result.scope.language,
      })),
      ...group.contentKeysOrIds.map((selector) => ({
        contentType: group.contentType,
        apiName: null,
        language: result.scope.language,
        selector,
        selectorKind: 'content-key-or-id' as const,
      })),
      ...(group.all
        ? [
            {
              contentType: group.contentType,
              apiName: null,
              language: result.scope.language,
              selectorKind: 'all' as const,
            },
          ]
        : []),
    ]);
    result.summary.selected = result.unattempted.length;
    let stage: 'scope' | 'resolution' = 'scope';
    let prepared: Awaited<ReturnType<typeof prepareEditableSourceSelection>>;
    try {
      const context = await this.getOrgContext(flags['target-org'], flags['api-version']);
      orgId = context.orgId;
      if (flags['api-version'] === 'latest')
        flags['api-version'] = getCmsApiSelection(context.connection).effectiveApiVersion;
      const workspace = await this.resolveSourceWorkspace(context.connection, {
        workspaceId: flags['workspace-id'],
        workspaceName: flags['workspace-name'],
      });
      result.scope.workspaceId = workspace.id;
      const language = flags.language ?? workspace.workspace.defaultLanguage;
      if (typeof language !== 'string' || !language.trim())
        throw new TypeError('Workspace default language unavailable');
      result.scope.language = language;
      for (const identity of result.unattempted) identity.language = language;
      stage = 'resolution';
      prepared = await this.prepareSources(context.connection, {
        workspaceId: workspace.id,
        language,
        selection,
      });
    } catch {
      return finish(
        'blocked',
        stage === 'scope' ? 'RETRIEVE_SCOPE_BLOCKED' : 'RETRIEVE_RESOLUTION_BLOCKED',
        'Cannot prove the explicit org/workspace/language or complete native selection. No local write was attempted.',
      );
    }
    const { resolution } = prepared;
    result.resolution = { inventory: resolution.inventory, unresolved: resolution.unresolved };
    result.summary.selected = resolution.variants.length + resolution.unresolved.length;
    result.unattempted = resolution.variants.map((row) => ({
      contentType: row.ContentTypeFullyQualifiedName,
      apiName: row.ManagedContent.ApiName,
      language: row.Language,
      ...(selection.mode !== 'api-name' ||
      resolution.variants.length !== 1 ||
      row.ManagedContent.ApiName === null
        ? { variantId: row.Id }
        : {}),
    }));
    for (const unresolved of resolution.unresolved) {
      result.items.push({
        identity: {
          contentType: unresolved.contentType,
          apiName: unresolved.kind === 'api-name' ? unresolved.selector : null,
          language: resolution.language,
          selector: unresolved.selector,
          selectorKind: unresolved.kind,
        },
        operation: 'retrieve',
        outcome: 'blocked',
        paths: null,
        evidence: null,
        diagnostics: [`RETRIEVE_SELECTOR_${unresolved.reason.toUpperCase()}`],
      });
      result.summary.blocked += 1;
    }
    // Distinct native parents must never compete for one portable output identity,
    // even when overwrite is enabled or their eventual projections are identical.
    const parentsByIdentity = new Map<string, Set<string>>();
    for (const row of resolution.variants) {
      const key = portableKey(row);
      const parents = parentsByIdentity.get(key) ?? new Set<string>();
      parents.add(row.ManagedContentId);
      parentsByIdentity.set(key, parents);
    }
    const collidingVariants = new Set<string>();
    for (const [index, row] of resolution.variants.entries()) {
      if (parentsByIdentity.get(portableKey(row))!.size < 2) continue;
      collidingVariants.add(row.Id);
      result.items.push({
        identity: result.unattempted[index],
        operation: 'retrieve',
        outcome: 'blocked',
        paths: null,
        evidence: { variantId: row.Id, contentId: row.ManagedContentId },
        diagnostics: ['RETRIEVE_PORTABLE_IDENTITY_COLLISION'],
      });
      result.summary.blocked += 1;
    }
    result.unattempted = result.unattempted.filter(
      (_, index) => !collidingVariants.has(resolution.variants[index].Id),
    );
    let fatal = false;
    for (const row of resolution.variants) {
      if (collidingVariants.has(row.Id)) continue;
      const identity = result.unattempted.shift()!;
      const item: RetrieveContentResult['items'][number] = {
        identity,
        operation: 'retrieve',
        outcome: 'blocked',
        paths: null,
        evidence: { variantId: row.Id, contentId: row.ManagedContentId },
        diagnostics: [],
      };
      result.items.push(item);
      let writing = false;
      try {
        const source = await prepared.acquire(row.Id);
        item.evidence = source.evidence;
        writing = true;
        item.paths = await this.writeSource(
          flags['output-dir'],
          source.directory,
          source.projection,
          flags.overwrite,
        );
        const changed =
          item.paths.created.length + item.paths.updated.length + item.paths.removed.length > 0;
        item.outcome = changed ? 'retrieved' : 'unchanged';
        result.summary[item.outcome] += 1;
      } catch (error) {
        item.diagnostics.push(writing ? 'RETRIEVE_WRITE_BLOCKED' : 'RETRIEVE_SOURCE_BLOCKED');
        result.summary.blocked += 1;
        if (!writing && fatalReadFailure(error)) {
          fatal = true;
          break;
        }
      }
    }
    const completed = result.summary.retrieved + result.summary.unchanged;
    if (result.summary.blocked === 0 && !fatal) return finish('success');
    return finish(
      completed > 0 ? 'partial' : 'blocked',
      fatal ? 'RETRIEVE_SCOPE_BLOCKED' : 'RETRIEVE_ITEMS_BLOCKED',
      'Some selections could not be retrieved. Inspect per-item diagnostics and unattempted identities. Local I/O failure can leave partial local progress; no org mutation occurred.',
    );
  }
}

function portableKey(row: NativeRetrieveResolution['variants'][number]): string {
  return JSON.stringify([
    row.ContentTypeFullyQualifiedName,
    row.ManagedContent.ApiName,
    row.Language,
  ]);
}

function fatalReadFailure(error: unknown): boolean {
  if (error === null || typeof error !== 'object') return false;
  const observed = error as { status?: number; statusCode?: number; errorCode?: string };
  return (
    [401, 403].includes(observed.status ?? observed.statusCode ?? 0) ||
    [
      'INVALID_SESSION_ID',
      'INSUFFICIENT_ACCESS',
      'INSUFFICIENT_ACCESS_OR_READONLY',
      'API_DISABLED_FOR_ORG',
    ].includes(observed.errorCode ?? '')
  );
}

function assertRetrieveContentResult(value: unknown): asserts value is RetrieveContentResult {
  if (
    value === null ||
    typeof value !== 'object' ||
    !('items' in value) ||
    !Array.isArray(value.items)
  )
    throw new TypeError('Invalid retrieve result');
}
