import { expect } from 'chai';
import { appendFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import sinon from 'sinon';
import {
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  inspectLifecycleLocalSource,
  deleteLifecycleLocalSource,
  synchronizeLifecycleLocalSource,
  type LifecycleLocalIdentity,
} from '../../src/services/lifecycle-local-source.js';
import { extractEditableItemSourceV2 } from '../../src/services/editable-item-source-v2.js';
import type { SourceDefinition } from '../../src/contracts/source-definition.js';

const identity: LifecycleLocalIdentity = {
  workspaceApiName: 'Marketing',
  contentType: 'sfdc_cms__email',
  apiName: 'Welcome',
  language: 'en_US',
};
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
    subjectLine: 'Authored subject',
    textContent: 'Authored text',
  },
  companions: { rawHtml: 'Welcome.cms-email.html' },
};

async function fixture(template = false, legacy = false) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cms-local-inspector-'));
  const source = structuredClone(definition);
  const selected = { ...identity };
  if (template) {
    source.contentType = selected.contentType = 'sfdc_cms__emailTemplate';
    source.identity.type = 'Email Template';
    source.companions.rawHtml = 'Welcome.cms-email-template.html';
  }
  const item = extractEditableItemSourceV2(source, '<p>Authored &amp; unchanged</p>');
  const directory = path.join(root, 'cms', 'Marketing', template ? 'emailTemplate' : 'email');
  await mkdir(directory, { recursive: true });
  const bytes = legacy ? Buffer.from(JSON.stringify(source)) : item.definitionBytes;
  await writeFile(path.join(directory, item.definitionName), bytes);
  for (const file of item.companions) await writeFile(path.join(directory, file.path), file.bytes);
  return { root, directory, selected, item, bytes };
}

async function blocked(root: string, selected = identity, pattern = /./u) {
  const result = await inspectLifecycleLocalSource(root, selected);
  expect(result.outcome).to.equal('blocked');
  if (result.outcome === 'blocked') expect(result.message).to.match(pattern);
}

