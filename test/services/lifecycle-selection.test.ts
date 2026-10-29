import { expect } from 'chai';
import { normalizeLifecycleMetadata } from '../../src/services/lifecycle-selection.js';

describe('pure lifecycle metadata normalization', () => {
  it('rejects an empty selection instead of expanding to all content', () => {
    expect(() => normalizeLifecycleMetadata([])).to.throw(TypeError);
  });

  for (const value of [
    'emailFragment:*',
    'emailFragment:Welcome?',
    'email:Welcome*',
    'image:[Hero]',
    'audio:{One,Two}',
  ]) {
    it(`rejects malformed or unsupported selector ${JSON.stringify(value)}`, () => {
      expect(() => normalizeLifecycleMetadata([value])).to.throw(TypeError);
    });
  }

  it('rejects a malformed later member rather than returning a valid prefix', () => {
    expect(() => normalizeLifecycleMetadata(['email:Welcome', 'image'])).to.throw(TypeError);
  });
});
