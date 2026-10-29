import { expect } from 'chai';
import { randomUUID } from 'node:crypto';
import sinon from 'sinon';
import { Connection as JsforceConnection } from '@jsforce/jsforce-node';
import type { Connection } from '@salesforce/core';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { prepareEmailFragmentUpdate } from '../../src/services/deploy-email-fragment-update-preflight.js';
import type { EmailFragmentSourceDefinition } from '../../src/contracts/email-fragment-source.js';

export type RecordValue = Record<string, unknown>;
export const workspaceId = '0Zu000000000001AAA';
export const contentId = '20Y000000000001AAA';
export const variantId = '9Ps000000000001AAA';
export async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'cms-fragment-update-'));
  await writeFile(path.join(root, '.sf-cms-run-owner'), randomUUID(), { flag: 'wx' });
  const file = path.join(root, 'Welcome.cms-email-fragment.json');
  const reportFile = path.join(root, 'intent.json');
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
      'sfdc_cms:title': 'Edited body title',
      'lightning:brandSource': { defaultBrandOption: 'sfdcBrand' },
      'lightning:dataProviders': [
        {
          definition: 'sfdc_cms__dataGraphDataProvider',
          sfdcExpressionKey: '$dataGraph',
          attributes: { dataGraphApiName: 'Marketing', dataspace: 'default' },
        },
      ],
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
            attributes: { text: 'Full authored <p> & body' },
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
  const rows: RecordValue[] = [
    {
      Id: variantId,
      ManagedContentId: contentId,
      ContentTypeFullyQualifiedName: definition.contentType,
      Language: 'en_US',
      VariantType: 'Content',
      IsPublished: false,
      ManagedContentVariantStatus: 'Draft',
      IsPrimary: true,
      Name: 'Envelope',
      UrlName: 'envelope',
      ManagedContentKey: 'MCWELCOME',
      ManagedContent: { AuthoredManagedContentSpaceId: workspaceId, ApiName: 'Welcome' },
    },
  ];
  const detail: RecordValue = {
    managedContentVariantId: variantId,
    managedContentId: contentId,
    contentKey: 'MCWELCOME',
    contentSpace: { id: workspaceId },
    apiName: 'Welcome',
    language: 'en_US',
    contentType: { fullyQualifiedName: definition.contentType },
    title: 'Envelope',
    urlName: 'envelope',
    folder: null,
    isPublished: false,
    status: { status: 'Draft', label: 'Draft' },
    contentBody: structuredClone(definition.contentBody),
  };
  (detail.contentBody as RecordValue)['sfdc_cms:title'] = 'Old body';
  const parent = structuredClone(detail);
  delete parent.managedContentVariantId;
  delete parent.language;
  delete parent.contentBody;
  const response: RecordValue = {
    managedContentId: contentId,
    managedContentVariantId: variantId,
    language: 'en_US',
    isPublished: false,
    contentBody: structuredClone(definition.contentBody),
  };
  const folders: Record<string, RecordValue> = {};
  const calls: Array<{ method: string; url: string; body?: string }> = [];
  let onRequest: ((method: string, url: string) => void | Promise<void>) | undefined;
  let mutationError: Error | undefined;
  let orgId = '00D000000000001AAA';
  let apiVersion = '67.0';
  const connection = {
    accessToken: 'test-token',
    instanceUrl: 'https://example.invalid',
    version: '67.0',
    getApiVersion: () => apiVersion,
    getAuthInfoFields: () => ({ orgId }),
    request(input: { method: string; url: string; body?: string }, options?: unknown) {
      calls.push(structuredClone(input));
      const promise = (async () => {
        if (input.method !== 'GET') {
          expect(input.method).to.equal('PUT');
          expect(input.url).to.include(`/variants/${variantId}`);
          expect(options).to.have.nested.property('retry.maxRetries', 0);
          expect(this).to.have.property('_refreshDelegate', undefined);
          const body = JSON.parse(input.body!) as RecordValue;
          Object.assign(detail, structuredClone(body));
          // Native UPDATE couples ordinary authored title to both envelopes, not stale metadata.
          const authoredTitle = (body.contentBody as RecordValue)['sfdc_cms:title'];
          detail.title = typeof authoredTitle === 'string' ? authoredTitle : body.title;
          parent.title = detail.title;
          parent.urlName = body.urlName;
          rows[0].Name = detail.title;
          rows[0].UrlName = body.urlName;
        }
        await onRequest?.(input.method, input.url);
        if (input.method !== 'GET') {
          if (mutationError) throw mutationError;
          return structuredClone(response);
        }
        const url = new URL(input.url, 'https://example.invalid');
        if (url.pathname === `/connect/cms/spaces/${workspaceId}`)
          return structuredClone(workspace);
        if (url.pathname.startsWith('/connect/cms/folders/'))
          return structuredClone(folders[url.pathname.split('/').at(-1)!]);
        if (url.pathname.includes('/ssot/data-graphs/')) return structuredClone(graph);
        if (url.pathname.includes('/connect/cms/contents/'))
          return structuredClone(url.pathname.includes('/variants/') ? detail : parent);
        if (url.pathname === '/services/data/v67.0/query') {
          const soql = url.searchParams.get('q')!;
          const parentFilter = /ManagedContentId = '([^']+)'/u.exec(soql)?.[1];
          const after = /Id > '([^']+)'/u.exec(soql)?.[1];
          const selected = rows.filter(
            (row) => !parentFilter || row.ManagedContentId === parentFilter,
          );
          const records = soql.includes('COUNT(Id)')
            ? selected
                .filter(
                  (row, index) =>
                    selected.findIndex(
                      (other) => other.ManagedContentId === row.ManagedContentId,
                    ) === index,
                )
                .map((row) => ({
                  ManagedContentId: row.ManagedContentId,
                  siblingCount: selected.filter(
                    (other) => other.ManagedContentId === row.ManagedContentId,
                  ).length,
                }))
            : selected.filter((row) => !after || String(row.Id) > after);
          return { done: true, totalSize: records.length, records };
        }
        throw new Error(`Unexpected request ${input.url}`);
      })();
      return Object.assign(promise, { stream: () => new PassThrough() });
    },
  } as unknown as Pick<Connection, 'request' | 'getApiVersion' | 'getAuthInfoFields'>;
  sinon.restore();
  sinon.stub(JsforceConnection.prototype, 'request').callsFake(connection.request as never);
  return {
    definition,
    folders,
    save,
    workspace,
    graph,
    rows,
    detail,
    parent,
    response,
    calls,
    connection,
    file,
    reportFile,
    onRequest(callback: typeof onRequest) {
      onRequest = callback;
    },
    failMutation(error: Error) {
      mutationError = error;
    },
    org(value: string) {
      orgId = value;
    },
    api(value: string) {
      apiVersion = value;
    },
    prepare: () => prepareEmailFragmentUpdate(connection, { definitionFile: file, workspaceId }),
  };
}
export async function failure(operation: Promise<unknown>, pattern: RegExp): Promise<void> {
  try {
    await operation;
  } catch (error) {
    expect((error as Error).message).to.match(pattern);
    return;
  }
  throw new Error('Expected rejection');
}

