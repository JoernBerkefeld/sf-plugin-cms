import { expect } from 'chai';
import { Config } from '@oclif/core';
import { Org, StateAggregator } from '@salesforce/core';
import sinon from 'sinon';
import { CmsCommand, targetOrgFlag } from '../src/command-base.js';

class NoticeCommand extends CmsCommand<void> {
  public static flags = { 'target-org': targetOrgFlag };
  public async run(): Promise<void> {
    await this.parse(NoticeCommand);
  }
  public parseNotice() {
    return this.parse(NoticeCommand);
  }
}

describe('resolved org notice', () => {
  let config: Config;
  before(async () => {
    config = await Config.load({ root: process.cwd() });
  });
  afterEach(() => sinon.restore());

  for (const args of [['-o', 'chosen'], ['--target-org', 'chosen'], ['--target-org=chosen']]) {
    it(`uses the actual selected alias from parser tokens: ${args.join(' ')}`, async () => {
      const org = { getUsername: () => 'user@example.com' } as Org;
      const create = sinon.stub(Org, 'create').resolves(org);
      const aliases = { getUsername: sinon.stub().withArgs('chosen').returns('user@example.com') };
      sinon
        .stub(StateAggregator, 'getInstance')
        .resolves({ aliases } as unknown as StateAggregator);
      const command = new NoticeCommand(args, config);
      const output = sinon.stub(command, 'logToStderr');
      const parsed = await command.parseNotice();
      expect(parsed.flags['target-org']).to.equal(org);
      expect(parsed.raw).to.deep.include({ type: 'flag', flag: 'target-org', input: 'chosen' });
      expect(output.args).to.deep.equal([['Using org chosen (user@example.com)']]);
      await command.parseNotice();
      expect(output.callCount).to.equal(1);
      expect(create.callCount).to.equal(4); // Installed parser resolves input and defaultHelp each time.
    });
  }

  for (const [selection, mapped, expected] of [
    ['chosen', 'user@example.com', 'chosen (user@example.com)'],
    ['chosen', 'other@example.com', 'user@example.com'],
    ['user@example.com', 'user@example.com', 'user@example.com'],
  ]) {
    it(`verifies the effective implicit selection ${selection} / ${mapped}`, async () => {
      sinon.stub(Org, 'create').resolves({ getUsername: () => 'user@example.com' } as Org);
      sinon.stub(StateAggregator, 'getInstance').resolves({
        aliases: { getUsername: () => mapped },
      } as unknown as StateAggregator);
      const command = new NoticeCommand([], config);
      command.configAggregator = {
        getInfo: () => ({ value: selection }),
      } as unknown as NoticeCommand['configAggregator'];
      const output = sinon.stub(command, 'logToStderr');
      await command.parseNotice();
      expect(output.args).to.deep.equal([[`Using org ${expected}`]]);
    });
  }

  it('does not choose a reverse alias for an explicit username or mismatched alias', async () => {
    sinon.stub(Org, 'create').resolves({ getUsername: () => 'user@example.com' } as Org);
    const getUsername = sinon.stub().returns('other@example.com');
    sinon
      .stub(StateAggregator, 'getInstance')
      .resolves({ aliases: { getUsername } } as unknown as StateAggregator);
    for (const selection of ['user@example.com', 'mismatched']) {
      const command = new NoticeCommand(['-o', selection], config);
      const output = sinon.stub(command, 'logToStderr');
      await command.parseNotice();
      expect(output.args).to.deep.equal([['Using org user@example.com']]);
    }
    expect(getUsername.args).to.deep.equal([['mismatched']]);
  });

  it('falls back nonfatally and redacts terminal control characters and secrets', async () => {
    sinon
      .stub(Org, 'create')
      .resolves({ getUsername: () => 'user\n\u001B[31m Authorization: Bearer secret' } as Org);
    sinon.stub(StateAggregator, 'getInstance').rejects(new Error('optional lookup failure'));
    const command = new NoticeCommand(['-o', 'chosen'], config);
    const output = sinon.stub(command, 'logToStderr');
    await command.parseNotice();
    expect(output.firstCall.args[0]).to.equal('Using org user  [31m Authorization: [REDACTED]');
  });

  it('suppresses JSON and failed-parse notices without alias lookups', async () => {
    sinon.stub(Org, 'create').resolves({ getUsername: () => 'user@example.com' } as Org);
    const aliases = sinon.stub(StateAggregator, 'getInstance').rejects();
    for (const args of [
      ['-o', 'chosen', '--json'],
      ['-o', 'chosen', '--invalid'],
    ]) {
      const command = new NoticeCommand(args, config);
      const output = sinon.stub(command, 'logToStderr');
      try {
        await command.parseNotice();
      } catch {
        expect(args).to.include('--invalid');
      }
      expect(output.called).to.equal(false);
    }
    expect(aliases.called).to.equal(false);
  });
});
