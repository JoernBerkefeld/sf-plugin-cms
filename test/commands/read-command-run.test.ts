import { TestContext } from '@salesforce/core/testSetup';
import { expect } from 'chai';
import ListWorkspace from '../../src/commands/cms/list/workspace.js';

function fakeConnection(request: ReturnType<TestContext['SANDBOX']['stub']>): unknown {
  return { request };
}

describe('CMS read command execution', () => {
  const $$ = new TestContext();

  afterEach(() => {
    $$.restore();
  });

  it('returns list results and renders bounded human output', async () => {
    const command = Object.create(ListWorkspace.prototype) as ListWorkspace;
    const request = $$.SANDBOX.stub().returns(
      Object.assign(Promise.resolve({ spaces: [{ id: 'space', name: 'Main' }] }), {
        stream: () => ({ destroy: $$.SANDBOX.stub() }),
      }),
    );
    const showPage = $$.SANDBOX.stub();
    Object.assign(command, {
      parse: $$.SANDBOX.stub().resolves({
        flags: {
          'target-org': 'my-org',
          'api-version': '67.0',
          'name-fragment': 'Main',
          page: 1,
          'page-size': 20,
        },
      }),
      getConnection: $$.SANDBOX.stub().resolves(fakeConnection(request)),
      showPage,
    });

    const result = await command.run();

    expect(result).to.deep.equal({ items: [{ id: 'space', name: 'Main' }] });
    expect(showPage.calledOnceWithExactly('CMS workspaces', result)).to.equal(true);
    expect(request.firstCall.args[0]).to.deep.equal({
      method: 'GET',
      url: '/connect/cms/spaces?nameFragment=Main&page=1&pageSize=20',
    });
  });

  it('propagates normalized request errors', async () => {
    const command = Object.create(ListWorkspace.prototype) as ListWorkspace;
    const request = $$.SANDBOX.stub().returns(
      Object.assign(
        Promise.reject(Object.assign(new Error('Authorization: Bearer hidden'), { status: 403 })),
        { stream: () => ({ destroy: $$.SANDBOX.stub() }) },
      ),
    );
    Object.assign(command, {
      parse: $$.SANDBOX.stub().resolves({
        flags: { 'target-org': 'my-org', 'api-version': '67.0' },
      }),
      getConnection: $$.SANDBOX.stub().resolves(fakeConnection(request)),
    });

    try {
      await command.run();
      expect.fail('expected command failure');
    } catch (error) {
      expect(error).to.include({ operationKey: 'workspace.list', status: 403 });
      expect((error as Error).message).to.equal('Authorization: [REDACTED]');
    }
  });
});
