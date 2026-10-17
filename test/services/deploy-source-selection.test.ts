import { expect } from 'chai';
import { mkdir, mkdtemp, readFile, symlink, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { SourceDefinition } from '../../src/contracts/source-definition.js';
import { extractEditableItemSourceV2 } from '../../src/services/editable-item-source-v2.js';
import {
  selectDeploySources,
  type DeploySourceSelectionFlags,
} from '../../src/services/deploy-source-selection.js';

function definition(template = false, apiName = 'Welcome'): SourceDefinition {
  return {
    contract: 'sf-cms-source-definition',
    contractVersion: '1.0.0',
    identity: {
      family: 'cms',
      type: template ? 'Email Template' : 'Email',
      apiName,
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
    companions: { rawHtml: `${apiName}.cms-${template ? 'email-template' : 'email'}.html` },
  };
}

async function temporary(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), 'cms-deploy-selection-'));
}

async function fixture(directory: string, candidate = definition(), v2 = false): Promise<string> {
  await mkdir(directory, { recursive: true });
  const html = '<p>Café &amp; 世界</p>\n';
  if (v2) {
    const projection = extractEditableItemSourceV2(candidate, html);
    const file = path.join(directory, projection.definitionName);
    await writeFile(file, projection.definitionBytes);
    for (const companion of projection.companions)
      await writeFile(path.join(directory, companion.path), companion.bytes);
    return file;
  }
  const file = path.join(directory, candidate.companions.rawHtml!.replace(/\.html$/u, '.json'));
  await writeFile(file, JSON.stringify(candidate));
  await writeFile(path.join(directory, candidate.companions.rawHtml!), html);
  return file;
}

async function failure(operation: Promise<unknown>, pattern: RegExp): Promise<void> {
  try {
    await operation;
  } catch (error) {
    expect((error as Error).message).to.match(pattern);
    return;
  }
  throw new Error('Expected rejection');
}

