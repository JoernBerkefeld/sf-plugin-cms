import { expect } from 'chai';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sinon from 'sinon';
import { allocateLifecycleBatchReport } from '../../src/services/lifecycle-batch-report.js';
import type { PreparedLifecycleMetadataBatch } from '../../src/services/lifecycle-batch.js';
import type { LifecycleOperation } from '../../src/contracts/content-lifecycle-batch.js';

function prepared(operation: LifecycleOperation): PreparedLifecycleMetadataBatch {
  const hash = 'a'.repeat(64);
  const targets = ['../../unsafe', 'second'].map((apiName, index) => ({
    contentType: 'sfdc_cms__email' as const,
    apiName,
    workspaceId: 'space',
    language: 'en_US',
    contentId: `parent-${index}`,
    variantId: `variant-${index}`,
  }));
  const items = targets.map((target, index) => {
    const { contentType, ...singleTarget } = target;
    const sibling = {
      hash,
      language: target.language,
      isPublished: operation === 'unpublish',
      status: operation === 'unpublish' ? 'Published' : 'Draft',
      variantId: target.variantId,
    };
    return {
      index,
      selector: { contentType, apiName: target.apiName },
      target,
      outcome: 'ready' as const,
      blockers: [],
      result: {
        mode: 'dry-run',
        outcome: 'ready',
        target: singleTarget,
        blockers: [],
        evidence: {
          baselineHash: hash,
          inventory: [{ contentId: target.contentId, ...sibling }],
          siblingInventory: [sibling],
          ...(operation === 'publish'
            ? {
                selectorScope: 'variant',
                includeContentReferences: false,
                noSendAcknowledgementRequired: true,
              }
            : {
                selectorScope: 'parent',
                includeContentReferencesOmitted: true,
                activeUseStopsAcknowledgementRequired: true,
              }),
        },
      },
    };
  });
  // Only the preflight evidence consumed by report allocation is needed here.
  return {
    status: 'success',
    result: { selection: 'metadata', operation, mode: 'dry-run', outcome: 'ready', items },
    preparations: targets.map((target, index) => ({
      index,
      operation,
      binding: {
        ...target,
        org: 'https://example.invalid',
        apiVersion: '67.0',
        baselineHash: hash,
      },
      prepared: {
        evidence: {
          ...target,
          org: 'https://example.invalid',
          apiVersion: '67.0',
          baselineHash: hash,
        },
      },
    })),
    inventories: [],
  } as unknown as PreparedLifecycleMetadataBatch;
}

async function directory() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cms-batch-report-'));
  return { root, report: path.join(root, 'run') };
}

async function rejects(action: Promise<unknown>) {
  try {
    await action;
  } catch (error) {
    return error;
  }
  throw new Error('Expected rejection');
}

