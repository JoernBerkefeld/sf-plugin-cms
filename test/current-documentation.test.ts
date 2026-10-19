import { expect } from 'chai';
import { readFile } from 'node:fs/promises';
import DeployContent from '../src/commands/cms/deploy/content.js';
import RetrieveContent from '../src/commands/cms/retrieve/content.js';

const readmeFile = new URL('../README.md', import.meta.url);

const launcher = async (): Promise<{
  createCoverageRun: () => Promise<{ root: string; raw: string }>;
  validateTemp: (environment?: NodeJS.ProcessEnv, actualTemp?: string) => void;
  runCommand: (args: string[]) => Promise<{ code: number | null; signal: string | null }>;
}> => import(new URL('../scripts/test-coverage.mjs', import.meta.url).href);

describe('coverage launcher configuration', () => {
  it('allocates distinct marked registered raw roots without mixing stale runs', async () => {
    const { createCoverageRun } = await launcher();
    const first = await createCoverageRun();
    const second = await createCoverageRun();
    const { tmpdir } = await import('node:os');
    const { default: path } = await import('node:path');
    const { readdir } = await import('node:fs/promises');
    expect(path.dirname(first.root)).to.equal(tmpdir());
    expect(first.root).not.to.equal(second.root);
    expect(path.dirname(first.raw)).to.equal(first.root);
    expect(await readdir(first.raw)).to.deep.equal([]);
    expect(await readdir(second.raw)).to.deep.equal([]);
    const marker = await readFile(path.join(first.root, '.sf-cms-run-owner'), 'utf8');
    expect(marker).to.match(/^[\da-f-]{36}$/u);
    expect(
      JSON.parse(await readFile(path.join(first.root, 'registered-paths.json'), 'utf8')),
    ).to.deep.equal({ marker, paths: [first.raw] });
  });

  it('fails closed on relative or mismatched temp environment and actual tmpdir', async () => {
    const { validateTemp } = await launcher();
    expect(() => validateTemp({ ...process.env, TEMP: 'relative' })).to.throw();
    expect(() => validateTemp({ ...process.env, TMP: 'relative' })).to.throw();
    expect(() => validateTemp({ ...process.env, TMPDIR: 'relative' })).to.throw();
    expect(() => validateTemp(process.env, 'relative')).to.throw();
    validateTemp();
  });

  it('propagates child failure status without converting it to success', async () => {
    const { runCommand } = await launcher();
    expect(await runCommand(['-e', 'process.exit(7)'])).to.deep.equal({ code: 7, signal: null });
  });

  it('pins ESM-native c8 while preserving full compile and Mocha discovery', async () => {
    const manifest = JSON.parse(
      await readFile(new URL('../package.json', import.meta.url), 'utf8'),
    );
    expect(manifest.devDependencies.c8).to.equal('12.0.0');
    expect(manifest.scripts.test).to.equal('npm run compile && node scripts/test-coverage.mjs');
    const config = await readFile(new URL('../.mocharc.cjs', import.meta.url), 'utf8');
    expect(config).to.include('test/**/*.test.ts');
    expect(config).to.include('loader=ts-node/esm');
  });
});

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
      'content info',
      'content list workspace',
      'content list channel',
      'content retrieve',
      'content deploy',
      'content upload images',
      'content publish',
      'content unpublish',
      'content delete',
    ]) {
      expect(readme).to.include(`### \`sf ${command}\``);
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
      'For this Image workflow, URL-only sources, nested folders, multiple variants, published targets and metadata-changing UPDATE remain unsupported',
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

  it('aligns README and command help on bounded unqualified Document support', async () => {
    const readme = await readFile(readmeFile, 'utf8');
    for (const claim of [
      '**Bounded Document retrieval:**',
      '**Bounded Document deployment:**',
      'UTF-8 contents are not restricted to ASCII',
      'Document retrieval, CREATE, bytes-only UPDATE and exact unchanged remain unqualified',
      'Bounded two-org development-artifact acceptance covers the tested text/plain profile',
      'released-package verification remains separate',
      'nonempty UTF-8 `text/plain` bytes up to 10 MiB',
      'safe ASCII companion filename with lowercase `.txt` extension',
      'Document profile bounds, not Salesforce caps or Image restrictions',
      'Exact metadata, native filename, MIME and bytes',
      'All other Document differences block the whole selection before mutation',
      'Document UPDATE never falls back to Image transport',
      'metadata, filename, MIME, language and type changes remain unsupported',
      'zero created parents',
      '`content.retrieve.document`',
      '`content.deploy.document.create`',
      '`content.deploy.document.unchanged`',
      '`content.deploy.document.update`',
    ]) {
      expect(readme, claim).to.include(claim);
    }
    const documentRow = readme.split('\n').find((line) => /^\| Document\s+\|/u.test(line));
    expect(
      documentRow
        ?.split('|')
        .slice(1, -1)
        .map((cell) => cell.trim()),
    ).to.deep.equal([
      'Document',
      '`sfdc_cms__document`',
      'Available (limited)',
      'Available (text/plain)',
      'Available (bytes only)',
      'Not supported',
    ]);
    for (const obsolete of [
      'Bounded Document retrieval (retrieval only)',
      'Document deploy remains blocked',
      'retrieval-only Document profile',
      'its deploy operations remain blocked',
      'Documents are not deployable',
      'Document is not admitted by this command',
      'Current immutable-artifact two-org UPDATE qualification is pending',
      'pending current immutable-artifact two-org UPDATE qualification',
    ]) {
      expect(readme, obsolete).not.to.include(obsolete);
    }
    expect(RetrieveContent.description).to.include(
      'unqualified CREATE, bytes-only UPDATE and exact unchanged',
    );
    expect(RetrieveContent.description).to.include(
      'with bounded two-org development-artifact acceptance for the tested text/plain profile',
    );
    expect(RetrieveContent.description).not.to.include('Documents are not deployable');
    expect(DeployContent.summary).to.include('Document');
    expect(DeployContent.flags['content-type'].summary).to.include('Document');
    expect(DeployContent.description).to.include(
      'Documents support CREATE, bytes-only UPDATE and exact unchanged',
    );
    expect(DeployContent.description).to.include(
      'unchanged metadata, native filename, MIME, language and type',
    );
    expect(DeployContent.description).to.include(
      'unqualified; bounded two-org development-artifact acceptance covers the tested text/plain profile',
    );
    expect(DeployContent.description).to.include('never falls back to Image transport');
    expect(DeployContent.description).to.include(
      'all other Document differences block the whole selection before mutation',
    );
    expect(RetrieveContent.flags['content-type'].summary).to.include('document');
    expect(RetrieveContent.flags['content-type'].summary).to.include('sfdc_cms__ names');
  });

  it('documents retrieve defaults, exact operation aliases and bounded two-org Audio evidence', async () => {
    const readme = await readFile(readmeFile, 'utf8');
    for (const claim of [
      'sf content retrieve --workspace-name "Content Workspace for Marketing Cloud"',
      './cms/<workspaceAPI>/',
      'current directory',
      'configured default org',
      'workspace default language',
      'Explicit `-t` still requires',
      'All eight org-backed commands use your configured Salesforce CLI default org',
      'Org defaults do not supply or broaden workspace, language, source, mutation or ownership selectors.',
      'Offline `content info` needs no org.',
      'Case and whitespace are not normalized',
      'delete accepts only `email` and `emailTemplate`',
      'Audio deployment implements CREATE, bytes-only UPDATE and exact unchanged, all unqualified',
      '`content.retrieve.audio`',
      '`content.deploy.audio.create`',
      '`content.deploy.audio.update`',
      '`content.deploy.audio.unchanged`',
      'all **unqualified**; bounded two-org development-artifact acceptance covers the tested 844-byte WAV profile, not general-format or released-package qualification',
      'Do not infer native qualification from capability discovery or command availability.',
      'tested 844-byte WAV profile',
      'zero-write unchanged and public retrieval with independent native identity, inventory and exact-byte readbacks',
      '**0.19.0**',
      'Current Document profile bounds and unsupported Video operations remain unchanged',
    ])
      expect(readme, claim).to.include(claim);
    expect(readme).not.to.include(
      'No configured default org or implicit directory/language scope is used',
    );
    const audioRow = readme.split('\n').find((line) => /^\| Audio\s+\|/u.test(line));
    expect(
      audioRow
        ?.split('|')
        .slice(1, -1)
        .map((cell) => cell.trim()),
    ).to.deep.equal([
      'Audio',
      '`sfdc_cms__audio`',
      'Available (limited)',
      'Available (unqualified)',
      'Available (bytes only)',
      'Not supported',
    ]);
    expect(readme).not.to.include('Audio deployment is not enabled');
    expect(readme).not.to.include('not yet listed in the offline capability registry');
    expect(readme).not.to.include('deploy accepts the first four');
    for (const text of [readme, RetrieveContent.description, DeployContent.description]) {
      expect(text).to.include(
        'two-org development-artifact acceptance covers the tested 844-byte WAV profile',
      );
      expect(text).to.include('general-format or released-package qualification');
      expect(text).not.to.match(
        /native (?:Audio )?CREATE\/UPDATE and two-org qualification remain pending/iu,
      );
      expect(text).not.to.include('only an 844-byte primary WAV');
    }
    expect(DeployContent.summary).to.include('Audio');
    expect(DeployContent.flags['content-type'].summary).to.include('audio');
    expect(DeployContent.description).to.include(
      'Audio supports unqualified CREATE, bytes-only UPDATE and exact unchanged',
    );
    expect(DeployContent.examples.join('\n')).to.include('-m audio:Intro');
    expect(RetrieveContent.examples.join('\n')).to.include('-t email');
    expect(DeployContent.examples.join('\n')).to.include('-m email:Welcome');
    expect(DeployContent.flags['content-type'].summary).to.include('sfdc_cms__ names');
  });

  it('keeps concise metadata examples without omitting required mutation scope', async () => {
    const readme = await readFile(readmeFile, 'utf8');
    for (const example of [
      'sf org login web --alias my-org --set-default',
      'aliases in the upcoming 0.19 release',
      'sf content retrieve --workspace-name Marketing -m email:Welcome\n',
      'sf content retrieve --workspace-name Marketing -m email\n',
      'sf content retrieve --workspace-name Marketing -m email -m emailTemplate\n',
      'sf content retrieve --workspace-name Marketing -m email:Welcome -m email:Reminder',
      'sf content deploy --workspace-name Marketing --default-language --definition-file ./cms/Marketing/email/Welcome.cms-email.json --apply --report-dir ./reports/welcome-001',
      'sf content deploy --workspace-name Marketing --default-language --source-dir ./cms/Marketing -m audio:Intro --json',
      '--apply --acknowledge-no-send --report-dir ./cms-publish-report',
      '--ownership-report ./delete-ownership.json --apply --acknowledge-permanent-delete --report-dir ./cms-delete-report',
      'It cannot be mixed with `--content-type`, `--api-name`, `--content-key-or-id`, or `--all`.',
    ])
      expect(readme, example).to.include(example);
    expect(readme).not.to.include('./project/cms/');
    expect(readme).not.to.include('sf content retrieve -W');
    expect(readme).not.to.include('sf cms info --contract-version 1 --json');
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
