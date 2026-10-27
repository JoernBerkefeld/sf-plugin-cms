import { expect } from 'chai';
import type { Connection } from '@salesforce/core';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { prepareEmailFragmentCreate } from '../../src/services/deploy-email-fragment-create-preflight.js';
import type { EmailFragmentSourceDefinition } from '../../src/contracts/email-fragment-source.js';

type RecordValue = Record<string, unknown>;
const workspaceId = '0Zu000000000001AAA';
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'cms-fragment-create-'));
  const file = path.join(root, 'Welcome.cms-email-fragment.json');
  const definition: EmailFragmentSourceDefinition = {
    contract: 'sf-cms-email-fragment-source',
    contractVersion: '1.0.0',
    identity: {
      family: 'cms',
      type: 'Email Fragment',
      apiName: 'Welcome',
      context: { workspaceApiName: 'Source' },
    },
    contentType: 'sfdc_cms__emailFragment',
    language: 'en_US',
    title: 'Envelope',
    urlName: 'envelope',
    folderPath: [],
    contentBody: {
      'sfdc_cms:title': 'Envelope ',
      'lightning:brandSource': { defaultBrandOption: 'sfdcBrand' },
      'lightning:dataProviders': [
        {
          definition: 'sfdc_cms__dataGraphDataProvider',
          sfdcExpressionKey: '$dataGraph',
          attributes: { dataGraphApiName: 'Marketing', dataspace: 'default' },
        },
      ],
      'lightning:padding': '{!$brand.spacing.none}',
      'lightning:expressions': ['{!$dataGraph.Person.Name}'],
      'sfdc_cms:attachments': [],
      'sfdc_cms:variants': [],
      'lightning:backgroundImage': {
        repeat: 'no-repeat',
        position: 'center center',
        size: 'cover',
      },
      'sfdc_cms:block': {
        type: 'block',
        definition: 'sfdc_cms/rootContentBlock',
        id: '10000000-0000-4000-8000-000000000001',
        children: [
          {
            type: 'block',
            definition: 'lightning/section',
            id: '10000000-0000-4000-8000-000000000002',
            attributes: { reverseOrderOnMobile: false },
            children: [],
          },
          {
            type: 'block',
            definition: 'lightning/text',
            id: '10000000-0000-4000-8000-000000000003',
            attributes: { text: 'Entire authored body' },
          },
        ],
      },
    },
  };
  const save = () => writeFile(file, JSON.stringify(definition));
  await save();
  const workspace: RecordValue = {
    id: workspaceId,
    apiName: 'Destination',
    defaultLanguage: 'en_US',
    languages: ['en_US', 'de'],
    rootFolderId: '9Pu000000000001AAA',
    spaceType: { apiName: 'Marketing' },
  };
  const graph: RecordValue = { name: 'Marketing', dataspaceName: 'default', status: 'Ready' };
  const rows: RecordValue[] = [];
  const calls: string[] = [];
  let onRead: ((url: string) => void | Promise<void>) | undefined;
  let orgId = '00D000000000001AAA';
  const connection = {
    getApiVersion: () => '67.0',
    getAuthInfoFields: () => ({ orgId }),
    request(input: { method: string; url: string }) {
      expect(input.method).to.equal('GET');
      calls.push(input.url);
      const response = (async () => {
        await onRead?.(input.url);
        const url = new URL(input.url, 'https://example.invalid');
        if (url.pathname === `/connect/cms/spaces/${workspaceId}`)
          return structuredClone(workspace);
        if (url.pathname.includes('/ssot/data-graphs/')) return structuredClone(graph);
        if (url.pathname.startsWith('/connect/cms/contents/'))
          return {
            managedContentVariantId: '9Ps000000000001AAA',
            managedContentId: '20Y000000000001AAA',
            contentKey: 'MCWELCOME',
            contentSpace: { id: workspaceId },
            apiName: 'Welcome',
            language: 'en_US',
            contentType: { fullyQualifiedName: definition.contentType },
            title: definition.title,
            urlName: definition.urlName,
            folder: null,
            isPublished: false,
            status: { status: 'Draft', label: 'Draft' },
            contentBody: structuredClone(definition.contentBody),
          };
        if (url.pathname === '/services/data/v67.0/query') {
          const soql = url.searchParams.get('q')!;
          const after = /Id > '([^']+)'/u.exec(soql)?.[1];
          const records = soql.includes('COUNT(Id)')
            ? rows
                .filter(
                  (row, index) =>
                    rows.findIndex((other) => other.ManagedContentId === row.ManagedContentId) ===
                    index,
                )
                .map((row) => ({
                  ManagedContentId: row.ManagedContentId,
                  siblingCount: rows.filter(
                    (other) => other.ManagedContentId === row.ManagedContentId,
                  ).length,
                }))
            : rows.filter((row) => !after || String(row.Id) > after);
          return { done: true, totalSize: records.length, records };
        }
        throw new Error(`Unexpected read ${input.url}`);
      })();
      return Object.assign(response, { stream: () => new PassThrough() });
    },
  } as unknown as Pick<Connection, 'request' | 'getApiVersion' | 'getAuthInfoFields'>;
  return {
    definition,
    save,
    workspace,
    graph,
    rows,
    calls,
    connection,
    onRead(callback: (url: string) => void | Promise<void>) {
      onRead = callback;
    },
    org(value: string) {
      orgId = value;
    },
    prepare: () => prepareEmailFragmentCreate(connection, { definitionFile: file, workspaceId }),
  };
}
async function failure(operation: Promise<unknown>, pattern: RegExp): Promise<void> {
  try {
    await operation;
  } catch (error) {
    expect((error as Error).message).to.match(pattern);
    return;
  }
  throw new Error('Expected rejection');
}
function row(apiName = 'Welcome'): RecordValue {
  return {
    Id: '9Ps000000000001AAA',
    ManagedContentId: '20Y000000000001AAA',
    ContentTypeFullyQualifiedName: 'sfdc_cms__emailFragment',
    Language: 'en_US',
    VariantType: 'Content',
    IsPublished: false,
    ManagedContentVariantStatus: 'Draft',
    IsPrimary: true,
    Name: 'Envelope',
    UrlName: 'envelope',
    ManagedContentKey: 'MCWELCOME',
    ManagedContent: { AuthoredManagedContentSpaceId: workspaceId, ApiName: apiName },
  };
}
describe('internal Fragment CREATE preparation', () => {
  it('preserves the full materialized body and binds absent target, root, org and provider with no writes', async () => {
    const current = await fixture();
    const result = await current.prepare();
    expect(result.payload).to.deep.equal({
      contentSpaceOrFolderId: current.workspace.rootFolderId,
      contentType: current.definition.contentType,
      apiName: 'Welcome',
      title: 'Envelope',
      urlName: 'envelope',
      contentBody: current.definition.contentBody,
    });
    expect(result.orgId).to.equal('00D000000000001AAA');
    expect(result.apiVersion).to.equal('67.0');
    expect(result.qualification).to.equal('unqualified');
    expect(result.destination.inventory.complete).to.equal(true);
    expect(result.destination.existing).to.equal(undefined);
    expect(result.dataGraphs[0].validationStatus).to.equal('passed');
    expect(current.calls.filter((url) => url.includes('/ssot/'))).to.have.length(2);
    result.payload.contentBody!['sfdc_cms:title'] = 'mutated';
    expect(result.destination.source.contentBody).to.deep.equal(current.definition.contentBody);
    result.destination.source.contentBody['sfdc_cms:title'] = 'other';
    expect(result.destination.source.definition.contentBody).to.deep.equal(
      current.definition.contentBody,
    );
    expect(current.graph).not.to.have.property('validationEvidence');
  });
  it('blocks absent authored title for CREATE without inventing an envelope fallback', async () => {
    const current = await fixture();
    delete current.definition.contentBody['sfdc_cms:title'];
    delete current.definition.contentBody['lightning:padding'];
    delete current.definition.contentBody['lightning:brandSource'];
    current.definition.contentBody['lightning:expressions'] = [];
    current.definition.contentBody['lightning:dataProviders'] = [];
    await current.save();
    await failure(current.prepare(), /Unsupported derived envelope/u);
  });
  it('requires a missing target and exact connection identity', async () => {
    const current = await fixture();
    current.rows.push(row());
    const existing = await current.prepare();
    expect(existing.proposed).to.equal('unchanged');
    const invalid = await fixture();
    invalid.org('bad');
    await failure(invalid.prepare(), /exact destination org/u);
    expect(invalid.calls).to.deep.equal([]);
  });
  it('supports independently named providers without sample-derived graph or layout restrictions', async () => {
    const current = await fixture();
    const providers = current.definition.contentBody['lightning:dataProviders'] as Array<
      Record<string, unknown>
    >;
    providers[0].attributes = { dataGraphApiName: 'CustomGraph', dataspace: 'CustomSpace' };
    current.graph.name = 'CustomGraph';
    current.graph.dataspaceName = 'CustomSpace';
    await current.save();
    const result = await current.prepare();
    expect(result.dataGraphs[0].targetDeveloperName).to.equal('CustomGraph');
    expect(result.payload.contentBody).to.deep.equal(current.definition.contentBody);
  });
  it('blocks nonroot paths rather than flattening them', async () => {
    const current = await fixture();
    current.definition.folderPath = ['Nested'];
    await current.save();
    await failure(current.prepare(), /nonroot folder destination resolution/u);
  });
  it('rejects missing, ambiguous or unsupported provider/reference dependencies', async () => {
    for (const patch of [
      { 'lightning:dataProviders': [] },
      { 'lightning:dataProviders': [{ definition: 'Other' }] },
      { 'lightning:brandSource': { contentKey: 'OTHER' } },
      { custom: { ref: { contentKey: 'OTHER' } } },
      { custom: { type: 'imageReference' } },
    ]) {
      const current = await fixture();
      Object.assign(current.definition.contentBody, patch);
      await current.save();
      await failure(current.prepare(), /prerequisite|reference|portable.*leak/u);
    }
    const current = await fixture();
    const providers = current.definition.contentBody['lightning:dataProviders'] as unknown[];
    providers.push(structuredClone(providers[0]));
    await current.save();
    await failure(current.prepare(), /ambiguous/u);
  });
  it('rejects unavailable, mismatched and unready graph evidence', async () => {
    for (const patch of [
      { name: 'Other' },
      { dataspaceName: 'Other' },
      { status: 'Building' },
      { name: undefined },
    ]) {
      const current = await fixture();
      Object.assign(current.graph, patch);
      await failure(current.prepare(), /prerequisite response did not qualify/u);
    }
    const current = await fixture();
    current.onRead((url) => {
      if (url.includes('/ssot/')) throw new Error('missing');
    });
    await failure(current.prepare(), /prerequisite request failed/u);
  });
  it('rejects collisions, additional actual variants and invalid root identity', async () => {
    const collision = await fixture();
    collision.rows.push(row('Other'));
    await failure(collision.prepare(), /collision/u);
    const siblings = await fixture();
    siblings.rows.push(row(), {
      ...row(),
      Id: '9Ps000000000002AAA',
      Language: 'de',
      IsPrimary: false,
    });
    await failure(siblings.prepare(), /exactly one default variant/u);
    const root = await fixture();
    root.workspace.rootFolderId = workspaceId;
    await failure(root.prepare(), /root evidence/u);
  });
  it('blocks source, destination, provider and org drift after dependency reads', async () => {
    for (const drift of ['source', 'workspace', 'graph', 'org']) {
      const current = await fixture();
      let reads = 0;
      current.onRead(async (url) => {
        if (!url.includes('/ssot/') || ++reads !== 2) return;
        if (drift === 'source') {
          current.definition.title = 'Changed';
          await current.save();
        }
        if (drift === 'workspace') current.workspace.rootFolderId = '9Pu000000000002AAA';
        if (drift === 'graph') current.graph.status = 'Active';
        if (drift === 'org') current.org('00D000000000002AAA');
      });
      await failure(current.prepare(), /changed during preparation/u);
    }
  });
});
