import { expect } from 'chai';
import type { Connection } from '@salesforce/core';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import type { SourceDefinition } from '../../src/contracts/source-definition.js';
import { extractEditableItemSourceV2 } from '../../src/services/editable-item-source-v2.js';
import { preflightDeployCreate } from '../../src/services/deploy-create-preflight.js';

const workspaceId = '0Zu000000000001AAA';
type Row = Record<string, unknown>;
async function fixture(template = false, v2 = false) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'cms-create-preflight-'));
  const definition: SourceDefinition = {
    contract: 'sf-cms-source-definition',
    contractVersion: '1.0.0',
    identity: {
      family: 'cms',
      type: template ? 'Email Template' : 'Email',
      apiName: 'Welcome',
      context: { workspaceApiName: 'Other_Source' },
    },
    contentType: template ? 'sfdc_cms__emailTemplate' : 'sfdc_cms__email',
    language: 'en_US',
    title: 'Welcome',
    urlName: 'welcome',
    folderPath: [],
    contentBody: {
      'sfdc_cms:title': 'Welcome',
      messagePurpose: 'Transactional',
      textContent: 'Résumé 世界\n',
      'lightning:dataProviders': [],
      ...(template ? {} : { subjectLine: 'Hello', 'sfdc_cms:urlName': 'welcome' }),
    },
    companions: { rawHtml: `Welcome.cms-${template ? 'email-template' : 'email'}.html` },
  };
  const html = '<p>Literal &amp; 世界</p>\n';
  const projection = v2 ? extractEditableItemSourceV2(definition, html) : undefined;
  const file = path.join(
    directory,
    projection?.definitionName ?? definition.companions.rawHtml!.replace('.html', '.json'),
  );
  await writeFile(file, projection?.definitionBytes ?? JSON.stringify(definition));
  for (const companion of projection?.companions ?? [
    { path: definition.companions.rawHtml!, bytes: Buffer.from(html) },
  ])
    await writeFile(path.join(directory, companion.path), companion.bytes);
  const workspace: Row = {
    id: workspaceId,
    apiName: 'Destination',
    defaultLanguage: 'en_US',
    rootFolderId: 'root',
    spaceType: { apiName: 'Marketing' },
  };
  const calls: string[] = [];
  let rows: Row[] = [];
  let workspaceReads = 0;
  let onInventory: (() => Promise<void>) | undefined;
  const connection = {
    getApiVersion: () => '67.0',
    request(input: { method: string; url: string }) {
      expect(input.method).to.equal('GET');
      calls.push(input.url);
      const response = (async () => {
        const url = new URL(input.url, 'https://example.invalid');
        if (url.pathname.endsWith(`/spaces/${workspaceId}`)) {
          workspaceReads += 1;
          return structuredClone(workspace);
        }
        expect(url.pathname).to.equal('/services/data/v67.0/query');
        const soql = url.searchParams.get('q')!;
        expect(soql).not.to.match(/ContentTypeFullyQualifiedName IN|Language =|Status =/u);
        if (onInventory) await onInventory();
        let records = soql.includes('Id >') ? [] : rows;
        if (soql.includes('COUNT(Id)'))
          records = rows.map((row) => ({
            ManagedContentId: row.ManagedContentId,
            siblingCount: 1,
          }));
        return { records: structuredClone(records), done: true, totalSize: records.length };
      })();
      return Object.assign(response, { stream: () => new PassThrough() });
    },
  } as unknown as Pick<Connection, 'request' | 'getApiVersion'>;
  return {
    definition,
    file,
    workspace,
    calls,
    workspaceReads: () => workspaceReads,
    setRows(value: Row[]) {
      rows = value;
    },
    onInventory(callback: () => Promise<void>) {
      onInventory = callback;
    },
    run: () =>
      preflightDeployCreate(connection, { definitionFile: file, workspaceId, language: 'en_US' }),
    save: () => writeFile(file, JSON.stringify(definition)),
  };
}
function row(patch: Row = {}): Row {
  return {
    Id: '9Ps000000000001AAA',
    ManagedContentId: '20Y000000000001AAA',
    ContentTypeFullyQualifiedName: 'sfdc_cms__image',
    Language: 'de',
    IsPublished: true,
    ManagedContentVariantStatus: 'Published',
    IsPrimary: true,
    Name: 'Unrelated',
    UrlName: 'unrelated',
    ManagedContentKey: 'MCEXISTING',
    ManagedContent: { AuthoredManagedContentSpaceId: workspaceId, ApiName: 'Other' },
    ...patch,
  };
}
async function failure(promise: Promise<unknown>, pattern: RegExp): Promise<void> {
  try {
    await promise;
  } catch (error) {
    expect((error as Error).message).to.match(pattern);
    return;
  }
  throw new Error('Expected rejection');
}

