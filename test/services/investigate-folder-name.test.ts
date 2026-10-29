import { expect } from 'chai';
import sinon from 'sinon';
import { prepareCmsConnection } from '../../src/api-policy.js';
import { resolveEmailFragmentFolder } from '../../src/services/resolve-email-fragment-folder.js';

const workspace = { id: '0Zu000000000001AAA', rootFolderId: '9Pu000000000001AAA' };
const childId = '9Pu000000000002AAA';
const otherId = '9Pu000000000003AAA';
const root = { id: workspace.rootFolderId, folderType: 'System', name: 'Root', isShared: false };
const row = (id = childId, title = 'Child', folderType = 'Standard') => ({
  isFolder: true,
  title,
  managedContentOrFolderId: id,
  folderSummary: { folderType, isShared: false },
});
const page = (folderItems: unknown[]) => ({ folderId: root.id, parentFolderId: null, folderItems });
const detail = (id: string, name = 'Child') => ({
  id,
  name,
  folderType: 'Standard',
  isShared: false,
  parentFolderId: root.id,
  folderHierarchy: [root],
});
const fake = (pages: unknown[] = [page([row()]), page([]), page([row(otherId, 'Other')])]) => {
  const request = sinon.stub().callsFake(async (input: { method: string; url: string }) => {
    expect(input.method).to.equal('GET');
    if (input.url.includes('/folder-items')) {
      const url = new URL(input.url, 'https://example.invalid');
      expect(Object.fromEntries(url.searchParams)).to.deep.equal({
        includeSharedWithSpaceFolder: 'false',
        itemType: 'Folders',
        page: url.searchParams.get('page'),
        pageSize: '250',
      });
      return pages[Number(url.searchParams.get('page'))];
    }
    return detail(input.url.includes(otherId) ? otherId : childId);
  });
  return { request, version: '68.0' };
};
async function reject(action: Promise<unknown>, pattern: RegExp) {
  try {
    await action;
  } catch (error) {
    expect((error as Error).message).to.match(pattern);
    return error;
  }
  throw new Error('Expected rejection');
}

