import { expect } from 'chai';
import type { WorkspaceExportManifest } from '../../src/contracts/workspace-export.js';
import { projectSourceDefinitions } from '../../src/services/source-definition.js';
import {
  replaySourceAdmissionEvidence,
  serializeSourceAdmissionEvidence,
  type SourceAdmissionEvidence,
} from '../../src/services/source-admission-evidence.js';
import { brandDetail } from '../fixtures/brand.js';

type MutableEvidence = {
  workspace: Record<string, unknown>;
  inventory: {
    contentType: string;
    pages: { page: number; response: Record<string, unknown> }[];
    variants: Record<string, unknown>[];
  };
  selections: { rawItemPath: string; variantId: string; parent: Record<string, unknown> }[];
};
const row = (id: string) => ({
  type: 'ManagedContentVariantSearchResultRepresentation',
  id,
  managedContentSpaceId: 'space',
});

function setup(
  family: SourceAdmissionEvidence['inventory']['contentType'] = 'sfdc_cms__email',
  count = 1,
) {
  const variants = Array.from({ length: count }, (_, index): Record<string, unknown> => {
    const id = `variant-${String(index).padStart(3, '0')}`;
    if (family === 'sfdc_cms__brand') return brandDetail(id, `Brand_${index}`, 'space');
    // Same sanitized retained native Email/Template response shape as the source-definition fixtures.
    return {
      managedContentVariantId: id,
      managedContentId: `parent-${index}`,
      contentKey: `key-${index}`,
      contentSpace: { id: 'space' },
      apiName: `Welcome_${index}`,
      contentType: { fullyQualifiedName: family },
      language: 'en_US',
      folder: null,
      title: 'Welcome',
      contentBody: {
        'sfdc_cms:title': 'Welcome',
        messagePurpose: 'Transactional',
        ...(family === 'sfdc_cms__email' ? { subjectLine: 'Hello' } : {}),
        rawHtml: '&lt;p&gt;Hello &amp;amp; café&lt;/p&gt;',
        'lightning:expressions': [],
        'sfdc_cms:variants': [],
      },
    };
  });
  const pages = [];
  for (let page = 0; page * 250 < count; page++) {
    const items = variants
      .slice(page * 250, (page + 1) * 250)
      .map((raw) => row(raw.managedContentVariantId as string));
    pages.push({
      page,
      response: { items, count: family === 'sfdc_cms__emailTemplate' ? items.length : count },
    });
  }
  if (family === 'sfdc_cms__emailTemplate' && count % 250 === 0)
    pages.push({ page: pages.length, response: { items: [], count: 0 } });
  const evidence: SourceAdmissionEvidence = {
    contract: 'sf-cms-source-admission',
    contractVersion: '1.0.0',
    workspace: { id: 'space', name: 'Demo', rootFolderId: 'folder-source-id' },
    inventory: { contentType: family, pages, variants },
    selections: variants.map((raw) => ({
      rawItemPath: `items/${String(raw.managedContentVariantId)}.json`,
      variantId: raw.managedContentVariantId as string,
      parent:
        family === 'sfdc_cms__brand'
          ? { ...raw, contentVersion: 1, variantVersion: '1.1' }
          : {
              managedContentId: raw.managedContentId,
              contentType: raw.contentType,
              contentSpace: raw.contentSpace,
              folder: null,
            },
    })),
  };
  const manifest: WorkspaceExportManifest = {
    schemaVersion: 1,
    mode: 'experimental-best-effort',
    workspaceId: 'space',
    search: {
      contentSpaceOrFolderIds: ['space'],
      languages: ['All'],
      pageSize: 250,
      queryTerm: '*',
    },
    expectedCount: count,
    foundCount: count,
    exportedCount: count,
    pagesRequested: pages.length,
    entries: evidence.selections.map(({ rawItemPath, variantId }) => ({
      file: rawItemPath,
      variantId,
    })),
    rejectedVariantIds: [],
    failedVariantIds: [],
    warnings: [],
    contract: 'sf-cms-workspace-export',
    contractVersion: '1.0.0',
    provenance: {
      producer: 'sf-plugin-cms',
      sourceOrgId: 'org',
      sourceWorkspaceId: 'space',
      pluginVersion: '0.9.0',
      generatedAt: '2026-10-05T01:11:00Z',
    },
    completeness: 'complete',
    dependencies: [],
    externalReferences: [],
    items: evidence.selections.map(({ rawItemPath }) => ({
      path: rawItemPath,
      sha256: 'a'.repeat(64),
      kind: 'cms.content',
    })),
  };
  const rawItems = new Map(
    evidence.selections.map((selection, index) => [
      selection.rawItemPath,
      structuredClone(variants[index]),
    ]),
  );
  return { evidence, manifest, rawItems };
}