describe('confirmed Template local lifecycle synchronization', () => {
  for (const outcome of ['published', 'unpublished'] as const)
    for (const legacy of [false, true])
      it(`preserves authored ${legacy ? 'legacy' : 'v2'} bytes after ${outcome}`, async () => {
        const f = await fixture(true, legacy);
        const inspection = await inspectLifecycleLocalSource(f.root, f.selected);
        const before = await Promise.all(
          [f.item.definitionName, ...f.item.companions.map((file) => file.path)].map(async (name) =>
            readFile(path.join(f.directory, name)),
          ),
        );
        expect(await synchronizeLifecycleLocalSource(f.root, inspection)).to.deep.equal({
          outcome: 'noop',
          reason: 'unconfirmed',
        });
        expect(
          await synchronizeLifecycleLocalSource(f.root, inspection, {
            outcome,
            identity: f.selected,
          }),
        ).to.deep.equal({ outcome: 'noop', reason: 'retrieval-equivalent' });
        const after = await Promise.all(
          [f.item.definitionName, ...f.item.companions.map((file) => file.path)].map(async (name) =>
            readFile(path.join(f.directory, name)),
          ),
        );
        expect(after).to.deep.equal(before);
      });

  it('never creates a missing copy or a missing root', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cms-local-sync-'));
    const missing = path.join(root, 'missing');
    const inspection = await inspectLifecycleLocalSource(missing, identity);
    expect(
      await synchronizeLifecycleLocalSource(missing, inspection, {
        outcome: 'published',
        identity,
      }),
    ).to.deep.equal({ outcome: 'noop', reason: 'missing-copy' });
    expect(await readdir(root)).to.deep.equal([]);
  });

  for (const drift of ['companion', 'definition', 'owner', 'missing', 'root'] as const)
    it(`reports local failure after confirmed remote success on ${drift} drift`, async () => {
      const f = await fixture(true);
      const inspection = await inspectLifecycleLocalSource(f.root, f.selected);
      const companion = path.join(f.directory, f.item.companions[0].path);
      let root = f.root;
      if (drift === 'companion') await writeFile(companion, '<p>Later authored edit</p>');
      if (drift === 'definition')
        await fs.appendFile(path.join(f.directory, f.item.definitionName), ' ');
      if (drift === 'owner')
        await writeFile(path.join(f.directory, 'Other.cms-email-template.json'), '{}');
      if (drift === 'missing') await fs.unlink(companion);
      if (drift === 'root') {
        const other = await fixture(true);
        root = other.root;
      }
      const result = await synchronizeLifecycleLocalSource(root, inspection, {
        outcome: 'unpublished',
        identity: f.selected,
      });
      expect(result.outcome).to.equal('blocked');
      expect(result.message).to.match(/changed/u);
      expect(await readdir(f.directory)).to.include(f.item.definitionName);
      if (drift === 'companion')
        expect(await readFile(companion, 'utf8')).to.equal('<p>Later authored edit</p>');
    });

  it('rejects mismatched remote identity and unproven alternate locales', async () => {
    const f = await fixture();
    const inspection = await inspectLifecycleLocalSource(f.root, identity);
    for (const key of ['workspaceApiName', 'apiName', 'language', 'contentType'] as const) {
      const result = await synchronizeLifecycleLocalSource(f.root, inspection, {
        outcome: 'published',
        identity: { ...identity, [key]: 'wrong' },
      });
      expect(result.outcome).to.equal('blocked');
      expect(result.message).to.match(/confirmation/u);
    }
    await writeFile(
      path.join(f.directory, f.item.definitionName),
      JSON.stringify({ ...f.item.definition, language: 'de_DE' }),
    );
    const alternate = { ...identity, language: 'de_DE' };
    const result = await synchronizeLifecycleLocalSource(
      f.root,
      await inspectLifecycleLocalSource(f.root, alternate),
      { outcome: 'published', identity: alternate },
    );
    expect(result.outcome).to.equal('blocked');
    expect(result.message).to.match(/not established/u);
  });

  it('does not reinterpret blocked ownership as a successful no-op', async () => {
    const f = await fixture(true);
    await writeFile(path.join(f.directory, 'Other.cms-email-template.json'), '{}');
    const inspection = await inspectLifecycleLocalSource(f.root, f.selected);
    expect(inspection.outcome).to.equal('blocked');
    const result = await synchronizeLifecycleLocalSource(f.root, inspection, {
      outcome: 'published',
      identity: f.selected,
    });
    expect(result.outcome).to.equal('blocked');
    expect(await readFile(path.join(f.directory, f.item.definitionName))).to.deep.equal(f.bytes);
  });
});

