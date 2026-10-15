import { expect } from 'chai';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  assertEditableMediaDefinition,
  extractEditableMediaSource,
  loadEditableMediaSource,
  reassembleEditableMediaSource,
  type EditableMediaMetadata,
} from '../../src/services/editable-media-source.js';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=',
  'base64',
);
const DOCUMENT = Buffer.from('Résumé 世界\r\nNative text.\n');
function metadata(document = false): EditableMediaMetadata {
  return {
    identity: {
      family: 'cms',
      type: document ? 'Document' : 'Image',
      apiName: 'Hero',
      context: { workspaceApiName: 'Marketing' },
    },
    contentType: document ? 'sfdc_cms__document' : 'sfdc_cms__image',
    language: 'en_US',
    title: 'Hero',
    folderPath: [],
  };
}
function body(bytes: Buffer, mimeType = 'image/png', fileName = 'hero.png') {
  return {
    'sfdc_cms:media': {
      source: { type: 'file', ref: 'source-native-ref', mimeType, size: bytes.length },
      url: `/cms/media/source-key?fileName=${fileName}&fileHash=${createHash('md5').update(bytes).digest('hex')}&version=1.1`,
    },
  };
}
async function failure(operation: Promise<unknown>, pattern: RegExp) {
  try {
    await operation;
  } catch (error) {
    expect((error as Error).message).to.match(pattern);
    return;
  }
  throw new Error('Expected rejection');
}

