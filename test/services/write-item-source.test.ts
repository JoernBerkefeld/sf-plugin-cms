import { expect } from 'chai';
import {
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { SourceDefinition } from '../../src/contracts/source-definition.js';
import { extractEditableItemSourceV2 } from '../../src/services/editable-item-source-v2.js';
import { writeEditableItemSource } from '../../src/services/write-item-source.js';
import { extractEditableMediaSource } from '../../src/services/editable-media-source.js';
import { createHash } from 'node:crypto';
import {
  extractEditableBrandSource,
  loadEditableBrandSource,
} from '../../src/services/editable-item-source.js';
import { brandBody } from '../fixtures/brand.js';

function brandProjection() {
  return extractEditableBrandSource({
    contract: 'sf-cms-source-definition',
    contractVersion: '1.0.0',
    identity: {
      family: 'cms',
      type: 'Brand',
      apiName: 'Welcome',
      context: { workspaceApiName: 'Marketing' },
    },
    contentType: 'sfdc_cms__brand',
    language: 'en_US',
    folderPath: [],
    title: 'Brand',
    contentBody: brandBody('Brand'),
    companions: {},
  });
}

const directory = 'cms/Marketing/email';
function projection(text = true, html = '<p>Hello</p>') {
  const definition: SourceDefinition = {
    contract: 'sf-cms-source-definition',
    contractVersion: '1.0.0',
    identity: {
      family: 'cms',
      type: 'Email',
      apiName: 'Welcome',
      context: { workspaceApiName: 'Marketing' },
    },
    contentType: 'sfdc_cms__email',
    language: 'en_US',
    folderPath: [],
    contentBody: {
      'sfdc_cms:title': 'Welcome',
      messagePurpose: 'Transactional',
      subjectLine: 'Hello',
      ...(text ? { textContent: 'Plain text' } : {}),
    },
    companions: { rawHtml: 'Welcome.cms-email.html' },
  };
  return extractEditableItemSourceV2(definition, html);
}
async function root() {
  return mkdtemp(path.join(os.tmpdir(), 'cms-item-writer-'));
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
async function snapshot(folder: string) {
  const entries = await readdir(folder);
  return Promise.all(
    entries.toSorted().map(async (name) => {
      const bytes = await readFile(path.join(folder, name));
      const information = await stat(path.join(folder, name));
      return { name, bytes: bytes.toString('hex'), mtime: information.mtimeMs };
    }),
  );
}

function mediaProjection(binary = true, jpeg = false) {
  const bytes = jpeg
    ? Buffer.from([255, 216, 255, 42])
    : Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 42]);
  return extractEditableMediaSource(
    {
      identity: {
        family: 'cms',
        type: 'Image',
        apiName: 'Hero',
        context: { workspaceApiName: 'Marketing' },
      },
      contentType: 'sfdc_cms__image',
      language: 'en_US',
      folderPath: [],
    },
    {
      'sfdc_cms:media': {
        source: { type: 'file', size: bytes.length, mimeType: jpeg ? 'image/jpeg' : 'image/png' },
        url: `/cms/media/key?fileName=hero.${jpeg ? 'jpg' : 'png'}&version=1.1&fileHash=${createHash('md5').update(bytes).digest('hex')}`,
      },
    },
    binary ? bytes : undefined,
  );
}

