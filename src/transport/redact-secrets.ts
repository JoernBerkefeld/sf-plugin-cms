import { Stream } from 'node:stream';

const REDACTED = '[REDACTED]';
const SECRET_KEY =
  /^(?:authorization|proxy[-_]?authorization|cookie|set[-_]?cookie|(?:access|refresh|id)[-_]?token|token|password|passwd|client[-_]?secret|session(?:id|key)?|fueloauth)$/iu;

/**
 * Sanitizes received argv without normalizing nonsecret tokens.
 * @param {readonly string[]} argv - Actual received tokens, including alias spelling.
 * @returns {string[]} Redacted tokens in their original order.
 */
export function redactArgv(argv: readonly string[]): string[] {
  let secretValue = false;
  return argv.map((token) => {
    if (secretValue) {
      secretValue = false;
      return REDACTED;
    }
    const [flag] = token.split('=', 1);
    if (flag.startsWith('--') && SECRET_KEY.test(flag.slice(2))) {
      if (token.includes('=')) return `${flag}=${REDACTED}`;
      secretValue = true;
      return token;
    }
    return redactSecrets(token);
  });
}

/**
 * Produces JSON-safe diagnostics without reading binary bodies or live streams.
 * @param {unknown} value - Diagnostic data, never persisted before sanitizing.
 * @param {Set<object>} seen - Ancestors used to label cycles explicitly.
 * @returns {unknown} Sanitized data retaining useful error details.
 */
export function redactLogValue(value: unknown, seen = new Set<object>()): unknown {
  if (typeof value === 'string') return redactSecrets(value);
  if (typeof value === 'bigint') return String(value);
  if (typeof value === 'function' || typeof value === 'symbol') return '[omitted non-JSON value]';
  if (value === null || typeof value !== 'object') return value;
  if (ArrayBuffer.isView(value)) return { omitted: 'binary', byteLength: value.byteLength };
  if (value instanceof ArrayBuffer) return { omitted: 'binary', byteLength: value.byteLength };
  if (value instanceof Stream || value instanceof ReadableStream)
    return { omitted: 'stream (not consumed)' };
  if (value instanceof Blob) return { omitted: 'binary', byteLength: value.size, type: value.type };
  if (seen.has(value)) return '[omitted circular reference]';
  const ancestors = new Set(seen).add(value);
  if (Array.isArray(value)) return value.map((entry) => redactLogValue(entry, ancestors));
  if (value instanceof Headers || value instanceof URLSearchParams) {
    return redactLogValue(Object.fromEntries(value), ancestors);
  }
  if (value instanceof URL) return redactSecrets(value.href);
  if (value instanceof Date) return value.toISOString();
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of Object.getOwnPropertyNames(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (SECRET_KEY.test(key)) result[key] = REDACTED;
    else if (descriptor && 'value' in descriptor)
      result[key] = redactLogValue(descriptor.value, ancestors);
    else result[key] = '[omitted accessor]';
  }
  return result;
}

const AUTHORIZATION_HEADERS = '(?:authorization|proxy-authorization)';
const COOKIE_HEADERS = '(?:cookie|set-cookie)';
const QUERY_KEYS = [
  'client_secret',
  'password',
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
  // Decode only for inspection; unchanged nonsecret tokens retain their original encoding.
  try {
    const decoded = decodeURIComponent(message);
    if (decoded !== message && redactSecrets(decoded) !== decoded) return redactSecrets(decoded);
  } catch {
    // Malformed percent escapes remain useful diagnostic text.
  }
  if (/^\s*[[{]/u.test(message)) {
    try {
      const parsed: unknown = JSON.parse(message);
      const sanitized = redactLogValue(parsed);
      if (JSON.stringify(parsed) !== JSON.stringify(sanitized)) return JSON.stringify(sanitized);
    } catch {
      // Non-JSON diagnostics still receive embedded text masking below.
    }
  }
  return message
    .replaceAll(
      /("(?:authorization|proxy-authorization|cookie|set-cookie)"\s*:\s*)"(?:\\.|[^"\\])*"/giu,
      `$1"${REDACTED}"`,
    )
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
    .replaceAll(new RegExp(String.raw`([?&](?:${QUERY_KEYS})=)[^&#\s]+`, 'giu'), `$1${REDACTED}`)
    .replaceAll(/(https?:\/\/)[^\s/@]+@/giu, `$1${REDACTED}@`)
    .replaceAll(
      /(["']?(?:access[-_]?token|refresh[-_]?token|id[-_]?token|client[-_]?secret|password|sessionid)["']?\s*[:=]\s*)("[^"\r\n]*"|'[^'\r\n]*'|[^\s&,;}]+)/giu,
      `$1${REDACTED}`,
    );
}