function changed(
  evidence: SourceAdmissionEvidence,
  change: (value: MutableEvidence) => void,
): SourceAdmissionEvidence {
  const copy = structuredClone(evidence);
  change(copy as unknown as MutableEvidence);
  return copy;
}

describe('historical source admission evidence', () => {
  for (const family of ['sfdc_cms__email', 'sfdc_cms__emailTemplate', 'sfdc_cms__brand'] as const) {
    it(`replays deterministic detached original ${family} with manifest v1 and v2`, () => {
      const { evidence, manifest, rawItems } = setup(family);
      const replay = replaySourceAdmissionEvidence(evidence, manifest, rawItems);
      const projection = projectSourceDefinitions(replay);
      expect(projection.items[0].definition.identity.context.workspaceApiName).to.equal('Demo');
      expect(projection.items[0].definition.folderPath).to.deep.equal([]);
      manifest.schemaVersion = 2;
      manifest.contractVersion = '2.0.0';
      manifest.media = [];
      expect(
        replaySourceAdmissionEvidence(
          JSON.parse(serializeSourceAdmissionEvidence(evidence)),
          manifest,
          rawItems,
        ),
      ).to.deep.equal(replay);
      (evidence.workspace as Record<string, unknown>).name = 'Mutated';
      rawItems.values().next().value!.apiName = 'Mutated';
      (evidence.selections[0].parent as Record<string, unknown>).folder = 'Mutated';
      expect(projectSourceDefinitions(replay)).to.deep.equal(projection);
    });
  }

  it('serializes sorted keys, retained unknown fields, ordered arrays, LF/no BOM without mutation', () => {
    const { evidence } = setup();
    (evidence.workspace as Record<string, unknown>).nativeField = { z: [2, 1], a: true };
    const before = structuredClone(evidence);
    const bytes = serializeSourceAdmissionEvidence(evidence);
    const reordered = Object.fromEntries(
      Object.entries(evidence).toReversed(),
    ) as SourceAdmissionEvidence;
    expect(serializeSourceAdmissionEvidence(reordered)).to.equal(bytes);
    expect(JSON.parse(bytes)).to.deep.equal(evidence);
    expect(evidence).to.deep.equal(before);
    expect(bytes.startsWith('{\n  "contract":')).to.equal(true);
    expect(bytes.endsWith('\n')).to.equal(true);
    expect(bytes).not.to.include('\r');
    expect(bytes.codePointAt(0)).not.to.equal(65_279);
    expect(bytes).to.include('variant-000');
  });

  it('rejects non-JSON data, missing/extra schema keys, wrong versions, families, paths and ordering', () => {
    const { evidence } = setup('sfdc_cms__email', 2);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    for (const value of [
      undefined,
      Number.NaN,
      Infinity,
      1n,
      () => 1,
      new Date(),
      cyclic,
      Array.from({ length: 1 }),
    ]) {
      expect(() =>
        serializeSourceAdmissionEvidence(
          changed(evidence, (copy) => {
            copy.workspace.bad = value;
          }),
        ),
      ).to.throw();
    }
    for (const patch of [
      { contract: 'other' },
      { contractVersion: '2.0.0' },
      { complete: true },
      { workspace: undefined },
      { selections: [] },
    ])
      expect(() =>
        serializeSourceAdmissionEvidence({ ...evidence, ...patch } as SourceAdmissionEvidence),
      ).to.throw();
    for (const change of [
      (copy: MutableEvidence) => {
        copy.inventory.contentType = 'sfdc_cms__image';
      },
      (copy: MutableEvidence) => {
        copy.inventory.pages[0].page = 1;
      },
      (copy: MutableEvidence) => {
        copy.inventory.variants.reverse();
      },
      (copy: MutableEvidence) => {
        copy.selections.reverse();
      },
      (copy: MutableEvidence) => {
        copy.selections[0].rawItemPath = '../escape';
      },
      (copy: MutableEvidence) => {
        copy.selections[0].variantId = copy.selections[1].variantId;
      },
    ])
      expect(() => serializeSourceAdmissionEvidence(changed(evidence, change))).to.throw();
  });

  it('accepts selected subsets but derives and rejects unselected siblings from the full inventory', () => {
    const { evidence, manifest, rawItems } = setup('sfdc_cms__email', 2);
    const subset = { ...evidence, selections: evidence.selections.slice(0, 1) };
    manifest.entries = manifest.entries.slice(0, 1);
    manifest.items = manifest.items.slice(0, 1);
    manifest.expectedCount = manifest.foundCount = manifest.exportedCount = 1;
    rawItems.delete(evidence.selections[1].rawItemPath);
    expect(replaySourceAdmissionEvidence(subset, manifest, rawItems)).to.have.length(1);
    expect(() =>
      replaySourceAdmissionEvidence(
        changed(subset, (copy) => {
          copy.inventory.variants[1].managedContentId = copy.inventory.variants[0].managedContentId;
        }),
        manifest,
        rawItems,
      ),
    ).to.throw('sibling');
  });

  it('requires Template short-page termination, including empty terminal pages at exact multiples', () => {
    const { evidence, manifest, rawItems } = setup('sfdc_cms__emailTemplate', 250);
    expect(replaySourceAdmissionEvidence(evidence, manifest, rawItems)).to.have.length(250);
    expect(() =>
      replaySourceAdmissionEvidence(
        changed(evidence, (copy) => {
          copy.inventory.pages.pop();
        }),
        manifest,
        rawItems,
      ),
    ).to.throw('incomplete');
    expect(() =>
      replaySourceAdmissionEvidence(
        changed(evidence, (copy) => {
          copy.inventory.pages[0].response.count = 251;
        }),
        manifest,
        rawItems,
      ),
    ).to.throw('count');
    const partial = setup('sfdc_cms__emailTemplate', 251);
    expect(
      replaySourceAdmissionEvidence(partial.evidence, partial.manifest, partial.rawItems),
    ).to.have.length(251);
  });

  it('uses total/totalCount/count precedence and rejects truncation, extra pages, cap and duplicate inventory', () => {
    const { evidence, manifest, rawItems } = setup('sfdc_cms__email', 251);
    const precedence = changed(evidence, (copy) => {
      copy.inventory.pages[0].response.total = 251;
      copy.inventory.pages[0].response.count = 0;
    });
    expect(replaySourceAdmissionEvidence(precedence, manifest, rawItems)).to.have.length(251);
    for (const change of [
      (copy: MutableEvidence) => {
        copy.inventory.pages.pop();
      },
      (copy: MutableEvidence) => {
        copy.inventory.pages[0].response.total = 250_001;
      },
      (copy: MutableEvidence) => {
        copy.inventory.pages[1].response.items = [];
      },
      (copy: MutableEvidence) => {
        copy.inventory.pages.push({ page: 2, response: { items: [], count: 251 } });
      },
      (copy: MutableEvidence) => {
        (copy.inventory.pages[1].response.items as unknown[])[0] = row('variant-000');
      },
      (copy: MutableEvidence) => {
        copy.inventory.variants.pop();
      },
      (copy: MutableEvidence) => {
        copy.inventory.variants[0].managedContentVariantId = 'absent';
      },
    ])
      expect(() =>
        replaySourceAdmissionEvidence(changed(evidence, change), manifest, rawItems),
      ).to.throw();
  });

  it('rejects workspace/type/identity/parent/root contradictions and original dependency-bearing HTML', () => {
    const { evidence, manifest, rawItems } = setup();
    for (const change of [
      (copy: MutableEvidence) => {
        copy.workspace.id = 'other';
      },
      (copy: MutableEvidence) => {
        copy.workspace.name = '../forged';
      },
      (copy: MutableEvidence) => {
        copy.inventory.pages[0].response.items = [{ ...row('variant-000'), type: 'Unknown' }];
      },
      (copy: MutableEvidence) => {
        copy.inventory.pages[0].response.items = [
          { ...row('variant-000'), managedContentSpaceId: 'other' },
        ];
      },
      (copy: MutableEvidence) => {
        copy.inventory.variants[0].contentSpace = { id: 'other' };
      },
      (copy: MutableEvidence) => {
        copy.inventory.variants[0].contentType = 'sfdc_cms__emailTemplate';
      },
      (copy: MutableEvidence) => {
        copy.selections[0].parent.managedContentId = 'forged';
      },
      (copy: MutableEvidence) => {
        copy.selections[0].parent.contentSpace = { id: 'other' };
      },
      (copy: MutableEvidence) => {
        delete copy.selections[0].parent.folder;
      },
      (copy: MutableEvidence) => {
        copy.selections[0].parent.folder = { id: 'space' };
        copy.workspace.rootFolderId = 'space';
      },
    ])
      expect(() =>
        replaySourceAdmissionEvidence(changed(evidence, change), manifest, rawItems),
      ).to.throw();
    for (const patch of [
      { folder: undefined },
      { folder: { id: 'nested' } },
      {
        contentBody: {
          ...(evidence.inventory.variants[0].contentBody as object),
          rawHtml: '&lt;script&gt;alert(1)&lt;/script&gt;',
        },
      },
      {
        contentBody: {
          ...(evidence.inventory.variants[0].contentBody as object),
          'lightning:expressions': ['binding'],
        },
      },
    ]) {
      const candidate = changed(evidence, (copy) => {
        Object.assign(copy.inventory.variants[0], patch);
      });
      const raw = new Map([[candidate.selections[0].rawItemPath, candidate.inventory.variants[0]]]);
      expect(() => replaySourceAdmissionEvidence(candidate, manifest, raw)).to.throw();
    }
  });

  it('accepts explicit authoritative root IDs but rejects workspace-ID-as-root and unknown ancestry', () => {
    const { evidence, manifest } = setup();
    const rooted = changed(evidence, (copy) => {
      copy.inventory.variants[0].folder = { id: 'folder-source-id' };
      copy.selections[0].parent.folder = { id: 'folder-source-id' };
    });
    const rawItems = new Map([[rooted.selections[0].rawItemPath, rooted.inventory.variants[0]]]);
    expect(replaySourceAdmissionEvidence(rooted, manifest, rawItems)[0].folderPath).to.deep.equal(
      [],
    );
    for (const rootFolderId of [undefined, 'space', 'different'])
      expect(() =>
        replaySourceAdmissionEvidence(
          changed(rooted, (copy) => {
            copy.workspace.rootFolderId = rootFolderId;
          }),
          manifest,
          rawItems,
        ),
      ).to.throw();
  });

  it('rejects duplicate exact selection paths and duplicate variant records', () => {
    const { evidence, manifest, rawItems } = setup('sfdc_cms__email', 2);
    expect(() =>
      replaySourceAdmissionEvidence(
        changed(evidence, (copy) => {
          copy.selections[1].rawItemPath = copy.selections[0].rawItemPath;
        }),
        manifest,
        rawItems,
      ),
    ).to.throw('binding');
    expect(() =>
      serializeSourceAdmissionEvidence(
        changed(evidence, (copy) => {
          copy.inventory.variants[1] = copy.inventory.variants[0];
        }),
      ),
    ).to.throw('unique');
  });

  it('rejects raw drift, missing/extra baseline records, exact path/variant mismatches and selected count drift', () => {
    const { evidence, manifest, rawItems } = setup();
    expect(() => replaySourceAdmissionEvidence(evidence, manifest, new Map())).to.throw();
    const extra = new Map(rawItems);
    extra.set('extra', {});
    expect(() => replaySourceAdmissionEvidence(evidence, manifest, extra)).to.throw();
    rawItems.values().next().value!.title = 'Drift';
    expect(() => replaySourceAdmissionEvidence(evidence, manifest, rawItems)).to.throw('binding');
    const fresh = setup();
    for (const change of [
      (copy: MutableEvidence) => {
        copy.selections[0].rawItemPath = 'items/other.json';
      },
      (copy: MutableEvidence) => {
        copy.selections[0].variantId = 'other';
      },
    ])
      expect(() =>
        replaySourceAdmissionEvidence(
          changed(fresh.evidence, change),
          fresh.manifest,
          fresh.rawItems,
        ),
      ).to.throw();
    fresh.manifest.expectedCount = 2;
    expect(() =>
      replaySourceAdmissionEvidence(fresh.evidence, fresh.manifest, fresh.rawItems),
    ).to.throw();
  });
});
