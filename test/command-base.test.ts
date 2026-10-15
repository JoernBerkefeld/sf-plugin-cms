import { Parser } from '@oclif/core';
import { Org } from '@salesforce/core';
import { expect } from 'chai';
import sinon from 'sinon';
import { CmsCommand, apiVersionFlag } from '../src/command-base.js';
import { getCmsApiSelection } from '../src/api-policy.js';

class Command extends CmsCommand<void> {
  public async run(): Promise<void> {}
  public context(version: string) {
    return this.getOrgContext('target', version);
  }
}

describe('CMS command API selection', () => {
  afterEach(() => sinon.restore());

  it('accepts latest and explicit numeric API flags, but rejects malformed versions', async () => {
    for (const version of ['latest', '68.0']) {
      const parsed = await Parser.parse(['--api-version', version], {
        flags: { 'api-version': apiVersionFlag },
      });
      expect(parsed.flags['api-version']).to.equal(version);
    }
    let error: unknown;
    try {
      await Parser.parse(['--api-version', 'v68.0'], { flags: { 'api-version': apiVersionFlag } });
    } catch (error_) {
      error = error_;
    }
    expect(error).to.be.instanceOf(Error);
  });

  it('defaults to latest and bootstraps Core with a numeric version', async () => {
    expect(apiVersionFlag.default).to.equal('latest');
    const request = sinon.stub().resolves({});
    request.onFirstCall().resolves([{ version: '68.0' }]);
    const connection = {
      version: '67.0',
      getApiVersion() {
        return this.version;
      },
      setApiVersion(version: string) {
        this.version = version;
      },
      request,
    };
    const getConnection = sinon.stub().returns(connection);
    sinon.stub(Org, 'create').resolves({ getConnection, getOrgId: () => 'org' } as unknown as Org);
    const command = new Command([], {} as never);
    const context = await command.context('latest');
    expect(getConnection.calledOnceWithExactly('67.0')).to.equal(true);
    expect(context.orgId).to.equal('org');
    expect(getCmsApiSelection(context.connection).effectiveApiVersion).to.equal('68.0');
    expect(connection.version).to.equal('68.0');
  });
});
