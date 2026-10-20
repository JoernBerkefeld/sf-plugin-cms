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
  it('documents neutral resolved org notices and suppression boundaries', async () => {
    const readme = await readFile(readmeFile, 'utf8');
    for (const claim of [
      'Using org my-org (user@example.com)',
      'both explicit',
      'implicit configured selections',
      'JSON mode, offline `info`, help and failed parsing',
    ])
      expect(readme).to.include(claim);
  });
  it('documents matching workspace and channel pagination semantics', async () => {
    const readme = await readFile(readmeFile, 'utf8');
    for (const resource of ['workspace', 'channel']) {
      const section = readme.split(`### \`sf content list ${resource}\``)[1].split('\n### ')[0];
      for (const claim of [
        'all pages',
        'one-based page number',
        '`--page-size` alone requests only the first page',
        'both flags select page N',
        'Enumeration safety failures are errors',
      ])
        expect(section).to.include(claim);
      const messages = await readFile(
        new URL(`../messages/cms.list.${resource}.md`, import.meta.url),
        'utf8',
      );
      expect(messages).to.include('One-based page number (first page is 1).');
      expect(messages).to.include('Supply --page or --page-size to select one page.');
    }
  });
  it('documents workspace presentation independently from unchanged JSON and list requests', async () => {
    const readme = await readFile(readmeFile, 'utf8');
    const workspace = readme
      .split('### `sf content list workspace`')[1]
      .split('### `sf content list channel`')[0];
    for (const claim of [
      'spaceType.apiName',
      'Marketing, Content and Enablement',
      'isEnhancedSpace: true',
      'Unknown',
      'Neither column is inferred',
      'JSON retains the complete normalized API records',
      'Aggregate output is `{ items, total }`',
      'Explicit single-page output preserves API metadata unchanged',
      'no workspace-detail requests',
    ])
      expect(workspace).to.include(claim);
  });
  it('documents project-local and explicit global org defaults with per-command overrides', async () => {
    const readme = await readFile(readmeFile, 'utf8');
    const gettingStarted = readme
      .split('## Installation and getting started')[1]
      .split('## Download, edit and save one Email')[0];
    const authentication = gettingStarted.split('### Authenticate an org')[1];
    const defaults = authentication
      .split('### Choose a default org')[1]
      .split('### Install the plugin')[0];
    expect(authentication).to.include('sf org login web --alias isolated-source\n');
    expect(authentication).to.include('sf org display --target-org isolated-source');
    expect(authentication).not.to.include('--set-default');
    expect(authentication.indexOf('For a sandbox')).to.be.lessThan(
      authentication.indexOf('### Choose a default org'),
    );
    expect(defaults).to.include(
      '**only inside a valid Salesforce project containing `sfdx-project.json`**',
    );
    expect(defaults).to.include(
      'sf config set target-org=isolated-source\nsf config get target-org',
    );
    expect(defaults).to.include(
      'Outside a Salesforce project, pass `--target-org isolated-source` on each org-backed command',
    );
    expect(defaults).to.include(
      'sf config set target-org=isolated-source --global\nsf config get target-org',
    );
    expect(defaults).to.include('A project-local default overrides the global default.');
    expect(defaults).to.include(
      'Explicit `-o` / `--target-org` overrides the configured default for that command only, without changing either default.',
    );
    expect(defaults).to.include('sf content list workspace --target-org isolated-target');
  });

  it('documents conventional deploy metadata and file-or-directory alternatives without compatibility flags', async () => {
    const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8');
    expect(readme).to.include('--metadata -m Type[:ApiName]');
    expect(readme).to.include('No selectors means an error');
    expect(readme).to.include('Source-dir accepts definition files or directories');
    expect(readme).not.to.include('--definition-file ./');
    expect(DeployContent.flags).not.to.have.property('definition-file');
    expect(
      DeployContent.examples.every(
        (example) => !(example.includes('-d ') && example.includes('-m ')),
      ),
    ).to.equal(true);
  });
  it('documents upload execution, preview and opt-in operation evidence', async () => {
    const readme = await readFile(readmeFile, 'utf8');
    const upload = readme.split('### `sf content upload`')[1].split('### `sf content info`')[0];
    expect(upload).to.include('Execution is the default');
    expect(upload).to.include('Preview rejects `--report` and `--report-dir`');
    expect(upload).to.include('no crash-surviving structured journal');
    expect(upload).to.include('in-memory');
    expect(upload).not.to.include('--apply --report-dir');
  });

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
      'content upload',
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
      'Salesforce documents a 25 MB Image limit.',
      'Document/Audio retrieval, deploy and loose-image upload are also listed.',
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
      'Native Document bytes and safe declared MIME are preserved without UTF-8 conversion or a source-level 10 MiB cap',
      'safe same-stem paths, nonempty bytes and native size/hash integrity remain required',
      'Explicit download budgets still bind',
      'Document retrieval, CREATE, bytes-only UPDATE and exact unchanged remain unqualified',
      'Bounded two-org development-artifact acceptance covers the tested text/plain profile',
      'released-package verification remains separate',
      'opaque nonempty runtime-representable bytes, safe native MIME',
      'no client format whitelist, UTF-8 conversion, suffix restriction or 10 MiB cap',
      'Explicit caller download budgets still bind',
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
      'Available (API-led)',
      'Available (bytes only)',
      'Available (API-led)',
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
    for (const text of [readme, RetrieveContent.description, DeployContent.description]) {
      expect(text).to.include(
        'no client format whitelist, UTF-8 conversion, suffix restriction or 10 MiB cap',
      );
      expect(text).not.to.include(
        'Document deploy requires root/default-language UTF-8 text/plain bytes',
      );
      expect(text).not.to.include('nonempty up to 10 MiB and a safe ASCII lowercase .txt filename');
    }
    expect(RetrieveContent.description).to.include('Explicit caller download budgets still bind');
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
      'retrieve, deploy and delete accept `email`, `emailTemplate`, `image`, `document`, `audio`',
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
      'Video deployment remains closed; 0.20 qualification and local sync are deferred.',
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
      'Available (API-led)',
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
      'sf org login web --alias isolated-source',
      'spellings used here are aliases, with identical flags and behavior',
      'sf content retrieve --workspace-name Marketing -m email:Welcome\n',
      'sf content retrieve --workspace-name Marketing -m email\n',
      'sf content retrieve --workspace-name Marketing -m email -m emailTemplate\n',
      'sf content retrieve --workspace-name Marketing -m email:Welcome -m email:Reminder',
      'sf content deploy --workspace-name Marketing --default-language -m email:Welcome --report',
      'sf content deploy --workspace-name Marketing --default-language -m audio:Intro --preview --json',
      '--apply --acknowledge-no-send --report-dir ./cms-publish-report',
      'sf content delete --workspace-id 0Zu... -m image:Banner -m audio:Intro --language "*" --report --json',
      'It cannot be mixed with `--content-type`, `--api-name`, `--content-key-or-id`, or `--all`.',
    ])
      expect(readme, example).to.include(example);
    expect(readme).to.include('Deploy executes by default');
    expect(readme).to.include('./logs/cms/reports/<timestamp>-<unique-id>/');
    expect(readme).to.include('no crash-surviving structured operation journal');
    expect(DeployContent.flags).not.to.have.property('apply');
    expect(DeployContent.flags).to.have.property('preview');
    expect(DeployContent.flags).to.have.property('report');
    expect(
      readme
        .split('\n')
        .filter((line) => line.startsWith('sf content deploy '))
        .every((line) => !line.includes('--apply')),
    ).to.equal(true);
    expect(readme).not.to.include('./project/cms/');
    expect(readme).not.to.include('sf content retrieve -W');
    expect(readme).not.to.include('sf cms info --contract-version 1 --json');
  });

  it('documents automatic logs, opt-in API payloads and customer-content precautions', async () => {
    const readme = await readFile(readmeFile, 'utf8');
    for (const claim of [
      'automatically write one diagnostic log under `logs/cms/`',
      '2026-10-19T21.11.00.000Z.log',
      'installed plugin version and exact received command tokens, subject to secret redaction',
      "does not reconstruct your shell's original quoting",
      'terminal diagnostics, warnings, errors and stack traces',
      'complete rows and columns are recorded as structured data',
      '`--api log` to opt in to request/response payload details',
      'not a raw HTTP wire capture',
      'not comprehensive PII redaction',
      'customer content or other sensitive data',
      '**Inspect before sharing**',
      "**consuming project's `.gitignore`**",
    ])
      expect(readme, claim).to.include(claim);
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
      'content-delete-run.json',
      'Historical revisions, references and other collateral effects are not proven preserved',
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