describe('Lifecycle batch report allocation', () => {
  for (const operation of ['publish', 'unpublish'] as const) {
    it(`${operation}: persists complete ordered bindings without target records`, async () => {
      const current = await directory();
      const input = prepared(operation);
      const report = await allocateLifecycleBatchReport(input, current.report);
      const manifest = JSON.parse(await readFile(report.reportFile, 'utf8'));
      expect(manifest).to.deep.equal({
        contract: `sf-cms-content-${operation}-batch-run`,
        contractVersion: '2.0.0',
        ...report,
        state: 'pending',
        completedPrefix: 0,
      });
      expect(report.runId).to.match(/^[\da-f-]{36}$/u);
      expect(report.targets.map((target) => path.basename(target.reportFile))).to.deep.equal([
        'target-000001.json',
        'target-000002.json',
      ]);
      expect(report.targets.map((target) => target.binding)).to.deep.equal(
        input.preparations.map((item) => item!.binding),
      );
      expect(await readdir(current.report)).to.deep.equal([path.basename(report.reportFile)]);
    });
  }

  it('rejects incomplete or mismatching preparation before allocating', async () => {
    const current = await directory();
    for (const kind of ['missing', 'index', 'operation', 'target', 'hash', 'org', 'api'] as const) {
      const input = prepared('publish');
      // Deliberately exercise runtime-invalid caller inputs.
      const mutable = input as unknown as {
        preparations: Array<{ index: number; operation: string; binding: Record<string, string> }>;
      };
      switch (kind) {
        case 'missing': {
          mutable.preparations.pop();
          break;
        }
        case 'index': {
          mutable.preparations[0].index = 1;
          break;
        }
        case 'operation': {
          mutable.preparations[0].operation = 'unpublish';
          break;
        }
        case 'target': {
          mutable.preparations[0].binding.variantId = 'substitute';
          break;
        }
        case 'hash': {
          mutable.preparations[0].binding.baselineHash = 'b'.repeat(64);
          break;
        }
        default: {
          mutable.preparations[0].binding[kind === 'org' ? 'org' : 'apiVersion'] = '';
        }
      }
      expect(await rejects(allocateLifecycleBatchReport(input, current.report))).to.be.instanceOf(
        TypeError,
      );
      expect(await readdir(current.root)).to.deep.equal([]);
    }
  });

  it('rejects blocked preflight and missing explicit directory before allocation', async () => {
    const current = await directory();
    const input = prepared('publish');
    const blocked = { ...input, status: 'blocked' as const };
    await rejects(allocateLifecycleBatchReport(blocked, current.report));
    await rejects(allocateLifecycleBatchReport(input, ''));
    expect(await readdir(current.root)).to.deep.equal([]);
  });

  it('leaves claimed directory untouched after manifest failure and never retries', async () => {
    const current = await directory();
    const rewrite = sinon.stub().rejects(new Error('Persistence failed'));
    const error = await rejects(
      allocateLifecycleBatchReport(prepared('publish'), current.report, rewrite),
    );
    expect((error as Error).message).to.equal('Persistence failed');
    expect(rewrite.callCount).to.equal(1);
    expect(await readdir(current.report)).to.deep.equal([]);
    await rejects(allocateLifecycleBatchReport(prepared('publish'), current.report, rewrite));
    expect(rewrite.callCount).to.equal(1);
  });

  it('retains manifest bytes when persistence reports failure after writing', async () => {
    const current = await directory();
    const rewrite = sinon.stub().callsFake(async (file: string, value: unknown) => {
      await writeFile(file, JSON.stringify(value));
      throw new Error('Durability uncertain');
    });
    await rejects(allocateLifecycleBatchReport(prepared('publish'), current.report, rewrite));
    const manifest = path.join(current.report, 'content-publish-batch-run.json');
    expect(JSON.parse(await readFile(manifest, 'utf8')).completedPrefix).to.equal(0);
    expect(await readdir(current.report)).to.deep.equal([path.basename(manifest)]);
    expect(rewrite.callCount).to.equal(1);
  });

  it('preserves existing destination and allows only one owner', async () => {
    const current = await directory();
    const outcomes = await Promise.allSettled([
      allocateLifecycleBatchReport(prepared('publish'), current.report),
      allocateLifecycleBatchReport(prepared('publish'), current.report),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).to.have.length(1);
    await writeFile(path.join(current.report, 'sentinel'), 'preserve');
    await rejects(allocateLifecycleBatchReport(prepared('publish'), current.report));
    expect(await readFile(path.join(current.report, 'sentinel'), 'utf8')).to.equal('preserve');
  });

  it('detaches caller bindings before asynchronous allocation', async () => {
    const current = await directory();
    const input = prepared('publish');
    const pending = allocateLifecycleBatchReport(input, current.report);
    (input.preparations[0]!.binding as { apiName: string }).apiName = 'changed';
    const report = await pending;
    expect(report.targets[0].binding.apiName).to.equal('../../unsafe');
    expect(JSON.parse(await readFile(report.reportFile, 'utf8')).targets).to.deep.equal(
      report.targets,
    );
  });
});
