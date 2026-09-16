import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { expect } from 'chai';
import { exportWorkspace } from '../../src/services/export-workspace.js';
import { loadEditableRawHtml } from '../../src/services/editable-raw-html-import.js';
import { loadWorkspaceExport } from '../../src/services/import-workspace.js';
import { planNativeCopies } from '../../src/services/import-identities.js';

const digest = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex');

const htmlFile = (directory: string, id = 'a'): string => path.join(directory, `items/${id}.html`);

describe('editable raw HTML verified loading', () => {
  let root: string;
  let sourceDirectory: string;
  let editableDirectory: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'cms-editable-import-'));
    sourceDirectory = path.join(root, 'source');
    editableDirectory = path.join(root, 'editable');
    const variants = [
      ['a', 'email-key', 'en', 'sfdc_cms__email'],
      ['b', 'email-key', 'de', 'sfdc_cms__email'],
      ['c', 'template-key', 'en', 'sfdc_cms__emailTemplate'],
      ['d', 'other-key', 'en', 'sfdc_cms__news'],
    ];
    const raw = variants.map(([id, contentKey, language, contentType]) => ({
      managedContentVariantId: id,
      managedContentId: `parent-${contentKey}`,
      contentKey,
      language,
      contentType: { fullyQualifiedName: contentType, name: 'summary retained' },
      contentSpace: { id: 'space' },
      externalId: null,
      externalSource: null,
      title: 'Original title',
      apiName: `api_${contentKey}`,
      contentBody: {
        'sfdc_cms:title': 'Original title',
        subjectLine: 'Original subject',
        messagePurpose: 'Transactional',
        rawHtml: `&lt;p&gt;Café ${id}&lt;/p&gt;`,
      },
    }));
    const request = (({ url }: { url: string }) =>
      Object.assign(
        Promise.resolve(
          url.startsWith('/connect/cms/items/search')
            ? {
                items: variants.map(([id]) => ({
                  id,
                  managedContentSpaceId: 'space',
                  type: 'ManagedContentVariantSearchResultRepresentation',
                })),
                total: variants.length,
              }
            : raw.find((item) => url.endsWith(`/${item.managedContentVariantId}`)),
        ),
        { stream: () => new PassThrough() },
      )) as Parameters<typeof exportWorkspace>[0]['request'];
    await exportWorkspace({ request }, 'space', sourceDirectory, { editableDirectory });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('accepts only literal HTML edits, preserves normalized metadata, and returns detached selected siblings', async () => {
    const source = await loadWorkspaceExport(sourceDirectory);
    const snapshot = structuredClone(source);
    const edited = '<p>Edited 世界 &lt;literal&gt;</p>\r\n';
    await writeFile(htmlFile(editableDirectory, 'b'), edited);
    const result = await loadEditableRawHtml(source, editableDirectory, ['b', 'c']);
    expect(result.items.map((item) => [item.id, item.contentKey, item.language])).to.deep.equal([
      ['b', 'email-key', 'de'],
      ['c', 'template-key', 'en'],
    ]);
    expect(result.items[0].contentBody).to.deep.equal({
      ...source.items[1].contentBody,
      rawHtml: edited,
    });
    expect(result.items[0].contentSpace).not.to.equal(source.items[1].contentSpace);
    expect(result.literalHtmlVariantIds).to.deep.equal(new Set(['b', 'c']));
    expect(result.editableSource.entries).to.have.length(3);
    expect(result.editableSource.entries.find((entry) => entry.variantId === 'b')).to.deep.equal({
      variantId: 'b',
      originalHtmlSha256: digest('<p>Café b</p>'),
      currentHtmlSha256: digest(edited),
      changed: true,
    });
    expect(result.editableSource.sourceManifestSha256).to.equal(source.manifestSha256);
    expect(source).to.deep.equal(snapshot);
    expect(await loadWorkspaceExport(sourceDirectory)).to.deep.equal(source);
  });

  it('matches legacy native payloads when unchanged and never decodes literal sidecars twice', async () => {
    const source = await loadWorkspaceExport(sourceDirectory);
    const mapping = [
      { sourceContentKey: 'email-key', language: 'en', apiName: 'new_api', urlName: 'new-url' },
    ];
    const unchanged = await loadEditableRawHtml(source, editableDirectory);
    expect(
      planNativeCopies(
        { ...source, items: unchanged.items },
        mapping,
        unchanged.literalHtmlVariantIds,
      ),
    ).to.deep.equal(planNativeCopies(source, mapping));
    // Literal text that happens to look GET-encoded must remain text, not become an element.
    await writeFile(htmlFile(editableDirectory), '&lt;p&gt;literal text&lt;/p&gt;');
    const edited = await loadEditableRawHtml(source, editableDirectory);
    const proposal = planNativeCopies(
      { ...source, items: edited.items },
      mapping,
      edited.literalHtmlVariantIds,
    );
    expect(proposal.items[0].contentBody.rawHtml).to.equal('&lt;p&gt;literal text&lt;/p&gt;');
    expect(planNativeCopies(source, mapping).items[0].contentBody.rawHtml).to.equal(
      '<p>Café a</p>',
    );
    await writeFile(htmlFile(editableDirectory), '<img src="unsafe">');
    const opaque = await loadEditableRawHtml(source, editableDirectory);
    expect(
      planNativeCopies({ ...source, items: opaque.items }, mapping, opaque.literalHtmlVariantIds)
        .items[0].contentBody.rawHtml,
    ).to.equal('<img src="unsafe">');
  });

  it('rejects metadata changes even if editable metadata checksums are recomputed', async () => {
    const source = await loadWorkspaceExport(sourceDirectory);
    const file = path.join(editableDirectory, 'items/a.json');
    const original = await readFile(file, 'utf8');
    const changed = original.replace('Original subject', 'Changed subject');
    await writeFile(file, changed);
    await expectFailure(loadEditableRawHtml(source, editableDirectory), /metadata.*differs/u);
    const descriptorFile = path.join(editableDirectory, 'editable.json');
    const descriptor = JSON.parse(await readFile(descriptorFile, 'utf8')) as {
      entries: { variantId: string; metadataSha256: string }[];
    };
    descriptor.entries[0].metadataSha256 = digest(changed);
    await writeFile(descriptorFile, JSON.stringify(descriptor));
    await expectFailure(loadEditableRawHtml(source, editableDirectory), /descriptor.*baseline/u);
  });

  it('rejects foreign baselines, descriptor edits, duplicate IDs, and substituted paths', async () => {
    const source = await loadWorkspaceExport(sourceDirectory);
    const file = path.join(editableDirectory, 'editable.json');
    const original = await readFile(file, 'utf8');
    const descriptor = JSON.parse(original) as { entries: Record<string, unknown>[] };
    for (const changed of [
      { ...descriptor, sourceManifestSha256: 'f'.repeat(64) },
      { ...descriptor, contractVersion: '2.0.0' },
      { ...descriptor, entries: [...descriptor.entries, descriptor.entries[0]] },
      {
        ...descriptor,
        entries: [
          { ...descriptor.entries[0], variantId: '../escape' },
          ...descriptor.entries.slice(1),
        ],
      },
      { ...descriptor, path: '../elsewhere' },
    ]) {
      await writeFile(file, JSON.stringify(changed));
      await expectFailure(loadEditableRawHtml(source, editableDirectory), /descriptor.*baseline/u);
    }
    await writeFile(file, original);
    await expectFailure(loadEditableRawHtml(source, editableDirectory, ['d']), /missing from/u);
    await expectFailure(loadEditableRawHtml(source, editableDirectory, ['a', 'a']), /Duplicate/u);
  });

  it('rejects missing and unlisted companion files and observes tamper in unselected original items', async () => {
    const source = await loadWorkspaceExport(sourceDirectory);
    const file = htmlFile(editableDirectory, 'b');
    const bytes = await readFile(file);
    await rm(file);
    await expectFailure(
      loadEditableRawHtml(source, editableDirectory, ['a']),
      /missing.*unlisted/u,
    );
    await writeFile(file, bytes);
    const extra = path.join(editableDirectory, 'extra.html');
    await writeFile(extra, 'extra');
    await expectFailure(loadEditableRawHtml(source, editableDirectory), /unlisted/u);
    await rm(extra);
    await writeFile(path.join(sourceDirectory, 'items/d.json'), '{}');
    await expectFailure(loadEditableRawHtml(source, editableDirectory, ['a']), /SHA-256/u);
  });

  it('rejects changed original manifests and unsupported UTF-8 or BOM HTML', async () => {
    const source = await loadWorkspaceExport(sourceDirectory);
    for (const bytes of [Buffer.from([195, 40]), Buffer.from('\uFEFF<p>BOM</p>')]) {
      await writeFile(htmlFile(editableDirectory), bytes);
      await expectFailure(loadEditableRawHtml(source, editableDirectory), /UTF-8/u);
    }
    const manifestFile = path.join(sourceDirectory, 'manifest.json');
    await writeFile(manifestFile, `${await readFile(manifestFile, 'utf8')}\n`);
    await expectFailure(loadEditableRawHtml(source, editableDirectory), /manifest changed/u);
  });

  it('rejects unsafe directory spellings and junctions at root, ancestor, or items paths', async () => {
    const source = await loadWorkspaceExport(sourceDirectory);
    for (const directory of [
      `${editableDirectory}/../editable`,
      `${editableDirectory}/CON`,
      `${editableDirectory}:stream`,
    ]) {
      await expectFailure(loadEditableRawHtml(source, directory), /Unsafe/u);
    }
    const alias = path.join(root, 'alias');
    await symlink(editableDirectory, alias, 'junction');
    await expectFailure(loadEditableRawHtml(source, alias), /symlink|reparse/u);
    await expectFailure(loadEditableRawHtml(source, path.join(alias, 'items')), /symlink|reparse/u);
    const items = path.join(editableDirectory, 'items');
    const moved = path.join(root, 'moved-items');
    await rename(items, moved);
    await symlink(moved, items, 'junction');
    await expectFailure(loadEditableRawHtml(source, editableDirectory), /symlink|reparse/u);
  });
});

async function expectFailure(promise: Promise<unknown>, message: RegExp): Promise<void> {
  let failure: unknown;
  try {
    await promise;
  } catch (error) {
    failure = error;
  }
  expect(failure).to.be.instanceOf(Error);
  expect((failure as Error).message).to.match(message);
}
