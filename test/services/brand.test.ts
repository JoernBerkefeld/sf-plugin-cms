import { expect } from 'chai';
import {
  BRAND_READ_REPORT_FORMAT,
  buildBrandReadReport,
  normalizeBrand,
  validateBrandReadReport,
} from '../../src/services/brand.js';

const measurement = (value: number, unit = 'rem') => ({ unit, value });
const inset = (value: number) => ({
  bottom: measurement(value),
  left: measurement(value),
  right: measurement(value),
  top: measurement(value),
});
const typography = (size: string) => ({
  fontFamily: '{!$brand.baseFontFamily}',
  fontSize: `{!$brand.fontSize.${size}}`,
  fontWeight: '{!$brand.fontWeight.normal}',
  letterSpacing: 'normal',
  lineHeight: 1.5,
  textTransform: 'none',
});
const font = (name: string, category: string, fallbacks?: string[]) => ({
  category,
  ...(fallbacks === undefined ? {} : { fallbacks }),
  name,
});

function body(): Record<string, unknown> {
  const button = (tertiary = false) => ({
    'lightning:borderRadius': '{!$brand.borderRadius.round}',
    'lightning:borderWidth': tertiary
      ? '{!$brand.borderWeight.none}'
      : '{!$brand.borderWeight.thin}',
    'lightning:buttonColorGroup': tertiary
      ? {
          textColor: '{!$brand.colorScheme.primaryAccent}',
          textHoverColor: '{!$brand.colorScheme.primaryAccentDerived}',
        }
      : {
          backgroundColor: '{!$brand.colorScheme.primaryAccent}',
          backgroundHoverColor: '{!$brand.colorScheme.primaryAccentDerived}',
          borderColor: '{!$brand.colorScheme.primaryAccent}',
          borderHoverColor: '{!$brand.colorScheme.primaryAccentDerived}',
          textColor: '{!$brand.colorScheme.primaryAccentContrast}',
          textHoverColor: '{!$brand.colorScheme.primaryAccentContrastDerived}',
        },
    'lightning:padding': inset(0.5),
    'lightning:typography': '{!$brand.typography.button.button1}',
  });
  return {
    baseFontFamily: '{!$brand.fontFamily.arial}',
    baseFontSize: measurement(16, 'px'),
    borderRadius: { round: measurement(0.25), square: measurement(0) },
    borderWeight: {
      medium: measurement(0.125),
      none: measurement(0),
      thick: measurement(0.1875),
      thin: measurement(0.0625),
    },
    buttonStyleGroup: { primary: button(), secondary: button(), tertiary: button(true) },
    colorScheme: {
      contrast: '#000000',
      neutral: '#747474',
      primaryAccent: '#CD2BF0',
      primaryAccentContrast: '#ffffff',
      primaryAccentContrastDerived: '#FFFFFF',
      primaryAccentDerived: '#b200d6',
      root: '#ffffff',
    },
    fontFamily: {
      arial: font('Arial', 'sans-serif', ['Helvetica']),
      arialBlack: font('Arial Black', 'sans-serif', ['Gadget']),
      calibri: font('Calibri', 'sans-serif', ['Candara', 'Segoe', 'Segoe UI', 'Optima', 'Arial']),
      comicSansMs: font('Comic Sans MS', 'sans-serif', ['cursive']),
      courierNew: font('Courier New', 'monospace'),
      georgia: font('Georgia', 'serif'),
      impact: font('Impact', 'sans-serif', ['Charcoal']),
      lucidaConsole: font('Lucida Console', 'monospace', ['Monaco']),
      lucidaSansUnicode: font('Lucida Sans Unicode', 'sans-serif', ['Lucida Grande']),
      palatinoLinotype: font('Palatino Linotype', 'serif', ['Book Antiqua', 'Palatino']),
      tahoma: font('Tahoma', 'sans-serif', ['Geneva']),
      timesNewRoman: font('Times New Roman', 'serif', ['Times']),
      trebuchetMs: font('Trebuchet MS', 'sans-serif'),
      verdana: font('Verdana', 'sans-serif', ['Geneva']),
    },
    fontSize: {
      large: measurement(1.125),
      medium: measurement(1),
      small: measurement(0.8125),
      xLarge: measurement(1.5),
      xSmall: measurement(0.625),
      xxLarge: measurement(2),
    },
    fontWeight: { bold: 700, light: 300, normal: 400 },
    letterSpacing: { compact: measurement(-1, 'px'), normal: 'normal', wide: measurement(6, 'px') },
    'lightning:dataProviders': [],
    'sfdc_cms:title': 'Phase 5 Discovery Brand',
    spacing: {
      large: inset(1.5),
      medium: inset(1),
      none: inset(0),
      small: inset(0.75),
      xLarge: inset(2),
      xSmall: inset(0.5),
    },
    typography: {
      button: { button1: typography('medium') },
      heading: {
        heading1: typography('xxLarge'),
        heading2: typography('xLarge'),
        heading3: typography('large'),
        heading4: typography('medium'),
        heading5: typography('small'),
        heading6: typography('xSmall'),
      },
      input: { input1: typography('medium') },
      label: { label1: typography('small') },
      paragraph: { paragraph1: typography('medium'), paragraph2: typography('small') },
    },
    'sfdc_cms:einsteinBrandProperties': {
      personality: { defaultPersonality: 'professional' },
    },
    'sfdc_cms:variants': [],
  };
}

