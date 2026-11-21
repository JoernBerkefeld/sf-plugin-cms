import { Org, type Connection } from '@salesforce/core';
import { Flags, SfCommand } from '@salesforce/sf-plugins-core';
import { plugin } from './plugin.js';
import {
  createInvocationLogger,
  enableInvocationApiLogging,
  runWithInvocationLogging,
} from './logging.js';
import { CmsError, formatDiagnostic, toDiagnostic, type Diagnostic } from './errors/registry.js';
import { redactArgv, redactSecrets } from './transport/redact-secrets.js';

export const DEFAULT_API_VERSION = '68.0';

/** The result every command returns (the `result` of `--json`). */
export type CmsResult<R> = {
  status: 'success' | 'failed';
  metadata: {
    command: string;
    apiVersion: string;
    orgId?: string;
    plugin: typeof plugin;
  };
  diagnostics: { warnings: Diagnostic[]; errors: Diagnostic[] };
  result: R;
};

/** The org a command works on. */
export type OrgContext = {
  connection: Connection;
  orgId: string;
  username: string;
};

/** Flags of every org-backed command. */
export const orgFlags = {
  'target-org': Flags.string({
    char: 'o',
    summary: 'Org alias or username; default: the target-org config value.',
  }),
  'api-version': Flags.string({
    summary: `Salesforce API version for CMS requests (default ${DEFAULT_API_VERSION}).`,
    default: DEFAULT_API_VERSION,
  }),
};

/**
 * Base of all `sf cms` commands: one invocation log file per run (`logs/cms/`), the
 * `--api log` opt-in, org resolution and the common result envelope.
 */
export abstract class CmsCommand<R> extends SfCommand<CmsResult<R>> {
  public static baseFlags = {
    ...SfCommand.baseFlags,
    api: Flags.string({
      options: ['log'],
      summary: 'Also write request and response bodies to the invocation log (may hold content).',
      parse: async (value) => {
        if (value === 'log') enableInvocationApiLogging();
        return value;
      },
    }),
  };

  /**
   * Open the org connection. Tests replace this with a fake connection.
   * @param {string | undefined} targetOrg - Alias or username; undefined uses the default.
   * @param {string} apiVersion - Numeric API version.
   * @returns {Promise<OrgContext>} Connection and org identity.
   */
  protected resolveOrg = async (
    targetOrg: string | undefined,
    apiVersion: string,
  ): Promise<OrgContext> => {
    let org: Org;
    try {
      org = await Org.create(targetOrg === undefined ? {} : { aliasOrUsername: targetOrg });
    } catch (error) {
      throw new CmsError(
        targetOrg === undefined ? 'TARGET_ORG_REQUIRED' : 'AUTHENTICATION_FAILED',
        redactSecrets(error instanceof Error ? error.message : String(error)),
      );
    }
    return {
      connection: org.getConnection(apiVersion),
      orgId: org.getOrgId(),
      username: org.getUsername() ?? '',
    };
  };

  public async _run<T>(): Promise<T> {
    const logger = createInvocationLogger({ cwd: process.cwd(), argv: redactArgv(this.argv) });
    try {
      return await runWithInvocationLogging(logger, () => super._run<T>());
    } finally {
      process.stderr.write(`CMS log: ${logger.filePath}\n`);
      await logger.close();
    }
  }

  /**
   * Run the body of an org-backed command inside the common envelope: resolve the org, print
   * the org notice, turn any failure into a diagnostic and set the exit code.
   * @param {string} command - Command name, such as `cms list workspace`.
   * @param {{ 'target-org'?: string; 'api-version': string }} flags - Parsed org flags.
   * @param {R} empty - Result when the body did not finish.
   * @param {(org: OrgContext, result: CmsResult<R>) => Promise<R>} body - Command work.
   * @returns {Promise<CmsResult<R>>} Filled envelope.
   */
  protected async withOrg(
    command: string,
    flags: { 'target-org'?: string; 'api-version': string },
    empty: R,
    body: (org: OrgContext, result: CmsResult<R>) => Promise<R>,
  ): Promise<CmsResult<R>> {
    const envelope: CmsResult<R> = {
      status: 'failed',
      metadata: { command: `sf ${command}`, apiVersion: flags['api-version'], plugin },
      diagnostics: { warnings: [], errors: [] },
      result: empty,
    };
    try {
      if (!/^\d{2,3}\.0$/u.test(flags['api-version']))
        throw new CmsError(
          'INVALID_API_VERSION',
          `Not a numeric API version: ${flags['api-version']}`,
        );
      const org = await this.resolveOrg(flags['target-org'], flags['api-version']);
      envelope.metadata.orgId = org.orgId;
      this.logToStderr(`Org: ${org.username} (${org.orgId})`);
      envelope.result = await body(org, envelope);
      // A body may record per-component errors and still finish (lenient retrieve).
      envelope.status = envelope.diagnostics.errors.length === 0 ? 'success' : 'failed';
    } catch (error) {
      envelope.diagnostics.errors.push(toDiagnostic(error));
    }
    if (envelope.status !== 'success') process.exitCode = 1;
    for (const warning of envelope.diagnostics.warnings)
      this.logToStderr(formatDiagnostic(warning));
    for (const error of envelope.diagnostics.errors) this.logToStderr(formatDiagnostic(error));
    return envelope;
  }
}
