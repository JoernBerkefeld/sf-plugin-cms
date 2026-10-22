import { expect } from 'chai';
import {
  assertContentLifecycleBatchResult,
  type ContentLifecycleBatchItem,
  type ContentLifecycleBatchResult,
  type LifecycleOperation,
} from '../../src/contracts/content-lifecycle-batch.js';
import { assertCmsEnvelope, type CmsStatus } from '../../src/contracts/shared.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Mutation fixtures deliberately violate nested contract types.
type MalformedBatch = any;

const hash = 'a'.repeat(64);

function item(
  operation: LifecycleOperation,
  index: number,
  outcome = 'ready',
): ContentLifecycleBatchItem {
  const selector = { contentType: 'sfdc_cms__email' as const, apiName: `Email${index}` };
  const target = {
    ...selector,
    workspaceId: 'space',
    language: 'en_US',
    contentId: `parent${index}`,
    variantId: `variant${index}`,
  };
  const base = { index, selector, outcome, blockers: [] };
  if (outcome === 'unattempted') return { ...base, target } as ContentLifecycleBatchItem;
  const blocked = outcome === 'blocked';
  const uncertain = outcome === 'ownership-uncertain' || outcome === 'rejected-before-mutation';
  const completed = outcome === 'completed';
  let blockerCode = 'REJECTED_BEFORE_MUTATION';
  if (outcome === 'ownership-uncertain') blockerCode = 'OWNERSHIP_UNCERTAIN';
  if (blocked) blockerCode = 'PREFLIGHT_BLOCKED';
  const blockers =
    blocked || uncertain
      ? [
          {
            code: `EMAIL_${operation.toUpperCase()}_${blockerCode}`,
            message: 'Stopped',
          },
        ]
      : [];
  const resultTarget = {
    workspaceId: target.workspaceId,
    apiName: target.apiName,
    language: target.language,
    ...(blocked ? {} : { contentId: target.contentId, variantId: target.variantId }),
  };
  const published = operation === 'publish' ? completed : !completed;
  const sibling = {
    hash,
    language: target.language,
    isPublished: published,
    status: published ? 'Published' : 'Draft',
    variantId: target.variantId,
  };
  const publishAcknowledgement = completed
    ? { noSendAcknowledged: true, postPublishHash: hash, deploymentId: 'deploy' }
    : { noSendAcknowledgementRequired: true };
  const unpublishAcknowledgement = completed
    ? { activeUseStopsAcknowledged: true, postUnpublishHash: hash, deploymentId: 'deploy' }
    : { activeUseStopsAcknowledgementRequired: true };
  const evidence = {
    ...(operation === 'publish'
      ? { selectorScope: 'variant', includeContentReferences: false }
      : { selectorScope: 'parent', includeContentReferencesOmitted: true }),
    ...(!blocked && !uncertain
      ? {
          baselineHash: hash,
          inventory: [{ contentId: target.contentId, ...sibling }],
          siblingInventory: [sibling],
          ...(operation === 'publish' ? publishAcknowledgement : unpublishAcknowledgement),
        }
      : {}),
    ...(uncertain && operation === 'unpublish'
      ? {
          mutationError: {
            classification:
              outcome === 'rejected-before-mutation'
                ? 'definite-pre-mutation-rejection'
                : 'ownership-uncertain',
          },
        }
      : {}),
  };
  const report = completed || uncertain ? { reportFile: `target-${index}.json` } : {};
  const reconciliation = uncertain
    ? {
        reconciliation: {
          workspaceId: target.workspaceId,
          contentId: target.contentId,
          variantId: target.variantId,
        },
      }
    : {};
  return {
    ...base,
    target,
    blockers,
    ...report,
    ...reconciliation,
    result: {
      mode: completed || uncertain ? 'apply' : 'dry-run',
      outcome,
      target: resultTarget,
      evidence,
      blockers,
      ...report,
      ...reconciliation,
    },
  } as ContentLifecycleBatchItem;
}

