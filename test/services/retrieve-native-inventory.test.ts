import { prepareCmsConnection } from '../../src/api-policy.js';
import type { Connection } from '@salesforce/core';
import type { Duplex } from 'node:stream';
import { expect } from 'chai';
import {
  enumerateNativeFamily,
  enumerateNativeSiblings,
  type NativeInventoryOptions,
  type NativeInventoryRow,
} from '../../src/services/retrieve-native-inventory.js';

const workspaceId = '0Zuaj000007dgL8CAI';
const parentId = '20Yaj00000FaO1aEAF';
const variantId = '9Psaj00000J5oxJCAR';
const secondId = '9Psaj00000J5oxKCAR';
const types = ['sfdc_cms__email', 'sfdc_cms__emailTemplate'];
type Native = Record<string, unknown>;
function row(id = variantId): NativeInventoryRow {
  return {
    Id: id,
    ManagedContentId: parentId,
    ContentTypeFullyQualifiedName: types[1],
    Language: 'en_US',
    IsPublished: false,
    ManagedContentVariantStatus: 'Draft',
    IsPrimary: true,
    Name: 'Native template',
    UrlName: null,
    ManagedContentKey: 'MCNATIVE',
    ManagedContent: { AuthoredManagedContentSpaceId: workspaceId, ApiName: 'Native_Template' },
  };
}
function page(records: unknown[]): Native {
  return { done: true, totalSize: records.length, records };
}
function count(size = 1): Native {
  return page(size === 0 ? [] : [{ ManagedContentId: parentId, siblingCount: size }]);
}
function setup(pages = [page([row()]), page([])], size = 1) {
  const responses: unknown[] = [
    ...structuredClone(pages),
    count(size),
    ...structuredClone(pages),
    count(size),
  ];
  const calls: { method: string; url: string; options: unknown; refresh: unknown }[] = [];
  const refresh = {};
  const connection = {
    _refreshDelegate: refresh,
    getApiVersion: () => '67.0',
    request(
      this: { _refreshDelegate?: unknown },
      request: { method: string; url: string },
      options: unknown,
    ) {
      calls.push({ ...request, options, refresh: this._refreshDelegate });
      const response = responses.shift();
      return response instanceof Error
        ? Promise.reject(response)
        : Promise.resolve(structuredClone(response));
    },
  };
  const conn = connection as unknown as Pick<Connection, 'request' | 'getApiVersion'>;
  return {
    responses,
    calls,
    connection,
    refresh,
    conn,
    family: (options: NativeInventoryOptions = {}) =>
      enumerateNativeFamily(conn, workspaceId, types, options),
    siblings: (options: NativeInventoryOptions = {}) =>
      enumerateNativeSiblings(conn, workspaceId, parentId, options),
  };
}
async function fails(action: () => Promise<unknown>, match?: string): Promise<void> {
  let failure: unknown;
  try {
    await action();
  } catch (error) {
    failure = error;
  }
  expect(failure).to.be.instanceOf(TypeError);
  if (match) expect((failure as Error).message).to.include(match);
}
function query(call: { url: string }): string {
  return decodeURIComponent(call.url.split('?q=')[1]);
}

