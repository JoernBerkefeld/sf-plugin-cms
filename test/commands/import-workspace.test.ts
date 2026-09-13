import { TestContext } from '@salesforce/core/testSetup';
import { expect } from 'chai';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
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
  await writeFile(
    path.join(source, 'items', 'source-variant.json'),
    `${JSON.stringify(exported)}\n`,
  );
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
      'workspace-id',
      'source-dir',
      'apply',
      'allow-partial',
      'report-dir',
    ]);
    expect(ImportWorkspace.flags['target-org'].required).to.equal(true);
    expect(ImportWorkspace.flags['workspace-id'].required).to.equal(true);
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

    try {
      await command.run();
      expect.fail('expected report directory validation failure');
    } catch (error) {
      expect((error as Error).message).to.include('--report-dir');
    }
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

      expect(result.dryRun).to.equal(true);
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

    expect(result.dryRun).to.equal(false);
    expect(result.report).to.include({ destinationOrgId: '00D-org', state: 'completed' });
    expect(request.getCalls().filter(({ args }) => args[0].method === 'POST')).to.have.length(1);
  });
});
