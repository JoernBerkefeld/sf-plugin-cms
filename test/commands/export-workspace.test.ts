import { access, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { TestContext } from '@salesforce/core/testSetup';
import { expect } from 'chai';
import ExportWorkspace from '../../src/commands/cms/export/workspace.js';
import type { ExportWorkspaceResult } from '../../src/services/export-workspace.js';

function fakeRequest<T>(value: T): Promise<T> & { stream(): { destroy(): void } } {
  return Object.assign(Promise.resolve(value), { stream: () => ({ destroy: () => {} }) });
}

describe('CMS export workspace command', () => {
  const $$ = new TestContext();
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    process.exitCode = undefined;
    $$.restore();
    await Promise.all(
      temporaryDirectories
        .splice(0)
        .map((directory) => rm(directory, { force: true, recursive: true })),
    );
  });

  it('defines only the required explicit export flags', () => {
    expect(Object.keys(ExportWorkspace.flags)).to.have.members([
      'target-org',
      'api-version',
      'contract-version',
      'all',
      'workspace-id',
      'workspace-name',
      'workspace-type',
      'output-dir',
      'editable-dir',
    ]);
    expect(ExportWorkspace.flags['target-org'].required).to.equal(true);
    expect(ExportWorkspace.flags['workspace-id'].required).not.to.equal(true);
    expect(ExportWorkspace.flags['workspace-name'].required).not.to.equal(true);
    expect(ExportWorkspace.flags['output-dir'].required).not.to.equal(true);
    expect(ExportWorkspace.flags['contract-version'].default).to.equal(1);
    expect(ExportWorkspace.flags.all.required).not.to.equal(true);
    expect(ExportWorkspace.flags['workspace-type'].dependsOn).to.deep.equal(['all']);
    expect(ExportWorkspace.summary).to.match(/read-only.*best-effort/iu);
    expect(ExportWorkspace.description).to.match(
      /experimental.*not a complete or guaranteed backup/iu,
    );
  });

  it('rejects invalid editable flags and both overlap directions before org access or writes', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'cms-editable-command-'));
    temporaryDirectories.push(root);
    const output = path.join(root, 'source');
    for (const flags of [
      { 'editable-dir': path.join(root, 'editable') },
      { all: true, 'output-dir': output, 'editable-dir': path.join(root, 'editable') },
      { 'output-dir': output, 'editable-dir': output },
      { 'output-dir': output, 'editable-dir': path.join(output, 'child') },
      { 'output-dir': path.join(output, 'child'), 'editable-dir': output },
    ]) {
      const command = Object.create(ExportWorkspace.prototype) as ExportWorkspace;
      const getOrgContext = $$.SANDBOX.stub();
      Object.assign(command, {
        parse: $$.SANDBOX.stub().resolves({ flags: { 'workspace-id': 'space', ...flags } }),
        getOrgContext,
      });
      let failure: unknown;
      try {
        await command.run();
      } catch (error) {
        failure = error;
      }
      expect(failure).to.be.instanceOf(Error);
      expect((failure as Error).message).to.match(/explicit|incompatible|overlap/u);
      expect(getOrgContext.notCalled).to.equal(true);
      expect(await readdir(root)).to.deep.equal([]);
    }
    expect(ExportWorkspace.flags['editable-dir'].dependsOn).to.deep.equal(['output-dir']);
    expect(ExportWorkspace.flags['editable-dir'].exclusive).to.deep.equal(['all']);
  });

  it('publishes the editable subset while retaining partial exit and machine result shape', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'cms-editable-command-'));
    temporaryDirectories.push(root);
    const editable = path.join(root, 'editable');
    const command = Object.create(ExportWorkspace.prototype) as ExportWorkspace;
    const request = $$.SANDBOX.stub().callsFake(({ url }: { url: string }) => {
      if (url === '/connect/cms/spaces/space') return fakeRequest({ id: 'space' });
      if (url.startsWith('/connect/cms/items/search'))
        return fakeRequest({
          items: [
            {
              id: 'variant',
              managedContentSpaceId: 'space',
              type: 'ManagedContentVariantSearchResultRepresentation',
            },
          ],
          total: 2,
        });
      return fakeRequest({
        id: 'variant',
        contentSpace: { id: 'space' },
        contentType: 'sfdc_cms__email',
        contentBody: { rawHtml: '<p>literal</p>' },
      });
    });
    Object.assign(command, {
      parse: $$.SANDBOX.stub().resolves({
        flags: {
          'workspace-id': 'space',
          'output-dir': path.join(root, 'source'),
          'editable-dir': editable,
        },
      }),
      getOrgContext: $$.SANDBOX.stub().resolves({ connection: { request }, orgId: 'source' }),
      jsonEnabled: $$.SANDBOX.stub().returns(true),
      warn: $$.SANDBOX.stub(),
    });
    const result = (await command.run()) as ExportWorkspaceResult;
    expect(Object.keys(result)).to.have.members(['destination', 'manifest', 'manifestSha256']);
    expect(result.manifest.completeness).to.equal('partial');
    expect(process.exitCode).to.equal(2);
    expect(await readFile(path.join(editable, 'items/variant.html'), 'utf8')).to.equal(
      '<p>literal</p>',
    );
  });

  it('rejects missing or combined workspace selectors before org access', async () => {
    for (const flags of [
      { 'output-dir': 'export-dir' },
      { 'output-dir': 'export-dir', 'workspace-id': 'id', 'workspace-name': 'name' },
    ]) {
      const command = Object.create(ExportWorkspace.prototype) as ExportWorkspace;
      const getConnection = $$.SANDBOX.stub();
      Object.assign(command, {
        parse: $$.SANDBOX.stub().resolves({
          flags: { 'api-version': '67.0', 'target-org': 'mcnext-sdo', ...flags },
        }),
        getConnection,
      });
      try {
        await command.run();
        expect.fail('expected selector failure');
      } catch (error) {
        expect((error as Error).message).to.include('exactly one');
      }
      expect(getConnection.notCalled).to.equal(true);
    }
  });

  it('rejects a workspace ID mismatch before invoking export search', async () => {
    const command = Object.create(ExportWorkspace.prototype) as ExportWorkspace;
    const request = $$.SANDBOX.stub().returns(fakeRequest({ id: 'different-space', name: 'Main' }));
    Object.assign(command, {
      parse: $$.SANDBOX.stub().resolves({
        flags: {
          'target-org': 'mcnext-sdo',
          'api-version': '67.0',
          'workspace-id': 'requested-space',
          'output-dir': 'export-dir',
        },
      }),
      getOrgContext: $$.SANDBOX.stub().resolves({ connection: { request }, orgId: '00DSource' }),
    });

    try {
      await command.run();
      expect.fail('expected workspace validation failure');
    } catch (error) {
      expect((error as Error).message).to.include('different-space');
    }
    expect(request.calledOnce).to.equal(true);
    expect(request.firstCall.args[0].url).to.equal('/connect/cms/spaces/requested-space');
  });

  it('rejects an omitted output when the canonical workspace has no usable name before writing', async () => {
    const command = Object.create(ExportWorkspace.prototype) as ExportWorkspace;
    const root = await mkdtemp(path.join(tmpdir(), 'sf-plugin-cms-command-'));
    temporaryDirectories.push(root);
    const request = $$.SANDBOX.stub().returns(fakeRequest({ id: 'space' }));
    Object.assign(command, {
      parse: $$.SANDBOX.stub().resolves({
        flags: {
          'target-org': 'mcnext-sdo',
          'api-version': '67.0',
          'workspace-id': 'space',
        },
      }),
      getOrgContext: $$.SANDBOX.stub().resolves({ connection: { request }, orgId: '00DSource' }),
    });

    const previousCwd = process.cwd();
    process.chdir(root);
    try {
      await command.run();
      expect.fail('expected missing workspace name failure');
    } catch (error) {
      expect((error as Error).message).to.include('no usable name');
    } finally {
      process.chdir(previousCwd);
    }

    expect(request.calledOnce).to.equal(true);
    try {
      await access(path.join(root, 'cms'));
      expect.fail('expected no export directory');
    } catch (error) {
      expect((error as NodeJS.ErrnoException).code).to.equal('ENOENT');
    }
  });

  it('exports by workspace name to the safe default destination', async () => {
    const command = Object.create(ExportWorkspace.prototype) as ExportWorkspace;
    const root = await mkdtemp(path.join(tmpdir(), 'sf-plugin-cms-command-'));
    temporaryDirectories.push(root);
    const request = $$.SANDBOX.stub().callsFake(({ url }: { url: string }) => {
      if (url.startsWith('/connect/cms/spaces?')) {
        const page = Number(new URL(url, 'https://example.test').searchParams.get('page'));
        return fakeRequest({
          currentPage: page,
          pageSize: 250,
          spaces: page === 0 ? [{ id: 'space', name: 'Main/Site' }] : [],
          total: 1,
        });
      }
      if (url === '/connect/cms/spaces/space')
        return fakeRequest({ id: 'space', name: 'Main/Site' });
      return fakeRequest({ items: [], total: 0 });
    });
    Object.assign(command, {
      parse: $$.SANDBOX.stub().resolves({
        flags: {
          'target-org': 'mcnext-sdo',
          'api-version': '67.0',
          'workspace-name': 'Main/Site',
        },
      }),
      getOrgContext: $$.SANDBOX.stub().resolves({ connection: { request }, orgId: '00DSource' }),
      jsonEnabled: $$.SANDBOX.stub().returns(true),
      warn: $$.SANDBOX.stub(),
    });

    const previousCwd = process.cwd();
    process.chdir(root);
    let result;
    try {
      result = await command.run();
    } finally {
      process.chdir(previousCwd);
    }

    const singleResult = result as ExportWorkspaceResult;
    expect(singleResult.destination).to.equal(path.join('cms', 'Main_Site'));
    await access(path.join(root, singleResult.destination, 'manifest.json'));
  });

  for (const jsonEnabled of [false, true]) {
    it(`exports, warns, and ${jsonEnabled ? 'suppresses' : 'renders'} human output in JSON=${jsonEnabled} mode`, async () => {
      const command = Object.create(ExportWorkspace.prototype) as ExportWorkspace;
      const root = await mkdtemp(path.join(tmpdir(), 'sf-plugin-cms-command-'));
      temporaryDirectories.push(root);
      const destination = path.join(root, 'export');
      const request = $$.SANDBOX.stub().callsFake(({ url }: { url: string }) => {
        if (url === '/connect/cms/spaces/space') return fakeRequest({ id: 'space' });
        if (url.startsWith('/connect/cms/items/search')) {
          return fakeRequest({
            items: [
              {
                id: 'variant',
                managedContentSpaceId: 'space',
                type: 'ManagedContentVariantSearchResultRepresentation',
              },
            ],
            total: 1,
          });
        }
        return fakeRequest({ contentSpace: { id: 'space' }, id: 'variant' });
      });
      const warn = $$.SANDBOX.stub();
      const log = $$.SANDBOX.stub();
      Object.assign(command, {
        parse: $$.SANDBOX.stub().resolves({
          flags: {
            'target-org': 'mcnext-sdo',
            'api-version': '67.0',
            'workspace-id': 'space',
            'output-dir': destination,
          },
        }),
        getOrgContext: $$.SANDBOX.stub().resolves({ connection: { request }, orgId: '00DSource' }),
        jsonEnabled: $$.SANDBOX.stub().returns(jsonEnabled),
        warn,
        log,
      });

      const result = await command.run();

      const singleResult = result as ExportWorkspaceResult;
      expect(singleResult.destination).to.equal(destination);
      expect(singleResult.manifest.exportedCount).to.equal(1);
      expect(singleResult.manifest.provenance.sourceOrgId).to.equal('00DSource');
      expect(singleResult.manifest.completeness).to.equal('complete');
      expect(process.exitCode).to.equal(undefined);
      expect(request.callCount).to.equal(3);
      expect(warn.calledOnce).to.equal(true);
      expect(warn.firstCall.args[0]).to.match(/^\[UNSUPPORTED_WILDCARD\]/u);
      if (jsonEnabled) {
        expect(log.notCalled).to.equal(true);
      } else {
        expect(log.callCount).to.equal(2);
        expect(log.firstCall.args[0]).to.equal(`Destination: ${destination}`);
        expect(log.secondCall.args[0]).to.equal('Exported variants: 1/1 expected');
      }
    });
  }

  for (const jsonEnabled of [false, true]) {
    it(`retains partial diagnostics and provenance with exit 2 in JSON=${jsonEnabled} mode`, async () => {
      const command = Object.create(ExportWorkspace.prototype) as ExportWorkspace;
      const root = await mkdtemp(path.join(tmpdir(), 'sf-plugin-cms-command-'));
      temporaryDirectories.push(root);
      const request = $$.SANDBOX.stub().callsFake(({ url }: { url: string }) => {
        if (url === '/connect/cms/spaces/space') return fakeRequest({ id: 'space' });
        return fakeRequest({ items: [], total: 1 });
      });
      const warn = $$.SANDBOX.stub();
      const log = $$.SANDBOX.stub();
      Object.assign(command, {
        parse: $$.SANDBOX.stub().resolves({
          flags: {
            'target-org': 'source-alias',
            'api-version': '67.0',
            'workspace-id': 'space',
            'output-dir': path.join(root, 'export'),
          },
        }),
        getOrgContext: $$.SANDBOX.stub().resolves({ connection: { request }, orgId: '00DActual' }),
        jsonEnabled: $$.SANDBOX.stub().returns(jsonEnabled),
        warn,
        log,
      });

      const result = (await command.run()) as ExportWorkspaceResult;

      expect(Object.keys(result)).to.have.members(['destination', 'manifest', 'manifestSha256']);
      expect(result.manifest.provenance.sourceOrgId).to.equal('00DActual');
      expect(result.manifest.completeness).to.equal('partial');
      expect(result.manifest.warnings.map(({ code }) => code)).to.include.members([
        'PREMATURE_EMPTY_PAGE',
        'COUNT_MISMATCH',
      ]);
      expect(warn.callCount).to.equal(result.manifest.warnings.length);
      expect(log.callCount).to.equal(jsonEnabled ? 0 : 2);
      expect(process.exitCode).to.equal(2);
      await access(path.join(result.destination, 'manifest.json'));
    });
  }

  for (const all of [false, true]) {
    it(`blocks an unsupported ${all ? 'bulk' : 'single'} contract version before org access`, async () => {
      const command = Object.create(ExportWorkspace.prototype) as ExportWorkspace;
      const getOrgContext = $$.SANDBOX.stub();
      const getConnection = $$.SANDBOX.stub();
      Object.assign(command, {
        parse: $$.SANDBOX.stub().resolves({
          flags: {
            'target-org': 'mcnext-sdo',
            'api-version': '67.0',
            'contract-version': 2,
            all,
            'workspace-id': all ? undefined : '0ZuSource',
          },
        }),
        getConnection,
        getOrgContext,
        jsonEnabled: $$.SANDBOX.stub().returns(true),
      });

      const result = await command.run();

      expect('status' in result && result.status).to.equal('blocked');
      expect('diagnostics' in result && result.diagnostics.errors[0].code).to.equal(
        'UNSUPPORTED_CONTRACT_VERSION',
      );
      expect(getOrgContext.notCalled).to.equal(true);
      expect(getConnection.notCalled).to.equal(true);
      expect(process.exitCode).to.equal(1);
    });
  }

  for (const jsonEnabled of [false, true]) {
    it(`returns mixed bulk results in JSON=${jsonEnabled} mode and sets exitCode`, async () => {
      const command = Object.create(ExportWorkspace.prototype) as ExportWorkspace;
      const root = await mkdtemp(path.join(tmpdir(), 'sf-plugin-cms-command-'));
      temporaryDirectories.push(root);
      const outputDirectory = path.join(root, 'cms');
      const request = $$.SANDBOX.stub().callsFake(({ url }: { url: string }) => {
        if (url.startsWith('/connect/cms/spaces?')) {
          const page = Number(new URL(url, 'https://example.test').searchParams.get('page'));
          return fakeRequest({
            spaces:
              page === 0
                ? [
                    { id: 'b', name: 'Second', spaceType: { apiName: 'marketing' } },
                    { id: 'a', name: 'First', spaceType: { apiName: 'marketing' } },
                  ]
                : [],
          });
        }
        if (url === '/connect/cms/spaces/a')
          return fakeRequest({ id: 'a', name: 'First', spaceType: { apiName: 'marketing' } });
        if (url === '/connect/cms/spaces/b')
          return fakeRequest({ id: 'b', name: 'Second', spaceType: { apiName: 'marketing' } });
        if (url.includes('contentSpaceOrFolderIds=a'))
          return Promise.reject(new Error('first failed'));
        return fakeRequest({ items: [], total: 0 });
      });
      const styledJSON = $$.SANDBOX.stub();
      Object.assign(command, {
        parse: $$.SANDBOX.stub().resolves({
          flags: {
            'target-org': 'mcnext-sdo',
            'api-version': '67.0',
            all: true,
            'output-dir': outputDirectory,
          },
        }),
        getOrgContext: $$.SANDBOX.stub().resolves({ connection: { request }, orgId: '00DSource' }),
        jsonEnabled: $$.SANDBOX.stub().returns(jsonEnabled),
        styledJSON,
      });

      const result = await command.run();

      expect('status' in result && result.status).to.equal('partial');
      expect('result' in result && result.result?.summary.failedCount).to.equal(1);
      expect(process.exitCode).to.equal(2);
      expect(styledJSON.calledOnce).to.equal(!jsonEnabled);
    });
  }
});
