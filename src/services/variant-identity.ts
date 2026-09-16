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
