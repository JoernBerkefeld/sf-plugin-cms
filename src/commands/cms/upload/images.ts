import { Flags } from '@salesforce/sf-plugins-core';
import { lstat } from 'node:fs/promises';
import { getCmsApiSelection } from '../../../api-policy.js';
import { apiVersionFlag, CmsCommand, targetOrgFlag } from '../../../command-base.js';
import {
  assertImageUploadCommandResult,
  type ImageUploadCommandResult,
  type PlannedImageUploadFile,
} from '../../../contracts/image-upload.js';
import { type CmsEnvelope, type CmsStatus } from '../../../contracts/shared.js';
import {
  applyImageUpload,
  ImageUploadApplyError,
  imageUploadReadServices,
  planImageUploadFiles,
  prepareImageUpload,
} from '../../../services/image-upload.js';
import { assertWorkspaceSelector } from '../../../services/resolve-workspace.js';
import { getContent } from '../../../services/read.js';

export default class UploadImages extends CmsCommand<CmsEnvelope<ImageUploadCommandResult>> {
  public static readonly summary =
    'Preview or create local images in an enhanced CMS workspace root.';
  public static readonly description =
    'Dry-run is the default: validates explicit image files and reads the exact enhanced workspace root and complete collision inventory, with no mutations. Repeat --file for each image; no JSON input map is needed. Titles retain the full filename including extension; API and URL names are derived from it. Apply requires a new --report-dir and creates Drafts sequentially with no retry, overwrite, publication, rollback, or resume. Metadata readback does not prove downloaded binary bytes.';
  public static readonly examples = [
    '<%= config.bin %> cms upload images --target-org my-org --workspace-name "Main Site" --file "./Banner with spaces.png" --file ./Logo.jpg',
    '<%= config.bin %> cms upload images --target-org my-org --workspace-id 0ZuTARGET --file ./Logo.jpg --apply --report-dir ./image-upload-report --json',
  ];
  public static readonly flags = {
    'target-org': targetOrgFlag,
    'api-version': apiVersionFlag,
    'contract-version': Flags.integer({
      default: 1,
      min: 1,
      summary: 'Machine result contract major (supported: 1).',
    }),
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
    apply: Flags.boolean({
      default: false,
      summary: 'Create Draft images after complete preflight; otherwise preview only.',
    }),
    'report-dir': Flags.directory({
      exists: false,
      dependsOn: ['apply'],
      summary: 'New directory required for durable apply reports.',
    }),
  };

  public async run(): Promise<CmsEnvelope<ImageUploadCommandResult>> {
    const { flags } = await this.parse(UploadImages);
    let orgId = 'unresolved-org';
    let result: ImageUploadCommandResult = {
      mode: flags.apply ? 'apply' : 'dry-run',
      outcome: 'blocked',
      target: null,
      intents: [],
      byteProof: 'unavailable',
      reportFile: null,
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
          command: 'sf cms upload images',
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
                        ? 'CREATE may have succeeded. Reconcile the durable report and destination before any new apply; do not retry.'
                        : 'Image upload did not complete. Check local inputs, exact workspace selection, collision eligibility, and any durable report before proceeding.',
                    retryable: false,
                  },
                ],
        },
        result,
      };
      if (!this.jsonEnabled()) {
        this.log(`Mode: ${result.mode}; outcome: ${result.outcome}`);
        if (result.target !== null) {
          this.log(`Destination workspace: ${result.target.workspaceId}`);
          this.log(`Destination root folder: ${result.target.rootFolderId}`);
        }
        for (const intent of result.intents)
          this.log(
            `${intent.filename}: ${intent.size} bytes; title=${intent.title}; apiName=${intent.apiName}; urlName=${intent.urlName}`,
          );
        if (result.reportFile !== null) this.log(`Run report: ${result.reportFile}`);
        for (const error of envelope.diagnostics.errors) this.log(error.message);
      }
      return this.finishEnvelope(envelope, assertImageUploadCommandResult);
    };
    try {
      if (flags['contract-version'] !== 1) return finish('blocked', 'UNSUPPORTED_CONTRACT_VERSION');
      assertWorkspaceSelector({
        workspaceId: flags['workspace-id'],
        workspaceName: flags['workspace-name'],
      });
      if (flags.apply && flags['report-dir'] === undefined)
        return finish('blocked', 'REPORT_DIRECTORY_REQUIRED');
      if (flags['report-dir'] !== undefined) {
        try {
          await lstat(flags['report-dir']);
          return finish('blocked', 'REPORT_DIRECTORY_EXISTS');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      }
      await planImageUploadFiles(flags.file);
    } catch {
      return finish('blocked', 'IMAGE_UPLOAD_LOCAL_VALIDATION_FAILED');
    }
    try {
      const context = await this.getOrgContext(flags['target-org'], flags['api-version']);
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
      if (!flags.apply) return finish('success');
      const applied = await applyImageUpload({
        preparation,
        services: { ...services, getContent: async (id) => getContent(context.connection, id) },
        connection: context.connection,
        reportDirectory: flags['report-dir']!,
      });
      result = { ...result, outcome: 'completed', reportFile: applied.reportFile };
      return finish('success');
    } catch (error) {
      result =
        error instanceof ImageUploadApplyError
          ? {
              ...result,
              outcome:
                error.report.state === 'ownership-uncertain' ? 'ownership-uncertain' : 'failed',
              reportFile: error.reportFile,
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
