import { expect } from 'chai';
import type { Connection } from '@salesforce/core';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { executeEmailFragmentCreate } from '../../src/services/deploy-email-fragment-create.js';
import type { WorkspaceImportRunReport } from '../../src/services/import-workspace.js';
import type { EmailFragmentSourceDefinition } from '../../src/contracts/email-fragment-source.js';

type RecordValue = Record<string, unknown>;
const workspaceId = '0Zu000000000001AAA';
const contentId = '20Y000000000001AAA';
const variantId = '9Ps000000000001AAA';
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'cms-fragment-execute-'));
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
      'sfdc_cms:title': 'Authored title ',
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
            attributes: { text: 'Full body <p> & text' },
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
  const native = () => ({
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
  });
  const rows: RecordValue[] = [];
  let detail: RecordValue | undefined;
  let parent: RecordValue | undefined;
  const install = () => {
    rows.push(native());
    detail = {
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
    parent = structuredClone(detail);
    delete parent.managedContentVariantId;
    delete parent.language;
    delete parent.contentBody;
  };
  const response: RecordValue = {
    managedContentId: contentId,
    managedContentVariantId: variantId,
    contentKey: 'MCWELCOME',
  };
  const calls: Array<{ method: string; url: string; body?: unknown }> = [];
  let onRequest: ((method: string, url: string) => void | Promise<void>) | undefined;
  let postError: Error | undefined;
  let orgId = '00D000000000001AAA';
  let apiVersion = '67.0';
  const connection = {
    getApiVersion: () => apiVersion,
    getAuthInfoFields: () => ({ orgId }),
    request(input: { method: string; url: string; body?: string }, options?: unknown) {
      calls.push(structuredClone(input));
      if (input.method === 'POST') {
        expect(options).to.have.nested.property('retry.maxRetries', 0);
        expect(this).to.have.property('_refreshDelegate', undefined);
      }
      const promise = (async () => {
        if (input.method === 'POST') install();
        await onRequest?.(input.method, input.url);
        if (input.method === 'POST') {
          if (postError) throw postError;
          return structuredClone(response);
        }
        expect(input.method).to.equal('GET');
        const url = new URL(input.url, 'https://example.invalid');
        if (url.pathname === `/connect/cms/spaces/${workspaceId}`)
          return structuredClone(workspace);
        if (url.pathname.includes('/ssot/data-graphs/')) return structuredClone(graph);
        if (url.pathname.includes('/connect/cms/contents/'))
          return structuredClone(url.pathname.includes('/variants/') ? detail : parent);
        if (url.pathname === '/services/data/v67.0/query') {
          const soql = url.searchParams.get('q')!;
          const after = /Id > '([^']+)'/u.exec(soql)?.[1];
          const parentFilter = /ManagedContentId = '([^']+)'/u.exec(soql)?.[1];
          const selectedRows = rows.filter(
            (row) => !parentFilter || row.ManagedContentId === parentFilter,
          );
          const records = soql.includes('COUNT(Id)')
            ? selectedRows
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
            : selectedRows.filter((row) => !after || String(row.Id) > after);
          return { done: true, totalSize: records.length, records };
        }
        throw new Error(`Unexpected request ${input.url}`);
      })();
      return Object.assign(promise, { stream: () => new PassThrough() });
    },
  } as unknown as Pick<Connection, 'request' | 'getApiVersion' | 'getAuthInfoFields'>;
  let report: WorkspaceImportRunReport | undefined;
  return {
    definition,
    save,
    workspace,
    graph,
    rows,
    response,
    calls,
    install,
    file,
    reportFile,
    get detail() {
      return detail!;
    },
    get parent() {
      return parent!;
    },
    get report() {
      return report!;
    },
    onRequest(callback: typeof onRequest) {
      onRequest = callback;
    },
    failPost(error: Error) {
      postError = error;
    },
    org(value: string) {
      orgId = value;
    },
    api(value: string) {
      apiVersion = value;
    },
    run: (persist = true, persistence?: Parameters<typeof executeEmailFragmentCreate>[3]) =>
      executeEmailFragmentCreate(
        connection,
        { definitionFile: file, workspaceId, ...(persist ? { reportFile } : {}) },
        {},
        persistence,
        (value) => {
          report = value;
        },
      ),
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
const posts = (current: Awaited<ReturnType<typeof fixture>>) =>
  current.calls.filter((call) => call.method !== 'GET');
describe('internal Fragment CREATE executor and unchanged', () => {
  it('POSTs once, records destination ownership and independently reads full Draft parent/variant/siblings', async () => {
    const current = await fixture();
    const result = await current.run();
    expect(result.outcome).to.equal('created');
    expect(result.qualification).to.equal('unqualified');
    expect(result.evidence).to.deep.equal({ contentId, variantId });
    expect(posts(current)).to.have.length(1);
    const body = JSON.parse(posts(current)[0].body as string) as RecordValue;
    expect(body.contentBody).to.deep.equal(current.definition.contentBody);
    expect(body).not.to.have.property('contentKey');
    expect(body.contentSpaceOrFolderId).to.equal(current.workspace.rootFolderId);
    expect(current.calls.some((call) => call.url.includes(`/contents/${contentId}`))).to.equal(
      true,
    );
    expect(current.calls.some((call) => call.url.includes(`/variants/${variantId}`))).to.equal(
      true,
    );
    expect(current.report.createdParents[0]).to.include({
      contentId,
      primaryVariantId: variantId,
      contentKey: 'MCWELCOME',
    });
    expect(current.report.operations[0].state).to.equal('succeeded');
    expect(JSON.parse(await readFile(current.reportFile, 'utf8'))).to.deep.equal(current.report);
    const before = posts(current).length;
    const repeat = await current.run();
    expect(repeat.outcome).to.equal('unchanged');
    expect(repeat.report).to.equal(undefined);
    expect(posts(current)).to.have.length(before);
  });
  it('admits identical destination-local identity with unused enabled German and no journal writes', async () => {
    const current = await fixture();
    current.install();
    await writeFile(current.reportFile, 'untouched');
    const existing = await current.run();
    expect(existing.outcome).to.equal('unchanged');
    expect(posts(current)).to.have.length(0);
    expect(await readFile(current.reportFile, 'utf8')).to.equal('untouched');
  });
  it('requires UPDATE for divergent authored body, structural IDs, envelope metadata or folder', async () => {
    for (const change of ['body', 'id', 'title', 'url', 'folder']) {
      const current = await fixture();
      current.install();
      if (change === 'body')
        (current.detail.contentBody as RecordValue)['sfdc_cms:title'] = 'different';
      if (change === 'id')
        ((current.detail.contentBody as RecordValue)['sfdc_cms:block'] as RecordValue).id =
          '10000000-0000-4000-8000-000000000099';
      if (change === 'title') {
        current.detail.title = 'Other';
        current.parent.title = 'Other';
        current.rows[0].Name = 'Other';
      }
      if (change === 'url') {
        current.detail.urlName = 'other';
        current.parent.urlName = 'other';
        current.rows[0].UrlName = 'other';
      }
      if (change === 'folder') {
        current.definition.folderPath = ['Nested'];
        await current.save();
      }
      await failure(current.run(), /UPDATE required|nonroot/u);
      expect(posts(current)).to.have.length(0);
    }
  });
  it('blocks provider, source, root, org and API drift after pending intent before POST', async () => {
    for (const change of ['provider', 'source', 'root', 'org', 'api']) {
      const current = await fixture();
      let graphs = 0;
      current.onRequest(async (_method, url) => {
        if (!url.includes('/ssot/') || ++graphs !== 3) return;
        if (change === 'provider') current.graph.status = 'Building';
        if (change === 'source') {
          current.definition.title = 'changed';
          await current.save();
        }
        if (change === 'root') current.workspace.rootFolderId = '9Pu000000000002AAA';
        if (change === 'org') current.org('00D000000000002AAA');
        if (change === 'api') current.api('66.0');
      });
      await failure(current.run(), /prerequisite|changed|drifted|Unexpected/u);
      expect(posts(current)).to.have.length(0);
      expect(current.report.state).to.equal('failed');
    }
  });
  it('blocks stale absence, collisions, extra variants and published targets without writes', async () => {
    for (const change of ['absence', 'collision', 'siblings', 'published']) {
      const current = await fixture();
      if (change !== 'absence') current.install();
      if (change === 'collision') (current.rows[0].ManagedContent as RecordValue).ApiName = 'Other';
      if (change === 'siblings')
        current.rows.push({
          ...current.rows[0],
          Id: '9Ps000000000002AAA',
          Language: 'de',
          IsPrimary: false,
        });
      if (change === 'published') current.rows[0].IsPublished = true;
      let graphs = 0;
      if (change === 'absence')
        current.onRequest((_method, url) => {
          if (url.includes('/ssot/') && ++graphs === 3) current.install();
        });
      await failure(current.run(), /collision|exactly one default|unpublished|changed|drifted/u);
      expect(posts(current)).to.have.length(0);
    }
  });
  it('retains returned IDs and uncertain journal for independently mismatched readback without replay', async () => {
    for (const change of ['body', 'parent', 'siblings', 'published', 'root', 'source', 'key']) {
      const current = await fixture();
      current.onRequest(async (method) => {
        if (method !== 'POST') return;
        if (change === 'body')
          (current.detail.contentBody as RecordValue)['sfdc_cms:title'] = 'server silently changed';
        if (change === 'parent') current.parent.managedContentId = '20Y000000000002AAA';
        if (change === 'siblings')
          current.rows.push({
            ...current.rows[0],
            Id: '9Ps000000000002AAA',
            Language: 'de',
            IsPrimary: false,
          });
        if (change === 'published') current.rows[0].IsPublished = true;
        if (change === 'root') current.workspace.rootFolderId = '9Pu000000000002AAA';
        if (change === 'source') {
          current.definition.title = 'changed';
          await current.save();
        }
        if (change === 'key') current.response.contentKey = 'OTHER';
      });
      await failure(current.run(), /readback|identity|Unsupported|unpublished|disagreement/u);
      expect(posts(current)).to.have.length(1);
      expect(current.report.state).to.equal('ownership-uncertain');
      expect(current.report.operations[0].result?.contentId).to.equal(contentId);
      expect(current.report.createdParents).to.have.length(0);
    }
  });
  it('never replays uncertain transport results and preserves durable pending intent', async () => {
    const current = await fixture();
    current.failPost(new Error('connection reset'));
    await failure(current.run(), /connection reset/u);
    expect(posts(current)).to.have.length(1);
    expect(current.report.state).to.equal('ownership-uncertain');
    expect(current.report.operations[0].state).to.equal('pending');
    expect(current.report.operations[0].result).to.equal(undefined);
    // A second invocation cannot overwrite the existing journal to retry CREATE.
    current.rows.length = 0;
    await failure(current.run(), /exist/u);
    expect(posts(current)).to.have.length(1);
  });
  it('captures malformed response identities without claiming ownership or repeating the POST', async () => {
    const current = await fixture();
    current.response.managedContentVariantId = 'bad';
    await failure(current.run(), /invalid native/u);
    expect(posts(current)).to.have.length(1);
    expect(current.report.operations[0].result?.primaryVariantId).to.equal('bad');
    expect(current.report.state).to.equal('ownership-uncertain');
  });
  it('does not write remotely when durable intent changes or cannot be persisted', async () => {
    for (const fail of [false, true]) {
      const current = await fixture();
      await failure(
        current.run(true, {
          rewrite: async (file) => {
            if (fail) throw new Error('disk unavailable');
            await writeFile(file, '{}');
          },
        }),
        /durable intent|disk unavailable/u,
      );
      expect(posts(current)).to.have.length(0);
    }
  });
  it('blocks unchanged when another destination parent collides with its title or URL', async () => {
    const current = await fixture();
    current.install();
    current.rows.push({
      ...current.rows[0],
      Id: '9Ps000000000002AAA',
      ManagedContentId: '20Y000000000002AAA',
      ManagedContentKey: 'MCOTHER',
      ManagedContent: { AuthoredManagedContentSpaceId: workspaceId, ApiName: 'Other' },
    });
    await failure(current.run(), /collision/u);
    expect(posts(current)).to.have.length(0);
  });
  it('blocks nonroot missing sources rather than flattening them', async () => {
    const current = await fixture();
    current.definition.folderPath = ['Nested'];
    await current.save();
    await failure(current.run(), /nonroot/u);
    expect(posts(current)).to.have.length(0);
  });
  it('retains ownership uncertainty if result persistence fails after a successful POST', async () => {
    const current = await fixture();
    let rewrites = 0;
    await failure(
      current.run(true, {
        rewrite: async (file, report) => {
          if (++rewrites > 1) throw new Error('disk unavailable');
          await writeFile(file, JSON.stringify(report));
        },
      }),
      /may have succeeded/u,
    );
    expect(posts(current)).to.have.length(1);
    expect(current.report.operations[0].result?.contentId).to.equal(contentId);
    expect(current.report.state).to.equal('ownership-uncertain');
  });
});
