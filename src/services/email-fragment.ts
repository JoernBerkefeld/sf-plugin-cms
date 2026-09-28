import { isDeepStrictEqual } from 'node:util';
import type { LoadedWorkspaceExport, WorkspaceImportItem } from './import-workspace.js';
import type { PlannedImportIdentities } from './import-identities.js';

const EMAIL_FRAGMENT_TYPE = 'sfdc_cms__emailFragment';
const BLOCK_KEY = 'sfdc_cms:block';
const TITLE_KEY = 'sfdc_cms:title';
const URL_NAME_KEY = 'sfdc_cms:urlName';
const BODY_KEYS = [
  'backgroundColor',
  'lightning:backgroundImage',
  'lightning:brandSource',
  'lightning:colorScheme',
  'lightning:dataProviders',
  'lightning:expressions',
  'lightning:padding',
  'sfdc_cms:attachments',
  BLOCK_KEY,
  TITLE_KEY,
  URL_NAME_KEY,
  'sfdc_cms:variants',
] as const;
const COMPONENT_DEFINITIONS = {
  root: 'sfdc_cms/rootContentBlock',
  section: 'lightning/section',
  column: 'lightning/column',
} as const;
const BACKGROUND_IMAGE = { position: 'center center', repeat: 'no-repeat', size: 'cover' };
const SECTION_ATTRIBUTES = {
  'lightning:backgroundImage': BACKGROUND_IMAGE,
  'lightning:borderRadius': '{!$brand.borderRadius.square}',
  'lightning:borderWidth': '{!$brand.borderWeight.none}',
  'lightning:colorScheme': '{!$brand.colorScheme}',
  'lightning:margin': '{!$brand.spacing.none}',
  'lightning:padding': '{!$brand.spacing.xSmall}',
  reverseOrderOnMobile: false,
  stackOnMobile: true,
};
const COLUMN_ATTRIBUTES = {
  'lightning:backgroundImage': BACKGROUND_IMAGE,
  'lightning:borderRadius': '{!$brand.borderRadius.square}',
  'lightning:borderWidth': '{!$brand.borderWeight.none}',
  'lightning:colorScheme': '{!$brand.colorScheme}',
  'lightning:margin': '{!$brand.spacing.none}',
  'lightning:padding': '{!$brand.spacing.xSmall}',
  columnWidth: 12,
  'lightning:verticalAlignment': 'top',
};

type JsonRecord = Record<string, unknown>;

function record(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function identity(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw new TypeError(`${label} must be a nonempty identifier without whitespace or separators`);
  }
}

function exactKeys(value: JsonRecord, keys: readonly string[], label: string): void {
  if (Object.keys(value).toSorted().join('\0') !== [...keys].toSorted().join('\0')) {
    throw new TypeError(`${label} must contain exactly ${keys.join(', ')}`);
  }
}

function exactValue(value: unknown, expected: unknown, label: string): void {
  if (!isDeepStrictEqual(value, expected)) {
    throw new TypeError(`${label} must match the evidenced dependency-free profile`);
  }
}

function emptyArray(value: unknown, label: string): void {
  if (!Array.isArray(value) || value.length > 0) {
    throw new TypeError(`${label} must be an empty array`);
  }
}

function children(value: JsonRecord, label: string): unknown[] {
  if (!Array.isArray(value.children)) throw new TypeError(`${label}.children must be an array`);
  return value.children;
}

function assertComponent(
  value: unknown,
  expected: 'root' | 'section' | 'column',
  label: string,
): JsonRecord {
  if (!record(value)) throw new TypeError(`${label} must be an object`);
  const expectedKeys =
    expected === 'root'
      ? ['children', 'definition', 'id', 'type']
      : ['attributes', 'children', 'definition', 'id', 'type'];
  exactKeys(value, expectedKeys, label);
  if (value.definition !== COMPONENT_DEFINITIONS[expected] || value.type !== 'block') {
    throw new TypeError(
      `${label} must use exact definition ${COMPONENT_DEFINITIONS[expected]} and type block`,
    );
  }
  identity(value.id, `${label}.id`);
  if (expected !== 'root') {
    exactValue(
      value.attributes,
      expected === 'section' ? SECTION_ATTRIBUTES : COLUMN_ATTRIBUTES,
      `${label}.attributes`,
    );
  }
  return value;
}

/**
 * Validate the first evidenced, create-only email-fragment body shape.
 * @param {WorkspaceImportItem} item - Integrity-verified import item to validate.
 * @returns {void}
 */
