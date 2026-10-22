import { redactLogValue, redactSecrets } from './transport/redact-secrets.js';

/** Detached diagnostic fields only; never an execution report or request payload. */
export type MutationOutcome = Readonly<{
  operation: 'publish' | 'unpublish' | 'upload' | 'deploy';
  state: string;
  ordinal: number;
  label?: string;
  language?: string;
  target?: Readonly<{ workspaceId?: string; contentId?: string; variantId?: string }>;
  deploymentId?: string;
  reportFile?: string;
  diagnostics?: readonly Readonly<{ code: string; message: string }>[];
}>;
export type MutationOutcomeObserver = (event: MutationOutcome) => void;

/**
 * Delivers a detached sanitized event without affecting mutation classification.
 * @param {MutationOutcomeObserver | undefined} observer - Best-effort invocation sink.
 * @param {MutationOutcome} event - Settled per-item classification.
 */
export function notifyMutationOutcome(
  observer: MutationOutcomeObserver | undefined,
  event: MutationOutcome,
): void {
  try {
    const detached: MutationOutcome = {
      operation: event.operation,
      state: event.state,
      ordinal: event.ordinal,
      label: event.label,
      language: event.language,
      target:
        event.target === undefined
          ? undefined
          : {
              workspaceId: event.target.workspaceId,
              contentId: event.target.contentId,
              variantId: event.target.variantId,
            },
      deploymentId: event.deploymentId,
      reportFile: event.reportFile,
      diagnostics: event.diagnostics?.map(({ code, message }) => ({ code, message })),
    };
    observer?.(redactLogValue(detached) as MutationOutcome);
  } catch {
    // Diagnostics must not change outcomes or replay mutations.
  }
}

/**
 * Keeps identifiers and diagnostic prose out of human progress lines.
 * @param {MutationOutcome} event - Sanitized technical observation.
 * @returns {string} Human label/language or a stable ordinal fallback.
 */
export function formatMutationOutcome(event: MutationOutcome): string {
  const clean = (value: string | undefined): string => {
    let text = redactSecrets(value ?? '');
    for (const id of [...Object.values(event.target ?? {}), event.deploymentId, event.reportFile])
      if (id) text = text.replaceAll(id, '');
    return (
      text
        // eslint-disable-next-line no-control-regex -- Strip terminal ANSI sequences from user-facing labels.
        .replaceAll(/\u001B\[[\d;]*[A-Za-z]/gu, '')
        .replaceAll(/\b[a-z\d]{15}(?:[a-z\d]{3})?\b/giu, '')
        .replaceAll(/[\p{Cc}\u2028\u2029]+/gu, ' ')
        .replaceAll(/\s+/gu, ' ')
        .trim()
    );
  };
  const label = clean(event.label) || `Item ${event.ordinal}`;
  const language = clean(event.language);
  return `${event.operation}: ${label}${language ? ` (${language})` : ''} — ${event.state}`;
}
