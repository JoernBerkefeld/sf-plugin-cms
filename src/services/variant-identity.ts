type VariantIdentity = { contentId?: string; variantId?: string };

function retainedIdentifier(
  record: Record<string, unknown>,
  current: string,
  legacy: string,
): string | undefined {
  for (const key of [current, legacy]) {
    const value = record[key];
    if (
      value !== undefined &&
      (typeof value !== 'string' || value.length === 0 || /[/\\]/u.test(value))
    ) {
      throw new TypeError(`Variant ${key} must be a nonempty identifier`);
    }
  }
  if (
    record[current] !== undefined &&
    record[legacy] !== undefined &&
    record[current] !== record[legacy]
  ) {
    throw new TypeError(`Variant has conflicting ${current}/${legacy} identity`);
  }
  return (record[current] ?? record[legacy]) as string | undefined;
}

/**
 * Reads a required Managed Content variant ID from current or legacy response fields.
 * @param {Record<string, unknown>} record - Managed Content variant response.
 * @param {string} [label] - Human-readable error label.
 * @returns {string} Exact variant identifier.
 */
export function requiredVariantIdentifier(
  record: Record<string, unknown>,
  label = 'Variant',
): string {
  const variantId = retainedIdentifier(record, 'managedContentVariantId', 'id');
  if (variantId === undefined) throw new TypeError(`${label} identity is missing`);
  return variantId;
}

/**
 * Reads a required Managed Content parent ID from current or legacy response fields.
 * @param {Record<string, unknown>} record - Managed Content variant response.
 * @param {string} [label] - Human-readable error label.
 * @returns {string} Exact parent content identifier.
 */
export function requiredContentIdentifier(
  record: Record<string, unknown>,
  label = 'Content',
): string {
  const contentId = retainedIdentifier(record, 'managedContentId', 'contentId');
  if (contentId === undefined) throw new TypeError(`${label} identity is missing`);
  return contentId;
}

/**
 * Reads documented variant response IDs and this package's legacy fixture fields.
 * Never treats a variant ID as the parent content ID.
 * @param {Record<string, unknown>} record - Retained variant response.
 * @param {string} expectedVariantId - Variant ID from the package/search entry.
 * @returns {VariantIdentity} Separate parent and variant identities, when retained.
 */
export function variantIdentity(
  record: Record<string, unknown>,
  expectedVariantId: string,
): VariantIdentity {
  const variantId = retainedIdentifier(record, 'managedContentVariantId', 'id');
  const contentId = retainedIdentifier(record, 'managedContentId', 'contentId');
  if (variantId !== undefined && variantId !== expectedVariantId) {
    throw new TypeError('Variant does not match its manifest/search variant ID');
  }
  if (contentId !== undefined && contentId === expectedVariantId) {
    throw new TypeError('Parent content identity must not be the variant identity');
  }
  return { contentId, variantId };
}
