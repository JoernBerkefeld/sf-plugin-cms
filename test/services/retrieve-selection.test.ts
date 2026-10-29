import { expect } from 'chai';
import {
  normalizeRetrieveSelection,
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
  for (const image of ['sfdc_cms__audio']) {
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

  const invalid: Array<[string, RetrieveSelectionFlags]> = [];
  for (const value of ['Audio', 'sfdc_cms__Audio']) {
    invalid.push(
      [`unsupported metadata type ${JSON.stringify(value)}`, { metadata: [value] }],
      [
        `unsupported separate type ${JSON.stringify(value)}`,
        { 'content-type': [value], all: true },
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

  for (const canonical of ['sfdc_cms__audio']) {
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
});
