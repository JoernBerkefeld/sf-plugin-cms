/**
 * Library entry `sf-plugin-cms/api`: the `sf cms` commands as functions on a caller's
 * `@salesforce/core` Connection. Each returns the envelope `--json` returns and never throws.
 *
 * Stable contract: the functions and options below; in results `status`, `diagnostics`,
 * `result.workspace`, `result.preview` and per item `type`, `apiName`, `outcome`, `reason`,
 * `managedContentId`, `variantId`, `contentKey`, `isPublished`; the outcome values and the
 * error codes. Other item fields (`changes`, `renames`, `folders`, `dependencies`, `answer`,
 * `note`, local file lists) are informational. `exitCodeOf(result)` gives the exit code the
 * command would set (0, 1, 68 or 69).
 */
import { createApi } from './api/impl.js';

const api = createApi();

export const { deploy, publish, unpublish, remove, retrieve, getItems } = api;
export { flowContentReference, parseFlowContentReference } from './api/impl.js';
export { exitCodeOf } from './exit-code.js';
export type { ExitCode } from './exit-code.js';
export type {
  ApiConnection,
  DeployOptions,
  FlowContentReference,
  GetItemsOptions,
  GetItemsResult,
  ItemReference,
  ItemState,
  RemoveOptions,
  RetrieveOptions,
  SelectionOptions,
} from './api/impl.js';
export type { CmsResult } from './command-base.js';
export type { Diagnostic } from './errors/registry.js';
export type { DeployedItem, DeployOutcome, DeployResult } from './services/deploy.js';
export type { LifecycleItem, LifecycleOutcome, LifecycleResult } from './services/lifecycle.js';
export type { RetrievedItem, RetrieveResult } from './services/retrieve.js';
