import { hints as general } from './codes/general.js';
import { hints as workspace } from './codes/workspace.js';
import { hints as content } from './codes/content.js';
import { CmsRequestError } from '../transport/json-request.js';
import { redactSecrets } from '../transport/redact-secrets.js';

/** One entry per family; a new family adds one import and one key. */
export const errorFamilies = { general, workspace, content } as const;

export type ErrorFamily = keyof typeof errorFamilies;

export type ErrorCodeInfo = Readonly<{ family: ErrorFamily; hint: string }>;

/** A plugin diagnostic: a registered code, a message and, from Salesforce, what it answered. */
export type Diagnostic = {
  code: string;
  /** The component it is about, as `type:ApiName`. */
  component?: string;
  message: string;
  hint?: string;
  status?: number;
  salesforceErrorCode?: string;
  requestId?: string;
};

const registry = new Map<string, ErrorCodeInfo>();
for (const [family, entries] of Object.entries(errorFamilies) as Array<
  [ErrorFamily, Readonly<Record<string, string>>]
>)
  for (const [code, hint] of Object.entries(entries)) {
    if (registry.has(code)) throw new Error(`Duplicate error code ${code}`);
    registry.set(code, Object.freeze({ family, hint }));
  }

/** An error the plugin raises on purpose, with a registered code. */
export class CmsError extends Error {
  public readonly code: string;

  public constructor(code: string, message: string) {
    super(message);
    this.name = 'CmsError';
    this.code = code;
  }
}

/**
 * Look up the CLI hint of a plugin error code.
 * @param {string} code - Plugin diagnostic code.
 * @returns {ErrorCodeInfo | undefined} Registered hint and family.
 */
export function errorCodeInfo(code: string): ErrorCodeInfo | undefined {
  return registry.get(code);
}

/**
 * All registered codes, for tests.
 * @returns {string[]} Registered codes.
 */
export function registeredErrorCodes(): string[] {
  return [...registry.keys()];
}

/**
 * Turn any thrown value into a diagnostic. A Salesforce answer keeps its status, error code,
 * message and request ID; a 401 becomes AUTHENTICATION_FAILED.
 * @param {unknown} error - Thrown value.
 * @param {string} fallbackCode - Code for anything that is neither a CmsError nor a request error.
 * @returns {Diagnostic} Diagnostic with its hint.
 */
export function toDiagnostic(error: unknown, fallbackCode = 'REQUEST_FAILED'): Diagnostic {
  if (error instanceof CmsError) return withHint({ code: error.code, message: error.message });
  if (error instanceof CmsRequestError) {
    const answer = [
      error.status === undefined ? undefined : `HTTP ${error.status}`,
      error.errorCode,
      error.responseMessage ?? error.message,
    ].filter(Boolean);
    return withHint({
      code: error.status === 401 ? 'AUTHENTICATION_FAILED' : 'REQUEST_FAILED',
      message: `${error.operationKey}: ${answer.join(': ')}`,
      ...(error.status === undefined ? {} : { status: error.status }),
      ...(error.errorCode === undefined ? {} : { salesforceErrorCode: error.errorCode }),
      ...(error.requestId === undefined ? {} : { requestId: error.requestId }),
    });
  }
  return withHint({
    code: fallbackCode,
    message: redactSecrets(error instanceof Error ? error.message : String(error)),
  });
}

function withHint(diagnostic: Diagnostic): Diagnostic {
  const info = registry.get(diagnostic.code);
  return info ? { ...diagnostic, hint: info.hint } : diagnostic;
}

/**
 * Human output for one diagnostic: `CODE: message`, then the hint unless the message says it.
 * @param {Readonly<Diagnostic>} diagnostic - Diagnostic to print.
 * @param {string} [prefix] - Text before the code, such as `email:Welcome: `.
 * @returns {string} One or two lines.
 */
export function formatDiagnostic(
  diagnostic: Readonly<Diagnostic>,
  prefix = diagnostic.component ? `${diagnostic.component}: ` : '',
): string {
  const lines = [`${prefix}${diagnostic.code}: ${diagnostic.message}`];
  const hint = diagnostic.hint ?? registry.get(diagnostic.code)?.hint;
  if (hint && !diagnostic.message.includes(hint)) lines.push(`Hint: ${hint}`);
  if (diagnostic.requestId) lines.push(`Request ID: ${diagnostic.requestId}`);
  return lines.join('\n');
}
