import { Connection as JsforceConnection } from '@jsforce/jsforce-node';
import { expect } from 'chai';
import { PassThrough } from 'node:stream';
import sinon from 'sinon';
import {
  assertContentLifecycleBatchResult,
  type LifecycleOperation,
} from '../../src/contracts/content-lifecycle-batch.js';
import {
  prepareLifecycleMetadataBatch,
  runLifecycleMetadataBatch,
} from '../../src/services/lifecycle-batch.js';
import path from 'node:path';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createRunOwnedTemp, createRunOwnedDirectory } from '../../src/filesystem/runOwnedTemp.js';
import { rewriteAtomic } from '../../src/services/import-workspace.js';
import { normalizeLifecycleMetadata } from '../../src/services/lifecycle-selection.js';

function fixture(operation: LifecycleOperation) {
  let searches = 0;
  const variants = Object.fromEntries(
    ['a', 'b', 'c'].map((name) => [
      name,
      {
        managedContentVariantId: `variant-${name}`,
        managedContentId: `parent-${name}`,
        apiName: name,
        language: 'en_US',
        title: name,
        urlName: name,
        contentType: { fullyQualifiedName: 'sfdc_cms__email' },
        contentSpace: { id: 'space' },
        isPublished: operation === 'unpublish',
        status: { status: operation === 'unpublish' ? 'Published' : 'Draft' },
        contentBody: { rawHtml: name },
      },
    ]),
  );
  const state = { fail: '', drift: false, driftOrg: false };
  const dispatches: string[] = [];
  const mutation = (body: string) => {
    const payload = JSON.parse(body);
    const name = String((payload.variantIds ?? payload.contentIds)[0])
      .split('-')
      .at(-1)!;
    dispatches.push(name);
    variants[name].isPublished = operation === 'publish';
    variants[name].status = { status: operation === 'publish' ? 'Published' : 'Draft' };
    return response({ deploymentId: `deployment-${name}` });
  };
  const connection = {
    accessToken: 'token',
    instanceUrl: 'https://example.invalid',
    version: '67.0',
    request: sinon.stub().callsFake(({ method, url }: { method?: string; url: string }) => {
      expect(method ?? 'GET').to.equal('GET');
      if (url === '/connect/cms/spaces/space')
        return response({ id: 'space', apiName: 'Marketing', defaultLanguage: 'en_US' });
      if (url.startsWith('/connect/cms/items/search')) {
        searches += 1;
        if (state.drift && searches === 3) variants.c.contentBody = { rawHtml: 'drifted' };
        if (state.driftOrg && searches === 3) connection.instanceUrl = 'https://changed.invalid';
        return response({
          total: 3,
          items: Object.keys(variants).map((name) => ({
            id: `variant-${name}`,
            managedContentSpaceId: 'space',
            type: 'ManagedContentVariantSearchResultRepresentation',
          })),
        });
      }
      if (url.includes('/connect/cms/contents/variants/'))
        return response(variants[url.split('-').at(-1)!]);
      if (url.startsWith('/connect/cms/contents/parent-')) {
        const name = url.split('-').at(-1)!;
        if (state.fail === name) throw new Error('read failed');
        return response({
          managedContentId: `parent-${name}`,
          contentType: { fullyQualifiedName: 'sfdc_cms__email' },
          contentSpace: { id: 'space' },
        });
      }
      throw new Error(`Unexpected request ${url}`);
    }),
  };
  function response(value: unknown) {
    return Object.assign(Promise.resolve(structuredClone(value)), {
      stream: () => new PassThrough(),
    });
  }
  return { connection, state, variants, mutation, dispatches };
}

async function failure(action: () => Promise<unknown>) {
  try {
    await action();
  } catch (error) {
    return error;
  }
  throw new Error('Expected failure');
}

