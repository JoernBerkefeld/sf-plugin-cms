import { expect } from 'chai';
import { normalizeContentTypeAlias } from '../../src/services/content-type-alias.js';

describe('operation-scoped content type aliases', () => {
  it('automatically shortens a future admitted canonical CMS type without a registry entry', () => {
    const admitted = Object.freeze(['sfdc_cms__futureType', 'external__type'] as const);
    expect(normalizeContentTypeAlias('futureType', admitted)).to.equal('sfdc_cms__futureType');
    expect(normalizeContentTypeAlias('sfdc_cms__futureType', admitted)).to.equal(
      'sfdc_cms__futureType',
    );
    expect(normalizeContentTypeAlias('external__type', admitted)).to.equal('external__type');
    expect(normalizeContentTypeAlias('type', admitted)).to.equal(undefined);
    expect(admitted).to.deep.equal(['sfdc_cms__futureType', 'external__type']);
  });

  for (const value of [
    'unknown',
    'sfdc_cms__unknown',
    'FutureType',
    'sfdc_cms__FutureType',
    ' futureType',
    'futureType ',
    'futureType:Name',
    '',
  ]) {
    it(`rejects unadmitted or inexact spelling ${JSON.stringify(value)}`, () => {
      expect(normalizeContentTypeAlias(value, ['sfdc_cms__futureType'])).to.equal(undefined);
    });
  }

  it('does not admit a type merely because it has the CMS prefix', () => {
    expect(normalizeContentTypeAlias('sfdc_cms__futureType', [])).to.equal(undefined);
    expect(normalizeContentTypeAlias('futureType', [])).to.equal(undefined);
  });
});