describe('internal portable CREATE payload preflight (read-only)', () => {
  for (const template of [false, true])
    for (const v2 of [false, true]) {
      it(`preserves exact ${template ? 'Template' : 'Email'} v${v2 ? 2 : 1} fields without mutation authority`, async () => {
        const f = await fixture(template, v2);
        f.setRows([row()]);
        const result = await f.run();
        expect(result.qualification).to.equal('unqualified');
        expect(result.payload.contentBody).to.deep.equal({
          ...f.definition.contentBody,
          rawHtml: '<p>Literal &amp; 世界</p>\n',
        });
        expect(result.payload).not.to.have.property('contentKey');
        expect(result.payload).not.to.have.property('language');
        expect(result.payload.contentSpaceOrFolderId).to.equal('root');
        expect(f.workspaceReads()).to.equal(2);
      });
    }
  for (const patch of [
    { ManagedContent: { AuthoredManagedContentSpaceId: workspaceId, ApiName: 'Welcome' } },
    { Name: 'Welcome' },
    { UrlName: 'welcome' },
    { ManagedContent: { AuthoredManagedContentSpaceId: workspaceId, ApiName: null } },
  ])
    it('rejects cross-family/language/status collisions or unknown parent names', async () => {
      const f = await fixture();
      f.setRows([row(patch)]);
      await failure(f.run(), /collision|absence unproven/u);
    });
  it('rejects non-default language and non-Marketing workspace', async () => {
    const f = await fixture();
    f.workspace.defaultLanguage = 'de';
    await failure(f.run(), /default language/u);
    f.workspace.defaultLanguage = 'en_US';
    f.workspace.spaceType = { apiName: 'Content' };
    await failure(f.run(), /Marketing/u);
  });
  it('rejects unsupported fields rather than dropping desired text or JSON', async () => {
    const f = await fixture();
    f.definition.contentBody.unsupported = { desired: 'keep' };
    await f.save();
    await failure(f.run(), /Unsupported native body field/u);
    expect(f.calls).to.have.length(0);
  });
  it('requires explicit matching title, URL identity and root placement', async () => {
    for (const change of [
      (d: SourceDefinition) => {
        delete d.title;
      },
      (d: SourceDefinition) => {
        d.urlName = 'different';
      },
      (d: SourceDefinition) => {
        d.folderPath = ['nested'];
      },
    ]) {
      const f = await fixture();
      change(f.definition);
      await f.save();
      await failure(f.run(), /CREATE requires/u);
      expect(f.calls).to.have.length(0);
    }
  });
  it('rejects source edits during destination acquisition', async () => {
    const f = await fixture();
    f.onInventory(async () => {
      f.definition.contentBody.textContent = 'Changed';
      await f.save();
    });
    await failure(f.run(), /source drifted/u);
  });
  it('rejects destination root drift', async () => {
    const f = await fixture();
    f.onInventory(async () => {
      f.workspace.rootFolderId = 'changed';
    });
    await failure(f.run(), /workspace drifted/u);
  });
  it('propagates acquisition failures without accepting an absence claim', async () => {
    const f = await fixture();
    f.onInventory(async () => {
      throw new Error('Read failed');
    });
    await failure(f.run(), /Read failed/u);
  });
});
