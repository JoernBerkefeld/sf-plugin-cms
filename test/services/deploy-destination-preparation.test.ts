import { expect } from 'chai';
import type { Connection } from '@salesforce/core';
import { PassThrough } from 'node:stream';
import {
  prepareDeployDestination,
  type DeployDestinationInput,
} from '../../src/services/deploy-destination-preparation.js';
import type { DeployLocalItem } from '../../src/services/deploy-source-selection.js';
import { extractEditableItemSourceV2 } from '../../src/services/editable-item-source-v2.js';

type RecordValue = Record<string, unknown>;
const workspaceId = '0Zu000000000001AAA';
const parentId = '20Y000000000001AAA';
const variantId = '9Ps000000000001AAA';
function local(template = false): DeployLocalItem {
  const definition = {
    contract: 'sf-cms-source-definition' as const,
    contractVersion: '1.0.0' as const,
    identity: {
      family: 'cms' as const,
      type: template ? 'Email Template' : 'Email',
      apiName: 'Welcome',
      context: { workspaceApiName: 'Different_Source_Workspace' },
    },
    contentType: template ? 'sfdc_cms__emailTemplate' : 'sfdc_cms__email',
    language: 'en_US',
    title: 'Welcome',
    folderPath: [],
    contentBody: {
      'sfdc_cms:title': 'Welcome',
      messagePurpose: 'Transactional',
      textContent: 'Text\n',
      ...(template ? {} : { subjectLine: 'Hello' }),
    },
    companions: { rawHtml: `Welcome.cms-${template ? 'email-template' : 'email'}.html` },
  };
  return {
    definition,
    definitionPath: 'local.json',
    companionPaths: ['local.html'],
    contentBody: { ...definition.contentBody, rawHtml: '<p>Original &amp; text</p>' },
    targetIdentity: { contentType: definition.contentType, apiName: 'Welcome', language: 'en_US' },
  };
}
function unchangedRows(rows: RecordValue[]): RecordValue[] {
  return rows;
}
function fixture(template = false) {
  const source = local(template);
  const workspace: RecordValue = {
    id: workspaceId,
    apiName: 'Destination',
    defaultLanguage: 'en_US',
    rootFolderId: 'root',
    spaceType: { apiName: 'Marketing' },
  };
  const variants: RecordValue[] = [
    {
      managedContentVariantId: variantId,
      managedContentId: parentId,
      contentKey: 'MCWELCOME',
      contentSpace: { id: workspaceId },
      apiName: 'Welcome',
      language: 'en_US',
      contentType: { fullyQualifiedName: source.definition.contentType },
      title: 'Welcome',
      folder: null,
      isPublished: false,
      status: { status: 'Draft', label: 'Draft' },
      contentBody: { ...source.contentBody, rawHtml: '&lt;p&gt;Original &amp;amp; text&lt;/p&gt;' },
    },
  ];
  const parent: RecordValue = {
    managedContentId: parentId,
    contentSpace: { id: workspaceId },
    contentType: { fullyQualifiedName: source.definition.contentType },
    folder: null,
  };
  const calls: { method: string; url: string }[] = [];
  let nativePatch: (rows: RecordValue[], sibling: boolean) => RecordValue[] = unchangedRows;
  const connection = {
    getApiVersion: () => '67.0',
    request(input: { method: string; url: string }) {
      calls.push(input);
      expect(input.method).to.equal('GET');
      const url = new URL(input.url, 'https://example.invalid');
      let value: unknown;
      switch (url.pathname) {
        case `/connect/cms/spaces/${workspaceId}`: {
          value = workspace;
          break;
        }
        case '/services/data/v67.0/query': {
          const soql = url.searchParams.get('q')!;
          const sibling = soql.includes('WHERE ManagedContentId =');
          const types = /ContentTypeFullyQualifiedName IN \(([^)]+)\)/u.exec(soql)?.[1];
          const rows = nativePatch(
            variants
              .map((detail) => ({
                Id: detail.managedContentVariantId,
                ManagedContentId: detail.managedContentId,
                ContentTypeFullyQualifiedName: (detail.contentType as RecordValue)
                  .fullyQualifiedName,
                Language: detail.language,
                IsPublished: detail.isPublished,
                ManagedContentVariantStatus: (detail.status as RecordValue).status,
                IsPrimary: true,
                Name: detail.title,
                UrlName: detail.urlName ?? null,
                ManagedContentKey: detail.contentKey,
                ManagedContent: {
                  AuthoredManagedContentSpaceId: workspaceId,
                  ApiName: detail.apiName,
                },
              }))
              .filter(
                (row) => !types || types.includes(`'${String(row.ContentTypeFullyQualifiedName)}'`),
              ),
            sibling,
          );
          let records: RecordValue[];
          if (soql.includes('COUNT(Id)')) {
            const groups = new Map<unknown, number>();
            for (const row of rows)
              groups.set(row.ManagedContentId, (groups.get(row.ManagedContentId) ?? 0) + 1);
            records = [...groups].map(([ManagedContentId, siblingCount]) => ({
              ManagedContentId,
              siblingCount,
            }));
          } else {
            const after = /Id > '([^']+)'/u.exec(soql)?.[1];
            records = rows.filter((row) => !after || String(row.Id) > after);
          }
          value = { records, totalSize: records.length, done: true };

          break;
        }
        case `/connect/cms/contents/variants/${variantId}`: {
          value = variants[0];
          break;
        }
        case `/connect/cms/contents/${parentId}`: {
          value = parent;
          break;
        }
        default: {
          throw new Error(`Unexpected request ${input.url}`);
        }
      }
      return Object.assign(Promise.resolve(structuredClone(value)), {
        stream: () => new PassThrough(),
      });
    },
  } as unknown as Pick<Connection, 'request' | 'getApiVersion'>;
  const input: DeployDestinationInput = {
    workspaceId,
    language: 'en_US',
    selection: { mode: 'definition-file', items: [source] },
  };
  return {
    source,
    workspace,
    variants,
    parent,
    calls,
    input,
    patch(callback: typeof nativePatch) {
      nativePatch = callback;
    },
    run: () => prepareDeployDestination(connection, input),
  };
}

