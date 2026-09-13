import { TestContext } from '@salesforce/core/testSetup';
import { stubSfCommandUx } from '@salesforce/sf-plugins-core';
import { expect } from 'chai';
import Info from '../../../src/commands/cms/info.js';

describe('cms info', () => {
  const context = new TestContext();

  beforeEach(() => {
    stubSfCommandUx(context.SANDBOX);
  });

  afterEach(() => {
    context.restore();
  });

  it('loads and reports scaffold status without an org', async () => {
    const result = await Info.run([]);

    expect(result).to.deep.equal({ name: 'sf-plugin-cms', status: 'scaffold' });
  });
});
