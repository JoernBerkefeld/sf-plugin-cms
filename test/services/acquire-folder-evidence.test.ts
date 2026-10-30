import { expect } from 'chai';
import sinon from 'sinon';
import {
  acquireFolderEvidence,
  acquireContextualFolderEvidence,
} from '../../src/services/acquire-folder-evidence.js';
import { buildOperationUrl, getSelectedOperation } from '../../src/transport/json-request.js';

const workspace = { id: '0Zuaj000007dgL8CAI', rootFolderId: '9Pu000000000001AAA' };
const outer = {
  id: '9Pu000000000002AAA',
  name: 'Outer',
  parentFolderId: workspace.rootFolderId,
  folderType: 'Standard',
};
const leaf = {
  id: '9Pu000000000003AAA',
  name: 'Inner',
  parentFolderId: outer.id,
  folderType: 'Standard',
  isShared: false,
};
const detail = () => ({
  ...leaf,
  folderHierarchy: [
    { id: workspace.rootFolderId, name: 'Workspace', folderType: 'System' },
    { ...outer },
  ],
});

async function rejected(run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
    expect.fail('Expected folder evidence rejection');
  } catch (error) {
    expect(error).to.be.instanceOf(TypeError);
  }
}

describe('independent folder evidence', () => {
  it('registers the documented GET with workspace context', () => {
    const operation = getSelectedOperation('folder.get');
    expect(operation.method).to.equal('GET');
    expect(operation.operationId).to.equal('getManagedContentSpaceFolder');
    expect(
      buildOperationUrl(operation, {
        path: { folderId: leaf.id },
        query: { contextContentSpaceId: workspace.id },
      }),
    ).to.equal(`/connect/cms/folders/${leaf.id}?contextContentSpaceId=${workspace.id}`);
  });

  for (const folder of [null, { id: workspace.rootFolderId }]) {
    it(`accepts independently matching root evidence ${String(folder === null)}`, async () => {
      const request = sinon.stub();
      expect(
        await acquireFolderEvidence({ request }, workspace, folder, structuredClone(folder)),
      ).to.deep.equal([]);
      expect(request.called).to.equal(false);
    });
  }

  it('preserves ancestor order and binds the context without mutating evidence', async () => {
    const response = detail();
    const before = structuredClone(response);
    const request = sinon.stub().resolves(response);
    expect(
      await acquireFolderEvidence({ request }, workspace, { id: leaf.id }, { id: leaf.id }),
    ).to.deep.equal(['Outer', 'Inner']);
    expect(response).to.deep.equal(before);
    expect(request.firstCall.args[0]).to.deep.equal({
      method: 'GET',
      url: `/connect/cms/folders/${leaf.id}?contextContentSpaceId=${workspace.id}`,
    });
  });

  it('keeps strict ancestor enrichment disabled by default', async () => {
    const request = sinon.stub().resolves(detail());
    await rejected(() =>
      acquireContextualFolderEvidence({ request }, workspace, leaf.id, {}, true),
    );
    expect(request.calledOnce).to.equal(true);
  });

  it('accepts a direct child without inventing an extra ancestor', async () => {
    const response = detail();
    response.folderHierarchy.pop();
    response.parentFolderId = workspace.rootFolderId;
    expect(
      await acquireFolderEvidence(
        { request: sinon.stub().resolves(response) },
        workspace,
        { id: leaf.id },
        { id: leaf.id },
      ),
    ).to.deep.equal(['Inner']);
  });

  for (const [label, mutate] of Object.entries<(value: Record<string, unknown>) => void>({
    identity: (value) => {
      value.id = outer.id;
    },
    shared: (value) => {
      value.isShared = true;
    },
    missingShared: (value) => {
      delete value.isShared;
    },
    special: (value) => {
      value.folderType = 'SharedWithSpace';
    },
    absentHierarchy: (value) => {
      delete value.folderHierarchy;
    },
    emptyHierarchy: (value) => {
      value.folderHierarchy = [];
    },
    wrongRoot: (value) => {
      value.folderHierarchy = [{ ...outer, folderType: 'System' }];
    },
    rootType: (value) => {
      value.folderHierarchy = [{ id: workspace.rootFolderId, folderType: 'Standard' }];
    },
    brokenParent: (value) => {
      value.parentFolderId = workspace.rootFolderId;
    },
    repeated: (value) => {
      value.folderHierarchy = [detail().folderHierarchy[0], outer, outer];
    },
    malformedEntry: (value) => {
      value.folderHierarchy = [null];
    },
    unsafeName: (value) => {
      value.name = '../escape';
    },
    missingName: (value) => {
      delete value.name;
    },
    invalidId: (value) => {
      value.folderHierarchy = [{ id: 'bad', folderType: 'System' }];
    },
    ancestorParent: (value) => {
      value.folderHierarchy = [detail().folderHierarchy[0], { ...outer, parentFolderId: leaf.id }];
    },
    ancestorType: (value) => {
      value.folderHierarchy = [
        detail().folderHierarchy[0],
        { ...outer, folderType: 'SharedWithSpace' },
      ];
    },
  })) {
    it(`rejects ${label} evidence`, async () => {
      const response: Record<string, unknown> = detail();
      mutate(response);
      await rejected(() =>
        acquireFolderEvidence(
          { request: sinon.stub().resolves(response) },
          workspace,
          { id: leaf.id },
          { id: leaf.id },
        ),
      );
    });
  }

  it('rejects malformed workspace or disagreeing content scope before access', async () => {
    const request = sinon.stub();
    for (const [scope, variant, parent] of [
      [{ ...workspace, id: 'bad' }, null, null],
      [{ ...workspace, rootFolderId: workspace.id }, null, null],
      [workspace, { id: leaf.id }, { id: outer.id }],
      [workspace, null, { id: workspace.rootFolderId }],
      [workspace, undefined, null],
      [workspace, { id: 'bad' }, null],
    ] as const)
      await rejected(() => acquireFolderEvidence({ request }, scope, variant, parent));
    expect(request.called).to.equal(false);
  });

  it('propagates transport failures rather than returning a partial path', async () => {
    const error = new Error('read denied');
    try {
      await acquireFolderEvidence(
        { request: sinon.stub().rejects(error) },
        workspace,
        { id: leaf.id },
        { id: leaf.id },
      );
      expect.fail('Expected read failure');
    } catch (error_) {
      expect((error_ as Error).message).to.equal('read denied');
    }
  });
});