describe('read-only deploy destination preparation', () => {
  for (const template of [false, true]) {
    it(`resolves exact ${template ? 'Template' : 'Email'} with portable source context and unchanged semantics`, async () => {
      const f = fixture(template);
      const result = await f.run();
      expect(result.blockedReasons).to.deep.equal([]);
      expect(result.items[0].blockedReasons).to.deep.equal([]);
      expect(result.items[0].proposed).to.equal('unchanged');
      expect(result.items[0].qualification).to.equal('unqualified');
      expect(result.items[0].existing?.variantId).to.equal(variantId);
      expect(result.inventory?.scope).to.equal(
        'principal-visible-nondeleted-workspace-all-types-languages-statuses',
      );
      const firstQuery = f.calls.find((call) => call.url.includes('/query?'))!;
      expect(decodeURIComponent(firstQuery.url)).not.to.include('ContentTypeFullyQualifiedName IN');
      expect(f.calls.every((call) => call.method === 'GET')).to.equal(true);
    });
    it(`proposes an unqualified rawHtml-only ${template ? 'Template' : 'Email'} update`, async () => {
      const f = fixture(template);
      f.source.contentBody.rawHtml = '<p>Changed &amp; literal</p>';
      const result = await f.run();
      expect(result.items[0].proposed).to.equal('update');
      expect(result.items[0].changedFields).to.deep.equal(['contentBody.rawHtml']);
      expect(result.items[0].qualification).to.equal('unqualified');
    });
  }
  it('proposes create only after an empty unfiltered terminal/count/repeat inventory', async () => {
    const f = fixture();
    f.variants.length = 0;
    const result = await f.run();
    expect(result.items[0].proposed).to.equal('create');
    expect(result.items[0].qualification).to.equal('unqualified');
    expect(result.inventory).to.include({ complete: true, recordCount: 0, pagesRequested: 4 });
    expect(f.calls).to.have.length(5);
  });
  it('proves absence across unrelated types, languages and statuses without narrowing queries', async () => {
    const f = fixture();
    Object.assign(f.variants[0], {
      apiName: 'Unrelated',
      language: 'de',
      isPublished: true,
      status: { status: 'Published' },
      contentType: { fullyQualifiedName: 'sfdc_cms__other' },
    });
    const result = await f.run();
    expect(result.items[0].proposed).to.equal('create');
    expect(result.inventory?.recordCount).to.equal(1);
    for (const call of f.calls.filter((value) => value.url.includes('/query?'))) {
      const predicate = decodeURIComponent(call.url).split(' WHERE ')[1];
      expect(predicate).not.to.match(
        /ContentTypeFullyQualifiedName|Language|IsPublished|ManagedContentVariantStatus/u,
      );
    }
  });
  it('blocks existing same-name parents in other types, languages and statuses', async () => {
    for (const patch of [
      { contentType: { fullyQualifiedName: 'sfdc_cms__other' } },
      { language: 'de' },
      { status: { status: 'Published' }, isPublished: true },
    ]) {
      const f = fixture();
      Object.assign(f.variants[0], patch);
      const result = await f.run();
      expect(result.items[0].proposed).to.equal('blocked');
      expect(result.items[0].blockedReasons).not.to.have.length(0);
    }
  });
  it('blocks duplicate native parent identities, not merely exact-language matches', async () => {
    const f = fixture();
    f.variants.push({
      ...structuredClone(f.variants[0]),
      managedContentVariantId: '9Ps000000000002AAA',
      managedContentId: '20Y000000000002AAA',
      language: 'de',
    });
    const result = await f.run();
    expect(result.items[0].proposed).to.equal('blocked');
  });
  it('blocks unknown API-name absence and incomplete inventory without making proposals', async () => {
    const unknown = fixture();
    unknown.variants[0].apiName = null;
    const unknownResult = await unknown.run();
    expect(unknownResult.items[0].blockedReasons[0]).to.include('absence is unproven');
    const incomplete = fixture();
    incomplete.patch((rows) => rows.map((row) => ({ ...row, Language: null })));
    const result = await incomplete.run();
    expect(result.blockedReasons).not.to.have.length(0);
    expect(result.items).to.deep.equal([]);
    expect(result.inventory).to.equal(undefined);
  });
  it('retains and blocks text/JSON/top-level edits rather than dropping them', async () => {
    for (const field of ['textContent', 'subjectLine', 'messagePurpose', 'title', 'urlName']) {
      const f = fixture();
      if (field === 'title' || field === 'urlName') f.source.definition[field] = 'Changed';
      else {
        f.source.definition.contentBody[field] = 'Changed';
        f.source.contentBody[field] = 'Changed';
      }
      f.source.contentBody.rawHtml = '<p>Also changed</p>';
      const result = await f.run();
      expect(result.items[0].proposed, field).to.equal('blocked');
      expect(result.items[0].changedFields).to.include(
        field === 'title' || field === 'urlName' ? field : `contentBody.${field}`,
      );
      expect(result.items[0].desired.contentBody.rawHtml).to.equal('<p>Also changed</p>');
      expect(result.items[0].blockedReasons[0]).to.include('Unsupported update fields');
    }
  });
  it('compares reassembled v2 text as authoritative and does not decode local HTML', async () => {
    const f = fixture();
    const projection = extractEditableItemSourceV2(
      f.source.definition as Parameters<typeof extractEditableItemSourceV2>[0],
      f.source.contentBody.rawHtml as string,
    );
    f.source.definition = projection.definition;
    f.source.contentBody.textContent = 'Changed text';
    const result = await f.run();
    expect(result.items[0].proposed).to.equal('blocked');
    expect(result.items[0].changedFields).to.deep.equal(['contentBody.textContent']);
  });
  it('blocks fresh parent/detail/sibling disagreement and unsupported destination envelopes', async () => {
    for (const mutate of [
      (f: ReturnType<typeof fixture>) => {
        f.parent.contentSpace = { id: '0Zu000000000002AAA' };
      },
      (f: ReturnType<typeof fixture>) => {
        f.variants[0].unknownField = 'must not disappear';
      },
      (f: ReturnType<typeof fixture>) => {
        f.patch((rows, sibling) => (sibling ? [] : rows));
      },
      (f: ReturnType<typeof fixture>) => {
        f.patch((rows) => rows.map((row) => ({ ...row, ManagedContentKey: 'DIFFERENT' })));
      },
    ]) {
      const f = fixture();
      mutate(f);
      const result = await f.run();
      expect(result.items[0].proposed).to.equal('blocked');
      expect(result.items[0].blockedReasons).not.to.have.length(0);
    }
  });
  it('blocks wrong workspace context, source-language mismatches and non-root placement', async () => {
    for (const mutate of [
      (f: ReturnType<typeof fixture>) => {
        f.workspace.id = '0Zu000000000002AAA';
      },
      (f: ReturnType<typeof fixture>) => {
        f.workspace.spaceType = { apiName: 'Content' };
      },
      (f: ReturnType<typeof fixture>) => {
        f.input.language = 'de';
      },
      (f: ReturnType<typeof fixture>) => {
        f.source.definition.folderPath = ['Nested'];
      },
    ]) {
      const f = fixture();
      mutate(f);
      const result = await f.run();
      expect(
        result.blockedReasons.length + result.items.flatMap((item) => item.blockedReasons).length,
      ).to.be.greaterThan(0);
      expect(result.items.some((item) => item.proposed === 'create')).to.equal(false);
    }
  });
  it('rejects empty selections and colliding parent names before org reads', async () => {
    for (const empty of [true, false]) {
      const f = fixture();
      f.input.selection.items = empty ? [] : [f.source, local(true)];
      const result = await f.run();
      expect(result.blockedReasons).not.to.have.length(0);
      expect(f.calls).to.have.length(0);
    }
  });
  it('blocks lifecycle drift after native enumeration even if body and identity remain stable', async () => {
    const f = fixture();
    // Last sibling count completes the strict acquisition before the final fresh detail.
    let siblingQueries = 0;
    f.patch((rows, sibling) => {
      if (sibling && ++siblingQueries === 6)
        f.variants[0].status = { status: 'Published', label: 'Published' };
      return rows;
    });
    const result = await f.run();
    expect(result.items[0].proposed).to.equal('blocked');
    expect(result.items[0].blockedReasons[0]).to.match(/lifecycle changed|metadata disagreement/u);
  });
  it('snapshots input before awaiting destination reads', async () => {
    const f = fixture();
    const pending = f.run();
    f.source.contentBody.rawHtml = '<p>Caller changed</p>';
    f.input.workspaceId = '0Zu000000000002AAA';
    const result = await pending;
    expect(result.items[0].proposed).to.equal('unchanged');
    expect(result.workspaceId).to.equal(workspaceId);
  });
});