function batch(
  operation: LifecycleOperation,
  mode: 'dry-run' | 'apply',
  outcomes: string[],
  stopIndex?: number,
): ContentLifecycleBatchResult {
  const items = outcomes.map((outcome, index) => item(operation, index, outcome));
  const stop =
    stopIndex === undefined
      ? undefined
      : { index: stopIndex, outcome: items[stopIndex].outcome as 'blocked' };
  const partial = stopIndex !== undefined && outcomes.slice(0, stopIndex).includes('completed');
  return {
    selection: 'metadata',
    operation,
    mode,
    outcome: partial ? 'partial' : (stop?.outcome ?? (mode === 'dry-run' ? 'ready' : 'completed')),
    items,
    ...(stop ? { stop } : {}),
    ...(outcomes.some((outcome) =>
      ['completed', 'ownership-uncertain', 'rejected-before-mutation'].includes(outcome),
    )
      ? { reportFile: 'batch.json' }
      : {}),
  };
}

function envelope(
  result: unknown,
  operation = 'publish',
  version = '2.0.0',
  status: CmsStatus = 'success',
): unknown {
  return {
    contract: `sf-cms-content-${operation}`,
    contractVersion: version,
    status,
    metadata: {
      operation: `content.${operation}`,
      plugin: { name: 'sf-plugin-cms', version: '0.20.0' },
      apiVersion: '67.0',
    },
    diagnostics: { warnings: [], errors: [] },
    provenance: {
      producer: 'sf-plugin-cms',
      sourceOrgId: 'org',
      pluginVersion: '0.20.0',
      command: 'test',
      generatedAt: '2026-10-21T00:00:00Z',
    },
    result,
  };
}

