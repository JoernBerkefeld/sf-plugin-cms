import { expect } from 'chai';
import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  serializeSourceDefinition,
  type SourceDefinition,
} from '../../src/contracts/source-definition.js';
import {
  loadEditableBrandSource,
  loadEditableItemSource,
  reassembleEditableItemSource,
} from '../../src/services/editable-item-source.js';
import { projectSourceDefinitions } from '../../src/services/source-definition.js';
import { brandBody } from '../fixtures/brand.js';

function definition(template = false): SourceDefinition {
  return {
    contract: 'sf-cms-source-definition',
    contractVersion: '1.0.0',
    identity: {
      family: 'cms',
      type: template ? 'Email Template' : 'Email',
      apiName: 'Welcome',
      context: { workspaceApiName: 'Marketing' },
    },
    contentType: template ? 'sfdc_cms__emailTemplate' : 'sfdc_cms__email',
    contentBody: {
      'sfdc_cms:title': 'Café 世界',
      messagePurpose: 'Transactional',
      ...(template ? {} : { subjectLine: 'Hello' }),
      'lightning:expressions': [],
    },
    language: 'en_US',
    title: 'Café 世界',
    folderPath: ['Campaigns'],
    companions: { rawHtml: `Welcome.cms-${template ? 'email-template' : 'email'}.html` },
  };
}

async function fixture(
  candidate = definition(),
  html: string | Buffer = '<p>Café &amp; 世界</p>\n',
) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'cms-editable-item-'));
  const json = path.join(directory, candidate.companions.rawHtml!.replace(/\.html$/u, '.json'));
  await writeFile(json, serializeSourceDefinition(candidate));
  await writeFile(path.join(directory, candidate.companions.rawHtml!), html);
  return { directory, json };
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

function brandDefinition(): SourceDefinition {
  const title = 'Edited Café Brand';
  return {
    ...definition(),
    identity: { ...definition().identity, type: 'Brand' },
    contentType: 'sfdc_cms__brand',
    title,
    contentBody: brandBody(title) as SourceDefinition['contentBody'],
    companions: {},
  };
}

async function brandFixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'cms-editable-brand-'));
  const json = path.join(directory, 'Welcome.cms-brand.json');
  const candidate = brandDefinition();
  await writeFile(json, serializeSourceDefinition(candidate));
  return { directory, json, candidate };
}

