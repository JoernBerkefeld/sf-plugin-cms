import { expect } from 'chai';
import sinon from 'sinon';
import { Connection as JsforceConnection } from '@jsforce/jsforce-node';
import type { Connection } from '@salesforce/core';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { executeDeployUpdate } from '../../src/services/deploy-update-executor.js';
import {
  rewriteAtomic,
  type WorkspaceImportRunReport,
} from '../../src/services/import-workspace.js';
import { extractEditableItemSourceV2 } from '../../src/services/editable-item-source-v2.js';

const workspaceId = '0Zu000000000001AAA';
const contentId = '20Y000000000001AAA';
const variantId = '9Ps000000000001AAA';
type Row = Record<string, unknown>;
async function fixture(template = false, v2 = false, reporting = true) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'cms-update-executor-'));
  const definitionFile = path.join(
    directory,
    `Welcome.cms-${template ? 'email-template' : 'email'}.json`,
  );
  const reportFile = path.join(directory, 'run.json');
  let evidence: WorkspaceImportRunReport | undefined;
  const definition = {
    contract: 'sf-cms-source-definition' as const,
    contractVersion: '1.0.0' as const,
    identity: {
      family: 'cms' as const,
      type: template ? 'Email Template' : 'Email',
      apiName: 'Welcome',
      context: { workspaceApiName: 'Different_Source' },
    },
    contentType: template ? 'sfdc_cms__emailTemplate' : 'sfdc_cms__email',
    language: 'en_US',
    title: 'Welcome',
    folderPath: [],
    contentBody: {
      'sfdc_cms:title': 'Welcome',
      messagePurpose: 'Transactional',
      textContent: 'Text\n',
      ...(template ? {} : { subjectLine: 'Hello' }),
    },
    companions: { rawHtml: `Welcome.cms-${template ? 'email-template' : 'email'}.html` },
  };
  const desired = '<p>Changed &amp; 世界</p>';
  const original = '<p>Original</p>';
  let htmlFile = path.join(directory, definition.companions.rawHtml);
  if (v2) {
    const projection = extractEditableItemSourceV2(
      definition as Parameters<typeof extractEditableItemSourceV2>[0],
      desired,
    );
    await writeFile(definitionFile, JSON.stringify(projection.definition));
    for (const part of projection.companions)
      await writeFile(path.join(directory, part.path), part.bytes);
    htmlFile = path.join(
      directory,
      projection.definition.companions.find((part) => part.role === 'rawHtml')!.path,
    );
  } else {
    await writeFile(definitionFile, JSON.stringify(definition));
    await writeFile(htmlFile, desired);
  }
  const workspace: Row = {
    id: workspaceId,
    apiName: 'Destination',
    defaultLanguage: 'en_US',
    rootFolderId: 'root',
    spaceType: { apiName: 'Marketing' },
  };
  const detail: Row = {
    managedContentId: contentId,
    managedContentVariantId: variantId,
    contentKey: 'MCDESTINATION',
    apiName: 'Welcome',
    language: 'en_US',
    title: 'Welcome',
    contentType: { fullyQualifiedName: definition.contentType },
    contentSpace: { id: workspaceId },
    folder: null,
    isPublished: false,
    status: { status: 'Draft' },
    contentBody: { ...definition.contentBody, rawHtml: '&lt;p&gt;Original&lt;/p&gt;' },
    managedContentVersionId: 'version-before',
  };
  const parent: Row = {
    managedContentId: contentId,
    contentSpace: { id: workspaceId },
    contentType: { fullyQualifiedName: definition.contentType },
    folder: null,
    managedContentVersionId: 'version-before',
  };
  let puts = 0;
  let failPut = false;
  let skipUpdate = false;
  let siblingDrift = false;
  let finalReadbackVersion: { value: unknown } | undefined;
  const response: Row = {
    managedContentId: contentId,
    managedContentVariantId: variantId,
    contentBody: {},
    language: 'en_US',
    isPublished: false,
  };
  const requests: { method: string; url: string }[] = [];
  const request = function (
    input: { method: string; url: string; body?: string },
    options?: { retry?: { maxRetries: number } },
  ) {
    requests.push(input);
    const result = (async () => {
      const url = new URL(input.url, 'https://example.invalid');
      if (input.method === 'PUT') {
        puts += 1;
        expect(options?.retry?.maxRetries).to.equal(0);
        const journal = reporting
          ? (JSON.parse(await readFile(reportFile, 'utf8')) as WorkspaceImportRunReport)
          : evidence!;
        expect(journal.operations[0].state).to.equal('pending');
        expect(journal.operations[0].target).to.deep.equal({ contentId, variantId });
        expect(journal.operations[0].operationKind).to.equal('update-variant');
        expect(input.url).to.include(variantId);
        const payload = JSON.parse(input.body!) as Row;
        expect(Object.keys(payload).toSorted()).to.deep.equal(['apiName', 'contentBody', 'title']);
        if (failPut) throw new Error('Lost response');
        if (!skipUpdate) {
          detail.contentBody = {
            ...(payload.contentBody as Row),
            rawHtml: '&lt;p&gt;Changed &amp;amp; 世界&lt;/p&gt;',
          };
          detail.managedContentVersionId = 'version-after';
          parent.managedContentVersionId = 'version-after';
        }
        return structuredClone(response);
      }
      expect(input.method).to.equal('GET');
      if (url.pathname.endsWith(`/spaces/${workspaceId}`)) return structuredClone(workspace);
      if (url.pathname.endsWith('/query')) {
        const soql = url.searchParams.get('q')!;
        const rows: Row[] = [
          {
            Id: detail.managedContentVariantId,
            ManagedContentId: detail.managedContentId,
            ContentTypeFullyQualifiedName: definition.contentType,
            Language: detail.language,
            IsPublished: detail.isPublished,
            ManagedContentVariantStatus: (detail.status as Row).status,
            IsPrimary: true,
            Name: detail.title,
            UrlName: null,
            ManagedContentKey: detail.contentKey,
            ManagedContent: { AuthoredManagedContentSpaceId: workspaceId, ApiName: detail.apiName },
          },
        ];
        if (siblingDrift && puts)
          rows.push({ ...rows[0], Id: '9Ps000000000002AAA', Language: 'de' });
        let records = soql.includes('Id >') ? [] : rows;
        if (soql.includes('COUNT(Id)'))
          records = [{ ManagedContentId: contentId, siblingCount: rows.length }];
        return { records, totalSize: records.length, done: true };
      }
      if (url.pathname.endsWith(`/variants/${String(detail.managedContentVariantId)}`)) {
        const result = structuredClone(detail);
        if (puts > 0 && finalReadbackVersion) {
          // Only the executor's final detail read follows the full preparation's workspace read.
          const previous = requests.at(-3);
          if (previous?.url.endsWith(`/spaces/${workspaceId}`)) {
            if (finalReadbackVersion.value === undefined) delete result.managedContentVersionId;
            else result.managedContentVersionId = finalReadbackVersion.value;
          }
        }
        return result;
      }
      if (url.pathname.endsWith(`/${String(detail.managedContentId)}`)) {
        const result = structuredClone(parent);
        if (
          puts > 0 &&
          finalReadbackVersion &&
          requests.at(-2)?.url.endsWith(`/spaces/${workspaceId}`)
        )
          delete result.managedContentVersionId;
        return result;
      }
      throw new Error('Unexpected ' + input.url);
    })();
    return Object.assign(result, { stream: () => new PassThrough() });
  };
  sinon.stub(JsforceConnection.prototype, 'request').callsFake(request as never);
  let apiVersion = '67.0';
  const connection = {
    accessToken: 'test-token',
    instanceUrl: 'https://example.invalid',
    version: '67.0',
    getApiVersion: () => apiVersion,
    request,
  } as unknown as Pick<Connection, 'request' | 'getApiVersion'>;
  const input = {
    definitionFile,
    reportFile,
    workspaceId,
    language: 'en_US',
    destinationOrgId: '00D000000000001AAA',
  };
  return {
    input,
    definition,
    detail,
    parent,
    workspace,
    response,
    requests,
    htmlFile,
    setFinalReadbackVersion: (value: unknown) => {
      finalReadbackVersion = { value };
    },
    setApiVersion: (value: string) => {
      apiVersion = value;
    },
    puts: () => puts,
    unchanged: () => writeFile(htmlFile, original),
    fail: () => {
      failPut = true;
    },
    mismatch: () => {
      skipUpdate = true;
    },
    siblings: () => {
      siblingDrift = true;
    },
    save: () => writeFile(definitionFile, JSON.stringify(definition)),
    journal: async () => JSON.parse(await readFile(reportFile, 'utf8')) as WorkspaceImportRunReport,
    evidence: () => evidence,
    files: () => readdir(directory),
    run: (rewrite = rewriteAtomic, beforeExecute?: () => Promise<void>) =>
      executeDeployUpdate(
        connection,
        { ...input, reportFile: reporting ? reportFile : undefined },
        {},
        { rewrite },
        beforeExecute,
        (report) => {
          evidence = report;
        },
      ),
  };
}
async function failure(promise: Promise<unknown>, pattern: RegExp) {
  try {
    await promise;
  } catch (error) {
    expect((error as Error).message).to.match(pattern);
    return;
  }
  throw new Error('Expected failure');
}