describe('metadata lifecycle batch contracts', () => {
  for (const operation of ['publish', 'unpublish'] as const) {
    it(`${operation}: retains first remote completion with local partial stop`, () => {
      const value = batch(operation, 'apply', ['completed', 'unattempted']);
      value.items[0].localSource = { outcome: 'blocked', message: 'Authored bytes changed' };
      value.stop = { index: 0, outcome: 'remote-completed-local-blocked' };
      value.outcome = 'partial';
      expect(() => assertContentLifecycleBatchResult(value, undefined, 'partial')).not.to.throw();
      for (const status of ['blocked', 'failed', 'success'] as const)
        expect(() => assertContentLifecycleBatchResult(value, undefined, status)).to.throw();
      const invalid: MalformedBatch = structuredClone(value);
      invalid.items[0].outcome = 'ownership-uncertain';
      expect(() => assertContentLifecycleBatchResult(invalid)).to.throw();
      invalid.items[0] = structuredClone(value.items[0]);
      invalid.items[1].localSource = { outcome: 'noop', reason: 'missing-copy' };
      expect(() => assertContentLifecycleBatchResult(invalid)).to.throw();
      const dry: MalformedBatch = structuredClone(value);
      dry.mode = 'dry-run';
      expect(() => assertContentLifecycleBatchResult(dry)).to.throw();
      const missing: MalformedBatch = structuredClone(value);
      delete missing.stop;
      expect(() => assertContentLifecycleBatchResult(missing)).to.throw();
    });
  }
  for (const operation of ['publish', 'unpublish'] as const) {
    for (const mode of ['dry-run', 'apply'] as const) {
      it(`accepts complete ${operation} ${mode} evidence`, () => {
        const value = batch(operation, mode, [mode === 'dry-run' ? 'ready' : 'completed']);
        expect(() => assertContentLifecycleBatchResult(value, undefined, 'success')).not.to.throw();
        expect(() =>
          assertCmsEnvelope(envelope(value, operation), assertContentLifecycleBatchResult),
        ).not.to.throw();
      });
      for (const index of [0, 1])
        it(`accepts ${operation} ${mode} preflight stop at ${index} without mutations`, () => {
          const value = batch(
            operation,
            mode,
            index === 0 ? ['blocked', 'unattempted'] : ['ready', 'blocked', 'unattempted'],
            index,
          );
          expect(value.items.some((entry) => entry.outcome === 'completed')).to.equal(false);
          expect(() =>
            assertContentLifecycleBatchResult(value, undefined, 'blocked'),
          ).not.to.throw();
          const unresolved = structuredClone(value);
          delete unresolved.items[index].target;
          delete unresolved.items[index].result;
          expect(() => assertContentLifecycleBatchResult(unresolved)).not.to.throw();
        });
    }
    for (const stop of [
      'blocked',
      'ownership-uncertain',
      ...(operation === 'unpublish' ? ['rejected-before-mutation'] : []),
    ]) {
      for (const index of [0, 1])
        it(`accepts ${operation} execution ${stop} after ${index} completions`, () => {
          const outcomes = index === 0 ? [stop, 'unattempted'] : ['completed', stop, 'unattempted'];
          const value = batch(operation, 'apply', outcomes, index);
          if (stop === 'blocked' && value.items[index].result)
            value.items[index].result.mode = 'apply';
          let status: CmsStatus = stop === 'blocked' ? 'blocked' : 'failed';
          if (index > 0) status = 'partial';
          expect(() => assertContentLifecycleBatchResult(value, undefined, status)).not.to.throw();
          expect(() => assertContentLifecycleBatchResult(value, undefined, 'success')).to.throw();
        });
    }
  }

  for (const operation of ['publish', 'unpublish'] as const) {
    for (const mode of ['dry-run', 'apply'] as const) {
      it(`binds required native family evidence for ${operation} ${mode}`, () => {
        const value: MalformedBatch = batch(operation, mode, [
          mode === 'dry-run' ? 'ready' : 'completed',
        ]);
        const selected = value.items[0];
        selected.selector.contentType = selected.target.contentType = 'sfdc_cms__emailTemplate';
        expect(() => assertContentLifecycleBatchResult(value)).to.throw('native evidence');
        const lifecycle = {
          isPublished: selected.result.evidence.inventory[0].isPublished,
          status: { label: 'Lifecycle', status: selected.result.evidence.inventory[0].status },
        };
        selected.result.evidence.nativeEvidence = {
          contentType: 'sfdc_cms__emailTemplate',
          identity: {
            ...selected.result.target,
            contentType: 'sfdc_cms__emailTemplate',
            contentKey: 'MCNATIVE',
          },
          canonicalAuthoringHash: hash,
          parentLifecycle: lifecycle,
          variantLifecycle: lifecycle,
          references: [
            {
              referenceId: `ref:${'b'.repeat(64)}`,
              owner: 'cms',
              kind: 'cms.content',
              source: {
                workspaceId: selected.result.target.workspaceId,
                sourceId: selected.result.target.contentId,
              },
              portableKey: { scheme: 'cms-opaque-v1', value: 'MCNATIVE' },
              required: true,
              resolution: 'included',
            },
          ],
        };
        expect(() => assertContentLifecycleBatchResult(value)).not.to.throw();
        for (const family of ['sfdc_cms__image', 'sfdc_cms__email']) {
          selected.selector.contentType = selected.target.contentType = family;
          expect(() => assertContentLifecycleBatchResult(value)).to.throw('native evidence');
        }
      });
    }
  }

  const mutations: Array<[string, (value: MalformedBatch) => void]> = [
    [
      'unknown batch key',
      (v) => {
        v.extra = true;
      },
    ],
    [
      'missing batch key',
      (v) => {
        delete v.selection;
      },
    ],
    [
      'invalid selection',
      (v) => {
        v.selection = 'all';
      },
    ],
    [
      'invalid operation',
      (v) => {
        v.operation = 'delete';
      },
    ],
    [
      'invalid mode',
      (v) => {
        v.mode = 'preview';
      },
    ],
    [
      'empty items',
      (v) => {
        v.items = [];
      },
    ],
    [
      'nonarray items',
      (v) => {
        v.items = {};
      },
    ],
    [
      'unordered index',
      (v) => {
        v.items[0].index = 1;
      },
    ],
    [
      'unknown item key',
      (v) => {
        v.items[0].extra = true;
      },
    ],
    [
      'nonobject item',
      (v) => {
        v.items[0] = null;
      },
    ],
    [
      'noncanonical type',
      (v) => {
        v.items[0].selector.contentType = 'email';
      },
    ],
    [
      'blank name',
      (v) => {
        v.items[0].selector.apiName = ' ';
      },
    ],
    [
      'separator name',
      (v) => {
        v.items[0].selector.apiName = 'a:b';
      },
    ],
    [
      'unknown selector key',
      (v) => {
        v.items[0].selector.extra = true;
      },
    ],
    [
      'invalid outcome',
      (v) => {
        v.items[0].outcome = 'cancelled';
      },
    ],
    [
      'nonarray blockers',
      (v) => {
        v.items[0].blockers = null;
      },
    ],
    [
      'false blocker',
      (v) => {
        v.items[0].blockers = [{ code: 'x', message: 'x' }];
      },
    ],
    [
      'malformed blocker',
      (v) => {
        v.items[0].blockers = [{ code: '', message: 'x' }];
      },
    ],
    [
      'missing target',
      (v) => {
        delete v.items[0].target;
      },
    ],
    [
      'missing result',
      (v) => {
        delete v.items[0].result;
      },
    ],
    [
      'target selector mismatch',
      (v) => {
        v.items[0].target.apiName = 'other';
      },
    ],
    [
      'target family mismatch',
      (v) => {
        v.items[0].target.contentType = 'sfdc_cms__image';
      },
    ],
    [
      'empty identity',
      (v) => {
        v.items[0].target.contentId = '';
      },
    ],
    [
      'result selector mismatch',
      (v) => {
        v.items[0].selector.apiName = 'other';
        v.items[0].target.apiName = 'other';
      },
    ],
    [
      'result identity mismatch',
      (v) => {
        v.items[0].target.workspaceId = 'other';
      },
    ],
    [
      'result outcome mismatch',
      (v) => {
        v.items[0].outcome = 'completed';
      },
    ],
    [
      'ready report',
      (v) => {
        v.items[0].reportFile = 'wrong';
      },
    ],
    [
      'dryrun report',
      (v) => {
        v.reportFile = 'wrong';
      },
    ],
    [
      'wrong full outcome',
      (v) => {
        v.outcome = 'completed';
      },
    ],
    [
      'wrong full item',
      (v) => {
        v.items[0] = item('publish', 0, 'unattempted');
      },
    ],
    [
      'duplicate target',
      (v) => {
        v.items.push({ ...structuredClone(v.items[0]), index: 1 });
      },
    ],
  ];
  for (const [name, mutate] of mutations)
    it(`rejects ${name}`, () => {
      const value = batch('publish', 'dry-run', ['ready']);
      mutate(value);
      expect(() => assertContentLifecycleBatchResult(value)).to.throw();
    });

  for (const [name, mutate] of [
    [
      'completed in preflight prefix',
      (v: MalformedBatch) => {
        v.items[0] = item('publish', 0, 'completed');
      },
    ],
    [
      'ready in execution prefix',
      (v: MalformedBatch) => {
        v.items[1] = item('publish', 1, 'ownership-uncertain');
        v.stop.outcome = 'ownership-uncertain';
        v.outcome = 'ownership-uncertain';
      },
    ],
    [
      'attempted suffix',
      (v: MalformedBatch) => {
        v.items[2] = item('publish', 2);
      },
    ],
    [
      'stop mismatch',
      (v: MalformedBatch) => {
        v.stop.outcome = 'ownership-uncertain';
      },
    ],
    [
      'out of bounds stop',
      (v: MalformedBatch) => {
        v.stop.index = 3;
      },
    ],
    [
      'negative stop',
      (v: MalformedBatch) => {
        v.stop.index = -1;
      },
    ],
    [
      'fractional stop',
      (v: MalformedBatch) => {
        v.stop.index = 0.5;
      },
    ],
    [
      'invalid stop outcome',
      (v: MalformedBatch) => {
        v.stop.outcome = 'ready';
      },
    ],
    [
      'unknown stop key',
      (v: MalformedBatch) => {
        v.stop.extra = true;
      },
    ],
    [
      'unattempted evidence',
      (v: MalformedBatch) => {
        v.items[2].reportFile = 'wrong';
      },
    ],
    [
      'missing stop blockers',
      (v: MalformedBatch) => {
        v.items[1].blockers = [];
      },
    ],
    [
      'blocker disagreement',
      (v: MalformedBatch) => {
        v.items[1].blockers = [{ ...v.items[1].blockers[0], message: 'different' }];
      },
    ],
  ] as const)
    it(`rejects ${name}`, () => {
      const value = batch('publish', 'dry-run', ['ready', 'blocked', 'unattempted'], 1);
      mutate(value);
      expect(() => assertContentLifecycleBatchResult(value)).to.throw();
    });

  for (const [name, mutate] of [
    [
      'missing aggregate report',
      (v: MalformedBatch) => {
        delete v.reportFile;
      },
    ],
    [
      'missing target report',
      (v: MalformedBatch) => {
        delete v.items[0].reportFile;
      },
    ],
    [
      'mismatched target report',
      (v: MalformedBatch) => {
        v.items[0].reportFile = 'other';
      },
    ],
    [
      'completed reconciliation',
      (v: MalformedBatch) => {
        v.items[0].reconciliation = {};
      },
    ],
    [
      'result mode mismatch',
      (v: MalformedBatch) => {
        v.mode = 'dry-run';
      },
    ],
  ] as const)
    it(`rejects ${name}`, () => {
      const value = batch('publish', 'apply', ['completed']);
      mutate(value);
      expect(() => assertContentLifecycleBatchResult(value)).to.throw();
    });
  it('rejects missing or mismatched reconciliation', () => {
    for (const replacement of [undefined, {}]) {
      const value = batch('unpublish', 'apply', ['ownership-uncertain'], 0);
      value.items[0].reconciliation = replacement as MalformedBatch;
      expect(() => assertContentLifecycleBatchResult(value)).to.throw();
    }
  });
  it('rejects publish rejection and cross-operation evidence', () => {
    const value = batch('unpublish', 'apply', ['rejected-before-mutation'], 0);
    value.operation = 'publish';
    expect(() => assertContentLifecycleBatchResult(value)).to.throw();
    value.items[0] = item('unpublish', 0, 'ownership-uncertain');
    expect(() => assertContentLifecycleBatchResult(value)).to.throw();
  });
  it('preserves a duplicate target on the blocked item for honest preflight reporting', () => {
    const value = batch('publish', 'apply', ['ready', 'blocked', 'unattempted'], 1);
    value.items[1] = { ...item('publish', 0, 'blocked'), index: 1 };
    expect(() => assertContentLifecycleBatchResult(value)).not.to.throw();
  });
  it('accepts reconciliation independent of object key order and rejects altered identities', () => {
    const value = batch('unpublish', 'apply', ['ownership-uncertain'], 0);
    const target = value.items[0].target!;
    value.items[0].reconciliation = {
      variantId: target.variantId,
      contentId: target.contentId,
      workspaceId: target.workspaceId,
    };
    expect(() => assertContentLifecycleBatchResult(value)).not.to.throw();
    value.items[0].reconciliation.workspaceId = 'other';
    expect(() => assertContentLifecycleBatchResult(value)).to.throw();
  });
  it('accepts unresolved unattempted suffix and rejects ready evidence in successful apply', () => {
    const value = batch('publish', 'dry-run', ['blocked', 'unattempted'], 0);
    delete value.items[1].target;
    expect(() => assertContentLifecycleBatchResult(value)).not.to.throw();
    const apply = batch('publish', 'apply', ['ready']);
    expect(() => assertContentLifecycleBatchResult(apply)).to.throw();
  });
  it('rejects a falsely partial preflight and dry-run execution stops', () => {
    const value = batch('publish', 'apply', ['ready', 'blocked'], 1);
    value.outcome = 'partial';
    expect(() => assertContentLifecycleBatchResult(value)).to.throw();
    const stopped = batch('publish', 'dry-run', ['ownership-uncertain'], 0);
    expect(() => assertContentLifecycleBatchResult(stopped)).to.throw();
  });
  it('admits only metadata matching v2 operations and preserves v1 admission', () => {
    const value = batch('publish', 'dry-run', ['ready']);
    for (const candidate of [
      envelope(value, 'publish', '1.0.0'),
      envelope(value, 'unpublish'),
      envelope(value.items[0].result),
      envelope(null),
    ])
      expect(() => assertCmsEnvelope(candidate, assertContentLifecycleBatchResult)).to.throw();
    expect(() =>
      assertCmsEnvelope(envelope(value.items[0].result, 'publish', '1.0.0'), () => {}),
    ).not.to.throw();
  });
});
