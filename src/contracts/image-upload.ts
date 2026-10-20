import type { Connection } from '@salesforce/core';
import { assertExactKeys, assertNonemptyString, assertSha256 } from './shared.js';
import { assertMediaMimeType } from '../services/editable-media-source.js';

export type ImageUploadSummary = {
  readonly action: 'create';
  readonly filename: string;
  readonly title: string;
  readonly apiName: string;
  readonly urlName: string;
  readonly mediaType: string;
  readonly size: number;
  readonly sha256: string;
};

export type ImageUploadCommandResult = {
  readonly mode: 'preview' | 'execute';
  readonly outcome: 'ready' | 'completed' | 'blocked' | 'failed' | 'ownership-uncertain';
  readonly target: ImageUploadRootEvidence | null;
  readonly intents: readonly ImageUploadSummary[];
  readonly byteProof: 'unavailable';
  readonly reportFile: string | null;
  readonly report: ImageUploadReport | null;
};

export function assertImageUploadCommandResult(
  value: unknown,
): asserts value is ImageUploadCommandResult {
  assertExactKeys(
    value,
    ['mode', 'outcome', 'target', 'intents', 'byteProof', 'reportFile', 'report'],
    'image upload result',
  );
  const { mode, outcome } = value;
  if (
    typeof mode !== 'string' ||
    !['preview', 'execute'].includes(mode) ||
    typeof outcome !== 'string' ||
    !['ready', 'completed', 'blocked', 'failed', 'ownership-uncertain'].includes(outcome) ||
    value.byteProof !== 'unavailable' ||
    !Array.isArray(value.intents)
  )
    throw new TypeError('Invalid image upload result');
  if (value.target !== null) {
    assertExactKeys(value.target, ['workspaceId', 'rootFolderId', 'isEnhancedSpace'], 'target');
    assertNonemptyString(value.target.workspaceId, 'workspaceId');
    assertNonemptyString(value.target.rootFolderId, 'rootFolderId');
    if (
      value.target.isEnhancedSpace !== true ||
      value.target.workspaceId === value.target.rootFolderId
    )
      throw new TypeError('Distinct enhanced root required');
  }
  if (value.reportFile !== null) assertNonemptyString(value.reportFile, 'reportFile');
  for (const intent of value.intents) {
    assertExactKeys(
      intent,
      ['action', 'filename', 'title', 'apiName', 'urlName', 'mediaType', 'size', 'sha256'],
      'intent',
    );
    for (const field of ['filename', 'title', 'apiName', 'urlName', 'mediaType'])
      assertNonemptyString(intent[field], field);
    assertSha256(intent.sha256, 'sha256');
    assertMediaMimeType(intent.mediaType);
    if (
      intent.action !== 'create' ||
      intent.title !== intent.filename ||
      !Number.isSafeInteger(intent.size) ||
      Number(intent.size) <= 0
    )
      throw new TypeError('Invalid image intent');
  }
  if (
    mode === 'preview' &&
    (value.reportFile !== null ||
      value.report !== null ||
      !['ready', 'blocked', 'failed'].includes(outcome))
  )
    throw new TypeError('Invalid dry-run outcome');
  if (
    ['ready', 'completed', 'ownership-uncertain'].includes(outcome) &&
    (value.target === null || value.intents.length === 0)
  )
    throw new TypeError('Prepared intents required');
  if (value.report !== null) {
    if (typeof value.report !== 'object' || Array.isArray(value.report))
      throw new TypeError('Invalid upload report');
    assertExactKeys(
      value.report,
      ['runId', 'root', 'operations', 'state', ...('error' in value.report ? ['error'] : [])],
      'report',
    );
    assertNonemptyString(value.report.runId, 'runId');
    if (
      !Array.isArray(value.report.operations) ||
      typeof value.report.state !== 'string' ||
      !['applying', 'completed', 'failed', 'ownership-uncertain'].includes(value.report.state)
    )
      throw new TypeError('Invalid upload report');
    for (const operation of value.report.operations) {
      if (
        operation === null ||
        typeof operation !== 'object' ||
        !['planned', 'pending', 'succeeded'].includes(operation.state) ||
        !operation.file ||
        typeof operation.file !== 'object' ||
        'bytes' in operation.file
      )
        throw new TypeError('Invalid upload operation');
    }
  }
  if (
    ['completed', 'ownership-uncertain'].includes(outcome) &&
    (mode !== 'execute' || value.report === null || value.report.state !== outcome)
  )
    throw new TypeError('Execution outcome evidence required');
}
import type {
  ImageCreateInput,
  ManagedContentDocumentBinding,
  MultipartImageCreateOptions,
} from '../transport/multipart-image-create.js';
import type { WorkspaceSelector, ResolvedWorkspace } from '../services/resolve-workspace.js';
import type { CmsRecord } from '../services/read.js';

export type ImageUploadInput = WorkspaceSelector & {
  readonly files: readonly string[];
};

export type ImageUploadFileIdentity = {
  readonly dev: string;
  readonly ino: string;
  readonly size: number;
  readonly mtimeNs: string;
  readonly ctimeNs: string;
};

export type PlannedImageUploadFile = {
  readonly path: string;
  readonly filename: string;
  readonly title: string;
  readonly apiName: string;
  readonly urlName: string;
  readonly mediaType: string;
  readonly bytes: Buffer;
  readonly sha256: string;
  readonly identity: ImageUploadFileIdentity;
};

export type ImageUploadRootEvidence = {
  readonly workspaceId: string;
  readonly rootFolderId: string;
  readonly isEnhancedSpace: true;
};

export type ImageUploadIntent = {
  readonly action: 'create';
  readonly file: PlannedImageUploadFile;
  readonly input: ImageCreateInput;
};

export type ImageUploadPreparation = {
  readonly ready: true;
  readonly root: ImageUploadRootEvidence;
  readonly intents: readonly ImageUploadIntent[];
};

/** Read-only dependencies: no mutation transport is exposed to preparation. */
export type ImageUploadReadServices = {
  readonly resolveWorkspace: (selector: WorkspaceSelector) => Promise<ResolvedWorkspace>;
  readonly getWorkspace: (workspaceId: string) => Promise<CmsRecord>;
  readonly searchVariants: (workspaceId: string, page?: number) => Promise<unknown>;
  readonly getVariant: (variantId: string) => Promise<CmsRecord>;
};

export type ImageUploadOperation = {
  readonly file: Omit<PlannedImageUploadFile, 'bytes'>;
  readonly input: ImageCreateInput;
  state: 'planned' | 'pending' | 'succeeded';
  binding?: Partial<ManagedContentDocumentBinding>;
  requestSha256?: string;
  readonly byteProof: 'unavailable';
};

export type ImageUploadReport = {
  readonly runId: string;
  readonly root: ImageUploadRootEvidence;
  readonly operations: ImageUploadOperation[];
  state: 'applying' | 'completed' | 'failed' | 'ownership-uncertain';
  error?: string;
};

export type ImageUploadApplyOptions = {
  readonly preparation: ImageUploadPreparation;
  readonly services: ImageUploadReadServices & {
    readonly getContent: (contentId: string) => Promise<CmsRecord>;
  };
  readonly connection: Pick<Connection, 'request'>;
  readonly reportDirectory?: string;
  readonly reportFile?: string;
  readonly createOptions?: MultipartImageCreateOptions;
  readonly reportPersistence?: {
    readonly rewrite: (file: string, report: ImageUploadReport) => Promise<void>;
  };
};

export type ImageUploadApplyResult = {
  readonly report: ImageUploadReport;
  readonly reportFile: string | null;
};
