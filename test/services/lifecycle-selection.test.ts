import { expect } from 'chai';
import { normalizeLifecycleMetadata } from '../../src/services/lifecycle-selection.js';

const types = [
  'sfdc_cms__email',
  'sfdc_cms__emailTemplate',
  'sfdc_cms__image',
  'sfdc_cms__document',
  'sfdc_cms__audio',
] as const;

describe('pure lifecycle metadata normalization', () => {
  for (const contentType of types) {
    for (const spelling of [contentType, contentType.slice('sfdc_cms__'.length)]) {
      it(`normalizes exact ${spelling} selectors`, () => {
        expect(normalizeLifecycleMetadata([`${spelling}:Welcome`])).to.deep.equal([
          { contentType, apiName: 'Welcome' },
        ]);
      });
    }
  }

  it('preserves order, interleaved families, API spelling and duplicate selectors', () => {
    expect(
      normalizeLifecycleMetadata([
        'image:Hero',
        'email: Welcome ',
        'email:welcome',
        'image:Hero',
        'sfdc_cms__image:Hero',
      ]),
    ).to.deep.equal([
      { contentType: 'sfdc_cms__image', apiName: 'Hero' },
      { contentType: 'sfdc_cms__email', apiName: ' Welcome ' },
      { contentType: 'sfdc_cms__email', apiName: 'welcome' },
      { contentType: 'sfdc_cms__image', apiName: 'Hero' },
      { contentType: 'sfdc_cms__image', apiName: 'Hero' },
    ]);
  });

  it('does not mutate frozen input and returns detached selector objects on every call', () => {
    const values = Object.freeze(['email:Welcome', 'email:Welcome']);
    const first = normalizeLifecycleMetadata(values);
    expect(first[0]).not.to.equal(first[1]);
    first[0].apiName = 'Changed';
    expect(normalizeLifecycleMetadata(values)).to.deep.equal([
      { contentType: 'sfdc_cms__email', apiName: 'Welcome' },
      { contentType: 'sfdc_cms__email', apiName: 'Welcome' },
    ]);
    expect(values).to.deep.equal(['email:Welcome', 'email:Welcome']);
  });

  it('rejects an empty selection instead of expanding to all content', () => {
    expect(() => normalizeLifecycleMetadata([])).to.throw(TypeError);
  });

  for (const value of [
    '',
    ' ',
    'email',
    'sfdc_cms__email',
    ':Welcome',
    'email:',
    'email: \t ',
    'email:Welcome:Other',
    'email::Welcome',
    'email:Welcome:',
    'Email:Welcome',
    'emailtemplate:Welcome',
    'sfdc_cms__Email:Welcome',
    'video:Welcome',
    'sfdc_cms__video:Welcome',
    'other__email:Welcome',
    ' email:Welcome',
    'email :Welcome',
    'email/Welcome',
  ]) {
    it(`rejects malformed or unsupported selector ${JSON.stringify(value)}`, () => {
      expect(() => normalizeLifecycleMetadata([value])).to.throw(TypeError);
    });
  }

  it('rejects a malformed later member rather than returning a valid prefix', () => {
    expect(() => normalizeLifecycleMetadata(['email:Welcome', 'image'])).to.throw(TypeError);
  });

  it('rejects non-string members at the runtime boundary', () => {
    for (const value of [null, undefined, 42, {}, ['email:Welcome']]) {
      expect(() => normalizeLifecycleMetadata([value as string])).to.throw(TypeError);
    }
  });
});