describe('internal Fragment UPDATE preparation', () => {
  afterEach(() => sinon.restore());
  it('preserves complete materialized body, structural IDs and independent exact baseline', async () => {
    const current = await fixture();
    const result = await current.prepare();
    expect(result.proposed).to.equal('update');
    expect(result.payload).to.deep.equal({
      apiName: 'Welcome',
      title: 'Edited body title',
      urlName: 'envelope',
      contentBody: current.definition.contentBody,
    });
    expect(result.baseline.parent).to.deep.equal(current.parent);
    expect(result.baseline.variant).to.deep.equal(current.detail);
    expect(result.destination.existing.evidence).to.deep.equal({ contentId, variantId });
    expect(result.envelope).to.deep.equal({
      sourceTitle: 'Envelope',
      effectiveTitle: 'Edited body title',
      derived: true,
    });
    expect(result.dataGraphs[0].validationStatus).to.equal('passed');
    expect(current.calls.every((call) => call.method === 'GET')).to.equal(true);
    (result.payload.contentBody as RecordValue)['sfdc_cms:title'] = 'detached';
    expect(result.destination.source.contentBody).to.deep.equal(current.definition.contentBody);
  });
  it('admits unchanged with unused enabled German and preserves absent optional body metadata', async () => {
    const current = await fixture();
    delete current.definition.contentBody['sfdc_cms:title'];
    await current.save();
    current.detail.contentBody = structuredClone(current.definition.contentBody);
    const result = await current.prepare();
    expect(result.proposed).to.equal('unchanged');
    expect(result.payload.contentBody).not.to.have.property('sfdc_cms:title');
  });
  it('rejects unsupported changed boundary or absent titles before mutation, but admits exact observed pairs', async () => {
    for (const title of ['Boundary ', ' Leading', '', 'Café', undefined]) {
      const current = await fixture();
      if (title === undefined) delete current.definition.contentBody['sfdc_cms:title'];
      else current.definition.contentBody['sfdc_cms:title'] = title;
      await current.save();
      await failure(current.prepare(), /Unsupported derived envelope/u);
      expect(current.calls.every((call) => call.method === 'GET')).to.equal(true);
      current.detail.contentBody = structuredClone(current.definition.contentBody);
      const unchanged = await current.prepare();
      expect(unchanged.proposed).to.equal('unchanged');
    }
  });
  it('requires explicit CREATE for absence and blocks collisions, extra variants and published state', async () => {
    for (const change of ['missing', 'collision', 'siblings', 'published', 'root', 'org']) {
      const current = await fixture();
      if (change === 'missing') current.rows.length = 0;
      if (change === 'collision')
        current.rows.push({
          ...current.rows[0],
          Id: '9Ps000000000002AAA',
          ManagedContentId: '20Y000000000002AAA',
          ManagedContentKey: 'MCOTHER',
          ManagedContent: { AuthoredManagedContentSpaceId: workspaceId, ApiName: 'Other' },
        });
      if (change === 'siblings')
        current.rows.push({
          ...current.rows[0],
          Id: '9Ps000000000002AAA',
          Language: 'de',
          IsPrimary: false,
        });
      if (change === 'published') current.rows[0].IsPublished = true;
      if (change === 'root') current.workspace.rootFolderId = workspaceId;
      if (change === 'org') current.org('bad');
      await failure(
        current.prepare(),
        /CREATE required|collision|exactly one default|unpublished|root evidence|exact destination org/u,
      );
      expect(current.calls.every((call) => call.method === 'GET')).to.equal(true);
    }
  });
  it('blocks nonroot and unresolved references/provider identities without widening the contract', async () => {
    for (const change of ['folder', 'reference', 'brand', 'provider', 'expression']) {
      const current = await fixture();
      if (change === 'folder') current.definition.folderPath = ['Nested'];
      if (change === 'reference')
        current.definition.contentBody.custom = { ref: { contentKey: 'OTHER' } };
      if (change === 'brand')
        current.definition.contentBody['lightning:brandSource'] = { contentKey: 'OTHER' };
      if (change === 'provider') current.graph.status = 'Building';
      if (change === 'expression')
        current.definition.contentBody['lightning:expressions'] = ['{!$missing.Name}'];
      await current.save();
      await failure(
        current.prepare(),
        /requires numeric CMS API 68.0|reference|portable.*leak|prerequisite/u,
      );
    }
  });
});
