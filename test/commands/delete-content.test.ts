import { TestContext } from '@salesforce/core/testSetup';
import { expect } from 'chai';
import DeleteContent from '../../src/commands/cms/delete/content.js';

describe('cms delete content command', () => {
  const context = new TestContext();
  beforeEach(() => {
    process.exitCode = undefined;
  });
  afterEach(() => {
    context.restore();
    process.exitCode = undefined;
  });

  it('requires contract v2 for Email Template before org access', async () => {
    const command = Object.create(DeleteContent.prototype) as DeleteContent;
    const getOrgContext = context.SANDBOX.stub();
    Object.assign(command, {
      parse: context.SANDBOX.stub().resolves({
        flags: {
          'target-org': 'org',
          'api-version': '67.0',
          'contract-version': 1,
          'content-type': 'sfdc_cms__emailTemplate',
          'workspace-id': 'space',
          'api-name': 'Template',
          language: 'en_US',
          'default-language': false,
          'ownership-report': 'ownership.json',
          apply: false,
        },
      }),
      getOrgContext,
      jsonEnabled: context.SANDBOX.stub().returns(true),
    });
    const result = await command.run();
    expect(result.status).to.equal('blocked');
    expect(result.diagnostics.errors[0].code).to.equal('UNSUPPORTED_CONTRACT_VERSION');
    expect(getOrgContext.notCalled).to.equal(true);
  });

  for (const invalid of [
    {
      label: 'missing language selector',
      overrides: { language: undefined, 'default-language': false, apply: false },
      diagnostic: 'LANGUAGE_SELECTOR_REQUIRED',
    },
    {
      label: 'missing report directory',
      overrides: { apply: true, 'acknowledge-permanent-delete': true, 'report-dir': undefined },
      diagnostic: 'REPORT_DIRECTORY_REQUIRED',
    },
    {
      label: 'missing acknowledgement',
      overrides: { apply: true, 'acknowledge-permanent-delete': false, 'report-dir': 'report' },
      diagnostic: 'PERMANENT_DELETE_ACKNOWLEDGEMENT_REQUIRED',
    },
  ]) {
    it(`returns Template v2 for ${invalid.label} before org access`, async () => {
      const command = Object.create(DeleteContent.prototype) as DeleteContent;
      const getOrgContext = context.SANDBOX.stub();
      Object.assign(command, {
        parse: context.SANDBOX.stub().resolves({
          flags: {
            'target-org': 'org',
            'api-version': '67.0',
            'contract-version': 2,
            'content-type': 'sfdc_cms__emailTemplate',
            'workspace-id': 'space',
            'api-name': 'Template',
            language: 'en_US',
            'default-language': false,
            'ownership-report': 'ownership.json',
            ...invalid.overrides,
          },
        }),
        getOrgContext,
        jsonEnabled: context.SANDBOX.stub().returns(true),
      });
      const result = await command.run();
      expect(result).to.deep.include({ contractVersion: '2.0.0', status: 'blocked' });
      expect(result.diagnostics.errors[0].code).to.equal(invalid.diagnostic);
      expect(result.result?.blockers[0]?.code).to.equal('EMAIL_TEMPLATE_DELETE_PREFLIGHT_BLOCKED');
      expect(getOrgContext.notCalled).to.equal(true);
    });
  }

  it('blocks apply without permanent-delete acknowledgement before org access', async () => {
    const command = Object.create(DeleteContent.prototype) as DeleteContent;
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
          'ownership-report': 'ownership.json',
          apply: true,
          'report-dir': 'report',
          'acknowledge-permanent-delete': false,
        },
      }),
      getOrgContext,
      jsonEnabled: context.SANDBOX.stub().returns(true),
    });
    const result = await command.run();
    expect(result.status).to.equal('blocked');
    expect(result.diagnostics.errors[0].code).to.equal('PERMANENT_DELETE_ACKNOWLEDGEMENT_REQUIRED');
    expect(getOrgContext.notCalled).to.equal(true);
  });

  it('blocks apply without fresh report directory before org access', async () => {
    const command = Object.create(DeleteContent.prototype) as DeleteContent;
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
          'ownership-report': 'ownership.json',
          apply: true,
          'acknowledge-permanent-delete': true,
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
