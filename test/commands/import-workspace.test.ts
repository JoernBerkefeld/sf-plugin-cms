import { TestContext } from '@salesforce/core/testSetup';
import { expect } from 'chai';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import ImportWorkspace from '../../src/commands/cms/import/workspace.js';

type FakeRequest<T> = Promise<T> & { stream(): { destroy(): void } };

function fakeRequest<T>(value: T): FakeRequest<T> {
  return Object.assign(Promise.resolve(value), { stream: () => ({ destroy: () => {} }) });
}

function missingRequest(): FakeRequest<never> {
  return Object.assign(Promise.reject(Object.assign(new Error('not found'), { statusCode: 404 })), {
    stream: () => ({ destroy: () => {} }),
  });
}

async function writeSource(root: string): Promise<string> {
  const source = path.join(root, 'source');
  await mkdir(path.join(source, 'items'), { recursive: true });
  const exported = {
    apiName: 'command_api',
    contentBody: { body: 'command body' },
    contentKey: 'command-key',
    contentSpace: { id: 'source-space' },
    contentType: 'sfdc_cms__news',
    id: 'source-variant',
    language: 'en',
    title: 'Command title',
    urlName: 'command-title',
  };
  const itemBytes = `${JSON.stringify(exported)}\n`;
  await writeFile(path.join(source, 'items', 'source-variant.json'), itemBytes);
  const referenceId = `ref:${createHash('sha256')
    .update(
      JSON.stringify({
        kind: 'cms.content',
        sourceId: 'command-key',
        workspaceId: 'source-space',
      }),
    )
    .digest('hex')}`;
  await writeFile(
    path.join(source, 'manifest.json'),
    `${JSON.stringify({
      entries: [{ file: 'items/source-variant.json', variantId: 'source-variant' }],
      expectedCount: 1,
      exportedCount: 1,
      failedVariantIds: [],
      foundCount: 1,
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
      externalReferences: [
        {
          referenceId,
          owner: 'cms',
          kind: 'cms.content',
          source: { workspaceId: 'source-space', sourceId: 'command-key' },
          portableKey: { scheme: 'cms-opaque-v1', value: 'command-key' },
          required: true,
          resolution: 'included',
        },
      ],
      items: [
        {
          path: 'items/source-variant.json',
          sha256: createHash('sha256').update(itemBytes).digest('hex'),
          kind: 'cms.content',
          referenceId,
        },
      ],
    })}\n`,
  );
  return source;
}

