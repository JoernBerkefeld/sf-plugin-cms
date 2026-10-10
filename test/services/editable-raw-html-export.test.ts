import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect } from 'chai';
import sinon from 'sinon';
import {
  createRunOwnedDirectory,
  createRunOwnedTemp,
  removeRunOwnedPath,
  type RunOwnedTemp,
} from '../../src/filesystem/runOwnedTemp.js';
import { writeEditableRawHtml } from '../../src/services/editable-raw-html-export.js';
import { projectEditableRawHtml } from '../../src/services/editable-raw-html.js';

const manifestHash = 'a'.repeat(64);
const rawItems = [
  {
    variantId: 'variant-a',
    raw: {
      managedContentVariantId: 'variant-a',
      managedContentId: 'parent-a',
      language: 'en_US',
      contentType: 'sfdc_cms__email',
      contentBody: { rawHtml: '<p>Café 世界 &amp; tea</p>\r\n' },
    },
  },
];

describe('editable directory staging retention', () => {
  let run: RunOwnedTemp;
  let root: string;
  beforeEach(async () => {
    run = await createRunOwnedTemp('cms-editable-retention');
    root = await createRunOwnedDirectory(run, 'fixture');
  });
  afterEach(async () => {
    await removeRunOwnedPath(run, root);
  });

  it('publishes exact projected bytes and preserves narrow Windows retries', async () => {
    const destination = path.join(root, 'editable');
    const expected = projectEditableRawHtml(rawItems, manifestHash);
    const publishPath = sinon.stub();
    publishPath.onFirstCall().rejects(Object.assign(new Error('busy'), { code: 'EPERM' }));
    publishPath.onSecondCall().callsFake(rename);
    const delay = sinon.stub().resolves();
    await writeEditableRawHtml(rawItems, manifestHash, destination, {
      publishPath,
      delay,
      platform: 'win32',
    });
    expect(delay.args).to.deep.equal([[10]]);
    expect(publishPath.callCount).to.equal(2);
    expect(await readFile(path.join(destination, 'editable.json'))).to.deep.equal(
      expected.descriptorBytes,
    );
    for (const item of expected.items) {
      expect(await readFile(path.join(destination, item.metadataPath))).to.deep.equal(
        item.metadataBytes,
      );
      expect(await readFile(path.join(destination, item.htmlPath))).to.deep.equal(item.htmlBytes);
    }
    expect(await readdir(root)).to.deep.equal(['editable']);
  });

  it('retains failed staging and the original error with nonenumerable diagnostics', async () => {
    const destination = path.join(root, 'editable');
    const failure = Object.assign(new Error('locked'), { code: 'EBUSY' });
    const publishPath = sinon.stub().rejects(failure);
    const delay = sinon.stub().resolves();
    let caught: unknown;
    try {
      await writeEditableRawHtml(rawItems, manifestHash, destination, {
        publishPath,
        delay,
        platform: 'win32',
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).to.equal(failure);
    expect(publishPath.callCount).to.equal(4);
    expect(delay.args).to.deep.equal([[10], [25], [50]]);
    const staging = (caught as Error & { stagingPath: string }).stagingPath;
    expect(Object.getOwnPropertyDescriptor(failure, 'stagingPath')?.enumerable).to.equal(false);
    expect(await readdir(root)).to.deep.equal([path.basename(staging)]);
    expect(await readFile(path.join(staging, 'items/variant-a.html'), 'utf8')).to.equal(
      rawItems[0].raw.contentBody.rawHtml,
    );
  });

  it('keeps an existing destination untouched before publication', async () => {
    const destination = path.join(root, 'editable');
    await mkdir(destination);
    await writeFile(path.join(destination, 'sentinel'), 'winner');
    const publishPath = sinon.stub().resolves();
    let failure: unknown;
    try {
      await writeEditableRawHtml(rawItems, manifestHash, destination, { publishPath });
    } catch (error) {
      failure = error;
    }
    expect(failure).to.be.instanceOf(Error);
    expect(failure).not.to.have.property('stagingPath');
    expect(publishPath.callCount).to.equal(0);
    expect(await readFile(path.join(destination, 'sentinel'), 'utf8')).to.equal('winner');
    expect(await readdir(root)).to.deep.equal(['editable']);
  });

  it('retains staging without changing a winner appearing during publication', async () => {
    const destination = path.join(root, 'editable');
    const failure = Object.assign(new Error('winner appeared'), { code: 'EEXIST' });
    let staging = '';
    const publishPath = async (temporary: string): Promise<void> => {
      staging = temporary;
      await mkdir(destination);
      await writeFile(path.join(destination, 'sentinel'), 'winner');
      throw failure;
    };
    let caught: unknown;
    try {
      await writeEditableRawHtml(rawItems, manifestHash, destination, { publishPath });
    } catch (error) {
      caught = error;
    }
    expect(caught).to.equal(failure);
    expect((caught as Error & { stagingPath: string }).stagingPath).to.equal(staging);
    expect(await readFile(path.join(destination, 'sentinel'), 'utf8')).to.equal('winner');
    expect(await readFile(path.join(staging, 'editable.json'))).to.deep.equal(
      projectEditableRawHtml(rawItems, manifestHash).descriptorBytes,
    );
  });
});
