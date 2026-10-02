import { TestContext } from '@salesforce/core/testSetup';
import { expect } from 'chai';
import PublishContent from '../../src/commands/cms/publish/content.js';

describe('cms publish content command', () => {
  const context = new TestContext();
  beforeEach(() => {
    process.exitCode = undefined;
  });
  afterEach(() => {
    context.restore();
    process.exitCode = undefined;
  });

  it('blocks apply without the no-send acknowledgement before org access', async () => {
    const command = Object.create(PublishContent.prototype) as PublishContent;
    const getOrgContext = context.SANDBOX.stub();
    Object.assign(command, {
      parse: context.SANDBOX.stub().resolves({
        flags: {
          'target-org': 'org',
          'api-version': '67.0',
          'contract-version': 1,
          'workspace-id': 'space',
          'api-name': 'Email',
          language: 'en_US',
          'default-language': false,
          apply: true,
          'report-dir': 'report',
          'acknowledge-no-send': false,
        },
      }),
      getOrgContext,
      jsonEnabled: context.SANDBOX.stub().returns(true),
    });
    const result = await command.run();
    expect(result.status).to.equal('blocked');
    expect(result.diagnostics.errors[0].code).to.equal('NO_SEND_ACKNOWLEDGEMENT_REQUIRED');
    expect(getOrgContext.notCalled).to.equal(true);
  });

  it('blocks apply without a report directory before org access', async () => {
    const command = Object.create(PublishContent.prototype) as PublishContent;
    const getOrgContext = context.SANDBOX.stub();
    Object.assign(command, {
      parse: context.SANDBOX.stub().resolves({
        flags: {
          'target-org': 'org',
          'api-version': '67.0',
          'contract-version': 1,
          'workspace-id': 'space',
          'api-name': 'Email',
          language: 'en_US',
          'default-language': false,
          apply: true,
          'acknowledge-no-send': true,
        },
      }),
      getOrgContext,
      jsonEnabled: context.SANDBOX.stub().returns(true),
    });
    const result = await command.run();
    expect(result.status).to.equal('blocked');
    expect(result.diagnostics.errors[0].code).to.equal('REPORT_DIRECTORY_REQUIRED');
    expect(getOrgContext.notCalled).to.equal(true);
  });
});
