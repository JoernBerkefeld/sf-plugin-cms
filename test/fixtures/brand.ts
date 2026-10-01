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

export function brandBody(title = 'Phase 5 Discovery Brand'): Record<string, unknown> {
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
    'sfdc_cms:title': title,
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

export function brandDetail(
  id = 'variant-source-id',
  apiName = 'Phase_5_Discovery_Brand',
  workspaceId = 'space',
): Record<string, unknown> {
  const title = 'Phase 5 Discovery Brand';
  return {
    apiName,
    contentBody: brandBody(title),
    contentFqn: `marketing--workspace.sfdc_cms__brand--${apiName}`,
    contentKey: 'content-key',
    contentSpace: { id: workspaceId, resourceUrl: `/connect/cms/spaces/${workspaceId}` },
    contentType: { fullyQualifiedName: 'sfdc_cms__brand' },
    createdBy: { id: 'user-source-id', resourceUrl: '/users/user' },
    createdDate: '2026-09-30T18:52:32.000Z',
    externalId: null,
    folder: { id: 'folder-source-id', resourceUrl: '/connect/cms/folders/folder' },
    isPublished: false,
    language: 'en_US',
    lastModifiedBy: { id: 'user-source-id', resourceUrl: '/users/user' },
    lastModifiedDate: '2026-09-30T18:52:32.000Z',
    managedContentId: `content-${id}`,
    managedContentVariantId: id,
    managedContentVersionId: `version-${id}`,
    status: { label: 'Draft', status: 'Draft' },
    title,
    urlName: apiName.toLowerCase().replaceAll('_', '-'),
  };
}
