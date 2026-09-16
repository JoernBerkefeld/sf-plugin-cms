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

function workspace(id: string, name: string, type?: unknown) {
  return {
    id,
    name,
    ...(type === undefined
      ? {}
      : { spaceType: typeof type === 'string' ? { apiName: type } : type }),
  };
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

  it('uses exact-ID-correlated list type when canonical detail omits spaceType', async () => {
    const request = sinon.stub().callsFake(({ url }: { url: string }) => {
      if (url.startsWith('/connect/cms/spaces?')) {
        return fakeRequest({
          spaces: pageNumber(url) === 0 ? [workspace('a', 'Listed', 'marketing')] : [],
        });
      }
      return fakeRequest(workspace('a', 'Canonical'));
    });

    const result = await preflightBulkWorkspaceExport(
      { request },
      path.join(root, 'cms'),
      'Marketing',
    );

    expect(result.selected.map(({ id, name, type }) => ({ id, name, type }))).to.deep.equal([
      { id: 'a', name: 'Canonical', type: 'Marketing' },
    ]);
  });

  for (const [title, detail] of [
    ['object variant', workspace('a', 'Canonical', 'marketing')],
    ['string variant', { id: 'a', name: 'Canonical', spaceType: 'MARKETING' }],
  ] as const) {
    it(`prefers the recognized detail ${title}`, async () => {
      const request = sinon.stub().callsFake(({ url }: { url: string }) =>
        url.startsWith('/connect/cms/spaces?')
          ? fakeRequest({
              spaces: pageNumber(url) === 0 ? [workspace('a', 'Listed', 'marketing')] : [],
            })
          : fakeRequest(detail),
      );

      const result = await preflightBulkWorkspaceExport(
        { request },
        path.join(root, 'cms'),
        'Marketing',
      );
      expect(result.selected[0]).to.include({ id: 'a', name: 'Canonical', type: 'Marketing' });
    });
  }

  it('rejects an explicit contradictory detail type despite Marketing list evidence', async () => {
    const outputDirectory = path.join(root, 'cms');
    const request = sinon.stub().callsFake(({ url }: { url: string }) =>
      url.startsWith('/connect/cms/spaces?')
        ? fakeRequest({
            spaces: pageNumber(url) === 0 ? [workspace('a', 'Listed', 'marketing')] : [],
          })
        : fakeRequest(workspace('a', 'Canonical', 'content')),
    );

    const result = await preflightBulkWorkspaceExport({ request }, outputDirectory, 'Marketing');
    expect(result).to.deep.equal({ discoveredCount: 1, selected: [] });
    try {
      await access(outputDirectory);
      expect.fail('expected zero destinations');
    } catch (error) {
      expect((error as NodeJS.ErrnoException).code).to.equal('ENOENT');
    }
  });

  for (const [title, detailType] of [
    ['null value', null],
    ['array value', ['marketing']],
    ['number value', 1],
    ['boolean value', true],
    ['unsupported string', 'enablement'],
    ['malformed object', { unexpected: 'marketing' }],
    ['object with non-string apiName', { apiName: 1 }],
  ] as const) {
    it(`rejects canonical ${title} despite exact-ID list evidence`, async () => {
      const request = sinon.stub().callsFake(({ url }: { url: string }) =>
        url.startsWith('/connect/cms/spaces?')
          ? fakeRequest({
              spaces: pageNumber(url) === 0 ? [workspace('a', 'Listed', 'marketing')] : [],
            })
          : fakeRequest(workspace('a', 'Canonical', detailType)),
      );

      try {
        await preflightBulkWorkspaceExport({ request }, path.join(root, 'cms'), 'Marketing');
        expect.fail('expected malformed canonical type rejection');
      } catch (error) {
        expect((error as Error).message).to.equal('Workspace type must be Marketing or Content.');
      }
      expect(request.callCount).to.equal(3);
    });
  }

  it('rejects malformed canonical identity before trusting list type evidence', async () => {
    const request = sinon.stub().callsFake(({ url }: { url: string }) =>
      url.startsWith('/connect/cms/spaces?')
        ? fakeRequest({
            spaces: pageNumber(url) === 0 ? [workspace('a', 'Listed', 'marketing')] : [],
          })
        : fakeRequest({ id: 'different', name: 'Canonical' }),
    );

    try {
      await preflightBulkWorkspaceExport({ request }, path.join(root, 'cms'), 'Marketing');
      expect.fail('expected malformed identity rejection');
    } catch (error) {
      expect((error as Error).message).to.include('malformed or mismatched ID/name');
    }
    expect(request.callCount).to.equal(3);
  });

  for (const [title, second, diagnostic] of [
    ['Marketing plus null', workspace('a', 'Listed', null), 'Marketing and invalid'],
    [
      'Marketing plus malformed or unsupported',
      workspace('a', 'Listed', { apiName: 'enablement' }),
      'Marketing and invalid',
    ],
    ['Marketing plus missing', workspace('a', 'Listed'), 'Marketing and missing'],
    ['Marketing plus Content', workspace('a', 'Listed', 'content'), 'Marketing and Content'],
  ] as const) {
    it(`rejects duplicate exact-ID evidence: ${title}`, async () => {
      const outputDirectory = path.join(root, 'cms');
      const pages = [
        [workspace('a', 'Listed', 'marketing')],
        [second, workspace('b', 'Progress', 'marketing')],
        [],
      ];
      const request = sinon.stub().callsFake(({ url }: { url: string }) => {
        if (!url.startsWith('/connect/cms/spaces?')) {
          throw new Error(`unexpected canonical GET/export request: ${url}`);
        }
        return fakeRequest({ spaces: pages[pageNumber(url)] ?? [] });
      });

      try {
        await exportAllWorkspaces({ request }, outputDirectory, 'Marketing');
        expect.fail('expected inconsistent list type evidence rejection');
      } catch (error) {
        expect((error as Error).message).to.equal(
          `Workspace listing returned inconsistent type evidence for ID a: ${diagnostic}.`,
        );
      }
      expect(request.callCount).to.equal(2);
      try {
        await access(outputDirectory);
        expect.fail('expected no export output');
      } catch (error) {
        expect((error as NodeJS.ErrnoException).code).to.equal('ENOENT');
      }
    });
  }

  it('correlates duplicate list type evidence by exact ID rather than name', async () => {
    const pages = [
      [
        workspace('a', 'Same', 'marketing'),
        workspace('b', 'Same', 'content'),
        workspace('a', 'Swapped B', 'marketing'),
        workspace('b', 'Swapped A', 'content'),
      ],
      [],
    ];
    const request = sinon.stub().callsFake(({ url }: { url: string }) => {
      if (url.startsWith('/connect/cms/spaces?')) {
        return fakeRequest({ spaces: pages[pageNumber(url)] ?? [] });
      }
      return url.endsWith('/a')
        ? fakeRequest(workspace('a', 'Canonical A'))
        : fakeRequest(workspace('b', 'Canonical B'));
    });

    const result = await preflightBulkWorkspaceExport(
      { request },
      path.join(root, 'cms'),
      'Marketing',
    );

    expect(result.selected.map(({ id, type }) => ({ id, type }))).to.deep.equal([
      { id: 'a', type: 'Marketing' },
    ]);
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
      if (url === '/connect/cms/spaces/a') return fakeRequest(workspace('a', 'First'));
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
      if (url === '/connect/cms/spaces/a') return fakeRequest(workspace('a', 'First'));
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

    expect(Object.keys(envelope).toSorted()).to.deep.equal(
      [
        'contract',
        'contractVersion',
        'status',
        'metadata',
        'diagnostics',
        'provenance',
        'result',
      ].toSorted(),
    );
    expect(envelope).to.deep.include({
      contract: 'sf-cms-workspace-export-set',
      contractVersion: '1.0.0',
      status: 'partial',
    });
    expect(result.workspaceType).to.equal('Marketing');
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
      result.workspaces.map(({ source, status }) => ({
        id: source.sourceId,
        name: source.name,
        type: source.workspaceType,
        status,
      })),
    ).to.deep.equal([
      { id: 'a', name: 'First', type: 'Marketing', status: 'failed' },
      { id: 'b', name: 'Second', type: 'Marketing', status: 'success' },
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
