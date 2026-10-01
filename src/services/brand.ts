const BRAND_TYPE = 'sfdc_cms__brand' as const;

type JsonRecord = Record<string, unknown>;

const COMMON_KEYS = [
  'apiName',
  'contentBody',
  'contentFqn',
  'contentKey',
  'contentSpace',
  'contentType',
  'createdBy',
  'createdDate',
  'externalId',
  'folder',
  'isPublished',
  'language',
  'lastModifiedBy',
  'lastModifiedDate',
  'managedContentId',
  'managedContentVariantId',
  'managedContentVersionId',
  'status',
  'title',
  'urlName',
] as const;
const CONTENT_KEYS = [...COMMON_KEYS, 'contentVersion', 'variantVersion'] as const;
const BODY_KEYS = [
  'baseFontFamily',
  'baseFontSize',
  'borderRadius',
  'borderWeight',
  'buttonStyleGroup',
  'colorScheme',
  'fontFamily',
  'fontSize',
  'fontWeight',
  'letterSpacing',
  'lightning:dataProviders',
  'sfdc_cms:title',
  'spacing',
  'typography',
  'sfdc_cms:einsteinBrandProperties',
  'sfdc_cms:variants',
] as const;
const FONT_KEYS = [
  'arial',
  'arialBlack',
  'calibri',
  'comicSansMs',
  'courierNew',
  'georgia',
  'impact',
  'lucidaConsole',
  'lucidaSansUnicode',
  'palatinoLinotype',
  'tahoma',
  'timesNewRoman',
  'trebuchetMs',
  'verdana',
] as const;

export const BRAND_READ_REPORT_FORMAT = 'sf-cms-brand-read-report@1' as const;

export type BrandSourceProvenance = {
  readonly managedContentId: string;
  readonly managedContentVariantId: string;
  readonly contentSpaceId: string;
};

export type BrandNormalization = {
  readonly semantic: {
    readonly contentType: typeof BRAND_TYPE;
    readonly title: string;
    readonly body: Readonly<JsonRecord>;
  };
  readonly provenance: BrandSourceProvenance;
  readonly unresolvedReferences: readonly [];
};

export type BrandReadReport = {
  readonly format: typeof BRAND_READ_REPORT_FORMAT;
  readonly workspaceId: string;
  readonly apiName: string;
  readonly variantId: string;
  readonly rawItemPath: string;
  readonly normalization: BrandNormalization;
};

export type BrandReadReportInput = Omit<BrandReadReport, 'format'>;
export type BrandReadReportExpectedIdentity = Partial<Omit<BrandReadReport, 'format'>>;

