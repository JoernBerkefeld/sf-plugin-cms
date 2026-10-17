import { createHash } from 'node:crypto';
import { constants as bufferConstants } from 'node:buffer';
import { assertMediaMimeType } from '../services/editable-media-source.js';
import { domainToASCII } from 'node:url';
import { open, unlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { redactSecrets } from './redact-secrets.js';

const MEDIA_SUFFIX = 'file.force.com';
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
export const EXPERIMENTAL_MEDIA_POLICY = {
  approvedRedirectSuffix: MEDIA_SUFFIX,
  maxRedirects: 3,
  perImageBytes: 10 * 1024 * 1024,
  totalBytes: 50 * 1024 * 1024,
} as const;

export type ExperimentalMediaDownload = {
  readonly bytes: number;
  readonly contentLength?: number;
  readonly md5: string;
  readonly mimeType: string;
  readonly sha256: string;
};

type ExperimentalMediaFileHandle = Pick<FileHandle, 'close' | 'write'>;

export type ExperimentalMediaDownloadOptions = {
  readonly accessToken: string;
  readonly contentType?:
    'sfdc_cms__image' | 'sfdc_cms__document' | 'sfdc_cms__audio' | 'sfdc_cms__video';
  readonly expectedMd5: string;
  readonly expectedMimeType: string;
  readonly expectedSize: number;
  readonly fetch?: typeof fetch;
  readonly instanceUrl: string;
  readonly maxBytes?: number;
  readonly openFile?: (file: string) => Promise<ExperimentalMediaFileHandle>;
  readonly outputFile: string;
  readonly unlinkFile?: (file: string) => Promise<void>;
};

function safeSecondaryDiagnostic(error: unknown): string {
  const message = redactSecrets(error instanceof Error ? error.message : String(error));
  return message.slice(0, 256);
}

async function cleanupFailedDownload(
  handle: ExperimentalMediaFileHandle,
  outputFile: string,
  primary: unknown,
  unlinkFile: (file: string) => Promise<void>,
  closeAttempted: boolean,
): Promise<never> {
  const secondary: string[] = [];
  if (!closeAttempted) {
    try {
      await handle.close();
    } catch (error) {
      secondary.push(`close: ${safeSecondaryDiagnostic(error)}`);
    }
  }
  try {
    await unlinkFile(outputFile);
  } catch (error) {
    secondary.push(`unlink: ${safeSecondaryDiagnostic(error)}`);
  }
  if (primary instanceof Error && secondary.length > 0) {
    Object.defineProperty(primary, 'cleanupDiagnostics', {
      configurable: true,
      enumerable: false,
      value: secondary,
    });
  }
  throw primary;
}

function normalizedHost(url: URL): string {
  const host = domainToASCII(url.hostname.toLowerCase().replace(/\.$/u, ''));
  if (host.length === 0) throw new TypeError('Experimental media URL hostname is invalid');
  return host;
}

function assertSafeHttps(url: URL): string {
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') {
    throw new TypeError('Experimental media transport requires HTTPS without userinfo');
  }
  if (url.port !== '' && url.port !== '443') {
    throw new TypeError('Experimental media transport permits only the default HTTPS port');
  }
  return normalizedHost(url);
}

export function isApprovedSalesforceMediaUrl(value: string | URL): boolean {
  try {
    const url = value instanceof URL ? value : new URL(value);
    const host = assertSafeHttps(url);
    return host.endsWith(`.${MEDIA_SUFFIX}`) && host.length > MEDIA_SUFFIX.length + 1;
  } catch {
    return false;
  }
}

function sameOrigin(left: URL, right: URL): boolean {
  return assertSafeHttps(left) === assertSafeHttps(right) && left.port === right.port;
}

function extension(fileName: string): string {
  const last = fileName.split('.').at(-1)?.toLowerCase();
  if (last === undefined || last === fileName.toLowerCase()) return '';
  return last;
}

