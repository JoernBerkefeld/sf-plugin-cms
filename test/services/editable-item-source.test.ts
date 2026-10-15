import { expect } from 'chai';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  serializeSourceDefinition,
  type SourceDefinition,
} from '../../src/contracts/source-definition.js';
import {
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
