import { PassThrough } from 'node:stream';
import { expect } from 'chai';
import sinon from 'sinon';
import { prepareCmsConnection } from '../../src/api-policy.js';
import {
  CmsRequestError,
  getSelectedOperation,
  requestJson,
} from '../../src/transport/json-request.js';

const operation = getSelectedOperation('folder.items.list');
const values = {
  path: { folderId: '9PuFolder' },
  query: { itemType: 'Folders', page: 0, pageSize: 250, includeSharedWithSpaceFolder: false },
};

function fakeConnection() {
  const request = sinon
    .stub()
    .callsFake(() =>
      Object.assign(Promise.resolve({ folderItems: [] }), { stream: () => new PassThrough() }),
    );
  const connection = {
    version: '68.0',
    getApiVersion() {
      return this.version;
    },
    setApiVersion(version: string) {
      this.version = version;
    },
    request,
  };
  return { connection, request };
}

async function rejection(action: Promise<unknown>): Promise<unknown> {
  try {
    await action;
    expect.fail('Expected rejection');
  } catch (error) {
    return error;
  }
}

describe('folder items operation API gate', () => {
  it('rejects explicit 67 and latest fallback 67 before any folder route dispatch', async () => {
    for (const fallback of [false, true]) {
      const { connection, request } = fakeConnection();
      if (fallback) {
        request.onCall(0).resolves([{ version: '68.0' }]);
        request.onCall(1).rejects({ errorCode: 'INVALID_VERSION' });
        await prepareCmsConnection(connection);
      } else await prepareCmsConnection(connection, '67.0');
      request.resetHistory();
      const error = await rejection(requestJson(connection, operation, values));
      expect(error).to.be.instanceOf(CmsRequestError);
      expect((error as Error).message).to.include('requires numeric CMS API 68.0');
      expect(request.callCount).to.equal(0);
      const narrowed = {
        getApiVersion: () => connection.getApiVersion(),
        request: connection.request.bind(connection),
      };
      expect(await rejection(requestJson(narrowed, operation, values))).to.be.instanceOf(
        CmsRequestError,
      );
      expect(request.callCount).to.equal(0);
      // The bound effective selection wins over a changed raw version property.
      connection.version = '69.0';
      expect(await rejection(requestJson(connection, operation, values))).to.be.instanceOf(
        CmsRequestError,
      );
      expect(request.callCount).to.equal(0);
    }
  });

  it('preserves latest routing at 68+ including narrowed Fragment-style wrappers', async () => {
    for (const version of ['68.0', '69.0']) {
      const { connection, request } = fakeConnection();
      request.onCall(0).resolves([{ version }]);
      await prepareCmsConnection(connection);
      request.resetHistory();
      // This wrapper has no WeakMap binding but delegates to the original latest-bound request.
      const narrowed = {
        getApiVersion: () => connection.getApiVersion(),
        request: connection.request.bind(connection),
      };
      await requestJson(narrowed, operation, values);
      expect(request.callCount).to.equal(1);
      expect(request.lastCall.args[0]).to.deep.equal({
        method: 'GET',
        url: '/services/data/latest/connect/cms/folders/9PuFolder/folder-items?includeSharedWithSpaceFolder=false&itemType=Folders&page=0&pageSize=250',
      });
    }
  });

  it('dispatches explicit numeric 68 without discovery and leaves v67 operations available', async () => {
    const { connection, request } = fakeConnection();
    await prepareCmsConnection(connection, '68.0');
    await requestJson(connection, operation, values);
    expect(request.lastCall.args[0].url).to.include('/services/data/v68.0/connect/cms/folders/');
    await prepareCmsConnection(connection, '67.0');
    await requestJson(connection, getSelectedOperation('folder.get'), {
      path: { folderId: '9PuFolder' },
    });
    expect(request.lastCall.args[0].url).to.equal(
      '/services/data/v67.0/connect/cms/folders/9PuFolder',
    );
    expect(request.callCount).to.equal(2);
  });

  it('fails closed for missing, unresolved, unsupported and malformed effective versions', async () => {
    for (const version of [
      undefined,
      '',
      'latest',
      '67.0',
      '68',
      '68.1',
      'v68.0',
      'NaN',
      '-68.0',
    ]) {
      const { request } = fakeConnection();
      const error = await rejection(requestJson({ request, version }, operation, values));
      expect(error).to.be.instanceOf(CmsRequestError);
      expect(request.callCount).to.equal(0);
    }
  });

  it('propagates permission failures once without fallback, retry or inferred terminal semantics', async () => {
    const { connection, request } = fakeConnection();
    await prepareCmsConnection(connection, '68.0');
    const denied = Object.assign(new Error('Denied'), {
      statusCode: 403,
      data: [{ errorCode: 'INSUFFICIENT_ACCESS', message: 'Denied' }],
    });
    request.rejects(denied);
    const error = await rejection(requestJson(connection, operation, values));
    expect(error).to.include({
      status: 403,
      errorCode: 'INSUFFICIENT_ACCESS',
      operationKey: 'folder.items.list',
    });
    expect(request.callCount).to.equal(1);
    expect(connection.getApiVersion()).to.equal('68.0');
  });
});