describe('bounded Fragment folder-name investigation', () => {
  it('observes one contextual match but cannot authorize descent or placement', async () => {
    const connection = fake();
    await reject(
      resolveEmailFragmentFolder(connection, workspace, ['Child', 'Leaf']),
      /1 matching candidate.*no authoritative pagination.*--destination-folder-id/u,
    );
    expect(connection.request.callCount).to.equal(4);
    expect(connection.request.lastCall.args[0].url).to.equal(
      `/connect/cms/folders/${childId}?contextContentSpaceId=${workspace.id}`,
    );
    expect(
      connection.request.args.every(([input]) => !input.url.includes('/folders/' + otherId)),
    ).to.equal(true);
  });
  it('rejects duplicate eligible names across different pages after contextual validation', async () => {
    const connection = fake([page([row()]), page([row(otherId)]), page([])]);
    await reject(
      resolveEmailFragmentFolder(connection, workspace, ['Child']),
      /Ambiguous.*duplicate eligible.*--destination-folder-id/u,
    );
    expect(connection.request.callCount).to.equal(5);
  });
  for (const [label, pages, pattern] of [
    ['short pages', [page([row()]), page([]), page([row(otherId, 'Other')])], /inconclusive/u],
    ['empty pages', [page([]), page([])], /repeated page/u],
    [
      'no match',
      [page([row(childId, 'child')]), page([row(otherId, 'Other')]), page([])],
      /0 matching candidate/u,
    ],
    ['repeated nonempty pages', [page([row()]), page([row()])], /repeated page/u],
    [
      'repeated identity',
      [page([row()]), page([row(), row(otherId, 'Other')])],
      /repeated folder identity/u,
    ],
    [
      'changing identity',
      [page([row()]), page([row(childId, 'Changed')])],
      /changing folder evidence/u,
    ],
    [
      'system and shared view',
      [
        page([row(childId, 'Child', 'System')]),
        page([row(otherId, 'Child', 'SharedWithSpace')]),
        page([]),
      ],
      /0 matching candidate/u,
    ],
  ] as const) {
    it(`never authorizes ${label}`, async () => {
      const connection = fake([...pages]);
      await reject(resolveEmailFragmentFolder(connection, workspace, ['Child']), pattern);
      expect(connection.request.callCount).to.be.at.most(4);
    });
  }
  for (const [label, value] of Object.entries({
    missing: null,
    wrongFolder: { ...page([]), folderId: childId },
    wrongParent: { ...page([]), parentFolderId: childId },
    missingParent: { folderId: root.id, folderItems: [] },
    wrongRows: { ...page([]), folderItems: {} },
    tooMany: page(Array.from({ length: 251 }, () => row())),
    content: page([{ ...row(), isFolder: false }]),
    title: page([{ ...row(), title: null }]),
    wrongId: page([row('not-an-id')]),
    missingSummary: page([{ ...row(), folderSummary: undefined }]),
    unknownKind: page([row(childId, 'Child', 'Unknown')]),
    missingSharing: page([{ ...row(), folderSummary: { folderType: 'Standard' } }]),
  })) {
    it(`blocks malformed ${label} before any more reads`, async () => {
      const connection = fake([value]);
      await reject(resolveEmailFragmentFolder(connection, workspace, ['Child']), /inconclusive/u);
      expect(connection.request.callCount).to.equal(1);
    });
  }
  it('rejects changed candidate title or contextual parentage', async () => {
    for (const changed of [
      detail(childId, 'Changed'),
      { ...detail(childId), parentFolderId: otherId },
    ]) {
      const connection = fake();
      connection.request.onCall(3).resolves(changed);
      await reject(
        resolveEmailFragmentFolder(connection, workspace, ['Child']),
        /changed|parent identity/u,
      );
      expect(connection.request.callCount).to.equal(4);
    }
  });
  it('bounds candidate detail requests even for a large matching set', async () => {
    const connection = fake([
      page([row(), row(otherId), row('9Pu000000000004AAA'), row('9Pu000000000005AAA')]),
      page([]),
      page([row('9Pu000000000006AAA', 'Other')]),
    ]);
    // The first two eligible contextual matches already prove ambiguity; no broad detail scan.
    await reject(resolveEmailFragmentFolder(connection, workspace, ['Child']), /Ambiguous/u);
    expect(connection.request.callCount).to.equal(5);
  });
  it('propagates permission errors once without fallback or mutation', async () => {
    for (const at of [0, 3]) {
      const connection = fake();
      connection.request
        .onCall(at)
        .rejects(Object.assign(new Error('permission denied'), { statusCode: 403 }));
      const error = await reject(
        resolveEmailFragmentFolder(connection, workspace, ['Child']),
        /permission denied/u,
      );
      expect(error).to.have.property('status', 403);
      expect(connection.request.callCount).to.equal(at + 1);
    }
  });
  it('gates explicit 67 and latest fallback before dispatch while retaining root baseline', async () => {
    for (const fallback of [false, true]) {
      const connection = fake();
      const request = connection.request;
      if (fallback) {
        connection.request.onCall(0).resolves([{ version: '68.0' }]);
        connection.request.onCall(1).rejects({ errorCode: 'INVALID_VERSION' });
        connection.request.onCall(2).resolves({});
        connection.request.onCall(3).resolves({});
        await prepareCmsConnection(connection);
      } else await prepareCmsConnection(connection, '67.0');
      request.resetHistory();
      await reject(
        resolveEmailFragmentFolder(connection, workspace, ['Child']),
        /requires numeric CMS API 68.0/u,
      );
      expect(await resolveEmailFragmentFolder(connection, workspace, [])).to.deep.equal({
        id: root.id,
        path: [],
        ancestry: [],
      });
      expect(request.callCount).to.equal(0);
    }
  });
  it('keeps original latest routing through a narrowed getter wrapper', async () => {
    const connection = {
      ...fake(),
      getApiVersion() {
        return this.version;
      },
    };
    const request = connection.request;
    connection.request.onCall(0).resolves([{ version: '68.0' }]);
    connection.request.onCall(1).resolves({});
    connection.request.onCall(2).resolves({});
    await prepareCmsConnection(connection);
    request.resetHistory();
    const narrowed = {
      getApiVersion: () => connection.getApiVersion(),
      request: connection.request.bind(connection),
    };
    await reject(resolveEmailFragmentFolder(narrowed, workspace, ['Child']), /inconclusive/u);
    expect(
      request.args.every(([input]) => input.url.startsWith('/services/data/latest/')),
    ).to.equal(true);
  });
  it('validates all source segments and identity before enumeration', async () => {
    const connection = fake();
    for (const path of [
      ['Child', '../Leaf'],
      ['Child', ''],
    ])
      await reject(
        resolveEmailFragmentFolder(connection, workspace, path),
        /Unsafe source path segment/u,
      );
    await reject(
      resolveEmailFragmentFolder(connection, { ...workspace, id: 'invalid' }, ['Child']),
      /identity/u,
    );
    expect(connection.request.callCount).to.equal(0);
  });
});
