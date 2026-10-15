import path from 'node:path';
import { Flags } from '@salesforce/sf-plugins-core';
import { apiVersionFlag, CmsCommand, targetOrgFlag } from '../../../command-base.js';
import { type CmsEnvelope, type CmsStatus } from '../../../contracts/shared.js';
import { acquireEditableEmailSource } from '../../../services/retrieve-item-source.js';
import {
  writeEditableItemSource,
  type ItemSourceWriteReceipt,
} from '../../../services/write-item-source.js';
import { assertWorkspaceSelector, resolveWorkspace } from '../../../services/resolve-workspace.js';

type Identity = { contentType: string; apiName: string; language: string | null };
export type RetrieveContentResult = {
  scope: {
    targetOrg: string;
    workspaceId: string | null;
    workspaceName: string | null;
    language: string | null;
    defaultLanguage: boolean;
    outputDir: string;
  };
  selection: { contentTypes: string[]; apiNames: string[] };
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
  public static readonly summary = 'Retrieve one editable Email into an explicit local project.';
  public static readonly description =
    'Partial developer-workflow checkpoint: only one exact sfdc_cms__email API name, in one explicit workspace and language. Acquires a supported root-level, single-variant Email and writes portable v2 JSON plus HTML/text companions. Differing selected local files require --overwrite. No org mutations or deploy command; Template, native ID, metadata, all-of-type and batch selection are not supported.';
  public static readonly examples = [
    '<%= config.bin %> cms retrieve content --target-org my-org --workspace-name Marketing --content-type sfdc_cms__email --api-name Welcome --default-language --output-dir ./project --json',
    '<%= config.bin %> cms retrieve content -o my-org -w 0ZuSOURCE -t sfdc_cms__email -n Welcome -l en_US -d ./project -x',
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
      required: true,
      multiple: true,
      multipleNonGreedy: true,
      summary: 'Exactly one content type: sfdc_cms__email only.',
    }),
    'api-name': Flags.string({
      char: 'n',
      required: true,
      multiple: true,
      multipleNonGreedy: true,
      summary: 'Exactly one exact Email API name.',
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
      summary: 'Permit replacing differing files owned by this selected item.',
    }),
    metadata: Flags.string({ char: 'm', multiple: true, hidden: true }),
    all: Flags.boolean({ char: 'a', hidden: true }),
    'content-key-or-id': Flags.string({ char: 'i', multiple: true, hidden: true }),
  };

  // Narrow service seams keep command orchestration independently testable.
  protected acquireSource = acquireEditableEmailSource;
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
      selection: { contentTypes: flags['content-type'], apiNames: flags['api-name'] },
      items: [],
      summary: {
        selected: flags['api-name'].length,
        retrieved: 0,
        unchanged: 0,
        blocked: 0,
        unattempted: flags['api-name'].length,
      },
      unattempted: flags['api-name'].map((apiName) => ({
        contentType: flags['content-type'][0],
        apiName,
        language: flags.language ?? null,
      })),
    };
    const finish = (
      status: CmsStatus,
      code?: string,
      message?: string,
    ): CmsEnvelope<RetrieveContentResult> => {
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
    try {
      assertWorkspaceSelector({
        workspaceId: flags['workspace-id'],
        workspaceName: flags['workspace-name'],
      });
      if (
        !flags['target-org'].trim() ||
        !flags['output-dir'].trim() ||
        flags.language?.trim() === '' ||
        flags['api-name'].some((name) => !name.trim())
      )
        throw new Error('empty selector');
      if ((flags.language !== undefined) === flags['default-language'])
        throw new Error('language selector');
    } catch {
      return finish(
        'blocked',
        'RETRIEVE_SELECTION_INVALID',
        'Specify an explicit target org and output directory, exactly one workspace ID/name, and exactly one language/default-language choice with nonempty selectors.',
      );
    }
    if (
      flags.metadata !== undefined ||
      flags.all ||
      flags['content-key-or-id'] !== undefined ||
      flags['content-type'].length !== 1 ||
      flags['api-name'].length !== 1 ||
      flags['content-type'][0] !== 'sfdc_cms__email'
    ) {
      return finish(
        'blocked',
        'RETRIEVE_MODE_UNSUPPORTED',
        'This checkpoint supports one sfdc_cms__email API name only; batch, Template/other types, metadata, all-of-type and native ID modes are not implemented.',
      );
    }
    const identity = result.unattempted[0];
    let stage: 'scope' | 'acquire' | 'write' = 'scope';
    try {
      const context = await this.getOrgContext(flags['target-org'], flags['api-version']);
      orgId = context.orgId;
      const workspace = await this.resolveSourceWorkspace(context.connection, {
        workspaceId: flags['workspace-id'],
        workspaceName: flags['workspace-name'],
      });
      result.scope.workspaceId = workspace.id;
      stage = 'acquire';
      result.unattempted = [];
      result.summary.unattempted = 0;
      const source = await this.acquireSource(context.connection, {
        workspaceId: workspace.id,
        apiName: identity.apiName,
        ...(flags.language === undefined
          ? { useDefaultLanguage: true as const }
          : { language: flags.language }),
      });
      identity.language = source.projection.definition.language;
      result.scope.language = identity.language;
      const item: RetrieveContentResult['items'][number] = {
        identity,
        operation: 'retrieve',
        outcome: 'blocked',
        paths: null,
        evidence: source.evidence,
        diagnostics: [],
      };
      result.items.push(item);
      stage = 'write';
      item.paths = await this.writeSource(
        flags['output-dir'],
        source.directory,
        source.projection,
        flags.overwrite,
      );
      const changed =
        item.paths.created.length + item.paths.updated.length + item.paths.removed.length > 0;
      item.outcome = changed ? 'retrieved' : 'unchanged';
      result.summary[changed ? 'retrieved' : 'unchanged'] = 1;
      return finish('success');
    } catch {
      const code = {
        scope: 'RETRIEVE_SCOPE_BLOCKED',
        acquire: 'RETRIEVE_SOURCE_BLOCKED',
        write: 'RETRIEVE_WRITE_BLOCKED',
      }[stage];
      if (stage !== 'scope') {
        result.summary.blocked = 1;
        if (result.items.length === 0)
          result.items.push({
            identity,
            operation: 'retrieve',
            outcome: 'blocked',
            paths: null,
            evidence: null,
            diagnostics: [],
          });
        result.items[0].diagnostics.push(code);
      }
      return finish(
        'blocked',
        code,
        stage === 'write'
          ? 'Selected local files were not completely written. Check overwrite conflicts, item ownership and filesystem access; an I/O failure can leave partial local progress. No org mutation occurred.'
          : 'Cannot prove the explicit org/workspace or complete supported Email source. Check authentication, exact API name/language, root folder, sibling variants and supported components. No local write was attempted.',
      );
    }
  }
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
