import { expect } from 'chai';
import sinon from 'sinon';
import {
  assertCanonicalMarketingWorkspace,
  assertMarketingWorkspace,
} from '../../src/services/resolve-workspace.js';

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
  it('does not let the rejection helper catch its own failed assertion', async () => {
    let failure: unknown;
    try {
      await expectRejected(Promise.resolve());
    } catch (error) {
      failure = error;
    }
    expect(failure).to.be.instanceOf(Error);
    expect((failure as Error).message).to.equal('expected rejection');
    await expectRejected(Promise.reject(new Error('actual rejection')));
  });

  for (const apiName of ['Marketing', 'marketing']) {
    it(`accepts exact structured ${apiName} detail for strict profiles`, async () => {
      const request = sinon.stub();
      await assertCanonicalMarketingWorkspace(
        { request },
        { id: 'space', workspace: { id: 'space', spaceType: { apiName } } },
      );
      expect(request.notCalled).to.equal(true);
    });
  }

  const rejectedEvidence: unknown[] = [
    'Marketing',
    'marketing',
    { apiName: 'MARKETING' },
    { apiName: 'mArketing' },
    { apiName: 'Marketing', label: 'Marketing' },
    { apiName: 'marketing', label: 'Marketing' },
    { label: 'Marketing' },
    { apiName: 'Unknown' },
    { apiName: 'CONTENT' },
    { apiName: 'Content' },
    { apiName: 'content' },
    { apiName: null },
    null,
    [],
  ];
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

  for (const apiName of ['Marketing', 'marketing']) {
    it(`accepts exact-ID structured ${apiName} listing fallback with mixed Content evidence`, async () => {
      const request = sinon.stub().callsFake(({ url }: { url: string }) => {
        const page = Number(new URL(url, 'https://example.test').searchParams.get('page'));
        return fakeRequest({
          spaces:
            page === 0
              ? [
                  { id: 'other', spaceType: { apiName: 'Content' } },
                  { id: 'native-content', spaceType: { apiName: 'content' } },
                  { id: 'space', spaceType: { apiName } },
                ]
              : [],
        });
      });
      await assertCanonicalMarketingWorkspace(
        { request },
        { id: 'space', workspace: { id: 'space' } },
      );
      expect(request.callCount).to.equal(2);
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

  for (const apiName of ['Content', 'content', 'Unknown', 'MARKETING']) {
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

  it('preserves the established permissive Form assertion behavior', async () => {
    const request = sinon.stub();
    for (const spaceType of [
      'marketing',
      { apiName: 'MARKETING' },
      { apiName: 'mArKeTiNg', label: 'Marketing' },
    ]) {
      await assertMarketingWorkspace(
        { request },
        { id: 'space', workspace: { id: 'space', spaceType: spaceType as never } },
      );
    }
    expect(request.notCalled).to.equal(true);
  });
});
