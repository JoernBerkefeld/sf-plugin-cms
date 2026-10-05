import { expect } from 'chai';
import { createHash } from 'node:crypto';
import { brandDetail } from '../fixtures/brand.js';
import type { WorkspaceExportManifest } from '../../src/contracts/workspace-export.js';
import { link, mkdir, mkdtemp, readFile, rename, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { exportWorkspace } from '../../src/services/export-workspace.js';
import {
  executeWorkspaceImport,
  loadWorkspaceExport,
  planSourceWorkspaceImport,
  revalidateSourceWorkspaceImport,
} from '../../src/services/import-workspace.js';
import {
  loadSourceDefinitions,
  validateSourceDefinitionFiles,
} from '../../src/services/source-definition-import.js';
import {
  projectSourceDefinitions,
  type SourceDefinitionInputItem,
} from '../../src/services/source-definition.js';

const inventoryRow = (id = 'existing', workspace = 'target') => ({
  id,
  managedContentSpaceId: workspace,
  type: 'ManagedContentVariantSearchResultRepresentation',
});
const inventoryDetail = (apiName = 'Other', id = 'existing') => ({
  managedContentVariantId: id,
  managedContentId: `parent-${id}`,
  apiName,
  contentSpace: { id: 'target' },
  contentType: { fullyQualifiedName: 'sfdc_cms__image' },
});

async function failure(operation: Promise<unknown>, pattern: RegExp): Promise<void> {
  try {
    await operation;
  } catch (error) {
    expect((error as Error).message).to.match(pattern);
    return;
  }
  throw new Error('Expected rejection');
}

async function replaceArtifact(sourceDirectory: string, file: string, bytes: string | Buffer) {
  await writeFile(path.join(sourceDirectory, file), bytes);
  const manifest = JSON.parse(
    await readFile(path.join(sourceDirectory, 'manifest.json'), 'utf8'),
  ) as WorkspaceExportManifest;
  const changed = {
    ...manifest,
    items: manifest.items.map((item) =>
      item.path === file
        ? { ...item, sha256: createHash('sha256').update(bytes).digest('hex') }
        : item,
    ),
  };
  await writeFile(path.join(sourceDirectory, 'manifest.json'), JSON.stringify(changed));
  return loadWorkspaceExport(sourceDirectory);
}

function original(contentType = 'sfdc_cms__email'): SourceDefinitionInputItem {
  const raw = {
    managedContentVariantId: 'variant',
    managedContentId: 'parent',
    contentKey: 'key',
    contentSpace: { id: 'space' },
    apiName: 'Welcome',
    contentType: { fullyQualifiedName: contentType },
    language: 'en_US',
    title: 'Welcome',
    folder: null,
    contentBody: {
      'sfdc_cms:title': 'Welcome',
      messagePurpose: 'Transactional',
      ...(contentType === 'sfdc_cms__email' ? { subjectLine: 'Hello' } : {}),
      rawHtml: '&lt;p&gt;Hello &amp;amp; café&lt;/p&gt;',
      'lightning:expressions': [],
      'sfdc_cms:variants': [],
    },
  };
  return {
    workspaceApiName: 'Demo',
    workspaceId: 'space',
    apiName: 'Welcome',
    contentType,
    folderPath: [],
    variantId: 'variant',
    raw,
    parent: {
      managedContentId: 'parent',
      contentType: raw.contentType,
      contentSpace: raw.contentSpace,
      folder: null,
    },
    siblings: { complete: true, variants: [raw] },
  };
}

describe('strict source definition import checkpoints', () => {
  let root: string;
  let baseline: string;
  let definitions: string;
  let input: SourceDefinitionInputItem;
  let json: string;
  let html: string;
  beforeEach(async () => {
    // Newly owned OS-temp fixtures are retained; no recursive cleanup is invoked.
    root = await mkdtemp(path.join(os.tmpdir(), 'cms-source-import-'));
    baseline = path.join(root, 'baseline');
    definitions = path.join(root, 'definitions');
    await mkdir(baseline);
    await mkdir(definitions);
    input = original();
    const item = projectSourceDefinitions([input]).items[0];
    json = path.join(definitions, item.definitionPath);
    html = path.join(definitions, item.htmlPath!);
    await mkdir(path.dirname(json), { recursive: true });
    await writeFile(json, item.definitionBytes);
    await writeFile(html, item.htmlBytes!);
  });
  const check = () => validateSourceDefinitionFiles([input], baseline, definitions);

  it('returns detached original/current hashes and literal edits without a second decode or integrity claim', async () => {
    const unchanged = await check();
    expect(unchanged.entries[0].changed).to.equal(false);
    expect(unchanged.entries[0].literalHtml).to.equal('<p>Hello &amp; café</p>');
    const edited = '<p>Edited &lt;literal&gt; 世界</p>';
    await writeFile(html, edited);
    const current = await check();
    expect(current.entries[0].literalHtml).to.equal(edited);
    expect(current.entries[0].changed).to.equal(true);
    expect(current.entries[0].originalHtmlSha256).to.equal(unchanged.entries[0].currentHtmlSha256);
    expect(current).not.to.have.property('integrity');
    expect(current).not.to.have.property('items');
    expect(input.raw.contentBody).to.have.property(
      'rawHtml',
      '&lt;p&gt;Hello &amp;amp; café&lt;/p&gt;',
    );
  });

  it('supports the Template projection without substituting family metadata', async () => {
    input = original('sfdc_cms__emailTemplate');
    const item = projectSourceDefinitions([input]).items[0];
    const target = path.join(root, 'template');
    await mkdir(path.dirname(path.join(target, item.definitionPath)), { recursive: true });
    await writeFile(path.join(target, item.definitionPath), item.definitionBytes);
    await writeFile(path.join(target, item.htmlPath!), item.htmlBytes!);
    const result = await validateSourceDefinitionFiles([input], baseline, target);
    expect(result.entries[0].changed).to.equal(false);
  });

  it('rejects any JSON edits including IDs, companion, language, body or whitespace drift', async () => {
    const bytes = await readFile(json);
    const value = JSON.parse(bytes.toString()) as Record<string, unknown>;
    for (const patch of [
      { language: 'de' },
      { contentBody: {} },
      { companions: { rawHtml: 'other.html' } },
      { id: 'source-id' },
    ]) {
      await writeFile(json, JSON.stringify({ ...value, ...patch }));
      await failure(check(), /JSON.*reprojection/u);
    }
    await writeFile(json, Buffer.concat([bytes, Buffer.from('\n')]));
    await failure(check(), /JSON.*reprojection/u);
  });

  it('rejects missing, substituted, new, case-aliased and image/body files', async () => {
    await rename(html, `${html}.saved`);
    await failure(check(), /missing.*substituted.*unlisted/u);
    await rename(`${html}.saved`, html);
    for (const name of ['body.json', 'image.png', 'WELCOME.cms-email.json']) {
      const extra = path.join(root, name);
      await writeFile(extra, '{}');
      await rename(extra, path.join(path.dirname(json), name));
      await failure(check(), /unlisted/u);
      await rename(path.join(path.dirname(json), name), extra);
    }
  });

  it('rejects unsafe original and edited HTML including personalization, BOM and malformed UTF-8', async () => {
    for (const bytes of [
      Buffer.from('<img src="unsafe">'),
      Buffer.from('<p>{{user}}</p>'),
      Buffer.from('\uFEFF<p>Hello</p>'),
      Buffer.from([255]),
    ]) {
      await writeFile(html, bytes);
      await failure(check(), /Unsupported|UTF-8/u);
    }
    input = structuredClone(input);
    const raw = input.raw as Record<string, unknown>;
    raw.contentBody = { ...(raw.contentBody as object), rawHtml: '<img src="unsafe">' };
    await failure(check(), /native|rawHtml/u);
  });

  it('rejects non-root, mixed family, duplicate and multi-variant projections', async () => {
    await failure(
      validateSourceDefinitionFiles([{ ...input, folderPath: ['Nested'] }], baseline, definitions),
      /root-only/u,
    );
    await failure(
      validateSourceDefinitionFiles([input, input], baseline, definitions),
      /Duplicate/u,
    );
    await failure(
      validateSourceDefinitionFiles(
        [{ ...input, siblings: { complete: true, variants: [input.raw, input.raw] } }],
        baseline,
        definitions,
      ),
      /single exact/u,
    );
    await failure(
      validateSourceDefinitionFiles(
        [{ ...input, contentType: 'sfdc_cms__image' }],
        baseline,
        definitions,
      ),
      /Unsupported/u,
    );
  });

  it('rejects overlapping routes, hard links and junctions before returning evidence', async () => {
    await failure(validateSourceDefinitionFiles([input], definitions, definitions), /overlap/u);
    await rename(html, path.join(root, 'original.html'));
    await link(path.join(root, 'original.html'), html);
    await failure(check(), /hard-link/u);
    const junction = path.join(root, 'junction');
    await symlink(definitions, junction, 'junction');
    await failure(validateSourceDefinitionFiles([input], baseline, junction), /symlink|reparse/u);
  });

  async function admitted(family = 'sfdc_cms__email', multiple = false) {
    const brand = family === 'sfdc_cms__brand';
    const acquired = brand
      ? { ...brandDetail('variant', 'Welcome', 'space'), folder: null }
      : original(family).raw;
    const second = {
      ...acquired,
      managedContentVariantId: 'variant2',
      managedContentId: 'parent2',
      contentKey: 'key2',
      apiName: 'Welcome2',
    };
    const parent = brand ? acquired : original(family).parent;
    const request = (async ({ url }: { url: string }) => {
      if (url.includes('/items/search'))
        return {
          count: multiple ? 2 : 1,
          items: (multiple ? ['variant', 'variant2'] : ['variant']).map((id) => ({
            id,
            managedContentSpaceId: 'space',
            type: 'ManagedContentVariantSearchResultRepresentation',
          })),
        };
      if (url.endsWith('/variants/variant2')) return second;
      if (url.endsWith('/contents/parent2')) return { ...parent, managedContentId: 'parent2' };
      if (url.includes('/variants/')) return acquired;
      if (url.includes('/spaces/')) return { id: 'space', name: 'Demo' };
      return parent;
    }) as unknown as Parameters<typeof exportWorkspace>[0]['request'];
    const exported = path.join(root, 'admitted');
    const target = path.join(root, 'admitted-source');
    await exportWorkspace({ request }, 'space', exported, {
      definitionDirectory: target,
      selection: {
        contentType: family,
        apiNames: multiple ? ['Welcome', 'Welcome2'] : ['Welcome'],
        // Raw-only Brand baselines retain the existing general profile semantics.
      },
    });
    const source = await loadWorkspaceExport(exported);
    return { source, target, acquired };
  }

  const destination = { id: 'target', rootFolderId: 'target-root', defaultLanguage: 'en_US' };
  const nativeCopyMappings = [
    { sourceContentKey: 'key', language: 'en_US', apiName: 'Copy', urlName: 'copy' },
  ];

  for (const family of ['sfdc_cms__email', 'sfdc_cms__emailTemplate']) {
    it(`plans ${family} with original identity and separately qualified edited literal HTML`, async () => {
      const { source, target } = await admitted(family);
      const options = {
        source,
        definitionDirectory: target,
        destinationWorkspace: destination,
        workspaceId: 'target',
        nativeCopyMappings,
      };
      const clean = await planSourceWorkspaceImport(options);
      expect(clean.proposal.items[0].contentBody.rawHtml).to.equal('<p>Hello &amp; café</p>');
      expect(clean.sourceDefinitions.edits.entries[0].changed).to.equal(false);
      await revalidateSourceWorkspaceImport(clean);
      const projected = projectSourceDefinitions(clean.sourceDefinitions.originals).items[0];
      const literal = '<p>Edited &lt;literal&gt; 世界</p>';
      await writeFile(path.join(target, projected.htmlPath!), literal);
      await failure(revalidateSourceWorkspaceImport(clean), /changed after planning/u);
      const edited = await planSourceWorkspaceImport(options);
      expect(edited.proposal.items[0].contentBody.rawHtml).to.equal(literal);
      expect(edited.source.items[0].contentBody.rawHtml).to.equal(
        '&lt;p&gt;Hello &amp;amp; café&lt;/p&gt;',
      );
      expect(edited.sourceDefinitions.originals[0].raw.contentBody).to.have.property(
        'rawHtml',
        '&lt;p&gt;Hello &amp;amp; café&lt;/p&gt;',
      );
      expect(edited.sourceDefinitions.edits.entries[0].changed).to.equal(true);
      expect(edited.destinationWorkspace.rootFolderId).to.equal('target-root');
      await revalidateSourceWorkspaceImport(edited);
      (edited.proposal.items[0].contentBody as Record<string, unknown>).rawHtml = '<p>Forged</p>';
      await failure(revalidateSourceWorkspaceImport(edited), /modified/u);
      await writeFile(path.join(target, projected.htmlPath!), '<img src="unsafe">');
      await failure(planSourceWorkspaceImport(options), /Unsupported/u);
      expect(source.items[0].contentBody.rawHtml).to.equal(
        '&lt;p&gt;Hello &amp;amp; café&lt;/p&gt;',
      );
    });
  }

  for (const family of ['sfdc_cms__email', 'sfdc_cms__emailTemplate']) {
    it(`applies edited ${family} to the distinct root with durable original/current proof`, async () => {
      const { source, target } = await admitted(family);
      const projected = projectSourceDefinitions([original(family)]).items[0];
      const literal = '<p>Current &lt;literal&gt; 世界</p>';
      await writeFile(path.join(target, projected.htmlPath!), literal);
      let posts = 0;
      let payload: Record<string, unknown> = {};
      const reportDirectory = path.join(root, 'apply-report');
      const request = (async ({
        method,
        url,
        body,
      }: {
        method: string;
        url: string;
        body?: string;
      }) => {
        if (url.includes('/items/search')) return { count: 0, items: [] };
        if (url.includes('/spaces/target')) return destination;
        if (method === 'POST') {
          posts += 1;
          const initial = JSON.parse(
            await readFile(path.join(reportDirectory, 'workspace-import-run.json'), 'utf8'),
          );
          expect(initial.operations).to.have.length(1);
          expect(initial.operations[0].state).to.equal('pending');
          expect(initial.sourceDefinitions.edits.entries[0].literalHtml).to.equal(literal);
          payload = JSON.parse(body!);
          return {
            contentKey: 'generated',
            managedContentId: 'new-parent',
            managedContentVariantId: 'new-variant',
          };
        }
        return {
          ...payload,
          contentKey: 'generated',
          managedContentId: 'new-parent',
          language: 'en_US',
          contentSpace: { id: 'target' },
          folder: { id: 'target-root' },
          isPublished: false,
          status: { status: 'Draft' },
        };
      }) as unknown as Parameters<typeof executeWorkspaceImport>[0]['connection']['request'];
      const result = await executeWorkspaceImport({
        connection: { request },
        destinationOrgId: 'org',
        destinationWorkspace: destination,
        workspaceId: 'target',
        sourceDirectory: source.sourceDirectory,
        loadedSource: source,
        definitionDirectory: target,
        nativeCopyMappings,
        reportDirectory,
      });
      expect(posts).to.equal(1);
      expect(payload.contentSpaceOrFolderId).to.equal('target-root');
      expect(payload).not.to.have.property('contentKey');
      expect(payload.contentBody).to.have.property('rawHtml', literal);
      expect(result.plan.source.items[0].contentBody.rawHtml).to.equal(
        (original(family).raw.contentBody as Record<string, unknown>).rawHtml,
      );
      expect(result.diagnostics.some(({ code }) => code === 'SOURCE_DEFINITION_INPUT')).to.equal(
        true,
      );
      const journal = JSON.parse(await readFile(result.reportFile!, 'utf8'));
      expect(journal.state).to.equal('completed');
      expect(journal.operations).to.have.length(1);
      expect(journal.sourceManifestSha256).to.equal(source.manifestSha256);
      expect(journal.sourceDestination).to.deep.equal(destination);
      expect(journal.sourceDefinitions.edits.entries[0].originalHtmlSha256).not.to.equal(
        journal.sourceDefinitions.edits.entries[0].currentHtmlSha256,
      );
    });
  }

  for (const family of ['sfdc_cms__email', 'sfdc_cms__emailTemplate']) {
    for (const mismatch of ['workspace', 'folder', 'missing-folder', 'transport']) {
      it(`retains uncertain ${family} ownership after ${mismatch} readback failure without retry`, async () => {
        const { source, target } = await admitted(family);
        const reportDirectory = path.join(root, 'readback-report');
        let posts = 0;
        let payload: Record<string, unknown> = {};
        const request = (async ({
          method,
          url,
          body,
        }: {
          method: string;
          url: string;
          body?: string;
        }) => {
          if (url.includes('/items/search')) return { count: 0, items: [] };
          if (url.includes('/spaces/target')) return destination;
          if (method === 'POST') {
            posts += 1;
            payload = JSON.parse(body!);
            return {
              contentKey: 'generated',
              managedContentId: 'new-parent',
              managedContentVariantId: 'new-variant',
            };
          }
          const pending = JSON.parse(
            await readFile(path.join(reportDirectory, 'workspace-import-run.json'), 'utf8'),
          );
          expect(pending.state).to.equal('ownership-uncertain');
          if (mismatch === 'transport') throw new Error('readback unavailable');
          return {
            ...payload,
            contentKey: 'generated',
            managedContentId: 'new-parent',
            language: 'en_US',
            contentSpace: { id: mismatch === 'workspace' ? 'other' : 'target' },
            ...(mismatch === 'missing-folder'
              ? {}
              : {
                  folder: { id: mismatch === 'folder' ? 'other-root' : 'target-root' },
                }),
            isPublished: false,
            status: { status: 'Draft' },
          };
        }) as unknown as Parameters<typeof executeWorkspaceImport>[0]['connection']['request'];
        await failure(
          executeWorkspaceImport({
            connection: { request },
            destinationOrgId: 'org',
            destinationWorkspace: destination,
            workspaceId: 'target',
            sourceDirectory: source.sourceDirectory,
            loadedSource: source,
            definitionDirectory: target,
            nativeCopyMappings,
            reportDirectory,
          }),
          /readback.*verification failed|readback unavailable/u,
        );
        expect(posts).to.equal(1);
        const journal = JSON.parse(
          await readFile(path.join(reportDirectory, 'workspace-import-run.json'), 'utf8'),
        );
        expect(journal.state).to.equal('ownership-uncertain');
        expect(journal.operations).to.have.length(1);
        expect(journal.operations[0].state).to.equal('succeeded');
        expect(journal.operations[0].result).to.deep.equal({
          contentKey: 'generated',
          contentId: 'new-parent',
          primaryVariantId: 'new-variant',
        });
        expect(journal.createdParents).to.have.length(1);
        expect(journal.sourceDestination).to.deep.equal(destination);
        expect(journal.sourceDefinitions.sourceManifestSha256).to.equal(source.manifestSha256);
      });
    }
  }

  for (const scenario of [
    'collision',
    'incomplete',
    'duplicate',
    'workspace',
    'detail-workspace',
    'detail-id',
    'missing-name',
    'ambiguous-name',
    'count-drift',
    'count-conflict',
  ]) {
    it(`blocks source ${scenario} inventory with zero POST`, async () => {
      const { source, target } = await admitted();
      let posts = 0;
      let searches = 0;
      const request = (async ({ method, url }: { method: string; url: string }) => {
        if (method === 'POST') {
          posts += 1;
          throw new Error('Unexpected POST');
        }
        if (url.includes('/items/search')) {
          expect(url).to.include('contentSpaceOrFolderIds=target');
          expect(url).not.to.include('contentTypeFQN');
          searches += 1;
          if (scenario === 'count-drift' && searches > 1) return { count: 3, items: [] };
          if (searches > 1) return { count: 2, items: [] };
          let items = [inventoryRow('existing', scenario === 'workspace' ? 'other' : 'target')];
          if (scenario === 'duplicate') items = [inventoryRow(), inventoryRow()];
          if (scenario === 'ambiguous-name') items = [inventoryRow(), inventoryRow('existing2')];
          return {
            count: ['incomplete', 'count-drift', 'duplicate', 'ambiguous-name'].includes(scenario)
              ? 2
              : 1,
            ...(scenario === 'count-conflict' ? { total: 2 } : {}),
            items,
          };
        }
        const detail = inventoryDetail(
          scenario === 'collision' ? 'Copy' : 'Other',
          url.endsWith('existing2') ? 'existing2' : 'existing',
        );
        if (scenario === 'detail-workspace') detail.contentSpace.id = 'other';
        if (scenario === 'detail-id') detail.managedContentVariantId = 'wrong';
        if (scenario === 'missing-name') detail.apiName = '';
        return detail;
      }) as unknown as Parameters<typeof executeWorkspaceImport>[0]['connection']['request'];
      await failure(
        executeWorkspaceImport({
          connection: { request },
          destinationOrgId: 'org',
          destinationWorkspace: destination,
          workspaceId: 'target',
          sourceDirectory: source.sourceDirectory,
          loadedSource: source,
          definitionDirectory: target,
          nativeCopyMappings,
          reportDirectory: path.join(root, 'inventory-report'),
        }),
        /collision|incomplete|completeness|ambiguous|count|identity/u,
      );
      expect(posts).to.equal(0);
    });
  }

  it('proves dry-run API-name absence with complete multi-page cross-family detail inventory', async () => {
    const { source, target } = await admitted();
    let searches = 0;
    let details = 0;
    const request = (async ({ method, url }: { method: string; url: string }) => {
      expect(method).not.to.equal('POST');
      if (url.includes('/items/search')) {
        searches += 1;
        return { count: 2, items: [inventoryRow(`existing${searches}`)] };
      }
      details += 1;
      return inventoryDetail(`Other${details}`, `existing${details}`);
    }) as unknown as Parameters<typeof executeWorkspaceImport>[0]['connection']['request'];
    const result = await executeWorkspaceImport({
      connection: { request },
      destinationOrgId: 'org',
      destinationWorkspace: destination,
      workspaceId: 'target',
      sourceDirectory: source.sourceDirectory,
      loadedSource: source,
      definitionDirectory: target,
      nativeCopyMappings,
      dryRun: true,
    });
    expect(searches).to.equal(2);
    expect(details).to.equal(2);
    expect(
      result.diagnostics.find(({ code }) => code === 'SERVER_CONFLICT_CHECK_UNVERIFIED')!.message,
    )
      .to.include('complete workspace-wide')
      .and.not.to.include('not prevalidated');
  });

  for (const scenario of ['single-collision', 'multiple-collision', 'multiple-success']) {
    it(`rechecks remaining identities before each CREATE: ${scenario}`, async () => {
      const multiple = scenario !== 'single-collision';
      const success = scenario === 'multiple-success';
      const { source, target } = await admitted('sfdc_cms__email', multiple);
      let searches = 0;
      let posts = 0;
      let payload: Record<string, unknown> = {};
      const request = (async ({
        method,
        url,
        body,
      }: {
        method: string;
        url: string;
        body?: string;
      }) => {
        if (url.includes('/items/search')) {
          searches += 1;
          if (searches === 1 || (multiple && searches === 2)) return { count: 0, items: [] };
          if (success) return { count: 1, items: [inventoryRow('created')] };
          return {
            count: multiple ? 2 : 1,
            items: multiple ? [inventoryRow(), inventoryRow('created')] : [inventoryRow()],
          };
        }
        if (url.includes('/spaces/')) return destination;
        if (url.endsWith('/variants/existing')) return inventoryDetail(multiple ? 'Copy2' : 'Copy');
        if (url.endsWith('/variants/created'))
          return { ...inventoryDetail('Copy', 'created'), managedContentId: 'new-parent1' };
        if (method === 'POST') {
          posts += 1;
          payload = JSON.parse(body!);
          return {
            contentKey: `generated${posts}`,
            managedContentId: `new-parent${posts}`,
            managedContentVariantId: `new-variant${posts}`,
          };
        }
        return {
          ...payload,
          contentKey: `generated${posts}`,
          managedContentId: `new-parent${posts}`,
          language: 'en_US',
          contentSpace: { id: 'target' },
          folder: { id: 'target-root' },
          isPublished: false,
          status: { status: 'Draft' },
        };
      }) as unknown as Parameters<typeof executeWorkspaceImport>[0]['connection']['request'];
      const apply = executeWorkspaceImport({
        connection: { request },
        destinationOrgId: 'org',
        destinationWorkspace: destination,
        workspaceId: 'target',
        sourceDirectory: source.sourceDirectory,
        loadedSource: source,
        definitionDirectory: target,
        nativeCopyMappings: multiple
          ? [
              ...nativeCopyMappings,
              { sourceContentKey: 'key2', language: 'en_US', apiName: 'Copy2', urlName: 'copy2' },
            ]
          : nativeCopyMappings,
        reportDirectory: path.join(root, 'fresh-report'),
      });
      if (success) {
        const result = await apply;
        const journal = JSON.parse(await readFile(result.reportFile!, 'utf8'));
        expect(journal.state).to.equal('completed');
        expect(journal.operations).to.have.length(2);
      } else await failure(apply, /collision/u);
      expect(posts).to.equal(success ? 2 : Number(multiple));
      expect(searches).to.equal(multiple ? 3 : 2);
    });
  }

  for (const acquisition of ['search', 'detail']) {
    for (const drift of ['html', 'journal']) {
      it(`blocks ${drift} drift during final collision ${acquisition} with zero POST`, async () => {
        const { source, target } = await admitted();
        const projected = projectSourceDefinitions([original()]).items[0];
        const reportDirectory = path.join(root, 'collision-drift-report');
        const reportFile = path.join(reportDirectory, 'workspace-import-run.json');
        let posts = 0;
        let searches = 0;
        let injected = false;
        const request = (async ({ method, url }: { method: string; url: string }) => {
          if (method === 'POST') {
            posts += 1;
            throw new Error('Unexpected mutation');
          }
          const search = url.includes('/items/search');
          if (search) searches += 1;
          if (
            searches === 2 &&
            ((acquisition === 'search' && search) ||
              (acquisition === 'detail' && url.endsWith('/variants/existing')))
          ) {
            injected = true;
            if (drift === 'html')
              await writeFile(
                path.join(target, projected.htmlPath!),
                '<p>Collision-time drift</p>',
              );
            else {
              const journal = JSON.parse(await readFile(reportFile, 'utf8'));
              journal.sourceDefinitions.edits.entries[0].literalHtml = '<p>Journal drift</p>';
              await writeFile(reportFile, JSON.stringify(journal));
            }
          }
          if (search) return { count: 1, items: [inventoryRow()] };
          if (url.endsWith('/variants/existing')) return inventoryDetail();
          return destination;
        }) as unknown as Parameters<typeof executeWorkspaceImport>[0]['connection']['request'];
        await failure(
          executeWorkspaceImport({
            connection: { request },
            destinationOrgId: 'org',
            destinationWorkspace: destination,
            workspaceId: 'target',
            sourceDirectory: source.sourceDirectory,
            loadedSource: source,
            definitionDirectory: target,
            nativeCopyMappings,
            reportDirectory,
          }),
          /changed after planning|durable apply evidence changed/u,
        );
        expect(injected).to.equal(true);
        expect(searches).to.equal(2);
        expect(posts).to.equal(0);
        const journal = JSON.parse(await readFile(reportFile, 'utf8'));
        expect(journal.state).to.equal('failed');
        expect(journal.createdParents).to.have.length(0);
        expect(journal.operations).to.have.length(1);
      });
    }
  }

  it('never retries an uncertain source CREATE and retains pending original/current evidence', async () => {
    const { source, target } = await admitted();
    let posts = 0;
    const reportDirectory = path.join(root, 'uncertain-report');
    const request = (async ({ method, url }: { method: string; url: string }) => {
      if (url.includes('/items/search')) return { count: 0, items: [] };
      if (method === 'POST') {
        posts += 1;
        throw Object.assign(new Error('uncertain server outcome'), { statusCode: 503 });
      }
      return destination;
    }) as unknown as Parameters<typeof executeWorkspaceImport>[0]['connection']['request'];
    await failure(
      executeWorkspaceImport({
        connection: { request },
        destinationOrgId: 'org',
        destinationWorkspace: destination,
        workspaceId: 'target',
        sourceDirectory: source.sourceDirectory,
        loadedSource: source,
        definitionDirectory: target,
        nativeCopyMappings,
        reportDirectory,
      }),
      /uncertain server outcome/u,
    );
    expect(posts).to.equal(1);
    const journal = JSON.parse(
      await readFile(path.join(reportDirectory, 'workspace-import-run.json'), 'utf8'),
    );
    expect(journal.state).to.equal('ownership-uncertain');
    expect(journal.operations[0].state).to.equal('pending');
    expect(journal.sourceDefinitions.sourceManifestSha256).to.equal(source.manifestSha256);
  });

  for (const drift of ['html', 'json', 'baseline', 'root', 'language', 'journal', 'request']) {
    it(`fails closed with zero POST on immediate pre-mutation ${drift} drift`, async () => {
      const { source, target } = await admitted();
      const projected = projectSourceDefinitions([original()]).items[0];
      const reportDirectory = path.join(root, 'drift-report');
      let posts = 0;
      const request = (async ({ method, url }: { method: string; url: string }) => {
        if (url.includes('/items/search')) return { count: 0, items: [] };
        if (method === 'POST') {
          posts += 1;
          throw new Error('Unexpected mutation');
        }
        return {
          ...destination,
          ...(drift === 'root' ? { rootFolderId: 'changed' } : {}),
          ...(drift === 'language' ? { defaultLanguage: 'en-US' } : {}),
        };
      }) as unknown as Parameters<typeof executeWorkspaceImport>[0]['connection']['request'];
      await failure(
        executeWorkspaceImport({
          connection: { request },
          destinationOrgId: 'org',
          destinationWorkspace: destination,
          workspaceId: 'target',
          sourceDirectory: source.sourceDirectory,
          loadedSource: source,
          definitionDirectory: target,
          nativeCopyMappings,
          reportDirectory,
          reportPersistence: {
            rewrite: async (file, report) => {
              if (drift === 'html')
                await writeFile(path.join(target, projected.htmlPath!), '<p>Drift</p>');
              if (drift === 'json')
                await writeFile(path.join(target, projected.definitionPath), '{}');
              if (drift === 'baseline')
                await writeFile(
                  path.join(source.sourceDirectory, source.manifest.entries[0].file),
                  '{}',
                );
              if (drift === 'journal')
                (
                  report.sourceDefinitions!.edits.entries[0] as unknown as Record<string, unknown>
                ).literalHtml = '<p>Tampered</p>';
              if (drift === 'request')
                (report.operations[0] as unknown as Record<string, unknown>).requestSha256 =
                  'tampered';
              await writeFile(file, JSON.stringify(report));
            },
          },
        }),
        /changed|drift|reprojection|SHA-256/u,
      );
      expect(posts).to.equal(0);
      const journal = JSON.parse(
        await readFile(path.join(reportDirectory, 'workspace-import-run.json'), 'utf8'),
      );
      expect(journal.state).to.equal('failed');
      expect(journal.createdParents).to.have.length(0);
      expect(journal.operations).to.have.length(1);
    });
  }

  it('rejects destination root/identity/default-language contradictions without mutation', async () => {
    const { source, target } = await admitted();
    for (const workspace of [
      { ...destination, rootFolderId: '' },
      { ...destination, id: 'other' },
      { ...destination, defaultLanguage: 'en-US' },
    ]) {
      await failure(
        planSourceWorkspaceImport({
          source,
          definitionDirectory: target,
          destinationWorkspace: workspace,
          workspaceId: 'target',
          nativeCopyMappings,
        }),
        /rootFolderId|exactly match/u,
      );
    }
    expect(source.items[0].apiName).to.equal('Welcome');
  });

  it('preserves typed Brand admission restrictions for a raw-only source baseline', async () => {
    const { source, target } = await admitted('sfdc_cms__brand');
    await failure(
      planSourceWorkspaceImport({
        source,
        definitionDirectory: target,
        destinationWorkspace: destination,
        workspaceId: 'target',
        brandMappings: [
          {
            source: { family: 'cms', type: 'brand', apiName: 'Welcome' },
            target: { apiName: 'Copy', title: 'Copy', urlName: 'copy' },
          },
        ],
      }),
      /Brand profile/u,
    );
    const loaded = await loadSourceDefinitions(source, target);
    expect(loaded.originals[0].contentType).to.equal('sfdc_cms__brand');
  });

  it('rejects old baseline source planning and non-root historical evidence', async () => {
    const { source, target } = await admitted();
    const options = {
      source,
      definitionDirectory: target,
      destinationWorkspace: destination,
      workspaceId: 'target',
      nativeCopyMappings,
    };
    const file = 'evidence/source-admission.v1.json';
    const evidence = JSON.parse(await readFile(path.join(source.sourceDirectory, file), 'utf8'));
    evidence.selections[0].parent.folder = { id: 'nested' };
    const changed = await replaceArtifact(source.sourceDirectory, file, JSON.stringify(evidence));
    await failure(planSourceWorkspaceImport({ ...options, source: changed }), /root|folder/u);
    const legacyDirectory = path.join(root, 'legacy-plan');
    await exportWorkspace(
      {
        request: (async ({ url }: { url: string }) =>
          url.includes('/items/search')
            ? {
                count: 1,
                items: [
                  {
                    id: 'variant',
                    managedContentSpaceId: 'space',
                    type: 'ManagedContentVariantSearchResultRepresentation',
                  },
                ],
              }
            : original().raw) as unknown as Parameters<typeof exportWorkspace>[0]['request'],
      },
      'space',
      legacyDirectory,
    );
    const legacy = await loadWorkspaceExport(legacyDirectory);
    await failure(
      planSourceWorkspaceImport({ ...options, source: legacy }),
      /re-export.*--definition-dir/u,
    );
  });

  it('revalidates pinned baseline hashes after planning', async () => {
    const { source, target } = await admitted();
    const intent = await planSourceWorkspaceImport({
      source,
      definitionDirectory: target,
      destinationWorkspace: destination,
      workspaceId: 'target',
      nativeCopyMappings,
    });
    await writeFile(path.join(source.sourceDirectory, source.manifest.entries[0].file), '{}');
    await failure(revalidateSourceWorkspaceImport(intent), /SHA-256/u);
  });

  for (const family of ['sfdc_cms__email', 'sfdc_cms__emailTemplate', 'sfdc_cms__brand']) {
    it(`positively loads detached ${family} originals and exact metadata`, async () => {
      const { source, target, acquired } = await admitted(family);
      // Caller projections are not authoritative original evidence.
      (source.items[0] as unknown as Record<string, unknown>).raw = { forged: true };
      const result = await loadSourceDefinitions(source, target);
      expect(result).to.have.all.keys('sourceManifestSha256', 'originals', 'edits');
      expect(result.sourceManifestSha256).to.equal(source.manifestSha256);
      expect(result.originals[0].raw).to.deep.equal(acquired);
      expect(result.originals[0].folderPath).to.deep.equal([]);
      expect(result.originals[0].raw.language).to.equal(acquired.language);
      expect(result.edits.entries[0].changed).to.equal(false);
      if (family === 'sfdc_cms__brand') {
        expect(result.edits.entries[0]).not.to.have.property('literalHtml');
      } else {
        const item = projectSourceDefinitions(result.originals).items[0];
        const literal = '<p>Edited &lt;literal&gt; 世界</p>';
        await writeFile(path.join(target, item.htmlPath!), literal);
        const edited = await loadSourceDefinitions(source, target);
        expect(edited.edits.entries[0].literalHtml).to.equal(literal);
        expect(edited.edits.entries[0].changed).to.equal(true);
        expect(edited.edits.entries[0].originalHtmlSha256).to.equal(
          result.edits.entries[0].currentHtmlSha256,
        );
      }
      (result.originals[0].raw as Record<string, unknown>).title = 'Mutated return';
      const reloaded = await loadSourceDefinitions(source, target);
      expect(reloaded.originals[0].raw).to.deep.equal(acquired);
    });
  }

  it('rejects malformed, duplicate-key and invalid UTF-8 evidence even with matching manifest hashes', async () => {
    const { source, target } = await admitted();
    const file = 'evidence/source-admission.v1.json';
    const bytes = await readFile(path.join(source.sourceDirectory, file), 'utf8');
    for (const candidate of [
      '{',
      bytes.replace('"contract":', '"contract":"forged","contract":'),
      '\uFEFF' + bytes,
    ]) {
      const current = await replaceArtifact(source.sourceDirectory, file, candidate);
      await failure(loadSourceDefinitions(current, target), /JSON|BOM/u);
    }
    const invalid = await replaceArtifact(source.sourceDirectory, file, Buffer.from([255]));
    await failure(loadSourceDefinitions(invalid, target), /UTF-8/u);
  });

  it('rejects rehashed evidence selection/raw mapping contradictions', async () => {
    const { source, target } = await admitted();
    const file = 'evidence/source-admission.v1.json';
    const evidence = JSON.parse(await readFile(path.join(source.sourceDirectory, file), 'utf8'));
    evidence.selections[0].rawItemPath = 'items/unlisted.json';
    const current = await replaceArtifact(source.sourceDirectory, file, JSON.stringify(evidence));
    await failure(loadSourceDefinitions(current, target), /binding|selection|raw|path/iu);
  });

  it('rejects original raw tamper, duplicate keys and pinned manifest drift', async () => {
    const { source, target } = await admitted();
    const file = source.manifest.entries[0].file;
    const bytes = await readFile(path.join(source.sourceDirectory, file), 'utf8');
    await writeFile(path.join(source.sourceDirectory, file), '{}');
    await failure(loadSourceDefinitions(source, target), /SHA-256/u);
    const current = await replaceArtifact(
      source.sourceDirectory,
      file,
      bytes.replace('"apiName":', '"apiName":"Forged","apiName":'),
    );
    await failure(loadSourceDefinitions(current, target), /duplicate JSON keys/u);
    await failure(loadSourceDefinitions(source, target), /manifest changed/u);
  });

  it('rejects wrong kind/path, referenceId and duplicate evidence artifacts', async () => {
    const { source, target } = await admitted();
    const file = 'evidence/source-admission.v1.json';
    const bytes = await readFile(path.join(source.sourceDirectory, file));
    for (const patch of [{ kind: 'cms.other' }, { referenceId: 'variant' }]) {
      const manifest = {
        ...source.manifest,
        items: source.manifest.items.map((item) =>
          item.path === file ? { ...item, ...patch } : item,
        ),
      };
      await writeFile(path.join(source.sourceDirectory, 'manifest.json'), JSON.stringify(manifest));
      await failure(
        loadWorkspaceExport(source.sourceDirectory).then((current) =>
          loadSourceDefinitions(current, target),
        ),
        /canonical evidence|reference descriptor/u,
      );
    }
    const other = 'evidence/other.json';
    await writeFile(path.join(source.sourceDirectory, other), bytes);
    for (const items of [
      [
        ...source.manifest.items.map((item) =>
          item.path === file ? { ...item, kind: 'cms.other' } : item,
        ),
        {
          path: other,
          kind: 'cms.source-admission',
          sha256: createHash('sha256').update(bytes).digest('hex'),
        },
      ],
      [
        ...source.manifest.items,
        {
          path: other,
          kind: 'cms.source-admission',
          sha256: createHash('sha256').update(bytes).digest('hex'),
        },
      ],
    ]) {
      await writeFile(
        path.join(source.sourceDirectory, 'manifest.json'),
        JSON.stringify({ ...source.manifest, items }),
      );
      await failure(
        loadWorkspaceExport(source.sourceDirectory).then((current) =>
          loadSourceDefinitions(current, target),
        ),
        /canonical evidence|reference descriptor/u,
      );
    }
  });

  it('rejects evidence hash tamper, unlisted files, JSON edits and unsafe edited HTML on the positive route', async () => {
    const { source, target } = await admitted();
    const evidenceFile = path.join(source.sourceDirectory, 'evidence/source-admission.v1.json');
    const evidenceBytes = await readFile(evidenceFile);
    await writeFile(evidenceFile, '{}');
    await failure(loadSourceDefinitions(source, target), /SHA-256/u);
    await writeFile(evidenceFile, evidenceBytes);
    const loaded = await loadSourceDefinitions(source, target);
    const item = projectSourceDefinitions(loaded.originals).items[0];
    await writeFile(path.join(target, item.definitionPath), '{}');
    await failure(loadSourceDefinitions(source, target), /JSON.*reprojection/u);
    await writeFile(path.join(target, item.definitionPath), item.definitionBytes);
    await writeFile(path.join(target, item.htmlPath!), '<p>{{user}}</p>');
    await failure(loadSourceDefinitions(source, target), /Unsupported/u);
    await writeFile(path.join(target, item.htmlPath!), item.htmlBytes!);
    await writeFile(path.join(target, 'extra.json'), '{}');
    await failure(loadSourceDefinitions(source, target), /unlisted/u);
  });

  it('reverifies baseline hashes then explicitly blocks absent historical evidence rather than trusting source JSON', async () => {
    const request = (async ({ url }: { url: string }) =>
      url.includes('/items/search')
        ? {
            count: 1,
            items: [
              {
                id: 'variant',
                managedContentSpaceId: 'space',
                type: 'ManagedContentVariantSearchResultRepresentation',
              },
            ],
          }
        : input.raw) as unknown as Parameters<typeof exportWorkspace>[0]['request'];
    const exported = path.join(root, 'exported');
    await exportWorkspace({ request }, 'space', exported, {});
    const source = await loadWorkspaceExport(exported);
    await failure(
      loadSourceDefinitions(source, definitions),
      /admission evidence unavailable.*workspace API name.*parent GET.*sibling.*re-export with --definition-dir/u,
    );
    await writeFile(path.join(exported, 'items/variant.json'), '{}');
    await failure(loadSourceDefinitions(source, definitions), /SHA-256/u);
  });
});