describe('bounded native retrieve inventory', () => {
  it('uses the exact API67 projection, workspace/family scope, terminal keysets, counts and repeat parity', async () => {
    const fixture = setup();
    const result = await fixture.family();
    expect(result).to.deep.equal({
      apiVersion: '67.0',
      workspaceId,
      records: [row()],
      complete: true,
      pagesRequested: 6,
    });
    const base = `SELECT Id, ManagedContentId, ContentTypeFullyQualifiedName, Language, IsPublished, ManagedContentVariantStatus, IsPrimary, Name, UrlName, ManagedContentKey, ManagedContent.AuthoredManagedContentSpaceId, ManagedContent.ApiName FROM ManagedContentVariant WHERE ManagedContent.AuthoredManagedContentSpaceId = '${workspaceId}' AND ContentTypeFullyQualifiedName IN ('sfdc_cms__email', 'sfdc_cms__emailTemplate') ORDER BY Id LIMIT 2000`;
    expect(query(fixture.calls[0])).to.equal(base);
    expect(query(fixture.calls[1])).to.equal(
      base.replace(' ORDER BY Id', ` AND Id > '${variantId}' ORDER BY Id`),
    );
    expect(query(fixture.calls[2])).to.equal(
      `SELECT ManagedContentId, COUNT(Id) siblingCount FROM ManagedContentVariant WHERE ManagedContent.AuthoredManagedContentSpaceId = '${workspaceId}' AND ContentTypeFullyQualifiedName IN ('sfdc_cms__email', 'sfdc_cms__emailTemplate') GROUP BY ManagedContentId LIMIT 2000`,
    );
    expect(fixture.calls.slice(3).map((call) => query(call))).to.deep.equal(
      fixture.calls.slice(0, 3).map((call) => query(call)),
    );
    for (const call of fixture.calls) {
      expect(call.method).to.equal('GET');
      expect(call.url).to.match(/^\/services\/data\/v67\.0\/query\?q=/u);
      expect(call.options).to.deep.equal({ timeout: 30_000, retry: { maxRetries: 0 } });
      expect(call.refresh).to.equal(undefined);
    }
    expect(fixture.connection._refreshDelegate).to.equal(fixture.refresh);
  });
  it('independently returns siblings across types, statuses and languages without narrowing filters', async () => {
    const other = {
      ...row(secondId),
      ContentTypeFullyQualifiedName: 'sfdc_cms__other',
      Language: 'de',
      ManagedContentVariantStatus: 'Published',
      IsPublished: true,
      IsPrimary: false,
    };
    const fixture = setup([page([row()]), page([other]), page([])], 2);
    const result = await fixture.siblings({ timeoutMs: 1500 });
    expect(result.records).to.deep.equal([row(), other]);
    expect(result.pagesRequested).to.equal(8);
    for (const call of fixture.calls) {
      expect(query(call)).to.include(
        `WHERE ManagedContentId = '${parentId}' AND ManagedContent.AuthoredManagedContentSpaceId = '${workspaceId}'`,
      );
      expect(query(call).split(' WHERE ')[1]).not.to.match(
        /ContentTypeFullyQualifiedName|Language|IsPublished|ManagedContentVariantStatus/u,
      );
      expect(call.options).to.deep.equal({ timeout: 1500, retry: { maxRetries: 0 } });
    }
  });
  it('requires explicit empty terminal even after a short page, and validates empty inventories', async () => {
    const fixture = setup([page([])], 0);
    const result = await fixture.family();
    expect(result.records).to.deep.equal([]);
    expect(fixture.calls).to.have.length(4);
    const bounded = setup();
    await fails(() => bounded.family({ maxPages: 1 }), 'empty termination');
    expect(bounded.calls).to.have.length(1);
  });
  it('rejects malformed response metadata, locator continuations and oversized pages', async () => {
    for (const response of [
      { done: false, totalSize: 1, records: [row()] },
      { done: true, totalSize: 2, records: [row()] },
      { done: true, totalSize: '1', records: [row()] },
      { ...page([row()]), nextRecordsURL: '/query/locator' },
      { ...page([row()]), nextRecordsUrl: '/query/locator' },
      { done: true, totalSize: 0, records: null },
      page(Array.from({ length: 2001 }, () => row())),
    ]) {
      const fixture = setup();
      fixture.responses[0] = response;
      await fails(() => fixture.family());
      expect(fixture.calls).to.have.length(1);
    }
  });
  it('rejects malformed native rows, foreign scopes/types, duplicate IDs and regressing cursors', async () => {
    for (const change of [
      (value: Native) => {
        value.Id = 'bad';
      },
      (value: Native) => {
        value.ManagedContentId = 'bad';
      },
      (value: Native) => {
        value.ContentTypeFullyQualifiedName = types[0] + "'";
      },
      (value: Native) => {
        value.ContentTypeFullyQualifiedName = 'sfdc_cms__other';
      },
      (value: Native) => {
        (value.ManagedContent as Native).AuthoredManagedContentSpaceId = '0Zufj000006rx4wCAA';
      },
      (value: Native) => {
        value.ManagedContent = null;
      },
      (value: Native) => {
        value.Language = null;
      },
      (value: Native) => {
        value.IsPublished = 'false';
      },
      (value: Native) => {
        delete value.UrlName;
      },
      (value: Native) => {
        delete (value.ManagedContent as Native).ApiName;
      },
    ]) {
      const fixture = setup();
      const value = row() as unknown as Native;
      change(value);
      fixture.responses[0] = page([value]);
      await fails(() => fixture.family());
    }
    for (const pages of [
      [page([row(), row()])],
      [page([row(secondId), row()])],
      [page([row()]), page([row()])],
    ]) {
      const fixture = setup(pages);
      await fails(() => fixture.family(), 'cursor');
    }
    const foreign = setup();
    (foreign.responses[0] as Native).records = [
      { ...row(), ManagedContentId: '20Yaj00000FaDZBEA3' },
    ];
    await fails(() => foreign.siblings(), 'parent');
  });
  it('rejects missing/extra/duplicate/count-mismatched parent groups and aggregate truncation', async () => {
    for (const response of [
      count(0),
      count(2),
      page([{ ManagedContentId: parentId, siblingCount: '1' }]),
      page([{ ManagedContentId: parentId, siblingCount: 0 }]),
      page([
        { ManagedContentId: parentId, siblingCount: 1 },
        { ManagedContentId: parentId, siblingCount: 1 },
      ]),
      page([{ ManagedContentId: '20Yaj00000FaDZBEA3', siblingCount: 1 }]),
      page(Array.from({ length: 2000 }, () => ({ ManagedContentId: parentId, siblingCount: 1 }))),
    ]) {
      const fixture = setup();
      fixture.responses[2] = response;
      await fails(() => fixture.family());
    }
  });
  it('rejects a dropped native row despite exhausted enumeration when the count sees it', async () => {
    const fixture = setup([page([])], 0);
    fixture.responses[1] = count(1);
    await fails(() => fixture.family(), 'count disagreement');
  });
  it('rejects changed rows, dropped rows and changed counts during repeat reads', async () => {
    for (const change of [
      (fixture: ReturnType<typeof setup>) => {
        ((fixture.responses[3] as Native).records as Native[])[0].Name = 'Changed';
      },
      (fixture: ReturnType<typeof setup>) => {
        fixture.responses.splice(3, 3, page([]), count(0));
      },
      (fixture: ReturnType<typeof setup>) => {
        fixture.responses[5] = count(2);
      },
    ]) {
      const fixture = setup();
      change(fixture);
      await fails(() => fixture.family());
    }
  });
  it('validates query inputs, selected API, cancellation and bounds before transport', async () => {
    const fixture = setup();
    for (const action of [
      () => enumerateNativeFamily(fixture.conn, "0Zu' OR Id != null", types),
      () => enumerateNativeFamily(fixture.conn, workspaceId, []),
      () => enumerateNativeFamily(fixture.conn, workspaceId, ["sfdc_cms__email' OR Id != null"]),
      () => enumerateNativeSiblings(fixture.conn, workspaceId, "20Y' OR Id != null"),
      ...[
        { timeoutMs: 0 },
        { timeoutMs: Number.NaN },
        { signal: AbortSignal.abort() },
        { maxPages: 0 },
        { maxPages: 1001 },
        { maxRows: 250_001 },
        { maxRows: 1.5 },
      ].map((options) => () => fixture.family(options)),
    ])
      await fails(action);
    expect(fixture.calls).to.have.length(0);
  });
  it('uses latest REST paths with effective numeric inventory provenance', async () => {
    const fixture = setup();
    let version = '67.0';
    fixture.connection.getApiVersion = () => version;
    const connection = Object.assign(fixture.connection, {
      setApiVersion: (value: string) => {
        version = value;
      },
    });
    const request = connection.request.bind(connection);
    Object.assign(connection, {
      request: (input: { method: string; url: string }, options: unknown) => {
        if (input.url === '/services/data') return Promise.resolve([{ version: '68.0' }]);
        if (input.url.includes('pageSize=1') || input.url.includes('SELECT%20Id%20FROM'))
          return Promise.resolve({});
        return request(input, options);
      },
    });
    await prepareCmsConnection(connection as unknown as Connection);
    const result = await fixture.family();
    expect(result.apiVersion).to.equal('68.0');
    expect(
      fixture.calls.every(({ url }) => url.startsWith('/services/data/latest/query?')),
    ).to.equal(true);
  });

  it('uses newer selected numeric APIs instead of restricting inventory to API67', async () => {
    const fixture = setup();
    fixture.connection.getApiVersion = () => '68.0';
    const result = await fixture.family();
    expect(result.apiVersion).to.equal('68.0');
    expect(
      fixture.calls.every(({ url }) => url.startsWith('/services/data/v68.0/query?')),
    ).to.equal(true);
  });
  it('enforces a row cap, never retries errors and redacts secrets', async () => {
    const bounded = setup([page([row(), row(secondId)]), page([])], 2);
    await fails(() => bounded.family({ maxRows: 1 }), 'row cap');
    const fixture = setup();
    fixture.responses[0] = new Error('Authorization: Bearer secret-token');
    let message = '';
    try {
      await fixture.family();
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).not.to.include('secret-token');
    expect(fixture.calls).to.have.length(1);
  });
  it('destroys the active transport stream when cancelled', async () => {
    const controller = new AbortController();
    let destroyed = false;
    const connection = {
      getApiVersion: () => '67.0',
      request() {
        let rejectRequest!: (error: Error) => void;
        const promise = new Promise<unknown>((_resolve, reject) => {
          rejectRequest = reject;
        });
        const request = Object.assign(promise, {
          stream: () =>
            ({
              destroy(error: Error) {
                destroyed = true;
                rejectRequest(error);
              },
            }) as unknown as Duplex,
        });
        queueMicrotask(() => controller.abort());
        return request;
      },
    };
    await fails(
      () =>
        enumerateNativeFamily(
          connection as unknown as Pick<Connection, 'request' | 'getApiVersion'>,
          workspaceId,
          types,
          { signal: controller.signal },
        ),
      'cancelled',
    );
    expect(destroyed).to.equal(true);
  });
});
