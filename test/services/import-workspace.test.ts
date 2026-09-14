import { expect } from 'chai';
import { createHash } from 'node:crypto';
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import sinon from 'sinon';
import {
  executeWorkspaceImport,
  loadWorkspaceExport,
  planWorkspaceImport,
  rewriteAtomic,
  WorkspaceImportOwnershipUncertainError,
  type LoadedWorkspaceExport,
} from '../../src/services/import-workspace.js';

type FakeRequest<T> = Promise<T> & { stream(): PassThrough };

function fakeRequest<T>(value: T): FakeRequest<T> {
  return Object.assign(Promise.resolve(value), { stream: () => new PassThrough() });
}

function failedRequest(statusCode: number, message = 'request failed'): FakeRequest<never> {
  return Object.assign(Promise.reject(Object.assign(new Error(message), { statusCode })), {
    stream: () => new PassThrough(),
  });
}

function item(id: string, language = 'en', contentKey = 'key', overrides = {}) {
  return {
    apiName: 'api_name',
    contentBody: { body: `${language} body` },
    contentKey,
    contentSpace: { id: 'source-space' },
    contentType: 'sfdc_cms__news',
    externalId: 'external-id',
    externalSource: { source: 'migration' },
    id,
    language,
    serverOwned: 'strip-me',
    title: `${language} title`,
    urlName: `${language}-title`,
    ...overrides,
  };
}

function referenceId(sourceId: string): string {
  return `ref:${createHash('sha256')
    .update(JSON.stringify({ kind: 'cms.content', sourceId, workspaceId: 'source-space' }))
    .digest('hex')}`;
}

function manifest(
  exportedItems: readonly ReturnType<typeof item>[],
  itemBytes: ReadonlyMap<string, string>,
  overrides = {},
) {
  const ids = exportedItems.map(({ id }) => id);
  const contentReferences = new Map<string, ReturnType<typeof item>>();
  for (const exportedItem of exportedItems)
    contentReferences.set(exportedItem.contentKey, exportedItem);
  const externalReferences = [...contentReferences.values()]
    .map((exportedItem) => ({
      referenceId: referenceId(exportedItem.contentKey),
      owner: 'cms',
      kind: 'cms.content',
      source: { workspaceId: 'source-space', sourceId: exportedItem.contentKey },
      portableKey: { scheme: 'cms-opaque-v1', value: exportedItem.contentKey },
      required: true,
      resolution: 'included',
    }))
    .toSorted((left, right) => left.referenceId.localeCompare(right.referenceId));
  return {
    entries: ids.map((variantId) => ({ file: `items/${variantId}.json`, variantId })),
    expectedCount: ids.length,
    exportedCount: ids.length,
    failedVariantIds: [],
    foundCount: ids.length,
    mode: 'experimental-best-effort',
    pagesRequested: 1,
    rejectedVariantIds: [],
    schemaVersion: 1,
    search: {
      contentSpaceOrFolderIds: ['source-space'],
      languages: ['All'],
      pageSize: 250,
      queryTerm: '*',
    },
    warnings: [{ code: 'UNSUPPORTED_WILDCARD', message: 'provenance only' }],
    workspaceId: 'source-space',
    contract: 'sf-cms-workspace-export',
    contractVersion: '1.0.0',
    provenance: {
      producer: 'sf-plugin-cms',
      sourceOrgId: '00D-source',
      sourceWorkspaceId: 'source-space',
      pluginVersion: '0.3.0',
      generatedAt: '2026-09-13T18:00:00.000Z',
    },
    completeness: 'complete',
    dependencies: [],
    externalReferences,
    items: ids.map((id) => ({
      path: `items/${id}.json`,
      sha256: createHash('sha256')
        .update(itemBytes.get(id) ?? '')
        .digest('hex'),
      kind: 'cms.content',
      referenceId: referenceId(exportedItems.find((value) => value.id === id)!.contentKey),
    })),
    ...overrides,
  };
}

async function writeExport(
  root: string,
  items: readonly ReturnType<typeof item>[],
  manifestOverrides = {},
) {
  const source = path.join(root, 'source');
  await mkdir(path.join(source, 'items'), { recursive: true });
  const itemBytes = new Map<string, string>();
  for (const value of items) {
    const bytes = `${JSON.stringify(value)}\n`;
    itemBytes.set(value.id, bytes);
    await writeFile(path.join(source, 'items', `${value.id}.json`), bytes);
  }
  await writeFile(
    path.join(source, 'manifest.json'),
    `${JSON.stringify(manifest(items, itemBytes, manifestOverrides))}\n`,
  );
  return source;
}

