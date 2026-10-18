/**
 * Resolve an exact canonical type or its exact CMS namespace suffix within one operation.
 * @param {string} value - Unmodified caller spelling.
 * @param {readonly string[]} admittedTypes - Canonical types admitted by the operation.
 * @returns {string | undefined} Canonical admitted type, or undefined for unsupported input.
 */
export function normalizeContentTypeAlias<T extends string>(
  value: string,
  admittedTypes: readonly T[],
): T | undefined {
  return admittedTypes.find(
    (canonical) =>
      value === canonical ||
      (canonical.startsWith('sfdc_cms__') && value === canonical.slice('sfdc_cms__'.length)),
  );
}