describe('item-local incremental source writer', () => {
  it('roundtrips Brand inline JSON, preserves stable files and requires overwrite for edits', async () => {
    const project = await root();
    const route = 'cms/Marketing/brand';
    const item = brandProjection();
    const first = await writeEditableItemSource(project, route, item, false);
    expect(first.created).to.have.length(1);
    const loaded = await loadEditableBrandSource(first.definitionPath);
    expect(loaded.definition).to.deep.equal(item.definition);
    expect(loaded.contentBody).to.deep.equal(item.definition.contentBody);
    const folder = path.join(project, route);
    await writeFile(path.join(folder, 'Other.json'), 'keep');
    const before = await snapshot(folder);
    const repeated = await writeEditableItemSource(project, route, item, false);
    expect(repeated.unchanged).to.have.length(1);
    expect(await snapshot(folder)).to.deep.equal(before);
    const edited = structuredClone(item.definition);
    (edited.contentBody.colorScheme as Record<string, string>).primaryAccent = '#FF0000';
    await writeFile(first.definitionPath, JSON.stringify(edited));
    const local = await snapshot(folder);
    await failure(writeEditableItemSource(project, route, item, false), /overwrite/u);
    expect(await snapshot(folder)).to.deep.equal(local);
    const overwritten = await writeEditableItemSource(project, route, item, true);
    expect(overwritten.updated).to.deep.equal([first.definitionPath]);
    const restored = await loadEditableBrandSource(first.definitionPath);
    expect(restored.definition).to.deep.equal(item.definition);
    expect(await readFile(path.join(folder, 'Other.json'), 'utf8')).to.equal('keep');
  });

  it('rejects Brand projection schema, identity, filename and companion conflicts before writing', async () => {
    const project = await root();
    const route = 'cms/Marketing/brand';
    const item = brandProjection();
    for (const wrong of ['../escape', 'cms/Other/brand', 'cms/Marketing/email'])
      await failure(writeEditableItemSource(project, wrong, item, true), /directory/u);
    for (const invalid of [
      { ...item, definitionName: '../outside.json' },
      { ...item, definitionBytes: Buffer.from('{}') },
      {
        ...item,
        companions: [
          { role: 'rawHtml', path: 'Welcome.cms-brand.html', bytes: Buffer.from('bad') },
        ],
      },
      { ...item, definition: { ...item.definition, language: 'de_DE' } },
    ])
      await failure(
        writeEditableItemSource(project, route, invalid, true),
        /filename|definition|fields|bindings|version/u,
      );
    expect(await readdir(project)).to.deep.equal([]);
    const first = await writeEditableItemSource(project, route, item, false);
    const prior = structuredClone(item.definition);
    prior.language = 'de_DE';
    await writeFile(first.definitionPath, JSON.stringify(prior));
    const before = await snapshot(path.join(project, route));
    await failure(writeEditableItemSource(project, route, item, true), /conflict/u);
    expect(await snapshot(path.join(project, route))).to.deep.equal(before);
  });

  it('detaches Brand projection bytes and filenames before asynchronous writes', async () => {
    const project = await root();
    const item = brandProjection();
    const expected = Buffer.from(item.definitionBytes);
    const pending = writeEditableItemSource(project, 'cms/Marketing/brand', item, false);
    item.definitionBytes.fill(0);
    (item as { definitionName: string }).definitionName = '../outside.json';
    item.definition.identity.apiName = 'Changed';
    const receipt = await pending;
    expect(receipt.definitionPath).to.equal(
      path.join(project, 'cms/Marketing/brand/Welcome.cms-brand.json'),
    );
    expect(await readFile(receipt.definitionPath)).to.deep.equal(expected);
    expect(await readdir(project)).to.deep.equal(['cms']);
  });

  it('retains Brand file and route security checks', async () => {
    for (const kind of ['alias', 'directory', 'hardlink', 'junction']) {
      const project = await root();
      const route = 'cms/Marketing/brand';
      const item = brandProjection();
      if (kind === 'junction') {
        const outside = await root();
        await symlink(outside, path.join(project, 'cms'), 'junction');
        await failure(writeEditableItemSource(project, route, item, true), /symlink|reparse/u);
        expect(await readdir(outside)).to.deep.equal([]);
        continue;
      }
      const folder = path.join(project, route);
      await mkdir(folder, { recursive: true });
      const target = path.join(folder, item.definitionName);
      if (kind === 'alias')
        await writeFile(path.join(folder, item.definitionName.toLowerCase()), 'alias');
      if (kind === 'directory') await mkdir(target);
      if (kind === 'hardlink') {
        await writeFile(path.join(project, 'outside.txt'), 'keep');
        await link(path.join(project, 'outside.txt'), target);
      }
      await failure(
        writeEditableItemSource(project, route, item, true),
        /case-aliased|regular file|hard-linked/u,
      );
      expect(await readdir(folder)).to.have.length(1);
    }
  });
  it('writes Audio exact files, preserves unchanged mtimes and unrelated files, and guards overwrite and family mapping', async () => {
    const project = await root();
    const audioDirectory = 'cms/Marketing/audio';
    const bytes = Buffer.from('opaque non-WAV audio');
    const item = extractEditableMediaSource(
      {
        identity: {
          family: 'cms',
          type: 'Audio',
          apiName: 'Hero',
          context: { workspaceApiName: 'Marketing' },
        },
        contentType: 'sfdc_cms__audio',
        language: 'en_US',
        folderPath: [],
      },
      {
        'sfdc_cms:media': {
          source: { type: 'file', size: bytes.length, mimeType: 'audio/mpeg' },
          url: `/cms/media/key?fileName=hero.mp3&version=1.1&fileHash=${createHash('md5').update(bytes).digest('hex')}`,
        },
      },
      bytes,
    );
    for (const wrong of ['cms/Marketing/document', 'cms/Marketing/image'])
      await failure(writeEditableItemSource(project, wrong, item, true), /directory/u);
    const wrongFamily = structuredClone(item);
    wrongFamily.definition.identity.type = 'Document';
    wrongFamily.definitionBytes = Buffer.from(JSON.stringify(wrongFamily.definition));
    await failure(
      writeEditableItemSource(project, audioDirectory, wrongFamily, true),
      /identity|type/u,
    );
    expect(await readdir(project)).to.deep.equal([]);
    const first = await writeEditableItemSource(project, audioDirectory, item, false);
    const folder = path.join(project, audioDirectory);
    expect(first.created.map((name) => path.basename(name))).to.have.members([
      'Hero.cms-audio.json',
      'Hero.cms-audio.media.mp3',
    ]);
    const companion = path.join(folder, item.companions[0].path);
    expect(await readFile(companion)).to.deep.equal(bytes);
    await writeFile(path.join(folder, 'Other.cms-audio.media.mp3'), 'keep');
    const before = await snapshot(folder);
    const repeated = await writeEditableItemSource(project, audioDirectory, item, false);
    expect(repeated.unchanged).to.have.length(2);
    expect(await snapshot(folder)).to.deep.equal(before);
    await writeFile(companion, 'local edit');
    const edited = await snapshot(folder);
    await failure(writeEditableItemSource(project, audioDirectory, item, false), /overwrite/u);
    expect(await snapshot(folder)).to.deep.equal(edited);
    const overwritten = await writeEditableItemSource(project, audioDirectory, item, true);
    expect(overwritten.updated).to.deep.equal([companion]);
    expect(await readFile(companion)).to.deep.equal(bytes);
    expect(await readFile(path.join(folder, 'Other.cms-audio.media.mp3'), 'utf8')).to.equal('keep');
  });
  for (const prior of ['missing', 'url-only', 'other-extension'] as const) {
    it(`rejects differing undeclared media targets before any write with ${prior} ownership`, async () => {
      const project = await root();
      const mediaDirectory = 'cms/Marketing/image';
      const folder = path.join(project, mediaDirectory);
      await mkdir(folder, { recursive: true });
      if (prior !== 'missing')
        await writeEditableItemSource(
          project,
          mediaDirectory,
          mediaProjection(prior !== 'url-only', prior === 'other-extension'),
          false,
        );
      const item = mediaProjection();
      await writeFile(path.join(folder, item.companions[0].path), 'unowned local media');
      const before = await snapshot(folder);
      for (const overwrite of [false, true]) {
        await failure(
          writeEditableItemSource(project, mediaDirectory, item, overwrite),
          /ownership/u,
        );
        expect(await snapshot(folder)).to.deep.equal(before);
      }
    });
  }
  it('allows an owned media replacement and a transition to an absent destination', async () => {
    const project = await root();
    const mediaDirectory = 'cms/Marketing/image';
    const folder = path.join(project, mediaDirectory);
    const item = mediaProjection();
    await writeEditableItemSource(project, mediaDirectory, item, false);
    await writeFile(path.join(folder, item.companions[0].path), 'owned local edit');
    const replacement = await writeEditableItemSource(project, mediaDirectory, item, true);
    expect(replacement.updated).to.deep.equal([path.join(folder, item.companions[0].path)]);
    expect(await readFile(path.join(folder, item.companions[0].path))).to.deep.equal(
      item.companions[0].bytes,
    );
    const next = mediaProjection(true, true);
    const transition = await writeEditableItemSource(project, mediaDirectory, next, true);
    expect(transition.created).to.deep.equal([path.join(folder, next.companions[0].path)]);
    expect(transition.removed).to.deep.equal([path.join(folder, item.companions[0].path)]);
  });
  it('writes media independently, protects edits, and removes only a prior declared companion', async () => {
    const project = await root();
    const folder = path.join(project, 'cms/Marketing/image');
    const item = mediaProjection();
    const first = await writeEditableItemSource(project, 'cms/Marketing/image', item, false);
    expect(first.created).to.have.length(2);
    await writeFile(path.join(folder, 'Other.media.png'), 'unrelated');
    const before = await snapshot(folder);
    const repeated = await writeEditableItemSource(project, 'cms/Marketing/image', item, false);
    expect(repeated.unchanged).to.have.length(2);
    expect(await snapshot(folder)).to.deep.equal(before);
    await writeFile(path.join(folder, item.companions[0].path), 'local edit');
    await failure(
      writeEditableItemSource(project, 'cms/Marketing/image', item, false),
      /overwrite/u,
    );
    await writeEditableItemSource(project, 'cms/Marketing/image', item, true);
    const url = mediaProjection(false);
    await failure(
      writeEditableItemSource(project, 'cms/Marketing/image', url, false),
      /overwrite/u,
    );
    const converted = await writeEditableItemSource(project, 'cms/Marketing/image', url, true);
    expect(converted.removed).to.deep.equal([path.join(folder, item.companions[0].path)]);
    expect(await readFile(path.join(folder, 'Other.media.png'), 'utf8')).to.equal('unrelated');
  });
  it('rejects media directory, projection and ownership disagreement without broadening Email admission', async () => {
    const project = await root();
    const item = mediaProjection();
    await failure(writeEditableItemSource(project, directory, item, true), /directory/u);
    const bad = structuredClone(item);
    bad.companions[0].path = 'Other.png';
    await failure(writeEditableItemSource(project, 'cms/Marketing/image', bad, true), /bindings/u);
    await writeEditableItemSource(project, 'cms/Marketing/image', item, false);
    const prior = structuredClone(item.definition);
    prior.language = 'de_DE';
    await writeFile(
      path.join(project, 'cms/Marketing/image', item.definitionName),
      JSON.stringify(prior),
    );
    await failure(writeEditableItemSource(project, 'cms/Marketing/image', item, true), /language/u);
    const wrongFamily = projection();
    (wrongFamily.definition as unknown as Record<string, unknown>).contract = 'sf-cms-media-source';
    wrongFamily.definitionBytes = Buffer.from(JSON.stringify(wrongFamily.definition));
    await failure(
      writeEditableItemSource(project, directory, wrongFamily, true),
      /fields|contract/u,
    );
  });
  it('preserves unrelated project files and unchanged bytes and mtimes', async () => {
    const project = await root();
    const folder = path.join(project, directory);
    await mkdir(folder, { recursive: true });
    await writeFile(path.join(project, 'package.json'), '{"private":true}');
    await writeFile(path.join(folder, 'Other.cms-email.json'), 'other item');
    await writeFile(path.join(folder, 'notes.txt'), 'unrelated');
    const item = projection();
    const first = await writeEditableItemSource(project, directory, item, false);
    expect(first.created).to.have.length(3);
    expect(first.updated).to.deep.equal([]);
    const before = await snapshot(folder);
    const second = await writeEditableItemSource(project, directory, item, false);
    expect(second.unchanged).to.have.length(3);
    expect(second.created).to.deep.equal([]);
    expect(second.updated).to.deep.equal([]);
    expect(await snapshot(folder)).to.deep.equal(before);
    expect(await readFile(path.join(project, 'package.json'), 'utf8')).to.equal('{"private":true}');
  });

  it('preflights later conflicts before creating or replacing any file', async () => {
    const project = await root();
    const folder = path.join(project, directory);
    await mkdir(folder, { recursive: true });
    const item = projection();
    await writeFile(path.join(folder, item.companions[1].path), 'Local edit');
    const before = await snapshot(folder);
    await failure(writeEditableItemSource(project, directory, item, false), /overwrite/u);
    expect(await snapshot(folder)).to.deep.equal(before);
    const result = await writeEditableItemSource(project, directory, item, true);
    expect(result.created).to.have.length(2);
    expect(result.updated).to.deep.equal([path.join(folder, item.companions[1].path)]);
  });

  it('overwrites only selected differences and removes only proven obsolete text', async () => {
    const project = await root();
    const folder = path.join(project, directory);
    await writeEditableItemSource(project, directory, projection(), false);
    await writeFile(path.join(folder, 'Other.textContent.txt'), 'keep');
    const before = await snapshot(folder);
    const next = projection(false, '<p>Changed</p>');
    await failure(writeEditableItemSource(project, directory, next, false), /overwrite/u);
    expect(await snapshot(folder)).to.deep.equal(before);
    const receipt = await writeEditableItemSource(project, directory, next, true);
    expect(receipt.updated).to.have.length(2);
    expect(receipt.removed).to.deep.equal([path.join(folder, 'Welcome.cms-email.txt')]);
    expect(await readFile(path.join(folder, 'Other.textContent.txt'), 'utf8')).to.equal('keep');
    const repeated = await writeEditableItemSource(project, directory, next, true);
    expect(repeated.unchanged).to.have.length(2);
  });

  it('blocks ambiguous obsolete ownership and invalid prior definitions even with overwrite', async () => {
    for (const prior of [undefined, '{}', JSON.stringify(projection(false).definition)]) {
      const project = await root();
      const folder = path.join(project, directory);
      await mkdir(folder, { recursive: true });
      const item = projection(false);
      if (prior !== undefined) await writeFile(path.join(folder, item.definitionName), prior);
      await writeFile(path.join(folder, 'Welcome.cms-email.txt'), 'unknown owner');
      const before = await snapshot(folder);
      await failure(
        writeEditableItemSource(project, directory, item, true),
        /ownership|definition|version/u,
      );
      expect(await snapshot(folder)).to.deep.equal(before);
    }
  });

  it('rejects old companion bindings before overwriting any selected file', async () => {
    const project = await root();
    const folder = path.join(project, directory);
    const item = projection();
    await writeEditableItemSource(project, directory, item, false);
    const prior = structuredClone(item.definition);
    prior.companions[0].path = 'Welcome.cms-email.rawHtml.html';
    await writeFile(path.join(folder, item.definitionName), JSON.stringify(prior));
    await writeFile(path.join(folder, prior.companions[0].path), 'Old local HTML');
    const before = await snapshot(folder);
    await failure(writeEditableItemSource(project, directory, item, true), /same-stem/u);
    expect(await snapshot(folder)).to.deep.equal(before);
  });

  it('blocks prior filename/type/language identity conflicts before writes', async () => {
    for (const key of ['language', 'apiName', 'type'] as const) {
      const project = await root();
      const folder = path.join(project, directory);
      const item = projection();
      await writeEditableItemSource(project, directory, item, false);
      const prior = structuredClone(item.definition);
      if (key === 'language') prior.language = 'de_DE';
      if (key === 'apiName') {
        prior.identity.apiName = 'Other';
        prior.companions = prior.companions.map((entry) => ({
          ...entry,
          path: entry.path.replace('Welcome', 'Other'),
        }));
      }
      if (key === 'type') {
        prior.identity.type = 'Email Template';
        prior.contentType = 'sfdc_cms__emailTemplate';
        delete prior.contentBody.subjectLine;
        prior.companions = prior.companions.map((entry) => ({
          ...entry,
          path: entry.path.replace('cms-email.', 'cms-email-template.'),
        }));
      }
      await writeFile(path.join(folder, item.definitionName), JSON.stringify(prior));
      const before = await snapshot(folder);
      await failure(writeEditableItemSource(project, directory, item, true), /conflict/u);
      expect(await snapshot(folder)).to.deep.equal(before);
    }
  });

  it('rejects unsafe routes and inconsistent projection metadata without creating output', async () => {
    const project = await root();
    for (const route of [
      '../outside',
      '/cms/Marketing/email',
      String.raw`cms\Marketing\email`,
      'cms/Other/email',
      'cms/Marketing/email/..',
    ])
      await failure(writeEditableItemSource(project, route, projection(), true), /directory/u);
    await failure(writeEditableItemSource('', directory, projection(), true), /nonempty/u);
    const item = projection();
    await failure(
      writeEditableItemSource(
        project,
        directory,
        { ...item, definitionName: '../outside.json' },
        true,
      ),
      /filename/u,
    );
    await failure(
      writeEditableItemSource(
        project,
        directory,
        { ...item, definitionBytes: Buffer.from('{}') },
        true,
      ),
      /definition|version/u,
    );
    await failure(
      writeEditableItemSource(
        project,
        directory,
        { ...item, companions: item.companions.slice(0, 1) },
        true,
      ),
      /bindings/u,
    );
    expect(await readdir(project)).to.deep.equal([]);
  });

  it('rejects case aliases, directory files, and hard links without touching other selected files', async () => {
    for (const kind of ['alias', 'directory', 'hardlink']) {
      const project = await root();
      const folder = path.join(project, directory);
      await mkdir(folder, { recursive: true });
      const item = projection();
      const target = path.join(folder, item.companions[0].path);
      if (kind === 'alias')
        await writeFile(path.join(folder, item.companions[0].path.toLowerCase()), 'alias');
      if (kind === 'directory') await mkdir(target);
      if (kind === 'hardlink') {
        await writeFile(path.join(project, 'outside.txt'), 'outside');
        await link(path.join(project, 'outside.txt'), target);
      }
      await failure(
        writeEditableItemSource(project, directory, item, true),
        /case-aliased|regular file|hard-linked/u,
      );
      expect(await readdir(folder)).to.have.length(1);
    }
  });

  it('rejects symlinked directory routes using the existing filesystem guard', async () => {
    const project = await root();
    const outside = await root();
    await symlink(outside, path.join(project, 'cms'), 'junction');
    await failure(
      writeEditableItemSource(project, directory, projection(), true),
      /symlink|reparse/u,
    );
    expect(await readdir(outside)).to.deep.equal([]);
  });
});
