import { expect } from 'chai';
import sinon from 'sinon';
import { createHash } from 'node:crypto';
import { mkdir, writeFile, readFile, readdir, symlink, link, unlink } from 'node:fs/promises';
import { createRunOwnedTemp } from '../../src/filesystem/runOwnedTemp.js';
import path from 'node:path';
import type { ImageUploadReadServices } from '../../src/contracts/image-upload.js';
import type { MutationOutcome } from '../../src/mutation-outcome.js';
import {
  applyImageUpload as applyImageUploadWithNativeGuard,
  ImageUploadApplyError,
  imageUploadNames,
  imageUploadReadServices,
  planImageUploadFiles,
  prepareImageUpload as prepareImageUploadWithNativeGuard,
} from '../../src/services/image-upload.js';
import { assertImageUploadCommandResult } from '../../src/contracts/image-upload.js';
import { rewriteAtomic } from '../../src/services/import-workspace.js';

const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);
const workspace = { id: 'space', rootFolderId: 'root', isEnhancedSpace: true };

// Orchestration keeps real reads and identity checks, without repeated Windows process startup.
function prepareImageUpload(
  ...[input, services]: Parameters<typeof prepareImageUploadWithNativeGuard>
) {
  return prepareImageUploadWithNativeGuard(input, services, {
    inspectNativeReparsePath: sinon.stub().resolves(),
  });
}

function applyImageUpload(options: Parameters<typeof applyImageUploadWithNativeGuard>[0]) {
  return applyImageUploadWithNativeGuard({
    ...options,
    fileServices: { inspectNativeReparsePath: sinon.stub().resolves() },
  });
}

async function rejected(promise: Promise<unknown>, message: string): Promise<void> {
  let failure: unknown;
  try {
    await promise;
  } catch (error) {
    failure = error;
  }
  expect(failure).to.be.instanceOf(Error);
  expect((failure as Error).message).to.contain(message);
}

function reads(): ImageUploadReadServices {
  return {
    resolveWorkspace: sinon.stub().resolves({ id: 'space', workspace }),
    getWorkspace: sinon.stub().resolves(workspace),
    searchVariants: sinon.stub().resolves({ count: 0, items: [] }),
    getVariant: sinon.stub().rejects(new Error('unexpected detail read')),
  };
}

type Scenario = Awaited<ReturnType<typeof createScenario>>;

async function createScenario() {
  const { root: directory } = await createRunOwnedTemp('cms-image-upload');
  const created: string[] = [];
  return {
    directory,
    created,
    async file(name: string, bytes = png): Promise<string> {
      const target = path.join(directory, name);
      await writeFile(target, bytes);
      created.push(target);
      return target;
    },
    async teardown(): Promise<void> {
      // Only unlink registered fixture files; no recursive cleanup or global state changes.
      for (const file of created.splice(0)) await unlink(file);
    },
  };
}

