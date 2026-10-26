import { expect } from 'chai';
import {
  EMAIL_FRAGMENT_SOURCE_CONTRACT,
  EMAIL_FRAGMENT_SOURCE_VERSION,
  assertEmailFragmentSourceDefinition,
  assertSingleDefaultEmailFragmentVariant,
  serializeEmailFragmentSourceDefinition,
  type EmailFragmentSourceDefinition,
} from '../../src/contracts/email-fragment-source.js';

const uuid = (index: number): string =>
  `10000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
const component = (
  index: number,
  definition: string,
  children?: unknown[],
): Record<string, unknown> => ({
  id: uuid(index),
  definition,
  type: 'block',
  ...(children ? { children } : {}),
  attributes:
    definition === 'lightning/paragraph'
      ? { text: ' English\r\n<p>Café &amp; 世界</p> ' }
      : { columnWidth: 6 },
});
function fixture(): EmailFragmentSourceDefinition {
  return {
    contract: EMAIL_FRAGMENT_SOURCE_CONTRACT,
    contractVersion: EMAIL_FRAGMENT_SOURCE_VERSION,
    identity: {
      family: 'cms',
      type: 'Email Fragment',
      apiName: 'Synthetic_Fragment',
      context: { workspaceApiName: 'Synthetic_Workspace' },
    },
    contentType: 'sfdc_cms__emailFragment',
    language: 'en_US',
    title: 'Synthetic title',
    urlName: 'synthetic-fragment',
    folderPath: ['Nested', 'Blocks'],
    contentBody: {
      'sfdc_cms:title': 'Synthetic title',
      'sfdc_cms:urlName': 'synthetic-fragment',
      'sfdc_cms:variants': [],
      'sfdc_cms:attachments': [],
      'lightning:brandSource': { defaultBrandOption: 'sfdcBrand' },
      'lightning:dataProviders': [
        {
          attributes: { dataGraphApiName: 'Marketing', dataspace: 'default' },
          definition: 'sfdc_cms__dataGraphDataProvider',
          sfdcExpressionKey: '$dataGraph',
        },
      ],
      'sfdc_cms:block': component(1, 'sfdc_cms/rootContentBlock', [
        component(2, 'lightning/section', [
          component(3, 'lightning/column', [
            component(4, 'lightning/paragraph'),
            component(5, 'lightning/paragraph'),
          ]),
          component(6, 'lightning/column', [component(7, 'lightning/paragraph')]),
        ]),
      ]) as EmailFragmentSourceDefinition['contentBody'][string],
    },
  };
}
function root(value: EmailFragmentSourceDefinition): Record<string, unknown> {
  return value.contentBody['sfdc_cms:block'] as Record<string, unknown>;
}

describe('single-default Email Fragment source', () => {
  it('preserves full multicolumn content, authored IDs, folders, providers and exact text', () => {
    const value = fixture();
    const before = structuredClone(value);
    assertEmailFragmentSourceDefinition(value);
    expect(value).to.deep.equal(before);
    const text = serializeEmailFragmentSourceDefinition(value);
    expect(JSON.parse(text)).to.deep.equal(before);
    for (let index = 1; index <= 7; index++) expect(text).to.include(uuid(index));
    expect(text).to.include(String.raw`English\r\n<p>Café &amp; 世界</p>`);
  });
  it('preserves optional authored metadata independently of required envelope metadata', () => {
    for (const metadata of [
      {},
      { 'sfdc_cms:title': 'Synthetic title ' },
      { 'sfdc_cms:title': '', 'sfdc_cms:urlName': 'independent-body-url ' },
      { 'sfdc_cms:urlName': '' },
    ]) {
      const value = fixture();
      delete value.contentBody['sfdc_cms:title'];
      delete value.contentBody['sfdc_cms:urlName'];
      Object.assign(value.contentBody, metadata);
      const before = structuredClone(value);
      assertEmailFragmentSourceDefinition(value);
      expect(value).to.deep.equal(before);
      expect(JSON.parse(serializeEmailFragmentSourceDefinition(value))).to.deep.equal(before);
    }
  });
  it('canonicalizes keys without reordering arrays and emits one terminal LF', () => {
    const value = fixture();
    const reversed = Object.fromEntries(
      Object.entries(value).toReversed(),
    ) as EmailFragmentSourceDefinition;
    expect(serializeEmailFragmentSourceDefinition(reversed)).to.equal(
      serializeEmailFragmentSourceDefinition(value),
    );
    const text = serializeEmailFragmentSourceDefinition(value);
    expect(text.endsWith('\n')).to.equal(true);
    expect(text.endsWith('\n\n')).to.equal(false);
    expect(text).not.to.include('\r');
    expect(text.codePointAt(0)).not.to.equal(65_279);
  });
  it('admits English alone despite unused enabled German and preserves API language spelling', () => {
    const workspace = { defaultLanguage: 'en_US', enabledLanguages: ['en_US', 'de'] };
    expect(workspace.enabledLanguages).to.have.length(2);
    assertSingleDefaultEmailFragmentVariant(
      [{ Language: 'en_US', IsPrimary: true, VariantType: 'Content' }],
      workspace.defaultLanguage,
    );
    const value = fixture();
    value.language = 'de';
    assertEmailFragmentSourceDefinition(value);
    expect(JSON.parse(serializeEmailFragmentSourceDefinition(value)).language).to.equal('de');
  });
  it('rejects extra actual translations/custom variants and missing/non-default siblings', () => {
    const primary = { Language: 'en_US', IsPrimary: true, VariantType: 'Content' };
    for (const extra of [
      { Language: 'de', IsPrimary: false, VariantType: 'Translation' },
      { ...primary },
    ]) {
      expect(() => assertSingleDefaultEmailFragmentVariant([primary, extra], 'en_US')).to.throw(
        'additional actual variants',
      );
    }
    for (const variants of [
      [],
      [{ ...primary, IsPrimary: false }],
      [{ ...primary, VariantType: 'Translation' }],
      [{ ...primary, Language: 'en_us' }],
    ]) {
      expect(() => assertSingleDefaultEmailFragmentVariant(variants, 'en_US')).to.throw();
    }
    expect(() => assertSingleDefaultEmailFragmentVariant([primary], '')).to.throw();
  });
  const mutations: Array<[string, (value: EmailFragmentSourceDefinition) => void]> = [
    ['extra top-level fields', (value) => Object.assign(value, { variants: [{}] })],
    ['wrong contract', (value) => Object.assign(value, { contract: 'other' })],
    ['wrong version', (value) => Object.assign(value, { contractVersion: '2' })],
    ['wrong content type', (value) => Object.assign(value, { contentType: 'sfdc_cms__email' })],
    ['wrong identity', (value) => Object.assign(value.identity, { type: 'Email' })],
    [
      'unsafe name',
      (value) => {
        value.identity.apiName = '../escape';
      },
    ],
    [
      'unsafe workspace',
      (value) => {
        value.identity.context.workspaceApiName = '..';
      },
    ],
    [
      'unsafe folders',
      (value) => {
        value.folderPath = ['..'];
      },
    ],
    ['missing folders', (value) => Object.assign(value, { folderPath: undefined })],
    [
      'inexact language',
      (value) => {
        value.language = 'English (US)';
      },
    ],
    [
      'missing envelope title',
      (value) => {
        Object.assign(value, { title: undefined });
      },
    ],
    ['non-string envelope URL', (value) => Object.assign(value, { urlName: 1 })],
    ['empty envelope title', (value) => Object.assign(value, { title: '' })],
    [
      'non-string authored title',
      (value) => {
        value.contentBody['sfdc_cms:title'] = null;
      },
    ],
    [
      'non-string authored URL',
      (value) => {
        value.contentBody['sfdc_cms:urlName'] = 1;
      },
    ],
    [
      'empty metadata',
      (value) => {
        value.urlName = '';
      },
    ],
    [
      'missing root',
      (value) => {
        delete value.contentBody['sfdc_cms:block'];
      },
    ],
    [
      'wrong root',
      (value) => {
        root(value).definition = 'lightning/paragraph';
      },
    ],
    [
      'invalid structural ID',
      (value) => {
        root(value).id = 'native-id';
      },
    ],
    [
      'duplicate structural IDs',
      (value) => {
        (root(value).children as Array<Record<string, unknown>>)[0].id = uuid(1);
      },
    ],
    [
      'malformed children',
      (value) => {
        root(value).children = {};
      },
    ],
    [
      'malformed attributes',
      (value) => {
        root(value).attributes = [];
      },
    ],
    [
      'authored variants',
      (value) => {
        value.contentBody['sfdc_cms:variants'] = [{}];
      },
    ],
    [
      'native locator',
      (value) => {
        value.contentBody.workspaceId = '0Zuaj000007dgL8CAI';
      },
    ],
    [
      'native ID value',
      (value) => {
        value.contentBody.native = '0Zuaj000007dgL8CAI';
      },
    ],
    [
      'unapproved nested ID',
      (value) => {
        value.contentBody.reference = { contentId: uuid(8) };
      },
    ],
    [
      'raw HTML companion',
      (value) => {
        value.contentBody.rawHtml = '<p>wrong representation</p>';
      },
    ],
    ['undefined data', (value) => Object.assign(value.contentBody, { invalid: undefined })],
    [
      'nonfinite number',
      (value) => {
        value.contentBody.invalid = Number.NaN;
      },
    ],
    ['non-JSON object', (value) => Object.assign(value.contentBody, { invalid: new Date() })],
    [
      'sparse array',
      (value) => {
        value.contentBody.invalid = Array.from({ length: 1 });
      },
    ],
  ];
  for (const [label, mutate] of mutations)
    it(`rejects ${label}`, () => {
      const value = fixture();
      mutate(value);
      expect(() => assertEmailFragmentSourceDefinition(value)).to.throw();
      expect(() => serializeEmailFragmentSourceDefinition(value)).to.throw();
    });
});