describe('CMS import workspace command', () => {
  const $$ = new TestContext();
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    $$.restore();
    await Promise.all(
      temporaryDirectories
        .splice(0)
        .map((directory) => rm(directory, { force: true, recursive: true })),
    );
  });

  it('defines the requested create-only safety flags', () => {
    expect(Object.keys(ImportWorkspace.flags)).to.have.members([
      'target-org',
      'api-version',
      'contract-version',
      'workspace-id',
      'workspace-name',
      'source-dir',
      'apply',
      'allow-partial',
      'report-dir',
    ]);
    expect(ImportWorkspace.flags['target-org'].required).to.equal(true);
    expect(ImportWorkspace.flags['workspace-id'].required).not.to.equal(true);
    expect(ImportWorkspace.flags['workspace-name'].required).not.to.equal(true);
    expect(ImportWorkspace.flags['source-dir'].required).to.equal(true);
    expect(ImportWorkspace.flags.apply.default).to.equal(false);
    expect(ImportWorkspace.flags['report-dir'].dependsOn).to.deep.equal(['apply']);
    expect(ImportWorkspace.summary).to.match(/create-only/iu);
  });

  it('requires a report directory for apply before local or remote work', async () => {
    const command = Object.create(ImportWorkspace.prototype) as ImportWorkspace;
    const getOrgContext = $$.SANDBOX.stub();
    Object.assign(command, {
      parse: $$.SANDBOX.stub().resolves({
        flags: {
          'allow-partial': false,
          apply: true,
          'api-version': '67.0',
          'source-dir': 'missing-source',
          'target-org': 'mcnext-sdo',
          'workspace-id': 'space',
        },
      }),
      getOrgContext,
    });

    const result = await command.run();
    expect(result).to.include({ status: 'blocked', result: null });
    expect(result.diagnostics.errors[0]).to.include({ code: 'REPORT_DIRECTORY_REQUIRED' });
    expect(getOrgContext.notCalled).to.equal(true);
  });

  it('blocks unsupported contract major before source or org access', async () => {
    const command = Object.create(ImportWorkspace.prototype) as ImportWorkspace;
    const getOrgContext = $$.SANDBOX.stub();
    Object.assign(command, {
      parse: $$.SANDBOX.stub().resolves({
        flags: {
          'allow-partial': false,
          apply: false,
          'api-version': '67.0',
          'contract-version': 2,
          'source-dir': 'missing-source',
          'target-org': 'mcnext-sdo',
          'workspace-id': 'space',
        },
      }),
      getOrgContext,
      jsonEnabled: $$.SANDBOX.stub().returns(true),
    });

    const result = await command.run();

    expect(result).to.include({ status: 'blocked', result: null });
    expect(result.diagnostics.errors[0]).to.include({ code: 'UNSUPPORTED_CONTRACT_VERSION' });
    expect(getOrgContext.notCalled).to.equal(true);
  });

  it('validates the source locally before requesting org context', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'sf-plugin-cms-command-import-'));
    temporaryDirectories.push(root);
    const source = await writeSource(root);
    await writeFile(path.join(source, 'items', 'source-variant.json'), '[]\n');
    const command = Object.create(ImportWorkspace.prototype) as ImportWorkspace;
    const getOrgContext = $$.SANDBOX.stub();
    Object.assign(command, {
      parse: $$.SANDBOX.stub().resolves({
        flags: {
          'allow-partial': false,
          apply: false,
          'api-version': '67.0',
          'source-dir': source,
          'target-org': 'mcnext-sdo',
          'workspace-id': 'space',
        },
      }),
      getOrgContext,
    });

    try {
      await command.run();
      expect.fail('expected local source validation failure');
    } catch (error) {
      expect(error).to.be.instanceOf(Error);
    }
    expect(getOrgContext.notCalled).to.equal(true);
  });

  it('blocks contradictory complete packages before org access even with allow-partial', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'sf-plugin-cms-command-import-'));
    temporaryDirectories.push(root);
    const source = await writeSource(root);
    const manifestFile = path.join(source, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestFile, 'utf8')) as Record<string, unknown>;
    manifest.failedVariantIds = ['source-variant'];
    await writeFile(manifestFile, `${JSON.stringify(manifest)}\n`);
    const command = Object.create(ImportWorkspace.prototype) as ImportWorkspace;
    const getOrgContext = $$.SANDBOX.stub();
    Object.assign(command, {
      parse: $$.SANDBOX.stub().resolves({
        flags: {
          'allow-partial': true,
          apply: false,
          'api-version': '67.0',
          'source-dir': source,
          'target-org': 'mcnext-sdo',
          'workspace-id': 'space',
        },
      }),
      getOrgContext,
    });

    const result = await command.run();

    expect(result).to.include({ status: 'blocked', result: null });
    expect(result.diagnostics.errors[0]).to.include({ code: 'PACKAGE_VALIDATION_FAILED' });
    expect(result.diagnostics.errors[0].message).to.include(
      'contradicts authoritative incompleteness evidence',
    );
    expect(getOrgContext.notCalled).to.equal(true);
  });

  it('validates a sound source before rejecting missing or combined destination selectors', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'sf-plugin-cms-command-import-'));
    temporaryDirectories.push(root);
    const source = await writeSource(root);
    for (const selector of [{}, { 'workspace-id': 'id', 'workspace-name': 'name' }]) {
      const command = Object.create(ImportWorkspace.prototype) as ImportWorkspace;
      const getOrgContext = $$.SANDBOX.stub();
      Object.assign(command, {
        parse: $$.SANDBOX.stub().resolves({
          flags: {
            'allow-partial': false,
            apply: false,
            'api-version': '67.0',
            'source-dir': source,
            'target-org': 'mcnext-sdo',
            ...selector,
          },
        }),
        getOrgContext,
      });
      const result = await command.run();
      expect(result).to.include({ status: 'blocked', result: null });
      expect(result.diagnostics.errors[0]).to.include({ code: 'PACKAGE_VALIDATION_FAILED' });
      expect(result.diagnostics.errors[0].message).to.include('exactly one');
      expect(getOrgContext.notCalled).to.equal(true);
    }
  });

  it('imports by workspace name using the canonical resolved workspace and ID', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'sf-plugin-cms-command-import-'));
    temporaryDirectories.push(root);
    const source = await writeSource(root);
    const request = $$.SANDBOX.stub().callsFake(({ url }: { url: string }) => {
      if (url.startsWith('/connect/cms/spaces?')) {
        const page = Number(new URL(url, 'https://example.test').searchParams.get('page'));
        return fakeRequest({
          currentPage: page,
          pageSize: 250,
          spaces: page === 0 ? [{ id: 'canonical-space', name: 'Destination' }] : [],
          total: 1,
        });
      }
      if (url === '/connect/cms/spaces/canonical-space') {
        return fakeRequest({
          defaultLanguage: 'en',
          id: 'canonical-space',
          name: 'Destination',
          rootFolderId: 'canonical-root',
        });
      }
      return missingRequest();
    });
    const command = Object.create(ImportWorkspace.prototype) as ImportWorkspace;
    Object.assign(command, {
      parse: $$.SANDBOX.stub().resolves({
        flags: {
          'allow-partial': false,
          apply: false,
          'api-version': '67.0',
          'source-dir': source,
          'target-org': 'mcnext-sdo',
          'workspace-name': 'Destination',
        },
      }),
      getOrgContext: $$.SANDBOX.stub().resolves({ connection: { request }, orgId: '00D-org' }),
      jsonEnabled: $$.SANDBOX.stub().returns(true),
    });

    const result = await command.run();

    expect(result.result?.target.workspaceId).to.equal('canonical-space');
    expect(result.status).to.equal('success');
    expect(request.thirdCall.args[0].url).to.equal('/connect/cms/spaces/canonical-space');
  });

  for (const jsonEnabled of [false, true]) {
    it(`defaults to dry-run and ${jsonEnabled ? 'suppresses' : 'shows'} the human plan in JSON=${jsonEnabled} mode`, async () => {
      const root = await mkdtemp(path.join(tmpdir(), 'sf-plugin-cms-command-import-'));
      temporaryDirectories.push(root);
      const source = await writeSource(root);
      const request = $$.SANDBOX.stub().callsFake(({ url }: { url: string }) => {
        if (url === '/connect/cms/spaces/space') {
          return fakeRequest({ defaultLanguage: 'en', id: 'space', rootFolderId: 'root' });
        }
        return missingRequest();
      });
      const log = $$.SANDBOX.stub();
      const command = Object.create(ImportWorkspace.prototype) as ImportWorkspace;
      Object.assign(command, {
        parse: $$.SANDBOX.stub().resolves({
          flags: {
            'allow-partial': false,
            apply: false,
            'api-version': '67.0',
            'source-dir': source,
            'target-org': 'mcnext-sdo',
            'workspace-id': 'space',
          },
        }),
        getOrgContext: $$.SANDBOX.stub().resolves({ connection: { request }, orgId: '00D-org' }),
        jsonEnabled: $$.SANDBOX.stub().returns(jsonEnabled),
        log,
      });

      const result = await command.run();

      expect(result).to.include({ status: 'success' });
      expect(result.result?.mappings).to.deep.equal([]);
      expect(request.callCount).to.equal(2);
      expect(request.getCalls().every(({ args }) => args[0].method === 'GET')).to.equal(true);
      expect(jsonEnabled ? log.notCalled : log.callCount > 0).to.equal(true);
      if (!jsonEnabled) expect(log.lastCall.args[0]).to.include('No content was created');
    });
  }

  it('applies only when explicitly requested and returns the durable report', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'sf-plugin-cms-command-import-'));
    temporaryDirectories.push(root);
    const source = await writeSource(root);
    const reportDirectory = path.join(root, 'report');
    const request = $$.SANDBOX.stub().callsFake(
      ({ method, url }: { method: string; url: string }) => {
        if (url === '/connect/cms/spaces/space') {
          return fakeRequest({ defaultLanguage: 'en', id: 'space', rootFolderId: 'root' });
        }
        if (method === 'GET') return missingRequest();
        return fakeRequest({
          contentKey: 'command-key',
          id: 'content-id',
          primaryVariantId: 'variant-id',
        });
      },
    );
    const command = Object.create(ImportWorkspace.prototype) as ImportWorkspace;
    Object.assign(command, {
      parse: $$.SANDBOX.stub().resolves({
        flags: {
          'allow-partial': false,
          apply: true,
          'api-version': '67.0',
          'report-dir': reportDirectory,
          'source-dir': source,
          'target-org': 'mcnext-sdo',
          'workspace-id': 'space',
        },
      }),
      getOrgContext: $$.SANDBOX.stub().resolves({ connection: { request }, orgId: '00D-org' }),
      jsonEnabled: $$.SANDBOX.stub().returns(true),
      log: $$.SANDBOX.stub(),
    });

    const result = await command.run();

    expect(result).to.include({ status: 'success' });
    expect(result.result?.mappings).to.have.length(1);
    expect(result.result?.mappings[0]).to.include({
      operation: 'created',
      status: 'resolved',
      cmsReferencesRewritten: true,
    });
    expect(result.result?.mappings[0].target).to.deep.equal({
      targetId: 'content-id',
      targetReference: 'command-key',
    });
    expect(request.getCalls().filter(({ args }) => args[0].method === 'POST')).to.have.length(1);
  });
});
