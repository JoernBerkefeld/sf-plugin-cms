import { expect } from 'chai';
import sinon from 'sinon';
import PublishContent from '../src/commands/cms/publish/content.js';
import UnpublishContent from '../src/commands/cms/unpublish/content.js';
import { CmsCommand } from '../src/command-base.js';
import {
  formatMutationOutcome,
  notifyMutationOutcome,
  type MutationOutcome,
} from '../src/mutation-outcome.js';

class OutcomeCommand extends CmsCommand<void> {
  public async run(): Promise<void> {}
  public observer() {
    return this.mutationOutcomeObserver();
  }
}
const event: MutationOutcome = {
  operation: 'publish',
  state: 'completed',
  ordinal: 2,
  label: 'Welcome',
  language: 'en_US',
  target: { variantId: 'variant-secret' },
  deploymentId: 'deployment-secret',
  diagnostics: [{ code: 'TEST', message: 'password=SECRET' }],
};

describe('Live lifecycle mutation outcomes', () => {
  afterEach(() => sinon.restore());
  it('formats human labels without technical identifiers, controls or diagnostic prose', () => {
    expect(formatMutationOutcome(event)).to.equal('publish: Welcome (en_US) — completed');
    const text = formatMutationOutcome({
      ...event,
      label: 'variant-secret\n\u001B[31mWelcome',
      language: 'variant-secret',
    });
    expect(text).to.equal('publish: Welcome — completed');
    expect(
      formatMutationOutcome({ ...event, label: '0ap123456789012AAA', language: undefined }),
    ).to.equal('publish: Item 2 — completed');
  });
  it('copies only approved fields, redacts secrets and isolates observer failure', () => {
    const spy = sinon.spy();
    notifyMutationOutcome(spy, {
      ...event,
      payload: 'MUST_NOT_COPY',
      target: { ...event.target, password: 'MUST_NOT_COPY' },
    } as MutationOutcome);
    expect(spy.firstCall.args[0]).not.to.equal(event);
    expect(JSON.stringify(spy.firstCall.args[0])).not.to.include('SECRET');
    expect(JSON.stringify(spy.firstCall.args[0])).not.to.include('MUST_NOT_COPY');
    expect(spy.firstCall.args[0].deploymentId).to.equal('deployment-secret');
    expect(() =>
      notifyMutationOutcome(() => {
        throw new Error('sink');
      }, event),
    ).not.to.throw();
    expect(() => notifyMutationOutcome(undefined, event)).not.to.throw();
  });
  for (const json of [false, true])
    it(`keeps technical evidence independent of human output with JSON=${String(json)}`, () => {
      const command = Object.create(OutcomeCommand.prototype) as OutcomeCommand;
      const log = sinon.spy();
      const technical = sinon.spy();
      Object.assign(command, {
        jsonEnabled: () => json,
        log,
        invocationLogger: { log: technical },
      });
      notifyMutationOutcome(command.observer(), event);
      expect(technical.calledOnce).to.equal(true);
      expect(technical.firstCall.args[2].target.variantId).to.equal('variant-secret');
      expect(log.callCount).to.equal(json ? 0 : 1);
      if (!json) expect(log.firstCall.args[0]).to.equal(formatMutationOutcome(event));
    });
  for (const Command of [PublishContent, UnpublishContent])
    for (const json of [false, true])
      it(`${Command.name}: replaces legacy apply technical output with one safe outcome JSON=${String(json)}`, () => {
        const command = Object.create(Command.prototype);
        const log = sinon.spy();
        const technical = sinon.spy();
        Object.assign(command, {
          jsonEnabled: () => json,
          log,
          invocationLogger: { log: technical },
        });
        command.showResult({
          result: {
            mode: 'apply',
            outcome: 'remote-completed-local-blocked',
            target: {
              apiName: 'Welcome',
              language: 'en_US',
              workspaceId: 'space',
              contentId: 'parent-secret',
              variantId: 'variant-secret',
            },
            evidence: { deploymentId: 'deployment-secret' },
            reportFile: 'report-secret',
            blockers: [{ code: 'LOCAL', message: 'password=SECRET' }],
          },
        });
        expect(log.callCount).to.equal(json ? 0 : 1);
        if (!json) {
          expect(log.firstCall.args[0]).to.include('remote-completed-local-blocked');
          expect(log.firstCall.args[0]).not.to.match(/secret|SECRET|password/);
        }
        expect(technical.calledOnce).to.equal(true);
        expect(technical.firstCall.args[2].reportFile).to.equal('report-secret');
        expect(JSON.stringify(technical.firstCall.args)).not.to.include('SECRET');
      });
  it('delivers already-redacted nested diagnostics without dropping the outcome', () => {
    const observer = sinon.spy();
    notifyMutationOutcome(observer, {
      ...event,
      operation: 'upload',
      diagnostics: [{ code: 'STOP', message: 'timeout password=[REDACTED]' }],
    });
    expect(observer.calledOnce).to.equal(true);
    expect(observer.firstCall.args[0].diagnostics[0].message).to.include('[REDACTED]');
    expect(observer.firstCall.args[0].operation).to.equal('upload');
  });
  it('does not let failed technical or terminal sinks alter outcomes', () => {
    const command = Object.create(OutcomeCommand.prototype) as OutcomeCommand;
    const log = sinon.stub().throws(new Error('terminal'));
    const technical = sinon.stub().throws(new Error('logger'));
    Object.assign(command, { jsonEnabled: () => false, log, invocationLogger: { log: technical } });
    expect(() => notifyMutationOutcome(command.observer(), event)).not.to.throw();
    expect(log.calledOnce).to.equal(true);
    expect(technical.calledOnce).to.equal(true);
    expect(event.state).to.equal('completed');
  });
});
