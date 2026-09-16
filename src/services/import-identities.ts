import type { LoadedWorkspaceExport, WorkspaceImportItem } from './import-workspace.js';

/**
 * Build the bounded native raw-HTML copy profile without allocating a content key.
 * @param {LoadedWorkspaceExport} source - Integrity-checked original export.
 * @param {unknown} input - Explicit parent/language selection and fresh names.
 * @param {ReadonlySet<string>} literalHtmlVariantIds - Reconstructed sidecar variants, never GET-decode their literal HTML.
 * @returns {PlannedImportIdentities} Detached selected native copies.
 */
export function planNativeCopies(
  source: LoadedWorkspaceExport,
  input: unknown,
  literalHtmlVariantIds: ReadonlySet<string> = new Set(),
): PlannedImportIdentities {
  if (!Array.isArray(input) || input.length === 0)
    throw new TypeError('Native copy mappings must be a nonempty array');
  const selected: WorkspaceImportItem[] = [];
  const apiNames = new Set(source.items.map((item) => item.apiName));
  const urls = new Set(
    source.items.flatMap((item) => [item.urlName, item.contentBody['sfdc_cms:urlName']]),
  );
  const parents = new Set<string>();
  for (const row of input) {
    if (!record(row)) throw new TypeError('Native copy mapping must be an object');
    exactKeys(row, ['sourceContentKey', 'language', 'apiName', 'urlName'], 'Native copy mapping');
    for (const key of ['sourceContentKey', 'language', 'apiName']) identity(row[key], key);
    if (typeof row.urlName !== 'string' || !/^[a-z0-9-]+$/u.test(row.urlName))
      throw new TypeError('Native URL name must use lowercase letters, digits or hyphens');
    const matches = source.items.filter(
      (item) => item.contentKey === row.sourceContentKey && item.language === row.language,
    );
    if (matches.length !== 1 || parents.has(row.sourceContentKey as string))
      throw new TypeError('Select exactly one language per distinct native parent');
    const item = matches[0];
    if (apiNames.has(row.apiName as string) || urls.has(row.urlName))
      throw new TypeError(
        'Native API and URL names must be fresh relative to the source and this run',
      );
    assertNativeBody(item);
    parents.add(item.contentKey);
    apiNames.add(row.apiName as string);
    urls.add(row.urlName);
    selected.push({
      ...item,
      apiName: row.apiName as string,
      urlName: row.urlName,
      contentBody: {
        ...item.contentBody,
        rawHtml: literalHtmlVariantIds.has(item.id)
          ? (item.contentBody.rawHtml as string)
          : decodeNativeHtml(item.contentBody.rawHtml as string),
        ...(item.contentType === 'sfdc_cms__email' ? { 'sfdc_cms:urlName': row.urlName } : {}),
      },
    });
  }
  return { items: selected, targetContentKeys: [] };
}

/**
 * Decode the single entity layer used by native GET, leaving literal HTML untouched.
 * @param {string} value - Native rawHtml string.
 * @returns {string} Literal HTML with at most one GET encoding layer removed.
 */
export function decodeNativeHtml(value: string): string {
  // Native GET encodes the complete HTML document once; do not decode literal HTML text.
  if (value.includes('<') || !value.includes('&lt;')) return value;
  return value
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&amp;', '&');
}

function assertNativeBody(item: WorkspaceImportItem): void {
  if (!['sfdc_cms__email', 'sfdc_cms__emailTemplate'].includes(item.contentType))
    throw new TypeError('Native copy supports only raw-HTML email/template content');
  if (item.externalId != null || item.externalSource != null)
    throw new TypeError('External provider content is unsupported');
  const strings = new Set([
    'sfdc_cms:title',
    'sfdc_cms:description',
    'subjectLine',
    'preheader',
    'messagePurpose',
    'rawHtml',
    'textContent',
    'backgroundColor',
  ]);
  if (item.contentType === 'sfdc_cms__email') strings.add('sfdc_cms:urlName');
  const emptyArrays = new Set([
    'lightning:dataProviders',
    'lightning:expressions',
    'sfdc_cms:attachments',
    'sfdc_cms:variants',
  ]);
  for (const required of ['sfdc_cms:title', 'subjectLine', 'messagePurpose', 'rawHtml']) {
    if (typeof item.contentBody[required] !== 'string' || !item.contentBody[required])
      throw new TypeError(`Native body requires ${required}`);
  }
  for (const [key, value] of Object.entries(item.contentBody)) {
    if (
      strings.has(key) &&
      typeof value === 'string' &&
      // Temporary through Phase 7: retain the scanner, but bypass it for opaque rawHtml.
      (key === 'rawHtml' ? TEMPORARILY_BYPASS_RAW_HTML_SCANNER : safeNativeMetadata(value))
    )
      continue;
    if (emptyArrays.has(key) && Array.isArray(value) && value.length === 0) continue;
    if (
      key === 'lightning:backgroundImage' &&
      record(value) &&
      Object.keys(value).length === 3 &&
      value.repeat === 'no-repeat' &&
      value.position === 'center center' &&
      value.size === 'cover'
    )
      continue;
    if (
      key === 'lightning:brandSource' &&
      item.contentType === 'sfdc_cms__email' &&
      record(value) &&
      Object.keys(value).length === 1 &&
      value.defaultBrandOption === 'sfdcBrand'
    )
      continue;
    throw new TypeError(`Unsupported native body field or unresolved reference/media: ${key}`);
  }
}