export function assertEmailFragmentItem(item: WorkspaceImportItem): void {
  if (item.contentType !== EMAIL_FRAGMENT_TYPE) {
    throw new TypeError(
      `Email fragment profile requires exact content type ${EMAIL_FRAGMENT_TYPE}`,
    );
  }
  if (typeof item.apiName !== 'string' || item.apiName.length === 0 || item.title.length === 0) {
    throw new TypeError('Email fragment identity and title are required');
  }
  exactKeys(item.contentBody as JsonRecord, BODY_KEYS, 'Email fragment contentBody');
  if (typeof item.contentBody[TITLE_KEY] !== 'string' || item.contentBody[TITLE_KEY].length === 0) {
    throw new TypeError(`Email fragment body requires ${TITLE_KEY}`);
  }
  if (
    typeof item.contentBody[URL_NAME_KEY] !== 'string' ||
    item.contentBody[URL_NAME_KEY].length === 0
  ) {
    throw new TypeError(`Email fragment body requires nonempty ${URL_NAME_KEY}`);
  }
  if (item.urlName !== item.contentBody[URL_NAME_KEY]) {
    throw new TypeError(`Email fragment ${URL_NAME_KEY} must match the top-level urlName`);
  }
  if (item.contentBody.backgroundColor !== '#f3f3f3') {
    throw new TypeError('Email fragment backgroundColor must match the evidenced profile');
  }
  exactValue(
    item.contentBody['lightning:backgroundImage'],
    BACKGROUND_IMAGE,
    'lightning:backgroundImage',
  );
  exactValue(
    item.contentBody['lightning:brandSource'],
    { defaultBrandOption: 'sfdcBrand' },
    'lightning:brandSource',
  );
  if (item.contentBody['lightning:colorScheme'] !== '{!$brand.colorScheme}') {
    throw new TypeError('lightning:colorScheme must match the evidenced profile');
  }
  if (item.contentBody['lightning:padding'] !== '{!$brand.spacing.none}') {
    throw new TypeError('lightning:padding must match the evidenced profile');
  }
  emptyArray(item.contentBody['lightning:dataProviders'], 'lightning:dataProviders');
  emptyArray(item.contentBody['lightning:expressions'], 'lightning:expressions');
  emptyArray(item.contentBody['sfdc_cms:attachments'], 'sfdc_cms:attachments');
  emptyArray(item.contentBody['sfdc_cms:variants'], 'sfdc_cms:variants');

  const root = assertComponent(item.contentBody[BLOCK_KEY], 'root', `Email fragment ${BLOCK_KEY}`);
  const rootChildren = children(root, `Email fragment ${BLOCK_KEY}`);
  if (rootChildren.length !== 1)
    throw new TypeError('Email fragment root must contain one section');
  const section = assertComponent(rootChildren[0], 'section', 'Email fragment section');
  const sectionChildren = children(section, 'Email fragment section');
  if (sectionChildren.length !== 1)
    throw new TypeError('Email fragment section must contain one column');
  const column = assertComponent(sectionChildren[0], 'column', 'Email fragment column');
  if (children(column, 'Email fragment column').length > 0) {
    throw new TypeError('Email fragment column must be empty in this bounded profile');
  }
}

/**
 * Plan detached fresh identities for one default-language email-fragment variant per parent.
 * @param {LoadedWorkspaceExport} source - Integrity-verified original workspace export.
 * @param {unknown} input - Explicit selected source and fresh target identities.
 * @returns {PlannedImportIdentities} Detached bounded fragment proposal.
 */
export function planEmailFragmentCopies(
  source: LoadedWorkspaceExport,
  input: unknown,
): PlannedImportIdentities {
  if (!source.integrity.verified) throw new TypeError('Source integrity must be verified first');
  if (!Array.isArray(input) || input.length === 0) {
    throw new TypeError('Email fragment mappings must be a nonempty array');
  }
  const sourceKeys = new Set(source.items.map((item) => item.contentKey));
  const sourceApiNames = new Set(source.items.map((item) => item.apiName));
  const selected = new Set<string>();
  const targetKeys = new Set<string>();
  const targetApiNames = new Set<string>();
  const items: WorkspaceImportItem[] = [];

  for (const row of input) {
    if (!record(row)) throw new TypeError('Email fragment mapping must be an object');
    exactKeys(
      row,
      ['sourceContentKey', 'language', 'contentKey', 'apiName'],
      'Email fragment mapping',
    );
    for (const key of ['sourceContentKey', 'language', 'contentKey', 'apiName'])
      identity(row[key], key);
    const sourceContentKey = row.sourceContentKey as string;
    const language = row.language as string;
    const contentKey = row.contentKey as string;
    const apiName = row.apiName as string;
    const selection = `${sourceContentKey}\0${language}`;
    const matches = source.items.filter(
      (item) => item.contentKey === sourceContentKey && item.language === language,
    );
    if (matches.length !== 1 || selected.has(selection)) {
      throw new TypeError(
        'Select exactly one email fragment variant per source parent and language',
      );
    }
    if (sourceKeys.has(contentKey) || targetKeys.has(contentKey)) {
      throw new TypeError('Target email fragment content keys must be fresh and unique');
    }
    if (sourceApiNames.has(apiName) || targetApiNames.has(apiName)) {
      throw new TypeError('Target email fragment API names must be fresh and unique');
    }
    assertEmailFragmentItem(matches[0]);
    selected.add(selection);
    targetKeys.add(contentKey);
    targetApiNames.add(apiName);
    items.push({ ...matches[0], contentKey, apiName });
  }

  return { items, targetContentKeys: [...targetKeys].toSorted() };
}
