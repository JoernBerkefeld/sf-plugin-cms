import { expect } from 'chai';
import {
  assertCanonicalContentKey,
  CANONICAL_CONTENT_KEY_PATTERN,
} from '../../src/services/content-key.js';

const VALID_CONTENT_KEY = 'MCAAAAAAAAAAAAAAAAAAAAAAAAAA';

describe('canonical Enhanced CMS content keys', () => {
  it('accepts the exact MC plus 26 base32-character format', () => {
    expect(() => assertCanonicalContentKey(VALID_CONTENT_KEY, 'contentKey')).not.to.throw();
    expect(() =>
      assertCanonicalContentKey('MCABCDEFGHIJKLMNOPQRSTUVWXYZ', 'contentKey'),
    ).not.to.throw();
    expect(() =>
      assertCanonicalContentKey('MC234567ABCDEFGHIJKLMNOPQRST', 'contentKey'),
    ).not.to.throw();
  });

  for (const [label, value] of [
    ['wrong short length', 'MCAAAAAAAAAAAAAAAAAAAAAAAAA'],
    ['wrong long length', 'MCAAAAAAAAAAAAAAAAAAAAAAAAAAA'],
    ['underscores', 'MC_AAAAAAAAAAAAAAAAAAAAAAAAA'],
    ['lowercase', 'MCaAAAAAAAAAAAAAAAAAAAAAAAAA'],
    ['forbidden zero', 'MC0AAAAAAAAAAAAAAAAAAAAAAAAA'],
    ['forbidden one', 'MC1AAAAAAAAAAAAAAAAAAAAAAAAA'],
    ['forbidden eight', 'MC8AAAAAAAAAAAAAAAAAAAAAAAAA'],
    ['forbidden nine', 'MC9AAAAAAAAAAAAAAAAAAAAAAAAA'],
  ] as const) {
    it(`rejects ${label}`, () => {
      expect(() => assertCanonicalContentKey(value, 'contentKey')).to.throw(
        `contentKey must match ${CANONICAL_CONTENT_KEY_PATTERN}`,
      );
    });
  }
});