function record(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonemptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function exactKeys(value: JsonRecord, keys: readonly string[]): boolean {
  const actual = Object.keys(value).toSorted();
  return (
    actual.length === keys.length && actual.every((key, index) => key === keys.toSorted()[index])
  );
}

function onlyKeys(value: JsonRecord, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function measurement(value: unknown, units: readonly string[] = ['rem']): boolean {
  return (
    record(value) &&
    exactKeys(value, ['unit', 'value']) &&
    units.includes(String(value.unit)) &&
    typeof value.value === 'number' &&
    Number.isFinite(value.value)
  );
}

function measurementMap(value: unknown, keys: readonly string[]): boolean {
  return record(value) && exactKeys(value, keys) && keys.every((key) => measurement(value[key]));
}

function inset(value: unknown): boolean {
  return measurementMap(value, ['bottom', 'left', 'right', 'top']);
}

function expression(value: unknown): value is string {
  return typeof value === 'string' && /^\{!\$brand\.[A-Za-z\d.]+\}$/u.test(value);
}

function typographyStyle(value: unknown): boolean {
  return (
    record(value) &&
    exactKeys(value, [
      'fontFamily',
      'fontSize',
      'fontWeight',
      'letterSpacing',
      'lineHeight',
      'textTransform',
    ]) &&
    expression(value.fontFamily) &&
    expression(value.fontSize) &&
    expression(value.fontWeight) &&
    value.letterSpacing === 'normal' &&
    value.lineHeight === 1.5 &&
    value.textTransform === 'none'
  );
}

function styleGroup(value: unknown, names: readonly string[]): boolean {
  return (
    record(value) && exactKeys(value, names) && names.every((name) => typographyStyle(value[name]))
  );
}

function buttonStyle(value: unknown, tertiary: boolean): boolean {
  if (
    !record(value) ||
    !exactKeys(value, [
      'lightning:borderRadius',
      'lightning:borderWidth',
      'lightning:buttonColorGroup',
      'lightning:padding',
      'lightning:typography',
    ]) ||
    !expression(value['lightning:borderRadius']) ||
    !expression(value['lightning:borderWidth']) ||
    !inset(value['lightning:padding']) ||
    !expression(value['lightning:typography']) ||
    !record(value['lightning:buttonColorGroup'])
  ) {
    return false;
  }
  const colors = value['lightning:buttonColorGroup'];
  const keys = tertiary
    ? ['textColor', 'textHoverColor']
    : [
        'backgroundColor',
        'backgroundHoverColor',
        'borderColor',
        'borderHoverColor',
        'textColor',
        'textHoverColor',
      ];
  return exactKeys(colors, keys) && keys.every((key) => expression(colors[key]));
}

function validBrandBody(value: unknown): value is JsonRecord {
  if (!record(value) || !exactKeys(value, BODY_KEYS)) return false;
  if (
    !expression(value.baseFontFamily) ||
    !measurement(value.baseFontSize, ['px']) ||
    !measurementMap(value.borderRadius, ['round', 'square']) ||
    !measurementMap(value.borderWeight, ['medium', 'none', 'thick', 'thin']) ||
    !record(value.buttonStyleGroup) ||
    !exactKeys(value.buttonStyleGroup, ['primary', 'secondary', 'tertiary']) ||
    !buttonStyle(value.buttonStyleGroup.primary, false) ||
    !buttonStyle(value.buttonStyleGroup.secondary, false) ||
    !buttonStyle(value.buttonStyleGroup.tertiary, true) ||
    !record(value.colorScheme) ||
    !exactKeys(value.colorScheme, [
      'contrast',
      'neutral',
      'primaryAccent',
      'primaryAccentContrast',
      'primaryAccentContrastDerived',
      'primaryAccentDerived',
      'root',
    ]) ||
    !Object.values(value.colorScheme).every((entry) => typeof entry === 'string') ||
    !record(value.fontFamily) ||
    !exactKeys(value.fontFamily, FONT_KEYS)
  ) {
    return false;
  }
  for (const font of Object.values(value.fontFamily)) {
    if (
      !record(font) ||
      !onlyKeys(font, ['category', 'fallbacks', 'name']) ||
      !nonemptyString(font.category) ||
      !nonemptyString(font.name) ||
      (font.fallbacks !== undefined &&
        (!Array.isArray(font.fallbacks) || !font.fallbacks.every(nonemptyString)))
    ) {
      return false;
    }
  }
  if (
    !measurementMap(value.fontSize, ['large', 'medium', 'small', 'xLarge', 'xSmall', 'xxLarge']) ||
    !record(value.fontWeight) ||
    !exactKeys(value.fontWeight, ['bold', 'light', 'normal']) ||
    !Object.values(value.fontWeight).every((entry) => typeof entry === 'number') ||
    !record(value.letterSpacing) ||
    !exactKeys(value.letterSpacing, ['compact', 'normal', 'wide']) ||
    !measurement(value.letterSpacing.compact, ['px']) ||
    value.letterSpacing.normal !== 'normal' ||
    !measurement(value.letterSpacing.wide, ['px']) ||
    !Array.isArray(value['lightning:dataProviders']) ||
    value['lightning:dataProviders'].length > 0 ||
    !nonemptyString(value['sfdc_cms:title']) ||
    !record(value.spacing) ||
    !exactKeys(value.spacing, ['large', 'medium', 'none', 'small', 'xLarge', 'xSmall']) ||
    !Object.values(value.spacing).every((entry) => inset(entry)) ||
    !record(value.typography) ||
    !exactKeys(value.typography, ['button', 'heading', 'input', 'label', 'paragraph']) ||
    !styleGroup(value.typography.button, ['button1']) ||
    !styleGroup(value.typography.heading, [
      'heading1',
      'heading2',
      'heading3',
      'heading4',
      'heading5',
      'heading6',
    ]) ||
    !styleGroup(value.typography.input, ['input1']) ||
    !styleGroup(value.typography.label, ['label1']) ||
    !styleGroup(value.typography.paragraph, ['paragraph1', 'paragraph2']) ||
    !record(value['sfdc_cms:einsteinBrandProperties']) ||
    !exactKeys(value['sfdc_cms:einsteinBrandProperties'], ['personality']) ||
    !record(value['sfdc_cms:einsteinBrandProperties'].personality) ||
    !exactKeys(value['sfdc_cms:einsteinBrandProperties'].personality, ['defaultPersonality']) ||
    !nonemptyString(value['sfdc_cms:einsteinBrandProperties'].personality.defaultPersonality) ||
    !Array.isArray(value['sfdc_cms:variants']) ||
    value['sfdc_cms:variants'].length > 0
  ) {
    return false;
  }
  return true;
}

function safeRawItemPath(value: unknown): value is string {
  if (!nonemptyString(value) || !value.startsWith('items/') || !value.endsWith('.json'))
    return false;
  if (value.includes('\\') || value.startsWith('/') || /^[A-Za-z]:/u.test(value)) return false;
  return value
    .split('/')
    .every((segment) => segment.length > 0 && segment !== '.' && segment !== '..');
}

function contentType(value: JsonRecord): string | undefined {
  return record(value.contentType) && onlyKeys(value.contentType, ['fullyQualifiedName', 'name'])
    ? (value.contentType.fullyQualifiedName as string | undefined)
    : undefined;
}

/**
 * Normalize one retained-evidence Brand content or variant record.
 * @param {unknown} value - Candidate Brand detail envelope.
 * @returns {BrandNormalization | null} Strict semantic and provenance separation, or null.
 */
export function normalizeBrand(value: unknown): BrandNormalization | null {
  if (!record(value)) return null;
  const isContent = 'contentVersion' in value || 'variantVersion' in value;
  if (
    !exactKeys(value, isContent ? CONTENT_KEYS : COMMON_KEYS) ||
    contentType(value) !== BRAND_TYPE
  )
    return null;
  if (
    !nonemptyString(value.managedContentId) ||
    !nonemptyString(value.managedContentVariantId) ||
    value.managedContentId === value.managedContentVariantId ||
    !record(value.contentSpace) ||
    !exactKeys(value.contentSpace, ['id', 'resourceUrl']) ||
    !nonemptyString(value.contentSpace.id) ||
    !validBrandBody(value.contentBody) ||
    value.title !== value.contentBody['sfdc_cms:title'] ||
    value.isPublished !== false ||
    !record(value.status) ||
    !exactKeys(value.status, ['label', 'status']) ||
    value.status.status !== 'Draft'
  ) {
    return null;
  }
  return {
    semantic: {
      contentType: BRAND_TYPE,
      title: value.contentBody['sfdc_cms:title'] as string,
      body: structuredClone(value.contentBody),
    },
    provenance: {
      managedContentId: value.managedContentId,
      managedContentVariantId: value.managedContentVariantId,
      contentSpaceId: value.contentSpace.id,
    },
    unresolvedReferences: [],
  };
}

function validNormalization(value: unknown): value is BrandNormalization {
  return (
    record(value) &&
    exactKeys(value, ['semantic', 'provenance', 'unresolvedReferences']) &&
    record(value.semantic) &&
    exactKeys(value.semantic, ['body', 'contentType', 'title']) &&
    value.semantic.contentType === BRAND_TYPE &&
    nonemptyString(value.semantic.title) &&
    validBrandBody(value.semantic.body) &&
    value.semantic.title === value.semantic.body['sfdc_cms:title'] &&
    record(value.provenance) &&
    exactKeys(value.provenance, [
      'contentSpaceId',
      'managedContentId',
      'managedContentVariantId',
    ]) &&
    nonemptyString(value.provenance.contentSpaceId) &&
    nonemptyString(value.provenance.managedContentId) &&
    nonemptyString(value.provenance.managedContentVariantId) &&
    value.provenance.managedContentId !== value.provenance.managedContentVariantId &&
    Array.isArray(value.unresolvedReferences) &&
    value.unresolvedReferences.length === 0
  );
}

export function buildBrandReadReport(input: BrandReadReportInput): BrandReadReport {
  const report: BrandReadReport = { format: BRAND_READ_REPORT_FORMAT, ...input };
  if (!validateBrandReadReport(report)) throw new Error('Invalid Brand read report input.');
  return report;
}

export function validateBrandReadReport(
  value: unknown,
  expected: BrandReadReportExpectedIdentity = {},
): value is BrandReadReport {
  if (
    !record(value) ||
    !exactKeys(value, [
      'apiName',
      'format',
      'normalization',
      'rawItemPath',
      'variantId',
      'workspaceId',
    ]) ||
    value.format !== BRAND_READ_REPORT_FORMAT ||
    !nonemptyString(value.workspaceId) ||
    !nonemptyString(value.apiName) ||
    !nonemptyString(value.variantId) ||
    !safeRawItemPath(value.rawItemPath) ||
    !validNormalization(value.normalization) ||
    value.variantId !== value.normalization.provenance.managedContentVariantId
  ) {
    return false;
  }
  return Object.entries(expected).every(([key, expectedValue]) => value[key] === expectedValue);
}
