import { expect } from 'chai';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertPortablePayload } from '../src/contracts/capability-registry.js';
import { assertSourceDefinition, sourcePathSegment } from '../src/contracts/source-definition.js';
import { assertSourceNativeHtml } from '../src/services/source-definition.js';
import { brandBody } from './fixtures/brand.js';

type InventoryItem = {
  family: string;
  type: string;
  displayLabel: string;
  apiName: string;
  token: string;
  status: string;
  gap?: string;
  definition: string;
  companions: string[];
};
type DemoDefinition = {
  contract: string;
  contractVersion: string;
  identity: {
    family: string;
    type: string;
    apiName: string;
    context: { workspaceApiName: string };
  };
  contentType: string;
  contentBody: Record<string, unknown>;
  language: string;
  title: string;
  folderPath: string[];
  companions: Record<string, string>;
};
const root = fileURLToPath(new URL('demo-project/', import.meta.url));
const inventoryFile = fileURLToPath(
  new URL('fixtures/demo-project-inventory.json', import.meta.url),
);
const coverageFile = fileURLToPath(
  new URL('fixtures/demo-project-ui-coverage.json', import.meta.url),
);

/**
 * List fixture files without creating temporary output or performing cleanup.
 * @param {string} directory - Fixture directory to inspect.
 * @returns {Promise<string[]>} Relative forward-slash file names.
 */
async function files(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const filename = path.join(directory, entry.name);
      return entry.isDirectory()
        ? files(filename)
        : [path.relative(root, filename).replaceAll('\\', '/')];
    }),
  );
  return nested.flat().toSorted();
}