describe('local deploy source selection', () => {
  it('admits binary Images without a format gate but rejects unsafe MIME/path, URL-only and Documents', async () => {
    const root = await temporary();
    const file = path.join(root, 'Hero.cms-image.json');
    const candidate = {
      contract: 'sf-cms-media-source',
      contractVersion: '1.0.0',
      identity: {
        family: 'cms',
        type: 'Image',
        apiName: 'Hero',
        context: { workspaceApiName: 'Source' },
      },
      contentType: 'sfdc_cms__image',
      language: 'en_US',
      folderPath: [],
      media: {
        representation: 'binary',
        mimeType: 'image/svg+xml',
        companion: { role: 'media', path: 'Hero.cms-image.media.svg' },
      },
    };
    await writeFile(file, JSON.stringify(candidate));
    await writeFile(path.join(root, candidate.media.companion.path), '<svg/>');
    const selected = await selectDeploySources({ 'source-dir': [root] });
    expect(selected.items).to.have.length(1);
    for (const patch of [
      { media: { ...candidate.media, mimeType: 'image/svg+xml\r\nX-Evil: yes' } },
      {
        media: {
          ...candidate.media,
          companion: { role: 'media', path: '../Hero.cms-image.media.svg' },
        },
      },
      { media: { representation: 'url-only', address: 'https://example.invalid/image' } },
      {
        identity: { ...candidate.identity, type: 'Document' },
        contentType: 'sfdc_cms__document',
        media: {
          ...candidate.media,
          mimeType: 'text/plain',
          companion: { role: 'media', path: 'Hero.cms-document.media.txt' },
        },
      },
    ]) {
      await writeFile(file, JSON.stringify({ ...candidate, ...patch }));
      await failure(
        selectDeploySources({ 'definition-file': [file] }),
        /MIME|same-stem|binary Image/u,
      );
    }
  });

  it('loads explicit v1/v2 sources, preserving workspace and literal components without writes', async () => {
    const root = await temporary();
    const file = await fixture(path.join(root, 'first'));
    const second = await fixture(path.join(root, 'second'), definition(true), true);
    const before = await readFile(file);
    const flags = Object.freeze({ 'definition-file': Object.freeze([second, file, file]) });
    const result = await selectDeploySources(flags);
    expect(result.mode).to.equal('definition-file');
    expect(result.items.map((item) => item.definitionPath)).to.deep.equal(
      [file, second].toSorted(),
    );
    for (const item of result.items) {
      expect(Object.keys(item).toSorted()).to.deep.equal([
        'companionPaths',
        'contentBody',
        'definition',
        'definitionPath',
        'targetIdentity',
      ]);
      expect(item.definition.identity.context.workspaceApiName).to.equal('Marketing');
      expect(item.targetIdentity).to.deep.equal({
        contentType: item.definition.contentType,
        apiName: 'Welcome',
        language: 'en_US',
      });
      expect(item.contentBody.rawHtml).to.equal('<p>Café &amp; 世界</p>\n');
      expect(item.contentBody.textContent).to.equal('Résumé 世界\n');
      expect(item.companionPaths).to.have.length(
        item.definition.contractVersion === '2.0.0' ? 2 : 1,
      );
    }
    const after = await readFile(file);
    expect(after.equals(before)).to.equal(true);
    expect(flags['definition-file']).to.deep.equal([second, file, file]);
  });

  it('recurses through arbitrary folders and deterministically deduplicates overlapping roots', async () => {
    const root = await temporary();
    const nested = path.join(root, 'emailTemplate', 'arbitrary');
    const file = await fixture(nested);
    const second = await fixture(path.join(root, 'email'), definition(true));
    await writeFile(path.join(root, 'receipt.json'), '{not a definition');
    await writeFile(path.join(root, 'other.cms-document.json'), '{not supported');
    await writeFile(path.join(root, 'Welcome.cms-email.txt'), 'companion');
    const result = await selectDeploySources({ 'source-dir': [nested, root, root] });
    expect(result.mode).to.equal('source-dir');
    expect(result.items.map((item) => item.definitionPath)).to.deep.equal(
      [file, second].toSorted(),
    );
    const filtered = await selectDeploySources({
      'source-dir': [root],
      'content-type': ['sfdc_cms__email'],
    });
    expect(filtered.items.map((item) => item.definitionPath)).to.deep.equal([file]);
  });

  it('unions per-type selectors and retains exact obligations underneath type-wide selectors', async () => {
    const root = await temporary();
    await fixture(path.join(root, 'a'));
    await fixture(path.join(root, 'b'), definition(true, 'Template'));
    const result = await selectDeploySources({
      'source-dir': [root],
      metadata: ['sfdc_cms__email', 'sfdc_cms__email:Welcome', 'sfdc_cms__emailTemplate:Template'],
    });
    expect(result.items).to.have.length(2);
    for (const name of ['Missing', 'Welcome:unchanged', ' Welcome', 'Welcome '])
      await failure(
        selectDeploySources({
          'source-dir': [root],
          metadata: ['sfdc_cms__email', `sfdc_cms__email:${name}`],
        }),
        /Exact deploy metadata member is missing/u,
      );
  });

  it('rejects invalid source modes and filters before filesystem access', async () => {
    const invalid: DeploySourceSelectionFlags[] = [
      {},
      { 'source-dir': [] },
      { 'definition-file': [] },
      { 'source-dir': ['x'], 'definition-file': ['y'] },
      { 'source-dir': [' '] },
      { 'definition-file': [''] },
      { 'definition-file': ['x'], metadata: ['sfdc_cms__email'] },
      { 'definition-file': ['x'], 'content-type': ['sfdc_cms__email'] },
      { 'source-dir': ['x'], metadata: ['sfdc_cms__email'], 'content-type': ['sfdc_cms__email'] },
      { 'source-dir': ['x'], metadata: [] },
      { 'source-dir': ['x'], 'content-type': [] },
      { 'source-dir': ['x'], 'content-type': ['email'] },
      { 'source-dir': ['x'], metadata: ['sfdc_cms__document'] },
      { 'source-dir': ['x'], metadata: ['sfdc_cms__email:'] },
      { 'source-dir': ['x'], metadata: ['sfdc_cms__email: '] },
      { 'source-dir': 'x' as unknown as string[] },
      { 'source-dir': [42 as unknown as string] },
    ];
    for (const flags of invalid) await failure(selectDeploySources(flags), /Deploy|deploy/u);
  });

  it('rejects empty discovery, empty filters, missing roots/files and files used as roots', async () => {
    const root = await temporary();
    await failure(selectDeploySources({ 'source-dir': [root] }), /empty/u);
    const file = await fixture(root);
    await failure(
      selectDeploySources({ 'source-dir': [root], 'content-type': ['sfdc_cms__emailTemplate'] }),
      /empty/u,
    );
    await failure(selectDeploySources({ 'source-dir': [path.join(root, 'missing')] }), /ENOENT/u);
    await failure(
      selectDeploySources({ 'definition-file': [path.join(root, 'missing.json')] }),
      /missing/u,
    );
    await failure(selectDeploySources({ 'source-dir': [file] }), /regular directories/u);
    await failure(
      selectDeploySources({
        'source-dir': [`${root}${path.sep}..${path.sep}${path.basename(root)}`],
      }),
      /Unsafe/u,
    );
  });

  it('rejects distinct destination collisions across source workspaces but allows language variants', async () => {
    const root = await temporary();
    await fixture(path.join(root, 'a'));
    const candidate = definition();
    candidate.identity.context.workspaceApiName = 'Another';
    const second = await fixture(path.join(root, 'b'), candidate, true);
    await failure(
      selectDeploySources({ 'source-dir': [root] }),
      /collide at destination identity/u,
    );
    candidate.language = 'de_DE';
    await fixture(path.dirname(second), candidate, true);
    const result = await selectDeploySources({ 'source-dir': [root] });
    expect(result.items).to.have.length(2);
  });

  it('rejects recognized malformed definitions and missing companions through existing loaders', async () => {
    for (const v2 of [false, true]) {
      const root = await temporary();
      const file = await fixture(root, definition(), v2);
      const companion = path.join(root, v2 ? 'Welcome.cms-email.txt' : 'Welcome.cms-email.html');
      await unlink(companion);
      await failure(selectDeploySources({ 'source-dir': [root] }), /missing/u);
      await writeFile(file, '{broken');
      await failure(selectDeploySources({ 'source-dir': [root] }), /valid JSON/u);
      await writeFile(file, '{"contractVersion":"9.0.0"}');
      await failure(selectDeploySources({ 'source-dir': [root] }), /Invalid|Unsupported/u);
      await writeFile(file, '{"contract":1,"contract":2}');
      await failure(selectDeploySources({ 'definition-file': [file] }), /duplicate/u);
    }
  });

  it('rejects filename substitution and validates filters against JSON rather than filenames', async () => {
    const root = await temporary();
    const file = await fixture(root);
    const candidate = definition(true);
    await writeFile(file, JSON.stringify(candidate));
    await failure(
      selectDeploySources({ 'source-dir': [root], metadata: ['sfdc_cms__emailTemplate'] }),
      /same-stem/u,
    );
    await writeFile(file, JSON.stringify({ ...candidate, extra: true }));
    await failure(selectDeploySources({ 'source-dir': [root] }), /fields/u);
  });

  it('rejects symlink traversal at roots and nested directories', async function () {
    const root = await temporary();
    const outside = await temporary();
    await fixture(outside);
    const link = path.join(root, 'linked');
    try {
      await symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error;
      this.skip();
    }
    await failure(selectDeploySources({ 'source-dir': [link] }), /symlinks|reparse/u);
    await failure(selectDeploySources({ 'source-dir': [root] }), /symlinks|reparse/u);
  });
});
