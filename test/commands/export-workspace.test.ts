import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { TestContext } from '@salesforce/core/testSetup';
import { expect } from 'chai';
import ExportWorkspace from '../../src/commands/cms/export/workspace.js';

function fakeRequest<T>(value: T): Promise<T> & { stream(): { destroy(): void } } {
  return Object.assign(Promise.resolve(value), { stream: () => ({ destroy: () => {} }) });
}

describe('CMS export workspace command', () => {
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

  it('defines only the required explicit export flags', () => {
    expect(Object.keys(ExportWorkspace.flags)).to.have.members([
      'target-org',
      'api-version',
      'workspace-id',
      'workspace-name',
      'output-dir',
    ]);
    expect(ExportWorkspace.flags['target-org'].required).to.equal(true);
    expect(ExportWorkspace.flags['workspace-id'].required).not.to.equal(true);
    expect(ExportWorkspace.flags['workspace-name'].required).not.to.equal(true);
    expect(ExportWorkspace.flags['output-dir'].required).not.to.equal(true);
    expect(ExportWorkspace.summary).to.match(/read-only.*best-effort/iu);
    expect(ExportWorkspace.description).to.match(
      /experimental.*not a complete or guaranteed backup/iu,
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
      getConnection: $$.SANDBOX.stub().resolves({ request }),
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
      getConnection: $$.SANDBOX.stub().resolves({ request }),
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
        return fakeRequest({
          currentPage: 0,
          pageSize: 100,
          spaces: [{ id: 'space', name: 'Main/Site' }],
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
      getConnection: $$.SANDBOX.stub().resolves({ request }),
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

    expect(result.destination).to.equal(path.join('cms', 'Main_Site'));
    await access(path.join(root, result.destination, 'manifest.json'));
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
        getConnection: $$.SANDBOX.stub().resolves({ request }),
        jsonEnabled: $$.SANDBOX.stub().returns(jsonEnabled),
        warn,
        log,
      });

      const result = await command.run();

      expect(result.destination).to.equal(destination);
      expect(result.manifest.exportedCount).to.equal(1);
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
});