async function localCopy(root: string, language = 'en_US') {
  const directory = path.join(root, 'cms', 'Marketing', 'email');
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, 'a.cms-email.json');
  const definition = {
    contract: 'sf-cms-source-definition',
    contractVersion: '1.0.0',
    identity: {
      family: 'cms',
      type: 'Email',
      apiName: 'a',
      context: { workspaceApiName: 'Marketing' },
    },
    contentType: 'sfdc_cms__email',
    language,
    folderPath: [],
    contentBody: {
      'sfdc_cms:title': 'Authored',
      messagePurpose: 'Transactional',
      subjectLine: 'Authored',
      textContent: 'Authored',
    },
    companions: { rawHtml: 'a.cms-email.html' },
  };
  await writeFile(file, JSON.stringify(definition));
  const html = path.join(directory, 'a.cms-email.html');
  await writeFile(html, '<p>Authored local edit</p>');
  return { file, html, directory };
}

describe('Lifecycle sequential metadata executor', () => {
  afterEach(() => sinon.restore());
  for (const operation of ['publish', 'unpublish'] as const) {
    const input = () => ({
      operation,
      selectors: normalizeLifecycleMetadata(['email:a', 'email:b', 'email:c']),
      workspaceId: 'space',
      language: 'en_US',
    });
    async function setup() {
      const current = fixture(operation);
      const run = await createRunOwnedTemp('cms-batch-executor-');
      const parent = await createRunOwnedDirectory(run, 'fixture');
      const directory = path.join(parent, 'reports');
      const mutation = sinon
        .stub(JsforceConnection.prototype, 'request')
        .callsFake((request: unknown) => current.mutation((request as { body: string }).body));
      return { current, directory, mutation };
    }
    it(`${operation}: integrates missing-copy noop without creating sources`, async () => {
      const test = await setup();
      const root = path.dirname(test.directory);
      const result = await runLifecycleMetadataBatch(test.current.connection, input(), {
        mode: 'apply',
        reportDirectory: test.directory,
        projectRoot: root,
      });
      expect(result.status).to.equal('success');
      expect(
        result.result.items.every(
          (item) =>
            item.localSource?.outcome === 'noop' && item.localSource.reason === 'missing-copy',
        ),
      ).to.equal(true);
      expect(await readdir(root)).to.deep.equal(['reports']);
    });
    for (const late of ['none', 'drift', 'local-report', 'aggregate-report'] as const)
      it(`${operation}: preserves confirmed remote truth with ${late} local outcome`, async () => {
        const test = await setup();
        const root = path.dirname(test.directory);
        const copy = await localCopy(root);
        const before = await readFile(copy.html);
        let injected = false;
        const rewriteReport: typeof rewriteAtomic = async (file, value) => {
          const record = value as { state?: string; completedPrefix?: number };
          if (late === 'drift' && !file.includes('-batch-run') && record.state === 'completed')
            await writeFile(copy.html, '<p>Edited during remote execution</p>');
          if (
            !injected &&
            ((late === 'local-report' && file.endsWith('.local.json')) ||
              (late === 'aggregate-report' &&
                file.includes('-batch-run') &&
                record.completedPrefix === 1))
          ) {
            injected = true;
            throw new Error('injected local persistence failure');
          }
          return rewriteAtomic(file, value);
        };
        const result = await runLifecycleMetadataBatch(test.current.connection, input(), {
          mode: 'apply',
          reportDirectory: test.directory,
          projectRoot: root,
          rewriteReport,
        });
        expect(result.status).to.equal(late === 'none' ? 'success' : 'partial');
        expect(test.current.dispatches).to.deep.equal(late === 'none' ? ['a', 'b', 'c'] : ['a']);
        expect(result.result.items[0].outcome).to.equal('completed');
        expect(result.result.items[0].result!.outcome).to.equal('completed');
        const native = JSON.parse(await readFile(result.result.items[0].reportFile!, 'utf8'));
        expect(native.state).to.equal('completed');
        const aggregate = JSON.parse(await readFile(result.result.reportFile!, 'utf8'));
        expect(aggregate.completedPrefix).to.equal(late === 'none' ? 3 : 1);
        if (late === 'none') {
          expect(await readFile(copy.html)).to.deep.equal(before);
        } else {
          expect(result.result.stop).to.deep.equal({
            index: 0,
            outcome: 'remote-completed-local-blocked',
          });
          expect(aggregate.result.items[0].localSource.outcome).to.equal('blocked');
          expect(result.result.items.slice(1).map((item) => item.outcome)).to.deep.equal([
            'unattempted',
            'unattempted',
          ]);
        }
        assertContentLifecycleBatchResult(result.result, undefined, result.status);
      });
    for (const mode of ['dry-run', 'apply'] as const)
      for (const fault of ['ambiguity', 'unsupported'] as const)
        it(`${operation}: ${mode} rejects local ${fault} before writes`, async () => {
          const test = await setup();
          const root = path.dirname(test.directory);
          const copy = await localCopy(root, fault === 'unsupported' ? 'de_DE' : 'en_US');
          if (fault === 'unsupported') {
            for (const variant of Object.values(test.current.variants)) variant.language = 'de_DE';
          } else
            await writeFile(path.join(copy.directory, 'other.cms-email.json'), 'invalid owner');
          const rewriteReport = sinon.stub().rejects(new Error('must not write'));
          const result = await runLifecycleMetadataBatch(
            test.current.connection,
            {
              ...input(),
              language: fault === 'unsupported' ? 'de_DE' : 'en_US',
            },
            { mode, reportDirectory: test.directory, projectRoot: root, rewriteReport },
          );
          expect(result.status).to.equal('blocked');
          expect(test.mutation.called).to.equal(false);
          expect(rewriteReport.called).to.equal(false);
          expect(await readdir(root)).to.deep.equal(['cms']);
        });
    it(`${operation}: dry-run delegates preflight without allocating`, async () => {
      const current = fixture(operation);
      const rewriteReport = sinon.stub().rejects(new Error('must not write'));
      const result = await runLifecycleMetadataBatch(current.connection, input(), {
        mode: 'dry-run',
        rewriteReport,
      });
      expect(result.status).to.equal('success');
      expect(rewriteReport.called).to.equal(false);
    });
    it(`${operation}: executes same-family targets against transition-only inventory`, async () => {
      const test = await setup();
      const result = await runLifecycleMetadataBatch(test.current.connection, input(), {
        mode: 'apply',
        reportDirectory: test.directory,
      });
      expect(result.status).to.equal('success');
      expect(test.current.dispatches).to.deep.equal(['a', 'b', 'c']);
      expect(result.result.items.map((item) => item.outcome)).to.deep.equal([
        'completed',
        'completed',
        'completed',
      ]);
      assertContentLifecycleBatchResult(result.result, undefined, result.status);
      const manifest = JSON.parse(await readFile(result.result.reportFile!, 'utf8'));
      expect(manifest.completedPrefix).to.equal(3);
      expect(manifest.targets.map((item: { index: number }) => item.index)).to.deep.equal([
        0, 1, 2,
      ]);
    });
    for (const failure of [
      'allocation',
      'manifest',
      'pending',
      'completion',
      'progress',
    ] as const) {
      it(`${operation}: stops on ${failure} persistence failure without suffix dispatch`, async () => {
        const test = await setup();
        const rewriteReport: typeof rewriteAtomic = async (file, value) => {
          const record = value as { state: string; completedPrefix?: number };
          const aggregate = file.includes('-batch-run');
          if (
            (failure === 'manifest' && aggregate && record.completedPrefix === 0) ||
            (failure === 'pending' && !aggregate && record.state === 'pending') ||
            (failure === 'completion' && !aggregate && record.state === 'completed') ||
            (failure === 'progress' && aggregate && record.completedPrefix === 1)
          )
            throw new Error('persistence failed');
          return rewriteAtomic(file, value);
        };
        const result = await runLifecycleMetadataBatch(test.current.connection, input(), {
          mode: 'apply',
          reportDirectory: failure === 'allocation' ? path.dirname(test.directory) : test.directory,
          rewriteReport,
        });
        const dispatched = failure === 'completion' || failure === 'progress';
        expect(result.status).to.equal(dispatched ? 'failed' : 'blocked');
        expect(test.mutation.callCount).to.equal(dispatched ? 1 : 0);
        expect(result.result.items.map((item) => item.outcome)).to.deep.equal([
          dispatched ? 'ownership-uncertain' : 'blocked',
          'unattempted',
          'unattempted',
        ]);
        assertContentLifecycleBatchResult(result.result, undefined, result.status);
      });
    }
    for (const drift of [
      'body',
      'variant',
      'parent',
      'org',
      'api',
      'language',
      'addition',
      'lifecycle',
    ] as const) {
      it(`${operation}: blocks ${drift} substitution after first verified transition`, async () => {
        const test = await setup();
        const rewriteReport: typeof rewriteAtomic = async (file, value) => {
          await rewriteAtomic(file, value);
          if (
            file.includes('-batch-run') &&
            (value as { completedPrefix?: number }).completedPrefix === 1
          ) {
            const variant = test.current.variants.b;
            if (drift === 'body') variant.contentBody.rawHtml = 'changed';
            if (drift === 'variant') variant.managedContentVariantId = 'substitution';
            if (drift === 'parent') variant.managedContentId = 'substitution';
            if (drift === 'org') test.current.connection.instanceUrl = 'https://changed.invalid';
            if (drift === 'api') test.current.connection.version = '66.0';
            if (drift === 'language') variant.language = 'de_DE';
            if (drift === 'addition')
              test.current.variants.d = {
                ...test.current.variants.c,
                managedContentVariantId: 'variant-d',
              };
            if (drift === 'lifecycle')
              test.current.variants.c.isPublished = operation === 'publish';
          }
        };
        const result = await runLifecycleMetadataBatch(test.current.connection, input(), {
          mode: 'apply',
          reportDirectory: test.directory,
          rewriteReport,
        });
        expect(result.status).to.equal('partial');
        expect(test.mutation.callCount).to.equal(1);
        expect(result.result.items.map((item) => item.outcome)).to.deep.equal([
          'completed',
          'blocked',
          'unattempted',
        ]);
        assertContentLifecycleBatchResult(result.result, undefined, 'partial');
      });
    }
    it(`${operation}: rejects invalid modes and blocks missing apply destination`, async () => {
      const current = fixture(operation);
      expect(
        await failure(() =>
          runLifecycleMetadataBatch(current.connection, input(), { mode: 'invalid' as 'apply' }),
        ),
      ).to.be.instanceOf(TypeError);
      expect(current.connection.request.called).to.equal(false);
      const result = await runLifecycleMetadataBatch(current.connection, input(), {
        mode: 'apply',
      });
      expect(result.status).to.equal('blocked');
      expect(result.result.items.map((item) => item.outcome)).to.deep.equal([
        'blocked',
        'unattempted',
        'unattempted',
      ]);
    });
    it(`${operation}: retains pending evidence when all post-dispatch persistence fails`, async () => {
      const test = await setup();
      const rewriteReport: typeof rewriteAtomic = async (file, value) => {
        if (test.mutation.called) throw new Error('storage unavailable');
        return rewriteAtomic(file, value);
      };
      const result = await runLifecycleMetadataBatch(test.current.connection, input(), {
        mode: 'apply',
        reportDirectory: test.directory,
        rewriteReport,
      });
      expect(result.status).to.equal('failed');
      expect(result.result.stop?.outcome).to.equal('ownership-uncertain');
      expect(test.mutation.callCount).to.equal(1);
      expect(JSON.parse(await readFile(result.result.items[0].reportFile!, 'utf8')).state).to.equal(
        'pending',
      );
      expect(
        JSON.parse(await readFile(result.result.reportFile!, 'utf8')).completedPrefix,
      ).to.equal(0);
    });
    it(`${operation}: apply blocks whole-selection failure before reporting or dispatch`, async () => {
      const test = await setup();
      test.current.state.fail = 'b';
      const rewriteReport = sinon.stub().rejects(new Error('must not persist'));
      const result = await runLifecycleMetadataBatch(test.current.connection, input(), {
        mode: 'apply',
        reportDirectory: test.directory,
        rewriteReport,
      });
      expect(result.status).to.equal('blocked');
      expect(result.result.items.map((item) => item.outcome)).to.deep.equal([
        'ready',
        'blocked',
        'unattempted',
      ]);
      expect(rewriteReport.called).to.equal(false);
      expect(test.mutation.called).to.equal(false);
    });
    for (const stage of ['pending', 'completion', 'progress', 'mutation'] as const) {
      it(`${operation}: keeps a durable completed prefix on second-target ${stage} failure`, async () => {
        const test = await setup();
        const rewriteReport: typeof rewriteAtomic = async (file, value) => {
          const data = value as { state: string; completedPrefix?: number };
          if (
            (file.endsWith('target-000002.json') &&
              data.state === (stage === 'completion' ? 'completed' : stage)) ||
            (stage === 'progress' && file.includes('-batch-run') && data.completedPrefix === 2)
          )
            throw new Error('second-target persistence failure');
          await rewriteAtomic(file, value);
        };
        if (stage === 'mutation') test.mutation.onSecondCall().throws(new Error('lost response'));
        const result = await runLifecycleMetadataBatch(test.current.connection, input(), {
          mode: 'apply',
          reportDirectory: test.directory,
          rewriteReport,
        });
        expect(result.status).to.equal('partial');
        const stopped = stage === 'pending' ? 'blocked' : 'ownership-uncertain';
        expect(result.result.items.map((item) => item.outcome)).to.deep.equal([
          'completed',
          stopped,
          'unattempted',
        ]);
        expect(test.mutation.callCount).to.equal(stage === 'pending' ? 1 : 2);
        assertContentLifecycleBatchResult(result.result, undefined, 'partial');
      });
    }
    it(`${operation}: preserves operation-specific mutation failure classification`, async () => {
      const test = await setup();
      test.mutation.callsFake(() =>
        Object.assign(
          Promise.reject(
            Object.assign(new Error('invalid JSON'), {
              data: [{ errorCode: 'JSON_PARSER_ERROR', message: 'Invalid field' }],
              response: { status: 400, headers: {} },
            }),
          ),
          { stream: () => new PassThrough() },
        ),
      );
      const result = await runLifecycleMetadataBatch(test.current.connection, input(), {
        mode: 'apply',
        reportDirectory: test.directory,
      });
      expect(result.status).to.equal('failed');
      expect(result.result.stop?.outcome).to.equal(
        operation === 'unpublish' ? 'rejected-before-mutation' : 'ownership-uncertain',
      );
      expect(test.mutation.callCount).to.equal(1);
    });
  }
});