describe('bounded Email and binary media local synchronization', () => {
  for (const outcome of ['published', 'unpublished'] as const)
    for (const legacy of [false, true])
      it(`retains authored Email v${legacy ? 1 : 2} after ${outcome}`, async () => {
        const f = await fixture(false, legacy);
        const inspection = await inspectLifecycleLocalSource(f.root, identity);
        expect(
          await synchronizeLifecycleLocalSource(f.root, inspection, { outcome, identity }),
        ).to.deep.equal({ outcome: 'noop', reason: 'retrieval-equivalent' });
        expect(await readFile(path.join(f.directory, f.item.definitionName))).to.deep.equal(
          f.bytes,
        );
        expect(await readFile(path.join(f.directory, f.item.companions[0].path), 'utf8')).to.equal(
          '<p>Authored &amp; unchanged</p>',
        );
      });

  for (const [kind, type, mime] of [
    ['image', 'Image', 'image/png'],
    ['document', 'Document', 'text/plain'],
    ['audio', 'Audio', 'audio/x-wav'],
  ] as const)
    for (const scenario of [
      'published',
      'unpublished',
      'drift',
      'url-only',
      'mime',
      'locale',
      'owner',
    ] as const)
      it(`${kind} ${scenario} retains bytes and admits only the proven profile`, async () => {
        const root = await mkdtemp(path.join(os.tmpdir(), 'cms-local-sync-media-'));
        const directory = path.join(root, 'cms', 'Marketing', kind);
        await mkdir(directory, { recursive: true });
        const selected: LifecycleLocalIdentity = {
          ...identity,
          contentType: `sfdc_cms__${kind}`,
          language: scenario === 'locale' ? 'de_DE' : 'en_US',
        };
        const companion = `Welcome.cms-${kind}.media.bin`;
        const source = {
          contract: 'sf-cms-media-source',
          contractVersion: '1.0.0',
          identity: { ...definition.identity, type },
          contentType: selected.contentType,
          language: selected.language,
          folderPath: [],
          media:
            scenario === 'url-only'
              ? { representation: 'url-only', address: 'https://example.invalid/authored' }
              : {
                  representation: 'binary',
                  mimeType: scenario === 'mime' ? 'application/octet-stream' : mime,
                  companion: { role: 'media', path: companion },
                },
        };
        const definitionFile = path.join(directory, `Welcome.cms-${kind}.json`);
        const bytes = JSON.stringify(source);
        await writeFile(definitionFile, bytes);
        await writeFile(path.join(directory, companion), 'Authored local binary edits');
        await writeFile(path.join(directory, 'unrelated.txt'), 'retain shared unrelated file');
        const inspection = await inspectLifecycleLocalSource(root, selected);
        expect(inspection.outcome).to.equal('matched');
        if (scenario === 'drift') await fs.appendFile(path.join(directory, companion), ' later');
        if (scenario === 'owner')
          await writeFile(path.join(directory, `Other.cms-${kind}.json`), '{}');
        const result = await synchronizeLifecycleLocalSource(root, inspection, {
          outcome: scenario === 'unpublished' ? 'unpublished' : 'published',
          identity: selected,
        });
        expect(result.outcome).to.equal(
          ['published', 'unpublished'].includes(scenario) ? 'noop' : 'blocked',
        );
        expect(await readFile(definitionFile, 'utf8')).to.equal(bytes);
        expect(await readFile(path.join(directory, companion), 'utf8')).to.equal(
          'Authored local binary edits' + (scenario === 'drift' ? ' later' : ''),
        );
        expect(await readFile(path.join(directory, 'unrelated.txt'), 'utf8')).to.equal(
          'retain shared unrelated file',
        );
      });
});

