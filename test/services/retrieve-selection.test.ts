import { expect } from 'chai';
import {
  normalizeRetrieveSelection,
  RETRIEVE_CONTENT_TYPES,
  type RetrieveSelectionFlags,
} from '../../src/services/retrieve-selection.js';

const email = 'sfdc_cms__email';
const template = 'sfdc_cms__emailTemplate';
const group = (
  contentType = email,
  all = false,
  apiNames: string[] = [],
  contentKeysOrIds: string[] = [],
) => ({
  contentType,
  all,
  apiNames,
  contentKeysOrIds,
});

describe('pure retrieve selector normalization', () => {
  it('defaults absent selection flags to detached all-of-type groups from the admitted canonical list', () => {
    const expected = {
      mode: 'all',
      groups: RETRIEVE_CONTENT_TYPES.map((type) => group(type, true)),
    };
    expect(normalizeRetrieveSelection(Object.freeze({}))).to.deep.equal(expected);
    const first = normalizeRetrieveSelection({ all: false });
    first.groups[0].apiNames.push('Not implicit');
    first.groups[1].contentKeysOrIds.push('Not implicit');
    first.groups.pop();
    expect(normalizeRetrieveSelection({ all: false })).to.deep.equal(expected);
  });
  it('normalizes repeatable exact API names and one distinct qualified type', () => {
    expect(
      normalizeRetrieveSelection({
        'content-type': [email, email],
        'api-name': ['Welcome', 'Welcome', 'welcome', ' Welcome ', 'a:b:c'],
      }),
    ).to.deep.equal({
      mode: 'api-name',
      groups: [group(email, false, ['Welcome', 'welcome', ' Welcome ', 'a:b:c'])],
    });
  });

  for (const image of [
    'sfdc_cms__image',
    'sfdc_cms__document',
    'sfdc_cms__audio',
    'sfdc_cms__brand',
  ]) {
    it(`admits ${image} exact, native, all and mixed metadata selectors`, () => {
      expect(
        normalizeRetrieveSelection({ 'content-type': [image], 'api-name': ['Hero'] }).groups,
      ).to.deep.equal([group(image, false, ['Hero'])]);
      expect(
        normalizeRetrieveSelection({ 'content-type': [image], 'content-key-or-id': ['key'] })
          .groups,
      ).to.deep.equal([group(image, false, [], ['key'])]);
      expect(
        normalizeRetrieveSelection({ 'content-type': [email, image], all: true }).groups,
      ).to.deep.equal([group(email, true), group(image, true)]);
      expect(
        normalizeRetrieveSelection({ metadata: [image, `${image}:Hero`, `${email}:Welcome`] })
          .groups,
      ).to.deep.equal([group(image, true, ['Hero']), group(email, false, ['Welcome'])]);
    });
  }

  it('keeps native selectors exact and deduplicates only identical values', () => {
    expect(
      normalizeRetrieveSelection({
        'content-type': [template],
        'content-key-or-id': ['20Ynative', 'MCkey', '20Ynative', 'mckey'],
      }),
    ).to.deep.equal({
      mode: 'content-key-or-id',
      groups: [group(template, false, [], ['20Ynative', 'MCkey', 'mckey'])],
    });
  });

  it('supports all of multiple explicit types without inventing a cross product', () => {
    expect(
      normalizeRetrieveSelection({
        'content-type': [template, email, template],
        all: true,
      }),
    ).to.deep.equal({ mode: 'all', groups: [group(template, true), group(email, true)] });
  });

  it('splits metadata on the first colon only and preserves exact name bytes', () => {
    expect(
      normalizeRetrieveSelection({
        metadata: [
          `${template}: A:B:c `,
          `${email}:Welcome`,
          `${template}: A:B:c `,
          `${email}:welcome`,
        ],
      }),
    ).to.deep.equal({
      mode: 'metadata',
      groups: [group(template, false, [' A:B:c ']), group(email, false, ['Welcome', 'welcome'])],
    });
  });

  it('deduplicates type-wide/exact overlap but retains explicit member validation obligations in either order', () => {
    for (const metadata of [
      [`${email}:Missing`, email, `${email}:Welcome`, email, `${email}:Missing`],
      [email, `${email}:Missing`, email, `${email}:Welcome`, `${email}:Missing`],
    ]) {
      expect(normalizeRetrieveSelection({ metadata })).to.deep.equal({
        mode: 'metadata',
        groups: [group(email, true, ['Missing', 'Welcome'])],
      });
    }
  });

  it('does not modify caller arrays and returns detached arrays on each call', () => {
    const flags = Object.freeze({
      metadata: Object.freeze([email, `${template}:Exact`]),
    });
    const result = normalizeRetrieveSelection(flags);
    result.groups[1].apiNames.push('Changed');
    expect(normalizeRetrieveSelection(flags)).to.deep.equal({
      mode: 'metadata',
      groups: [group(email, true), group(template, false, ['Exact'])],
    });
  });

  const invalid: Array<[string, RetrieveSelectionFlags]> = [
    ['type only', { 'content-type': [email] }],
    ['all without types', { all: true }],
    ['name without type', { 'api-name': ['Name'] }],
    ['native without type', { 'content-key-or-id': ['MCkey'] }],
    [
      'names and native',
      { 'content-type': [email], 'api-name': ['Name'], 'content-key-or-id': ['Key'] },
    ],
    ['all and names', { 'content-type': [email], all: true, 'api-name': ['Name'] }],
    ['all and native', { 'content-type': [email], all: true, 'content-key-or-id': ['Key'] }],
    ['multi-type names', { 'content-type': [email, template], 'api-name': ['Name'] }],
    ['multi-type native', { 'content-type': [email, template], 'content-key-or-id': ['Key'] }],
    ['metadata plus type', { metadata: [email], 'content-type': [email] }],
    ['metadata plus name', { metadata: [email], 'api-name': ['Name'] }],
    ['metadata plus native', { metadata: [email], 'content-key-or-id': ['Key'] }],
    ['metadata plus all', { metadata: [email], all: true }],
    ['empty metadata array', { metadata: [] }],
    ['empty type array', { 'content-type': [], all: true }],
    ['empty name array', { 'content-type': [email], 'api-name': [] }],
    ['empty native array', { 'content-type': [email], 'content-key-or-id': [] }],
  ];
  for (const value of [
    '',
    ' ',
    '\t',
    'unknown',
    'futureType',
    'sfdc_cms__futureType',
    'Audio',
    'sfdc_cms__Audio',
    'sfdc_cms__video',
    'sfdc_cms__Email',
    ` ${email}`,
    `${email} `,
  ]) {
    invalid.push(
      [`unsupported metadata type ${JSON.stringify(value)}`, { metadata: [value] }],
      [
        `unsupported separate type ${JSON.stringify(value)}`,
        { 'content-type': [value], all: true },
      ],
    );
  }
  for (const value of ['', ' ', '\t']) {
    invalid.push(
      [`empty exact metadata name ${JSON.stringify(value)}`, { metadata: [`${email}:${value}`] }],
      [
        `empty exact name ${JSON.stringify(value)}`,
        { 'content-type': [email], 'api-name': [value] },
      ],
      [
        `empty native ${JSON.stringify(value)}`,
        { 'content-type': [email], 'content-key-or-id': [value] },
      ],
    );
  }
  invalid.push(
    ['invalid explicit metadata under type-wide', { metadata: [email, `${email}: `] }],
    ['unknown metadata under type-wide', { metadata: [email, 'sfdc_cms__other:Name'] }],
  );
  for (const [label, flags] of invalid) {
    it(`rejects ${label}`, () => {
      expect(() => normalizeRetrieveSelection(flags)).to.throw(TypeError);
    });
  }

  for (const canonical of RETRIEVE_CONTENT_TYPES) {
    const short = canonical.slice('sfdc_cms__'.length);
    it(`canonicalizes both ${short} spellings before deduplication in every mode`, () => {
      const types = Object.freeze([short, canonical, short]);
      for (const selector of [
        { 'api-name': [' A:B:c ', ' A:B:c '] },
        { 'content-key-or-id': ['Opaque:Key', 'Opaque:Key'] },
        { all: true },
      ]) {
        expect(normalizeRetrieveSelection({ 'content-type': types, ...selector })).to.deep.equal(
          normalizeRetrieveSelection({ 'content-type': [canonical], ...selector }),
        );
      }
      const metadata = Object.freeze([
        `${short}: A:B:c `,
        canonical,
        `${canonical}: A:B:c `,
        short,
      ]);
      expect(normalizeRetrieveSelection({ metadata })).to.deep.equal({
        mode: 'metadata',
        groups: [group(canonical, true, [' A:B:c '])],
      });
      expect(types).to.deep.equal([short, canonical, short]);
      expect(metadata).to.deep.equal([
        `${short}: A:B:c `,
        canonical,
        `${canonical}: A:B:c `,
        short,
      ]);
    });
  }

  it('retains first canonical occurrence order across mixed alias metadata', () => {
    expect(
      normalizeRetrieveSelection({
        metadata: ['image:Hero', 'email', 'sfdc_cms__image', 'email:Exact'],
      }).groups,
    ).to.deep.equal([group('sfdc_cms__image', true, ['Hero']), group(email, true, ['Exact'])]);
  });

  it('treats false all as absent in metadata and exact modes', () => {
    expect(normalizeRetrieveSelection({ metadata: [email], all: false }).groups).to.deep.equal([
      group(email, true),
    ]);
    expect(
      normalizeRetrieveSelection({ 'content-type': [email], 'api-name': ['Name'], all: false })
        .mode,
    ).to.equal('api-name');
  });
});
