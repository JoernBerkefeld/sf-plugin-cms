import path from 'node:path';
import { Flags } from '@salesforce/sf-plugins-core';
import { CmsCommand, orgFlags, type CmsResult } from './command-base.js';
import {
  parseExactSelection,
  runLifecycle,
  type LifecycleAction,
  type LifecycleResult,
  type LifecycleTarget,
} from './services/lifecycle.js';
import { resolveWorkspace } from './services/workspaces.js';
import type { JsonMutationOptions } from './transport/json-mutation.js';

/** Flags shared by delete, publish and unpublish. */
export const lifecycleFlags = {
  ...orgFlags,
  metadata: Flags.string({
    char: 'm',
    multiple: true,
    summary: 'Component as type:ApiName (exact; a bare type or a wildcard is refused).',
  }),
  'source-dir': Flags.string({
    char: 'd',
    multiple: true,
    summary: 'Component file cms/<workspace>/<type>/<ApiName>.<type>.json (or a companion).',
  }),
  workspace: Flags.string({
    required: true,
    summary: 'Workspace API name or ID (see sf cms list workspace).',
  }),
  preview: Flags.boolean({
    summary: 'Report what the command would do; change nothing in the org or in local files.',
    default: false,
  }),
};

type LifecycleFlags = {
  metadata?: string[];
  'source-dir'?: string[];
  workspace: string;
  preview: boolean;
  'keep-local-files'?: boolean;
  'target-org'?: string;
  'api-version': string;
};

/** Base of `sf cms delete | publish | unpublish`. */
export abstract class LifecycleCommand extends CmsCommand<LifecycleResult> {
  /** Write transport options; tests replace this to use their fake connection. */
  protected writeOptions: JsonMutationOptions = {};

  protected async runAction(
    action: LifecycleAction,
    flags: LifecycleFlags,
  ): Promise<CmsResult<LifecycleResult>> {
    const projectDirectory = process.cwd();
    let targets: LifecycleTarget[] = [];
    const envelope = await this.withOrg(
      `cms ${action}`,
      flags,
      { workspace: { id: '', apiName: null }, preview: flags.preview, items: [] },
      async (org, result) => {
        const workspace = await resolveWorkspace(org.connection, flags.workspace);
        const outcome: LifecycleResult = {
          workspace: { id: workspace.id, apiName: workspace.apiName },
          preview: flags.preview,
          items: [],
        };
        result.result = outcome;
        outcome.items = await runLifecycle(org.connection, workspace, action, targets, {
          preview: flags.preview,
          diagnostics: result.diagnostics,
          keepLocalFiles: flags['keep-local-files'],
          projectDirectory,
          writeOptions: this.writeOptions,
          onPlanned: (items) => {
            outcome.items = items;
          },
        });
        return outcome;
      },
      async () => {
        targets = await parseExactSelection(flags.metadata, flags['source-dir'], action);
      },
    );
    for (const item of envelope.result.items) {
      this.log(
        `${item.outcome} ${item.type}:${item.apiName}${item.reason ? ` (${item.reason})` : ''}`,
      );
      if (item.note) this.log(`  note: ${item.note}`);
      for (const file of item.localFiles ?? [])
        this.log(
          `  would remove ${path.relative(projectDirectory, file.path)}${file.exists ? '' : ' (not present)'}`,
        );
      for (const file of item.removedLocalFiles ?? [])
        this.log(`  ${file.outcome} ${path.relative(projectDirectory, file.path)}`);
    }
    this.log(
      `${action[0].toUpperCase()}${action.slice(1)}${flags.preview ? ' preview' : ''}: ${envelope.status}; ${envelope.result.items.length} component(s), ${envelope.diagnostics.errors.length} error(s).`,
    );
    return envelope;
  }
}