const TEMPORARILY_BYPASS_RAW_HTML_SCANNER = true;

const NATIVE_DANGER =
  /\{\{|\{!|%%|\$brand|(?:<)\s*(?:img|script|iframe|video|audio|source|object|embed|link|svg)\b|\b(?:src|srcset)\s*=|url\s*\(|cms:\/\/|\/cms\//iu;

function safeNativeMetadata(value: string): boolean {
  return !/&(?:#|[a-z])/iu.test(value) && !NATIVE_DANGER.test(value);
}

// This is a security inspection vocabulary, not a general HTML entity decoder; list aliases that can compose denied markers.
const INSPECTABLE_ENTITY =
  /&(?:(?:amp|lt|gt|quot|apos|colon|sol|lbrace|rbrace|lcub|rcub|percnt|dollar|lpar|rpar|equals|tab|newline);?(?![\da-z=])|#39;?(?!\d)|#x[\da-f]+;?(?![\da-f])|#\d+;?(?!\d))/giu;

export function safeNativeRawHtml(value: string): boolean {
  let inspected = value;
  for (let pass = 0; pass < 3; pass += 1) {
    if (NATIVE_DANGER.test(inspected)) return false;
    const normalized = inspected.replaceAll(INSPECTABLE_ENTITY, (entity) =>
      decodeInspectionEntity(entity),
    );
    if (normalized === inspected) return true;
    inspected = normalized;
  }
  INSPECTABLE_ENTITY.lastIndex = 0;
  return !NATIVE_DANGER.test(inspected) && !INSPECTABLE_ENTITY.test(inspected);
}

function decodeInspectionEntity(entity: string): string {
  const normalized = entity.toLowerCase();
  const terminated = normalized.endsWith(';');
  const bare = terminated ? normalized.slice(0, -1) : normalized;
  if (bare === '&amp') return '&';
  if (bare === '&lt') return '<';
  if (bare === '&gt') return '>';
  if (bare === '&quot') return '"';
  if (bare === '&apos' || bare === '&#39') return "'";
  const named = new Map([
    ['&colon', ':'],
    ['&sol', '/'],
    ['&lbrace', '{'],
    ['&rbrace', '}'],
    ['&lcub', '{'],
    ['&rcub', '}'],
    ['&percnt', '%'],
    ['&dollar', '$'],
    ['&lpar', '('],
    ['&rpar', ')'],
    ['&equals', '='],
    ['&tab', '\t'],
    ['&newline', '\n'],
  ]).get(bare);
  if (named !== undefined) return named;
  const numeric = bare.startsWith('&#x')
    ? Number.parseInt(bare.slice(3), 16)
    : Number.parseInt(bare.slice(2), 10);
  return Number.isFinite(numeric) && numeric >= 0 && numeric <= 1_114_111
    ? String.fromCodePoint(numeric)
    : entity;
}

export type CreateIdentityMapping = {
  readonly sourceContentKey: string;
  readonly contentKey: string;
  readonly apiName: string;
  readonly urlNames: Readonly<Record<string, string>>;
};

export type PlannedImportIdentities = {
  readonly items: readonly WorkspaceImportItem[];
  readonly targetContentKeys: readonly string[];
};

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  if (Object.keys(value).toSorted().join('\0') !== [...keys].toSorted().join('\0')) {
    throw new TypeError(`${label} must contain exactly ${keys.join(', ')}`);
  }
}

function identity(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw new TypeError(`${label} must be a nonempty identifier without whitespace or separators`);
  }
}

function rewriteReferences(value: unknown, keys: ReadonlyMap<string, string>): unknown {
  if (Array.isArray(value)) return value.map((child) => rewriteReferences(child, keys));
  if (!record(value)) return value;
  if ('ref' in value) {
    // Only the documented ImageContentReference shape proves this field is a CMS key.
    if (value.type !== 'imageReference' || !record(value.ref)) {
      throw new TypeError(
        'Unsupported or ambiguous content reference; explicit transport required',
      );
    }
    exactKeys(value.ref, ['contentKey'], 'Image reference');
    const key = value.ref.contentKey;
    if (typeof key !== 'string' || !keys.has(key)) {
      throw new TypeError('Image reference has no selected source identity mapping');
    }
    return Object.fromEntries(
      Object.entries(value).map(([name, child]) => [
        name,
        name === 'ref' ? { contentKey: keys.get(key) } : rewriteReferences(child, keys),
      ]),
    );
  }
  return Object.fromEntries(
    Object.entries(value).map(([name, child]) => [name, rewriteReferences(child, keys)]),
  );
}

/**
 * Build a detached identity proposal, not an executable or destination-validated import plan.
 * @param {LoadedWorkspaceExport} source - Export already loaded through raw-byte integrity validation.
 * @param {unknown} input - Complete explicit CREATE mappings for every selected parent and language.
 * @returns {PlannedImportIdentities} Detached items requiring destination absence checks before mutation.
 */
export function planImportIdentities(
  source: LoadedWorkspaceExport,
  input: unknown,
): PlannedImportIdentities {
  if (!source.integrity.verified) throw new TypeError('Source integrity must be verified first');
  if (!Array.isArray(input)) throw new TypeError('Identity mappings must be an array');
  const sourceKeys = new Set(source.items.map((item) => item.contentKey));
  const sourceApiNames = new Set(source.items.map((item) => item.apiName));
  const sourceUrls = new Set(
    source.items.flatMap((item) => [item.urlName, item.contentBody['sfdc_cms:urlName']]),
  );
  const mappings = new Map<string, CreateIdentityMapping>();
  const targets = new Set<string>();
  const apiNames = new Set<string>();
  const urls = new Set<string>();
  for (const row of input) {
    if (!record(row)) throw new TypeError('Identity mapping must be an object');
    exactKeys(row, ['sourceContentKey', 'contentKey', 'apiName', 'urlNames'], 'Identity mapping');
    for (const name of ['sourceContentKey', 'contentKey', 'apiName']) identity(row[name], name);
    const { sourceContentKey, contentKey, apiName } = row as Record<string, string>;
    if (!sourceKeys.has(sourceContentKey) || mappings.has(sourceContentKey)) {
      throw new TypeError('Identity mapping has an unknown or duplicate source content key');
    }
    if (sourceKeys.has(contentKey) || targets.has(contentKey)) {
      throw new TypeError('Target content keys must be fresh and unique');
    }
    if (sourceApiNames.has(apiName) || apiNames.has(apiName)) {
      throw new TypeError('Target API names must be fresh and unique');
    }
    const variants = source.items.filter((item) => item.contentKey === sourceContentKey);
    if (new Set(variants.map((item) => item.contentType)).size !== 1) {
      throw new TypeError('Parent variants have conflicting content types');
    }
    if (!record(row.urlNames)) throw new TypeError('urlNames must be an object');
    exactKeys(
      row.urlNames,
      variants.map((item) => item.language),
      'urlNames',
    );
    for (const url of Object.values(row.urlNames)) {
      if (typeof url !== 'string' || !/^[a-z0-9-]+$/u.test(url)) {
        throw new TypeError('Target URL names must contain lowercase letters, digits or hyphens');
      }
      if (sourceUrls.has(url) || urls.has(url)) {
        throw new TypeError('Target URL names must be fresh and unique');
      }
      urls.add(url);
    }
    mappings.set(sourceContentKey, row as unknown as CreateIdentityMapping);
    targets.add(contentKey);
    apiNames.add(apiName);
  }
  if (mappings.size !== sourceKeys.size)
    throw new TypeError('Every selected parent needs a mapping');
  const replacements = new Map([...mappings].map(([key, mapping]) => [key, mapping.contentKey]));
  const imageKeys = new Map(
    source.items
      .filter((item) => item.contentType === 'sfdc_cms__image')
      .map((item) => [item.contentKey, replacements.get(item.contentKey)!]),
  );
  const items = source.items.map((item) => {
    const mapping = mappings.get(item.contentKey)!;
    const contentBody = rewriteReferences(item.contentBody, imageKeys) as Record<string, unknown>;
    const urlName = mapping.urlNames[item.language];
    // Email CMS metadata lives inside the body; never replace matching strings elsewhere.
    if (
      item.contentType === 'sfdc_cms__email' ||
      (item.contentType === 'sfdc_cms__emailTemplate' && 'sfdc_cms:urlName' in contentBody)
    ) {
      contentBody['sfdc_cms:urlName'] = urlName;
    }
    return {
      ...item,
      apiName: mapping.apiName,
      contentKey: mapping.contentKey,
      urlName,
      contentBody,
    } as WorkspaceImportItem;
  });
  return { items, targetContentKeys: [...targets].toSorted() };
}