describe('imaginary CMS retrieve-all demo project', () => {
  it('keeps the source-only proposal, ownership, baseline gaps and family scope explicit', async () => {
    const inventory = JSON.parse(await readFile(inventoryFile, 'utf8')) as {
      owner: string;
      scenario: string;
      status: string;
      importReady: boolean;
      baseline: string;
      defaultLanguage: string;
      workspaceApiName: string;
      coverageGaps: string[];
      outOfScope: string[];
      items: InventoryItem[];
    };
    expect(inventory).to.include({
      owner: 'cms',
      scenario: 'imaginary-retrieve-all-result',
      status: 'source-only',
      importReady: false,
      defaultLanguage: 'en_US',
      workspaceApiName: 'Demo_Workspace',
    });
    expect(inventory.baseline).to.include('absent').and.include('integrity-bound baseline');
    expect(inventory.coverageGaps.join(' ')).to.include('image/media').and.include('folder');
    expect(inventory.outOfScope).to.include.members(['variants', 'non-default languages']);
    expect(inventory.items.map((item) => item.family)).to.have.members([
      'email',
      'emailTemplate',
      'brand',
      'image',
      'landingPage',
      'landingPageTemplate',
      'emailFragment',
      'webFragment',
      'form',
      'formHandler',
      'consentBanner',
    ]);
    expect(inventory.items).to.have.lengthOf(11);
    expect(new Set(inventory.items.map((item) => item.apiName)).size).to.equal(11);
    const listed = ['sfdx-project.json'];
    expect(JSON.parse(await readFile(path.join(root, 'sfdx-project.json'), 'utf8'))).to.deep.equal({
      packageDirectories: [],
    });
    for (const item of inventory.items) {
      sourcePathSegment(item.apiName);
      sourcePathSegment(item.family);
      expect(item.definition).to.equal(
        `cms/Demo_Workspace/${item.family}/${item.apiName}.cms-${item.token}.json`,
      );
      listed.push(item.definition, ...item.companions);
      const definition = JSON.parse(
        await readFile(path.join(root, item.definition), 'utf8'),
      ) as DemoDefinition;
      expect(definition.identity).to.deep.equal({
        family: 'cms',
        type: item.type,
        apiName: item.apiName,
        context: { workspaceApiName: inventory.workspaceApiName },
      });
      expect(definition.language).to.equal(inventory.defaultLanguage);
      expect(definition.contentType).to.equal(`sfdc_cms__${item.family}`);
      expect(definition.contentBody).to.be.an('object');
      expect(definition.contentBody['sfdc_cms:title']).to.equal(definition.title);
      expect(definition.contentBody).not.to.have.property('rawHtml');
      expect(definition.folderPath).to.be.an('array');
      for (const segment of definition.folderPath) sourcePathSegment(segment);
      expect(
        Object.values(definition.companions).map(
          (name) => `cms/Demo_Workspace/${item.family}/${name}`,
        ),
      ).to.deep.equal(item.companions);
      for (const companion of item.companions) {
        expect(path.posix.dirname(companion)).to.equal(path.posix.dirname(item.definition));
        expect(path.posix.basename(companion)).to.match(
          new RegExp(String.raw`^${item.apiName}\.cms-${item.token}\.(?:html|svg)$`, 'u'),
        );
        expect(await readFile(path.join(root, companion), 'utf8')).not.to.equal('');
      }
      if (item.status === 'current-contract') {
        assertPortablePayload(definition);
        assertSourceDefinition(definition);
        expect(definition.folderPath).to.deep.equal([]);
        if (definition.companions.rawHtml) {
          assertSourceNativeHtml(
            definition.contentType,
            definition.contentBody,
            await readFile(
              path.join(root, path.posix.dirname(item.definition), definition.companions.rawHtml),
              'utf8',
            ),
          );
        } else {
          expect(item.family).to.equal('brand');
          const expectedBrand = brandBody('Demo campaign brand');
          // The demo uses the existing complete inline Brand vocabulary with shorter fallback lists.
          expect(definition.contentBody).to.have.all.keys(expectedBrand);
        }
      } else {
        expect(item.status).to.equal('proposed-not-implemented');
        expect(item.gap).to.be.a('string').and.not.equal('');
        expect(definition).to.include({
          contract: 'sf-cms-demo-proposed-definition',
          contractVersion: '0.0.0',
        });
        expect(() => assertSourceDefinition(definition)).to.throw();
        if (item.family === 'image') {
          expect(definition.companions).to.deep.equal({ media: 'Campaign_Hero.cms-image.svg' });
          expect(await readFile(path.join(root, item.companions[0]), 'utf8'))
            .to.include('<svg')
            .and.include('</svg>');
        } else {
          expect(definition.contentBody['sfdc_cms:block']).to.include({
            definition: 'sfdc_cms/rootContentBlock',
            type: 'block',
          });
        }
      }
    }
    expect(await files(root)).to.deep.equal(listed.toSorted());
  });

  it('accounts for all 25 UI labels outside the retrieved tree without inventing support or files', async () => {
    const coverage = JSON.parse(await readFile(coverageFile, 'utf8')) as {
      format: string;
      labels: Array<{
        displayLabel: string;
        apiType: string | null;
        mappingStatus: string;
        providerSupport: string;
        evidence?: string;
        demoFamily: string | null;
      }>;
    };
    const inventory = JSON.parse(await readFile(inventoryFile, 'utf8')) as {
      items: InventoryItem[];
    };
    expect(coverage.format).to.equal('sf-cms-demo-ui-coverage@1');
    expect(coverage.labels.map((entry) => entry.displayLabel)).to.deep.equal([
      'Audio',
      'Brand',
      'Consent Banner',
      'Contact Card (VCF)',
      'Content Block: Email',
      'Content Block: Landing Page',
      'Custom Font',
      'Document',
      'Email',
      'Email Template',
      'Expression',
      'Form',
      'Form Handler',
      'Image',
      'In-App Message',
      'Landing Page',
      'Landing Page Template',
      'Preference Page',
      'Push Notification Message',
      'RCS Message',
      'SMS and MMS',
      'Tracked Link',
      'Video',
      'WhatsApp Session Message',
      'WhatsApp Template Message',
    ]);
    expect(coverage.labels.filter((entry) => entry.demoFamily !== null)).to.have.lengthOf(11);
    expect(
      coverage.labels.filter((entry) => entry.mappingStatus === 'unresolved'),
    ).to.have.lengthOf(13);
    for (const entry of coverage.labels) {
      if (entry.mappingStatus === 'unresolved') {
        expect(entry).to.include({
          apiType: null,
          providerSupport: 'unresolved',
          demoFamily: null,
        });
        expect(entry).not.to.have.property('evidence');
      } else {
        expect(entry.mappingStatus).to.equal('verified');
        expect(entry.providerSupport).not.to.equal('unresolved');
        expect(entry.evidence).to.match(/^src\/.+\.ts$/u);
        const evidence = await readFile(new URL(`../${entry.evidence}`, import.meta.url), 'utf8');
        expect(evidence, entry.displayLabel).to.include(entry.apiType);
      }
      if (entry.demoFamily !== null) {
        const item = inventory.items.find((candidate) => candidate.family === entry.demoFamily);
        expect(item, entry.displayLabel).not.to.equal(undefined);
        expect(item?.displayLabel).to.equal(entry.displayLabel);
        expect(entry.apiType).to.equal(`sfdc_cms__${item?.family}`);
      }
    }
    expect(inventory.items.find((item) => item.family === 'emailFragment')).to.include({
      displayLabel: 'Content Block: Email',
      type: 'Email Fragment',
      token: 'email-fragment',
    });
    expect(inventory.items.find((item) => item.family === 'webFragment')).to.include({
      displayLabel: 'Content Block: Landing Page',
      type: 'Web Fragment',
      token: 'web-fragment',
    });
    for (const metadataFile of [inventoryFile, coverageFile]) {
      expect(path.relative(root, metadataFile).startsWith('..')).to.equal(true);
      const text = await readFile(metadataFile, 'utf8');
      expect(text).not.to.include('\r');
      expect(text.codePointAt(0)).not.to.equal(65_279);
      expect(text.endsWith('\n')).to.equal(true);
    }
  });

  it('contains only LF/no-BOM fictional source files and no source org identities or secrets', async () => {
    for (const filename of await files(root)) {
      const text = await readFile(path.join(root, filename), 'utf8');
      expect(text, filename).not.to.include('\r');
      expect(text.codePointAt(0), filename).not.to.equal(65_279);
      expect(text.endsWith('\n'), filename).to.equal(true);
      expect(text, filename).not.to.match(
        /"(?:contentKey|managedContentId|managedContentVariantId|contentSpace|sourceOrgId|workspaceId|folderId|authorization|cookie)"\s*:/iu,
      );
      expect(text, filename).not.to.match(/\b(?:00D|0CW|9Pu)[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?\b/u);
      expect(text, filename).not.to.match(
        /Bearer\s+[A-Za-z0-9]|https?:\/\/[^\s"]*salesforce\.com/iu,
      );
    }
  });
});
