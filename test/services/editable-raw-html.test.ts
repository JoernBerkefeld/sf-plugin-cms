import { createHash } from 'node:crypto';
import { expect } from 'chai';
import { projectEditableRawHtml } from '../../src/services/editable-raw-html.js';

const manifestHash = 'a'.repeat(64);

function item(variantId = 'variant-a', overrides = {}) {
  return {
    variantId,
    raw: {
      managedContentVariantId: variantId,
      managedContentId: 'parent-a',
      language: 'en_US',
      contentType: 'sfdc_cms__email',
      contentBody: { rawHtml: '<p>Café 世界 &amp; tea</p>' },
      ...overrides,
    },
  };
}

function hash(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

describe('editable raw HTML pure projection', () => {
  it('preserves complete original metadata except the single rawHtml field without mutation', () => {
    const raw = item('variant-a', {
      contentType: { fullyQualifiedName: 'sfdc_cms__email', label: 'Email', id: null },
      externalId: null,
      arbitrary: { rawHtml: 'not extracted', nested: [null, 1, false] },
      contentBody: {
        rawHtml: '<p>Café 世界</p>\r\n',
        subjectLine: 'subject',
        custom: { rawHtml: 'also retained' },
        'lightning:expressions': ['not a portability claim'],
      },
    });
    const before = JSON.stringify(raw);
    const projection = projectEditableRawHtml([raw], manifestHash);
    const output = projection.items[0];
    const expected = structuredClone(raw.raw);
    delete (expected.contentBody as Record<string, unknown>).rawHtml;
    expect(output.metadataBytes.toString()).to.equal(`${JSON.stringify(expected, null, 2)}\n`);
    expect(output.htmlBytes.toString()).to.equal('<p>Café 世界</p>\r\n');
    expect(JSON.stringify(raw)).to.equal(before);
    expect(projection.descriptor).to.deep.equal({
      contract: 'sf-cms-editable-raw-html',
      contractVersion: '1.0.0',
      sourceManifestSha256: manifestHash,
      entries: [
        {
          variantId: 'variant-a',
          metadataSha256: hash(output.metadataBytes),
          originalHtmlSha256: hash(output.htmlBytes),
        },
      ],
    });
    expect(projection.descriptorBytes.toString()).to.equal(
      `${JSON.stringify(projection.descriptor, null, 2)}\n`,
    );
  });

  it('separates sibling languages and distinct email/template parents in deterministic ID order', () => {
    const rows = [
      item('variant-c', { contentType: 'sfdc_cms__emailTemplate', managedContentId: 'parent-b' }),
      item('variant-b', { language: 'de_DE' }),
      item(),
      item('variant-d', { contentType: { fullyQualifiedName: 'sfdc_cms__emailTemplate' } }),
    ];
    const result = projectEditableRawHtml(rows, manifestHash);
    expect(
      result.items.map(({ metadataPath, htmlPath }) => [metadataPath, htmlPath]),
    ).to.deep.equal(
      ['a', 'b', 'c', 'd'].map((id) => [`items/variant-${id}.json`, `items/variant-${id}.html`]),
    );
    expect(projectEditableRawHtml(rows.toReversed(), manifestHash)).to.deep.equal(result);
  });

  it('decodes only one GET layer and preserves entities in literal documents', () => {
    for (const [input, expected] of [
      ['<p>&lt;tag&gt; &amp; &#39;</p>', '<p>&lt;tag&gt; &amp; &#39;</p>'],
      [
        '&lt;p title=&quot;Hi&quot;&gt;&amp;lt;tag&amp;gt; &amp;amp; &#39;世界&#39;&lt;/p&gt;',
        '<p title="Hi">&lt;tag&gt; &amp; \'世界\'</p>',
      ],
      ['', ''],
      ['plain text', 'plain text'],
    ]) {
      expect(
        projectEditableRawHtml(
          [item('v', { contentBody: { rawHtml: input } })],
          manifestHash,
        ).items[0].htmlBytes.toString(),
      ).to.equal(expected);
    }
  });

  it('fails closed on unsupported or ambiguous nonliteral encoding', () => {
    for (const rawHtml of [
      '&amp;lt;p&amp;gt;',
      '&#60;p&#62;',
      '&lt;p&gt;&nbsp;&lt;/p&gt;',
      '&lt;p&gt;bare & text&lt;/p&gt;',
    ]) {
      expect(() =>
        projectEditableRawHtml([item('v', { contentBody: { rawHtml } })], manifestHash),
      ).to.throw('encoding');
    }
  });

  it('excludes non-native, missing rawHtml and block-based rows without traversing them', () => {
    const excluded = [
      item('other', { contentType: 'sfdc_cms__image' }),
      item('missing', { contentBody: { nested: { rawHtml: '<p>nested</p>' } } }),
      item('block', { contentBody: { rawHtml: '<p>not eligible</p>', 'sfdc_cms:block': null } }),
      item('invalid', { contentBody: { rawHtml: 42 } }),
    ];
    expect(projectEditableRawHtml([...excluded, item()], manifestHash).items).to.have.length(1);
    expect(() => projectEditableRawHtml(excluded, manifestHash)).to.throw(
      'No editable native raw-HTML variants',
    );
    expect(() => projectEditableRawHtml([], manifestHash)).to.throw(
      'No editable native raw-HTML variants',
    );
  });

  it('rejects unsafe IDs, duplicate variants, conflicting raw identity and invalid manifest hashes', () => {
    for (const id of ['../x', '.', 'a/b', String.raw`a\b`, '', 'CON', 'lpt1']) {
      expect(() => projectEditableRawHtml([item(id)], manifestHash)).to.throw('Unsafe');
    }
    expect(() => projectEditableRawHtml([item(), item()], manifestHash)).to.throw('Duplicate');
    expect(() =>
      projectEditableRawHtml([item('v', { managedContentVariantId: 'other' })], manifestHash),
    ).to.throw('manifest/search');
    expect(() => projectEditableRawHtml([item()], 'foreign')).to.throw('manifest SHA-256');
  });
});
