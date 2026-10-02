import { TestContext } from '@salesforce/core/testSetup';
import { expect } from 'chai';
import { mkdtemp, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import UpdateContent from '../../src/commands/cms/update/content.js';

describe('cms update content command', () => {
  const context = new TestContext();

  beforeEach(() => {
    process.exitCode = undefined;
  });

  afterEach(() => {
    context.restore();
    process.exitCode = undefined;
  });

  it('requires explicit Email Template contract v2 before org access', async () => {
    const command = Object.create(UpdateContent.prototype) as UpdateContent;
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
          'source-dir': 'source',
          'editable-dir': 'editable',
          apply: false,
        },
      }),
      getOrgContext,
      jsonEnabled: context.SANDBOX.stub().returns(true),
    });

    const result = await command.run();

    expect(result.contractVersion).to.equal('2.0.0');
    expect(result.status).to.equal('blocked');
    expect(result.diagnostics.errors[0].code).to.equal('UNSUPPORTED_CONTRACT_VERSION');
    expect(getOrgContext.notCalled).to.equal(true);
  });

  it('uses the Template preflight blocker code for blocked v2 previews', async () => {
    const sourceDirectory = await mkdtemp(path.join(tmpdir(), 'sf-cms-template-update-source-'));
    const editableDirectory = await mkdtemp(
      path.join(tmpdir(), 'sf-cms-template-update-editable-'),
    );
    const command = Object.create(UpdateContent.prototype) as UpdateContent;
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
          'source-dir': sourceDirectory,
          'editable-dir': editableDirectory,
          apply: false,
        },
      }),
      getOrgContext: context.SANDBOX.stub().resolves({
        connection: { request: context.SANDBOX.stub(), version: '67.0' },
        orgId: '00Dorg',
      }),
      jsonEnabled: context.SANDBOX.stub().returns(true),
    });

    const result = await command.run();

    expect(result).to.deep.include({
      contract: 'sf-cms-content-update',
      contractVersion: '2.0.0',
      status: 'blocked',
    });
    expect(result.diagnostics.errors).to.deep.equal([
      {
        code: 'EMAIL_TEMPLATE_UPDATE_PREFLIGHT_BLOCKED',
        message: 'manifest.json is missing',
      },
    ]);
    expect(result.result).to.deep.include({
      contentType: 'sfdc_cms__emailTemplate',
      mode: 'dry-run',
      outcome: 'blocked',
    });
    await rmdir(sourceDirectory);
    await rmdir(editableDirectory);
  });

  it('blocks apply without a new report directory before org access', async () => {
    const command = Object.create(UpdateContent.prototype) as UpdateContent;
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
          'source-dir': 'source',
          'editable-dir': 'editable',
          apply: true,
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

  it('returns a blocked apply envelope for an existing report directory without PUT or ownership claim', async () => {
    const reportDirectory = await mkdtemp(path.join(tmpdir(), 'sf-cms-existing-report-'));
    const command = Object.create(UpdateContent.prototype) as UpdateContent;
    const request = context.SANDBOX.stub();
    const log = context.SANDBOX.stub();
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
          'source-dir': 'source',
          'editable-dir': 'editable',
          apply: true,
          'report-dir': reportDirectory,
        },
      }),
      getOrgContext: context.SANDBOX.stub().resolves({
        connection: { request, version: '67.0', instanceUrl: 'https://example.invalid' },
        orgId: '00Dorg',
      }),
      jsonEnabled: context.SANDBOX.stub().returns(false),
      log,
    });

    const result = await command.run();

    expect(result).to.deep.include({
      contract: 'sf-cms-content-update',
      contractVersion: '1.0.0',
      status: 'blocked',
    });
    expect(result.result).to.deep.equal({
      mode: 'apply',
      outcome: 'blocked',
      target: { workspaceId: 'space', apiName: 'Email', language: 'en_US' },
      evidence: { changedFields: [] },
      blockers: [
        {
          code: 'EMAIL_UPDATE_PREFLIGHT_BLOCKED',
          message: 'Content update report directory already exists',
        },
      ],
    });
    expect(result.result).not.to.have.property('reportFile');
    expect(result.result).not.to.have.property('reconciliation');
    expect(request.notCalled).to.equal(true);
    expect(log.calledWith('Status: blocked')).to.equal(true);
    expect(log.calledWith('Outcome: blocked')).to.equal(true);
    await rmdir(reportDirectory);
  });

  it('requires exactly one explicit language selector before org access', async () => {
    const command = Object.create(UpdateContent.prototype) as UpdateContent;
    const getOrgContext = context.SANDBOX.stub();
    Object.assign(command, {
      parse: context.SANDBOX.stub().resolves({
        flags: {
          'target-org': 'org',
          'api-version': '67.0',
          'contract-version': 1,
          'workspace-id': 'space',
          'api-name': 'Email',
          'default-language': false,
          'source-dir': 'source',
          'editable-dir': 'editable',
          apply: false,
        },
      }),
      getOrgContext,
      jsonEnabled: context.SANDBOX.stub().returns(true),
    });

    const result = await command.run();

    expect(result.status).to.equal('blocked');
    expect(result.diagnostics.errors[0].code).to.equal('LANGUAGE_SELECTOR_REQUIRED');
    expect(getOrgContext.notCalled).to.equal(true);
  });
});