function workspace(defaultLanguage = 'en') {
  return { defaultLanguage, id: 'destination-space', rootFolderId: 'root-folder' };
}

async function expectRejected(promise: Promise<unknown>): Promise<void> {
  try {
    await promise;
    expect.fail('expected rejection');
  } catch (error) {
    expect(error).to.be.instanceOf(Error);
  }
}

function requestRouter(
  options: { childFailure?: boolean; conflict?: boolean; lookupStatus?: number } = {},
) {
  let createdParents = 0;
  return sinon.stub().callsFake((request: { body?: string; method: string; url: string }) => {
    const { method, url } = request;
    if (method === 'GET') {
      if (options.conflict)
        return fakeRequest({ contentKey: decodeURIComponent(url.split('/').at(-1) ?? '') });
      return failedRequest(options.lookupStatus ?? 404);
    }
    const body = JSON.parse(request.body ?? '{}') as Record<string, unknown>;
    if (url.endsWith('/variants')) {
      if (options.childFailure) return failedRequest(500, 'child failed');
      return fakeRequest({ id: `child-${String(body.language)}` });
    }
    createdParents += 1;
    return fakeRequest({
      contentKey: body.contentKey,
      id: `content-${createdParents}`,
      primaryVariantId: `primary-${createdParents}`,
    });
  });
}