describe('confirmed exact-file lifecycle local deletion', () => {
  const confirmation = { outcome: 'deleted' as const, identity };

  it('requires confirmation and treats the pre-remote missing copy as a noop', async () => {
    const f = await fixture();
    const inspected = await inspectLifecycleLocalSource(f.root, identity);
    const unconfirmed = await deleteLifecycleLocalSource(f.root, inspected);
    expect(unconfirmed.outcome).to.equal('noop');
    const absent = await inspectLifecycleLocalSource(f.root, { ...identity, apiName: 'Missing' });
    expect(
      await deleteLifecycleLocalSource(f.root, absent, {
        outcome: 'deleted',
        identity: absent.identity,
      }),
    ).to.deep.equal({ outcome: 'noop', removed: [], remaining: [] });
    const wrong = await deleteLifecycleLocalSource(f.root, inspected, {
      outcome: 'deleted',
      identity: { ...identity, language: 'de_DE' },
    });
    expect(wrong.outcome).to.equal('blocked');
    expect(await readFile(path.join(f.directory, f.item.definitionName))).to.deep.equal(f.bytes);
  });

  it('deletes captured authored files only, preserving directories, reports and other locales', async () => {
    const f = await fixture(false, true);
    const preserved = ['Welcome.cms-email.txt', 'report.json', 'Welcome.de_DE.html'];
    for (const name of preserved) await writeFile(path.join(f.directory, name), 'keep');
    await mkdir(path.join(f.directory, 'nested'));
    await writeFile(path.join(f.directory, 'nested', 'report.json'), 'keep');
    const inspected = await inspectLifecycleLocalSource(f.root, identity);
    const result = await deleteLifecycleLocalSource(f.root, inspected, confirmation);
    expect(result.outcome).to.equal('deleted');
    expect(result.remaining).to.deep.equal([]);
    expect(result.removed).to.deep.equal([
      path.join(f.directory, f.item.companions[0].path),
      path.join(f.directory, f.item.definitionName),
    ]);
    const listing = await readdir(f.directory);
    expect(listing.toSorted()).to.deep.equal([...preserved, 'nested'].toSorted());
    expect(await readFile(path.join(f.directory, 'nested', 'report.json'), 'utf8')).to.equal(
      'keep',
    );
  });

  for (const mutation of [
    'bytes',
    'metadata',
    'hardlink',
    'junction',
    'owner',
    'identity',
    'root',
  ] as const)
    it(`blocks ${mutation} drift without deleting anything`, async () => {
      const f = await fixture();
      const inspected = await inspectLifecycleLocalSource(f.root, identity);
      const target = path.join(f.directory, f.item.companions[0].path);
      let root = f.root;
      if (mutation === 'bytes') await writeFile(target, '<p>New authored edit</p>');
      if (mutation === 'metadata') await fs.utimes(target, new Date(0), new Date(0));
      if (mutation === 'hardlink') await link(target, path.join(f.root, 'linked.html'));
      if (mutation === 'junction') {
        await rename(target, path.join(f.root, 'saved.html'));
        await symlink(f.root, target, 'junction');
      }
      if (mutation === 'owner')
        await writeFile(path.join(f.directory, 'Other.cms-email.json'), '{}');
      if (mutation === 'identity')
        await writeFile(
          path.join(f.directory, f.item.definitionName),
          JSON.stringify({
            ...f.item.definition,
            language: 'de_DE',
          }),
        );
      if (mutation === 'root') {
        const other = await fixture();
        root = other.root;
      }
      const result = await deleteLifecycleLocalSource(root, inspected, confirmation);
      expect(result.outcome).to.equal('blocked');
      expect(result.removed).to.deep.equal([]);
      expect(await readdir(f.directory)).to.include(f.item.definitionName);
      if (mutation === 'bytes')
        expect(await readFile(target, 'utf8')).to.equal('<p>New authored edit</p>');
    });

  it('retains captured independent owners and blocks their subsequent byte drift', async () => {
    for (const drift of [false, true]) {
      const f = await fixture();
      const other = structuredClone(f.item.definition);
      other.identity.apiName = 'Other';
      other.companions = other.companions.map((entry) => ({
        ...entry,
        path: entry.path.replace('Welcome', 'Other'),
      }));
      const owner = path.join(f.directory, 'Other.cms-email.json');
      await writeFile(owner, JSON.stringify(other));
      const inspected = await inspectLifecycleLocalSource(f.root, identity);
      if (drift) await fs.appendFile(owner, ' ');
      const result = await deleteLifecycleLocalSource(f.root, inspected, confirmation);
      expect(result.outcome).to.equal(drift ? 'blocked' : 'deleted');
      expect(await readFile(owner, 'utf8')).to.equal(JSON.stringify(other) + (drift ? ' ' : ''));
    }
  });

  it('removes all v2 companions and the definition last', async () => {
    const f = await fixture();
    const inspected = await inspectLifecycleLocalSource(f.root, identity);
    const result = await deleteLifecycleLocalSource(f.root, inspected, confirmation);
    expect(result.outcome).to.equal('deleted');
    expect(result.removed).to.deep.equal([
      ...f.item.companions.map((file) => path.join(f.directory, file.path)),
      path.join(f.directory, f.item.definitionName),
    ]);
    expect(await readdir(f.directory)).to.deep.equal([]);
  });

  it('blocks a pre-remote blocked inspection even with confirmation', async () => {
    const f = await fixture();
    await writeFile(path.join(f.directory, f.item.definitionName), '{}');
    const inspected = await inspectLifecycleLocalSource(f.root, identity);
    const result = await deleteLifecycleLocalSource(f.root, inspected, confirmation);
    expect(result.outcome).to.equal('blocked');
    expect(result.removed).to.deep.equal([]);
  });

  it('reports an exact removed prefix on IO failure, without rollback or retry', async () => {
    const f = await fixture();
    const inspected = await inspectLifecycleLocalSource(f.root, identity);
    const original = fs.unlink;
    const stub = sinon.stub(fs, 'unlink');
    stub.onFirstCall().callsFake(original);
    stub.onSecondCall().rejects(new Error('Injected IO failure'));
    try {
      const result = await deleteLifecycleLocalSource(f.root, inspected, confirmation);
      expect(result.outcome).to.equal('partial');
      expect(result.removed).to.deep.equal([path.join(f.directory, f.item.companions[0].path)]);
      expect(result.remaining).to.deep.equal([
        path.join(f.directory, f.item.companions[1].path),
        path.join(f.directory, f.item.definitionName),
      ]);
      expect(result.message).to.equal('Injected IO failure');
      expect(stub.callCount).to.equal(2);
      expect(await readFile(path.join(f.directory, f.item.definitionName))).to.deep.equal(f.bytes);
    } finally {
      stub.restore();
    }
  });

  for (const mutation of ['bytes', 'owner', 'hardlink', 'junction'] as const)
    it(`rechecks ${mutation} drift between individual unlinks`, async () => {
      const f = await fixture();
      const inspected = await inspectLifecycleLocalSource(f.root, identity);
      const original = fs.unlink;
      const edited = path.join(f.directory, f.item.companions[1].path);
      const stub = sinon.stub(fs, 'unlink').callsFake(async (target) => {
        await original(target);
        if (mutation === 'owner')
          await writeFile(path.join(f.directory, 'Other.cms-email.json'), '{}');
        if (mutation === 'bytes') await writeFile(edited, 'Later authored text');
        if (mutation === 'hardlink') await link(edited, path.join(f.root, 'linked.txt'));
        if (mutation === 'junction') {
          await rename(f.directory, path.join(f.root, 'saved'));
          await symlink(path.join(f.root, 'saved'), f.directory, 'junction');
        }
      });
      try {
        const result = await deleteLifecycleLocalSource(f.root, inspected, confirmation);
        expect(result.outcome).to.equal('partial');
        expect(result.removed).to.have.length(1);
        expect(stub.callCount).to.equal(1);
        if (mutation === 'bytes')
          expect(await readFile(edited, 'utf8')).to.equal('Later authored text');
      } finally {
        stub.restore();
      }
    });
});

