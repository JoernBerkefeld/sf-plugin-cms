import type { CmsResult } from '../../command-base.js';
import { HANDLERS } from '../../content/registry.js';
import { LifecycleCommand, lifecycleFlags } from '../../lifecycle-command.js';
import type { LifecycleResult } from '../../services/lifecycle.js';

export default class Unpublish extends LifecycleCommand {
  public static readonly summary = 'Unpublish named CMS components of one workspace.';
  public static readonly description = `Unpublishes the default variant of each named component in the workspace's context and reads the publish state back. The request is always sent; Salesforce's answer is reported. Types: ${HANDLERS.map((handler) => handler.type).join(', ')}.`;
  public static readonly examples = [
    '<%= config.bin %> <%= command.id %> -m email:Welcome_Email --workspace Default_Content_Workspace -o my-org',
  ];
  public static readonly flags = lifecycleFlags;

  public async run(): Promise<CmsResult<LifecycleResult>> {
    const { flags } = await this.parse(Unpublish);
    return this.runAction('unpublish', flags);
  }
}