describe('workspace import core', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'sf-plugin-cms-import-'));
  });

  afterEach(async () => {
    await rm(root, { force: true, recursive: true });
  });

  it('retries transient Windows atomic replacement errors and cleans the sibling temp file', async () => {
    const destination = path.join(root, 'workspace-import-run.json');
    await writeFile(destination, 'old report\n');
    const transient = Object.assign(new Error('scanner temporarily holds destination'), {
      code: 'EPERM',
    });
    const renamePath = sinon.stub();
    renamePath.onFirstCall().rejects(transient);
    renamePath
      .onSecondCall()
      .rejects(Object.assign(new Error('destination still busy'), { code: 'EBUSY' }));
    renamePath.onThirdCall().callsFake(async (source: string, target: string) => {
      await rename(source, target);
    });
    const wait = sinon.stub().resolves();

    await rewriteAtomic(
      destination,
      { state: 'completed' },
      {
        delay: wait,
        platform: 'win32',
        renamePath,
      },
    );

    expect(wait.args).to.deep.equal([[10], [25]]);
    expect(await readFile(destination, 'utf8')).to.equal('{\n  "state": "completed"\n}\n');
    const remainingFiles = await readdir(root);
    expect(remainingFiles.filter((name) => name.includes('.tmp-'))).to.deep.equal([]);
  });

  it('preserves permanent atomic replacement errors and cleans the sibling temp file', async () => {
    const destination = path.join(root, 'workspace-import-run.json');
    await writeFile(destination, 'old report\n');
    const permanent = Object.assign(new Error('destination remains locked'), { code: 'EPERM' });
    const renamePath = sinon.stub().rejects(permanent);
    const wait = sinon.stub().resolves();

    try {
      await rewriteAtomic(
        destination,
        { state: 'completed' },
        {
          delay: wait,
          platform: 'win32',
          renamePath,
        },
      );
      expect.fail('expected permanent rename failure');
    } catch (error) {
      expect(error).to.equal(permanent);
    }

    expect(renamePath.callCount).to.equal(4);
    expect(wait.args).to.deep.equal([[10], [25], [50]]);
    expect(await readFile(destination, 'utf8')).to.equal('old report\n');
    const remainingFiles = await readdir(root);
    expect(remainingFiles.filter((name) => name.includes('.tmp-'))).to.deep.equal([]);
  });

  it('preserves the original replacement error identity when temp cleanup fails', async () => {
    const destination = path.join(root, 'workspace-import-run.json');
    await writeFile(destination, 'old report\n');
    const publicationError = Object.assign(new Error('replacement failed'), { code: 'EACCES' });
    const cleanupError = Object.assign(new Error('cleanup failed'), { code: 'EPERM' });

    try {
      await rewriteAtomic(
        destination,
        { state: 'completed' },
        {
          platform: 'win32',
          removePath: sinon.stub().rejects(cleanupError),
          renamePath: sinon.stub().rejects(publicationError),
        },
      );
      expect.fail('expected replacement failure');
    } catch (error) {
      expect(error).to.equal(publicationError);
      expect((error as Error & { cleanupError?: unknown }).cleanupError).to.equal(cleanupError);
    }

    expect(await readFile(destination, 'utf8')).to.equal('old report\n');
    const remainingFiles = await readdir(root);
    expect(remainingFiles.some((name) => name.includes('.tmp-'))).to.equal(true);
  });

  it('preserves the primary error when cleanup diagnostics cannot be attached', async () => {
    const destination = path.join(root, 'workspace-import-run.json');
    await writeFile(destination, 'old report\n');
    const publicationError = Object.assign(new Error('replacement failed'), { code: 'EACCES' });
    Object.defineProperty(publicationError, 'cleanupError', {
      configurable: false,
      value: 'existing diagnostic',
    });

    try {
      await rewriteAtomic(
        destination,
        { state: 'completed' },
        {
          removePath: sinon.stub().rejects(new Error('cleanup failed')),
          renamePath: sinon.stub().rejects(publicationError),
        },
      );
      expect.fail('expected replacement failure');
    } catch (error) {
      expect(error).to.equal(publicationError);
      expect((error as Error & { cleanupError?: unknown }).cleanupError).to.equal(
        'existing diagnostic',
      );
    }
  });

  it('does not retry non-Windows or unrelated atomic replacement errors', async () => {
    const cases = [
      { code: 'EPERM', platform: 'linux' as const },
      { code: 'EACCES', platform: 'win32' as const },
    ];
    for (const [index, testCase] of cases.entries()) {
      const destination = path.join(root, `workspace-import-run-${index}.json`);
      await writeFile(destination, 'old report\n');
      const failure = Object.assign(new Error('rename failed'), { code: testCase.code });
      const renamePath = sinon.stub().rejects(failure);
      const wait = sinon.stub().resolves();

      try {
        await rewriteAtomic(
          destination,
          { state: 'completed' },
          {
            delay: wait,
            platform: testCase.platform,
            renamePath,
          },
        );
        expect.fail('expected rename failure');
      } catch (error) {
        expect(error).to.equal(failure);
      }

      expect(renamePath.callCount).to.equal(1);
      expect(wait.callCount).to.equal(0);
      expect(await readFile(destination, 'utf8')).to.equal('old report\n');
    }
    const remainingFiles = await readdir(root);
    expect(remainingFiles.filter((name) => name.includes('.tmp-'))).to.deep.equal([]);
  });

  it('loads a complete export and treats unsupported wildcard alone as non-partial', async () => {
    const source = await writeExport(root, [item('primary'), item('french', 'fr')]);

    const loaded = await loadWorkspaceExport(source);

    expect(loaded.isPartial).to.equal(false);
    expect(loaded.items.map(({ id }) => id)).to.deep.equal(['primary', 'french']);
    expect(loaded.manifestSha256).to.match(/^[a-f\d]{64}$/u);
    expect(loaded.integrity).to.deep.equal({
      listedItemCount: 2,
      verifiedItemCount: 2,
      unlistedFileCount: 0,
      verified: true,
    });
  });

  for (const [name, overrides] of [
    ['failed IDs', { completeness: 'partial', failedVariantIds: ['failed'] }],
    ['rejected IDs', { completeness: 'partial', rejectedVariantIds: ['rejected'] }],
    ['count mismatch', { completeness: 'partial', expectedCount: 2 }],
    [
      'unresolved reference warning',
      {
        completeness: 'partial',
        warnings: [{ code: 'REFERENCE_UNRESOLVED', message: 'partial' }],
      },
    ],
    [
      'unsupported reference warning',
      {
        completeness: 'partial',
        warnings: [{ code: 'REFERENCE_UNSUPPORTED', message: 'partial' }],
      },
    ],
  ] as const) {
    it(`rejects ${name} by default and accepts it only with allowPartial`, async () => {
      const source = await writeExport(root, [item('primary')], overrides);
      try {
        await loadWorkspaceExport(source);
        expect.fail('expected partial rejection');
      } catch (error) {
        expect((error as Error).message).to.include('partial');
      }
      const loaded = await loadWorkspaceExport(source, { allowPartial: true });
      expect(loaded.isPartial).to.equal(true);
    });
  }

  it('rejects contradictory complete manifests even with allowPartial', async () => {
    for (const overrides of [
      { failedVariantIds: ['failed'] },
      { rejectedVariantIds: ['rejected'] },
      { expectedCount: 2 },
      { warnings: [{ code: 'COUNT_MISMATCH', message: 'incomplete' }] },
      {
        provenance: {
          producer: 'sf-plugin-cms',
          sourceOrgId: '00D-source',
          sourceWorkspaceId: 'other-space',
          pluginVersion: '0.3.0',
          generatedAt: '2026-09-13T18:00:00.000Z',
        },
      },
      {
        externalReferences: [
          {
            referenceId: referenceId('key'),
            owner: 'cms',
            kind: 'cms.content',
            source: { workspaceId: 'other-space', sourceId: 'key' },
            portableKey: { scheme: 'cms-opaque-v1', value: 'key' },
            required: true,
            resolution: 'unresolved',
          },
        ],
      },
    ]) {
      const caseRoot = await mkdtemp(path.join(root, 'contradictory-'));
      const source = await writeExport(caseRoot, [item('primary')], overrides);
      await expectRejected(loadWorkspaceExport(source));
      await expectRejected(loadWorkspaceExport(source, { allowPartial: true }));
    }
  });

  it('rejects unsafe paths, separator IDs, duplicate mappings, and substituted files', async () => {
    const cases = [
      { entries: [{ file: '../escape.json', variantId: 'primary' }] },
      { entries: [{ file: path.resolve(root, 'escape.json'), variantId: 'primary' }] },
      { entries: [{ file: 'items/bad/id.json', variantId: 'bad/id' }] },
      {
        entries: [
          { file: 'items/primary.json', variantId: 'primary' },
          { file: 'items/primary.json', variantId: 'primary' },
        ],
        exportedCount: 2,
        expectedCount: 2,
      },
      { entries: [{ file: 'items/other.json', variantId: 'primary' }] },
    ];
    for (const overrides of cases) {
      const caseRoot = await mkdtemp(path.join(root, 'case-'));
      const source = await writeExport(caseRoot, [item('primary')], overrides);
      try {
        await loadWorkspaceExport(source, { allowPartial: true });
        expect.fail('expected structural rejection');
      } catch (error) {
        expect(error).to.be.instanceOf(Error);
      }
    }
  });

  it('rejects missing, extra, symlinked, and variant-mismatched item files', async () => {
    const missingRoot = await mkdtemp(path.join(root, 'missing-'));
    const missing = await writeExport(missingRoot, [item('primary')]);
    await rm(path.join(missing, 'items', 'primary.json'));
    try {
      await loadWorkspaceExport(missing);
      expect.fail('expected missing-file rejection');
    } catch (error) {
      expect(error).to.be.instanceOf(TypeError);
      expect((error as Error).message).to.include('missing');
    }

    const extraRoot = await mkdtemp(path.join(root, 'extra-'));
    const extra = await writeExport(extraRoot, [item('primary')]);
    await writeFile(path.join(extra, 'items', 'extra.json'), '{}');
    await expectRejected(loadWorkspaceExport(extra));

    const mismatchRoot = await mkdtemp(path.join(root, 'mismatch-'));
    const mismatch = await writeExport(mismatchRoot, [item('primary')]);
    await writeFile(path.join(mismatch, 'items', 'primary.json'), JSON.stringify(item('other')));
    await expectRejected(loadWorkspaceExport(mismatch));

    const linkRoot = await mkdtemp(path.join(root, 'link-'));
    const link = await writeExport(linkRoot, [item('primary')]);
    const target = path.join(linkRoot, 'target.json');
    await writeFile(target, JSON.stringify(item('primary')));
    await rm(path.join(link, 'items', 'primary.json'));
    try {
      await symlink(target, path.join(link, 'items', 'primary.json'), 'file');
      await expectRejected(loadWorkspaceExport(link));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error;
    }
  });

  it('rejects workspace, required-field, body, duplicate pair, and apiName relationship failures', async () => {
    const invalidItems = [
      item('one', 'en', 'key', { contentSpace: { id: 'other' } }),
      item('one', 'en', 'key', { title: '' }),
      item('one', 'en', 'key', { contentBody: [] }),
      item('one', 'en', 'key', { contentType: 'news' }),
    ];
    for (const invalid of invalidItems) {
      const caseRoot = await mkdtemp(path.join(root, 'invalid-'));
      const source = await writeExport(caseRoot, [invalid]);
      await expectRejected(loadWorkspaceExport(source));
    }
    const duplicateRoot = await mkdtemp(path.join(root, 'duplicate-'));
    const duplicateSource = await writeExport(duplicateRoot, [item('one'), item('two', 'en')]);
    await expectRejected(loadWorkspaceExport(duplicateSource));
    const apiRoot = await mkdtemp(path.join(root, 'api-'));
    const apiSource = await writeExport(apiRoot, [
      item('one'),
      item('two', 'fr', 'key', { apiName: 'other' }),
    ]);
    await expectRejected(loadWorkspaceExport(apiSource));
  });

  it('performs all local validation before any remote request', async () => {
    const source = await writeExport(root, [item('primary', 'en', 'key', { contentBody: [] })]);
    const request = sinon.stub();

    await expectRejected(
      executeWorkspaceImport({
        connection: { request },
        destinationOrgId: '00D-org-id',
        destinationWorkspace: workspace(),
        dryRun: true,
        sourceDirectory: source,
        workspaceId: 'destination-space',
      }),
    );
    expect(request.callCount).to.equal(0);
  });

  it('rejects exact-byte item hash substitution before org access', async () => {
    const source = await writeExport(root, [item('primary')]);
    await writeFile(
      path.join(source, 'items', 'primary.json'),
      `${JSON.stringify(item('primary'))} \n`,
    );
    const request = sinon.stub();

    await expectRejected(
      executeWorkspaceImport({
        connection: { request },
        destinationOrgId: '00D-org-id',
        destinationWorkspace: workspace(),
        dryRun: true,
        sourceDirectory: source,
        workspaceId: 'destination-space',
      }),
    );
    expect(request.notCalled).to.equal(true);
  });

  it('selects only the destination default language and rejects missing or ambiguous primaries', async () => {
    const source = await writeExport(root, [item('english'), item('french', 'fr')]);
    const loaded = await loadWorkspaceExport(source);
    expect(
      planWorkspaceImport(loaded, workspace('fr'), 'destination-space').groups[0].primary.id,
    ).to.equal('french');
    expect(() => planWorkspaceImport(loaded, workspace('de'), 'destination-space')).to.throw(
      'exactly one',
    );
    expect(() => planWorkspaceImport(loaded, workspace('en'), 'other-space')).to.throw(
      'exactly match',
    );
    expect(() =>
      planWorkspaceImport(loaded, { ...workspace('en'), rootFolderId: '' }, 'destination-space'),
    ).to.throw('rootFolderId');

    const unsafe = {
      ...loaded,
      items: [...loaded.items, { ...loaded.items[0], id: 'second-english' }],
    } as LoadedWorkspaceExport;
    expect(() => planWorkspaceImport(unsafe, workspace('en'), 'destination-space')).to.throw(
      'exactly one',
    );
  });

  it('hard-fails existing content and non-not-found lookup errors without mutation', async () => {
    const source = await writeExport(root, [item('primary')]);
    for (const request of [
      requestRouter({ conflict: true }),
      requestRouter({ lookupStatus: 500 }),
    ]) {
      await expectRejected(
        executeWorkspaceImport({
          connection: { request },
          destinationOrgId: '00D-org-id',
          destinationWorkspace: workspace(),
          dryRun: true,
          sourceDirectory: source,
          workspaceId: 'destination-space',
        }),
      );
      expect(request.getCalls().every(({ args }) => args[0].method === 'GET')).to.equal(true);
    }
  });

  it('dry-runs complete remote preflight without mutation', async () => {
    const source = await writeExport(root, [
      item('one', 'en', 'a', { apiName: 'api_a' }),
      item('two', 'en', 'b', { apiName: 'api_b' }),
    ]);
    const request = requestRouter();

    const result = await executeWorkspaceImport({
      connection: { request },
      destinationOrgId: '00D-org-id',
      destinationWorkspace: workspace(),
      dryRun: true,
      sourceDirectory: source,
      workspaceId: 'destination-space',
    });

    expect(result.dryRun).to.equal(true);
    expect(request.callCount).to.equal(2);
    expect(request.getCalls().every(({ args }) => args[0].method === 'GET')).to.equal(true);
  });

  it('emits no resolved mappings for dry-run and preserves explicit unsupported references', async () => {
    const unsupportedReference = {
      referenceId: `ref:${'a'.repeat(64)}`,
      owner: 'cms',
      kind: 'cms.unknown',
      source: { workspaceId: 'source-space', sourceId: 'unknown-source' },
      portableKey: { scheme: 'cms-opaque-v1', value: 'unknown-key' },
      required: true,
      resolution: 'unsupported',
    };
    const source = await writeExport(root, [item('primary')], {
      completeness: 'partial',
      externalReferences: [unsupportedReference],
      dependencies: [],
      items: [
        {
          path: 'items/primary.json',
          sha256: createHash('sha256')
            .update(`${JSON.stringify(item('primary'))}\n`)
            .digest('hex'),
          kind: 'cms.content',
        },
      ],
      warnings: [
        {
          code: 'REFERENCE_UNSUPPORTED',
          message: 'unsupported',
          variantIds: ['primary'],
        },
      ],
    });
    const result = await executeWorkspaceImport({
      allowPartial: true,
      connection: { request: requestRouter() },
      destinationOrgId: '00D-org-id',
      destinationWorkspace: workspace(),
      dryRun: true,
      sourceDirectory: source,
      workspaceId: 'destination-space',
    });

    expect(result.contractResult.mappings).to.deep.equal([]);
    expect(result.contractResult.references).to.deep.equal([
      {
        referenceId: unsupportedReference.referenceId,
        kind: 'cms.unknown',
        status: 'unsupported',
      },
    ]);
  });

  it('creates exact direct payloads and binds a durable report to org, workspace, and source', async () => {
    const source = await writeExport(root, [item('primary'), item('french', 'fr')]);
    const request = requestRouter();
    const reportDirectory = path.join(root, 'report');

    const result = await executeWorkspaceImport({
      connection: { request },
      destinationOrgId: '00D-org-id',
      destinationWorkspace: workspace(),
      reportDirectory,
      sourceDirectory: source,
      workspaceId: 'destination-space',
    });

    const mutationCalls = request.getCalls().filter(({ args }) => args[0].method === 'POST');
    expect(JSON.parse(mutationCalls[0].args[0].body)).to.deep.equal({
      apiName: 'api_name',
      contentBody: { body: 'en body' },
      contentKey: 'key',
      contentSpaceOrFolderId: 'root-folder',
      contentType: 'sfdc_cms__news',
      externalId: 'external-id',
      externalSource: { source: 'migration' },
      title: 'en title',
      urlName: 'en-title',
    });
    expect(JSON.parse(mutationCalls[1].args[0].body)).to.deep.equal({
      contentBody: { body: 'fr body' },
      language: 'fr',
      managedContentKeyOrId: 'key',
      title: 'fr title',
      urlName: 'fr-title',
    });
    expect(result.contractResult.mappings).to.have.length(1);
    expect(result.contractResult.mappings[0]).to.deep.include({
      referenceId: referenceId('key'),
      kind: 'cms.content',
      operation: 'created',
      status: 'resolved',
      cmsReferencesRewritten: true,
    });
    expect(result.contractResult.mappings[0].target).to.deep.equal({
      targetId: 'content-1',
      targetReference: 'key',
    });
    const report = JSON.parse(await readFile(result.reportFile!, 'utf8'));
    expect(report).to.include({
      destinationOrgId: '00D-org-id',
      destinationWorkspaceId: 'destination-space',
      sourceDirectory: await realpath(source),
      state: 'completed',
    });
    expect(report.runId).to.be.a('string');
    expect(report.runId).not.to.equal('');
    expect(report.sourceManifestSha256).to.match(/^[a-f\d]{64}$/u);
    expect(report.createdParents).to.deep.equal([
      {
        childVariantIds: ['child-fr'],
        contentId: 'content-1',
        contentKey: 'key',
        primaryVariantId: 'primary-1',
      },
    ]);
    const reportBytes = await readFile(result.reportFile!, 'utf8');
    expect(reportBytes.endsWith('\n')).to.equal(true);
  });

  it('touches only evidenced CMS contentBody ref.contentKey locations and requires payload proof', async () => {
    const source = await writeExport(root, [
      item('first', 'en', 'first-key', { apiName: 'first-api' }),
      item('second', 'en', 'second-key', {
        apiName: 'second-api',
        contentBody: {
          card: { ref: { contentKey: 'first-key', type: 'imageReference' } },
          unrelated: 'first-key',
        },
        externalSource: { contentKey: 'first-key' },
      }),
    ]);
    const request = requestRouter();

    const result = await executeWorkspaceImport({
      connection: { request },
      destinationOrgId: '00D-org-id',
      destinationWorkspace: workspace(),
      reportDirectory: path.join(root, 'rewrite-report'),
      sourceDirectory: source,
      workspaceId: 'destination-space',
    });

    const mutations = request.getCalls().filter(({ args }) => args[0].method === 'POST');
    expect(JSON.parse(mutations[1].args[0].body)).to.deep.include({
      contentBody: {
        card: { ref: { contentKey: 'first-key', type: 'imageReference' } },
        unrelated: 'first-key',
      },
      externalSource: { contentKey: 'first-key' },
    });
    expect(result.contractResult.references).to.deep.equal([
      {
        referenceId: referenceId('second-key'),
        kind: 'cms.content',
        status: 'unresolved',
      },
    ]);
    expect(result.contractResult.mappings).to.have.length(1);
    expect(result.contractResult.mappings[0].referenceId).to.equal(referenceId('first-key'));
  });

  it('leaves forward references unresolved and preserves their exact outgoing payload', async () => {
    const source = await writeExport(root, [
      item('first', 'en', 'first-key', {
        apiName: 'first-api',
        contentBody: { card: { ref: { contentKey: 'second-key', type: 'imageReference' } } },
      }),
      item('second', 'en', 'second-key', { apiName: 'second-api' }),
    ]);
    const request = requestRouter();

    const result = await executeWorkspaceImport({
      connection: { request },
      destinationOrgId: '00D-org-id',
      destinationWorkspace: workspace(),
      reportDirectory: path.join(root, 'forward-report'),
      sourceDirectory: source,
      workspaceId: 'destination-space',
    });

    const mutation = request.getCalls().find(({ args }) => args[0].method === 'POST');
    expect(mutation).not.to.equal(undefined);
    expect(JSON.parse(mutation!.args[0].body).contentBody).to.deep.equal({
      card: { ref: { contentKey: 'second-key', type: 'imageReference' } },
    });
    expect(result.contractResult.references).to.deep.include({
      referenceId: referenceId('second-key'),
      kind: 'cms.content',
      status: 'unresolved',
    });
    expect(
      result.contractResult.mappings.some(({ referenceId: id }) => id === referenceId('first-key')),
    ).to.equal(false);
  });

  it('accepts the live managed-content response identifier fields', async () => {
    const source = await writeExport(root, [item('primary')]);
    const request = sinon.stub().callsFake((request_: { method: string; url: string }) => {
      if (request_.method === 'GET') return failedRequest(404);
      return fakeRequest({
        contentKey: 'key',
        managedContentId: 'managed-content-id',
        managedContentVariantId: 'managed-variant-id',
      });
    });
    const result = await executeWorkspaceImport({
      connection: { request },
      destinationOrgId: '00D-org-id',
      destinationWorkspace: workspace(),
      reportDirectory: path.join(root, 'live-shape-report'),
      sourceDirectory: source,
      workspaceId: 'destination-space',
    });

    expect(result.report?.createdParents).to.deep.equal([
      {
        childVariantIds: [],
        contentId: 'managed-content-id',
        contentKey: 'key',
        primaryVariantId: 'managed-variant-id',
      },
    ]);
  });

  it('persists each parent before its child and journals a child mutation failure', async () => {
    const source = await writeExport(root, [item('primary'), item('french', 'fr')]);
    const request = requestRouter({ childFailure: true });
    const reportDirectory = path.join(root, 'report');

    await expectRejected(
      executeWorkspaceImport({
        connection: { request },
        destinationOrgId: '00D-org-id',
        destinationWorkspace: workspace(),
        reportDirectory,
        sourceDirectory: source,
        workspaceId: 'destination-space',
      }),
    );

    const report = JSON.parse(
      await readFile(path.join(reportDirectory, 'workspace-import-run.json'), 'utf8'),
    );
    expect(report.state).to.equal('failed');
    expect(report.createdParents[0]).to.include({
      contentId: 'content-1',
      primaryVariantId: 'primary-1',
    });
    expect(report.operations[1]).to.include({
      contentKey: 'key',
      destinationOrgId: '00D-org-id',
      destinationWorkspaceId: 'destination-space',
      error: 'child failed',
      language: 'fr',
      operationKind: 'create-child',
      state: 'failed',
    });
    expect(request.getCalls().filter(({ args }) => args[0].method === 'POST')).to.have.length(2);
  });

  it('journals a parent mutation failure without recording created ownership', async () => {
    const source = await writeExport(root, [item('primary')]);
    const request = sinon
      .stub()
      .callsFake((request_: { method: string }) =>
        request_.method === 'GET' ? failedRequest(404) : failedRequest(500, 'parent failed'),
      );
    const reportDirectory = path.join(root, 'parent-mutation-failure');

    await expectRejected(
      executeWorkspaceImport({
        connection: { request },
        destinationOrgId: '00D-org-id',
        destinationWorkspace: workspace(),
        reportDirectory,
        sourceDirectory: source,
        workspaceId: 'destination-space',
      }),
    );

    const report = JSON.parse(
      await readFile(path.join(reportDirectory, 'workspace-import-run.json'), 'utf8'),
    );
    expect(report).to.include({ state: 'failed' });
    expect(report.createdParents).to.deep.equal([]);
    expect(report.operations[0]).to.include({
      contentKey: 'key',
      error: 'parent failed',
      language: 'en',
      operationKind: 'create-parent',
      state: 'failed',
    });
  });

  it('makes no mutation when report creation fails', async () => {
    const source = await writeExport(root, [item('primary')]);
    const request = requestRouter();
    const reportDirectory = path.join(root, 'existing-report');
    await mkdir(reportDirectory);

    await expectRejected(
      executeWorkspaceImport({
        connection: { request },
        destinationOrgId: '00D-org-id',
        destinationWorkspace: workspace(),
        reportDirectory,
        sourceDirectory: source,
        workspaceId: 'destination-space',
      }),
    );
    expect(request.getCalls().filter(({ args }) => args[0].method === 'POST')).to.have.length(0);
  });

  it('persists parent and child pending intent before each mutation', async () => {
    const source = await writeExport(root, [item('primary'), item('french', 'fr')]);
    const request = requestRouter();
    const snapshots: unknown[] = [];
    const reportDirectory = path.join(root, 'intent-report');

    await executeWorkspaceImport({
      connection: { request },
      destinationOrgId: '00D-org-id',
      destinationWorkspace: workspace(),
      reportDirectory,
      reportPersistence: {
        rewrite: async (file, report) => {
          snapshots.push(structuredClone(report));
          await writeFile(file, `${JSON.stringify(report, null, 2)}\n`);
        },
      },
      sourceDirectory: source,
      workspaceId: 'destination-space',
    });

    const pending = snapshots
      .flatMap(
        (snapshot) => (snapshot as { operations: Array<Record<string, unknown>> }).operations,
      )
      .filter(({ state }) => state === 'pending');
    expect(pending.map(({ operationKind }) => operationKind)).to.include.members([
      'create-parent',
      'create-child',
    ]);
    for (const operation of pending) {
      expect(operation).to.include({
        contentKey: 'key',
        destinationOrgId: '00D-org-id',
        destinationWorkspaceId: 'destination-space',
      });
      expect(operation.operationId).to.match(/^[a-f\d]{64}$/u);
      expect(operation.requestSha256).to.match(/^[a-f\d]{64}$/u);
      expect(operation.requestIdentity).to.be.a('string').and.not.equal('');
      expect(operation.runId).to.be.a('string').and.not.equal('');
    }
  });

  for (const [name, items, failCall, expectedPosts] of [
    ['parent', [item('primary')], 1, 0],
    ['child', [item('primary'), item('french', 'fr')], 3, 1],
  ] as const) {
    it(`makes no ${name} mutation when its pending journal write fails`, async () => {
      const source = await writeExport(root, items);
      const request = requestRouter();
      let writes = 0;

      await expectRejected(
        executeWorkspaceImport({
          connection: { request },
          destinationOrgId: '00D-org-id',
          destinationWorkspace: workspace(),
          reportDirectory: path.join(root, `${name}-pre-failure`),
          reportPersistence: {
            rewrite: async (file, report) => {
              writes += 1;
              if (writes === failCall) throw new Error('journal unavailable');
              await writeFile(file, `${JSON.stringify(report, null, 2)}\n`);
            },
          },
          sourceDirectory: source,
          workspaceId: 'destination-space',
        }),
      );
      expect(request.getCalls().filter(({ args }) => args[0].method === 'POST')).to.have.length(
        expectedPosts,
      );
    });
  }

  for (const [name, items, failCall, expectedKind, expectedPosts] of [
    ['parent', [item('primary')], 2, 'create-parent', 1],
    ['child', [item('primary'), item('french', 'fr')], 4, 'create-child', 2],
  ] as const) {
    it(`surfaces ownership uncertainty after successful ${name} mutation result persistence fails`, async () => {
      const source = await writeExport(root, items);
      const request = requestRouter();
      const reportDirectory = path.join(root, `${name}-post-failure`);
      let writes = 0;

      try {
        await executeWorkspaceImport({
          connection: { request },
          destinationOrgId: '00D-org-id',
          destinationWorkspace: workspace(),
          reportDirectory,
          reportPersistence: {
            rewrite: async (file, report) => {
              writes += 1;
              if (writes === failCall) throw new Error('result write unavailable');
              await writeFile(file, `${JSON.stringify(report, null, 2)}\n`);
            },
          },
          sourceDirectory: source,
          workspaceId: 'destination-space',
        });
        expect.fail('expected ownership uncertainty');
      } catch (error) {
        expect(error).to.be.instanceOf(WorkspaceImportOwnershipUncertainError);
        expect((error as WorkspaceImportOwnershipUncertainError).state).to.equal(
          'ownership-uncertain',
        );
        expect((error as WorkspaceImportOwnershipUncertainError).operation).to.include({
          contentKey: 'key',
          operationKind: expectedKind,
          state: 'pending',
        });
      }
      expect(request.getCalls().filter(({ args }) => args[0].method === 'POST')).to.have.length(
        expectedPosts,
      );
      const durable = JSON.parse(
        await readFile(path.join(reportDirectory, 'workspace-import-run.json'), 'utf8'),
      );
      expect(durable.state).to.equal('ownership-uncertain');
      expect(durable.operations.at(-1)).to.include({
        operationKind: expectedKind,
        state: 'pending',
      });
    });
  }
});
