import { expect } from 'chai';
import type { Connection } from '@salesforce/core';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import type { EditableMediaDefinition } from '../../src/services/editable-media-source.js';
import { preflightDeployAudioCreate } from '../../src/services/deploy-audio-create-preflight.js';

const workspaceId = '0Zu000000000001AAA';
type Row = Record<string, unknown>;
async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'cms-audio-create-preflight-'));
  const file = path.join(directory, 'Sound.cms-audio.json');
  const companion = path.join(directory, 'Sound.cms-audio.media.bin');
  const bytes = Buffer.from([0, 255, 128, 13, 10, 1]);
  const definition: EditableMediaDefinition = {
    contract: 'sf-cms-media-source',
    contractVersion: '1.0.0',
    identity: {
      family: 'cms',
      type: 'Audio',
      apiName: 'Sound',
      context: { workspaceApiName: 'Different_Source' },
    },
    contentType: 'sfdc_cms__audio',
    language: 'en_US',
    folderPath: [],
    title: 'Opaque sound',
    urlName: 'opaque-sound',
    media: {
      representation: 'binary',
      mimeType: 'application/x-future-audio',
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
  let malformed: 'terminal' | 'count' | undefined;
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
            siblingCount: malformed === 'count' ? 2 : 1,
          }));
        return {
          records: structuredClone(records),
          done: malformed !== 'terminal',
          totalSize: records.length,
        };
      })();
      return Object.assign(response, { stream: () => new PassThrough() });
    },
  } as unknown as Pick<Connection, 'request' | 'getApiVersion'>;
  return {
    definition,
    file,
    companion,
    directory,
    bytes,
    workspace,
    calls,
    save,
    setRows(value: Row[]) {
      rows = value;
    },
    malformed(value: typeof malformed) {
      malformed = value;
    },
    onInventory(callback: () => Promise<void>) {
      onInventory = callback;
    },
    run: (input = {}) =>
      preflightDeployAudioCreate(connection, {
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

describe('portable Audio CREATE preflight (read-only)', () => {
  it('returns detached unqualified source, hashes and complete observations with no journal writes', async () => {
    const f = await fixture();
    f.setRows([row()]);
    const before = await readdir(f.directory);
    const first = await f.run({ expectedRootFolderId: 'root' });
    expect(await readdir(f.directory)).to.deep.equal(before);
    expect(first.qualification).to.equal('unqualified');
    expect(first.definitionFile).to.equal(path.resolve(f.file));
    expect(first.apiVersion).to.equal('67.0');
    expect(first.language).to.equal('en_US');
    expect(first.workspaceId).to.equal(workspaceId);
    expect(first.payload).to.deep.equal({
      apiName: 'Sound',
      title: 'Opaque sound',
      urlName: 'opaque-sound',
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
    expect(first.observations.inventory.pagesRequested).to.equal(6);
    expect(first.observations.inventory.records).to.deep.equal([row()]);
    const repeated = await f.run();
    expect(repeated.sourceSha256).to.equal(first.sourceSha256);
    f.workspace.rootFolderId = 'later';
    f.definition.title = 'later';
    repeated.observations.inventory.records[0].Name = 'later';
    expect(first.rootFolderId).to.equal('root');
    expect(first.observations.workspace.rootFolderId).to.equal('root');
    expect(first.observations.inventory.records[0].Name).to.equal('Unrelated');
    expect(first.payload.title).to.equal('Opaque sound');
  });
  it('binds intentional metadata edits separately from exact opaque bytes without a baseline', async () => {
    const f = await fixture();
    const first = await f.run();
    await writeFile(f.companion, Buffer.from([255, 0, 129]));
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
    { ManagedContent: { AuthoredManagedContentSpaceId: workspaceId, ApiName: 'Sound' } },
    { Name: 'Opaque sound' },
    { UrlName: 'opaque-sound' },
    { ManagedContent: { AuthoredManagedContentSpaceId: workspaceId, ApiName: null } },
  ])
    it('blocks cross-family/language/status collisions and unknown parent identity', async () => {
      const f = await fixture();
      f.setRows([row(patch)]);
      await failure(f.run(), /collision|absence unproven/u);
    });
  it('rejects wrong family, URL-only, identity, metadata, root and language before reads', async () => {
    const changes: Array<(d: EditableMediaDefinition) => void> = [
      (d) => {
        d.identity.type = 'Image';
      },
      (d) => {
        d.identity.apiName = 'Substituted';
      },
      (d) => {
        d.media = { representation: 'url-only', address: '/audio' };
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
        if (d.media.representation === 'binary') d.media.mimeType = 'audio/wav\r\nX: yes';
      },
    ];
    for (const change of changes) {
      const f = await fixture();
      change(f.definition);
      await f.save();
      await failure(f.run(), /Audio CREATE|same-stem|type\/contentType|safe ASCII/u);
      expect(f.calls).to.have.length(0);
    }
    const f = await fixture();
    await failure(f.run({ workspaceId: 'wrong' }), /workspace ID/u);
    expect(f.calls).to.have.length(0);
  });
  it('rejects missing or empty bytes and accepts opaque non-WAV bytes above the revoked 10 MiB cap locally', async () => {
    const f = await fixture();
    await writeFile(f.companion, Buffer.alloc(0));
    await failure(f.run(), /nonempty/u);
    expect(f.calls).to.have.length(0);
    await unlink(f.companion);
    await failure(f.run(), /missing/u);
    expect(f.calls).to.have.length(0);
    const bytes = Buffer.alloc(10 * 1024 * 1024 + 1, 255);
    await writeFile(f.companion, bytes);
    const result = await f.run();
    expect(result.mediaSha256).to.equal(createHash('sha256').update(bytes).digest('hex'));
    expect(result.qualification).to.equal('unqualified');
  });
  it('rejects substituted destination identity, language, root and noncanonical Marketing', async () => {
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
  it('fails closed on native IDs, workspace, terminal and count disagreement', async () => {
    for (const patch of [
      { Id: 'wrong' },
      { ManagedContentId: 'wrong' },
      { ManagedContent: { AuthoredManagedContentSpaceId: '0Zu000000000002AAA', ApiName: 'Other' } },
    ]) {
      const f = await fixture();
      f.setRows([row(patch)]);
      await failure(f.run(), /native IDs|disagreement/u);
    }
    for (const kind of ['terminal', 'count'] as const) {
      const f = await fixture();
      f.setRows([row()]);
      f.malformed(kind);
      await failure(f.run(), /incomplete|count disagreement/u);
    }
  });
  it('blocks local byte/metadata and destination root/language/identity drift', async () => {
    for (const kind of ['bytes', 'metadata', 'root', 'language', 'identity']) {
      const f = await fixture();
      f.onInventory(async () => {
        switch (kind) {
          case 'bytes': {
            await writeFile(f.companion, Buffer.from([1]));
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
  it('propagates API failures and rejects changing repeated inventory', async () => {
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
