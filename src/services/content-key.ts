export const CANONICAL_CONTENT_KEY_PATTERN = '^MC[A-Z2-7]{26}$';

const CANONICAL_CONTENT_KEY = /^MC[A-Z2-7]{26}$/u;

/**
 * Require an explicitly submitted Enhanced CMS content key to use the canonical format.
 * @param {string} value - Content key supplied by an import mapping.
 * @param {string} label - Field label used in the validation error.
 * @param {(message: string) => Error} errorFactory - Optional caller-specific error constructor.
 * @returns {void}
 */
export function assertCanonicalContentKey(
  value: string,
  label: string,
  errorFactory: (message: string) => Error = (message) => new TypeError(message),
): void {
  if (!CANONICAL_CONTENT_KEY.test(value)) {
    throw errorFactory(`${label} must match ${CANONICAL_CONTENT_KEY_PATTERN}`);
  }
}
