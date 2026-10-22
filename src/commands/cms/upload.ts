import { Flags } from '@salesforce/sf-plugins-core';
import path from 'node:path';
import { getCmsApiSelection } from '../../api-policy.js';
import { apiVersionFlag, CmsCommand, targetOrgFlag } from '../../command-base.js';
import {
  assertImageUploadCommandResult,
  type ImageUploadCommandResult,
  type PlannedImageUploadFile,
} from '../../contracts/image-upload.js';
import { type CmsEnvelope, type CmsStatus } from '../../contracts/shared.js';
import {
  applyImageUpload,
  ImageUploadApplyError,
  imageUploadReadServices,
  planImageUploadFiles,
  prepareImageUpload,
} from '../../services/image-upload.js';
import { assertWorkspaceSelector } from '../../services/resolve-workspace.js';
import { getContent } from '../../services/read.js';
import {
  allocateMutationReportDirectory,
  validateMutationReportDirectory,
} from '../../services/mutation-report-directory.js';

export default class UploadImages extends CmsCommand<CmsEnvelope<ImageUploadCommandResult>> {
  public static readonly aliases = ['content:upload'];
  public static readonly summary =
    'Create or preview local images in an enhanced CMS workspace root.';
  public static readonly description =
    'Executes by default. --preview validates explicit image files and reads the exact enhanced workspace root and complete collision inventory, with no mutations, content writes or report allocation; diagnostic invocation logs remain enabled. Repeat --file for each image; no JSON input map is needed. Titles retain the full filename including extension; API and URL names are derived from it. Creates Drafts sequentially with no retry, overwrite, publication, rollback, or resume. Reporting is opt-in: --report allocates ./logs/cms/reports/<timestamp>-<unique-id>/ under invocation cwd; --report-dir implies reporting at that exact fresh directory. Neither flag means no reports or hidden journals and no crash-surviving structured journal. Preview rejects reporting options. Metadata readback does not prove downloaded binary bytes.';
  public static readonly examples = [
    '<%= config.bin %> cms upload --target-org my-org --workspace-name "Main Site" --file "./Banner with spaces.png" --file ./Logo.jpg --preview',
    '<%= config.bin %> cms upload --target-org my-org --workspace-id 0ZuTARGET --file ./Logo.jpg --report --json',
  ];
  public static readonly flags = {
    'target-org': targetOrgFlag,
    'api-version': apiVersionFlag,
    'workspace-id': Flags.string({
      exclusive: ['workspace-name'],
      summary: 'Exact destination CMS workspace ID.',
    }),
    'workspace-name': Flags.string({
      exclusive: ['workspace-id'],
      summary: 'Exact case-insensitive destination CMS workspace name.',
    }),
    file: Flags.file({
      required: true,
      multiple: true,
      multipleNonGreedy: true,
      summary: 'Explicit local image path; repeat this flag in desired upload order.',
    }),
    preview: Flags.boolean({
      default: false,
      summary:
        'Read-only preflight; no mutations, content writes or reports (diagnostic logs remain).',
    }),
    report: Flags.boolean({
      default: false,
      summary: 'Persist reports in a unique cwd logs/cms/reports run directory; not with preview.',
    }),
    'report-dir': Flags.string({
      char: 'r',
      summary: 'Exact fresh report directory; implies report and overrides its default location.',
    }),
  };