describe('Lifecycle whole-selection preparation', () => {
  afterEach(() => sinon.restore());
  for (const operation of ['publish', 'unpublish'] as const) {
    function input(values = ['email:a', 'email:b', 'email:c']) {
      return {
        operation,
        selectors: normalizeLifecycleMetadata(values),
        workspaceId: 'space',
        useDefaultLanguage: true as const,
      };
    }
    it(`${operation}: binds multiple same-family targets without any dispatch`, async () => {
      const current = fixture(operation);
      const mutation = sinon
        .stub(JsforceConnection.prototype, 'request')
        .throws(new Error('Mutation forbidden'));
      const prepared = await prepareLifecycleMetadataBatch(current.connection, input());
      expect(prepared.status).to.equal('success');
      assertContentLifecycleBatchResult(prepared.result, undefined, 'success');
      expect(prepared.result.items.map((item) => item.outcome)).to.deep.equal([
        'ready',
        'ready',
        'ready',
      ]);
      expect(prepared.preparations.map((item) => item?.binding)).to.deep.equal(
        ['a', 'b', 'c'].map((name) => ({
          contentType: 'sfdc_cms__email',
          apiName: name,
          workspaceId: 'space',
          language: 'en_US',
          contentId: `parent-${name}`,
          variantId: `variant-${name}`,
          org: 'https://example.invalid',
          apiVersion: '67.0',
          baselineHash:
            prepared.preparations[['a', 'b', 'c'].indexOf(name)]!.prepared.evidence.baselineHash,
        })),
      );
      expect(prepared.inventories).to.have.length(1);
      expect(prepared.inventories[0].expectedInventory).to.deep.equal(
        prepared.preparations[2]!.prepared.inventoryBaseline,
      );
      expect(mutation.called).to.equal(false);
    });
    it(`${operation}: rejects short/FQN duplicates and retains resolved suffix`, async () => {
      const current = fixture(operation);
      const prepared = await prepareLifecycleMetadataBatch(
        current.connection,
        input(['email:a', 'sfdc_cms__email:a', 'email:b']),
      );
      expect(prepared.status).to.equal('blocked');
      expect(prepared.result.stop).to.deep.equal({ index: 1, outcome: 'blocked' });
      expect(prepared.result.items[1].blockers[0].message).to.include('Duplicate resolved');
      expect(prepared.result.items[2]).to.include({ outcome: 'unattempted' });
      expect(prepared.result.items[2].target?.apiName).to.equal('b');
      expect(prepared.result.items[2]).not.to.have.property('result');
      expect(prepared.preparations[2]?.binding.apiName).to.equal('b');
    });
    for (const index of [0, 1]) {
      it(`${operation}: failure at ${index} gives honest prefix/stop/resolved suffix`, async () => {
        const current = fixture(operation);
        current.state.fail = ['a', 'b'][index];
        const prepared = await prepareLifecycleMetadataBatch(current.connection, input());
        expect(prepared.result.stop?.index).to.equal(index);
        expect(prepared.result.items.map((item) => item.outcome)).to.deep.equal(
          index === 0
            ? ['blocked', 'unattempted', 'unattempted']
            : ['ready', 'blocked', 'unattempted'],
        );
        expect(prepared.result.items[index]).not.to.have.property('target');
        expect(prepared.preparations[index]).to.equal(undefined);
        expect(prepared.result.items[2].target?.variantId).to.equal('variant-c');
        assertContentLifecycleBatchResult(prepared.result, undefined, 'blocked');
      });
    }
    for (const drift of ['drift', 'driftOrg'] as const) {
      it(`${operation}: blocks differing initial ${drift}`, async () => {
        const current = fixture(operation);
        current.state[drift] = true;
        const prepared = await prepareLifecycleMetadataBatch(current.connection, input());
        expect(prepared.result.stop?.index).to.equal(1);
        expect(prepared.result.items[1].target?.apiName).to.equal('b');
        expect(prepared.result.items[1].blockers[0].message).to.include(
          drift === 'drift' ? 'inventory changed' : 'org or API',
        );
        expect(prepared.inventories[0].org).to.equal('https://example.invalid');
      });
    }
    it(`${operation}: keeps unresolved suffix identities absent`, async () => {
      const current = fixture(operation);
      const prepared = await prepareLifecycleMetadataBatch(
        current.connection,
        input(['image:a', 'email:missing', 'email:c']),
      );
      expect(prepared.result.items[0].outcome).to.equal('blocked');
      expect(prepared.result.items[1]).not.to.have.property('target');
      expect(prepared.result.items[2].target?.apiName).to.equal('c');
    });
    it(`${operation}: detaches caller selection while resolving`, async () => {
      const current = fixture(operation);
      const selected = input();
      const pending = prepareLifecycleMetadataBatch(current.connection, selected);
      selected.selectors[1].apiName = 'changed';
      selected.workspaceId = 'changed';
      const prepared = await pending;
      expect(prepared.status).to.equal('success');
      expect(prepared.result.items[1].target?.apiName).to.equal('b');
    });
    it(`${operation}: rejects empty selections before reading`, async () => {
      const current = fixture(operation);
      expect(
        await failure(() => prepareLifecycleMetadataBatch(current.connection, input([]))),
      ).to.be.instanceOf(TypeError);
      expect(current.connection.request.called).to.equal(false);
    });
  }
  it('rejects an invalid operation before reads', async () => {
    const current = fixture('publish');
    expect(
      await failure(() =>
        prepareLifecycleMetadataBatch(current.connection, {
          operation: 'apply' as LifecycleOperation,
          selectors: normalizeLifecycleMetadata(['email:a']),
          workspaceId: 'space',
          language: 'en_US',
        }),
      ),
    ).to.be.instanceOf(TypeError);
    expect(current.connection.request.called).to.equal(false);
  });
});
