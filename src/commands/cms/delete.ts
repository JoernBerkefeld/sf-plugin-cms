import { Flags } from '@salesforce/sf-plugins-core';
import type { CmsResult } from '../../command-base.js';
import { HANDLERS } from '../../content/registry.js';
import { LifecycleCommand, lifecycleFlags } from '../../lifecycle-command.js';
import type { LifecycleResult } from '../../services/lifecycle.js';

export default class Delete extends LifecycleCommand {
  public static readonly summary = 'Delete named CMS components from one workspace.';
  public static readonly description = `Deletes each named component and confirms it by reading it back; a component the workspace does not have reports unchanged. A component with variants besides the default one is refused, because the delete would remove them too. After a confirmed delete the local files at cms/<workspace>/<type>/ are removed unless --keep-local-files is set. Nothing is sent if a component is blocked; the run stops at the first failure. Types: ${HANDLERS.map((handler) => handler.type).join(', ')}.`;
  public static readonly examples = [
    '<%= config.bin %> <%= command.id %> -m email:Welcome_Email --workspace Default_Content_Workspace -o my-org --preview',
    '<%= config.bin %> <%= command.id %> -d cms/Default_Content_Workspace/email/Welcome_Email.email.json --workspace Default_Content_Workspace -o my-org --keep-local-files',
  ];
  public static readonly flags = {
    ...lifecycleFlags,
    'keep-local-files': Flags.boolean({
      summary: 'Keep the local files of deleted components.',
      default: false,
    }),
  };

  public async run(): Promise<CmsResult<LifecycleResult>> {
    const { flags } = await this.parse(Delete);
    return this.runAction('delete', flags);
  }
}
