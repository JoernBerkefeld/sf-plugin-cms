import { TestContext } from '@salesforce/core/testSetup';
import { stubSfCommandUx } from '@salesforce/sf-plugins-core';
import { expect } from 'chai';
import Info from '../../../src/commands/cms/info.js';

describe('cms info', () => {
  const context = new TestContext();

  beforeEach(() => {
    stubSfCommandUx(context.SANDBOX);
    process.exitCode = undefined;
  });

  afterEach(() => {
    context.restore();
    process.exitCode = undefined;
  });

  for (const requestedVersion of [undefined, 1]) {
    it(`reports the frozen offline capability envelope for contract major ${requestedVersion ?? 'default'}`, async () => {
      const command = Object.create(Info.prototype) as Info;
      Object.assign(command, {
        parse: context.SANDBOX.stub().resolves({
          flags: { 'contract-version': requestedVersion ?? 1 },
        }),
        jsonEnabled: context.SANDBOX.stub().returns(true),
      });

      const result = await command.run();

      expect(result.status).to.equal('success');
      expect(result.metadata).to.deep.include({ operation: 'cms.info', apiVersion: null });
      expect(result.provenance.sourceOrgId).to.equal('offline');
      expect(result.result?.plugin).to.deep.equal({ name: 'sf-plugin-cms', version: '0.3.0' });
      expect(result.result?.api).to.deep.equal({
        defaultVersion: '67.0',
        testedVersions: ['67.0'],
      });
      expect(result.result?.contracts.embeddedResults.externalReferenceCorrelations).to.deep.equal([
        'sf-cms-external-reference-correlations@1',
      ]);
      expect(result.result?.capabilities).to.deep.equal([
        {
          id: 'workspace.export.bulk',
          state: 'implemented',
          transport: 'cli-json',
          contract: 'sf-cms-workspace-export-set@1',
        },
        {
          id: 'workspace.export.dependency-closure',
          state: 'unavailable',
          transport: 'cli-json',
          contract: 'unavailable',
        },
        {
          id: 'workspace.export.external-reference-correlation',
          state: 'experimental',
          transport: 'cli-json',
          contract: 'sf-cms-external-reference-correlations@1',
        },
        {
          id: 'workspace.import.mapping',
          state: 'experimental',
          transport: 'cli-json',
          contract: 'sf-cms-workspace-import@1',
        },
      ]);
      expect(process.exitCode).to.equal(0);
    });
  }

  it('blocks an unsupported contract version offline', async () => {
    const command = Object.create(Info.prototype) as Info;
    Object.assign(command, {
      parse: context.SANDBOX.stub().resolves({ flags: { 'contract-version': 2 } }),
      jsonEnabled: context.SANDBOX.stub().returns(true),
    });
    const result = await command.run();

    expect(result).to.deep.include({
      contract: 'sf-cms-info',
      contractVersion: '1.0.0',
      status: 'blocked',
      result: null,
    });
    expect(result.diagnostics.errors).to.deep.equal([
      {
        code: 'UNSUPPORTED_CONTRACT_VERSION',
        message: 'Contract major 2 is unsupported; supported major is 1.',
        retryable: false,
      },
    ]);
    expect(process.exitCode).to.equal(1);
  });

  it('renders the same envelope in human mode', async () => {
    const command = Object.create(Info.prototype) as Info;
    const styledJSON = context.SANDBOX.stub();
    Object.assign(command, {
      parse: context.SANDBOX.stub().resolves({ flags: { 'contract-version': 1 } }),
      jsonEnabled: context.SANDBOX.stub().returns(false),
      styledJSON,
    });
    const result = await command.run();

    expect(styledJSON.calledOnceWithExactly(result)).to.equal(true);
  });
});
