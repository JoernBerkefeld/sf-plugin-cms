import { access, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { expect } from 'chai';
import sinon from 'sinon';
import {
  exportAllWorkspaces,
  normalizeWorkspaceType,
  preflightBulkWorkspaceExport,
} from '../../src/services/bulk-export-workspaces.js';

type FakeRequest<T> = Promise<T> & { stream(): PassThrough };

function fakeRequest<T>(value: T): FakeRequest<T> {
  return Object.assign(Promise.resolve(value), { stream: () => new PassThrough() });
}

function pageNumber(url: string): number {
  return Number(new URL(url, 'https://example.test').searchParams.get('page'));
}

function workspace(id: string, name: string, type: string) {
  return { id, name, spaceType: { apiName: type } };
}

describe('bulk workspace export service', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'sf-plugin-cms-bulk-'));
  });

  afterEach(async () => {
    await rm(root, { force: true, recursive: true });
  });

  it('normalizes workspace type casing and rejects other values', () => {
    expect(normalizeWorkspaceType('MARKETING')).to.equal('Marketing');
    expect(normalizeWorkspaceType('content')).to.equal('Content');
    expect(() => normalizeWorkspaceType('other')).to.throw('Marketing or Content');
  });

  it('preflights canonical workspaces, filters actual types, and sorts by ID', async () => {
    const request = sinon.stub().callsFake(({ url }: { url: string }) => {
      if (url.startsWith('/connect/cms/spaces?')) {
        const page = pageNumber(url);
        return fakeRequest({
          spaces:
            page === 0
              ? [workspace('b', 'List B', 'marketing'), workspace('a', 'List A', 'content')]
              : [],
          total: 1,
        });
      }
      return url.endsWith('/a')
        ? fakeRequest(workspace('a', 'Canonical A', 'content'))
        : fakeRequest(workspace('b', 'Canonical B', 'marketing'));
    });

    const result = await preflightBulkWorkspaceExport(
      { request },
      path.join(root, 'cms'),
      'Marketing',
    );

    expect(result.discoveredCount).to.equal(2);
    expect(result.selected.map(({ id, name, type }) => ({ id, name, type }))).to.deep.equal([
      { id: 'b', name: 'Canonical B', type: 'Marketing' },
    ]);
    expect(request.callCount).to.equal(4);
  });

  for (const [firstName, secondName, expected] of [
    ['A/B', String.raw`A\B`, 'collide after sanitization'],
    ['Café', 'Cafe\u0301', 'differ only by case or Unicode normalization'],
    ['Main', 'MAIN', 'differ only by case or Unicode normalization'],
  ]) {
    it(`rejects global name/destination collision: ${firstName} vs ${secondName}`, async () => {
      const request = sinon.stub().callsFake(({ url }: { url: string }) => {
        if (url.startsWith('/connect/cms/spaces?')) {
          return fakeRequest({
            spaces:
              pageNumber(url) === 0
                ? [workspace('a', firstName, 'marketing'), workspace('b', secondName, 'marketing')]
                : [],
          });
        }
        return url.endsWith('/a')
          ? fakeRequest(workspace('a', firstName, 'marketing'))
          : fakeRequest(workspace('b', secondName, 'marketing'));
      });
      try {
        await preflightBulkWorkspaceExport({ request }, path.join(root, 'cms'));
        expect.fail('expected collision');
      } catch (error) {
        expect((error as Error).message).to.include(expected);
      }
      try {
        await access(path.join(root, 'cms'));
        expect.fail('expected zero destinations');
      } catch (error) {
        expect((error as NodeJS.ErrnoException).code).to.equal('ENOENT');
      }
    });
  }

  it('rejects existing destinations and incompatible parents before export search', async () => {
    const parent = path.join(root, 'cms');
    await mkdir(parent);
    await mkdir(path.join(parent, 'Existing'));
    const request = sinon.stub().callsFake(({ url }: { url: string }) => {
      if (url.startsWith('/connect/cms/spaces?')) {
        return fakeRequest({
          spaces: pageNumber(url) === 0 ? [workspace('a', 'Existing', 'marketing')] : [],
        });
      }
      return fakeRequest(workspace('a', 'Existing', 'marketing'));
    });
    try {
      await exportAllWorkspaces({ request }, parent, 'Marketing');
      expect.fail('expected existing destination rejection');
    } catch (error) {
      expect((error as Error).message).to.include('already exists');
    }
    expect(request.callCount).to.equal(3);

    const fileParent = path.join(root, 'file-parent');
    await writeFile(fileParent, 'x', 'utf8');
    try {
      await preflightBulkWorkspaceExport({ request }, path.join(fileParent, 'cms'));
      expect.fail('expected parent rejection');
    } catch (error) {
      expect((error as Error).message).to.include('not a directory');
    }
  });

  it('emits exact opaque correlations for evidenced included CMS content', async () => {
    const outputDirectory = path.join(root, 'cms');
    const request = sinon.stub().callsFake(({ url }: { url: string }) => {
      if (url.startsWith('/connect/cms/spaces?')) {
        return fakeRequest({
          spaces: pageNumber(url) === 0 ? [workspace('a', 'First', 'marketing')] : [],
        });
      }
      if (url === '/connect/cms/spaces/a') return fakeRequest(workspace('a', 'First', 'marketing'));
      if (url.includes('contentSpaceOrFolderIds=a')) {
        return fakeRequest({
          items: [
            {
              id: 'variant-a',
              managedContentSpaceId: 'a',
              type: 'ManagedContentVariantSearchResultRepresentation',
            },
          ],
          total: 1,
        });
      }
      if (url.endsWith('/variant-a')) {
        return fakeRequest({
          contentId: 'content-a',
          contentKey: ' Exact/Opaque + Value ',
          contentSpace: { id: 'a' },
          id: 'variant-a',
        });
      }
      throw new Error(`unexpected ${url}`);
    });

    const envelope = await exportAllWorkspaces({ request }, outputDirectory, 'Marketing', {
      generatedAt: '2026-09-13T18:00:00.000Z',
      pluginVersion: '0.3.0',
      sourceOrgId: '00DSource',
    });
    const result = envelope.result!;
    const artifactHash = result.workspaces[0].artifact!.manifestSha256;

    expect(envelope.status).to.equal('success');
    expect(result.externalReferenceCorrelations).to.deep.equal([
      {
        sourceWorkspaceId: 'a',
        sourceReference: ' Exact/Opaque + Value ',
        referenceKind: 'cms.content',
        referenceId: result.externalReferenceCorrelations[0].referenceId,
        packageManifestSha256: artifactHash,
      },
    ]);
    expect(result.externalReferenceCorrelations[0].referenceId).to.match(/^ref:[a-f\d]{64}$/u);
  });

  it('bounds aggregate diagnostics deterministically while preserving every workspace result', async () => {
    const outputDirectory = path.join(root, 'cms');
    const selected = Array.from({ length: 105 }, (_, index) =>
      workspace(`workspace-${String(index).padStart(3, '0')}`, `Workspace ${index}`, 'marketing'),
    );
    const request = sinon.stub().callsFake(({ url }: { url: string }) => {
      if (url.startsWith('/connect/cms/spaces?')) {
        return fakeRequest({ spaces: pageNumber(url) === 0 ? selected.toReversed() : [] });
      }
      const id = url.split('/').at(-1) ?? '';
      const found = selected.find((entry) => entry.id === id);
      if (found !== undefined && url.startsWith('/connect/cms/spaces/')) return fakeRequest(found);
      if (url.includes('contentSpaceOrFolderIds=')) {
        return Promise.reject(
          new Error(
            `failed ${new URL(url, 'https://example.test').searchParams.get('contentSpaceOrFolderIds')}`,
          ),
        );
      }
      throw new Error(`unexpected ${url}`);
    });

    const options = {
      generatedAt: '2026-09-13T18:00:00.000Z',
      pluginVersion: '0.3.0',
      sourceOrgId: '00DSource',
    };
    const first = await exportAllWorkspaces({ request }, outputDirectory, 'Marketing', options);
    await rm(outputDirectory, { force: true, recursive: true });
    const second = await exportAllWorkspaces({ request }, outputDirectory, 'Marketing', options);

    expect(first).to.deep.equal(second);
    expect(first.result?.workspaces).to.have.length(105);
    expect(
      first.result?.workspaces.every(({ diagnostics }) => diagnostics.errors.length === 1),
    ).to.equal(true);
    expect(first.diagnostics.errors).to.have.length(100);
    expect(first.diagnostics.errors.at(-1)).to.deep.equal({
      code: 'DIAGNOSTICS_TRUNCATED',
      message:
        '6 additional errors omitted from aggregate diagnostics; per-workspace diagnostics remain complete.',
      retryable: false,
    });
    expect(first.diagnostics.errors.slice(0, 99).map(({ scope }) => scope)).to.deep.equal(
      selected
        .map(({ id }) => id)
        .toSorted()
        .slice(0, 99),
    );
  });

  it('returns a deterministic aggregate and continues after execution failures', async () => {
    const outputDirectory = path.join(root, 'cms');
    const request = sinon.stub().callsFake(({ url }: { url: string }) => {
      if (url.startsWith('/connect/cms/spaces?')) {
        return fakeRequest({
          spaces:
            pageNumber(url) === 0
              ? [workspace('b', 'Second', 'marketing'), workspace('a', 'First', 'marketing')]
              : [],
        });
      }
      if (url === '/connect/cms/spaces/a') return fakeRequest(workspace('a', 'First', 'marketing'));
      if (url === '/connect/cms/spaces/b')
        return fakeRequest(workspace('b', 'Second', 'marketing'));
      if (url.includes('contentSpaceOrFolderIds=a'))
        return Promise.reject(new Error('https://example.test?token=secret boom'));
      if (url.includes('contentSpaceOrFolderIds=b')) return fakeRequest({ items: [], total: 0 });
      throw new Error(`unexpected ${url}`);
    });

    const envelope = await exportAllWorkspaces({ request }, outputDirectory, 'Marketing', {
      apiVersion: '67.0',
      generatedAt: '2026-09-13T18:00:00.000Z',
      pluginVersion: '0.3.0',
      sourceOrgId: '00DSource',
    });
    const result = envelope.result!;

    expect(envelope.status).to.equal('partial');
    expect(result.selection).to.deep.equal({
      mode: 'all',
      discoveredCount: 2,
      selectedCount: 2,
    });
    expect(result.summary).to.deep.equal({
      succeededCount: 1,
      partialCount: 0,
      failedCount: 1,
    });
    expect(
      result.workspaces.map(({ source, status }) => ({ id: source.sourceId, status })),
    ).to.deep.equal([
      { id: 'a', status: 'failed' },
      { id: 'b', status: 'success' },
    ]);
    expect(result.workspaces[0].diagnostics.errors[0].message).to.equal(
      'https://example.test?token=[REDACTED] boom',
    );
    expect(result.externalReferenceCorrelations).to.deep.equal([]);
    expect(result.workspaces[1].artifact).to.include({
      path: 'Second',
      manifestPath: 'Second/manifest.json',
      manifestContract: 'sf-cms-workspace-export',
      manifestContractVersion: '1.0.0',
    });
    await access(path.join(outputDirectory, 'Second', 'manifest.json'));
  });
});