describe('read-only lifecycle local source inspection', () => {
  for (const template of [false, true])
    for (const legacy of [false, true]) {
      it(`snapshots authored ${template ? 'Template' : 'Email'} v${legacy ? 1 : 2} without remote provenance or byte equality`, async () => {
        const f = await fixture(template, legacy);
        await writeFile(path.join(f.directory, 'unrelated.txt'), 'keep');
        const result = await inspectLifecycleLocalSource(f.root, f.selected);
        expect(result.outcome).to.equal('matched');
        if (result.outcome !== 'matched') return;
        expect(result.identity).to.deep.equal(f.selected);
        expect(result.identity).not.to.equal(f.selected);
        expect(result.definition.path).to.equal(path.join(f.directory, f.item.definitionName));
        expect(result.definition.bytes).to.deep.equal(f.bytes);
        expect(result.companions).to.have.length(legacy ? 1 : 2);
        expect(result.definition.ino).to.be.a('number');
        result.definition.bytes.fill(0);
        result.identity.apiName = 'Detached';
        expect(await readFile(path.join(f.directory, f.item.definitionName))).to.deep.equal(
          f.bytes,
        );
        expect(f.selected.apiName).to.equal('Welcome');
        expect(await readFile(path.join(f.directory, 'unrelated.txt'), 'utf8')).to.equal('keep');
      });
    }

  for (const [kind, type] of [
    ['image', 'Image'],
    ['document', 'Document'],
    ['audio', 'Audio'],
  ] as const) {
    for (const binary of [false, true])
      it(`inspects ${kind} ${binary ? 'binary' : 'URL-only'} without deployment admission`, async () => {
        const root = await mkdtemp(path.join(os.tmpdir(), 'cms-local-media-'));
        const directory = path.join(root, 'cms', 'Marketing', kind);
        await mkdir(directory, { recursive: true });
        const file = `Welcome.cms-${kind}.media.bin`;
        const media = {
          contract: 'sf-cms-media-source',
          contractVersion: '1.0.0',
          identity: { ...definition.identity, type },
          contentType: `sfdc_cms__${kind}`,
          language: 'en_US',
          folderPath: [],
          media: binary
            ? {
                representation: 'binary',
                mimeType: 'application/octet-stream',
                companion: { role: 'media', path: file },
              }
            : { representation: 'url-only', address: 'https://example.invalid/authored' },
        };
        await writeFile(path.join(directory, `Welcome.cms-${kind}.json`), JSON.stringify(media));
        await writeFile(path.join(directory, file), 'authored opaque bytes');
        const result = await inspectLifecycleLocalSource(root, {
          ...identity,
          contentType: `sfdc_cms__${kind}`,
        });
        expect(result.outcome).to.equal('matched');
        if (result.outcome === 'matched') expect(result.companions).to.have.length(binary ? 1 : 0);
        expect(await readFile(path.join(directory, file), 'utf8')).to.equal(
          'authored opaque bytes',
        );
      });
  }

  it('returns absent for missing canonical roots, directories and definitions without creation', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cms-local-absent-'));
    for (const selectedRoot of [root, path.join(root, 'missing')]) {
      const result = await inspectLifecycleLocalSource(selectedRoot, identity);
      expect(result.outcome).to.equal('absent');
    }
    expect(await readdir(root)).to.deep.equal([]);
    const f = await fixture();
    const missing = await inspectLifecycleLocalSource(f.root, { ...identity, apiName: 'Missing' });
    expect(missing.outcome).to.equal('absent');
  });

  it('does not authorize an undeclared same-stem text companion', async () => {
    const f = await fixture(false, true);
    const result = await inspectLifecycleLocalSource(f.root, identity);
    expect(result.outcome).to.equal('matched');
    if (result.outcome === 'matched')
      expect(result.companions.map((file) => path.basename(file.path))).to.deep.equal([
        'Welcome.cms-email.html',
      ]);
  });

  it('blocks missing declared files, malformed present definitions and missing required companions', async () => {
    const f = await fixture();
    await rename(
      path.join(f.directory, f.item.companions[0].path),
      path.join(f.directory, 'saved.html'),
    );
    await blocked(f.root, identity, /missing/u);
    await writeFile(path.join(f.directory, f.item.definitionName), '{');
    await blocked(f.root);
    const malformed = structuredClone(f.item.definition);
    malformed.companions = [];
    await writeFile(path.join(f.directory, f.item.definitionName), JSON.stringify(malformed));
    await blocked(f.root, identity, /required/u);
  });

  it('blocks workspace/type/API-name/language conflicts and path escapes', async () => {
    const f = await fixture();
    await blocked(f.root, { ...identity, language: 'de_DE' }, /language/u);
    for (const field of ['workspaceApiName', 'apiName', 'language'] as const)
      await blocked(f.root, { ...identity, [field]: '../escape' }, /segment/u);
    await blocked(`${f.root}/../${path.basename(f.root)}`, identity, /Unsafe/u);
    await blocked(
      f.root,
      { ...identity, contentType: 'sfdc_cms__brand' } as LifecycleLocalIdentity,
      /Unsupported/u,
    );
    for (const mutation of [
      { identity: { ...f.item.definition.identity, context: { workspaceApiName: 'Other' } } },
      { identity: { ...f.item.definition.identity, apiName: 'Other' } },
      { companions: [{ role: 'rawHtml', path: '../escape.html' }] },
    ]) {
      await writeFile(
        path.join(f.directory, f.item.definitionName),
        JSON.stringify({ ...f.item.definition, ...mutation }),
      );
      await blocked(f.root);
    }
  });

  it('blocks case-aliased directory routes, definitions and companions', async () => {
    const f = await fixture();
    await rename(
      path.join(f.directory, f.item.definitionName),
      path.join(f.directory, f.item.definitionName.toLowerCase()),
    );
    await blocked(f.root, identity, /case-aliased/u);
    await rename(
      path.join(f.directory, f.item.definitionName.toLowerCase()),
      path.join(f.directory, f.item.definitionName),
    );
    await rename(
      path.join(f.directory, f.item.companions[0].path),
      path.join(f.directory, f.item.companions[0].path.toLowerCase()),
    );
    await blocked(f.root, identity, /case-aliased/u);
    const other = await fixture();
    await rename(
      path.join(other.root, 'cms', 'Marketing'),
      path.join(other.root, 'cms', 'marketing'),
    );
    await blocked(other.root, identity, /case-aliased/u);
  });

  it('rejects selected hard links and directory junctions without following them', async () => {
    const f = await fixture();
    await link(path.join(f.directory, f.item.definitionName), path.join(f.root, 'hardlink.json'));
    await blocked(f.root, identity, /linked/u);
    const other = await fixture();
    const junction = path.join(other.root, 'junction');
    await symlink(other.directory, junction, 'junction');
    await blocked(junction, identity, /symlink|reparse/u);
    const third = await fixture();
    await link(
      path.join(third.directory, third.item.companions[0].path),
      path.join(third.root, 'hardlink.html'),
    );
    await blocked(third.root, identity, /linked/u);
  });

  it('blocks ambiguous owner definitions, including malformed shared companion claims', async () => {
    const f = await fixture();
    const other = {
      ...f.item.definition,
      identity: { ...f.item.definition.identity, apiName: 'Other' },
    };
    await writeFile(path.join(f.directory, 'Other.cms-email.json'), JSON.stringify(other));
    await blocked(f.root, identity, /same-stem/u);
    await writeFile(path.join(f.directory, 'Other.cms-email.json'), '{}');
    await blocked(f.root);
  });

  it('ignores unrelated nested directories without recursing', async () => {
    const f = await fixture();
    const nested = path.join(f.directory, 'nested');
    await mkdir(nested);
    await writeFile(path.join(nested, 'Other.cms-email.json'), '{}');
    const result = await inspectLifecycleLocalSource(f.root, identity);
    expect(result.outcome).to.equal('matched');
  });

  it('accepts independent valid owners but blocks filename/type conflicts', async () => {
    const f = await fixture();
    const other = structuredClone(f.item.definition);
    other.identity.apiName = 'Other';
    other.companions = other.companions.map((entry) => ({
      ...entry,
      path: entry.path.replace('Welcome', 'Other'),
    }));
    await writeFile(path.join(f.directory, 'Other.cms-email.json'), JSON.stringify(other));
    const result = await inspectLifecycleLocalSource(f.root, identity);
    expect(result.outcome).to.equal('matched');
    await rename(
      path.join(f.directory, 'Other.cms-email.json'),
      path.join(f.directory, 'Wrong.cms-email.json'),
    );
    await blocked(f.root, identity, /canonical/u);
  });

  it('rejects malformed authored companion bytes without changing them', async () => {
    for (const legacy of [false, true]) {
      const f = await fixture(false, legacy);
      for (const bytes of [Buffer.from([255]), Buffer.from('\uFEFF<p>BOM</p>')]) {
        await writeFile(path.join(f.directory, f.item.companions[0].path), bytes);
        await blocked(f.root);
        expect(await readFile(path.join(f.directory, f.item.companions[0].path))).to.deep.equal(
          bytes,
        );
      }
    }
  });

  it('blocks observed junctions in canonical directories and selected file positions', async () => {
    const f = await fixture();
    const saved = path.join(f.root, 'saved');
    await rename(f.directory, saved);
    await symlink(saved, f.directory, 'junction');
    await blocked(f.root, identity, /symlink|reparse/u);
    const other = await fixture();
    const definitionFile = path.join(other.directory, other.item.definitionName);
    await rename(definitionFile, path.join(other.root, 'saved.json'));
    await symlink(other.root, definitionFile, 'junction');
    await blocked(other.root, identity, /regular|linked/u);
  });

  it('blocks byte drift discovered by final snapshot revalidation', async () => {
    const f = await fixture();
    const original = TextDecoder.prototype.decode;
    let changed = false;
    const stub = sinon.stub(TextDecoder.prototype, 'decode').callsFake(function (
      this: TextDecoder,
      ...args: Parameters<TextDecoder['decode']>
    ) {
      const decoded = original.apply(this, args);
      if (!changed && decoded.includes('Authored &amp; unchanged')) {
        changed = true;
        appendFileSync(path.join(f.directory, f.item.definitionName), ' ');
      }
      return decoded;
    });
    try {
      await blocked(f.root, identity, /changed/u);
      expect(changed).to.equal(true);
    } finally {
      stub.restore();
    }
  });

  it('returns blocked for non-directory selected roots', async () => {
    const f = await fixture();
    await blocked(path.join(f.directory, f.item.definitionName), identity, /regular directories/u);
  });
});