export async function downloadExperimentalCmsMedia(
  source: URL,
  options: ExperimentalMediaDownloadOptions,
): Promise<ExperimentalMediaDownload> {
  const contentType = options.contentType ?? 'sfdc_cms__image';
  assertMediaMimeType(options.expectedMimeType);
  if (
    !Number.isSafeInteger(options.expectedSize) ||
    options.expectedSize <= 0 ||
    options.expectedSize > bufferConstants.MAX_LENGTH
  ) {
    throw new TypeError('Experimental media expected size must be a positive safe Buffer length');
  }
  if (
    (contentType === 'sfdc_cms__document' && options.expectedMimeType !== 'text/plain') ||
    (contentType === 'sfdc_cms__audio' && options.expectedMimeType !== 'audio/x-wav') ||
    (contentType === 'sfdc_cms__video' && options.expectedMimeType !== 'video/mp4') ||
    (contentType !== 'sfdc_cms__image' &&
      contentType !== 'sfdc_cms__document' &&
      contentType !== 'sfdc_cms__audio' &&
      contentType !== 'sfdc_cms__video')
  ) {
    throw new TypeError(`Experimental media MIME type is unsupported: ${options.expectedMimeType}`);
  }
  const instance = new URL(options.instanceUrl);
  assertSafeHttps(instance);
  if (!sameOrigin(source, instance)) {
    throw new TypeError('Experimental media source must use the authenticated Salesforce instance');
  }
  if (!source.pathname.startsWith('/cms/media/')) {
    throw new TypeError('Experimental media source path is unsupported');
  }
  const fetcher = options.fetch ?? fetch;
  let current = source;
  let response: Response | undefined;
  for (let redirects = 0; redirects <= EXPERIMENTAL_MEDIA_POLICY.maxRedirects; redirects += 1) {
    const onInstance = sameOrigin(current, instance);
    if (!onInstance && !isApprovedSalesforceMediaUrl(current)) {
      throw new TypeError(
        'Experimental media redirect target is outside the approved Salesforce class',
      );
    }
    const accept =
      contentType === 'sfdc_cms__image'
        ? 'image/*,application/octet-stream;q=0.8'
        : options.expectedMimeType;
    response = await fetcher(current, {
      headers: {
        accept,
        authorization: `Bearer ${options.accessToken}`,
      },
      redirect: 'manual',
    });
    if (!REDIRECT_STATUSES.has(response.status)) break;
    if (redirects === EXPERIMENTAL_MEDIA_POLICY.maxRedirects) {
      throw new TypeError('Experimental media redirect count exceeded');
    }
    const location = response.headers.get('location');
    if (location === null) throw new TypeError('Experimental media redirect has no location');
    const target = new URL(location, current);
    assertSafeHttps(target);
    if (!isApprovedSalesforceMediaUrl(target) && !sameOrigin(target, instance)) {
      throw new TypeError(
        'Experimental media redirect target is outside the approved Salesforce class',
      );
    }
    current = target;
  }
  if (response === undefined || !response.ok || response.body === null) {
    throw Object.assign(
      new TypeError(`Experimental media request failed with status ${response?.status ?? 0}`),
      { status: response?.status },
    );
  }
  const responseHeader = response.headers.get('content-type');
  // HTTP parameters describe the response, not the parameter-free native/upload MIME.
  const responseType = responseHeader?.split(';', 1)[0].trim().toLowerCase();
  if (
    responseHeader === null ||
    !/^[A-Za-z0-9!#$%&'*+.^_`|~-]+\/[A-Za-z0-9!#$%&'*+.^_`|~-]+(?:[\t ]*;[\t ]*[A-Za-z0-9!#$%&'*+.^_`|~-]+=(?:[A-Za-z0-9!#$%&'*+.^_`|~-]+|"(?:[\t !#-[\]-~]|\\[\t -~])*"))*[\t ]*$/u.test(
      responseHeader,
    ) ||
    responseType === undefined
  ) {
    throw new TypeError(
      'Experimental media response Content-Type must be safe ASCII HTTP media type',
    );
  }
  const sameMime = responseType.toLowerCase() === options.expectedMimeType.toLowerCase();
  if (!sameMime && (responseType === 'text/html' || responseType.includes('json'))) {
    throw new TypeError('Experimental media response is not binary image content');
  }
  if (
    !sameMime &&
    !(
      contentType === 'sfdc_cms__image' && responseType.toLowerCase() === 'application/octet-stream'
    )
  ) {
    throw new TypeError('Experimental media response MIME type changed');
  }
  const declaredLengthText = response.headers.get('content-length');
  const declaredLength = declaredLengthText === null ? undefined : Number(declaredLengthText);
  const familyLimit =
    contentType === 'sfdc_cms__image'
      ? bufferConstants.MAX_LENGTH
      : EXPERIMENTAL_MEDIA_POLICY.perImageBytes;
  const configuredLimit = options.maxBytes ?? familyLimit;
  if (!Number.isSafeInteger(configuredLimit) || configuredLimit <= 0) {
    throw new TypeError('Experimental media byte cap must be a positive safe integer');
  }
  const limit = Math.min(configuredLimit, familyLimit);
  if (
    declaredLength !== undefined &&
    (!Number.isSafeInteger(declaredLength) || declaredLength < 0 || declaredLength > limit)
  ) {
    throw new TypeError('Experimental media Content-Length is invalid or exceeds the cap');
  }
  const fileName = source.searchParams.get('fileName');
  if (
    fileName === null ||
    fileName.length === 0 ||
    fileName.includes('/') ||
    fileName.includes('\\')
  ) {
    throw new TypeError('Experimental media filename is invalid');
  }
  const md5 = createHash('md5');
  const sha256 = createHash('sha256');
  const prefix: Buffer[] = [];
  let prefixLength = 0;
  let bytes = 0;
  const handle = await (options.openFile ?? (async (file) => open(file, 'wx')))(options.outputFile);
  const unlinkFile = options.unlinkFile ?? unlink;
  let closeAttempted = false;
  try {
    for await (const chunkValue of Readable.fromWeb(response.body as never)) {
      const chunk = Buffer.isBuffer(chunkValue)
        ? chunkValue
        : Buffer.from(chunkValue as Uint8Array);
      if (chunk.length > limit - bytes) {
        throw new TypeError('Experimental media response exceeds the byte cap');
      }
      bytes += chunk.length;
      if (prefixLength < 12) {
        const selected = chunk.subarray(0, 12 - prefixLength);
        prefix.push(selected);
        prefixLength += selected.length;
      }
      md5.update(chunk);
      sha256.update(chunk);
      await handle.write(chunk);
    }
    if (declaredLength !== undefined && bytes !== declaredLength) {
      throw new TypeError('Experimental media byte count differs from Content-Length');
    }
    if (bytes !== options.expectedSize) {
      throw new TypeError('Experimental media byte count differs from authoring metadata');
    }
    const actualMd5 = md5.digest('hex');
    if (actualMd5 !== options.expectedMd5.toLowerCase()) {
      throw new TypeError('Experimental media MD5 differs from the authoring URL');
    }
    switch (contentType) {
      case 'sfdc_cms__document': {
        if (extension(fileName) !== 'txt') {
          throw new TypeError('Experimental Document filename extension must be txt');
        }

        break;
      }
      case 'sfdc_cms__audio': {
        if (extension(fileName) !== 'wav') {
          throw new TypeError('Experimental Audio filename extension must be wav');
        }
        const signature = Buffer.concat(prefix);
        if (
          !signature.subarray(0, 4).equals(Buffer.from('RIFF')) ||
          !signature.subarray(8, 12).equals(Buffer.from('WAVE'))
        ) {
          throw new TypeError('Experimental Audio WAV signature is invalid');
        }

        break;
      }
      case 'sfdc_cms__video': {
        if (extension(fileName) !== 'mp4') {
          throw new TypeError('Experimental Video filename extension must be mp4');
        }
        if (!Buffer.concat(prefix).subarray(4, 12).equals(Buffer.from('ftypisom'))) {
          throw new TypeError('Experimental Video MP4 isom signature is invalid');
        }

        break;
      }
      default: {
        // Image format admission belongs to the API, not a local signature inventory.
        break;
      }
    }
    closeAttempted = true;
    await handle.close();
    return {
      bytes,
      ...(declaredLength === undefined ? {} : { contentLength: declaredLength }),
      md5: actualMd5,
      mimeType: options.expectedMimeType,
      sha256: sha256.digest('hex'),
    };
  } catch (error) {
    return cleanupFailedDownload(handle, options.outputFile, error, unlinkFile, closeAttempted);
  }
}
