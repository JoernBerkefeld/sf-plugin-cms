import { TestContext } from '@salesforce/core/testSetup';
import { expect } from 'chai';
import ListWorkspace from '../../src/commands/cms/list/workspace.js';
import ListChannel from '../../src/commands/cms/list/channel.js';

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
    const table = $$.SANDBOX.stub();
    Object.assign(command, {
      parse: $$.SANDBOX.stub().resolves({
        flags: {
          'target-org': { getUsername: () => 'my-org' },
          'api-version': '67.0',
          'name-fragment': 'Main',
          page: 1,
          'page-size': 20,
        },
      }),
      getConnection: $$.SANDBOX.stub().resolves(fakeConnection(request)),
      table,
    });

    const result = await command.run();

    expect(result).to.deep.equal({ items: [{ id: 'space', name: 'Main' }] });
    expect(table.firstCall.args[0]).to.deep.equal({
      title: 'CMS workspaces',
      data: [{ id: 'space', name: 'Main', type: 'Unknown', enhanced: 'Unknown' }],
    });
    expect(request.calledOnce).to.equal(true);
    expect(request.firstCall.args[0]).to.deep.equal({
      method: 'GET',
      url: '/connect/cms/spaces?nameFragment=Main&page=0&pageSize=20',
    });
  });

  it('projects actual workspace discriminators and strict booleans without changing JSON records', async () => {
    const items = [
      {
        id: '0Zufj000006rx4wCAA',
        name: 'Content Workspace for Marketing Cloud',
        type: 'Content',
        spaceType: { apiName: 'marketing', label: 'Misleading' },
        isEnhancedSpace: true,
      },
      {
        name: 'Marketing',
        type: 'Marketing',
        spaceType: { apiName: 'content' },
        isEnhancedSpace: false,
      },
      { name: 'Content', spaceType: { apiName: 'enablement' } },
      { spaceType: { apiName: 'Future_Type' }, isEnhancedSpace: null },
      { type: 'Marketing', isEnhancedSpace: 'false' },
      ...[
        null,
        [],
        'marketing',
        true,
        7,
        {},
        { apiName: '' },
        { apiName: '  ' },
        { apiName: null },
        { apiName: 3 },
      ].map((spaceType) => ({ spaceType, isEnhancedSpace: 1 })),
    ];
    const before = structuredClone(items);
    const request = $$.SANDBOX.stub().returns(
      Promise.resolve({
        spaces: [null, [], 'bad', ...items],
        currentPage: 0,
        pageSize: 25,
        total: items.length,
      }),
    );
    const command = Object.create(ListWorkspace.prototype) as ListWorkspace;
    const table = $$.SANDBOX.stub();
    Object.assign(command, {
      parse: $$.SANDBOX.stub().resolves({
        flags: { 'target-org': { getUsername: () => 'my-org' }, page: 1 },
      }),
      getConnection: $$.SANDBOX.stub().resolves(fakeConnection(request)),
      table,
    });

    expect(await command.run()).to.deep.equal({
      items: before,
      page: 0,
      pageSize: 25,
      total: items.length,
    });
    expect(items).to.deep.equal(before);
    expect(table.calledOnce).to.equal(true);
    expect(table.firstCall.args[0]).to.deep.equal({
      title: 'CMS workspaces',
      data: items.map((item, index) => ({
        id: index === 0 ? '0Zufj000006rx4wCAA' : '',
        name: ['Content Workspace for Marketing Cloud', 'Marketing', 'Content'][index] ?? '',
        type: ['Marketing', 'Content', 'Enablement', 'Future_Type'][index] ?? 'Unknown',
        enhanced: ['Yes', 'No'][index] ?? 'Unknown',
      })),
    });
    expect(request.calledOnce).to.equal(true);
    expect(request.firstCall.args[0]).to.deep.equal({
      method: 'GET',
      url: '/connect/cms/spaces?page=0',
    });
  });

  for (const Command of [ListWorkspace, ListChannel]) {
    for (const pagination of [{}, { page: 2 }, { 'page-size': 7 }, { page: 3, 'page-size': 9 }]) {
      it(`${Command.name} preserves flag presence and selects the correct API pages: ${JSON.stringify(pagination)}`, async () => {
        const aggregate = Object.keys(pagination).length === 0;
        const items = [
          {
            id: 'first',
            name: 'First',
            spaceType: { apiName: 'marketing' },
            isEnhancedSpace: true,
          },
          { id: 'second', name: 'Second', type: 'Email', extra: { retained: true } },
        ];
        const request = $$.SANDBOX.stub();
        request.onFirstCall().resolves({
          items: aggregate ? items.slice(0, 1) : items,
          currentPage: 8,
          pageSize: 11,
          total: 99,
        });
        request.onSecondCall().resolves({ items: items.slice(1), nextPageUrl: null });
        const command = Object.create(Command.prototype) as ListWorkspace | ListChannel;
        const table = $$.SANDBOX.stub();
        Object.assign(command, {
          parse: $$.SANDBOX.stub().resolves({
            flags: {
              'target-org': { getUsername: () => 'my-org' },
              'name-fragment': 'Main',
              'workspace-id': 'space',
              ...pagination,
            },
          }),
          getConnection: $$.SANDBOX.stub().resolves(fakeConnection(request)),
          table,
        });
        expect(await command.run()).to.deep.equal(
          aggregate ? { items, total: 2 } : { items, page: 8, pageSize: 11, total: 99 },
        );
        const base =
          Command === ListWorkspace
            ? '/connect/cms/spaces?nameFragment=Main&'
            : '/connect/cms/spaces/space/channels?';
        expect(request.getCalls().map((call) => call.args[0])).to.deep.equal(
          (aggregate ? [0, 1] : [('page' in pagination ? pagination.page! : 1) - 1]).map(
            (page) => ({
              method: 'GET',
              url: `${base}page=${page}${'page-size' in pagination ? `&pageSize=${pagination['page-size']}` : ''}`,
            }),
          ),
        );
        expect(table.calledOnce).to.equal(true);
        expect(table.firstCall.args[0].data).to.have.length(2);
        expect(table.firstCall.args[0].data[0]).to.include(
          Command === ListWorkspace
            ? { type: 'Marketing', enhanced: 'Yes' }
            : { id: 'first', name: 'First' },
        );
      });
    }
  }

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
        flags: { 'target-org': { getUsername: () => 'my-org' }, 'api-version': '67.0' },
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
