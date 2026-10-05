import { expect } from 'chai';
import { createHash } from 'node:crypto';
import { bindSourcePublication } from '../../src/services/source-definition-export.js';
import {
  assertSourceDefinition,
  serializeSourceDefinition,
} from '../../src/contracts/source-definition.js';
import {
  assertSourceNativeHtml,
  projectSourceDefinitions,
  type SourceDefinitionInputItem,
} from '../../src/services/source-definition.js';

function item(
  contentType = 'sfdc_cms__email',
  apiName = 'Welcome_Email',
): SourceDefinitionInputItem {
  const raw = {
    managedContentVariantId: `variant-${apiName}`,
    managedContentId: `parent-${apiName}`,
    contentKey: 'source-key',
    contentSpace: { id: 'source-workspace-id' },
    apiName,
    contentType: { fullyQualifiedName: contentType },
    language: 'en_US',
    title: 'Welcome',
    contentBody: {
      'sfdc_cms:title': 'Welcome',
      subjectLine: 'Hello',
      messagePurpose: 'Transactional',
      rawHtml: '&lt;p&gt;Café &amp;amp; 世界&lt;/p&gt;',
      'lightning:expressions': [],
      'sfdc_cms:variants': [],
    },
  };
  return {
    workspaceApiName: 'Demo_Workspace',
    workspaceId: 'source-workspace-id',
    apiName,
    contentType,
    folderPath: ['Campaigns', 'Autumn'],
    variantId: raw.managedContentVariantId,
    raw,
    parent: {
      managedContentId: raw.managedContentId,
      contentType: raw.contentType,
      contentSpace: raw.contentSpace,
    },
    siblings: { complete: true, variants: [raw] },
  };
}

function changedRaw(change: Record<string, unknown>): SourceDefinitionInputItem {
  const selected = item();
  const raw = { ...selected.raw, ...change };
  return { ...selected, raw, siblings: { complete: true, variants: [raw] } };
}