// Jobs are async workflows: drain every started sibling before reporting failure or teardown.
async function runScenarioJobs(jobs: Array<() => Promise<void>>): Promise<void> {
  for (let offset = 0; offset < jobs.length; offset += 4) {
    const settled = await Promise.allSettled(jobs.slice(offset, offset + 4).map((job) => job()));
    const failure = settled.find((result) => result.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
  }
}

async function execution(context: Scenario, nativeGuard = false) {
  const services = { ...reads(), getContent: sinon.stub() };
  const prepare = nativeGuard ? prepareImageUploadWithNativeGuard : prepareImageUpload;
  const preparation = await prepare(
    {
      workspaceId: 'space',
      files: [await context.file('first.png'), await context.file('second.png')],
    },
    services,
  );
  const reportDirectory = path.join(context.directory, 'report');
  const binding = {
    contentKey: 'key',
    managedContentId: 'parent',
    managedContentVariantId: 'variant',
  };
  const detail = {
    ...binding,
    ...preparation.intents[0].input,
    contentSpace: { id: 'space' },
    folder: { id: 'root' },
    contentType: { fullyQualifiedName: 'sfdc_cms__image' },
    status: { status: 'Draft' },
    isPublished: false,
  };
  services.getContent.resolves(detail);
  (services.getVariant as sinon.SinonStub).resolves(detail);
  const request = sinon.stub().callsFake(async ({ method }: { method: string }) => {
    expect(method).to.equal('POST');
    const durable = JSON.parse(
      await readFile(path.join(reportDirectory, 'image-upload-run.json'), 'utf8'),
    );
    expect(durable.operations).to.have.length(2);
    expect(durable.operations[0].state).to.equal('pending');
    return binding;
  });
  return { preparation, services, connection: { request }, reportDirectory, request, detail };
}

describe('no-JSON image upload preparation', () => {
  it('threads the invocation guard through every read and stops before POST on rejection', async () => {
    const context = await createScenario();
    try {
      const services = { ...reads(), getContent: sinon.stub() };
      const files = [await context.file('first.png'), await context.file('second.png')];
      const inspectNativeReparsePath = sinon.stub().resolves();
      const fileServices = { inspectNativeReparsePath };
      const preparation = await prepareImageUploadWithNativeGuard(
        { workspaceId: 'space', files },
        services,
        fileServices,
      );
      expect(inspectNativeReparsePath.callCount).to.equal(4);
      const request = sinon.stub().rejects(new Error('controlled POST rejection'));
      await rejected(
        applyImageUploadWithNativeGuard({
          preparation,
          services,
          connection: { request },
          fileServices,
        }),
        'controlled POST rejection',
      );
      expect(inspectNativeReparsePath.callCount).to.equal(12);
      expect(request.calledOnce).to.equal(true);
      inspectNativeReparsePath.resetHistory();
      inspectNativeReparsePath.rejects(new Error('path guard rejected'));
      request.resetHistory();
      await rejected(
        applyImageUploadWithNativeGuard({
          preparation,
          services,
          connection: { request },
          fileServices,
        }),
        'path guard rejected',
      );
      expect(inspectNativeReparsePath.calledOnce).to.equal(true);
      expect(request.notCalled).to.equal(true);
    } finally {
      await context.teardown();
    }
  });

  it('isolates two real workflows and drains a capped failing batch before teardown', async function () {
    this.timeout(60_000);
    const scenarios = await Promise.all([createScenario(), createScenario()]);
    const observations: Array<{ directory: string; reportDirectory: string; calls: number }> = [];
    try {
      await runScenarioJobs(
        scenarios.map((scenario, index) => async () => {
          const options = await execution(scenario, true);
          options.request.resolves({
            contentKey: 'key',
            managedContentId: 'parent',
            managedContentVariantId: 'variant',
          });
          if (index === 0) {
            const result = await applyImageUploadWithNativeGuard({
              ...options,
              preparation: {
                ...options.preparation,
                intents: options.preparation.intents.slice(0, 1),
              },
            });
            expect(result.report.state).to.equal('completed');
          } else {
            options.services.getContent.rejects(new Error('checkpoint readback failure'));
            await rejected(applyImageUploadWithNativeGuard(options), 'readback');
            const report = JSON.parse(
              await readFile(path.join(options.reportDirectory, 'image-upload-run.json'), 'utf8'),
            );
            expect(report.state).to.equal('ownership-uncertain');
            expect(report.operations[1].state).to.equal('planned');
          }
          expect(options.request.callCount).to.equal(1);
          for (const intent of options.preparation.intents) {
            expect(await readFile(intent.file.path)).to.deep.equal(png);
            expect(path.dirname(intent.file.path)).to.equal(scenario.directory);
          }
          observations.push({
            directory: scenario.directory,
            reportDirectory: options.reportDirectory,
            calls: options.request.callCount,
          });
        }),
      );
      expect(new Set(observations.map(({ directory }) => directory)).size).to.equal(2);
      expect(new Set(observations.map(({ reportDirectory }) => reportDirectory)).size).to.equal(2);
      expect(observations.map(({ calls }) => calls)).to.deep.equal([1, 1]);
      const states = await Promise.all(
        scenarios.map(
          async (scenario) =>
            JSON.parse(
              await readFile(
                path.join(scenario.directory, 'report', 'image-upload-run.json'),
                'utf8',
              ),
            ).state,
        ),
      );
      expect(states).to.deep.equal(['completed', 'ownership-uncertain']);
    } finally {
      await Promise.all(scenarios.map((scenario) => scenario.teardown()));
    }
    let active = 0;
    let maximum = 0;
    let started = 0;
    let drained = 0;
    const releases: Array<() => void> = [];
    const failure = new Error('scheduler checkpoint');
    const pending = runScenarioJobs(
      Array.from({ length: 5 }, (_, index) => async () => {
        started += 1;
        active += 1;
        maximum = Math.max(maximum, active);
        try {
          if (index === 0) {
            await Promise.resolve();
            throw failure;
          }
          await new Promise<void>((resolve) => releases.push(resolve));
        } finally {
          active -= 1;
          drained += 1;
        }
      }),
    );
    let exposed = false;
    const caught = pending.catch((error: unknown) => {
      exposed = true;
      return error;
    });
    await Promise.resolve();
    expect(started).to.equal(4);
    expect(maximum).to.equal(4);
    expect(exposed).to.equal(false);
    expect(drained).to.equal(1);
    for (const release of releases) release();
    expect(await caught).to.equal(failure);
    expect(drained).to.equal(4);
    expect(active).to.equal(0);
    expect(started).to.equal(4);
  });

  type Workflow = (this: Mocha.Context, scenario: Scenario) => Promise<void>;
  const workflows: Array<{ title: string; run: Workflow }> = [];
  function scenario(title: string, run: Workflow): void {
    if (/hardlink identities|symlink files|same filenames/u.test(title)) {
      it(title, async function () {
        const context = await createScenario();
        try {
          await run.call(this, context);
        } finally {
          await context.teardown();
        }
      });
    } else {
      workflows.push({ title, run });
    }
  }

  scenario(
    'emits verified creation before the next dispatch and retains the uncertain suffix without reports',
    async (context) => {
      const options = await execution(context);
      const third = await prepareImageUpload(
        { workspaceId: 'space', files: [await context.file('third.png')] },
        options.services,
      );
      const preparation = {
        ...options.preparation,
        intents: [...options.preparation.intents, ...third.intents],
      };
      const outcomes: MutationOutcome[] = [];
      options.request.callsFake(async () => {
        if (options.request.callCount === 1)
          return {
            contentKey: 'key',
            managedContentId: 'parent',
            managedContentVariantId: 'variant',
          };
        expect(outcomes.map(({ state }) => state)).to.deep.equal(['created']);
        throw new Error('timeout password=SECRET');
      });
      await rejected(
        applyImageUpload({
          preparation,
          services: options.services,
          connection: options.connection,
          onOutcome: (event) => {
            outcomes.push(event);
          },
        }),
        'timeout',
      );
      expect(outcomes.map(({ state }) => state)).to.deep.equal([
        'created',
        'ownership-uncertain',
        'unattempted',
      ]);
      expect(outcomes.map(({ ordinal }) => ordinal)).to.deep.equal([1, 2, 3]);
      expect(outcomes[0].target?.contentId).to.equal('parent');
      expect(JSON.stringify(outcomes)).not.to.include('SECRET');
      expect(options.request.callCount).to.equal(2);
      expect(await readdir(context.directory)).not.to.include('report');
    },
  );

  scenario(
    'isolates a throwing outcome sink after verified success without replay',
    async (context) => {
      const options = await execution(context);
      options.request.resolves({
        contentKey: 'key',
        managedContentId: 'parent',
        managedContentVariantId: 'variant',
      });
      const sink = sinon.stub().throws(new Error('sink failed'));
      const result = await applyImageUpload({
        preparation: { ...options.preparation, intents: options.preparation.intents.slice(0, 1) },
        services: options.services,
        connection: options.connection,
        onOutcome: sink,
      });
      expect(result.report.state).to.equal('completed');
      expect(sink.calledOnce).to.equal(true);
      expect(options.request.calledOnce).to.equal(true);
    },
  );

  scenario(
    'distinguishes verified remote completion from report failure without changing public evidence',
    async (context) => {
      const options = await execution(context);
      options.request.resolves({
        contentKey: 'key',
        managedContentId: 'parent',
        managedContentVariantId: 'variant',
      });
      const outcomes: MutationOutcome[] = [];
      let failure: ImageUploadApplyError | undefined;
      try {
        await applyImageUpload({
          ...options,
          onOutcome: (event) => {
            outcomes.push(event);
          },
          reportPersistence: {
            rewrite: async (destination, report) => {
              if (report.operations[0].state === 'succeeded') throw new Error('report unavailable');
              await rewriteAtomic(destination, report);
            },
          },
        });
      } catch (error) {
        failure = error as ImageUploadApplyError;
      }
      expect(failure).to.be.instanceOf(ImageUploadApplyError);
      expect(failure!.report.state).to.equal('ownership-uncertain');
      expect(failure!.report.operations[0].state).to.equal('succeeded');
      expect(outcomes.map(({ state }) => state)).to.deep.equal([
        'remote-completed-report-blocked',
        'unattempted',
      ]);
      expect(options.request.calledOnce).to.equal(true);
    },
  );

  scenario(
    'reports pre-dispatch failure and an untouched suffix without claiming remote writes',
    async (context) => {
      const options = await execution(context);
      options.services.getWorkspace = sinon
        .stub()
        .resolves({ ...workspace, rootFolderId: 'changed' });
      const outcomes: MutationOutcome[] = [];
      await rejected(
        applyImageUpload({
          preparation: options.preparation,
          services: options.services,
          connection: options.connection,
          onOutcome: (event) => {
            outcomes.push(event);
          },
        }),
        'root changed',
      );
      expect(outcomes.map(({ state }) => state)).to.deep.equal(['failed', 'unattempted']);
      expect(options.request.notCalled).to.equal(true);
    },
  );

  for (const failure of [{ statusCode: 401 }, { statusCode: 429 }, new Error('timeout')]) {
    scenario(`never retries a failed POST ${JSON.stringify(failure)}`, async (context) => {
      const options = await execution(context);
      options.request.rejects(failure);
      await rejected(applyImageUpload(options), '');
      expect(options.request.callCount).to.equal(1);
      const report = JSON.parse(
        await readFile(path.join(options.reportDirectory, 'image-upload-run.json'), 'utf8'),
      );
      expect(report.state).to.equal('ownership-uncertain');
      expect(report.operations[1].state).to.equal('planned');
    });
  }

  scenario(
    'POSTs opaque bytes with derived MIME and exact durable request hash, preserving API rejection without replay',
    async (context) => {
      const services = { ...reads(), getContent: sinon.stub() };
      const bytes = Buffer.from('opaque format evidence');
      const preparation = await prepareImageUpload(
        { workspaceId: 'space', files: [await context.file('unknown.avif', bytes)] },
        services,
      );
      const reportDirectory = path.join(context.directory, 'opaque-report');
      const request = sinon.stub().callsFake(async (sent: { body: Buffer; method: string }) => {
        expect(sent.method).to.equal('POST');
        expect(
          sent.body.includes(Buffer.from('Content-Type: application/octet-stream\r\n')),
        ).to.equal(true);
        expect(sent.body.includes(Buffer.from('filename="unknown.avif"'))).to.equal(true);
        expect(sent.body.includes(bytes)).to.equal(true);
        const report = JSON.parse(
          await readFile(path.join(reportDirectory, 'image-upload-run.json'), 'utf8'),
        );
        expect(report.state).to.equal('ownership-uncertain');
        expect(report.operations[0].file.mediaType).to.equal('application/octet-stream');
        expect(report.operations[0].requestSha256).to.equal(
          createHash('sha256').update(sent.body).digest('hex'),
        );
        throw Object.assign(new Error('API rejects unsupported Image'), { statusCode: 400 });
      });
      await rejected(
        applyImageUpload({
          preparation,
          services,
          reportDirectory,
          connection: { request },
          createOptions: { mimeType: 'image/invented', boundaryFactory: () => 'caller-boundary' },
        }),
        'API rejects unsupported Image',
      );
      expect(request.calledOnce).to.equal(true);
      expect(services.getContent.notCalled).to.equal(true);
      const report = JSON.parse(
        await readFile(path.join(reportDirectory, 'image-upload-run.json'), 'utf8'),
      );
      expect(report.state).to.equal('ownership-uncertain');
    },
  );

  it('validates safe MIME without a closed format or 10 MiB summary gate', () => {
    const result = {
      mode: 'preview',
      outcome: 'ready',
      target: { workspaceId: 'space', rootFolderId: 'root', isEnhancedSpace: true },
      byteProof: 'unavailable',
      reportFile: null,
      report: null,
      intents: [
        {
          action: 'create',
          filename: 'unknown',
          title: 'unknown',
          apiName: 'unknown',
          urlName: 'unknown',
          mediaType: 'application/octet-stream',
          size: 10 * 1024 * 1024 + 1,
          sha256: 'a'.repeat(64),
        },
      ],
    };
    expect(() => assertImageUploadCommandResult(result)).not.to.throw();
    for (const mediaType of [
      'image/png\r\nInjected: true',
      'image/é',
      'image/png; charset=UTF-8',
      '',
    ]) {
      expect(() =>
        assertImageUploadCommandResult({
          ...result,
          intents: [{ ...result.intents[0], mediaType }],
        }),
      ).to.throw();
    }
  });

  scenario(
    'persists bindings before independent readback and verifies root membership',
    async (context) => {
      const options = await execution(context);
      options.services.getContent.callsFake(async () => {
        const report = JSON.parse(
          await readFile(path.join(options.reportDirectory, 'image-upload-run.json'), 'utf8'),
        );
        expect(report.operations[0].binding.managedContentId).to.equal('parent');
        return options.detail;
      });
      // Complete one intent for a successful execution; this stub inspects its ordered durable journal.
      options.request.callsFake(async () => ({
        contentKey: 'key',
        managedContentId: 'parent',
        managedContentVariantId: 'variant',
      }));
      const result = await applyImageUpload({
        ...options,
        preparation: { ...options.preparation, intents: options.preparation.intents.slice(0, 1) },
      });
      expect(result.report.state).to.equal('completed');
      expect(result.report.operations[0].byteProof).to.equal('unavailable');
      expect((options.services.getVariant as sinon.SinonStub).calledOnce).to.equal(true);
    },
  );

  scenario(
    'rejects an empty preparation and existing report directory without a POST',
    async (context) => {
      const options = await execution(context);
      await rejected(
        applyImageUpload({ ...options, preparation: { ...options.preparation, intents: [] } }),
        'Nonempty',
      );
      await mkdir(options.reportDirectory);
      await rejected(applyImageUpload(options), 'EEXIST');
      expect(options.request.notCalled).to.equal(true);
    },
  );

  scenario('completes ordered multiple uploads', async function (context) {
    // Two files are checked before planning, before applying, and again at each write on Windows.
    this.timeout(process.platform === 'win32' ? 30_000 : 10_000);
    const options = await execution(context);
    let index = -1;
    options.request.callsFake(async () => {
      index += 1;
      return {
        contentKey: `key${index}`,
        managedContentId: `parent${index}`,
        managedContentVariantId: `variant${index}`,
      };
    });
    const detail = () => ({
      ...options.detail,
      ...options.preparation.intents[index].input,
      contentKey: `key${index}`,
      managedContentId: `parent${index}`,
      managedContentVariantId: `variant${index}`,
    });
    options.services.getContent.callsFake(async () => detail());
    (options.services.getVariant as sinon.SinonStub).callsFake(async () => detail());
    const inspectNativeReparsePath = sinon.stub().resolves();
    const result = await applyImageUploadWithNativeGuard({
      ...options,
      fileServices: { inspectNativeReparsePath },
    });
    // Apply preflight checks both files, then each remaining suffix before its POST.
    expect(inspectNativeReparsePath.callCount).to.equal(10);
    expect(options.request.callCount).to.equal(2);
    expect(result.report.operations.map(({ state }) => state)).to.deep.equal([
      'succeeded',
      'succeeded',
    ]);
  });

  scenario('stops on independent variant mismatch', async (context) => {
    const mismatched = await execution(context);
    (mismatched.services.getVariant as sinon.SinonStub).resolves({
      ...mismatched.detail,
      managedContentVariantId: 'wrong',
    });
    await rejected(applyImageUpload(mismatched), 'readback');
    expect(mismatched.request.callCount).to.equal(1);
  });

  for (const change of [
    { folder: { id: 'space' } },
    { folder: null },
    { managedContentId: 'wrong' },
    { title: 'wrong' },
    { isPublished: true },
    { contentType: { fullyQualifiedName: 'other' } },
    { status: { status: 'Published' } },
  ]) {
    scenario(`stops after mismatched readback ${JSON.stringify(change)}`, async (context) => {
      const options = await execution(context);
      options.services.getContent.resolves({ ...options.detail, ...change });
      await rejected(applyImageUpload(options), 'readback');
      expect(options.request.callCount).to.equal(1);
      expect((options.services.getVariant as sinon.SinonStub).notCalled).to.equal(true);
    });
  }

  for (const drift of ['last-file', 'buffer', 'root', 'collision']) {
    scenario(`revalidates ${drift} before any writes`, async (context) => {
      const options = await execution(context);
      if (drift === 'last-file')
        await writeFile(options.preparation.intents[1].file.path, Buffer.from('bad'));
      if (drift === 'buffer') options.preparation.intents[1].file.bytes[8] = 1;
      if (drift === 'root')
        (options.services.getWorkspace as sinon.SinonStub).resolves({
          ...workspace,
          rootFolderId: 'changed',
        });
      if (drift === 'collision')
        (options.services.searchVariants as sinon.SinonStub).resolves({ items: [], count: 1 });
      await rejected(applyImageUpload(options), '');
      expect(options.request.notCalled).to.equal(true);
    });
  }

  for (const failAt of [1, 2, 3]) {
    scenario(`stops on journal failure at rewrite ${failAt}`, async function (context) {
      // Real Windows file-route guards launch PowerShell during preparation and apply.
      this.timeout(process.platform === 'win32' ? 60_000 : 10_000);
      const options = await execution(context);
      let calls = 0;
      const rewrite = sinon.stub().callsFake(async (target: string, report: unknown) => {
        calls += 1;
        if (calls >= failAt) throw new Error('journal failure');
        await rewriteAtomic(target, report);
      });
      await rejected(
        applyImageUpload({ ...options, reportPersistence: { rewrite } }),
        'journal failure',
      );
      expect(options.request.callCount).to.equal(failAt === 1 ? 0 : 1);
      const files = await readdir(options.reportDirectory);
      const fallback = files.find((name) => name.startsWith('failure-'))!;
      expect(fallback).to.be.a('string');
      const report = JSON.parse(
        await readFile(path.join(options.reportDirectory, fallback), 'utf8'),
      );
      expect(report.state).to.equal(failAt === 1 ? 'failed' : 'ownership-uncertain');
    });
  }

  scenario(
    'completes without reports or persistence calls and retains exact in-memory evidence',
    async function (context) {
      this.timeout(60_000);
      const options = await execution(context);
      const rewrite = sinon.stub().rejects(new Error('must not persist'));
      options.request.resolves({
        contentKey: 'key',
        managedContentId: 'parent',
        managedContentVariantId: 'variant',
      });
      const before = await readdir(context.directory);
      const result = await applyImageUpload({
        ...options,
        reportDirectory: undefined,
        preparation: { ...options.preparation, intents: options.preparation.intents.slice(0, 1) },
        reportPersistence: { rewrite },
      });
      expect(result.reportFile).to.equal(null);
      expect(result.report.state).to.equal('completed');
      expect(result.report.operations[0].state).to.equal('succeeded');
      expect(result.report.operations[0].binding).to.deep.equal({
        contentKey: 'key',
        managedContentId: 'parent',
        managedContentVariantId: 'variant',
      });
      expect(result.report.operations[0].requestSha256).to.match(/^[a-f0-9]{64}$/u);
      expect(rewrite.notCalled).to.equal(true);
      expect(await readdir(context.directory)).to.deep.equal(before);
    },
  );

  for (const failure of [
    'rejection',
    'lost-response',
    'readback',
    'malformed-response',
    'preflight',
  ]) {
    scenario(
      `retains journal-free ${failure} evidence and never replays or attempts the suffix`,
      async function (context) {
        this.timeout(60_000);
        const options = await execution(context);
        options.request.resolves({
          contentKey: 'key',
          managedContentId: 'parent',
          managedContentVariantId: 'variant',
        });
        if (failure === 'rejection')
          options.request.rejects(Object.assign(new Error('API rejection'), { statusCode: 400 }));
        if (failure === 'lost-response') options.request.rejects(new Error('timeout'));
        if (failure === 'readback')
          options.services.getContent.rejects(new Error('readback unavailable'));
        if (failure === 'malformed-response')
          options.request.resolves({ managedContentId: 'known-parent' });
        if (failure === 'preflight')
          await writeFile(options.preparation.intents[1].file.path, Buffer.from('changed'));
        const before = await readdir(context.directory);
        let caught: unknown;
        try {
          await applyImageUpload({ ...options, reportDirectory: undefined });
        } catch (error) {
          caught = error;
        }
        expect(caught).to.be.instanceOf(ImageUploadApplyError);
        const error = caught as ImageUploadApplyError;
        expect(error.reportFile).to.equal(null);
        expect(error.report.state).to.equal(
          failure === 'preflight' ? 'failed' : 'ownership-uncertain',
        );
        expect(error.report.operations[1].state).to.equal('planned');
        expect(options.request.callCount).to.equal(failure === 'preflight' ? 0 : 1);
        if (failure === 'readback')
          expect(error.report.operations[0].binding?.managedContentId).to.equal('parent');
        if (failure === 'malformed-response')
          expect(error.report.operations[0].binding).to.deep.equal({
            managedContentId: 'known-parent',
          });
        expect(await readdir(context.directory)).to.deep.equal(before);
      },
    );
  }

  scenario(
    'keeps a verified prefix and uncertain active operation in memory without replay',
    async function (context) {
      this.timeout(60_000);
      const options = await execution(context);
      let index = -1;
      options.request.callsFake(async () => {
        index += 1;
        if (index === 1) throw new Error('response lost');
        return {
          contentKey: 'key',
          managedContentId: 'parent',
          managedContentVariantId: 'variant',
        };
      });
      let caught: unknown;
      try {
        await applyImageUpload({ ...options, reportDirectory: undefined });
      } catch (error) {
        caught = error;
      }
      expect(caught).to.be.instanceOf(ImageUploadApplyError);
      const error = caught as ImageUploadApplyError;
      expect(error.report.state).to.equal('ownership-uncertain');
      expect(error.report.operations.map(({ state }) => state)).to.deep.equal([
        'succeeded',
        'pending',
      ]);
      expect(error.report.operations[0].binding?.managedContentId).to.equal('parent');
      expect(options.request.callCount).to.equal(2);
      expect(await readdir(context.directory)).not.to.include('report');
    },
  );

  scenario(
    'blocks cancelled dispatch without reporting and preserves failed in-memory intent',
    async function (context) {
      this.timeout(60_000);
      const options = await execution(context);
      const controller = new AbortController();
      controller.abort();
      let caught: unknown;
      try {
        await applyImageUpload({
          ...options,
          reportDirectory: undefined,
          createOptions: { signal: controller.signal },
        });
      } catch (error) {
        caught = error;
      }
      expect(caught).to.be.instanceOf(ImageUploadApplyError);
      expect((caught as ImageUploadApplyError).report.state).to.equal('failed');
      expect(options.request.notCalled).to.equal(true);
    },
  );

  scenario(
    'supports an exclusive reportFile and rejects tampered pending intent before POST',
    async function (context) {
      this.timeout(60_000);
      const options = await execution(context);
      const reportFile = path.join(context.directory, 'explicit-report.json');
      const rewrite = sinon.stub().callsFake(async (target: string, report: unknown) => {
        await rewriteAtomic(target, { ...(report as object), runId: 'tampered' });
      });
      await rejected(
        applyImageUpload({
          ...options,
          reportDirectory: undefined,
          reportFile,
          reportPersistence: { rewrite },
        }),
        'durable intent changed',
      );
      expect(options.request.notCalled).to.equal(true);
      await rejected(
        applyImageUpload({ ...options, reportDirectory: undefined, reportFile }),
        'EEXIST',
      );
      expect(options.request.notCalled).to.equal(true);
    },
  );

  it('defines full filename naming, separator collapse, case folding and no truncation', () => {
    expect(imageUploadNames('Banner with spaces.PNG')).to.deep.equal({
      title: 'Banner with spaces.PNG',
      apiName: 'banner_with_spaces_png',
      urlName: 'banner-with-spaces-png',
    });
    expect(imageUploadNames('banner.png').apiName).to.equal('banner_png');
    expect(imageUploadNames('a'.repeat(180) + '.png').apiName).to.equal('a'.repeat(180) + '_png');
    for (const name of [
      '../a.png',
      'a".png',
      'a\n.png',
      'a.png\n',
      'é.png',
      'a..png',
      'CON.png',
      '1.png',
      'a.svg ',
      'a.',
      'a:b.svg',
      String.raw`a\b.svg`,
    ]) {
      expect(() => imageUploadNames(name)).to.throw();
    }
  });

  for (const count of [1, 17]) {
    scenario(
      `prepares all ${count} explicit files with bound bytes/hash and root-folder destinations`,
      async function (context) {
        // Windows checks each real file route using a separate PowerShell process.
        this.timeout(60_000);
        const files = [];
        for (let index = 0; index < count; index += 1)
          files.push(await context.file(`banner ${index}.png`));
        const services = reads();
        const result = await prepareImageUpload({ files, workspaceName: 'Images' }, services);
        expect(result.ready).to.equal(true);
        expect(result.intents).to.have.length(count);
        expect(result.root).to.deep.equal({
          workspaceId: 'space',
          rootFolderId: 'root',
          isEnhancedSpace: true,
        });
        for (const intent of result.intents) {
          expect(intent.input.contentSpaceOrFolderId).to.equal('root');
          expect(intent.input.title).to.equal(intent.file.filename);
          expect(intent.input).not.to.have.property('contentKey');
          expect(intent.file.bytes).to.deep.equal(png);
          expect(intent.file.sha256).to.equal(createHash('sha256').update(png).digest('hex'));
          expect(intent.file.identity.size).to.equal(png.length);
        }
        expect(
          (services.resolveWorkspace as sinon.SinonStub).firstCall.args[0].workspaceName,
        ).to.equal('Images');
      },
    );
  }

  scenario(
    'uses known signatures only as MIME hints and admits opaque or mismatched files',
    async function (context) {
      // Keep real filesystem guards while allowing the repeated Windows process checks.
      this.timeout(60_000);
      for (const [name, bytes, mediaType] of [
        ['a.png', png, 'image/png'],
        ['a.jpg', Buffer.from([255, 216, 255, 0]), 'image/jpeg'],
        ['a.jpeg', Buffer.from([255, 216, 255, 0]), 'image/jpeg'],
        ['a.gif', Buffer.from('GIF89a'), 'image/gif'],
        ['a.webp', Buffer.from('RIFF0000WEBP'), 'image/webp'],
      ] as const) {
        const [planned] = await planImageUploadFiles([await context.file(name, bytes)]);
        expect(planned.mediaType).to.equal(mediaType);
      }
      for (const [name, bytes, expected] of [
        ['wrong.jpg', png, 'image/png'],
        ['opaque.png', Buffer.from('not image'), 'application/octet-stream'],
        ['unfamiliar.avif', Buffer.from('opaque'), 'application/octet-stream'],
        ['extensionless', Buffer.from('opaque'), 'application/octet-stream'],
      ] as const) {
        const [planned] = await planImageUploadFiles([await context.file(name, bytes)]);
        expect(planned.filename).to.equal(name);
        expect(planned.mediaType).to.equal(expected);
        expect(planned.bytes).to.deep.equal(bytes);
      }
      await rejected(
        planImageUploadFiles([await context.file('empty.png', Buffer.alloc(0))]),
        'nonempty',
      );
    },
  );

  scenario('reads files above 10 MiB exactly without the legacy cap', async (context) => {
    const bytes = Buffer.alloc(10 * 1024 * 1024 + 1, 42);
    const [planned] = await planImageUploadFiles([await context.file('large.bin', bytes)]);
    expect(planned.bytes.length).to.equal(bytes.length);
    expect(planned.identity.size).to.equal(bytes.length);
    expect(planned.sha256).to.equal(createHash('sha256').update(bytes).digest('hex'));
    expect(planned.mediaType).to.equal('application/octet-stream');
  });

  scenario(
    'rejects empty batches, directories, duplicate paths and hardlink identities',
    async (context) => {
      await rejected(planImageUploadFiles([]), 'at least one');
      await rejected(planImageUploadFiles([context.directory]), 'regular nonempty');
      const source = await context.file('one.png');
      await rejected(planImageUploadFiles([source, source]), 'Duplicate image path');
      const alias = path.join(context.directory, 'alias.png');
      await link(source, alias);
      context.created.push(alias);
      await rejected(planImageUploadFiles([source, alias]), 'file identity');
    },
  );

  scenario('rejects symlink files and redirected ancestor directories', async (context) => {
    const source = await context.file('source.png');
    const alias = path.join(context.directory, 'alias.png');
    try {
      await symlink(source, alias, 'file');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error;
      // Windows without symlink privilege: junction ancestor still exercises reparse rejection.
      const junction = path.join(context.directory, 'redirect');
      await symlink(context.directory, junction, 'junction');
      context.created.push(junction);
      await rejected(
        planImageUploadFiles([path.join(junction, 'source.png')]),
        'symlink or junction',
      );
      return;
    }
    context.created.push(alias);
    await rejected(planImageUploadFiles([alias]), 'symlink or junction');
  });

  scenario(
    'rejects same filenames from different directories and normalized-name collisions',
    async (context) => {
      const sub = path.join(context.directory, 'sub');
      await mkdir(sub);
      const first = await context.file('same.png');
      const second = path.join(sub, 'same.png');
      await writeFile(second, png);
      context.created.push(second);
      await rejected(planImageUploadFiles([first, second]), 'collision');
      await rejected(
        planImageUploadFiles([await context.file('a-b.png'), await context.file('a b.png')]),
        'collision',
      );
    },
  );

  scenario(
    'bad last file rejects the whole batch before even reading destination',
    async (context) => {
      const services = reads();
      await rejected(
        prepareImageUpload(
          {
            workspaceId: 'space',
            files: [await context.file('good.png'), await context.file('bad.png', Buffer.alloc(0))],
          },
          services,
        ),
        'nonempty',
      );
      expect((services.resolveWorkspace as sinon.SinonStub).notCalled).to.equal(true);
    },
  );

  for (const detail of [
    { id: 'space', rootFolderId: 'root' },
    { ...workspace, isEnhancedSpace: false },
    { ...workspace, isEnhancedSpace: 'true' },
    { ...workspace, rootFolderId: 'space' },
    { ...workspace, rootFolderId: '' },
    { ...workspace, id: 'other' },
  ])
    scenario(
      `fails closed on invalid workspace eligibility ${JSON.stringify(detail)}`,
      async (context) => {
        const files = [await context.file('valid.png')];
        const services = reads();
        (services.resolveWorkspace as sinon.SinonStub).resolves({ id: 'space', workspace: detail });
        await rejected(prepareImageUpload({ files, workspaceId: 'space' }, services), 'evidence');
        expect((services.searchVariants as sinon.SinonStub).notCalled).to.equal(true);
      },
    );
  scenario('fails closed on root drift', async (context) => {
    const files = [await context.file('valid.png')];
    const services = reads();
    (services.getWorkspace as sinon.SinonStub).resolves({ ...workspace, rootFolderId: 'changed' });
    await rejected(prepareImageUpload({ files, workspaceId: 'space' }, services), 'root changed');
  });

  for (const response of [
    {},
    { items: [], count: 1 },
    { items: [], count: 0, total: 1 },
    { items: [], count: -1 },
    { items: [{ id: 'v', managedContentSpaceId: 'other' }], count: 1 },
    {
      items: [
        { id: 'v', managedContentSpaceId: 'space' },
        { id: 'v', managedContentSpaceId: 'space' },
      ],
      count: 2,
    },
  ])
    scenario(
      `rejects incomplete or inconsistent inventory ${JSON.stringify(response)}`,
      async (context) => {
        const files = [await context.file('valid.png')];
        const services = reads();
        (services.searchVariants as sinon.SinonStub).resolves(response);
        (services.getVariant as sinon.SinonStub).resolves({
          id: 'v',
          contentSpace: { id: 'space' },
          apiName: 'other',
          title: 'other',
          urlName: 'other',
        });
        await rejected(prepareImageUpload({ files, workspaceId: 'space' }, services), 'inventory');
      },
    );
  for (const detail of [
    { id: 'v' },
    { id: 'other', contentSpace: { id: 'space' }, apiName: 'a', title: 'a', urlName: 'a' },
  ])
    scenario(`rejects incomplete inventory detail ${JSON.stringify(detail)}`, async (context) => {
      const files = [await context.file('valid.png')];
      const services = reads();
      (services.searchVariants as sinon.SinonStub).resolves({
        count: 1,
        items: [{ id: 'v', managedContentSpaceId: 'space' }],
      });
      (services.getVariant as sinon.SinonStub).resolves(detail);
      await rejected(prepareImageUpload({ files, workspaceId: 'space' }, services), 'incomplete');
    });

  scenario(
    'paginates page-local counts to a short-page completion and rejects incomplete totals and cap',
    async (context) => {
      const files = [await context.file('new.png')];
      const services = reads();
      const search = services.searchVariants as sinon.SinonStub;
      search.callsFake(async (_id: string, page: number) => ({
        count: page === 0 ? 250 : 1,
        items: Array.from({ length: page === 0 ? 250 : 1 }, (_, index) => ({
          id: `v${page * 250 + index}`,
          managedContentSpaceId: 'space',
        })),
      }));
      (services.getVariant as sinon.SinonStub).callsFake(async (id: string) => ({
        id,
        contentSpace: { id: 'space' },
        apiName: id,
        title: id,
        urlName: id,
      }));
      await prepareImageUpload({ files, workspaceId: 'space' }, services);
      expect(search.callCount).to.equal(2);
      search.callsFake(async (_id: string, page: number) => ({
        count: page === 0 ? 250 : 1,
        total: 252,
        items: Array.from({ length: page === 0 ? 250 : 1 }, (_, index) => ({
          id: `v${page * 250 + index}`,
          managedContentSpaceId: 'space',
        })),
      }));
      await rejected(prepareImageUpload({ files, workspaceId: 'space' }, services), 'incomplete');
      search.callsFake(async (_id: string, page: number) => ({
        count: 250,
        items: Array.from({ length: 250 }, (_, index) => ({
          id: `v${page * 250 + index}`,
          managedContentSpaceId: 'space',
        })),
      }));
      await rejected(prepareImageUpload({ files, workspaceId: 'space' }, services), 'page cap');
      search.resolves({
        count: 250,
        items: Array.from({ length: 250 }, (_, index) => ({
          id: `v${index}`,
          managedContentSpaceId: 'space',
        })),
      });
      await rejected(prepareImageUpload({ files, workspaceId: 'space' }, services), 'duplicate');
    },
  );

  scenario(
    'accepts a complete noncolliding inventory and rejects capacity overflow and selector mismatch',
    async (context) => {
      const files = [await context.file('new.png')];
      const services = reads();
      (services.searchVariants as sinon.SinonStub).resolves({
        count: 1,
        total: 1,
        items: [{ id: 'v', managedContentSpaceId: 'space' }],
      });
      (services.getVariant as sinon.SinonStub).resolves({
        id: 'v',
        contentSpace: { id: 'space' },
        apiName: 'existing_png',
        title: 'existing.png',
        urlName: 'existing-png',
      });
      const result = await prepareImageUpload({ files, workspaceId: 'space' }, services);
      expect(result.intents).to.have.length(1);
      (services.searchVariants as sinon.SinonStub).resolves({
        count: 251,
        items: Array.from({ length: 251 }, (_, index) => ({
          id: `v${index}`,
          managedContentSpaceId: 'space',
        })),
      });
      await rejected(
        prepareImageUpload({ files, workspaceId: 'space' }, services),
        'cannot be proven',
      );
      await rejected(prepareImageUpload({ files, workspaceId: 'other' }, services), 'selected ID');
      await rejected(prepareImageUpload({ files }, services), 'exactly one');
      await rejected(
        prepareImageUpload({ files, workspaceId: 'space', workspaceName: 'Images' }, services),
        'exactly one',
      );
    },
  );

  for (const field of ['apiName', 'title', 'urlName'] as const) {
    scenario(
      `rejects destination ${field} collision, including case differences`,
      async (context) => {
        const services = reads();
        (services.searchVariants as sinon.SinonStub).resolves({
          count: 1,
          items: [{ id: 'v', managedContentSpaceId: 'space' }],
        });
        (services.getVariant as sinon.SinonStub).resolves({
          id: 'v',
          contentSpace: { id: 'space' },
          apiName: 'other',
          title: 'other',
          urlName: 'other',
          [field]: imageUploadNames('banner.png')[field].toUpperCase(),
        });
        await rejected(
          prepareImageUpload(
            { workspaceId: 'space', files: [await context.file('banner.png')] },
            services,
          ),
          'collision',
        );
      },
    );
  }

  scenario(
    'uses only existing GET read transports and rejects unproven inventory without writes',
    async (context) => {
      const request = sinon.stub().callsFake(({ method, url }: { method: string; url: string }) => {
        expect(method).to.equal('GET');
        return Object.assign(
          Promise.resolve(url.includes('search') ? { items: [], count: 1 } : workspace),
          { stream: () => ({ destroy: () => {} }) },
        );
      });
      await rejected(
        prepareImageUpload(
          { workspaceId: 'space', files: [await context.file('banner.png')] },
          imageUploadReadServices({ request }),
        ),
        'inventory',
      );
      expect(request.callCount).to.equal(2);
      expect(Object.keys(imageUploadReadServices({ request }))).to.have.members([
        'resolveWorkspace',
        'getWorkspace',
        'searchVariants',
        'getVariant',
      ]);
    },
  );

  for (let offset = 0; offset < workflows.length; offset += 4) {
    const group = workflows.slice(offset, offset + 4);
    // These independent readback/revalidation workflows must not share a 10-second envelope.
    const batches = group.every(
      ({ title }) =>
        title.startsWith('stops after mismatched readback ') ||
        title === 'revalidates last-file before any writes',
    )
      ? group.map((workflow) => [workflow])
      : [group];
    for (const batch of batches) {
      it(batch.map(({ title }) => title).join(' / '), async function () {
        const contexts: Scenario[] = [];
        try {
          for (let index = 0; index < batch.length; index += 1) {
            contexts.push(await createScenario());
          }
          await runScenarioJobs(
            batch.map(({ run }, index) => async () => {
              await run.call(this, contexts[index]);
            }),
          );
        } finally {
          for (const context of contexts) await context.teardown();
        }
      });
    }
  }
});
