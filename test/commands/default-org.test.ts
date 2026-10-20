import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Parser } from '@oclif/core';
import { Org } from '@salesforce/core';
import { expect } from 'chai';
import sinon from 'sinon';
import RetrieveContent from '../../src/commands/cms/retrieve/content.js';
import DeployContent from '../../src/commands/cms/deploy/content.js';
import DeleteContent from '../../src/commands/cms/delete/content.js';
import ListWorkspace from '../../src/commands/cms/list/workspace.js';
import ListChannel from '../../src/commands/cms/list/channel.js';
import UploadImages from '../../src/commands/cms/upload.js';
import PublishContent from '../../src/commands/cms/publish/content.js';
import UnpublishContent from '../../src/commands/cms/unpublish/content.js';
import Info from '../../src/commands/cms/info.js';
import { targetOrgFlag } from '../../src/command-base.js';

const commands = [
  { name: 'retrieve content', command: RetrieveContent, args: ['-W', 'Marketing'] },
  {
    name: 'deploy content',
    command: DeployContent,
    args: ['-W', 'Marketing', '-L', '-d', 'local.json'],
  },
  {
    name: 'delete content',
    command: DeleteContent,
    args: ['--workspace-id', 'space', '-m', 'email:Welcome'],
  },
  { name: 'list workspace', command: ListWorkspace, args: [] },
  { name: 'list channel', command: ListChannel, args: ['--workspace-id', 'space'] },
  {
    name: 'upload',
    command: UploadImages,
    args: ['--workspace-id', 'space', '--file', 'local.png'],
  },
  {
    name: 'publish content',
    command: PublishContent,
    args: ['--workspace-id', 'space', '--api-name', 'Welcome'],
  },
  {
    name: 'unpublish content',
    command: UnpublishContent,
    args: ['--workspace-id', 'space', '--api-name', 'Welcome'],
  },
];

describe('all org-backed CMS commands native default-org parsing', () => {
  afterEach(() => {
    sinon.restore();
    process.exitCode = undefined;
  });

  for (const entry of commands) {
    for (const override of [false, true]) {
      it(`${entry.name} resolves ${override ? 'explicit override' : 'configured default'} with the shared native flag`, async () => {
        const username = override ? 'override@example.test' : 'default@example.test';
        const org = { getUsername: () => username } as Org;
        const create = sinon.stub(Org, 'create').resolves(org);
        expect(entry.command.flags['target-org']).to.equal(targetOrgFlag);
        const parsed = await Parser.parse(
          [...entry.args, ...(override ? ['-o', 'override'] : [])],
          {
            flags: entry.command.flags as unknown as typeof RetrieveContent.flags,
          },
        );
        expect(create.called).to.equal(true);
        expect(
          create.calledWithExactly({ aliasOrUsername: override ? 'override' : undefined }),
        ).to.equal(true);
        expect(parsed.flags['target-org']).to.equal(org);
        expect((parsed.flags['target-org'] as Org).getUsername()).to.equal(username);
        expect(parsed.flags['api-version']).to.equal('latest');
        if ('apply' in parsed.flags) expect(parsed.flags.apply).to.equal(false);

        // Stop at the unchanged string-based CMS boundary, never real auth or transport.
        const getUsername = sinon.stub().returns(username);
        const boundary = sinon.stub().rejects(new Error('Controlled CMS boundary stop'));
        const subject = Object.create(entry.command.prototype) as RetrieveContent;
        if (entry.command === UploadImages) {
          const root = await mkdtemp(path.join(os.tmpdir(), 'cms-default-org-'));
          const file = path.join(root, 'local.png');
          await writeFile(file, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]));
          Object.assign(parsed.flags, { file: [file] });
        }
        if (['publish content', 'unpublish content', 'delete content'].includes(entry.name))
          Object.assign(parsed.flags, { 'default-language': true });
        Object.assign(subject, {
          parse: sinon
            .stub()
            .resolves({ flags: { ...parsed.flags, 'target-org': { getUsername } } }),
          getConnection: boundary,
          getOrgContext: boundary,
          selectSources: sinon.stub().resolves({ items: [] }),
          jsonEnabled: () => true,
          log: sinon.stub(),
        });
        try {
          await subject.run();
        } catch (error) {
          expect((error as Error).message).to.equal('Controlled CMS boundary stop');
        }
        expect(getUsername.calledOnce).to.equal(true);
        expect(boundary.calledOnceWithExactly(username, 'latest')).to.equal(true);
      });
    }

    it(`${entry.name} retains the native missing-default error before CMS services`, async () => {
      sinon.stub(Org, 'create').rejects(new Error('Controlled missing default'));
      const subject = Object.create(entry.command.prototype) as RetrieveContent;
      const cms = sinon.stub().throws(new Error('CMS must not be reached'));
      Object.assign(subject, {
        parse: () =>
          Parser.parse(entry.args, {
            flags: entry.command.flags as unknown as typeof RetrieveContent.flags,
          }),
        getConnection: cms,
        getOrgContext: cms,
        prepareSources: cms,
        selectSources: cms,
        preflightBatch: cms,
        executeBatch: cms,
        writeSource: cms,
        jsonEnabled: () => true,
      });
      let failure: unknown;
      try {
        await subject.run();
      } catch (error) {
        failure = error;
      }
      expect(failure).to.be.instanceOf(Error);
      expect((failure as Error).message).to.include('No default environment found');
      expect(cms.notCalled).to.equal(true);
    });
  }

  it('keeps cms info offline with no org flag or auth resolution', async () => {
    const create = sinon
      .stub(Org, 'create')
      .rejects(new Error('Offline command must not resolve auth'));
    expect(Info.flags).not.to.have.property('target-org');
    await Parser.parse([], { flags: Info.flags });
    expect(create.notCalled).to.equal(true);
  });
});