describe('internal portable identity-preserving UPDATE executor', () => {
  afterEach(() => sinon.restore());
  for (const scenario of ['success', 'boundary', 'lost-response', 'readback', 'malformed'] as const)
    it(`keeps journal-free UPDATE ${scenario} evidence without persistence or replacement files`, async () => {
      const f = await fixture(false, false, false);
      const files = await f.files();
      let rewrites = 0;
      const rewrite: typeof rewriteAtomic = async () => {
        rewrites += 1;
        throw new Error('Unexpected persistence');
      };
      if (scenario === 'lost-response') f.fail();
      if (scenario === 'readback') f.mismatch();
      if (scenario === 'malformed') f.response.managedContentId = 'unexpected-parent';
      const run = f.run(rewrite, async () => {
        expect(f.evidence()?.operations[0].target).to.deep.equal({ contentId, variantId });
        if (scenario === 'boundary') throw new Error('Boundary drift');
      });
      if (scenario === 'success') {
        const result = await run;
        expect(result.reportFile).to.equal(undefined);
        expect(result.report).to.equal(f.evidence());
      } else await failure(run, /Boundary drift|Lost response|readback|returned identity/u);
      expect(f.puts()).to.equal(scenario === 'boundary' ? 0 : 1);
      let expectedState = 'ownership-uncertain';
      if (scenario === 'success') expectedState = 'completed';
      if (scenario === 'boundary') expectedState = 'failed';
      expect(f.evidence()?.state).to.equal(expectedState);
      if (scenario === 'malformed')
        expect(f.evidence()?.operations[0].result?.contentId).to.equal('unexpected-parent');
      expect(rewrites).to.equal(0);
      expect(await f.files()).to.deep.equal(files);
    });
  for (const template of [false, true])
    for (const v2 of [false, true]) {
      it(`updates one ${template ? 'Template' : 'Email'} from v${v2 ? 2 : 1} with durable destination IDs`, async () => {
        const f = await fixture(template, v2);
        const result = await f.run();
        expect(result).to.include({ qualification: 'unqualified', outcome: 'updated' });
        expect(result.target).to.deep.equal({ contentId, variantId });
        expect(f.puts()).to.equal(1);
        const journal = await f.journal();
        expect(journal.state).to.equal('completed');
        expect(journal.createdParents).to.deep.equal([]);
        expect(journal.operations[0].result).to.deep.equal({ contentId, variantId });
        expect(f.requests.every((call) => ['GET', 'PUT'].includes(call.method))).to.equal(true);
      });
    }
  it('returns unchanged without mutation or journal and binds destination not source context', async () => {
    const f = await fixture();
    await f.unchanged();
    const result = await f.run();
    expect(result).to.deep.equal({
      qualification: 'unqualified',
      outcome: 'unchanged',
      target: { contentId, variantId },
    });
    expect(f.puts()).to.equal(0);
    await failure(f.journal(), /ENOENT/u);
  });
  it('retains unsupported desired text/JSON/title/URL edits and blocks before writing', async () => {
    const f = await fixture();
    f.definition.contentBody.textContent = 'Edited text';
    await f.save();
    await failure(f.run(), /Unsupported update fields/u);
    expect(f.puts()).to.equal(0);
  });
  it('blocks lifecycle/identity/root drift after durable intent', async () => {
    const f = await fixture();
    await failure(
      f.run(async (file, report) => {
        await rewriteAtomic(file, report);
        f.detail.status = { status: 'Published' };
      }),
      /blocked|drift/u,
    );
    expect(f.puts()).to.equal(0);
    const journal = await f.journal();
    expect(journal.state).to.equal('failed');
  });
  it('blocks companion drift after durable intent', async () => {
    const f = await fixture();
    await failure(
      f.run(async (file, report) => {
        await rewriteAtomic(file, report);
        await writeFile(f.htmlFile, '<p>Drifted</p>');
      }),
      /drift/u,
    );
    expect(f.puts()).to.equal(0);
  });
  it('blocks mutation if pending intent persistence fails', async () => {
    const f = await fixture();
    await failure(
      f.run(async () => {
        throw new Error('Disk unavailable');
      }),
      /Disk/u,
    );
    expect(f.puts()).to.equal(0);
    const journal = await f.journal();
    expect(journal.operations[0].state).to.equal('pending');
  });
  it('never retries an uncertain mutation and leaves a reconciliation journal', async () => {
    const f = await fixture();
    f.fail();
    await failure(f.run(), /Lost response/u);
    expect(f.puts()).to.equal(1);
    const journal = await f.journal();
    expect(journal.state).to.equal('ownership-uncertain');
  });
  it('persists malformed returned identities before transport validation rejects', async () => {
    const f = await fixture();
    f.response.managedContentId = 'unexpected-parent';
    delete f.response.contentBody;
    await failure(f.run(), /response shape/u);
    const journal = await f.journal();
    expect(journal.operations[0].result?.contentId).to.equal('unexpected-parent');
    expect(journal.state).to.equal('ownership-uncertain');
  });
  it('rejects independent content readback mismatch with a stable valid version after one update', async () => {
    const f = await fixture();
    f.mismatch();
    await failure(f.run(), /readback/u);
    expect(f.puts()).to.equal(1);
    const journal = await f.journal();
    expect(journal.state).to.equal('ownership-uncertain');
    expect(journal.operations[0].error).to.equal(
      'UPDATE independent readback identity/content/version mismatch; failed checks: content-unchanged',
    );
  });
  it('rejects new siblings after mutation', async () => {
    const f = await fixture();
    f.siblings();
    await failure(f.run(), /blocked/u);
    expect(f.puts()).to.equal(1);
    const journal = await f.journal();
    expect(journal.state).to.equal('ownership-uncertain');
  });
  it('blocks destination identity and workspace-root drift before mutation', async () => {
    const f = await fixture();
    await failure(
      f.run(async (file, report) => {
        await rewriteAtomic(file, report);
        f.workspace.rootFolderId = 'different-root';
        f.detail.managedContentId = '20Y000000000002AAA';
      }),
      /blocked|drift|Unexpected/u,
    );
    expect(f.puts()).to.equal(0);
  });
  it('retains pending intent when returned-result persistence fails and never replays', async () => {
    const f = await fixture();
    await failure(
      f.run(async (file, report) => {
        if (f.puts() > 0) throw new Error('Result disk failure');
        await rewriteAtomic(file, report);
      }),
      /could not be persisted/u,
    );
    expect(f.puts()).to.equal(1);
    const journal = await f.journal();
    expect(journal.operations[0].state).to.equal('pending');
    expect(journal.operations[0].target).to.deep.equal({ contentId, variantId });
  });
  for (const mismatch of [false, true])
    it(`retains UPDATE response evidence after one result write failure (mismatch: ${mismatch})`, async () => {
      const f = await fixture();
      if (mismatch) f.response.managedContentVariantId = '9Ps000000000002AAA';
      let failed = false;
      await failure(
        f.run(async (file, report) => {
          if (!failed && (report as WorkspaceImportRunReport).operations[0].result) {
            failed = true;
            throw new Error('First result write failed');
          }
          await rewriteAtomic(file, report);
        }),
        /could not be persisted/u,
      );
      expect(f.puts()).to.equal(1);
      const journal = await f.journal();
      expect(journal.state).to.equal('ownership-uncertain');
      expect(journal.operations[0].state).to.equal('pending');
      expect(journal.operations[0].target).to.deep.equal({ contentId, variantId });
      expect(journal.operations[0].result).to.deep.equal({
        contentId,
        variantId: mismatch ? '9Ps000000000002AAA' : variantId,
      });
    });
  it('keeps durable returned IDs when final completion persistence fails', async () => {
    const f = await fixture();
    await failure(
      f.run(async (file, report) => {
        if ((report as WorkspaceImportRunReport).state === 'completed')
          throw new Error('Completion disk failure');
        await rewriteAtomic(file, report);
      }),
      /Completion disk/u,
    );
    expect(f.puts()).to.equal(1);
    const journal = await f.journal();
    expect(journal.state).to.equal('ownership-uncertain');
    expect(journal.operations[0].result).to.deep.equal({ contentId, variantId });
  });
  it('rejects well-shaped returned identity mismatch while keeping returned IDs durable', async () => {
    const f = await fixture();
    f.response.managedContentVariantId = '9Ps000000000002AAA';
    await failure(f.run(), /returned identity/u);
    expect(f.puts()).to.equal(1);
    const journal = await f.journal();
    expect(journal.operations[0].result?.variantId).to.equal('9Ps000000000002AAA');
    expect(journal.state).to.equal('ownership-uncertain');
  });
  const readbackPrefix =
    'UPDATE independent readback identity/content/version mismatch; failed checks: ';
  const readbackCases: {
    label: string;
    change: (f: Awaited<ReturnType<typeof fixture>>) => void | Promise<void>;
  }[] = [
    { label: 'content-unchanged', change: (f) => f.mismatch() },
    {
      label: 'source-equal',
      change: async (f) => {
        f.definition.identity.context.workspaceApiName = 'Changed_Source';
        await f.save();
      },
    },
    {
      label: 'target-equal',
      change: (f) => {
        f.detail.managedContentVariantId = '9Ps000000000002AAA';
      },
    },
    {
      label: 'workspace-equal',
      change: (f) => {
        f.workspace.apiName = 'Changed_Destination';
      },
    },
    { label: 'api-version-equal', change: (f) => f.setApiVersion('66.0') },
    {
      label: 'content-key-equal',
      change: (f) => {
        f.detail.contentKey = 'Authorization: Bearer private-key';
      },
    },
    {
      label: 'detail-folder-equal',
      change: (f) => {
        f.detail.folder = { id: 'root' };
      },
    },
    {
      label: 'parent-folder-equal',
      change: (f) => {
        f.parent.folder = { id: 'root' };
      },
    },
  ];
  for (const { label, change } of readbackCases)
    it(`names only the failed ${label} readback check`, async () => {
      const f = await fixture();
      // Content mismatch must be armed before PUT; all other drift follows durable response.
      if (label === 'content-unchanged') await change(f);
      let changed = false;
      const expected = readbackPrefix + label;
      await failure(
        f.run(async (file, report) => {
          await rewriteAtomic(file, report);
          if (!changed && f.puts() > 0) {
            changed = true;
            if (label === 'content-unchanged') {
              f.detail.managedContentVersionId = 'version-after';
              f.parent.managedContentVersionId = 'version-after';
            } else await change(f);
          }
        }),
        /^UPDATE independent readback/u,
      );
      const journal = await f.journal();
      expect(journal.operations[0].error).to.equal(expected);
      expect(journal.state).to.equal('ownership-uncertain');
      expect(journal.operations[0].state).to.equal('pending');
      expect(f.puts()).to.equal(1);
    });
  for (const version of ['version-before', 'version-after'])
    it(`accepts coherent parent/detail readback with updated content and ${version}`, async () => {
      const f = await fixture();
      const result = await f.run(async (file, report) => {
        await rewriteAtomic(file, report);
        if (f.puts() > 0) {
          f.detail.managedContentVersionId = version;
          f.parent.managedContentVersionId = version;
        }
      });
      expect(result.outcome).to.equal('updated');
      const journal = await f.journal();
      expect(journal.state).to.equal('completed');
      expect(journal.operations[0].state).to.equal('succeeded');
      expect(f.puts()).to.equal(1);
    });
  for (const [name, version] of [
    ['missing', undefined],
    ['empty', ''],
    ['nonstring', 42],
  ] as const)
    it(`names version-present for a ${name} readback version`, async () => {
      const f = await fixture();
      f.setFinalReadbackVersion(version);
      await failure(f.run(), /^UPDATE independent readback/u);
      const journal = await f.journal();
      expect(journal.operations[0].error).to.equal(readbackPrefix + 'version-present');
      expect(journal.state).to.equal('ownership-uncertain');
      expect(journal.operations[0].state).to.equal('pending');
      expect(f.puts()).to.equal(1);
    });
  it('does not require version presence when the baseline has no version', async () => {
    const f = await fixture();
    delete f.detail.managedContentVersionId;
    delete f.parent.managedContentVersionId;
    const result = await f.run(async (file, report) => {
      await rewriteAtomic(file, report);
      if (f.puts() > 0) {
        delete f.detail.managedContentVersionId;
        delete f.parent.managedContentVersionId;
      }
    });
    expect(result.outcome).to.equal('updated');
    const journal = await f.journal();
    expect(journal.state).to.equal('completed');
    expect(f.puts()).to.equal(1);
  });
  it('never overwrites an existing journal', async () => {
    const f = await fixture();
    await writeFile(f.input.reportFile, 'prior');
    await failure(f.run(), /EEXIST/u);
    expect(f.puts()).to.equal(0);
    expect(await readFile(f.input.reportFile, 'utf8')).to.equal('prior');
  });
});