describe('standalone editable Brand source', () => {
  it('loads edited inline JSON without a baseline or companions and detaches nested bodies', async () => {
    const { directory, json, candidate } = await brandFixture();
    candidate.contentBody.colorScheme = {
      ...(candidate.contentBody.colorScheme as Record<string, string>),
      primaryAccent: '#FF0000',
    };
    await writeFile(json, serializeSourceDefinition(candidate));
    await writeFile(path.join(directory, 'unrelated.json'), '{}');
    const loaded = await loadEditableBrandSource(json);
    expect(loaded.definitionPath).to.equal(json);
    expect(loaded.definition).to.deep.equal(candidate);
    expect(loaded.contentBody).to.deep.equal(candidate.contentBody);
    (loaded.contentBody.colorScheme as Record<string, string>).primaryAccent = '#000000';
    expect(loaded.definition.contentBody).to.deep.equal(candidate.contentBody);
    const again = await loadEditableBrandSource(json);
    expect(again.definition).to.deep.equal(candidate);
    expect(again.contentBody).to.deep.equal(candidate.contentBody);
  });

  it('requires exact Brand identity, same-stem filename and no companion or extra fields', async () => {
    const { directory, json, candidate } = await brandFixture();
    for (const invalid of [
      definition(),
      { ...candidate, identity: { ...candidate.identity, type: 'Email' } },
      { ...candidate, companions: { rawHtml: 'Welcome.cms-brand.html' } },
      { ...candidate, sourceManifestSha256: 'old-baseline' },
      { ...candidate, contentBody: { ...candidate.contentBody, unsupported: true } },
    ]) {
      await writeFile(json, JSON.stringify(invalid));
      await failure(loadEditableBrandSource(json), /Brand|fields|body|disagreement/u);
    }
    await writeFile(
      path.join(directory, 'Other.cms-brand.json'),
      serializeSourceDefinition(candidate),
    );
    await failure(
      loadEditableBrandSource(path.join(directory, 'Other.cms-brand.json')),
      /same-stem/u,
    );
    await writeFile(json, serializeSourceDefinition(candidate));
    await failure(
      loadEditableBrandSource(path.join(directory, 'welcome.cms-brand.json')),
      /case-aliased/u,
    );
  });

  it('rejects malformed JSON, invalid UTF-8, BOM and duplicate keys', async () => {
    const { json } = await brandFixture();
    for (const bytes of [
      Buffer.from([195, 0x28]),
      Buffer.from('\uFEFF{}'),
      Buffer.from('{"contract":1,"contract":2}'),
      Buffer.from('{'),
    ]) {
      await writeFile(json, bytes);
      await failure(loadEditableBrandSource(json), /UTF-8|BOM|duplicate|JSON/u);
    }
  });

  it('rejects missing, nonregular and linked file or directory routes without writing', async () => {
    const { directory, json, candidate } = await brandFixture();
    await failure(loadEditableBrandSource(''), /nonempty/u);
    await failure(
      loadEditableBrandSource(path.join(directory, 'Missing.cms-brand.json')),
      /missing/u,
    );
    const folder = path.join(directory, 'Folder.cms-brand.json');
    await mkdir(folder);
    await failure(loadEditableBrandSource(folder), /regular/u);
    const target = path.join(directory, 'target');
    await mkdir(target);
    await writeFile(
      path.join(target, 'Welcome.cms-brand.json'),
      serializeSourceDefinition(candidate),
    );
    const linked = path.join(directory, 'linked');
    await symlink(target, linked, process.platform === 'win32' ? 'junction' : 'dir');
    await failure(
      loadEditableBrandSource(path.join(linked, 'Welcome.cms-brand.json')),
      /symlinks|reparse/u,
    );
    const original = await loadEditableBrandSource(json);
    expect(original.definition).to.deep.equal(candidate);
  });
});

