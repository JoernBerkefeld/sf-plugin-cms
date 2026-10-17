import { expect } from 'chai';
import type { Connection } from '@salesforce/core';
import { mkdtemp, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import type { EditableMediaDefinition } from '../../src/services/editable-media-source.js';
import { preflightDeployImageCreate } from '../../src/services/deploy-image-create-preflight.js';

const workspaceId = '0Zu000000000001AAA';
type Row = Record<string, unknown>;
async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'cms-image-create-preflight-'));
  const file = path.join(directory, 'Hero.cms-image.json');
  const companion = path.join(directory, 'Hero.cms-image.media.png');
  const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1]);
  const definition: EditableMediaDefinition = {
    contract: 'sf-cms-media-source',
    contractVersion: '1.0.0',
    identity: {
      family: 'cms',
      type: 'Image',
      apiName: 'Hero',
      context: { workspaceApiName: 'Different_Source' },
    },
    contentType: 'sfdc_cms__image',
    language: 'en_US',
    folderPath: [],
    title: 'Hero image',
    urlName: 'hero-image',
    media: {
      representation: 'binary',
      mimeType: 'image/png',
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
    run: () =>
      preflightDeployImageCreate(connection, {
        definitionFile: file,
        workspaceId,
        language: 'en_US',
      }),
  };
}
function row(patch: Row = {}): Row {
  return {
    Id: '9Ps000000000001AAA',
    ManagedContentId: '20Y000000000001AAA',
    ContentTypeFullyQualifiedName: 'sfdc_cms__email',
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

describe('portable binary Image CREATE preflight (read-only)', () => {
  it('loads real portable binary files and binds exact metadata, destination root and edited bytes', async () => {
    const f = await fixture();
    f.setRows([row()]);
    const first = await f.run();
    expect(first.qualification).to.equal('unqualified');
    expect(first.payload).to.deep.equal({
      apiName: 'Hero',
      title: 'Hero image',
      urlName: 'hero-image',
      contentSpaceOrFolderId: 'root',
    });
    expect(first.source.source.representation).to.equal('binary');
    expect(first.source.source).to.have.nested.property('binary.bytes').deep.equal(f.bytes);
    expect(first.sourceSha256).to.match(/^[a-f0-9]{64}$/u);
    const repeated = await f.run();
    expect(repeated.sourceSha256).to.equal(first.sourceSha256);
    await writeFile(f.companion, Buffer.concat([f.bytes, Buffer.from([2])]));
    const edited = await f.run();
    expect(edited.sourceSha256).not.to.equal(first.sourceSha256);
    f.definition.title = 'Edited title';
    await f.save();
    const metadataEdited = await f.run();
    expect(metadataEdited.sourceSha256).not.to.equal(edited.sourceSha256);
    expect(first.payload.title).to.equal('Hero image');
  });
  for (const patch of [
    { ManagedContent: { AuthoredManagedContentSpaceId: workspaceId, ApiName: 'Hero' } },
    { Name: 'Hero image' },
    { UrlName: 'hero-image' },
    { ManagedContent: { AuthoredManagedContentSpaceId: workspaceId, ApiName: null } },
  ])
    it('blocks cross-family/language/status collisions and unknown parent identities', async () => {
      const f = await fixture();
      f.setRows([row(patch)]);
      await failure(f.run(), /collision|absence unproven/u);
    });
  it('blocks unsupported local intent before any org access', async () => {
    const changes: Array<(d: EditableMediaDefinition) => void> = [
      (d) => {
        d.media = { representation: 'url-only', address: 'https://example.invalid/image.png' };
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
        d.contentType = 'sfdc_cms__document';
        d.identity.type = 'Document';
        d.media = { representation: 'url-only', address: '/document' };
      },
    ];
    for (const change of changes) {
      const f = await fixture();
      change(f.definition);
      await f.save();
      await failure(f.run(), /Image CREATE|same-stem/u);
      expect(f.calls).to.have.length(0);
    }
    const missing = await fixture();
    await unlink(missing.companion);
    await failure(missing.run(), /missing/u);
    expect(missing.calls).to.have.length(0);
    const invalid = await fixture();
    await writeFile(invalid.companion, 'not PNG');
    await failure(invalid.run(), /signature/u);
    expect(invalid.calls).to.have.length(0);
  });
  it('blocks non-default language, missing root and non-Marketing destinations', async () => {
    for (const patch of [
      { defaultLanguage: 'de' },
      { rootFolderId: '' },
      { spaceType: { apiName: 'Content' } },
    ]) {
      const f = await fixture();
      Object.assign(f.workspace, patch);
      await failure(f.run(), /default language|Marketing/u);
    }
  });
  it('blocks local byte or metadata drift and destination root drift', async () => {
    for (const kind of ['bytes', 'metadata', 'root']) {
      const f = await fixture();
      f.onInventory(async () => {
        if (kind === 'bytes')
          await writeFile(f.companion, Buffer.concat([f.bytes, Buffer.from([3])]));
        else if (kind === 'metadata') {
          f.definition.title = 'Changed';
          await f.save();
        } else f.workspace.rootFolderId = 'changed';
      });
      await failure(f.run(), /drifted/u);
    }
  });
  it('propagates failed inventory reads without claiming absence', async () => {
    const f = await fixture();
    f.onInventory(async () => {
      throw new Error('Read failed');
    });
    await failure(f.run(), /Read failed/u);
  });
});
