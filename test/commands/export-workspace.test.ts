import { mkdtemp, rm } from 'node:fs/promises';
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
      'output-dir',
    ]);
    expect(ExportWorkspace.flags['target-org'].required).to.equal(true);
    expect(ExportWorkspace.flags['workspace-id'].required).to.equal(true);
    expect(ExportWorkspace.flags['output-dir'].required).to.equal(true);
    expect(ExportWorkspace.summary).to.match(/read-only.*best-effort/iu);
    expect(ExportWorkspace.description).to.match(
      /experimental.*not a complete or guaranteed backup/iu,
    );
  });

  it('rejects a workspace ID mismatch before invoking export search', async () => {
    const command = Object.create(ExportWorkspace.prototype) as ExportWorkspace;
    const request = $$.SANDBOX.stub().returns(fakeRequest({ id: 'different-space' }));
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
