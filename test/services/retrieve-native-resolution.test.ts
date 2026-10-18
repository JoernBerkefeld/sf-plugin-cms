import type { Connection } from '@salesforce/core';
import { expect } from 'chai';
import { resolveNativeRetrieveSelection } from '../../src/services/retrieve-native-resolution.js';
import {
  NativeInventoryRequestError,
  type NativeInventoryRow,
} from '../../src/services/retrieve-native-inventory.js';
import { normalizeRetrieveSelection } from '../../src/services/retrieve-selection.js';

const workspaceId = '0Zuaj000007dgL8CAI';
const parentId = '20Yaj00000FaO1aEAF';
const otherParent = '20Yaj00000FaDZBEA3';
const type = 'sfdc_cms__emailTemplate';
function row(index = 0, changes: Partial<NativeInventoryRow> = {}): NativeInventoryRow {
  return {
    Id: `9Psaj00000J5ox${String.fromCodePoint(74 + index)}CAR`,
    ManagedContentId: parentId,
    ContentTypeFullyQualifiedName: type,
    Language: 'en_US',
    IsPublished: false,
    ManagedContentVariantStatus: 'Draft',
    IsPrimary: true,
    Name: 'Not the API name',
    UrlName: 'not-the-api-name',
    ManagedContentKey: 'MCNATIVE',
    ManagedContent: { AuthoredManagedContentSpaceId: workspaceId, ApiName: 'Exact_Name' },
    ...changes,
  };
}
const page = (values: unknown[]) => ({ done: true, totalSize: values.length, records: values });
function setup(records: NativeInventoryRow[] = [row()]) {
  const counts = new Map<string, number>();
  for (const value of records)
    counts.set(value.ManagedContentId, (counts.get(value.ManagedContentId) ?? 0) + 1);
  const responses: unknown[] = [];
  for (let repeat = 0; repeat < 2; repeat += 1)
    responses.push(
      page(records),
      page([]),
      page(
        [...counts].map(([ManagedContentId, siblingCount]) => ({ ManagedContentId, siblingCount })),
      ),
    );
  const calls: string[] = [];
  const connection = {
    getApiVersion: () => '67.0',
    request(request: { url: string }) {
      calls.push(decodeURIComponent(request.url));
      const response = responses.shift();
      return response instanceof Error
        ? Promise.reject(response)
        : Promise.resolve(structuredClone(response));
    },
  } as unknown as Pick<Connection, 'request' | 'getApiVersion'>;
  return {
    calls,
    responses,
    resolve: (metadata = [`${type}:Exact_Name`], language = 'en_US') =>
      resolveNativeRetrieveSelection(connection, {
        workspaceId,
        language,
        selection: normalizeRetrieveSelection({ metadata }),
      }),
    native: (selector: string, contentType = type) =>
      resolveNativeRetrieveSelection(connection, {
        workspaceId,
        language: 'en_US',
        selection: normalizeRetrieveSelection({
          'content-type': [contentType],
          'content-key-or-id': [selector],
        }),
      }),
    connection,
  };
}
async function failure(action: () => Promise<unknown>): Promise<Error> {
  try {
    await action();
  } catch (error) {
    return error as Error;
  }
  throw new Error('Expected rejection');
}
describe('native retrieve resolution', () => {
  it('uses exhaustive all-language inventory, selects explicit language and deduplicates in native order', async () => {
    const rows = [
      row(),
      row(1, { Language: 'de' }),
      row(2, { IsPublished: true, ManagedContentVariantStatus: 'Published' }),
    ];
    const fixture = setup(rows);
    const result = await fixture.resolve([type, `${type}:Exact_Name`, `${type}:Exact_Name`]);
    expect(result.variants).to.deep.equal([rows[0], rows[2]]);
    expect(result.unresolved).to.deep.equal([]);
    expect(result.inventory).to.deep.equal({
      complete: true,
      pagesRequested: 6,
      recordCount: 3,
      contentTypes: [type],
      scope: 'principal-visible-nondeleted-family-all-languages-and-statuses',
    });
    expect(result).to.include({ workspaceId, language: 'en_US', apiVersion: '67.0' });
    expect(fixture.calls).to.have.length(6);
    expect(
      fixture.calls.every((query) => query.includes(workspaceId) && !query.includes('Language =')),
    ).to.equal(true);
  });
  it('resolves default groups with empty types/languages only after complete native proof', async () => {
    const fixture = setup([row(0, { Language: 'de' })]);
    const input = { workspaceId, language: 'en_US', selection: normalizeRetrieveSelection({}) };
    const result = await resolveNativeRetrieveSelection(fixture.connection, input);
    expect(result.variants).to.deep.equal([]);
    expect(result.unresolved).to.deep.equal([]);
    expect(result.inventory.complete).to.equal(true);
    expect(result.inventory.contentTypes).to.deep.equal(
      input.selection.groups.map((group) => group.contentType),
    );
    const incomplete = setup();
    incomplete.responses[1] = undefined;
    expect(
      await failure(() => resolveNativeRetrieveSelection(incomplete.connection, input)),
    ).to.be.instanceOf(TypeError);
    const explicitMissing = await setup().resolve([type, `${type}:Missing`]);
    expect(explicitMissing.unresolved[0]).to.include({ selector: 'Missing', reason: 'missing' });
  });
  it('matches parent keys and parent IDs but never variant IDs', async () => {
    for (const selector of ['MCNATIVE', parentId]) {
      const resolved = await setup().native(selector);
      expect(resolved.variants).to.deep.equal([row()]);
    }
    const result = await setup().native(row().Id);
    expect(result.variants).to.deep.equal([]);
    expect(result.unresolved).to.deep.equal([
      {
        contentType: type,
        kind: 'content-key-or-id',
        selector: row().Id,
        reason: 'missing',
        parentIds: [],
      },
    ]);
  });
  it('resolves exact Audio names, keys and parent IDs with mixed metadata but not variant IDs', async () => {
    const audio = 'sfdc_cms__audio';
    const selected = row(0, { ContentTypeFullyQualifiedName: audio });
    for (const selector of ['MCNATIVE', parentId]) {
      const result = await setup([selected]).native(selector, audio);
      expect(result.variants).to.deep.equal([selected]);
      expect(result.unresolved).to.deep.equal([]);
    }
    const missing = await setup([selected]).native(selected.Id, audio);
    expect(missing.variants).to.deep.equal([]);
    expect(missing.unresolved[0]).to.include({ selector: selected.Id, reason: 'missing' });
    const template = row(1, { ManagedContentId: otherParent });
    const mixed = await setup([selected, template]).resolve([
      `${audio}:Exact_Name`,
      `${type}:Exact_Name`,
      `${audio}:Missing`,
    ]);
    expect(mixed.variants).to.deep.equal([selected, template]);
    expect(mixed.unresolved[0]).to.include({ contentType: audio, selector: 'Missing' });
    const wrongCase = await setup([selected]).resolve([`${audio}:exact_name`]);
    expect(wrongCase.variants).to.deep.equal([]);
  });
  it('preserves exact unresolved selectors without matching titles, slugs, whitespace or case', async () => {
    for (const selector of [
      'exact_name',
      ' Exact_Name',
      'Exact_Name ',
      'Not the API name',
      'not-the-api-name',
    ]) {
      const result = await setup().resolve([`${type}:${selector}`]);
      expect(result.variants).to.deep.equal([]);
      expect(result.unresolved).to.deep.equal([
        { contentType: type, kind: 'api-name', selector, reason: 'missing', parentIds: [] },
      ]);
    }
  });
  it('reports explicit missing members even alongside all without fabricating API names', async () => {
    const result = await setup().resolve([type, `${type}:Missing`]);
    expect(result.variants).to.deep.equal([row()]);
    expect(result.unresolved[0]).to.deep.equal({
      contentType: type,
      kind: 'api-name',
      selector: 'Missing',
      reason: 'missing',
      parentIds: [],
    });
  });
  it('rejects ambiguous names and keys across parents even if only one has the requested language', async () => {
    const rows = [row(), row(1, { ManagedContentId: otherParent, Language: 'de' })];
    for (const result of [
      await setup(rows).resolve([type, `${type}:Exact_Name`]),
      await setup(rows).native('MCNATIVE'),
    ]) {
      expect(result.unresolved[0]).to.include({ reason: 'ambiguous' });
      expect(result.unresolved[0].parentIds).to.deep.equal([parentId, otherParent]);
    }
  });
  it('keeps observed parent evidence for missing language and allows null API names for native selectors', async () => {
    const missing = await setup([row(0, { Language: 'de' })]).resolve();
    expect(missing.unresolved[0]).to.include({ reason: 'missing', selector: 'Exact_Name' });
    expect(missing.unresolved[0].parentIds).to.deep.equal([parentId]);
    const native = await setup([
      row(0, { ManagedContent: { AuthoredManagedContentSpaceId: workspaceId, ApiName: null } }),
    ]).native(parentId);
    expect(native.variants[0].ManagedContent.ApiName).to.equal(null);
  });
  it('does not cross content families', async () => {
    const fixture = setup([row(0, { ContentTypeFullyQualifiedName: 'sfdc_cms__email' })]);
    // Inventory rejects an out-of-scope row instead of silently trusting it.
    const error = await failure(() => fixture.resolve());
    expect(error.message).to.include('type disagreement');
  });
  it('cannot bypass terminal, count, repeat or bounded completeness checks', async () => {
    for (const change of [
      (values: unknown[]) => {
        values[1] = undefined;
      },
      (values: unknown[]) => {
        values[2] = { done: true, totalSize: 0, records: [] };
      },
      (values: unknown[]) => {
        values[3] = { done: true, totalSize: 0, records: [] };
      },
    ]) {
      const fixture = setup();
      change(fixture.responses);
      expect(await failure(() => fixture.resolve())).to.be.instanceOf(TypeError);
    }
    const fixture = setup();
    const error = await failure(() =>
      resolveNativeRetrieveSelection(
        fixture.connection,
        {
          workspaceId,
          language: 'en_US',
          selection: normalizeRetrieveSelection({ metadata: [type] }),
        },
        { maxPages: 1 },
      ),
    );
    expect(error.message).to.include('empty termination');
  });
  it('preserves sanitized structured fatal inventory evidence rather than returning missing members', async () => {
    const fixture = setup();
    fixture.responses[0] = Object.assign(new Error('Authorization: Bearer secret-token'), {
      statusCode: 403,
      data: [{ errorCode: 'INSUFFICIENT_ACCESS', message: 'Bearer response-secret' }],
    });
    const error = await failure(() => fixture.resolve());
    expect(error).to.be.instanceOf(NativeInventoryRequestError);
    expect(error).to.include({
      status: 403,
      statusObserved: true,
      errorCode: 'INSUFFICIENT_ACCESS',
      errorEntryCount: 1,
    });
    expect(JSON.stringify(error))
      .not.to.include('secret-token')
      .and.not.to.include('response-secret');
    expect(error.message).not.to.include('secret-token');
    expect(fixture.calls).to.have.length(1);
  });
  it('resolves multiple families independently and returns empty all selections honestly', async () => {
    const email = 'sfdc_cms__email';
    const rows = [
      row(),
      row(1, { ContentTypeFullyQualifiedName: email, ManagedContentId: otherParent }),
    ];
    const fixture = setup(rows);
    const result = await fixture.resolve([`${email}:Exact_Name`, `${type}:Exact_Name`]);
    expect(result.variants).to.deep.equal(rows);
    expect(result.unresolved).to.deep.equal([]);
    expect(result.inventory.contentTypes).to.deep.equal([email, type]);
    const empty = setup();
    empty.responses.splice(0, empty.responses.length, ...Array.from({ length: 4 }, () => page([])));
    const absent = await empty.resolve([type]);
    expect(absent.variants).to.deep.equal([]);
    expect(absent.unresolved).to.deep.equal([]);
    expect(absent.inventory.pagesRequested).to.equal(4);
  });
  it('does not infer HTTP status or retain raw transport objects', async () => {
    const fixture = setup();
    fixture.responses[0] = Object.assign(new Error('network failure'), {
      errorCode: 'NOT_FOUND',
      response: {
        data: [{ errorCode: 'FIRST' }, { errorCode: 'SECOND' }],
        headers: { authorization: 'secret' },
      },
    });
    const error = await failure(() => fixture.resolve());
    expect(error).to.include({ statusObserved: false, errorEntryCount: 2, errorCode: 'NOT_FOUND' });
    expect(error).not.to.have.property('response');
    expect(error).not.to.have.property('cause');
  });
  it('requires explicit language before requesting inventory', async () => {
    const fixture = setup();
    for (const language of ['', ' '])
      expect(await failure(() => fixture.resolve(undefined, language))).to.be.instanceOf(TypeError);
    expect(fixture.calls).to.have.length(0);
  });
});
