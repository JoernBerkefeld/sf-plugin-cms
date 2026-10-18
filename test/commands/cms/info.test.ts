import { TestContext } from '@salesforce/core/testSetup';
import { stubSfCommandUx } from '@salesforce/sf-plugins-core';
import { expect } from 'chai';
import packageJson from '../../../package.json' with { type: 'json' };
import Info from '../../../src/commands/cms/info.js';
import {
  CMS_CAPABILITY_DECLARATIONS,
  METADATA_CAPABILITY_FIXTURE_SHA256,
} from '../../../src/contracts/capability-registry.js';
import {
  CMS_PUBLIC_COMMANDS,
  CMS_PUBLIC_COMMAND_RESULTS,
  CMS_PUBLIC_CAPABILITIES,
} from '../../../src/contracts/info.js';

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
    it(`reports current offline public support for ${requestedVersion ?? 'default'}`, async () => {
      const command = Object.create(Info.prototype) as Info;
      Object.assign(command, {
        parse: context.SANDBOX.stub().resolves({ flags: { 'contract-version': requestedVersion } }),
        jsonEnabled: context.SANDBOX.stub().returns(true),
        getOrgContext: context.SANDBOX.stub().throws(new Error('Unexpected org access')),
        getConnection: context.SANDBOX.stub().throws(new Error('Unexpected org access')),
      });
      const result = await command.run();
      expect(result.status).to.equal('success');
      expect(result.contractVersion).to.equal('1.0.0');
      expect(result.metadata).to.deep.include({ operation: 'cms.info', apiVersion: null });
      expect(result.provenance.sourceOrgId).to.equal('offline');
      expect(result.result?.plugin).to.deep.equal({
        name: packageJson.name,
        version: packageJson.version,
      });
      expect(result.result?.api).to.deep.equal({
        defaultVersion: 'latest',
        testedVersions: ['67.0'],
      });
      expect(result.result?.commands).to.deep.equal(CMS_PUBLIC_COMMANDS);
      expect(result.result?.contracts.commandResults).to.deep.equal(CMS_PUBLIC_COMMAND_RESULTS);
      expect(result.result?.capabilities).to.deep.equal(CMS_PUBLIC_CAPABILITIES);
      expect(result.result?.internalRegistry).to.deep.include({
        scope: 'internal-engine-only',
        fixtureSha256: METADATA_CAPABILITY_FIXTURE_SHA256,
      });
      expect(result.result?.internalRegistry.declarations).to.deep.equal(
        CMS_CAPABILITY_DECLARATIONS,
      );
      expect(process.exitCode).to.equal(0);
    });
  }

  it('does not equate retained family engines with public retrieve or deploy support', async () => {
    const command = Object.create(Info.prototype) as Info;
    Object.assign(command, {
      parse: context.SANDBOX.stub().resolves({ flags: {} }),
      jsonEnabled: context.SANDBOX.stub().returns(true),
    });
    const { result } = await command.run();
    expect(result?.commands).to.deep.equal([
      'cms info',
      'cms list workspace',
      'cms list channel',
      'cms retrieve content',
      'cms deploy content',
      'cms upload images',
      'cms delete content',
      'cms publish content',
      'cms unpublish content',
    ]);
    expect(
      result?.capabilities
        .filter(({ id }) => id.startsWith('content.retrieve.'))
        .map(({ id }) => id),
    ).to.deep.equal([
      'content.retrieve.email',
      'content.retrieve.email-template',
      'content.retrieve.image',
      'content.retrieve.document',
      'content.retrieve.audio',
    ]);
    const deploy = result?.capabilities.filter(({ id }) => id.startsWith('content.deploy.')) ?? [];
    expect(deploy.map(({ id }) => id)).to.deep.equal([
      'content.deploy.email.create',
      'content.deploy.email.update',
      'content.deploy.email.unchanged',
      'content.deploy.email-template.create',
      'content.deploy.email-template.update',
      'content.deploy.email-template.unchanged',
      'content.deploy.image.create',
      'content.deploy.image.update',
      'content.deploy.image.unchanged',
      'content.deploy.document.create',
      'content.deploy.document.update',
      'content.deploy.document.unchanged',
      'content.deploy.audio.create',
      'content.deploy.audio.update',
      'content.deploy.audio.unchanged',
    ]);
    expect(deploy.every(({ contract }) => contract === 'sf-cms-content-deploy@1')).to.equal(true);
    expect(deploy.every(({ state }) => state === 'unqualified')).to.equal(true);
    expect(result?.capabilities.filter(({ id }) => id.includes('.document'))).to.deep.equal([
      {
        id: 'content.retrieve.document',
        state: 'unqualified',
        transport: 'cli-json',
        contract: 'sf-cms-content-retrieve@1',
      },
      ...['create', 'update', 'unchanged'].map((operation) => ({
        id: `content.deploy.document.${operation}`,
        state: 'unqualified',
        transport: 'cli-json',
        contract: 'sf-cms-content-deploy@1',
      })),
    ]);
    expect(result?.capabilities.filter(({ id }) => id.includes('.audio'))).to.deep.equal([
      {
        id: 'content.retrieve.audio',
        state: 'unqualified',
        transport: 'cli-json',
        contract: 'sf-cms-content-retrieve@1',
      },
      ...['create', 'update', 'unchanged'].map((operation) => ({
        id: `content.deploy.audio.${operation}`,
        state: 'unqualified',
        transport: 'cli-json',
        contract: 'sf-cms-content-deploy@1',
      })),
    ]);
    expect(
      result?.capabilities.some(({ id }) =>
        /workspace\.(?:export|import)|content\.update\.|sibling|baseline/u.test(id),
      ),
    ).to.equal(false);
    expect(
      result?.internalRegistry.declarations.some(({ identity }) => identity.type === 'Brand'),
    ).to.equal(true);
  });

  for (const version of [2, 3]) {
    it(`blocks obsolete or unsupported info major ${version} offline`, async () => {
      const command = Object.create(Info.prototype) as Info;
      Object.assign(command, {
        parse: context.SANDBOX.stub().resolves({ flags: { 'contract-version': version } }),
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
          message: `Contract major ${version} is unsupported; supported major is 1.`,
          retryable: false,
        },
      ]);
      expect(process.exitCode).to.equal(1);
    });
  }

  it('renders the same envelope in human mode', async () => {
    const command = Object.create(Info.prototype) as Info;
    const styledJSON = context.SANDBOX.stub();
    Object.assign(command, {
      parse: context.SANDBOX.stub().resolves({ flags: {} }),
      jsonEnabled: context.SANDBOX.stub().returns(false),
      styledJSON,
    });
    const result = await command.run();
    expect(styledJSON.calledOnceWithExactly(result)).to.equal(true);
  });
});
