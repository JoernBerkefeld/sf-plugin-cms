import { expect } from 'chai';
import {
  EMAIL_FRAGMENT_SOURCE_CONTRACT,
  EMAIL_FRAGMENT_SOURCE_VERSION,
  assertEmailFragmentSourceDefinition,
  assertSingleDefaultEmailFragmentVariant,
  serializeEmailFragmentSourceDefinition,
  expectedEmailFragmentDefinition,
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
  it('derives only operation-qualified envelopes without changing source or any authored body value', () => {
    const value = fixture();
    const before = structuredClone(value);
    value.contentBody['sfdc_cms:title'] = 'New ordinary title';
    const edited = structuredClone(value);
    const expected = expectedEmailFragmentDefinition(value, 'update', 'Destination');
    expect(expected.title).to.equal('New ordinary title');
    expect(expected.contentBody).to.deep.equal(edited.contentBody);
    expect(value).to.deep.equal(edited);
    expect(() => expectedEmailFragmentDefinition(value, 'create', 'Destination')).to.throw(
      'Unsupported derived envelope',
    );
    value.contentBody['sfdc_cms:title'] = `${before.title} `;
    expect(expectedEmailFragmentDefinition(value, 'create', 'Destination').title).to.equal(
      before.title,
    );
    expect(() => expectedEmailFragmentDefinition(value, 'update', 'Destination')).to.throw(
      'Unsupported derived envelope',
    );
    const native = structuredClone(value);
    native.identity.context.workspaceApiName = 'Destination';
    expect(expectedEmailFragmentDefinition(value, 'update', 'Destination', native)).to.deep.equal(
      native,
    );
  });
  it('qualifies ordinary ASCII titles without fixture-name restrictions and returns detached expectations', () => {
    for (const title of ['X', 'A  repeated space', '! punctuation ~', 'Unrelated 789']) {
      const value = fixture();
      value.contentBody['sfdc_cms:title'] = title;
      const before = structuredClone(value);
      const expected = expectedEmailFragmentDefinition(value, 'update', 'Destination');
      expect(expected).to.deep.equal({
        ...before,
        title,
        identity: { ...before.identity, context: { workspaceApiName: 'Destination' } },
      });
      expect(value).to.deep.equal(before);
      expect(expected.contentBody).not.to.equal(value.contentBody);
      expect(expected.identity.context).not.to.equal(value.identity.context);
      expect(expected.folderPath).not.to.equal(value.folderPath);
      const otherNative = structuredClone(expected);
      otherNative.title = 'Unexpected native envelope';
      expect(serializeEmailFragmentSourceDefinition(expected)).not.to.equal(
        serializeEmailFragmentSourceDefinition(otherNative),
      );
      value.title = title;
      expect(expectedEmailFragmentDefinition(value, 'create', 'Destination').title).to.equal(title);
    }
  });
  it('rejects unknown changed-write derivations while preserving exact observed unchanged pairs', () => {
    for (const title of [
      undefined,
      '',
      ' leading',
      'trailing ',
      'two  ',
      '\tTab',
      'Line\n',
      'Line\r\n',
      'Café',
      '\u00A0Title',
      'Title\u2003',
    ]) {
      const value = fixture();
      if (title === undefined) delete value.contentBody['sfdc_cms:title'];
      else value.contentBody['sfdc_cms:title'] = title;
      const before = structuredClone(value);
      for (const operation of ['create', 'update'] as const) {
        expect(() => expectedEmailFragmentDefinition(value, operation, 'Destination')).to.throw(
          'Unsupported derived envelope',
        );
        const native = structuredClone(value);
        native.identity.context.workspaceApiName = 'Destination';
        const expected = expectedEmailFragmentDefinition(value, operation, 'Destination', native);
        expect(expected).to.deep.equal(native);
        expect(expected).not.to.equal(native);
        native.contentBody['extra-field'] = true;
        expect(() =>
          expectedEmailFragmentDefinition(value, operation, 'Destination', native),
        ).to.throw('Unsupported derived envelope');
      }
      expect(value).to.deep.equal(before);
    }
  });
  it('does not extend CREATE qualification to arbitrary divergent envelopes or boundary titles', () => {
    for (const envelope of ['', ' Leading', 'Trailing ', 'Café']) {
      const value = fixture();
      value.title = envelope;
      value.contentBody['sfdc_cms:title'] = envelope;
      expect(() => expectedEmailFragmentDefinition(value, 'create', 'Destination')).to.throw(
        'Unsupported derived envelope',
      );
    }
    const value = fixture();
    value.contentBody['sfdc_cms:title'] = `${value.title}  `;
    expect(() => expectedEmailFragmentDefinition(value, 'create', 'Destination')).to.throw(
      'Unsupported derived envelope',
    );
  });
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