describe('standalone editable native media source', () => {
  for (const document of [false, true]) {
    it(`roundtrips and edits ${document ? 'Document' : 'Image'} bytes without native locators or a baseline`, async () => {
      const bytes = document ? DOCUMENT : PNG;
      const native = body(
        bytes,
        document ? 'text/plain' : 'image/png',
        document ? 'note.txt' : 'hero.png',
      );
      const original = structuredClone(native);
      const projection = extractEditableMediaSource(metadata(document), native, bytes);
      expect(native).to.deep.equal(original);
      expect(projection.definitionName).to.equal(
        `Hero.cms-${document ? 'document' : 'image'}.json`,
      );
      expect(projection.companions[0].path).to.equal(
        `Hero.cms-${document ? 'document' : 'image'}.media.${document ? 'txt' : 'png'}`,
      );
      const json = projection.definitionBytes.toString();
      for (const locator of [
        'source-native-ref',
        'source-key',
        'fileHash',
        'size',
        'base64',
        'contentBody',
      ])
        expect(json).not.to.include(locator);
      expect(
        extractEditableMediaSource(metadata(document), native, bytes).definitionBytes.equals(
          projection.definitionBytes,
        ),
      ).to.equal(true);
      const reconstructed = reassembleEditableMediaSource(
        projection.definition,
        new Map(projection.companions.map((entry) => [entry.path, entry.bytes])),
      );
      if (reconstructed.representation !== 'binary') throw new Error('Expected binary');
      expect(reconstructed.binary.bytes.equals(bytes)).to.equal(true);
      expect(reconstructed.contentBody).to.deep.equal({
        'sfdc_cms:media': { source: { type: 'file' } },
      });
      reconstructed.binary.bytes.fill(0);
      expect(projection.companions[0].bytes.equals(bytes)).to.equal(true);
      const directory = await mkdtemp(path.join(os.tmpdir(), 'cms-media-source-'));
      const definitionFile = path.join(directory, projection.definitionName);
      await writeFile(definitionFile, projection.definitionBytes);
      const companion = path.join(directory, projection.companions[0].path);
      await writeFile(companion, bytes);
      await writeFile(path.join(directory, 'unrelated.json'), '{}');
      const loaded = await loadEditableMediaSource(definitionFile);
      expect(loaded.source).to.deep.equal(
        reassembleEditableMediaSource(
          projection.definition,
          new Map([[projection.companions[0].path, bytes]]),
        ),
      );
      const edited = document
        ? Buffer.from('Edited 世界\n')
        : Buffer.concat([PNG, Buffer.from([0, 255, 42])]);
      await writeFile(companion, edited);
      const modified = structuredClone(projection.definition);
      modified.title = 'Edited title';
      await writeFile(definitionFile, JSON.stringify(modified));
      const result = await loadEditableMediaSource(definitionFile);
      if (result.source.representation !== 'binary') throw new Error('Expected binary');
      expect(result.source.binary.bytes.equals(edited)).to.equal(true);
      expect(result.definition.title).to.equal('Edited title');
      expect(await readFile(path.join(directory, 'unrelated.json'), 'utf8')).to.equal('{}');
    });
  }

  it('represents unretrieved URLs explicitly without inventing a native upload body', async () => {
    for (const address of ['https://cdn.example.test/image.png', body(PNG)['sfdc_cms:media'].url]) {
      const native = body(PNG);
      native['sfdc_cms:media'].url = address;
      const projection = extractEditableMediaSource(metadata(), native);
      expect(projection.companions).to.deep.equal([]);
      expect(reassembleEditableMediaSource(projection.definition, new Map())).to.deep.equal({
        representation: 'url-only',
        address,
      });
      const directory = await mkdtemp(path.join(os.tmpdir(), 'cms-url-only-'));
      const json = path.join(directory, projection.definitionName);
      await writeFile(json, projection.definitionBytes);
      const loaded = await loadEditableMediaSource(json);
      expect(loaded.source).to.deep.equal({
        representation: 'url-only',
        address,
      });
      expect(() =>
        reassembleEditableMediaSource(projection.definition, new Map([['extra', PNG]])),
      ).to.throw(/exactly/u);
    }
  });

  it('supports evidenced image signatures and deterministic meaningful extensions', () => {
    for (const [mime, extension, bytes] of [
      ['image/gif', 'gif', Buffer.from('GIF89a')],
      ['image/jpeg', 'jpg', Buffer.from([255, 216, 255, 0])],
      ['image/webp', 'webp', Buffer.from('RIFF0000WEBP')],
    ] as const) {
      const projection = extractEditableMediaSource(
        metadata(),
        body(bytes, mime, `hero.${extension}`),
        bytes,
      );
      expect(projection.companions[0].path).to.equal(`Hero.cms-image.media.${extension}`);
    }
  });

  it('rejects unsupported components, native evidence mismatch and ambiguous bindings', () => {
    const projection = extractEditableMediaSource(metadata(), body(PNG), PNG);
    for (const change of [
      { sourceId: 'source' },
      { contentBody: { binary: 'duplicate' } },
      { contentType: 'sfdc_cms__video' },
      {
        media: {
          representation: 'binary',
          mimeType: 'image/svg+xml',
          companion: { role: 'media', path: 'Hero.svg' },
        },
      },
      {
        media: {
          representation: 'binary',
          mimeType: 'image/png',
          companion: { role: 'media', path: '../Hero.png' },
        },
      },
      {
        media: {
          representation: 'binary',
          mimeType: 'image/png',
          companion: { role: 'media', path: 'Hero.cms-image.media.png', bytes: 'duplicate' },
        },
      },
      { media: { representation: 'url-only', address: 'javascript:alert(1)' } },
      { media: { representation: 'url-only', address: 'https://user:password@example.test/file' } },
    ])
      expect(() =>
        assertEditableMediaDefinition({ ...projection.definition, ...change }),
      ).to.throw();
    for (const native of [
      { ...body(PNG), builder: {} },
      { 'sfdc_cms:media': { ...body(PNG)['sfdc_cms:media'], other: 'unsupported' } },
      body(Buffer.concat([PNG, PNG])),
      body(PNG, 'image/png', 'hero.jpg'),
      body(PNG, 'image/svg+xml'),
    ])
      expect(() => extractEditableMediaSource(metadata(), native, PNG)).to.throw();
    expect(() => reassembleEditableMediaSource(projection.definition, new Map())).to.throw(
      /exactly/u,
    );
    expect(() =>
      reassembleEditableMediaSource(projection.definition, new Map([['wrong', PNG]])),
    ).to.throw(/missing/u);
    for (const bytes of [
      Buffer.alloc(0),
      Buffer.from('not png'),
      Buffer.alloc(10 * 1024 * 1024 + 1),
    ])
      expect(() =>
        reassembleEditableMediaSource(
          projection.definition,
          new Map([[projection.companions[0].path, bytes]]),
        ),
      ).to.throw();
    const document = extractEditableMediaSource(
      metadata(true),
      body(DOCUMENT, 'text/plain', 'note.txt'),
      DOCUMENT,
    );
    expect(() =>
      reassembleEditableMediaSource(
        document.definition,
        new Map([[document.companions[0].path, Buffer.from([195, 40])]]),
      ),
    ).to.throw();
  });

  it('fails clearly for missing/case-aliased companions and duplicate JSON keys', async () => {
    const projection = extractEditableMediaSource(metadata(), body(PNG), PNG);
    const directory = await mkdtemp(path.join(os.tmpdir(), 'cms-media-missing-'));
    const json = path.join(directory, projection.definitionName);
    await writeFile(json, projection.definitionBytes);
    await failure(loadEditableMediaSource(json), /missing/u);
    await writeFile(path.join(directory, projection.companions[0].path.toLowerCase()), PNG);
    await failure(loadEditableMediaSource(json), /case-aliased/u);
    await writeFile(json, '{"contract":1,"contract":2}');
    await failure(loadEditableMediaSource(json), /duplicate/u);
    await failure(loadEditableMediaSource(''), /nonempty/u);
  });
});
