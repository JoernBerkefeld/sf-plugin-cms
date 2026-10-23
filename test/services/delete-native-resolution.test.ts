import type { Connection } from '@salesforce/core';
import { expect } from 'chai';
import {
  normalizeDeleteSelection,
  resolveNativeDeleteSelection,
  type DeleteSelectionFlags,
} from '../../src/services/delete-native-resolution.js';
import type { NativeInventoryRow } from '../../src/services/retrieve-native-inventory.js';

const workspaceId = '0Zuaj000007dgL8CAI';
const parentId = '20Yaj00000FaO1aEAF';
function row(index = 0, changes: Partial<NativeInventoryRow> = {}): NativeInventoryRow {
  return {
    Id: `9Psaj00000J5ox${String.fromCodePoint(74 + index)}CAR`,
    ManagedContentId: parentId,
    ContentTypeFullyQualifiedName: 'sfdc_cms__audio',
    Language: 'en_US',
    VariantType: 'Content',
    IsPublished: false,
    ManagedContentVariantStatus: 'Draft',
    IsPrimary: true,
    Name: 'Display name',
    UrlName: null,
    ManagedContentKey: 'MCKEY',
    ManagedContent: { AuthoredManagedContentSpaceId: workspaceId, ApiName: 'Exact_Name' },
    ...changes,
  };
}
const page = (records: unknown[]) => ({ done: true, totalSize: records.length, records });
const defaultSelection: DeleteSelectionFlags = { metadata: ['audio:Exact_Name'] };
function fixture(rows = [row()]) {
  const calls: string[] = [];
  const details = new Map(
    rows.map((value) => [
      value.Id,
      {
        managedContentId: value.ManagedContentId,
        managedContentVariantId: value.Id,
        language: value.Language,
        apiName: value.ManagedContent.ApiName,
        contentType: { fullyQualifiedName: value.ContentTypeFullyQualifiedName },
        contentSpace: { id: workspaceId },
        isPublished: value.IsPublished,
        status: { status: value.ManagedContentVariantStatus },
        managedContentVersionId: '5OUaj00000FaO1aEAF',
        contentVersion: 2,
        variantVersion: 3,
      } as Record<string, unknown>,
    ]),
  );
  const counts = new Map<string, number>();
  for (const value of rows)
    counts.set(value.ManagedContentId, (counts.get(value.ManagedContentId) ?? 0) + 1);
  const responses = Array.from({ length: 2 }, () => [
    page(rows),
    page([]),
    page(
      [...counts].map(([ManagedContentId, siblingCount]) => ({ ManagedContentId, siblingCount })),
    ),
  ]).flat();
  const connection = {
    getApiVersion: () => '67.0',
    request(request: { url: string; method: string }) {
      expect(request.method).to.equal('GET');
      calls.push(request.url);
      if (request.url.includes('/query?'))
        return Promise.resolve(structuredClone(responses.shift()));
      return Promise.resolve(structuredClone(details.get(request.url.split('/').at(-1)!)));
    },
  } as unknown as Pick<Connection, 'request' | 'getApiVersion'>;
  return {
    calls,
    details,
    resolve: (languages?: string[], selection: DeleteSelectionFlags = defaultSelection) =>
      resolveNativeDeleteSelection(connection, { workspaceId, selection, languages }),
  };
}
async function failure(action: () => Promise<unknown>, match: string): Promise<void> {
  try {
    await action();
  } catch (error) {
    expect(error).to.be.instanceOf(TypeError);
    expect((error as Error).message).to.include(match);
    return;
  }
  throw new Error('Expected failure');
}

