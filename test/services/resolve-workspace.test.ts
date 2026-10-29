import { expect } from 'chai';
import sinon from 'sinon';
import { assertCanonicalMarketingWorkspace } from '../../src/services/resolve-workspace.js';

function fakeRequest<T>(value: T): Promise<T> & { stream(): { destroy(): void } } {
  return Object.assign(Promise.resolve(value), { stream: () => ({ destroy: () => {} }) });
}

async function expectRejected(promise: Promise<unknown>): Promise<void> {
  try {
    await promise;
  } catch (error) {
    expect(error).to.be.instanceOf(Error);
    return;
  }
  expect.fail('expected rejection');
}

describe('Marketing workspace assertions', () => {
  const rejectedEvidence: unknown[] = [{ apiName: 'Unknown' }, { apiName: 'Content' }];
  for (const spaceType of rejectedEvidence) {
    it(`rejects non-Marketing or malformed strict detail: ${JSON.stringify(spaceType)}`, async () => {
      const request = sinon.stub();
      await expectRejected(
        assertCanonicalMarketingWorkspace(
          { request },
          { id: 'space', workspace: { id: 'space', spaceType: spaceType as never } },
        ),
      );
      expect(request.notCalled).to.equal(true);
    });
  }

  for (const evidence of [...rejectedEvidence, undefined]) {
    it(`rejects non-Marketing or malformed strict listing: ${JSON.stringify(evidence)}`, async () => {
      const request = sinon.stub().callsFake(({ url }: { url: string }) => {
        const page = Number(new URL(url, 'https://example.test').searchParams.get('page'));
        return fakeRequest({
          spaces: page === 0 ? [{ id: 'space', spaceType: evidence as never }] : [],
        });
      });
      await expectRejected(
        assertCanonicalMarketingWorkspace({ request }, { id: 'space', workspace: { id: 'space' } }),
      );
    });
  }

  it('rejects Marketing listing evidence for a different exact ID', async () => {
    const request = sinon.stub().callsFake(({ url }: { url: string }) => {
      const page = Number(new URL(url, 'https://example.test').searchParams.get('page'));
      return fakeRequest({
        spaces: page === 0 ? [{ id: 'other', spaceType: { apiName: 'marketing' } }] : [],
      });
    });
    await expectRejected(
      assertCanonicalMarketingWorkspace({ request }, { id: 'space', workspace: { id: 'space' } }),
    );
  });

  for (const apiName of ['Content', 'Unknown']) {
    it(`rejects contradictory repeated listing evidence: marketing then ${apiName}`, async () => {
      const request = sinon.stub().callsFake(({ url }: { url: string }) => {
        const page = Number(new URL(url, 'https://example.test').searchParams.get('page'));
        if (page === 0) {
          return fakeRequest({
            spaces: [{ id: 'space', name: 'First', spaceType: { apiName: 'marketing' } }],
          });
        }
        if (page === 1) {
          return fakeRequest({
            spaces: [{ id: 'space', name: 'Second', spaceType: { apiName } }],
          });
        }
        return fakeRequest({ spaces: [] });
      });
      await expectRejected(
        assertCanonicalMarketingWorkspace({ request }, { id: 'space', workspace: { id: 'space' } }),
      );
    });
  }
});
