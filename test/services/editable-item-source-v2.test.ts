import { expect } from 'chai';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  assertSourceDefinition,
  type SourceDefinition,
} from '../../src/contracts/source-definition.js';
import {
  assertEditableItemDefinitionV2,
  extractEditableItemSourceV2,
  loadEditableItemSourceV2,
  reassembleEditableItemSourceV2,
} from '../../src/services/editable-item-source-v2.js';

function definition(template: boolean): SourceDefinition {
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
      'sfdc_cms:title': 'Welcome',
      messagePurpose: 'Transactional',
      textContent: 'Résumé 世界\n',
      ...(template ? {} : { subjectLine: 'Hello' }),
    },
    language: 'en_US',
    folderPath: [],
    companions: { rawHtml: `Welcome.cms-${template ? 'email-template' : 'email'}.html` },
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

describe('versioned editable Email components', () => {
  for (const template of [false, true]) {
    it(`extracts and reassembles literal HTML and text for ${template ? 'Template' : 'Email'}`, async () => {
      const original = definition(template);
      const html = '<p>Café &amp; &lt;b&gt; 世界</p>\n';
      const projection = extractEditableItemSourceV2(original, html);
      const files = new Map(projection.companions.map((entry) => [entry.path, entry.bytes]));
      expect(reassembleEditableItemSourceV2(projection.definition, files)).to.deep.equal({
        ...original.contentBody,
        rawHtml: html,
      });
      const base = `Welcome.cms-${template ? 'email-template' : 'email'}`;
      expect(projection.definitionName).to.equal(`${base}.json`);
      expect(projection.definition.companions).to.deep.equal([
        { role: 'rawHtml', path: `${base}.html` },
        { role: 'textContent', path: `${base}.txt` },
      ]);
      expect(projection.definition.contentBody).not.to.have.property('textContent');
      expect(projection.definition.contentBody).not.to.have.property('rawHtml');
      expect(projection.companions.map(({ role }) => role)).to.deep.equal([
        'rawHtml',
        'textContent',
      ]);
      expect(
        extractEditableItemSourceV2(original, html).definitionBytes.equals(
          projection.definitionBytes,
        ),
      ).to.equal(true);
      expect(() => assertSourceDefinition(projection.definition)).to.throw(/version/u);
      assertSourceDefinition(original);
      const directory = await mkdtemp(path.join(os.tmpdir(), 'cms-editable-v2-'));
      const json = path.join(directory, projection.definitionName);
      await writeFile(json, projection.definitionBytes);
      for (const companion of projection.companions)
        await writeFile(path.join(directory, companion.path), companion.bytes);
      await writeFile(path.join(directory, 'unrelated.json'), '{}');
      const initial = await loadEditableItemSourceV2(json);
      expect(initial.contentBody).to.deep.equal({
        ...original.contentBody,
        rawHtml: html,
      });
      for (const companion of projection.companions) {
        const edited = companion.role === 'rawHtml' ? '<p>Edited &amp;</p>' : 'Edited plain text';
        await writeFile(path.join(directory, companion.path), edited);
        const loaded = await loadEditableItemSourceV2(json);
        expect(loaded.contentBody[companion.role]).to.equal(edited);
      }
      const editedDefinition = structuredClone(projection.definition);
      editedDefinition.contentBody.messagePurpose = 'Promotional';
      editedDefinition.language = 'de_DE';
      await writeFile(json, JSON.stringify(editedDefinition));
      const loaded = await loadEditableItemSourceV2(json);
      expect(loaded.contentBody.messagePurpose).to.equal('Promotional');
      expect(loaded.definition.language).to.equal('de_DE');
    });
  }

  for (const template of [false, true]) {
    it(`rejects old role-suffixed filenames for ${template ? 'Template' : 'Email'} without migration`, async () => {
      const projection = extractEditableItemSourceV2(definition(template), '<p>Hello</p>');
      const directory = await mkdtemp(path.join(os.tmpdir(), 'cms-old-companion-name-'));
      const json = path.join(directory, projection.definitionName);
      for (const role of ['rawHtml', 'textContent']) {
        const candidate = structuredClone(projection.definition);
        const companion = candidate.companions.find((entry) => entry.role === role)!;
        const extension = role === 'rawHtml' ? 'html' : 'txt';
        companion.path = companion.path.replace(`.${extension}`, `.${role}.${extension}`);
        expect(() => assertEditableItemDefinitionV2(candidate)).to.throw(/same-stem/u);
        await writeFile(json, JSON.stringify(candidate));
        await failure(loadEditableItemSourceV2(json), /same-stem/u);
      }
    });
  }

  it('supports HTML-only items without inventing a text component', () => {
    const original = definition(false);
    delete original.contentBody.textContent;
    const projection = extractEditableItemSourceV2(original, '<p>Hello</p>');
    expect(projection.companions).to.have.length(1);
    expect(
      reassembleEditableItemSourceV2(
        projection.definition,
        new Map(projection.companions.map((entry) => [entry.path, entry.bytes])),
      ),
    ).not.to.have.property('textContent');
  });

  it('rejects duplicate, missing, escaping, unknown and embedded component bindings', () => {
    const projection = extractEditableItemSourceV2(definition(false), '<p>Hello</p>');
    const original = projection.definition;
    for (const companions of [
      [],
      [original.companions[0], original.companions[0]],
      [{ role: 'rawHtml', path: '../outside.html' }],
      [{ role: 'rawHtml', path: 'other.html' }],
      [...original.companions, { role: 'css', path: 'style.css' }],
      [{ ...original.companions[0], extra: true }],
    ])
      expect(() => assertEditableItemDefinitionV2({ ...original, companions })).to.throw();
    for (const key of ['rawHtml', 'textContent'])
      expect(() =>
        assertEditableItemDefinitionV2({
          ...original,
          contentBody: { ...original.contentBody, [key]: 'duplicate' },
        }),
      ).to.throw();
    expect(() => reassembleEditableItemSourceV2(original, new Map())).to.throw(/exactly/u);
    expect(() =>
      reassembleEditableItemSourceV2(
        original,
        new Map([
          ['wrong', Buffer.from('x')],
          ['other', Buffer.from('y')],
        ]),
      ),
    ).to.throw(/missing/u);
    for (const bytes of [Buffer.from([195, 40]), Buffer.from('\uFEFFtext')]) {
      const files = new Map(projection.companions.map((entry) => [entry.path, entry.bytes]));
      files.set(original.companions[1].path, bytes);
      expect(() => reassembleEditableItemSourceV2(original, files)).to.throw();
    }
    expect(() => assertEditableItemDefinitionV2({ ...original, sourceId: 'source' })).to.throw();
    expect(() =>
      assertEditableItemDefinitionV2({ ...original, contentType: 'sfdc_cms__image' }),
    ).to.throw();
  });

  it('fails clearly for missing or case-aliased files and strict JSON errors', async () => {
    const projection = extractEditableItemSourceV2(definition(false), '<p>Hello</p>');
    const directory = await mkdtemp(path.join(os.tmpdir(), 'cms-editable-v2-missing-'));
    const json = path.join(directory, projection.definitionName);
    await writeFile(json, projection.definitionBytes);
    await failure(loadEditableItemSourceV2(json), /missing/u);
    const first = projection.companions[0];
    await writeFile(path.join(directory, first.path.toLowerCase()), first.bytes);
    await failure(loadEditableItemSourceV2(json), /case-aliased/u);
    await writeFile(json, '{"contract":1,"contract":2}');
    await failure(loadEditableItemSourceV2(json), /duplicate/u);
    await failure(loadEditableItemSourceV2(''), /nonempty/u);
  });
});
