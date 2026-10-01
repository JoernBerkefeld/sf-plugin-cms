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
    expect.fail('expected rejection');
  } catch (error) {
    expect(error).to.be.instanceOf(Error);
  }
}

describe('Marketing workspace assertions', () => {
  it('requires exact canonical structured Marketing detail for strict profiles', async () => {
    const request = sinon.stub();
    await assertCanonicalMarketingWorkspace(
      { request },
      { id: 'space', workspace: { id: 'space', spaceType: { apiName: 'Marketing' } } },
    );
    expect(request.notCalled).to.equal(true);

    const malformedDetailEvidence: unknown[] = [
      'Marketing',
      { apiName: 'marketing' },
      { apiName: 'MARKETING' },
      { apiName: 'Marketing', label: 'Marketing' },
      { label: 'Marketing' },
      { apiName: 'Unknown' },
    ];
    for (const spaceType of malformedDetailEvidence) {
      await expectRejected(
        assertCanonicalMarketingWorkspace(
          { request },
          { id: 'space', workspace: { id: 'space', spaceType: spaceType as never } },
        ),
      );
    }
    expect(request.notCalled).to.equal(true);
  });

  for (const [label, spaceType] of [
    ['bare string', 'Marketing'],
    ['case variant', { apiName: 'marketing' }],
    ['extra structured key', { apiName: 'Marketing', label: 'Marketing' }],
  ] as const) {
    it(`rejects ${label} as canonical detail evidence`, async () => {
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

  it('allows only exact-ID-correlated canonical listing fallback when detail omits spaceType', async () => {
    const request = sinon.stub().callsFake(({ url }: { url: string }) => {
      const page = Number(new URL(url, 'https://example.test').searchParams.get('page'));
      return fakeRequest({
        spaces:
          page === 0
            ? [
                { id: 'other', spaceType: { apiName: 'Content' } },
                { id: 'space', spaceType: { apiName: 'Marketing' } },
              ]
            : [],
      });
    });
    await assertCanonicalMarketingWorkspace(
      { request },
      { id: 'space', workspace: { id: 'space' } },
    );
    expect(request.callCount).to.equal(2);

    const malformedListingEvidence: unknown[] = [
      'Marketing',
      { apiName: 'marketing' },
      { apiName: 'Marketing', label: 'Marketing' },
      { apiName: 'Content' },
    ];
    for (const evidence of malformedListingEvidence) {
      const malformedRequest = sinon.stub().callsFake(({ url }: { url: string }) => {
        const page = Number(new URL(url, 'https://example.test').searchParams.get('page'));
        return fakeRequest({
          spaces: page === 0 ? [{ id: 'space', spaceType: evidence as never }] : [],
        });
      });
      await expectRejected(
        assertCanonicalMarketingWorkspace(
          { request: malformedRequest },
          { id: 'space', workspace: { id: 'space' } },
        ),
      );
    }
  });

  it('rejects contradictory repeated listing evidence for the selected exact ID', async () => {
    const request = sinon.stub().callsFake(({ url }: { url: string }) => {
      const page = Number(new URL(url, 'https://example.test').searchParams.get('page'));
      if (page === 0) {
        return fakeRequest({
          spaces: [{ id: 'space', name: 'First', spaceType: { apiName: 'Marketing' } }],
        });
      }
      if (page === 1) {
        return fakeRequest({
          spaces: [{ id: 'space', name: 'Second', spaceType: { apiName: 'Content' } }],
        });
      }
      return fakeRequest({ spaces: [] });
    });
    await expectRejected(
      assertCanonicalMarketingWorkspace({ request }, { id: 'space', workspace: { id: 'space' } }),
    );
  });

  it('preserves the established permissive Form assertion behavior', async () => {
    const request = sinon.stub();
    await assertMarketingWorkspace(
      { request },
      { id: 'space', workspace: { id: 'space', spaceType: 'marketing' } },
    );
    await assertMarketingWorkspace(
      { request },
      { id: 'space', workspace: { id: 'space', spaceType: { apiName: 'MARKETING' } } },
    );
    expect(request.notCalled).to.equal(true);
  });
});
