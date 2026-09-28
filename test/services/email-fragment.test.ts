import { expect } from 'chai';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import sinon from 'sinon';
import {
  assertEmailFragmentItem,
  planEmailFragmentCopies,
} from '../../src/services/email-fragment.js';
import {
  executeWorkspaceImport,
  type LoadedWorkspaceExport,
  type WorkspaceImportItem,
} from '../../src/services/import-workspace.js';

const backgroundImage = { position: 'center center', repeat: 'no-repeat', size: 'cover' };
const baseLayoutAttributes = {
  'lightning:backgroundImage': backgroundImage,
  'lightning:borderRadius': '{!$brand.borderRadius.square}',
  'lightning:borderWidth': '{!$brand.borderWeight.none}',
  'lightning:colorScheme': '{!$brand.colorScheme}',
  'lightning:margin': '{!$brand.spacing.none}',
  'lightning:padding': '{!$brand.spacing.xSmall}',
};
const sectionAttributes = {
  ...baseLayoutAttributes,
  reverseOrderOnMobile: false,
  stackOnMobile: true,
};
const columnAttributes = {
  ...baseLayoutAttributes,
  columnWidth: 12,
  'lightning:verticalAlignment': 'top',
};
const fragmentBody = {
  backgroundColor: '#f3f3f3',
  'lightning:backgroundImage': backgroundImage,
  'lightning:brandSource': { defaultBrandOption: 'sfdcBrand' },
  'lightning:colorScheme': '{!$brand.colorScheme}',
  'lightning:dataProviders': [],
  'lightning:expressions': [],
  'lightning:padding': '{!$brand.spacing.none}',
  'sfdc_cms:attachments': [],
  'sfdc_cms:block': {
    children: [
      {
        attributes: sectionAttributes,
        children: [
          {
            attributes: columnAttributes,
            children: [],
            definition: 'lightning/column',
            id: 'column-1',
            type: 'block',
          },
        ],
        definition: 'lightning/section',
        id: 'section-1',
        type: 'block',
      },
    ],
    definition: 'sfdc_cms/rootContentBlock',
    id: 'root-1',
    type: 'block',
  },
  'sfdc_cms:title': 'Reusable footer',
  'sfdc_cms:urlName': 'reusable-footer',
  'sfdc_cms:variants': [],
};

function fragment(overrides: Partial<WorkspaceImportItem> = {}): WorkspaceImportItem {
  return {
    apiName: 'source_fragment_api',
    contentBody: fragmentBody,
    contentKey: 'source-fragment-key',
    contentSpace: { id: 'source-space' },
    contentType: 'sfdc_cms__emailFragment',
    id: 'source-fragment-variant',
    language: 'en_US',
    title: 'Reusable footer',
    urlName: 'reusable-footer',
    ...overrides,
  };
}

function fragmentWithColumnAttributes(attributes: Record<string, unknown>): WorkspaceImportItem {
  const contentBody = structuredClone(fragmentBody);
  const column = contentBody['sfdc_cms:block'].children[0].children[0] as {
    attributes: Record<string, unknown>;
  };
  column.attributes = attributes;
  return fragment({ contentBody });
}

function source(item = fragment()): LoadedWorkspaceExport {
  return {
    integrity: { listedItemCount: 1, unlistedFileCount: 0, verified: true, verifiedItemCount: 1 },
    isPartial: false,
    items: [item],
    manifest: {
      schemaVersion: 1,
      mode: 'experimental-best-effort',
      workspaceId: 'source-space',
      search: {
        contentSpaceOrFolderIds: ['source-space'],
        languages: ['All'],
        pageSize: 250,
        queryTerm: '*',
      },
      expectedCount: 1,
      foundCount: 1,
      exportedCount: 1,
      pagesRequested: 1,
      entries: [
        { file: 'items/source-fragment-variant.json', variantId: 'source-fragment-variant' },
      ],
      rejectedVariantIds: [],
      failedVariantIds: [],
      warnings: [{ code: 'UNSUPPORTED_WILDCARD', message: 'provenance only' }],
      contract: 'sf-cms-workspace-export',
      contractVersion: '1.0.0',
      provenance: {
        producer: 'sf-plugin-cms',
        sourceOrgId: 'source-org',
        sourceWorkspaceId: 'source-space',
        pluginVersion: '0.4.0',
        generatedAt: '2026-09-27T00:00:00.000Z',
      },
      completeness: 'complete',
      dependencies: [],
      externalReferences: [],
      items: [
        {
          path: 'items/source-fragment-variant.json',
          sha256: 'a'.repeat(64),
          kind: 'cms.content',
        },
      ],
    },
    manifestSha256: 'b'.repeat(64),
    sourceDirectory: 'synthetic-source',
  };
}

