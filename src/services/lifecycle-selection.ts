import type {
  ExactLifecycleSelector,
  LifecycleContentType,
} from '../contracts/content-lifecycle-batch.js';
import { normalizeContentTypeAlias } from './content-type-alias.js';

// Vocabulary only: native operation admission still requires qualified evidence.
const LIFECYCLE_CONTENT_TYPES = [
  'sfdc_cms__email',
  'sfdc_cms__emailTemplate',
  'sfdc_cms__image',
  'sfdc_cms__document',
  'sfdc_cms__audio',
] as const satisfies readonly LifecycleContentType[];

/**
 * Normalize ordered exact lifecycle selectors without expanding or deduplicating them.
 * @param {readonly string[]} values - Repeated exact Type:ApiName metadata values.
 * @returns {readonly ExactLifecycleSelector[]} Detached canonical selectors in caller order.
 */
export function normalizeLifecycleMetadata(
  values: readonly string[],
): readonly ExactLifecycleSelector[] {
  if (values.length === 0) throw new TypeError('Lifecycle metadata selectors must not be empty');
  return values.map((value) => {
    if (typeof value !== 'string')
      throw new TypeError('Lifecycle metadata requires exact Type:ApiName selectors');
    const separator = value.indexOf(':');
    if (separator <= 0 || separator !== value.lastIndexOf(':'))
      throw new TypeError('Lifecycle metadata requires exact Type:ApiName selectors');
    const contentType = normalizeContentTypeAlias(
      value.slice(0, separator),
      LIFECYCLE_CONTENT_TYPES,
    );
    if (contentType === undefined)
      throw new TypeError('Lifecycle metadata requires a supported content type or short name');
    const apiName = value.slice(separator + 1);
    if (apiName.trim().length === 0)
      throw new TypeError('Lifecycle metadata API names must not be empty');
    // Inspect whitespace only for emptiness; resolution must see the exact API name.
    return { contentType, apiName };
  });
}