describe('portable Email source definitions', () => {
  it('binds detached publication files and rejects projection byte/path/evidence drift', () => {
    const original = [item()];
    const projection = projectSourceDefinitions(original);
    const files = bindSourcePublication(original, projection);
    expect(files.map((file) => file.path)).to.deep.equal([
      projection.items[0].htmlPath,
      projection.items[0].definitionPath,
    ]);
    for (const file of files)
      expect(file.sha256).to.equal(createHash('sha256').update(file.bytes).digest('hex'));
    files[0].bytes.fill(0);
    expect(bindSourcePublication(original, projection)[0].bytes[0]).to.equal(60);
    for (const change of [
      { definitionPath: '../escape.json' },
      { htmlPath: 'cms/alias.html' },
      { definitionBytes: Buffer.from('{}') },
      { htmlBytes: Buffer.from('<p>edited</p>') },
    ]) {
      const candidate = { ...projection, items: [{ ...projection.items[0], ...change }] };
      expect(() => bindSourcePublication(original, candidate)).to.throw('reprojection');
    }
    expect(() => bindSourcePublication(original, { ...projection, evidence: [] })).to.throw();
  });
  it('projects exact flat paths, inline body, metadata-only folders and separated source evidence', () => {
    const selected = item();
    const before = JSON.stringify(selected);
    const projection = projectSourceDefinitions([selected]);
    const output = projection.items[0];
    expect(output.definitionPath).to.equal('cms/Demo_Workspace/email/Welcome_Email.cms-email.json');
    expect(output.htmlPath).to.equal('cms/Demo_Workspace/email/Welcome_Email.cms-email.html');
    expect(output.htmlBytes?.toString()).to.equal('<p>Café &amp; 世界</p>');
    expect(output.definition).to.deep.equal({
      contract: 'sf-cms-source-definition',
      contractVersion: '1.0.0',
      identity: {
        family: 'cms',
        type: 'Email',
        apiName: 'Welcome_Email',
        context: { workspaceApiName: 'Demo_Workspace' },
      },
      contentType: 'sfdc_cms__email',
      language: 'en_US',
      title: 'Welcome',
      contentBody: {
        'sfdc_cms:title': 'Welcome',
        subjectLine: 'Hello',
        messagePurpose: 'Transactional',
        'lightning:expressions': [],
        'sfdc_cms:variants': [],
      },
      folderPath: ['Campaigns', 'Autumn'],
      companions: { rawHtml: 'Welcome_Email.cms-email.html' },
    });
    expect(output.definitionBytes.toString()).not.to.match(
      /source-key|source-workspace-id|variant-Welcome|parent-Welcome|body\.json/u,
    );
    expect(projection.evidence[0]).to.include({
      variantId: 'variant-Welcome_Email',
      contentId: 'parent-Welcome_Email',
    });
    expect(projection.evidence[0].originalHtmlSha256).to.match(/^[a-f\d]{64}$/u);
    expect(JSON.stringify(selected)).to.equal(before);
  });

  it('uses exact Template directory/token and preserves language without defaulting or directories', () => {
    const selected = item('sfdc_cms__emailTemplate', 'Template');
    const raw = {
      ...selected.raw,
      language: 'de_DE',
      contentBody: { ...(selected.raw.contentBody as Record<string, unknown>) },
    };
    delete raw.contentBody.subjectLine;
    const output = projectSourceDefinitions([
      { ...selected, raw, folderPath: [], siblings: { complete: true, variants: [raw] } },
    ]).items[0];
    expect(output.definitionPath).to.equal(
      'cms/Demo_Workspace/emailTemplate/Template.cms-email-template.json',
    );
    expect(output.definition.identity.type).to.equal('Email Template');
    expect(output.definition.language).to.equal('de_DE');
    expect(output.definition.folderPath).to.deep.equal([]);
    expect(output.definition).not.to.have.property('urlName');
    expect(() => projectSourceDefinitions([changedRaw({ language: undefined })])).to.throw(
      'language',
    );
  });

  it('serializes sorted keys with LF/no BOM and deterministic selection ordering', () => {
    const rows = [item(), item('sfdc_cms__emailTemplate', 'Template')];
    const result = projectSourceDefinitions(rows);
    expect(projectSourceDefinitions(rows.toReversed())).to.deep.equal(result);
    for (const output of result.items) {
      const bytes = output.definitionBytes.toString();
      expect(bytes).to.equal(serializeSourceDefinition(output.definition));
      expect(bytes.startsWith('{\n  "companions": {\n')).to.equal(true);
      expect(bytes.endsWith('\n')).to.equal(true);
      expect(bytes).not.to.include('\r');
      expect(bytes.codePointAt(0)).not.to.equal(65_279);
    }
  });

  it('decodes GET only once, preserves literal entities/line endings and validates edited literal HTML separately', () => {
    const body = item().raw.contentBody as Record<string, unknown>;
    const literal = '<p>&lt;tag&gt; &amp; tea</p>\r\n';
    expect(
      projectSourceDefinitions([
        changedRaw({ contentBody: { ...body, rawHtml: literal } }),
      ]).items[0].htmlBytes?.toString(),
    ).to.equal(literal);
    expect(() =>
      assertSourceNativeHtml('sfdc_cms__email', body, '<p>Edited &amp; text</p>'),
    ).not.to.throw();
    for (const html of [
      '<img src="source">',
      '{{name}}',
      '%%name%%',
      '<script>alert(1)</script>',
      '\uFEFF<p>text</p>',
    ]) {
      expect(() => assertSourceNativeHtml('sfdc_cms__email', body, html)).to.throw();
      expect(() =>
        projectSourceDefinitions([changedRaw({ contentBody: { ...body, rawHtml: html } })]),
      ).to.throw();
    }
  });

  it('rejects encoded active original HTML after one GET decode', () => {
    const body = item().raw.contentBody as Record<string, unknown>;
    expect(() =>
      projectSourceDefinitions([
        changedRaw({ contentBody: { ...body, rawHtml: '&lt;script&gt;alert(1)&lt;/script&gt;' } }),
      ]),
    ).to.throw();
  });

  it('rejects duplicates workspace-wide across families and case aliases, but permits distinct workspaces', () => {
    expect(() => projectSourceDefinitions([item(), item('sfdc_cms__emailTemplate')])).to.throw(
      'Duplicate',
    );
    expect(() =>
      projectSourceDefinitions([item(), item('sfdc_cms__email', 'welcome_email')]),
    ).to.throw('alias');
    expect(() =>
      projectSourceDefinitions([item(), { ...item(), workspaceApiName: 'Other_Workspace' }]),
    ).not.to.throw();
    for (const name of ['../escape', 'CON', 'a/b', 'a.b', ''])
      expect(() => projectSourceDefinitions([{ ...item(), apiName: name }])).to.throw();
  });

  it('rejects incomplete/multiple/mismatched siblings, parent scope and unknown ancestry', () => {
    const selected = item();
    for (const siblings of [
      { complete: false, variants: [selected.raw] },
      { complete: true, variants: [] },
      { complete: true, variants: [selected.raw, selected.raw] },
      { complete: true, variants: [{ ...selected.raw, language: 'fr_FR' }] },
    ])
      expect(() =>
        projectSourceDefinitions([{ ...selected, siblings } as SourceDefinitionInputItem]),
      ).to.throw('sibling');
    expect(() =>
      projectSourceDefinitions([
        { ...selected, parent: { ...selected.parent, contentSpace: { id: 'other' } } },
      ]),
    ).to.throw('parent');
    expect(() =>
      projectSourceDefinitions([
        { ...selected, folderPath: undefined } as unknown as SourceDefinitionInputItem,
      ]),
    ).to.throw('folderPath');
    expect(() =>
      projectSourceDefinitions([changedRaw({ managedContentVariantId: 'other' })]),
    ).to.throw();
  });

  it('fails closed on unsupported families, bodies, personalization, providers and multiple extracted files', () => {
    expect(() => projectSourceDefinitions([item('sfdc_cms__image')])).to.throw('family');
    const body = item().raw.contentBody as Record<string, unknown>;
    for (const patch of [
      { rawHtml: undefined },
      { 'sfdc_cms:block': {} },
      { 'lightning:expressions': ['binding'] },
      { 'sfdc_cms:variants': [{}] },
      { secondHtml: '<p>extra</p>' },
      { 'lightning:dataProviders': [{}] },
      { contentKey: 'source-key' },
    ])
      expect(() =>
        projectSourceDefinitions([changedRaw({ contentBody: { ...body, ...patch } })]),
      ).to.throw();
    for (const patch of [{ externalId: 'provider' }, { personalization: {} }, { translations: [] }])
      expect(() => projectSourceDefinitions([changedRaw(patch)])).to.throw();
    expect(() =>
      projectSourceDefinitions([{ ...item(), parent: { ...item().parent, personalization: {} } }]),
    ).to.throw('parent envelope');
    expect(() => projectSourceDefinitions([])).to.throw();
  });

  it('rejects unknown/missing schema fields, wrong type/token, locators and JSON rawHtml', () => {
    const definition = projectSourceDefinitions([item()]).items[0].definition;
    for (const patch of [
      { unexpected: true },
      { language: undefined },
      { contractVersion: '2.0.0' },
      { contentType: 'sfdc_cms__emailTemplate' },
      { companions: { rawHtml: 'Welcome_Email.cms-email-template.html' } },
      { companions: { rawHtml: definition.companions.rawHtml, other: 'extra.html' } },
      {
        identity: {
          ...definition.identity,
          context: { workspaceApiName: 'Demo_Workspace', workspaceId: 'source' },
        },
      },
      { contentBody: { ...definition.contentBody, rawHtml: '<p>inline</p>' } },
      { title: '20Y000000000001AAA' },
    ])
      expect(() => assertSourceDefinition({ ...definition, ...patch })).to.throw();
    const missing = { ...definition } as Record<string, unknown>;
    delete missing.identity;
    expect(() => assertSourceDefinition(missing)).to.throw();
  });
});
