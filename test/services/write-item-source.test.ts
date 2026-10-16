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

describe('item-local incremental source writer', () => {
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
