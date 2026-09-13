const REDACTED = '[REDACTED]';

const AUTHORIZATION_HEADERS = '(?:authorization|proxy-authorization)';
const COOKIE_HEADERS = '(?:cookie|set-cookie)';
const QUERY_KEYS = [
  'access_token',
  'id_token',
  'refresh_token',
  'signature',
  'sig',
  'token',
  'x-amz-credential',
  'x-amz-security-token',
  'x-amz-signature',
  'se',
  'sp',
  'sr',
  'sv',
].join('|');

/**
 * Redacts credential-shaped values from transport diagnostics without replacing ordinary prose.
 * @param {string} message - Diagnostic text that may contain request credentials.
 * @returns {string} The diagnostic text with recognized secret values replaced.
 */
export function redactSecrets(message: string): string {
  return message
    .replaceAll(
      new RegExp(
        String.raw`(${AUTHORIZATION_HEADERS}\s*[:=]\s*)(?:(?:bearer|basic)\s+)?[^\s,;]+`,
        'giu',
      ),
      `$1${REDACTED}`,
    )
    .replaceAll(
      new RegExp(String.raw`(${COOKIE_HEADERS}\s*[:=]\s*)[^\r\n]+`, 'giu'),
      `$1${REDACTED}`,
    )
    .replaceAll(/(bearer\s+)[a-z\d._~+/=-]+/giu, `$1${REDACTED}`)
    .replaceAll(new RegExp(String.raw`([?&](?:${QUERY_KEYS})=)[^&#\s]+`, 'giu'), `$1${REDACTED}`);
}
