import { expect } from 'chai';
import type { Connection } from '@salesforce/core';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { resolveEmailFragmentDeployDestination } from '../../src/services/deploy-email-fragment-destination.js';
import type { EmailFragmentSourceDefinition } from '../../src/contracts/email-fragment-source.js';

type RecordValue = Record<string, unknown>;
const workspaceId = '0Zu000000000001AAA';
const parentId = '20Y000000000001AAA';
const variantId = '9Ps000000000001AAA';
async function fixture(present = true) {
  const root = await mkdtemp(path.join(tmpdir(), 'cms-fragment-destination-'));
  const file = path.join(root, 'Welcome.cms-email-fragment.json');
  const definition: EmailFragmentSourceDefinition = {
    contract: 'sf-cms-email-fragment-source',
    contractVersion: '1.0.0',
    identity: {
      family: 'cms',
      type: 'Email Fragment',
      apiName: 'Welcome',
      context: { workspaceApiName: 'Unrelated_Source' },
    },
    contentType: 'sfdc_cms__emailFragment',
    language: 'en_US',
    title: 'Welcome',
    urlName: 'welcome',
    folderPath: [],
    contentBody: {
      'sfdc_cms:title': 'Welcome',
      'sfdc_cms:urlName': 'welcome',
      'sfdc_cms:block': {
        type: 'block',
        definition: 'sfdc_cms/rootContentBlock',
        id: '10000000-0000-4000-8000-000000000001',
        children: [],
      },
    },
  };
  await writeFile(file, JSON.stringify(definition));
  const workspace: RecordValue = {
    id: workspaceId,
    apiName: 'Destination',
    defaultLanguage: 'en_US',
    languages: ['en_US', 'de'],
    rootFolderId: '9Pu000000000001AAA',
    spaceType: { apiName: 'Marketing' },
  };
  const detail: RecordValue = {
    managedContentVariantId: variantId,
    managedContentId: parentId,
    contentKey: 'MCWELCOME',
    contentSpace: { id: workspaceId },
    apiName: 'Welcome',
    language: 'en_US',
    contentType: { fullyQualifiedName: definition.contentType },
    title: 'Welcome',
    urlName: 'welcome',
    folder: null,
    isPublished: false,
    status: { status: 'Draft', label: 'Draft' },
    contentBody: structuredClone(definition.contentBody),
  };
  const parent = structuredClone(detail);
  const rows: RecordValue[] = present
    ? [
        {
          Id: variantId,
          ManagedContentId: parentId,
          ContentTypeFullyQualifiedName: definition.contentType,
          Language: 'en_US',
          VariantType: 'Content',
          IsPublished: false,
          ManagedContentVariantStatus: 'Draft',
          IsPrimary: true,
          Name: 'Welcome',
          UrlName: 'welcome',
          ManagedContentKey: 'MCWELCOME',
          ManagedContent: { AuthoredManagedContentSpaceId: workspaceId, ApiName: 'Welcome' },
        },
      ]
    : [];
  const calls: string[] = [];
  let workspaceReads = 0;
  let onWorkspace: ((count: number) => void) | undefined;
  const connection = {
    getApiVersion: () => '67.0',
    request(input: { method: string; url: string }) {
      expect(input.method).to.equal('GET');
      calls.push(input.url);
      const url = new URL(input.url, 'https://example.invalid');
      let value: unknown;
      switch (url.pathname) {
        case `/connect/cms/spaces/${workspaceId}`: {
          onWorkspace?.(++workspaceReads);
          value = workspace;

          break;
        }
        case `/connect/cms/contents/variants/${variantId}`: {
          value = detail;
          break;
        }
        case `/connect/cms/contents/${parentId}`: {
          value = parent;
          break;
        }
        case '/services/data/v67.0/query': {
          const soql = url.searchParams.get('q')!;
          const after = /Id > '([^']+)'/u.exec(soql)?.[1];
          let records: RecordValue[];
          if (soql.includes('COUNT(Id)')) {
            const counts = new Map<unknown, number>();
            for (const row of rows)
              counts.set(row.ManagedContentId, (counts.get(row.ManagedContentId) ?? 0) + 1);
            records = [...counts].map(([ManagedContentId, siblingCount]) => ({
              ManagedContentId,
              siblingCount,
            }));
          } else records = rows.filter((row) => !after || String(row.Id) > after);
          value = { done: true, totalSize: records.length, records };

          break;
        }
        default: {
          throw new Error(`Unexpected read ${input.url}`);
        }
      }
      return Object.assign(Promise.resolve(structuredClone(value)), {
        stream: () => new PassThrough(),
      });
    },
  } as unknown as Pick<Connection, 'request' | 'getApiVersion'>;
  return {
    definition,
    file,
    workspace,
    rows,
    detail,
    parent,
    calls,
    connection,
    onWorkspace(callback: (count: number) => void) {
      onWorkspace = callback;
    },
    resolve() {
      return resolveEmailFragmentDeployDestination(connection, {
        definitionFile: file,
        workspaceId,
      });
    },
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

describe('preparatory Fragment deployment destination identity', () => {
  it('loads a clean standalone source independent of destination name and proves absence without proposing an operation', async () => {
    const current = await fixture(false);
    const result = await current.resolve();
    expect(result.source.definition.identity.context.workspaceApiName).to.equal('Unrelated_Source');
    expect(result.workspace.apiName).to.equal('Destination');
    expect(result.inventory.complete).to.equal(true);
    expect(result.existing).to.equal(undefined);
    expect(result).not.to.have.property('proposed');
    expect(result.qualification).to.equal('unqualified');
  });
  it('binds destination-local single-default Draft evidence despite unused enabled German', async () => {
    const current = await fixture();
    const result = await current.resolve();
    expect(result.existing?.evidence).to.deep.equal({ variantId, contentId: parentId });
    expect(result.existing?.projection.definition.identity.context.workspaceApiName).to.equal(
      'Destination',
    );
    expect(result.source.definition).to.deep.equal(current.definition);
    expect(result).not.to.have.property('proposed');
  });
  it('rejects extra actual language/custom/type/status variants before detail acquisition', async () => {
    for (const patch of [
      { Language: 'de', IsPrimary: false },
      { VariantType: 'Custom' },
      { ContentTypeFullyQualifiedName: 'sfdc_cms__email' },
      { ManagedContentVariantStatus: 'Published' },
    ]) {
      const current = await fixture();
      current.rows.push({
        ...structuredClone(current.rows[0]),
        Id: '9Ps000000000002AAA',
        ...patch,
      });
      await failure(current.resolve(), /exactly one default variant/u);
      expect(current.calls.some((url) => url.includes('/contents/'))).to.equal(false);
    }
  });
  it('rejects wrong language, type, primary classification, published and missing variant evidence', async () => {
    for (const patch of [
      { Language: 'de' },
      { VariantType: '' },
      { IsPrimary: false },
      { ContentTypeFullyQualifiedName: 'sfdc_cms__email' },
      { IsPublished: true },
      { ManagedContentVariantStatus: 'Published' },
    ]) {
      const current = await fixture();
      Object.assign(current.rows[0], patch);
      await failure(
        current.resolve(),
        /exact native default|exact unpublished Draft|malformed native row/u,
      );
    }
  });
  it('blocks unproven absence and title/URL collisions across other API names', async () => {
    for (const apiName of [null, 'Other']) {
      const current = await fixture();
      (current.rows[0].ManagedContent as RecordValue).ApiName = apiName;
      await failure(current.resolve(), /absence is unproven|collision/u);
    }
  });
  it('blocks malformed workspace, nondefault source and workspace drift', async () => {
    for (const patch of [
      { id: 'wrong' },
      { rootFolderId: '' },
      { defaultLanguage: 'de' },
      { apiName: '../escape' },
    ]) {
      const current = await fixture(false);
      Object.assign(current.workspace, patch);
      await failure(current.resolve(), /workspace identity|exact destination default|Unsafe/u);
    }
    const current = await fixture(false);
    current.onWorkspace((count) => {
      if (count === 2) current.workspace.apiName = 'Changed';
    });
    await failure(current.resolve(), /changed during resolution/u);
  });
  it('uses complete sibling acquisition rather than trusting the first inventory row', async () => {
    const current = await fixture();
    current.detail.apiName = 'Other';
    await failure(current.resolve(), /disagreement|identity/u);
  });
  it('rejects authored source variants locally and invalid workspace IDs before org reads', async () => {
    const current = await fixture(false);
    current.definition.contentBody['sfdc_cms:variants'] = [{}];
    await writeFile(current.file, JSON.stringify(current.definition));
    await failure(current.resolve(), /Additional authored/u);
    await failure(
      resolveEmailFragmentDeployDestination(current.connection, {
        definitionFile: current.file,
        workspaceId: 'bad',
      }),
      /Exact destination/u,
    );
    expect(current.calls).to.deep.equal([]);
  });
});
