import { expect } from 'chai';
import type { Connection } from '@salesforce/core';
import { createHash } from 'node:crypto';
import { mkdtemp, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import type { EditableMediaDefinition } from '../../src/services/editable-media-source.js';
import { preflightDeployDocumentCreate } from '../../src/services/deploy-document-create-preflight.js';

const workspaceId = '0Zu000000000001AAA';
type Row = Record<string, unknown>;
async function fixture(apiName = 'Guide') {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'cms-document-create-preflight-'));
  const file = path.join(directory, `${apiName}.cms-document.json`);
  const companion = path.join(directory, `${apiName}.cms-document.media.txt`);
  const bytes = Buffer.from('Grüße 世界\r\nDocument\n');
  const definition: EditableMediaDefinition = {
    contract: 'sf-cms-media-source',
    contractVersion: '1.0.0',
    identity: {
      family: 'cms',
      type: 'Document',
      apiName,
      context: { workspaceApiName: 'Different_Source' },
    },
    contentType: 'sfdc_cms__document',
    language: 'en_US',
    folderPath: [],
    title: 'Guide document',
    urlName: 'guide-document',
    media: {
      representation: 'binary',
      mimeType: 'text/plain',
      companion: { role: 'media', path: path.basename(companion) },
    },
  };
  const save = () => writeFile(file, JSON.stringify(definition));
  await save();
  await writeFile(companion, bytes);
  const workspace: Row = {
    id: workspaceId,
    apiName: 'Destination',
    defaultLanguage: 'en_US',
    rootFolderId: 'root',
    spaceType: { apiName: 'Marketing' },
  };
  const calls: string[] = [];
  let rows: Row[] = [];
  let onInventory: (() => Promise<void>) | undefined;
  const connection = {
    getApiVersion: () => '67.0',
    request(input: { method: string; url: string }) {
      expect(input.method).to.equal('GET');
      calls.push(input.url);
      const response = (async () => {
        const url = new URL(input.url, 'https://example.invalid');
        if (url.pathname.endsWith(`/spaces/${workspaceId}`)) return structuredClone(workspace);
        expect(url.pathname).to.equal('/services/data/v67.0/query');
        const soql = url.searchParams.get('q')!;
        expect(soql).not.to.match(/ContentTypeFullyQualifiedName IN|Language =|Status =/u);
        await onInventory?.();
        let records = soql.includes('Id >') ? [] : rows;
        if (soql.includes('COUNT(Id)'))
          records = rows.map((entry) => ({
            ManagedContentId: entry.ManagedContentId,
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
    companion,
    bytes,
    workspace,
    calls,
    save,
    setRows(value: Row[]) {
      rows = value;
    },
    onInventory(callback: () => Promise<void>) {
      onInventory = callback;
    },
    run: (input = {}) =>
      preflightDeployDocumentCreate(connection, {
        definitionFile: file,
        workspaceId,
        language: 'en_US',
        ...input,
      }),
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
    IsPrimary: false,
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

describe('portable Document CREATE preflight (read-only)', () => {
  it('returns detached unqualified payload and complete native observations with exact UTF-8 bytes', async () => {
    const f = await fixture();
    f.setRows([row()]);
    const first = await f.run({ expectedRootFolderId: 'root' });
    expect(first.qualification).to.equal('unqualified');
    expect(first.payload).to.deep.equal({
      apiName: 'Guide',
      title: 'Guide document',
      urlName: 'guide-document',
      contentSpaceOrFolderId: 'root',
    });
    expect(first.source.source).to.have.nested.property('binary.bytes').deep.equal(f.bytes);
    expect(first.mediaSha256).to.equal(createHash('sha256').update(f.bytes).digest('hex'));
    expect(first.sourceSha256).to.equal(
      createHash('sha256')
        .update(JSON.stringify(first.source.definition))
        .update(f.bytes)
        .digest('hex'),
    );
    expect(first.observations.inventory.complete).to.equal(true);
    expect(first.observations.inventory.records).to.deep.equal([row()]);
    const repeated = await f.run();
    expect(repeated.sourceSha256).to.equal(first.sourceSha256);
    f.workspace.rootFolderId = 'later';
    f.definition.title = 'later';
    expect(first.rootFolderId).to.equal('root');
    expect(first.observations.workspace.rootFolderId).to.equal('root');
    expect(first.payload.title).to.equal('Guide document');
  });
  it('permits intentional edits without an authoring baseline and binds metadata separately from bytes', async () => {
    const f = await fixture();
    const first = await f.run();
    await writeFile(f.companion, 'Edited ü\n');
    const edited = await f.run();
    expect(edited.mediaSha256).not.to.equal(first.mediaSha256);
    expect(edited.sourceSha256).not.to.equal(first.sourceSha256);
    delete f.definition.urlName;
    await f.save();
    const metadata = await f.run();
    expect(metadata.payload).not.to.have.property('urlName');
    expect(metadata.sourceSha256).not.to.equal(edited.sourceSha256);
    expect(metadata.mediaSha256).to.equal(edited.mediaSha256);
  });
  for (const patch of [
    { ManagedContent: { AuthoredManagedContentSpaceId: workspaceId, ApiName: 'Guide' } },
    { Name: 'Guide document' },
    { UrlName: 'guide-document' },
    { ManagedContent: { AuthoredManagedContentSpaceId: workspaceId, ApiName: null } },
  ])
    it('blocks collisions across families, languages and statuses or unknown parent identity', async () => {
      const f = await fixture();
      f.setRows([row(patch)]);
      await failure(f.run(), /collision|absence unproven/u);
    });
  it('rejects unsupported identity, representation, metadata, root and language before org access', async () => {
    const changes: Array<(d: EditableMediaDefinition) => void> = [
      (d) => {
        d.identity.type = 'Image';
      },
      (d) => {
        d.identity.apiName = 'Substituted';
      },
      (d) => {
        d.media = { representation: 'url-only', address: '/document' };
      },
      (d) => {
        delete d.title;
      },
      (d) => {
        d.title = ' ';
      },
      (d) => {
        d.urlName = 'Bad Slug';
      },
      (d) => {
        d.folderPath = ['nested'];
      },
      (d) => {
        d.language = 'de';
      },
      (d) => {
        if (d.media.representation === 'binary') d.media.mimeType = 'application/pdf';
      },
      (d) => {
        if (d.media.representation === 'binary')
          d.media.companion.path = 'Guide.cms-document.media.TXT';
      },
    ];
    for (const change of changes) {
      const f = await fixture();
      change(f.definition);
      await f.save();
      await failure(f.run(), /Document CREATE|same-stem|type\/contentType/u);
      expect(f.calls).to.have.length(0);
    }
    const unicode = await fixture('Grüße');
    await failure(unicode.run(), /Unsafe source path segment/u);
    expect(unicode.calls).to.have.length(0);
    const invalid = await fixture();
    await failure(invalid.run({ workspaceId: 'wrong' }), /workspace ID/u);
    expect(invalid.calls).to.have.length(0);
  });
  it('rejects missing, empty, invalid UTF-8 and over-profile bytes before org access', async () => {
    for (const bytes of [
      Buffer.alloc(0),
      Buffer.from([255]),
      Buffer.alloc(10 * 1024 * 1024 + 1, 65),
    ]) {
      const f = await fixture();
      await writeFile(f.companion, bytes);
      await failure(f.run(), /nonempty|encoded data|10 MiB/u);
      expect(f.calls).to.have.length(0);
    }
    const missing = await fixture();
    await unlink(missing.companion);
    await failure(missing.run(), /missing/u);
    expect(missing.calls).to.have.length(0);
  });
  it('accepts the inclusive 10 MiB profile boundary', async () => {
    const f = await fixture();
    await writeFile(f.companion, Buffer.alloc(10 * 1024 * 1024, 65));
    const result = await f.run();
    expect(result.source.source).to.have.nested.property('binary.bytes.length', 10 * 1024 * 1024);
  });
  it('rejects substituted destination identity, language, root binding and noncanonical Marketing', async () => {
    for (const patch of [
      { id: '0Zu000000000002AAA' },
      { defaultLanguage: 'de' },
      { rootFolderId: '' },
      { spaceType: { apiName: 'Content' } },
      { spaceType: 'Marketing' },
    ]) {
      const f = await fixture();
      Object.assign(f.workspace, patch);
      await failure(f.run(), /default language|Marketing/u);
    }
    const f = await fixture();
    await failure(f.run({ expectedRootFolderId: 'different' }), /root/u);
  });
  it('blocks native parent/workspace/variant disagreement rather than claiming absence', async () => {
    for (const patch of [
      { Id: 'wrong' },
      { ManagedContentId: 'wrong' },
      { ManagedContent: { AuthoredManagedContentSpaceId: '0Zu000000000002AAA', ApiName: 'Other' } },
    ]) {
      const f = await fixture();
      f.setRows([row(patch)]);
      await failure(f.run(), /native IDs|disagreement/u);
    }
  });
  it('blocks local byte/metadata and destination root/language/identity drift', async () => {
    for (const kind of ['bytes', 'metadata', 'root', 'language', 'identity']) {
      const f = await fixture();
      f.onInventory(async () => {
        switch (kind) {
          case 'bytes': {
            await writeFile(f.companion, 'Changed');
            break;
          }
          case 'metadata': {
            f.definition.title = 'Changed';
            await f.save();
            break;
          }
          case 'root': {
            f.workspace.rootFolderId = 'changed';
            break;
          }
          case 'language': {
            f.workspace.defaultLanguage = 'de';
            break;
          }
          default: {
            f.workspace.id = '0Zu000000000002AAA';
          }
        }
      });
      await failure(f.run(), /drifted/u);
    }
  });
  it('propagates read failure and rejects changing native inventory', async () => {
    const failed = await fixture();
    failed.onInventory(async () => {
      throw new Error('Read failed');
    });
    await failure(failed.run(), /Read failed/u);
    const changed = await fixture();
    let reads = 0;
    changed.onInventory(async () => {
      reads += 1;
      if (reads === 3) changed.setRows([row()]);
    });
    await failure(changed.run(), /changed during repeat/u);
  });
});
