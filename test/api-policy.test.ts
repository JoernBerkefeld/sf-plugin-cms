import { PassThrough } from 'node:stream';
import { expect } from 'chai';
import sinon from 'sinon';
import { Connection } from '@salesforce/core';
import { Connection as JsforceConnection } from '@jsforce/jsforce-node';
import {
  DEFAULT_API_VERSION,
  FALLBACK_API_VERSION,
  apiDataPath,
  getCmsApiSelection,
  inheritCmsApiSelection,
  isNumericApiVersion,
  prepareCmsConnection,
} from '../src/api-policy.js';

function fakeConnection() {
  const request = sinon.stub().resolves({});
  request.onCall(0).resolves([{ version: '67.0' }, { version: '9.0' }, { version: '68.0' }]);
  const connection = {
    version: '66.0',
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

describe('CMS API policy', () => {
  it('validates numeric versions and builds distinct REST roots', () => {
    expect(DEFAULT_API_VERSION).to.equal('latest');
    expect(FALLBACK_API_VERSION).to.equal('67.0');
    for (const value of ['67.0', '68.0', '100.0'])
      expect(isNumericApiVersion(value)).to.equal(true);
    for (const value of ['latest', 'v67.0', '67', '0.0', '67.1', ' 67.0', null, 67]) {
      expect(isNumericApiVersion(value)).to.equal(false);
    }
    expect(apiDataPath('latest')).to.equal('/services/data/latest');
    expect(apiDataPath('68.0')).to.equal('/services/data/v68.0');
    expect(() => apiDataPath('v67.0')).to.throw('Invalid CMS API version');
  });

  it('discovers the actual numeric maximum and preflights latest without changing its REST spelling', async () => {
    const { connection, request } = fakeConnection();
    expect(await prepareCmsConnection(connection)).to.equal(connection);
    expect(connection.version).to.equal('68.0');
    expect(getCmsApiSelection(connection)).to.deep.equal({
      requestedVersion: 'latest',
      effectiveApiVersion: '68.0',
      restDataPath: '/services/data/latest',
    });
    expect(request.args.map(([input]) => input)).to.deep.equal([
      { method: 'GET', url: '/services/data' },
      { method: 'GET', url: '/services/data/latest/connect/cms/spaces?pageSize=1' },
      {
        method: 'GET',
        url: '/services/data/latest/query?q=SELECT%20Id%20FROM%20ManagedContentVariant%20LIMIT%201',
      },
    ]);
  });

  it('binds explicit newer numeric versions without discovery or fallback', async () => {
    const { connection, request } = fakeConnection();
    await prepareCmsConnection(connection, '69.0');
    expect(connection.version).to.equal('69.0');
    expect(request.callCount).to.equal(0);
    expect(getCmsApiSelection(connection)).to.deep.equal({
      requestedVersion: '69.0',
      effectiveApiVersion: '69.0',
      restDataPath: '/services/data/v69.0',
    });
    const error = { errorCode: 'INVALID_VERSION' };
    request.resetBehavior();
    request.rejects(error);
    expect(
      await rejection(connection.request({ method: 'POST', url: '/connect/cms/contents' })),
    ).to.equal(error);
    expect(request.callCount).to.equal(1);
    expect(await rejection(prepareCmsConnection(connection, 'bogus'))).to.be.instanceOf(Error);
    expect(connection.version).to.equal('69.0');
  });

  for (const failingCall of [1, 2]) {
    it(`preflights both fallback routes when latest probe ${failingCall} has an explicit unsupported route`, async () => {
      const { connection, request } = fakeConnection();
      request.onCall(failingCall).rejects({
        errorCode: 'NOT_FOUND',
        message: 'Could not find a match for URL',
        statusCode: 404,
      });
      await prepareCmsConnection(connection);
      expect(connection.version).to.equal('67.0');
      expect(getCmsApiSelection(connection).restDataPath).to.equal('/services/data/v67.0');
      expect(request.args.slice(-2).map(([input]) => input.url)).to.deep.equal([
        '/services/data/v67.0/connect/cms/spaces?pageSize=1',
        '/services/data/v67.0/query?q=SELECT%20Id%20FROM%20ManagedContentVariant%20LIMIT%201',
      ]);
      expect(request.args.every(([input]) => input.method === 'GET')).to.equal(true);
    });
  }

  for (const error of [
    { errorCode: 'INVALID_SESSION_ID', statusCode: 401 },
    { errorCode: 'INSUFFICIENT_ACCESS', statusCode: 403 },
    { errorCode: 'NOT_FOUND', message: 'Record not found', statusCode: 404 },
    { errorCode: 'NOT_FOUND', message: 'Could not find a match for URL', statusCode: 403 },
    { message: 'Could not find a match for URL', statusCode: 404 },
    { errorCode: 'INVALID_TYPE', message: 'ManagedContentVariant is not supported' },
    { code: 'ECONNRESET' },
  ]) {
    it(`does not fallback on ambiguous, permission or transport failure: ${JSON.stringify(error)}`, async () => {
      const { connection, request } = fakeConnection();
      request.onCall(1).rejects(error);
      expect(await rejection(prepareCmsConnection(connection))).to.equal(error);
      expect(request.callCount).to.equal(2);
    });
  }

  it('recognizes explicit version errors and fails closed if fallback preflight fails', async () => {
    const { connection, request } = fakeConnection();
    request.onCall(1).rejects({ errorCode: 'INVALID_VERSION' });
    const denied = { errorCode: 'INSUFFICIENT_ACCESS', statusCode: 403 };
    request.onCall(3).rejects(denied);
    expect(await rejection(prepareCmsConnection(connection))).to.equal(denied);
    expect(request.callCount).to.equal(4);
    expect(connection.version).to.equal('68.0');
  });

  it('fails closed on invalid discovery responses and discovery authentication failures', async () => {
    for (const value of [{ version: '68.0' }, [], [{ version: 'latest' }]]) {
      const { connection, request } = fakeConnection();
      request.onCall(0).resolves(value);
      expect(await rejection(prepareCmsConnection(connection))).to.be.instanceOf(Error);
      expect(request.callCount).to.equal(1);
    }
    const { connection, request } = fakeConnection();
    const denied = { errorCode: 'INVALID_SESSION_ID' };
    request.onCall(0).rejects(denied);
    expect(await rejection(prepareCmsConnection(connection))).to.equal(denied);
    expect(request.callCount).to.equal(1);
  });

  it('preserves request options, body, headers, exact stream promise and never replays mutations', async () => {
    const { connection, request } = fakeConnection();
    await prepareCmsConnection(connection);
    const stream = new PassThrough();
    const result = Object.assign(Promise.resolve({ ok: true }), { stream: () => stream });
    request.returns(result);
    const options = { timeout: 1234, encoding: null };
    const headers = { 'content-type': 'application/json' };
    const input = { method: 'POST', url: '/connect/cms/contents', headers, body: '{}' };
    const returned = connection.request(input, options);
    expect(returned).to.equal(result);
    expect(returned.stream()).to.equal(stream);
    expect(request.lastCall.args).to.deep.equal([
      { ...input, url: '/services/data/latest/connect/cms/contents' },
      options,
    ]);
    expect(request.lastCall.args[1]).to.equal(options);
    expect(request.lastCall.args[0].headers).to.equal(headers);
    expect(input.url).to.equal('/connect/cms/contents');
    const unsupported = { errorCode: 'INVALID_VERSION' };
    request.rejects(unsupported);
    const before = request.callCount;
    expect(
      await rejection(connection.request({ method: 'DELETE', url: '/connect/cms/contents/id' })),
    ).to.equal(unsupported);
    expect(request.callCount).to.equal(before + 1);
  });

  it('preserves shadow receivers, inherited selection and the exact stream promise', async () => {
    const { connection, request } = fakeConnection();
    const refreshDelegate = {};
    const caller = Object.assign(connection, { _refreshDelegate: refreshDelegate });
    await prepareCmsConnection(caller);
    const shadow = Object.create(caller) as typeof caller;
    Object.defineProperty(shadow, '_refreshDelegate', { value: undefined });
    const nestedShadow = Object.create(shadow) as typeof caller;
    expect(getCmsApiSelection(nestedShadow)).to.deep.equal(getCmsApiSelection(caller));
    const stream = new PassThrough();
    const result = Object.assign(Promise.resolve({ ok: true }), { stream: () => stream });
    request.returns(result);
    const options = { timeout: 1234, retry: { maxRetries: 0 } };
    const input = { method: 'GET', url: '/services/data/v68.0/query?q=SELECT' };
    const returned = shadow.request(input, options);
    expect(returned).to.equal(result);
    expect(returned.stream()).to.equal(stream);
    expect(request.lastCall.thisValue).to.equal(shadow);
    expect(request.lastCall.thisValue._refreshDelegate).to.equal(undefined);
    expect(caller._refreshDelegate).to.equal(refreshDelegate);
    expect(request.lastCall.args).to.deep.equal([
      { ...input, url: '/services/data/latest/query?q=SELECT' },
      options,
    ]);
    expect(request.lastCall.args[1]).to.equal(options);
    expect(input.url).to.equal('/services/data/v68.0/query?q=SELECT');
    expect(caller.version).to.equal('68.0');
  });

  it('rewrites relative and current numeric roots but leaves absolute and other services untouched', async () => {
    const { connection, request } = fakeConnection();
    await prepareCmsConnection(connection);
    for (const [url, expected] of [
      ['/query?q=select', '/services/data/latest/query?q=select'],
      ['/services/data/v68.0/query?q=select', '/services/data/latest/query?q=select'],
      ['/services/data/v68.0', '/services/data/latest'],
      ['/services/data/v67.0/query', '/services/data/v67.0/query'],
      ['/services/data/v68.01/query', '/services/data/v68.01/query'],
      ['/services/data', '/services/data'],
      ['/services/Soap/u/68.0', '/services/Soap/u/68.0'],
      [
        'https://example.com/services/data/v68.0/query',
        'https://example.com/services/data/v68.0/query',
      ],
      ['//example.com/query', '//example.com/query'],
    ]) {
      await connection.request(url);
      expect(request.lastCall.args[0]).to.equal(expected);
    }
  });

  it('inherits selection into fresh connections without rediscovery and does not stack adapters', async () => {
    const source = fakeConnection();
    const target = fakeConnection();
    await prepareCmsConnection(source.connection);
    inheritCmsApiSelection(source.connection, target.connection);
    inheritCmsApiSelection(source.connection, target.connection);
    expect(target.connection.version).to.equal('68.0');
    expect(target.request.callCount).to.equal(0);
    expect(getCmsApiSelection(target.connection)).to.deep.equal(
      getCmsApiSelection(source.connection),
    );
    await target.connection.request('/query');
    expect(target.request.lastCall.args[0]).to.equal('/services/data/latest/query');
    expect(target.request.callCount).to.equal(1);
    const selection = getCmsApiSelection(target.connection);
    selection.restDataPath = 'modified';
    expect(getCmsApiSelection(target.connection).restDataPath).to.equal('/services/data/latest');
    expect(getCmsApiSelection({ version: '69.0' }).restDataPath).to.equal('/services/data/v69.0');
    expect(getCmsApiSelection({ getApiVersion: () => '68.0' }).effectiveApiVersion).to.equal(
      '68.0',
    );
    expect(() => getCmsApiSelection({})).to.throw('no API version');
  });

  it('uses actual JSforce/Core normalization with numeric Core state and a distinct latest HTTP route', async () => {
    const connection = new JsforceConnection({
      instanceUrl: 'https://example.my.salesforce.com',
      version: '66.0',
    });
    const normalized: string[] = [];
    // Use the installed JSforce URL normalizer with Core's numeric version accessors.
    Object.assign(connection, {
      logger: { getRawLogger: () => ({ debug: () => {} }) },
      setApiVersion: Connection.prototype.setApiVersion,
      getApiVersion: Connection.prototype.getApiVersion,
    });
    const http = sinon.stub(connection, 'request').callsFake((input, options) => {
      const normalize = (
        connection as unknown as { _normalizeUrl: (url: string) => string }
      )._normalizeUrl.bind(connection);
      const url = normalize(typeof input === 'string' ? input : input.url);
      normalized.push(url);
      if (url.endsWith('/services/data')) {
        return Promise.resolve([{ version: '68.0' }]) as ReturnType<JsforceConnection['request']>;
      }
      expect(options).to.equal(undefined);
      return Promise.resolve({}) as ReturnType<JsforceConnection['request']>;
    });
    const policyConnection = connection as unknown as Connection;
    await prepareCmsConnection(policyConnection);
    await policyConnection.request('/query?q=SELECT');
    expect(normalized.at(-1)).to.equal(
      'https://example.my.salesforce.com/services/data/latest/query?q=SELECT',
    );
    expect(policyConnection.getApiVersion()).to.equal('68.0');
    await prepareCmsConnection(policyConnection, '69.0');
    await policyConnection.request('/query?q=SELECT');
    expect(normalized.at(-1)).to.equal(
      'https://example.my.salesforce.com/services/data/v69.0/query?q=SELECT',
    );
    http.restore();
  });
});
