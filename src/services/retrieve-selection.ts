import { normalizeContentTypeAlias } from './content-type-alias.js';

export const RETRIEVE_CONTENT_TYPES = [
  'sfdc_cms__email',
  'sfdc_cms__emailTemplate',
  'sfdc_cms__image',
  'sfdc_cms__document',
  'sfdc_cms__audio',
] as const;
export type RetrieveContentType = (typeof RETRIEVE_CONTENT_TYPES)[number];

/** The actual repeatable CLI flag shapes; unrelated command flags are not consumed. */
export interface RetrieveSelectionFlags {
  'content-type'?: readonly string[];
  'api-name'?: readonly string[];
  'content-key-or-id'?: readonly string[];
  metadata?: readonly string[];
  all?: boolean;
}

export interface RetrieveSelectionGroup {
  contentType: RetrieveContentType;
  all: boolean;
  /** Explicit members MUST still be resolved/validated when all is true. */
  apiNames: string[];
  /** Opaque native selectors, resolved by the next stage, not interpreted here. */
  contentKeysOrIds: string[];
}

export interface RetrieveSelection {
  mode: 'metadata' | 'api-name' | 'content-key-or-id' | 'all';
  /** One group per distinct type, in first-occurrence order. */
  groups: RetrieveSelectionGroup[];
}

function qualifiedType(value: string): RetrieveContentType {
  const canonical = normalizeContentTypeAlias(value, RETRIEVE_CONTENT_TYPES);
  if (canonical === undefined)
    throw new TypeError('Retrieve requires a supported qualified content type or short name');
  return canonical;
}

function nonemptyValues(values: readonly string[]): string[] {
  if (
    values.length === 0 ||
    values.some((value) => typeof value !== 'string' || value.trim().length === 0)
  )
    throw new TypeError('Retrieve selectors must not be empty');
  // Whitespace is inspected for emptiness only; exact selectors are never rewritten.
  return [...new Set(values)];
}

function group(contentType: RetrieveContentType): RetrieveSelectionGroup {
  return { contentType, all: false, apiNames: [], contentKeysOrIds: [] };
}

/**
 * Normalize retrieve selectors, defaulting absent selection to all admitted types without org access.
 * @param {RetrieveSelectionFlags} flags - Parsed repeatable CLI selectors.
 * @returns {RetrieveSelection} Detached per-type groups retaining explicit validation obligations.
 */
export function normalizeRetrieveSelection(flags: RetrieveSelectionFlags): RetrieveSelection {
  if (
    flags.metadata === undefined &&
    flags['content-type'] === undefined &&
    flags['api-name'] === undefined &&
    flags['content-key-or-id'] === undefined &&
    flags.all !== true
  )
    return {
      mode: 'all',
      groups: RETRIEVE_CONTENT_TYPES.map((contentType) => ({ ...group(contentType), all: true })),
    };

  if (flags.metadata !== undefined) {
    if (
      flags['content-type'] !== undefined ||
      flags['api-name'] !== undefined ||
      flags['content-key-or-id'] !== undefined ||
      flags.all === true
    )
      throw new TypeError('Metadata selection is exclusive of separate selection flags');
    const groups = new Map<RetrieveContentType, RetrieveSelectionGroup>();
    for (const selector of nonemptyValues(flags.metadata)) {
      const colon = selector.indexOf(':');
      const contentType = qualifiedType(colon === -1 ? selector : selector.slice(0, colon));
      let selected = groups.get(contentType);
      if (!selected) {
        selected = group(contentType);
        groups.set(contentType, selected);
      }
      if (colon === -1) selected.all = true;
      else {
        const apiName = nonemptyValues([selector.slice(colon + 1)])[0];
        if (!selected.apiNames.includes(apiName)) selected.apiNames.push(apiName);
      }
    }
    return { mode: 'metadata', groups: [...groups.values()] };
  }

  const types = [
    ...new Set(nonemptyValues(flags['content-type'] ?? []).map((value) => qualifiedType(value))),
  ];
  const hasNames = flags['api-name'] !== undefined;
  const hasNative = flags['content-key-or-id'] !== undefined;
  if (Number(hasNames) + Number(hasNative) + Number(flags.all === true) !== 1)
    throw new TypeError('Retrieve requires exactly one selection mode');
  if (flags.all === true)
    return {
      mode: 'all',
      groups: types.map((contentType) => ({ ...group(contentType), all: true })),
    };
  if (types.length !== 1)
    throw new TypeError('Separate exact/native selectors require one distinct content type');
  const selected = group(types[0]);
  if (hasNames) {
    selected.apiNames = nonemptyValues(flags['api-name']!);
    return { mode: 'api-name', groups: [selected] };
  }
  selected.contentKeysOrIds = nonemptyValues(flags['content-key-or-id']!);
  return { mode: 'content-key-or-id', groups: [selected] };
}