const mapping = [
  {
    source: { family: 'cms', type: 'emailFragment', apiName: 'source_fragment_api' },
    target: { contentKey: 'fresh-fragment-key', apiName: 'fresh_fragment_api' },
  },
];
const invalidColumnAttributeCases = [
  [
    'section-only mobile fields',
    { ...columnAttributes, reverseOrderOnMobile: false, stackOnMobile: true },
  ],
  [
    'missing field',
    Object.fromEntries(Object.entries(columnAttributes).filter(([key]) => key !== 'columnWidth')),
  ],
  ['near-match value', { ...columnAttributes, columnWidth: 11 }],
  ['unknown field', { ...columnAttributes, unexpected: true }],
] as const;

function fakeNotFound(): Promise<never> & { stream(): PassThrough } {
  return Object.assign(Promise.reject(Object.assign(new Error('missing'), { statusCode: 404 })), {
    stream: () => new PassThrough(),
  });
}

function absentApiName() {
  return Promise.resolve({ done: true, records: [], totalSize: 0 });
}

describe('bounded email fragment create profile', () => {
  it('accepts the exact evidenced section and saved column attribute profiles', () => {
    expect(() => assertEmailFragmentItem(fragment())).not.to.throw();
  });

  it('preserves the complete evidenced body while changing only fresh parent identities', () => {
    const loaded = source();
    const before = structuredClone(loaded);
    const result = planEmailFragmentCopies(loaded, mapping);

    expect(result.targetContentKeys).to.deep.equal(['fresh-fragment-key']);
    expect(result.items[0]).to.deep.equal({
      ...loaded.items[0],
      contentKey: 'fresh-fragment-key',
      apiName: 'fresh_fragment_api',
    });
    expect(result.items[0].contentBody).to.equal(loaded.items[0].contentBody);
    expect(loaded).to.deep.equal(before);
  });

  for (const [name, attributes] of invalidColumnAttributeCases) {
    it(`rejects column attributes with ${name}`, () => {
      const item = fragmentWithColumnAttributes(attributes);
      expect(() => assertEmailFragmentItem(item)).to.throw(
        'Email fragment column.attributes must match the evidenced dependency-free profile',
      );
      expect(() => planEmailFragmentCopies(source(item), mapping)).to.throw();
    });
  }

  for (const [name, item] of [
    ['wrong type', fragment({ contentType: 'sfdc_cms__webFragment' })],
    ['missing API identity', fragment({ apiName: undefined })],
    ['missing title', fragment({ title: '' })],
    [
      'missing body URL name',
      fragment({
        contentBody: Object.fromEntries(
          Object.entries(fragmentBody).filter(([key]) => key !== 'sfdc_cms:urlName'),
        ),
      }),
    ],
    [
      'wrong body URL-name type',
      fragment({ contentBody: { ...fragmentBody, 'sfdc_cms:urlName': 1 } }),
    ],
    ['empty body URL name', fragment({ contentBody: { ...fragmentBody, 'sfdc_cms:urlName': '' } })],
    ['inconsistent top-level URL name', fragment({ urlName: 'different-url-name' })],
    [
      'malformed tree',
      fragment({
        contentBody: {
          ...fragmentBody,
          'sfdc_cms:block': { ...fragmentBody['sfdc_cms:block'], children: [] },
        },
      }),
    ],
    [
      'extra discriminator alias',
      fragment({
        contentBody: {
          ...fragmentBody,
          'sfdc_cms:block': { ...fragmentBody['sfdc_cms:block'], componentType: 'root' },
        },
      }),
    ],
    [
      'near-match definition',
      fragment({
        contentBody: {
          ...fragmentBody,
          'sfdc_cms:block': {
            ...fragmentBody['sfdc_cms:block'],
            definition: 'sfdc_cms/rootContentBlockExtra',
          },
        },
      }),
    ],
    ['unsupported reference field', fragment({ contentBody: { ...fragmentBody, references: [] } })],
    [
      'unsupported media field',
      fragment({ contentBody: { ...fragmentBody, imageUrl: 'https://example.invalid/x.png' } }),
    ],
    [
      'unsupported non-empty component',
      fragment({
        contentBody: {
          ...fragmentBody,
          'sfdc_cms:block': {
            ...fragmentBody['sfdc_cms:block'],
            children: [
              {
                ...fragmentBody['sfdc_cms:block'].children[0],
                children: [
                  {
                    ...fragmentBody['sfdc_cms:block'].children[0].children[0],
                    children: [{ type: 'block' }],
                  },
                ],
              },
            ],
          },
        },
      }),
    ],
    [
      'nonempty attachments',
      fragment({ contentBody: { ...fragmentBody, 'sfdc_cms:attachments': [{}] } }),
    ],
    [
      'nonempty variants',
      fragment({ contentBody: { ...fragmentBody, 'sfdc_cms:variants': [{}] } }),
    ],
    [
      'nonempty providers',
      fragment({ contentBody: { ...fragmentBody, 'lightning:dataProviders': [{}] } }),
    ],
    [
      'nonempty expressions',
      fragment({ contentBody: { ...fragmentBody, 'lightning:expressions': [{}] } }),
    ],
    ['unknown field', fragment({ contentBody: { ...fragmentBody, unexpected: true } })],
    [
      'raw HTML companion shape',
      fragment({ contentBody: { ...fragmentBody, rawHtml: '<p>x</p>' } }),
    ],
  ] as const) {
    it(`rejects ${name}`, () => {
      expect(() => assertEmailFragmentItem(item)).to.throw();
      expect(() => planEmailFragmentCopies(source(item), mapping)).to.throw();
    });
  }

  it('rejects missing, ambiguous, wrong-type, and duplicate typed selections', () => {
    const duplicate = fragment({
      id: 'duplicate-fragment-variant',
      contentKey: 'other-source-key',
    });
    for (const [loaded, rows, message] of [
      [
        source(),
        [{ ...mapping[0], source: { ...mapping[0].source, apiName: 'missing' } }],
        'exactly one',
      ],
      [{ ...source(), items: [fragment(), duplicate] }, mapping, 'exactly one'],
      [
        source(),
        [{ ...mapping[0], source: { ...mapping[0].source, type: 'webFragment' } }],
        'cms/emailFragment',
      ],
      [source(), [mapping[0], mapping[0]], 'Duplicate email fragment selection'],
    ] as const) {
      expect(() => planEmailFragmentCopies(loaded, rows)).to.throw(message);
    }
  });

  it('rejects source and run identity conflicts without changing source data', () => {
    const loaded = source();
    const before = structuredClone(loaded);
    for (const target of [
      { ...mapping[0].target, contentKey: 'source-fragment-key' },
      { ...mapping[0].target, apiName: 'source_fragment_api' },
    ]) {
      expect(() => planEmailFragmentCopies(loaded, [{ ...mapping[0], target }])).to.throw(
        'fresh and unique',
      );
    }
    expect(() => planEmailFragmentCopies(loaded, [mapping[0], mapping[0]])).to.throw();
    expect(loaded).to.deep.equal(before);
  });

  for (const [name, contentBody] of [
    [
      'missing URL name',
      Object.fromEntries(
        Object.entries(fragmentBody).filter(([key]) => key !== 'sfdc_cms:urlName'),
      ),
    ],
    ['wrong URL-name type', { ...fragmentBody, 'sfdc_cms:urlName': 1 }],
    ['empty URL name', { ...fragmentBody, 'sfdc_cms:urlName': '' }],
    ['inconsistent URL-name binding', { ...fragmentBody, 'sfdc_cms:urlName': 'different-url' }],
    ['references', { ...fragmentBody, references: [] }],
    ['media', { ...fragmentBody, imageUrl: 'https://example.invalid/x.png' }],
    ['attachments', { ...fragmentBody, 'sfdc_cms:attachments': [{}] }],
    ['variants', { ...fragmentBody, 'sfdc_cms:variants': [{}] }],
    ['providers', { ...fragmentBody, 'lightning:dataProviders': [{}] }],
    ['expressions', { ...fragmentBody, 'lightning:expressions': [{}] }],
    ['unknown fields', { ...fragmentBody, unexpected: true }],
  ] as const) {
    it(`fails unsupported ${name} before any destination or mutation transport`, async () => {
      const request = sinon.stub();
      const query = sinon.stub();
      let failure: unknown;
      try {
        await executeWorkspaceImport({
          connection: { query, request },
          destinationOrgId: 'target-org',
          destinationWorkspace: {
            defaultLanguage: 'en_US',
            id: 'destination-space',
            rootFolderId: 'root-folder',
          },
          dryRun: true,
          emailFragmentMappings: mapping,
          loadedSource: source(fragment({ contentBody })),
          sourceDirectory: 'synthetic-source',
          workspaceId: 'destination-space',
        });
      } catch (error) {
        failure = error;
      }
      expect(failure).to.be.instanceOf(TypeError);
      expect(request.notCalled).to.equal(true);
      expect(query.notCalled).to.equal(true);
    });
  }

  for (const [name, attributes] of invalidColumnAttributeCases) {
    it(`fails column ${name} before any destination or mutation transport`, async () => {
      const request = sinon.stub();
      const query = sinon.stub();
      let failure: unknown;
      try {
        await executeWorkspaceImport({
          connection: { query, request },
          destinationOrgId: 'target-org',
          destinationWorkspace: {
            defaultLanguage: 'en_US',
            id: 'destination-space',
            rootFolderId: 'root-folder',
          },
          dryRun: true,
          emailFragmentMappings: mapping,
          loadedSource: source(fragmentWithColumnAttributes(attributes)),
          sourceDirectory: 'synthetic-source',
          workspaceId: 'destination-space',
        });
      } catch (error) {
        failure = error;
      }
      expect(failure).to.be.instanceOf(TypeError);
      expect(request.notCalled).to.equal(true);
      expect(query.notCalled).to.equal(true);
    });
  }

  it('blocks apply when exact API-name absence cannot be proven', async () => {
    const request = sinon.stub().returns(fakeNotFound());
    const query = sinon.stub().rejects(new Error('lookup unavailable'));
    let failure: unknown;
    try {
      await executeWorkspaceImport({
        connection: { query, request },
        destinationOrgId: 'target-org',
        destinationWorkspace: {
          defaultLanguage: 'en_US',
          id: 'destination-space',
          rootFolderId: 'root-folder',
        },
        dryRun: false,
        emailFragmentMappings: mapping,
        loadedSource: source(),
        reportDirectory: 'unused-report',
        sourceDirectory: 'synthetic-source',
        workspaceId: 'destination-space',
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).to.be.instanceOf(Error);
    expect(request.calledOnce).to.equal(true);
    expect(query.calledOnce).to.equal(true);
  });

  it('rejects an evidenced exact API-name collision', async () => {
    const request = sinon.stub().returns(fakeNotFound());
    const query = sinon.stub().resolves({
      done: true,
      records: [{ ApiName: 'fresh_fragment_api' }],
      totalSize: 1,
    });
    let failure: unknown;
    try {
      await executeWorkspaceImport({
        connection: { query, request },
        destinationOrgId: 'target-org',
        destinationWorkspace: {
          defaultLanguage: 'en_US',
          id: 'destination-space',
          rootFolderId: 'root-folder',
        },
        dryRun: true,
        emailFragmentMappings: mapping,
        loadedSource: source(),
        sourceDirectory: 'synthetic-source',
        workspaceId: 'destination-space',
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).to.be.instanceOf(Error);
  });

  it('rechecks key and API-name collisions immediately before CREATE', async () => {
    const request = sinon.stub().returns(fakeNotFound());
    const query = sinon.stub();
    query.onFirstCall().callsFake(absentApiName);
    query.onSecondCall().resolves({
      done: true,
      records: [{ ApiName: 'fresh_fragment_api' }],
      totalSize: 1,
    });
    const { mkdtemp, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const root = await mkdtemp(path.join(tmpdir(), 'cms-email-fragment-collision-'));
    try {
      let failure: unknown;
      try {
        await executeWorkspaceImport({
          connection: { query, request },
          destinationOrgId: 'target-org',
          destinationWorkspace: {
            defaultLanguage: 'en_US',
            id: 'destination-space',
            rootFolderId: 'root-folder',
          },
          dryRun: false,
          emailFragmentMappings: mapping,
          loadedSource: source(),
          reportDirectory: path.join(root, 'report'),
          sourceDirectory: 'synthetic-source',
          workspaceId: 'destination-space',
        });
      } catch (error) {
        failure = error;
      }
      expect(failure).to.be.instanceOf(Error);
      expect(query.callCount).to.equal(2);
      expect(request.getCalls().filter(({ args }) => args[0].method === 'POST')).to.have.length(0);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it('dry-runs the bounded shape with exact key and API-name conflict checks', async () => {
    const request = sinon.stub().returns(fakeNotFound());
    const query = sinon.stub().callsFake(absentApiName);
    const result = await executeWorkspaceImport({
      connection: { query, request },
      destinationOrgId: 'target-org',
      destinationWorkspace: {
        defaultLanguage: 'en_US',
        id: 'destination-space',
        rootFolderId: 'root-folder',
      },
      dryRun: true,
      emailFragmentMappings: mapping,
      loadedSource: source(),
      sourceDirectory: 'synthetic-source',
      workspaceId: 'destination-space',
    });

    expect(request.calledOnce).to.equal(true);
    expect(request.firstCall.args[0]).to.include({ method: 'GET' });
    expect(
      query.calledOnceWithExactly(
        "SELECT ApiName FROM ManagedContent WHERE ApiName = 'fresh_fragment_api' LIMIT 1",
      ),
    ).to.equal(true);
    expect(result.plan.groups[0].primary.contentBody).to.deep.equal(fragmentBody);
    expect(result.diagnostics.map(({ code }) => code)).to.deep.equal([
      'NAME_AVAILABILITY_UNVERIFIED',
      'SERVER_CONFLICT_CHECK_UNVERIFIED',
      'APPLY_READINESS_UNVERIFIED',
    ]);
  });
});