describe('standalone editable item source', () => {
  for (const template of [false, true]) {
    it(`loads edited ${template ? 'Template' : 'Email'} metadata and literal HTML without baseline evidence`, async () => {
      const candidate = definition(template);
      candidate.language = 'de_DE';
      candidate.contentBody.preheader = 'Edited résumé';
      candidate.contentBody.messagePurpose = 'Promotional';
      candidate.urlName = 'edited-url';
      const html = '<p>Edited naïve 世界 &lt;tag&gt; &amp;</p>\n';
      const { directory, json } = await fixture(candidate, html);
      await writeFile(path.join(directory, 'unrelated.json'), '{}');
      const loaded = await loadEditableItemSource(json);
      expect(loaded.definition).to.deep.equal(candidate);
      expect(loaded.contentBody).to.deep.equal({ ...candidate.contentBody, rawHtml: html });
      expect(loaded.htmlPath).to.equal(path.join(directory, candidate.companions.rawHtml!));
      expect(candidate.contentBody).not.to.have.property('rawHtml');
    });

    it(`roundtrips existing ${template ? 'Template' : 'Email'} projection bytes`, async () => {
      const candidate = definition(template);
      const raw = {
        managedContentVariantId: 'variant',
        managedContentId: 'parent',
        apiName: 'Welcome',
        contentSpace: { id: 'workspace' },
        contentType: { fullyQualifiedName: candidate.contentType },
        language: candidate.language,
        title: candidate.title,
        contentBody: {
          ...candidate.contentBody,
          rawHtml: '&lt;p&gt;Café &amp;amp; 世界&lt;/p&gt;',
        },
      };
      const projected = projectSourceDefinitions([
        {
          workspaceApiName: 'Marketing',
          workspaceId: 'workspace',
          apiName: 'Welcome',
          contentType: candidate.contentType,
          folderPath: ['Campaigns'],
          variantId: 'variant',
          raw,
          parent: {
            managedContentId: 'parent',
            contentSpace: raw.contentSpace,
            contentType: raw.contentType,
          },
          siblings: { complete: true, variants: [raw] },
        },
      ]).items[0];
      const { json } = await fixture(projected.definition, projected.htmlBytes!);
      const loaded = await loadEditableItemSource(json);
      expect(serializeSourceDefinition(loaded.definition)).to.equal(
        projected.definitionBytes.toString('utf8'),
      );
      expect(loaded.contentBody.rawHtml).to.equal('<p>Café &amp; 世界</p>');
    });
  }

  it('reports missing, escaping, wrong-stem and additional companion references clearly', async () => {
    const { json } = await fixture();
    const candidate = definition();
    for (const reference of [
      '../outside.html',
      '/outside.html',
      String.raw`C:\outside.html`,
      'sub/file.html',
    ]) {
      await writeFile(json, JSON.stringify({ ...candidate, companions: { rawHtml: reference } }));
      await failure(loadEditableItemSource(json), /escape/u);
    }
    await writeFile(json, JSON.stringify({ ...candidate, companions: { rawHtml: 'Other.html' } }));
    await failure(loadEditableItemSource(json), /same-stem/u);
    await writeFile(
      json,
      JSON.stringify({
        ...candidate,
        companions: { rawHtml: candidate.companions.rawHtml, extra: 'other.html' },
      }),
    );
    await failure(loadEditableItemSource(json), /fields/u);
    const directory = await mkdtemp(path.join(os.tmpdir(), 'cms-editable-missing-'));
    const missing = path.join(directory, 'Welcome.cms-email.json');
    await writeFile(missing, serializeSourceDefinition(candidate));
    await failure(loadEditableItemSource(missing), /companion is missing/u);
    await failure(
      loadEditableItemSource(path.join(directory, 'Missing.json')),
      /definition is missing/u,
    );
  });

  it('rejects case-aliased companion names and mismatched definition filenames', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'cms-editable-alias-'));
    const candidate = definition();
    const json = path.join(directory, 'Welcome.cms-email.json');
    await writeFile(json, serializeSourceDefinition(candidate));
    await writeFile(path.join(directory, 'welcome.cms-email.html'), '<p>Alias</p>');
    await failure(loadEditableItemSource(json), /ambiguous or case-aliased/u);
    const other = path.join(directory, 'Other.json');
    await writeFile(other, serializeSourceDefinition(candidate));
    await failure(loadEditableItemSource(other), /same-stem JSON/u);
  });

  it('rejects invalid UTF-8, BOMs and duplicate JSON keys', async () => {
    for (const bytes of [Buffer.from([195, 0x28]), Buffer.from('\uFEFF<p>BOM</p>')]) {
      const { json } = await fixture(definition(), bytes);
      await failure(loadEditableItemSource(json), /UTF-8|rawHtml/u);
    }
    const { json } = await fixture();
    for (const bytes of [
      Buffer.from([195, 0x28]),
      Buffer.from('\uFEFF{}'),
      Buffer.from('{"contract":1,"contract":2}'),
    ]) {
      await writeFile(json, bytes);
      await failure(loadEditableItemSource(json), /UTF-8|BOM|duplicate/u);
    }
  });

  it('rejects unsupported families and bodies rather than dropping components', async () => {
    const candidate = definition();
    const brand = {
      ...candidate,
      identity: { ...candidate.identity, type: 'Brand' },
      contentType: 'sfdc_cms__brand',
      title: 'Standalone Brand',
      contentBody: brandBody('Standalone Brand'),
      companions: {},
    };
    expect(() => reassembleEditableItemSource(brand, '<p>Text</p>')).to.throw(
      'supports only Email and Email Template',
    );
    for (const contentType of ['sfdc_cms__image', 'sfdc_cms__document', 'sfdc_cms__brand']) {
      expect(() =>
        reassembleEditableItemSource({ ...candidate, contentType }, '<p>Text</p>'),
      ).to.throw();
    }
    for (const contentBody of [
      { ...candidate.contentBody, secondHtml: '<p>Other</p>' },
      { ...candidate.contentBody, 'lightning:expressions': ['binding'] },
    ]) {
      expect(() =>
        reassembleEditableItemSource({ ...candidate, contentBody }, '<p>Text</p>'),
      ).to.throw();
    }
    expect(() => reassembleEditableItemSource(candidate, '{{personalization}}')).to.throw();
    const { json } = await fixture();
    await writeFile(json, JSON.stringify({ ...candidate, sourceManifestSha256: 'original' }));
    await failure(loadEditableItemSource(json), /fields/u);
  });
});
