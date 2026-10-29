import { expect } from 'chai';
import sinon from 'sinon';
import {
  resolveEmailFragmentFolder,
  assertEmailFragmentNativeFolder,
} from '../../src/services/resolve-email-fragment-folder.js';

const workspace = { id: '0Zu000000000001AAA', rootFolderId: '9Pu000000000001AAA' };
const root = { id: workspace.rootFolderId, name: 'Root', folderType: 'System', isShared: false };
const child = {
  id: '9Pu000000000002AAA',
  name: 'Child',
  folderType: 'Standard',
  isShared: false,
  parentFolderId: root.id,
};
const leaf = {
  id: '9Pu000000000003AAA',
  name: 'Leaf',
  folderType: 'Standard',
  isShared: false,
  parentFolderId: child.id,
};
const detail = () => ({ ...leaf, folderHierarchy: [root, child] });
async function reject(run: Promise<unknown>, pattern: RegExp = /folder|hierarchy/iu) {
  try {
    await run;
  } catch (error) {
    expect((error as Error).message).to.match(pattern);
    return;
  }
  throw new Error('Expected rejection');
}
describe('explicit Fragment destination placement', () => {
  afterEach(() => sinon.restore());
  it('retains unmapped root and gates unmapped nested placement before access', async () => {
    const request = sinon.stub();
    expect(await resolveEmailFragmentFolder({ request }, workspace, [])).to.deep.equal({
      id: root.id,
      path: [],
      ancestry: [],
    });
    await reject(resolveEmailFragmentFolder({ request }, workspace, ['Child']), /no API version/u);
    expect(request.called).to.equal(false);
  });
  for (const [folder, names] of [
    [{ ...root, folderHierarchy: [] }, []],
    [{ ...child, folderHierarchy: [root] }, ['Child']],
    [detail(), ['Child', 'Leaf']],
  ] as const) {
    it(`validates exact contextual ID for ${names.length} path segments without enumeration`, async () => {
      const response = structuredClone(folder);
      const request = sinon.stub().resolves(response);
      const proof = await resolveEmailFragmentFolder({ request }, workspace, names, folder.id);
      expect(proof.id).to.equal(folder.id);
      expect(proof.path).to.deep.equal(names);
      expect(request.calledOnce).to.equal(true);
      expect(request.firstCall.args[0].url).to.equal(
        `/connect/cms/folders/${folder.id}?contextContentSpaceId=${workspace.id}`,
      );
      response.name = 'Changed';
      expect(proof.ancestry.at(-1)!.name).to.not.equal('Changed');
    });
  }
  for (const [label, mutate] of Object.entries<(value: Record<string, unknown>) => void>({
    wrongId: (value) => {
      value.id = child.id;
    },
    wrongWorkspace: (value) => {
      value.contentSpaceId = '0Zu000000000002AAA';
    },
    shared: (value) => {
      value.isShared = true;
    },
    ambiguousSharing: (value) => {
      delete value.isShared;
    },
    sharedAncestor: (value) => {
      value.folderHierarchy = [root, { ...child, isShared: true }];
    },
    unknownAncestorSharing: (value) => {
      value.folderHierarchy = [root, { ...child, isShared: undefined }];
    },
    otherSystem: (value) => {
      value.folderType = 'System';
    },
    sharedView: (value) => {
      value.folderType = 'SharedWithSpace';
    },
    rootParentCycle: (value) => {
      value.folderHierarchy = [{ ...root, parentFolderId: leaf.id }, child];
    },
    wrongRoot: (value) => {
      value.folderHierarchy = [{ ...root, id: '9Pu000000000004AAA' }, child];
    },
    cycle: (value) => {
      value.folderHierarchy = [root, child, child];
    },
    missingParent: (value) => {
      value.folderHierarchy = [root];
    },
    missingHierarchy: (value) => {
      delete value.folderHierarchy;
    },
    missingFolder: (value) => {
      delete value.id;
    },
    wrongParent: (value) => {
      value.parentFolderId = root.id;
    },
    malformed: (value) => {
      value.folderHierarchy = [null];
    },
  })) {
    it(`rejects ${label} without fallback`, async () => {
      const response: Record<string, unknown> = detail();
      mutate(response);
      await reject(
        resolveEmailFragmentFolder(
          { request: sinon.stub().resolves(response) },
          workspace,
          ['Child', 'Leaf'],
          leaf.id,
        ),
      );
    });
  }
  it('rejects exact path disagreement, including case, and propagates permissions/absence', async () => {
    for (const names of [[], ['Child'], ['child', 'Leaf']])
      await reject(
        resolveEmailFragmentFolder(
          { request: sinon.stub().resolves(detail()) },
          workspace,
          names,
          leaf.id,
        ),
        /ID\/path disagreement/u,
      );
    for (const response of [null, undefined, {}])
      await reject(
        resolveEmailFragmentFolder(
          { request: sinon.stub().resolves(response) },
          workspace,
          ['Child', 'Leaf'],
          leaf.id,
        ),
      );
    await reject(
      resolveEmailFragmentFolder(
        { request: sinon.stub().rejects(new Error('permission denied')) },
        workspace,
        ['Child', 'Leaf'],
        leaf.id,
      ),
      /permission denied/u,
    );
  });
  it('requires both independent native IDs, never equal labels, and only normalizes null/null root', () => {
    expect(() => assertEmailFragmentNativeFolder(null, null, root.id, root.id)).not.to.throw();
    expect(() =>
      assertEmailFragmentNativeFolder({ id: leaf.id }, { id: leaf.id }, leaf.id, root.id),
    ).not.to.throw();
    for (const [variant, parent, selected] of [
      [null, null, leaf.id],
      [null, { id: root.id }, root.id],
      [{ id: child.id, name: 'Leaf' }, { id: child.id, name: 'Leaf' }, leaf.id],
      [{ id: leaf.id }, { id: child.id }, leaf.id],
      [undefined, undefined, root.id],
    ])
      expect(() =>
        assertEmailFragmentNativeFolder(variant, parent, selected as string, root.id),
      ).to.throw('native folder identity');
  });
});
