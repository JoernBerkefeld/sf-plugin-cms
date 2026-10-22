import type { Connection } from '@salesforce/core';
import { Connection as JsforceConnection } from '@jsforce/jsforce-node';
import { expect } from 'chai';
import fs, { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import sinon from 'sinon';
import { assertNativeDeleteResult } from '../../src/contracts/native-content-delete.js';
import { createRunOwnedTemp } from '../../src/filesystem/runOwnedTemp.js';
import {
  applyNativeDelete,
  NativeDeleteApplyError,
} from '../../src/services/delete-native-executor.js';
import { resolveNativeDeleteSelection } from '../../src/services/delete-native-resolution.js';
import type { NativeInventoryRow } from '../../src/services/retrieve-native-inventory.js';
import type { RetrieveContentType } from '../../src/services/retrieve-selection.js';

const workspaceId = '0Zuaj000007dgL8CAI';
const parentId = '20Yaj00000FaO1aEAF';
const variantId = '9Psaj00000J5oxJCAR';
const translatedId = '9Psaj00000J5oxKCAR';
function row(id: string, language: string, type: RetrieveContentType): NativeInventoryRow {
  return {
    Id: id,
    ManagedContentId: parentId,
    ContentTypeFullyQualifiedName: type,
    Language: language,
    VariantType: language === 'en_US' ? 'Content' : 'Translation',
    IsPublished: true,
    ManagedContentVariantStatus: 'Published',
    IsPrimary: language === 'en_US',
    Name: 'Existing',
    UrlName: null,
    ManagedContentKey: 'EXISTING',
    ManagedContent: { AuthoredManagedContentSpaceId: workspaceId, ApiName: 'Existing' },
  };
}
function response<T>(value: T): Promise<T> & { stream: () => PassThrough } {
  return Object.assign(Promise.resolve(value), { stream: () => new PassThrough() });
}
function rejected(error: unknown): Promise<never> & { stream: () => PassThrough } {
  return Object.assign(Promise.reject(error), { stream: () => new PassThrough() });
}
function fixture(type: RetrieveContentType = 'sfdc_cms__audio', multilingual = true) {
  const rows = [
    row(variantId, 'en_US', type),
    ...(multilingual ? [row(translatedId, 'de', type)] : []),
  ];
  const calls: string[] = [];
  const deletes: string[] = [];
  let queryPage = 0;
  let onDelete: ((id: string) => unknown) | undefined;
  let onRead: (() => void) | undefined;
  let variantFailure: unknown;
  const connection = {
    version: '67.0',
    accessToken: 'token',
    instanceUrl: 'https://example.salesforce.com',
    getApiVersion: () => '67.0',
    request(request: { url: string; method: string }) {
      calls.push(request.url);
      onRead?.();
      if (request.url.includes('/query?')) {
        const query = decodeURIComponent(request.url);
        let records: unknown[] = queryPage % 2 === 0 ? rows : [];
        if (query.includes('COUNT(Id)'))
          records =
            rows.length > 0 ? [{ ManagedContentId: parentId, siblingCount: rows.length }] : [];
        else queryPage += 1;
        return response({
          done: true,
          totalSize: records.length,
          records: structuredClone(records),
        });
      }
      const id = request.url.split('/').at(-1)!;
      if (id === parentId) {
        if (rows.length === 0)
          return rejected(
            Object.assign(new Error('Parent absent'), {
              response: { status: 404 },
              data: [{ errorCode: 'NOT_FOUND', message: 'Absent' }],
            }),
          );
        return response({
          managedContentId: parentId,
          contentSpace: { id: workspaceId },
          contentType: { fullyQualifiedName: type },
        });
      }
      const found = rows.find((entry) => entry.Id === id);
      if (variantFailure) return rejected(variantFailure);
      if (!found)
        return rejected(
          Object.assign(new Error('Variant absent'), {
            response: { status: 404 },
            data: [{ errorCode: 'VARIANT_NOT_FOUND', message: 'Absent' }],
          }),
        );
      return response({
        managedContentId: found.ManagedContentId,
        managedContentVariantId: found.Id,
        language: found.Language,
        apiName: found.ManagedContent.ApiName,
        contentType: { fullyQualifiedName: found.ContentTypeFullyQualifiedName },
        contentSpace: { id: workspaceId },
        isPublished: found.IsPublished,
        status: { status: found.ManagedContentVariantStatus },
        variantType: found.VariantType,
      });
    },
  } as unknown as Pick<Connection, 'request' | 'getApiVersion'>;
  sinon.stub(JsforceConnection.prototype, 'request').callsFake(((request: {
    url: string;
    method: string;
  }) => {
    expect(request.method).to.equal('DELETE');
    const id = request.url.split('/').at(-1)!;
    deletes.push(id);
    const failure = onDelete?.(id);
    if (failure !== undefined) return rejected(failure);
    rows.splice(
      rows.findIndex((entry) => entry.Id === id),
      1,
    );
    return response();
  }) as never);
  return {
    rows,
    calls,
    deletes,
    connection,
    resolve: (languages = ['*']) =>
      resolveNativeDeleteSelection(connection, {
        workspaceId,
        selection: { metadata: [`${type}:Existing`] },
        languages,
      }),
    onDelete: (fn: (id: string) => unknown) => {
      onDelete = fn;
    },
    onRead: (fn: () => void) => {
      onRead = fn;
    },
    failVariant: (error: unknown) => {
      variantFailure = error;
    },
  };
}
async function stopped(action: () => Promise<unknown>): Promise<NativeDeleteApplyError> {
  try {
    await action();
  } catch (error) {
    expect(error).to.be.instanceOf(NativeDeleteApplyError);
    const found = error as NativeDeleteApplyError;
    assertNativeDeleteResult(found.result);
    return found;
  }
  throw new Error('Expected stopped execution');
}

async function localFixture() {
  const run = await createRunOwnedTemp('cms-delete-local-integration-');
  const directory = path.join(run.root, 'cms', 'Marketing', 'email');
  await mkdir(directory, { recursive: true });
  const definition = path.join(directory, 'Existing.cms-email.json');
  const companion = path.join(directory, 'Existing.cms-email.html');
  await writeFile(
    definition,
    JSON.stringify({
      contract: 'sf-cms-source-definition',
      contractVersion: '1.0.0',
      identity: {
        family: 'cms',
        type: 'Email',
        apiName: 'Existing',
        context: { workspaceApiName: 'Marketing' },
      },
      contentType: 'sfdc_cms__email',
      language: 'en_US',
      folderPath: [],
      contentBody: {
        'sfdc_cms:title': 'Existing',
        messagePurpose: 'Transactional',
        subjectLine: 'Edited',
        textContent: 'Edited',
      },
      companions: { rawHtml: 'Existing.cms-email.html' },
    }),
  );
  await writeFile(companion, '<p>Local authored edits</p>');
  return {
    directory,
    definition,
    companion,
    localSource: { projectRoot: run.root, workspaceApiName: 'Marketing' },
  };
}

describe('API-led native delete executor', () => {
  afterEach(() => sinon.restore());
  it('deletes only the confirmed local copy and preserves directories and unrelated files', async () => {
    const f = fixture('sfdc_cms__email', false);
    const local = await localFixture();
    await writeFile(path.join(local.directory, 'unrelated.txt'), 'keep');
    const result = await applyNativeDelete(f.connection, {
      resolution: await f.resolve(),
      localSource: local.localSource,
    });
    assertNativeDeleteResult(result);
    expect(result.report.operations[0].localSource).to.deep.equal({
      outcome: 'deleted',
      removed: [local.companion, local.definition],
      remaining: [],
    });
    expect(await readdir(local.directory)).to.deep.equal(['unrelated.txt']);
    expect(f.deletes).to.deep.equal([variantId]);
  });
  it('keeps the confirmed local cleanup prefix when a later remote deletion fails', async () => {
    const f = fixture('sfdc_cms__email');
    const local = await localFixture();
    f.onDelete((id) => (id === translatedId ? new Error('Lost response') : undefined));
    const resolution = await f.resolve();
    const error = await stopped(() =>
      applyNativeDelete(f.connection, { resolution, localSource: local.localSource }),
    );
    expect(error.result.report.state).to.equal('uncertain');
    expect(error.result.report.operations[0].localSource?.outcome).to.equal('deleted');
    expect(error.result.report.operations[1].localSource).to.equal(undefined);
    expect(await readdir(local.directory)).to.deep.equal([]);
  });
  it('does not delete local files after rejection, uncertain response, or unsuccessful independent readback', async () => {
    for (const mode of ['rejected', 'uncertain', 'readback']) {
      const f = fixture('sfdc_cms__email', false);
      const local = await localFixture();
      const resolution = await f.resolve();
      f.onDelete(() => {
        if (mode === 'readback') {
          f.failVariant(new Error('Readback unavailable'));
          return;
        }
        return mode === 'uncertain'
          ? new Error('Lost response')
          : Object.assign(new Error('Denied'), {
              statusCode: 403,
              data: [{ errorCode: 'INSUFFICIENT_ACCESS', message: 'Denied' }],
            });
      });
      const error = await stopped(() =>
        applyNativeDelete(f.connection, { resolution, localSource: local.localSource }),
      );
      expect(error.result.report.operations[0].localSource).to.equal(undefined);
      expect(await readFile(local.companion, 'utf8')).to.equal('<p>Local authored edits</p>');
      expect(f.deletes).to.deep.equal([variantId]);
      sinon.restore();
    }
  });
  it('captures before dispatch, surfaces local drift and stops without remote replay', async () => {
    const f = fixture('sfdc_cms__email');
    const local = await localFixture();
    const resolution = await f.resolve();
    f.onDelete(() => {
      writeFileSync(local.companion, 'Changed during remote dispatch');
    });
    const error = await stopped(() =>
      applyNativeDelete(f.connection, {
        resolution,
        localSource: local.localSource,
        reportDirectory: path.join(local.localSource.projectRoot, 'report'),
      }),
    );
    expect(JSON.parse(await readFile(error.result.reportFile!, 'utf8'))).to.deep.equal(
      error.result.report,
    );
    expect(error.message).to.include('local cleanup failed');
    expect(error.result.report.state).to.equal('partial');
    expect(error.result.persistenceError).to.equal(undefined);
    expect(error.result.report.operations[0]).to.include({
      state: 'completed',
      exactVariantAbsent: true,
    });
    expect(error.result.report.operations[0].localSource?.outcome).to.equal('blocked');
    expect(await readFile(local.companion, 'utf8')).to.equal('Changed during remote dispatch');
    expect(f.deletes).to.deep.equal([variantId]);
  });
  it('retains exact partial local unlink evidence without replaying a completed remote target', async () => {
    const f = fixture('sfdc_cms__email', false);
    const local = await localFixture();
    const resolution = await f.resolve();
    const unlink = fs.unlink.bind(fs);
    sinon.stub(fs, 'unlink').callsFake(async (file) => {
      if (file === local.definition) throw new Error('Locked definition');
      await unlink(file);
    });
    const error = await stopped(() =>
      applyNativeDelete(f.connection, { resolution, localSource: local.localSource }),
    );
    expect(error.result.report.state).to.equal('completed');
    expect(error.result.report.operations[0].localSource).to.deep.equal({
      outcome: 'partial',
      removed: [local.companion],
      remaining: [local.definition],
      message: 'Locked definition',
    });
    expect(error.result.persistenceError).to.equal(undefined);
    expect(f.deletes).to.deep.equal([variantId]);
  });
  it('treats a pre-remote missing copy as noop even if a copy appears during remote dispatch', async () => {
    const f = fixture('sfdc_cms__email', false);
    const local = await localFixture();
    const bytes = await readFile(local.definition);
    await fs.unlink(local.definition);
    f.onDelete(() => {
      writeFileSync(local.definition, bytes);
    });
    const result = await applyNativeDelete(f.connection, {
      resolution: await f.resolve(),
      localSource: local.localSource,
    });
    assertNativeDeleteResult(result);
    expect(result.report.operations[0].localSource).to.deep.equal({
      outcome: 'noop',
      removed: [],
      remaining: [],
    });
    expect(await readFile(local.definition)).to.deep.equal(bytes);
  });
  it('executes all five public families including published existing content without ownership or disk reports', async () => {
    for (const type of ['email', 'emailTemplate', 'image', 'document', 'audio'] as const) {
      const f = fixture(`sfdc_cms__${type}`, false);
      const resolution = await f.resolve();
      const result = await applyNativeDelete(f.connection, {
        resolution,
        reportPersistence: {
          rewrite: async () => {
            throw new Error('No persistence allowed');
          },
        },
      });
      assertNativeDeleteResult(result);
      expect(result.report.state).to.equal('completed');
      expect(result.reportFile).to.equal(null);
      expect(result.report.operations[0]).to.include({
        state: 'completed',
        exactVariantAbsent: true,
      });
      expect(f.deletes).to.deep.equal([variantId]);
      sinon.restore();
    }
  });
  it('deletes a positively bound Translation subset, leaving the other locale untouched', async () => {
    const f = fixture();
    const result = await applyNativeDelete(f.connection, { resolution: await f.resolve(['de']) });
    expect(result.report.state).to.equal('completed');
    expect(f.deletes).to.deep.equal([translatedId]);
    expect(f.rows.map((entry) => entry.Id)).to.deep.equal([variantId]);
  });
  it('revalidates expected own deletions before the next selected locale, with exact one-shot dispatch order', async () => {
    const f = fixture();
    const result = await applyNativeDelete(f.connection, { resolution: await f.resolve() });
    assertNativeDeleteResult(result);
    expect(result.report.state).to.equal('completed');
    expect(f.deletes).to.deep.equal([variantId, translatedId]);
    expect(f.rows).to.deep.equal([]);
  });
  it('blocks fresh scope, identity, locale, state, version and classification drift before DELETE', async () => {
    for (const change of [
      (entry: NativeInventoryRow) => {
        entry.VariantType = 'Variation';
      },
      (entry: NativeInventoryRow) => {
        entry.VariantType = undefined;
      },
      (entry: NativeInventoryRow) => {
        entry.Language = 'fr';
      },
      (entry: NativeInventoryRow) => {
        entry.ManagedContent.ApiName = 'Renamed';
      },
      (entry: NativeInventoryRow) => {
        entry.IsPublished = false;
      },
      (entry: NativeInventoryRow) => {
        entry.ContentTypeFullyQualifiedName = 'sfdc_cms__image';
      },
      (entry: NativeInventoryRow) => {
        entry.ManagedContent.AuthoredManagedContentSpaceId = '0Zuaj000007dgL9CAI';
      },
    ]) {
      const f = fixture();
      const resolution = await f.resolve();
      change(f.rows[0]);
      const error = await stopped(() => applyNativeDelete(f.connection, { resolution }));
      expect(error.result.report.state).to.equal('blocked');
      expect(error.result.report.operations.map((operation) => operation.state)).to.deep.equal([
        'blocked',
        'unattempted',
      ]);
      expect(f.deletes).to.deep.equal([]);
      sinon.restore();
    }
  });
  it('rejects unresolved, empty, duplicate and forged targets without org access', async () => {
    const f = fixture();
    const resolution = await f.resolve();
    const calls = f.calls.length;
    for (const mutate of [
      (value: typeof resolution) => {
        value.items = [];
      },
      (value: typeof resolution) => {
        value.items[0].selected = [];
      },
      (value: typeof resolution) => {
        value.items[0].requiresLanguageSelection = true;
      },
      (value: typeof resolution) => {
        value.items[0].selected.push(value.items[0].selected[0]);
      },
      (value: typeof resolution) => {
        value.items[0].selected[0] = { ...value.items[0].selected[0], language: 'forged' };
      },
    ]) {
      const value = structuredClone(resolution);
      mutate(value);
      let caught: unknown;
      try {
        await applyNativeDelete(f.connection, { resolution: value });
      } catch (error) {
        caught = error;
      }
      expect(caught).to.be.instanceOf(TypeError);
    }
    expect(f.calls.length).to.equal(calls);
    expect(f.deletes).to.deep.equal([]);
  });
  it('retains completed prefix, API rejection and unattempted suffix without retry', async () => {
    const f = fixture();
    f.onDelete((id) =>
      id === translatedId
        ? Object.assign(new Error('Denied'), {
            statusCode: 403,
            data: [{ errorCode: 'INSUFFICIENT_ACCESS', message: 'Denied' }],
          })
        : undefined,
    );
    const resolution = await f.resolve();
    const error = await stopped(() => applyNativeDelete(f.connection, { resolution }));
    expect(error.result.report.state).to.equal('partial');
    expect(error.result.report.operations.map((operation) => operation.state)).to.deep.equal([
      'completed',
      'rejected',
    ]);
    expect(f.deletes).to.deep.equal([variantId, translatedId]);
  });
  it('reports definite first-target rejection and leaves every later target unattempted', async () => {
    const f = fixture();
    const resolution = await f.resolve();
    f.onDelete(() =>
      Object.assign(new Error('Rejected'), {
        statusCode: 400,
        data: [{ errorCode: 'INVALID_INPUT', message: 'Rejected' }],
      }),
    );
    const error = await stopped(() => applyNativeDelete(f.connection, { resolution }));
    expect(error.result.report.state).to.equal('rejected');
    expect(error.result.report.operations.map((operation) => operation.state)).to.deep.equal([
      'rejected',
      'unattempted',
    ]);
    expect(f.deletes).to.deep.equal([variantId]);
  });
  it('blocks durable intent tampering during fresh preflight without a DELETE', async () => {
    const f = fixture();
    const resolution = await f.resolve();
    const run = await createRunOwnedTemp('cms-delete-executor-');
    const directory = path.join(run.root, 'report');
    const error = await stopped(() =>
      applyNativeDelete(f.connection, {
        resolution,
        reportDirectory: directory,
        reportPersistence: {
          rewrite: async (file) => {
            await writeFile(file, '{}');
          },
        },
      }),
    );
    expect(error.result.report.state).to.equal('blocked');
    expect(f.deletes).to.deep.equal([]);
  });
  it('reconciles a lost response read-only but remains uncertain and never replays', async () => {
    const f = fixture();
    const resolution = await f.resolve();
    f.onDelete((id) => {
      f.rows.splice(
        f.rows.findIndex((entry) => entry.Id === id),
        1,
      );
      return new Error('Lost response');
    });
    const error = await stopped(() => applyNativeDelete(f.connection, { resolution }));
    expect(error.result.report.state).to.equal('uncertain');
    expect(error.result.report.operations.map((operation) => operation.state)).to.deep.equal([
      'uncertain',
      'unattempted',
    ]);
    expect(f.deletes).to.deep.equal([variantId]);
  });
  it('does not accept success without independent exact absence or generic 404 evidence', async () => {
    const f = fixture();
    const resolution = await f.resolve();
    f.onDelete(() => {
      f.failVariant(
        Object.assign(new Error('Denied'), {
          response: { status: 404 },
          data: [{ errorCode: 'NOT_FOUND', message: 'Not necessarily variant absence' }],
        }),
      );
    });
    const error = await stopped(() => applyNativeDelete(f.connection, { resolution }));
    expect(error.result.report.state).to.equal('uncertain');
    expect(f.deletes).to.deep.equal([variantId]);
  });
  it('stops uncertain if DELETE unexpectedly removes an unselected sibling', async () => {
    const f = fixture();
    const resolution = await f.resolve(['en_US']);
    f.onDelete(() => {
      f.rows.splice(1, 1);
    });
    const error = await stopped(() => applyNativeDelete(f.connection, { resolution }));
    expect(error.result.report.state).to.equal('uncertain');
    expect(f.deletes).to.deep.equal([variantId]);
  });
  it('cancels before dispatch with no mutations', async () => {
    const f = fixture();
    const resolution = await f.resolve();
    const controller = new AbortController();
    controller.abort();
    const error = await stopped(() =>
      applyNativeDelete(f.connection, {
        resolution,
        requestOptions: { signal: controller.signal },
      }),
    );
    expect(error.result.report.state).to.equal('blocked');
    expect(f.deletes).to.deep.equal([]);
  });
  it('detaches caller targets before async rechecks', async () => {
    const f = fixture();
    const resolution = await f.resolve();
    f.onRead(() => {
      resolution.items[0].selected[0].variantId = 'forged';
    });
    const result = await applyNativeDelete(f.connection, { resolution });
    expect(result.report.operations[0].target.variantId).to.equal(variantId);
    expect(f.deletes).to.deep.equal([variantId, translatedId]);
  });
  it('persists opt-in pending intent, then final evidence; existing directories block dispatch', async () => {
    const f = fixture();
    const resolution = await f.resolve();
    const run = await createRunOwnedTemp('cms-delete-executor-');
    const directory = path.join(run.root, 'report');
    f.onDelete(() => {
      expect(f.deletes.length).to.be.at.least(1);
    });
    const result = await applyNativeDelete(f.connection, {
      resolution,
      reportDirectory: directory,
    });
    expect(JSON.parse(await readFile(result.reportFile!, 'utf8'))).to.deep.equal(result.report);
    expect(await readdir(directory)).to.deep.equal(['content-delete-run.json']);
    const count = f.deletes.length;
    const error = await stopped(() =>
      applyNativeDelete(f.connection, { resolution, reportDirectory: directory }),
    );
    expect(error.result.report.state).to.equal('blocked');
    expect(f.deletes.length).to.equal(count);
  });
  it('retains known completion if optional final persistence fails, without replay or a hidden fallback journal', async () => {
    const f = fixture(undefined, false);
    const resolution = await f.resolve();
    const run = await createRunOwnedTemp('cms-delete-executor-');
    let rewrites = 0;
    const error = await stopped(() =>
      applyNativeDelete(f.connection, {
        resolution,
        reportDirectory: path.join(run.root, 'report'),
        reportPersistence: {
          rewrite: async (file, report) => {
            rewrites += 1;
            if (rewrites > 1) throw new Error('Disk unavailable');
            await writeFile(file, JSON.stringify(report));
          },
        },
      }),
    );
    expect(error.result.report.state).to.equal('completed');
    expect(error.result.persistenceError).to.include('Disk unavailable');
    expect(f.deletes).to.deep.equal([variantId]);
  });
  it('accepts only an empty preallocated reporting directory and preserves collisions', async () => {
    const f = fixture(undefined, false);
    const resolution = await f.resolve();
    const run = await createRunOwnedTemp('cms-delete-allocated-');
    const directory = path.join(run.root, 'report');
    await mkdir(directory);
    const result = await applyNativeDelete(f.connection, {
      resolution,
      reportDirectory: directory,
      reportDirectoryAllocated: true,
    });
    expect(result.report.state).to.equal('completed');
    const before = await readFile(result.reportFile!, 'utf8');
    const error = await stopped(() =>
      applyNativeDelete(f.connection, {
        resolution,
        reportDirectory: directory,
        reportDirectoryAllocated: true,
      }),
    );
    expect(error.result.report.state).to.equal('blocked');
    expect(await readFile(result.reportFile!, 'utf8')).to.equal(before);
    expect(f.deletes).to.deep.equal([variantId]);
  });
  it('blocks enabled pending persistence failure before any dispatch', async () => {
    const f = fixture();
    const resolution = await f.resolve();
    const run = await createRunOwnedTemp('cms-delete-executor-');
    const error = await stopped(() =>
      applyNativeDelete(f.connection, {
        resolution,
        reportDirectory: path.join(run.root, 'report'),
        reportPersistence: {
          rewrite: async () => {
            throw new Error('Disk unavailable');
          },
        },
      }),
    );
    expect(error.result.report.state).to.equal('blocked');
    expect(f.deletes).to.deep.equal([]);
  });
});
