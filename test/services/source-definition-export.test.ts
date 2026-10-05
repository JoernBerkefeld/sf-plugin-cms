import { expect } from 'chai';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { brandDetail } from '../fixtures/brand.js';
import {
  preflightSourceDefinitionExport,
  writeSourceDefinitions,
} from '../../src/services/source-definition-export.js';
import {
  projectSourceDefinitions,
  type SourceDefinitionInputItem,
} from '../../src/services/source-definition.js';

function item(contentType = 'sfdc_cms__email', apiName = 'Welcome'): SourceDefinitionInputItem {
  const raw = {
    managedContentVariantId: `variant-${apiName}`,
    managedContentId: `parent-${apiName}`,
    contentKey: 'source-key',
    contentSpace: { id: 'source-workspace' },
    apiName,
    contentType: { fullyQualifiedName: contentType },
    language: 'en_US',
    title: 'Welcome',
    contentBody: {
      'sfdc_cms:title': 'Welcome',
      messagePurpose: 'Transactional',
      ...(contentType === 'sfdc_cms__email' ? { subjectLine: 'Hello' } : {}),
      rawHtml: '&lt;p&gt;Café &amp;amp; 世界&lt;/p&gt;',
      'lightning:expressions': [],
      'sfdc_cms:variants': [],
    },
  };
  return {
    workspaceApiName: 'Demo',
    workspaceId: 'source-workspace',
    apiName,
    contentType,
    folderPath: ['Campaigns'],
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

async function rejected(operation: Promise<unknown>): Promise<Error> {
  try {
    await operation;
  } catch (error) {
    return error as Error;
  }
  throw new Error('Expected rejection');
}

async function absent(target: string): Promise<boolean> {
  try {
    await lstat(target);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
    throw error;
  }
}

describe('source definition filesystem publication', () => {
  let root: string;
  let baseline: string;
  let destination: string;
  beforeEach(async () => {
    // Run-owned OS-temp fixtures are retained; no recursive deletion is needed.
    root = await mkdtemp(path.join(os.tmpdir(), 'cms-source-publisher-'));
    baseline = path.join(root, 'baseline');
    destination = path.join(root, 'definitions');
    await mkdir(baseline);
    await writeFile(path.join(baseline, 'sentinel'), 'immutable');
  });

  it('publishes detached exact sorted same-stem files, without changing the sibling baseline', async () => {
    const original = [item(), item('sfdc_cms__emailTemplate', 'Template')];
    const candidate = projectSourceDefinitions(original);
    const before = JSON.stringify(original);
    const files = await writeSourceDefinitions(original, candidate, baseline, destination);
    expect(files).to.have.length(4);
    expect(files.map((file) => file.path)).to.deep.equal(files.map((file) => file.path).toSorted());
    for (const file of files) {
      const target = path.join(destination, file.path);
      const information = await lstat(target);
      expect(information.isFile()).to.equal(true);
      const bytes = await readFile(target);
      expect(bytes.equals(file.bytes)).to.equal(true);
      expect(createHash('sha256').update(bytes).digest('hex')).to.equal(file.sha256);
      if (file.path.endsWith('.json'))
        expect(bytes.toString()).not.to.match(
          /source-key|source-workspace|variant-Welcome|parent-Welcome/u,
        );
    }
    expect(await readdir(path.join(destination, 'cms', 'Demo', 'email'))).to.deep.equal([
      'Welcome.cms-email.html',
      'Welcome.cms-email.json',
    ]);
    expect(await readFile(path.join(baseline, 'sentinel'), 'utf8')).to.equal('immutable');
    expect(JSON.stringify(original)).to.equal(before);
    files[0].bytes.fill(0);
    const published = await readFile(path.join(destination, files[0].path));
    expect(published[0]).not.to.equal(0);
    expect(await readdir(root)).to.deep.equal(['baseline', 'definitions']);
  });

  it('publishes qualified Brand as one exact inline file without companions', async () => {
    const raw = brandDetail('variant-source-id', 'Simple_Brand', 'space');
    const original: SourceDefinitionInputItem[] = [
      {
        workspaceApiName: 'Demo',
        workspaceId: 'space',
        apiName: 'Simple_Brand',
        contentType: 'sfdc_cms__brand',
        folderPath: [],
        variantId: 'variant-source-id',
        raw,
        parent: { ...raw, contentVersion: 1, variantVersion: '1.1' },
        siblings: { complete: true, variants: [raw] },
      },
    ];
    const candidate = projectSourceDefinitions(original);
    const files = await writeSourceDefinitions(original, candidate, baseline, destination);
    expect(files.map((file) => file.path)).to.deep.equal([
      'cms/Demo/brand/Simple_Brand.cms-brand.json',
    ]);
    expect(await readdir(path.join(destination, 'cms', 'Demo', 'brand'))).to.deep.equal([
      'Simple_Brand.cms-brand.json',
    ]);
    const bytes = await readFile(path.join(destination, files[0].path));
    expect(bytes.equals(candidate.items[0].definitionBytes)).to.equal(true);
    expect(JSON.parse(bytes.toString()).contentBody).to.deep.equal(raw.contentBody);
    expect(bytes.toString()).not.to.match(/source-id|content-key|resourceUrl/u);
  });

  it('rejects all projection drift and unsupported records before creating any staging directory', async () => {
    const original = [item()];
    const candidate = projectSourceDefinitions(original);
    for (const patch of [
      { definitionPath: '../escape' },
      { definitionBytes: Buffer.from('{}') },
      { htmlBytes: Buffer.from('edited') },
    ]) {
      await rejected(
        writeSourceDefinitions(
          original,
          { ...candidate, items: [{ ...candidate.items[0], ...patch }] },
          baseline,
          destination,
        ),
      );
    }
    await rejected(
      writeSourceDefinitions([item('sfdc_cms__image')], candidate, baseline, destination),
    );
    await rejected(writeSourceDefinitions([item(), item()], candidate, baseline, destination));
    await rejected(
      writeSourceDefinitions(
        [item(), item('sfdc_cms__email', 'welcome')],
        candidate,
        baseline,
        destination,
      ),
    );
    expect(await readdir(root)).to.deep.equal(['baseline']);
  });

  it('rejects unsafe destinations, ancestor overlap and case aliases without writes', async () => {
    for (const target of [
      '',
      `${root}${path.sep}..${path.sep}escape`,
      path.join(root, 'CON'),
      path.join(root, 'trailing.'),
      path.join(root, 'file:stream'),
      String.raw`\\?\C:\unsafe`,
      path.join(baseline, 'child'),
      root,
      baseline.toUpperCase(),
    ]) {
      await rejected(preflightSourceDefinitionExport(baseline, target));
    }
    expect(await readdir(root)).to.deep.equal(['baseline']);
  });

  it('never clobbers existing empty/nonempty directories or files', async () => {
    const original = [item()];
    for (const kind of ['empty', 'nonempty', 'file']) {
      const target = path.join(root, kind);
      if (kind === 'file') await writeFile(target, 'existing');
      else {
        await mkdir(target);
        if (kind === 'nonempty') await writeFile(path.join(target, 'sentinel'), 'existing');
      }
      await rejected(
        writeSourceDefinitions(original, projectSourceDefinitions(original), baseline, target),
      );
      const directoryEntries = kind === 'empty' ? [] : ['sentinel'];
      const expected = kind === 'file' ? 'existing' : directoryEntries;
      expect(
        kind === 'file' ? await readFile(target, 'utf8') : await readdir(target),
      ).to.deep.equal(expected);
    }
    const entries = await readdir(root);
    expect(entries.some((entry) => entry.includes('.tmp-'))).to.equal(false);
  });

  it('rejects observed symlink/junction paths where permitted', async function () {
    const alias = path.join(root, 'alias');
    try {
      await symlink(baseline, alias, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      if (['EPERM', 'EACCES', 'ENOTSUP'].includes((error as NodeJS.ErrnoException).code ?? '')) {
        this.skip();
        return;
      }
      throw error;
    }
    await rejected(preflightSourceDefinitionExport(baseline, path.join(alias, 'definitions')));
    await rejected(preflightSourceDefinitionExport(alias, destination));
    expect(await absent(destination)).to.equal(true);
  });

  it('stages the whole exact tree before publication, retaining staging and original failure on error', async () => {
    const original = [item()];
    const candidate = projectSourceDefinitions(original);
    const failure = new Error('publication failed');
    let staging = '';
    const error = await rejected(
      writeSourceDefinitions(original, candidate, baseline, destination, {
        publishPath: async (temporary, target) => {
          staging = temporary;
          expect(path.dirname(temporary)).to.equal(path.dirname(target));
          expect(await absent(target)).to.equal(true);
          for (const output of candidate.items) {
            const definitionBytes = await readFile(path.join(temporary, output.definitionPath));
            const htmlBytes = await readFile(path.join(temporary, output.htmlPath!));
            expect(definitionBytes.equals(output.definitionBytes)).to.equal(true);
            expect(htmlBytes.equals(output.htmlBytes!)).to.equal(true);
          }
          throw failure;
        },
      }),
    );
    expect(error).to.equal(failure);
    expect((error as Error & { stagingPath: string }).stagingPath).to.equal(staging);
    expect(await absent(destination)).to.equal(true);
    expect(await absent(staging)).to.equal(false);
    expect(await readFile(path.join(baseline, 'sentinel'), 'utf8')).to.equal('immutable');
  });

  it('uses atomic no-clobber when another publisher wins after final preflight', async () => {
    const original = [item()];
    const { publishDirectoryNoClobber } = await import('../../src/services/atomic-publish.js');
    const error = await rejected(
      writeSourceDefinitions(original, projectSourceDefinitions(original), baseline, destination, {
        publishPath: async (temporary, target) => {
          await mkdir(target);
          await writeFile(path.join(target, 'winner'), 'untouched');
          await publishDirectoryNoClobber(temporary, target);
        },
      }),
    );
    expect(error).to.be.instanceOf(Error);
    expect(await readdir(destination)).to.deep.equal(['winner']);
    expect(await readFile(path.join(destination, 'winner'), 'utf8')).to.equal('untouched');
  });
});
