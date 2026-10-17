import { expect } from 'chai';
import { readFile } from 'node:fs/promises';
import DeployContent from '../src/commands/cms/deploy/content.js';
import RetrieveContent from '../src/commands/cms/retrieve/content.js';

const readmeFile = new URL('../README.md', import.meta.url);

describe('current public documentation', () => {
  it('omits historical command and internal-engine appendices', async () => {
    const readme = await readFile(readmeFile, 'utf8');
    for (const obsolete of [
      '## Upgrading to 0.14.0',
      '## Advanced: retained internal engines',
      '### Internal workspace export baselines',
      '### Retained internal workspace import engines',
      'Retained internal update engine and historical import recovery notes',
      '### Internal Draft HTML update engine',
      '### Internal-engine package layout and integrity',
      '## Contributor notes: retained internal experimental workspace export',
      'sf-cms-workspace-export-set@1',
      'sf-cms-external-reference-correlations@1',
      'sf-cms-workspace-import@1',
      'without aliases',
      'Historical evidence:',
      'contract 1)',
      'contract 2)',
    ]) {
      expect(readme, obsolete).not.to.include(obsolete);
    }
    expect(readme).not.to.match(/\bPhase \d+\b|\b0\.(?:11|12|13|14)\.0\b/);
    expect(readme).not.to.include('<details>');
  });

  it('retains current commands, schema identities and illustrative plugin versions', async () => {
    const readme = await readFile(readmeFile, 'utf8');
    for (const command of [
      'info',
      'list workspace',
      'list channel',
      'retrieve content',
      'deploy content',
      'upload images',
      'publish content',
      'unpublish content',
      'delete content',
    ]) {
      expect(readme).to.include(`### \`sf cms ${command}\``);
    }
    for (const schema of [
      'sf-cms-info@1',
      'sf-cms-content-retrieve@1',
      'sf-cms-media-source@1',
      'sf-cms-content-deploy@1',
      'sf-cms-images-upload@1',
      'sf-cms-content-delete@1',
      'sf-cms-content-delete@2',
      'sf-cms-email-delete-ownership@1',
      'sf-cms-content-publish@1',
      'sf-cms-content-unpublish@1',
    ]) {
      expect(readme, schema).to.include(schema);
    }
    expect(readme).to.include('"version": "<installed-plugin-version>"');
    expect(readme).to.include('"pluginVersion": "<installed-plugin-version>"');
    expect(readme).to.include('illustrative, not release identifiers');
    expect(readme).to.include('## Development');
    expect(readme).to.include('imaginary result of a future retrieve-all operation');
  });

  it('documents API-led Image admission without claiming live format qualification', async () => {
    const readme = await readFile(readmeFile, 'utf8');
    for (const claim of [
      'Available (API-led)',
      'Available (bytes only)',
      '## Download, edit and save one PNG Image',
      'edit **only the PNG companion bytes**',
      'Marketing workspace and its default language',
      'Existing targets must be unpublished primary Drafts with their native filename already exactly `<apiName>.cms-image.media.png`',
      'Retrieval normalizes the companion filename, so retrieval alone does not prove deploy eligibility',
      'A native filename mismatch blocks deploy; filename and metadata updates are unsupported',
      'URL-only sources, Documents, nested folders, multiple variants, published targets and metadata-changing UPDATE remain unsupported',
      'the client does NOT cap at 25 MB',
      '**Live qualification pending:**',
      'the exact byte boundary has not been proven',
      'local admission does not establish that all formats are accepted',
      'no Image format whitelist, signature-matching requirement or 10 MiB cap',
      '**Cross-org Image acceptance is pending**',
      '75 preexisting items unchanged',
      '`content.deploy.image.create|update|unchanged`',
    ]) {
      expect(readme, claim).to.include(claim);
    }
    expect(readme).not.to.include('Image developer deployment is not supported');
    expect(readme).not.to.include('retrieval-only local implementation');
    expect(DeployContent.description).to.include('bytes-only UPDATE');
    expect(DeployContent.description).to.include('does not establish cross-org qualification');
    expect(RetrieveContent.description).to.include(
      'Salesforce determines format and size acceptance',
    );
    expect(DeployContent.description).to.include('no client format whitelist or 25 MB cap');
    expect(RetrieveContent.description).not.to.include('deployment is not supported');
  });

  it('documents retrieval-only UTF-8 Documents without admitting deploy', async () => {
    const readme = await readFile(readmeFile, 'utf8');
    expect(readme).to.include('**Bounded Document retrieval (retrieval only):**');
    expect(readme).to.include('Document deploy remains blocked');
    expect(readme).to.include('UTF-8 contents are not restricted to ASCII');
    expect(readme).to.include('Document installed qualification remains pending');
    expect(readme).not.to.include('Document is not admitted by this command');
    expect(RetrieveContent.description).to.include('Document deployment remains blocked');
    expect(RetrieveContent.flags['content-type'].summary).to.include('sfdc_cms__document');
  });

  it('preserves recovery, qualification, ownership and API interoperability limits', async () => {
    const readme = await readFile(readmeFile, 'utf8');
    for (const safety of [
      'remote mutation and local journal persistence are not one atomic transaction',
      'content-deploy-run.json',
      'pending or uncertain entries read-only',
      'even when no returned ID was saved',
      'Do not replay a completed write or retry an unresolved one',
      'journals are not a resume mechanism',
      'new nonexisting report directory',
      'workspace-import-run.json',
      'VARIANT_NOT_FOUND',
      'ownership-uncertain',
      'differing JSON metadata or text companions block the whole selection',
      'no live image upload has been performed',
      'qualification: "unqualified"',
      '/services/data/latest',
      'numeric Core/JSforce connection version',
      '`67.0` fallback',
      '--api-version <numeric-version>',
      '--api-version latest',
      'Authentication, permission and transport failures do not trigger fallback',
      'failed mutations are never replayed at a fallback version',
    ]) {
      expect(readme, safety).to.include(safety);
    }
  });
});