function variant(): Record<string, unknown> {
  return {
    apiName: 'Phase_5_Discovery_Brand',
    contentBody: body(),
    contentFqn: 'marketing--workspace.sfdc_cms__brand--Phase_5_Discovery_Brand',
    contentKey: 'content-key',
    contentSpace: { id: 'space-source-id', resourceUrl: '/connect/cms/spaces/space' },
    contentType: { fullyQualifiedName: 'sfdc_cms__brand' },
    createdBy: { id: 'user-source-id', resourceUrl: '/users/user' },
    createdDate: '2026-09-30T18:52:32.000Z',
    externalId: null,
    folder: { id: 'folder-source-id', resourceUrl: '/connect/cms/folders/folder' },
    isPublished: false,
    language: 'en_US',
    lastModifiedBy: { id: 'user-source-id', resourceUrl: '/users/user' },
    lastModifiedDate: '2026-09-30T18:52:32.000Z',
    managedContentId: 'content-source-id',
    managedContentVariantId: 'variant-source-id',
    managedContentVersionId: 'version-source-id',
    status: { label: 'Draft', status: 'Draft' },
    title: 'Phase 5 Discovery Brand',
    urlName: 'phase-5-discovery-brand',
  };
}

describe('Brand semantic normalization', () => {
  it('normalizes the retained content and variant envelopes identically', () => {
    const variantValue = variant();
    const contentValue = {
      ...variantValue,
      contentType: { fullyQualifiedName: 'sfdc_cms__brand', name: 'Brand' },
      contentVersion: 1,
      variantVersion: '1.1',
    };
    expect(normalizeBrand(contentValue)).to.deep.equal(normalizeBrand(variantValue));
    expect(normalizeBrand(variantValue)?.unresolvedReferences).to.deep.equal([]);
  });

  it('keeps source identifiers out of portable semantics', () => {
    const normalization = normalizeBrand(variant());
    expect(normalization).not.to.equal(null);
    const portable = JSON.stringify(normalization?.semantic);
    for (const id of [
      'content-source-id',
      'variant-source-id',
      'space-source-id',
      'user-source-id',
    ]) {
      expect(portable).not.to.include(id);
    }
    expect(normalization?.provenance).to.deep.equal({
      contentSpaceId: 'space-source-id',
      managedContentId: 'content-source-id',
      managedContentVariantId: 'variant-source-id',
    });
  });

  it('fails closed on unknown, missing, malformed, non-Draft, and wrong-type evidence', () => {
    for (const mutate of [
      (value: Record<string, unknown>) => {
        value.extra = true;
      },
      (value: Record<string, unknown>) => {
        delete value.managedContentId;
      },
      (value: Record<string, unknown>) => {
        value.contentType = { fullyQualifiedName: 'sfdc_cms__form' };
      },
      (value: Record<string, unknown>) => {
        value.isPublished = true;
      },
      (value: Record<string, unknown>) => {
        value.status = { label: 'Published', status: 'Published' };
      },
      (value: Record<string, unknown>) => {
        (value.contentBody as Record<string, unknown>).extra = true;
      },
      (value: Record<string, unknown>) => {
        (value.contentBody as Record<string, unknown>)['lightning:dataProviders'] = [
          { id: 'provider' },
        ];
      },
      (value: Record<string, unknown>) => {
        value.title = 'Contradictory';
      },
    ]) {
      const value = variant();
      mutate(value);
      expect(normalizeBrand(value)).to.equal(null);
    }
  });
});

describe('Brand read reports', () => {
  it('builds and validates an identity-bound report', () => {
    const normalization = normalizeBrand(variant())!;
    const input = {
      workspaceId: 'space-source-id',
      apiName: 'Phase_5_Discovery_Brand',
      variantId: 'variant-source-id',
      rawItemPath: 'items/variant-source-id.json',
      normalization,
    };
    const report = buildBrandReadReport(input);
    expect(report.format).to.equal(BRAND_READ_REPORT_FORMAT);
    expect(validateBrandReadReport(report, input)).to.equal(true);
    expect(validateBrandReadReport({ ...report, variantId: 'other' })).to.equal(false);
    expect(validateBrandReadReport({ ...report, rawItemPath: 'reports/brand.json' })).to.equal(
      false,
    );
    expect(validateBrandReadReport({ ...report, extra: true })).to.equal(false);
  });
});