  public async run(): Promise<CmsEnvelope<ImageUploadCommandResult>> {
    const { flags } = await this.parse(UploadImages);
    const targetOrg = flags['target-org'].getUsername()!;
    const invocationCwd = process.cwd();
    let orgId = 'unresolved-org';
    let result: ImageUploadCommandResult = {
      mode: flags.preview ? 'preview' : 'execute',
      outcome: 'blocked',
      target: null,
      intents: [],
      byteProof: 'unavailable',
      reportFile: null,
      report: null,
    };
    const finish = (status: CmsStatus, code?: string): CmsEnvelope<ImageUploadCommandResult> => {
      const envelope: CmsEnvelope<ImageUploadCommandResult> = {
        contract: 'sf-cms-images-upload',
        contractVersion: '1.0.0',
        status,
        metadata: {
          operation: 'images.upload',
          plugin: { name: 'sf-plugin-cms', version: this.pluginVersion },
          apiVersion: flags['api-version'],
        },
        provenance: {
          producer: 'sf-plugin-cms',
          sourceOrgId: orgId,
          pluginVersion: this.pluginVersion,
          command: 'sf cms upload',
          generatedAt: new Date().toISOString(),
        },
        diagnostics: {
          warnings: [],
          errors:
            code === undefined
              ? []
              : [
                  {
                    code,
                    message:
                      code === 'IMAGE_UPLOAD_OWNERSHIP_UNCERTAIN'
                        ? 'CREATE may have succeeded. Inspect returned operation identities and reconcile the destination before any new execution; do not retry. Inspect durable reports only when reporting was enabled.'
                        : 'Image upload did not complete. Check local inputs, exact workspace selection, collision eligibility and returned outcomes; inspect durable reports only when reporting was enabled.',
                    retryable: false,
                  },
                ],
        },
        result,
      };
      if (!this.jsonEnabled()) {
        this.log(`Mode: ${result.mode}; outcome: ${result.outcome}`);
        if (result.mode === 'preview')
          for (const intent of result.intents)
            this.log(`${intent.filename}: ${intent.size} bytes; ready to create`);
        if (result.reportFile !== null) this.log(`Run report: ${result.reportFile}`);
        for (const error of envelope.diagnostics.errors) this.log(error.message);
      }
      return this.finishEnvelope(envelope, assertImageUploadCommandResult);
    };
    try {
      assertWorkspaceSelector({
        workspaceId: flags['workspace-id'],
        workspaceName: flags['workspace-name'],
      });
      if (flags.preview && (flags.report || flags['report-dir'] !== undefined))
        throw new TypeError('Preview forbids report and report-dir.');
      if (flags['report-dir'] !== undefined)
        await validateMutationReportDirectory(flags['report-dir']);
      await planImageUploadFiles(flags.file);
    } catch (error) {
      this.logDiagnosticError('image upload local validation failed', error);
      return finish('blocked', 'IMAGE_UPLOAD_LOCAL_VALIDATION_FAILED');
    }
    try {
      const context = await this.getOrgContext(targetOrg, flags['api-version']);
      orgId = context.orgId;
      if (flags['api-version'] === 'latest')
        flags['api-version'] = getCmsApiSelection(context.connection).effectiveApiVersion;
      const services = imageUploadReadServices(context.connection);
      const preparation = await prepareImageUpload(
        {
          workspaceId: flags['workspace-id'],
          workspaceName: flags['workspace-name'],
          files: flags.file,
        },
        services,
      );
      result = {
        ...result,
        outcome: 'ready',
        target: Object.freeze({ ...preparation.root }),
        intents: Object.freeze(preparation.intents.map(({ file }) => summary(file))),
      };
      if (flags.preview) return finish('success');
      const directory = await allocateMutationReportDirectory(
        flags.report,
        flags['report-dir'],
        invocationCwd,
      );
      const applied = await applyImageUpload({
        preparation,
        services: { ...services, getContent: async (id) => getContent(context.connection, id) },
        connection: context.connection,
        onOutcome: this.mutationOutcomeObserver(),
        ...(directory ? { reportFile: path.join(directory, 'image-upload-run.json') } : {}),
      });
      result = {
        ...result,
        outcome: 'completed',
        reportFile: applied.reportFile,
        report: applied.report,
      };
      return finish('success');
    } catch (error) {
      result =
        error instanceof ImageUploadApplyError
          ? {
              ...result,
              outcome:
                error.report.state === 'ownership-uncertain' ? 'ownership-uncertain' : 'failed',
              reportFile: error.reportFile,
              report: error.report,
            }
          : { ...result, outcome: 'failed' };
      return finish(
        'failed',
        result.outcome === 'ownership-uncertain'
          ? 'IMAGE_UPLOAD_OWNERSHIP_UNCERTAIN'
          : 'IMAGE_UPLOAD_FAILED',
      );
    }
  }
}

function summary(file: PlannedImageUploadFile): ImageUploadCommandResult['intents'][number] {
  return Object.freeze({
    action: 'create',
    filename: file.filename,
    title: file.title,
    apiName: file.apiName,
    urlName: file.urlName,
    mediaType: file.mediaType,
    size: file.identity.size,
    sha256: file.sha256,
  });
}