describe('exact-item native delete resolver', () => {
  it('admits exactly the public five families and deduplicates exact repeats', () => {
    for (const type of ['email', 'emailTemplate', 'image', 'document', 'audio']) {
      expect(normalizeDeleteSelection({ metadata: [`${type}:One`, `${type}:One`] })).to.deep.equal([
        { contentType: `sfdc_cms__${type}`, kind: 'api-name', value: 'One' },
      ]);
    }
  });
  it('rejects absent, type-wide, empty, wildcard and unsupported routes before any org read', async () => {
    const invalid: DeleteSelectionFlags[] = [
      {},
      { metadata: [] },
      ...[
        'audio',
        'audio:',
        'audio:*',
        'audio:A?',
        'audio:[A]',
        'audio:A:B',
        'video:A',
        'brand:A',
        'sfdc_cms__brand:A',
        'audio:   ',
      ].map((value) => ({ metadata: [value] })),
      { 'content-type': ['brand'], 'content-key-or-id': [parentId] },
      { 'content-type': ['sfdc_cms__brand'], 'content-key-or-id': [parentId] },
      { 'content-type': ['audio'] },
      { 'content-type': ['audio'], 'content-key-or-id': ['*'] },
      { 'content-type': ['audio'], 'content-key-or-id': ['9Psaj00000J5oxJCAR'] },
      { metadata: ['audio:One'], 'content-type': ['audio'] },
    ];
    for (const selection of invalid) {
      const f = fixture();
      await failure(() => f.resolve(undefined, selection), 'Delete');
      expect(f.calls).to.deep.equal([]);
    }
  });
  it('auto-selects the sole observed locale with separate classification, status and version axes', async () => {
    const f = fixture([row(0, { IsPublished: true, ManagedContentVariantStatus: 'Revised' })]);
    const result = await f.resolve();
    expect(result.inventory).to.deep.equal({ complete: true, recordCount: 1, pagesRequested: 6 });
    expect(result.items[0].requiresLanguageSelection).to.equal(false);
    expect(result.items[0].selected[0]).to.include({
      contentId: parentId,
      variantId: row().Id,
      contentType: 'sfdc_cms__audio',
      language: 'en_US',
      variantType: 'Content',
      isPublished: true,
      status: 'Revised',
    });
    expect(result.items[0].selected[0].version).to.deep.equal({
      managedContentVersionId: '5OUaj00000FaO1aEAF',
      contentVersion: 2,
      variantVersion: 3,
    });
    expect(decodeURIComponent(f.calls[0])).to.include('Language, VariantType');
  });
  it('binds native IDs for every admitted family and resolves repeated exact members once', async () => {
    for (const type of ['email', 'emailTemplate', 'image', 'document', 'audio'] as const) {
      const f = fixture([row(0, { ContentTypeFullyQualifiedName: `sfdc_cms__${type}` })]);
      const result = await f.resolve(undefined, {
        metadata: [`${type}:Exact_Name`, `${type}:Exact_Name`],
      });
      expect(result.items[0].selected[0].contentType).to.equal(`sfdc_cms__${type}`);
      expect(f.calls).to.have.length(7);
    }
  });
  it('supports classified Translation without assuming configuration creates a locale', async () => {
    const rows = [row(), row(1, { Language: 'de', VariantType: 'Translation', IsPrimary: false })];
    const choice = await fixture(rows).resolve();
    expect(choice.items[0].requiresLanguageSelection).to.equal(true);
    expect(choice.items[0].selected).to.deep.equal([]);
    expect(choice.items[0].available.map((target) => target.language)).to.deep.equal([
      'en_US',
      'de',
    ]);
    const subset = await fixture(rows).resolve(['de']);
    expect(subset.items[0].selected.map((target) => target.variantId)).to.deep.equal([rows[1].Id]);
    const all = await fixture(rows).resolve(['*']);
    expect(all.items[0].selected).to.have.length(2);
    await failure(() => fixture().resolve(['de']), 'requested locale is missing');
  });
  it('resolves only exact parent/key matches and deduplicates overlapping selectors', async () => {
    for (const value of [parentId, 'MCKEY']) {
      const result = await fixture().resolve(undefined, {
        'content-type': ['audio'],
        'content-key-or-id': [value, value],
      });
      expect(result.items).to.have.length(1);
    }
    await failure(
      () => fixture().resolve(undefined, { metadata: ['audio:Display name'] }),
      'missing',
    );
    const other = row(1, { ManagedContentId: '20Yaj00000FaDZBEA3' });
    await failure(() => fixture([row(), other]).resolve(), 'ambiguous');
    const result = await fixture([row(), other]).resolve(['*'], {
      'content-type': ['audio'],
      'content-key-or-id': [parentId],
    });
    expect(result.items).to.have.length(1);
    expect(result.items[0].selected).to.have.length(1);
  });
  it('blocks the entire exact item for duplicate locales, Variation or unknown classification with candidate evidence', async () => {
    for (const classification of ['Content', 'Variation', 'Future', undefined]) {
      const rows = [row(), row(1, { VariantType: classification })];
      const f = fixture(rows);
      await failure(
        () => f.resolve(['en_US']),
        `${rows[1].Id}/${classification ?? 'unknown'}/en_US`,
      );
      expect(f.calls).to.have.length(6);
    }
  });
  it('does not silently ignore an unsupported different-locale sibling', async () => {
    await failure(
      () =>
        fixture([row(), row(1, { Language: 'de', VariantType: 'Variation' })]).resolve(['en_US']),
      'unsupported or unknown',
    );
  });
  it('rejects malformed language subsets before org access', async () => {
    for (const languages of [[], [''], ['*', 'de'], ['d?'], ['[de]']]) {
      const f = fixture();
      await failure(() => f.resolve(languages), 'Delete language');
      expect(f.calls).to.deep.equal([]);
    }
  });
  it('requires native GET parent/variant/family/workspace/locale/status identity binding', async () => {
    for (const [key, value] of Object.entries({
      managedContentId: 'other',
      managedContentVariantId: 'other',
      contentType: 'sfdc_cms__image',
      contentSpace: { id: 'other' },
      language: 'de',
      apiName: 'Other',
      isPublished: true,
      status: { status: 'Published' },
      variantType: 'Variation',
    })) {
      const f = fixture();
      f.details.get(row().Id)![key] = value;
      await failure(() => f.resolve(), 'disagreement');
    }
  });
  it('retains only separately typed observed version evidence', async () => {
    for (const [key, value] of Object.entries({
      managedContentVersionId: '',
      contentVersion: '1.2',
      variantVersion: -1,
      versionNumber: 3,
    })) {
      const f = fixture();
      f.details.get(row().Id)![key] = value;
      await failure(() => f.resolve(), 'malformed version');
    }
    const f = fixture();
    const detail = f.details.get(row().Id)!;
    delete detail.managedContentVersionId;
    delete detail.contentVersion;
    detail.variantVersion = null;
    detail.versionNumber = '1.2';
    const result = await f.resolve();
    expect(result.items[0].selected[0].version).to.deep.equal({
      versionNumber: '1.2',
    });
  });
});
