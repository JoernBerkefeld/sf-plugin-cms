import path from 'node:path';
import { Parser } from '@oclif/core';
import { Org } from '@salesforce/core';
import { expect } from 'chai';
import sinon from 'sinon';
import RetrieveContent from '../../src/commands/cms/retrieve/content.js';
import type { AcquiredEditableEmailSource } from '../../src/services/retrieve-item-source.js';
import type { NativeInventoryRow } from '../../src/services/retrieve-native-inventory.js';
import type { NativeRetrieveResolution } from '../../src/services/retrieve-native-resolution.js';
import { CmsRequestError } from '../../src/transport/json-request.js';
import { normalizeRetrieveSelection } from '../../src/services/retrieve-selection.js';

const flags = {
  'target-org': { getUsername: () => 'source' },
  'api-version': '67.0',
  'workspace-id': 'space',
  'content-type': ['sfdc_cms__email'],
  'api-name': ['Welcome'],
  'default-language': true,
  'output-dir': './project',
  overwrite: false,
};
const source = {
  directory: 'cms/Marketing/email',
  projection: { definition: { language: 'en_US' } },
  evidence: { variantId: 'variant', contentId: 'parent' },
} as AcquiredEditableEmailSource;
const receipt = {
  definitionPath: path.resolve('project/cms/Marketing/email/Welcome.cms-email.json'),
  created: [path.resolve('project/cms/Marketing/email/Welcome.cms-email.json')],
  updated: [],
  unchanged: [],
  removed: [],
};
function row(
  id = 'variant',
  name: string | null = 'Welcome',
  type = 'sfdc_cms__email',
): NativeInventoryRow {
  return {
    Id: id,
    ManagedContentId: `parent-${id}`,
    ContentTypeFullyQualifiedName: type,
    Language: 'en_US',
    ManagedContent: { ApiName: name, AuthoredManagedContentSpaceId: 'resolved-space' },
  } as NativeInventoryRow;
}
function command(extra: Record<string, unknown> = {}) {
  const instance = Object.create(RetrieveContent.prototype) as RetrieveContent;
  const connection = {
    version: '67.0',
    request: sinon.stub().rejects(new Error('Unexpected transport')),
  };
  const getOrgContext = sinon.stub().resolves({ connection, orgId: '00DSource' });
  const resolveSourceWorkspace = sinon
    .stub()
    .resolves({ id: 'resolved-space', workspace: { defaultLanguage: 'en_US' } });
  const resolution: NativeRetrieveResolution = {
    workspaceId: 'resolved-space',
    language: 'en_US',
    apiVersion: '67.0',
    variants: [row()],
    unresolved: [],
    inventory: {
      complete: true,
      pagesRequested: 6,
      recordCount: 1,
      contentTypes: ['sfdc_cms__email'],
      scope: 'principal-visible-nondeleted-family-all-languages-and-statuses',
    },
  };
  const acquire = sinon.stub().resolves(source);
  const prepareSources = sinon.stub().resolves({ resolution, acquire });
  const writeSource = sinon.stub().resolves(structuredClone(receipt));
  const log = sinon.stub();
  Object.assign(instance, {
    parse: sinon.stub().resolves({ flags: { ...flags, ...extra } }),
    getOrgContext,
    resolveSourceWorkspace,
    prepareSources,
    writeSource,
    jsonEnabled: sinon.stub().returns(true),
    log,
  });
  return {
    instance,
    connection,
    getOrgContext,
    resolveSourceWorkspace,
    resolution,
    acquire,
    prepareSources,
    writeSource,
    log,
  };
}
const arguments_ = [
  '-o',
  'source',
  '-w',
  'space',
  '-t',
  'sfdc_cms__email',
  '-n',
  'Welcome',
  '-L',
  '-d',
  './project',
];

describe('cms retrieve content command', () => {
  beforeEach(() => {
    process.exitCode = undefined;
  });
  afterEach(() => {
    sinon.restore();
    process.exitCode = undefined;
  });

  it('parses repeatable selectors and resolves an explicit org without changing configuration', async () => {
    const org = { getUsername: () => 'source@example.test' } as Org;
    const create = sinon.stub(Org, 'create').resolves(org);
    const parsed = await Parser.parse([...arguments_, '-n', 'Other', '-x'], {
      flags: RetrieveContent.flags,
    });
    expect(parsed.flags['api-name']).to.deep.equal(['Welcome', 'Other']);
    expect(parsed.flags.overwrite).to.equal(true);
    expect(parsed.flags['target-org']).to.equal(org);
    expect(create.firstCall.args).to.deep.equal([{ aliasOrUsername: 'source' }]);
    for (const selector of [
      ['-m', 'email'],
      ['-t', 'email', '-i', 'key'],
      ['-t', 'email', '-a'],
    ]) {
      const alternative = await Parser.parse(['-o', 'source', '-W', 'Marketing', ...selector], {
        flags: RetrieveContent.flags,
      });
      expect(alternative.flags['target-org']).to.equal(org);
      expect(alternative.flags['output-dir']).to.equal(undefined);
    }
  });

  for (const override of [false, true]) {
    it(`runs the minimal real parser with controlled default org (override: ${override})`, async () => {
      const create = sinon.stub(Org, 'create').callsFake(async (options) => {
        const username =
          (options as { aliasOrUsername?: string } | undefined)?.aliasOrUsername === 'override'
            ? 'override@example.test'
            : 'default@example.test';
        return { getUsername: () => username } as Org;
      });
      const subject = command();
      Object.assign(subject.instance, {
        parse: () =>
          Parser.parse(
            [
              '-W',
              'Content Workspace for Marketing Cloud',
              ...(override ? ['-o', 'override'] : []),
            ],
            { flags: RetrieveContent.flags },
          ),
      });
      const result = await subject.instance.run();
      const username = override ? 'override@example.test' : 'default@example.test';
      expect(create.firstCall.args).to.deep.equal([
        { aliasOrUsername: override ? 'override' : undefined },
      ]);
      expect(subject.getOrgContext.firstCall.args[0]).to.equal(username);
      expect(result.result!.scope).to.include({
        targetOrg: username,
        workspaceName: 'Content Workspace for Marketing Cloud',
        language: 'en_US',
        defaultLanguage: true,
        outputDir: process.cwd(),
      });
      expect(result.status).to.equal('success');
      expect(subject.prepareSources.firstCall.args[1].selection).to.deep.equal(
        normalizeRetrieveSelection({}),
      );
      expect(subject.writeSource.firstCall.args[0]).to.equal(process.cwd());
    });
  }

  it('retains the standard Salesforce missing-default parser error before selection handling', async () => {
    sinon.stub(Org, 'create').rejects(new Error('No default configured in controlled auth mock'));
    const subject = command();
    Object.assign(subject.instance, {
      parse: () => Parser.parse(['-W', 'Marketing'], { flags: RetrieveContent.flags }),
    });
    let failure: unknown;
    try {
      await subject.instance.run();
    } catch (error) {
      failure = error;
    }
    expect(failure).to.be.instanceOf(Error);
    expect((failure as Error).message).to.include('No default environment found');
    expect((failure as Error).message).not.to.include('RETRIEVE_SELECTION_INVALID');
    expect(subject.getOrgContext.notCalled).to.equal(true);
    expect(subject.prepareSources.notCalled).to.equal(true);
    expect(subject.writeSource.notCalled).to.equal(true);
  });

  it('runs explicit workspace ID, output and language overrides through the real parser', async () => {
    sinon.stub(Org, 'create').resolves({ getUsername: () => 'source' } as Org);
    for (const language of [[], ['-L'], ['-l', 'fr']]) {
      const subject = command();
      Object.assign(subject.instance, {
        parse: () =>
          Parser.parse(
            ['-o', 'source', '-w', 'space', '-m', 'email:Welcome', '-d', './project', ...language],
            { flags: RetrieveContent.flags },
          ),
      });
      const result = await subject.instance.run();
      expect(result.status).to.equal('success');
      expect(result.result!.scope).to.include({
        language: language[0] === '-l' ? 'fr' : 'en_US',
        defaultLanguage: language[0] !== '-l',
        outputDir: path.resolve('project'),
      });
      expect(subject.prepareSources.firstCall.args[1].selection.groups).to.have.length(1);
    }
  });

  it('retains real-parser blank output, language conflict and missing workspace diagnostics', async () => {
    sinon.stub(Org, 'create').resolves({ getUsername: () => 'source' } as Org);
    for (const arguments_ of [
      ['-W', 'Marketing', '-d', ''],
      ['-W', 'Marketing', '-d', '   '],
      ['-W', 'Marketing', '-l', 'fr', '-L'],
      ['-W', 'Marketing', '-l', ''],
      [],
      ['-W', 'Marketing', '-w', 'space'],
      ['-W', 'Marketing', '-t', 'email'],
      ['-W', 'Marketing', '-a'],
    ]) {
      const subject = command();
      Object.assign(subject.instance, {
        parse: () => Parser.parse(arguments_, { flags: RetrieveContent.flags }),
      });
      const result = await subject.instance.run();
      expect(result.status).to.equal('blocked');
      expect(result.diagnostics.errors[0].code).to.equal('RETRIEVE_SELECTION_INVALID');
      expect(subject.getOrgContext.notCalled).to.equal(true);
      expect(subject.writeSource.notCalled).to.equal(true);
    }
  });

  it('defaults only omitted output/language with an explicit workspace ID and short selector', async () => {
    const subject = command({
      'output-dir': undefined,
      'default-language': false,
      'content-type': ['email'],
      language: undefined,
    });
    const result = await subject.instance.run();
    expect(result.result!.scope).to.include({
      outputDir: process.cwd(),
      defaultLanguage: true,
      language: 'en_US',
    });
    expect(subject.writeSource.firstCall.args[0]).to.equal(process.cwd());
    expect(subject.resolveSourceWorkspace.firstCall.args[1]).to.deep.equal({
      workspaceId: 'space',
      workspaceName: undefined,
    });
    expect(subject.prepareSources.firstCall.args[1].selection.mode).to.equal('api-name');
  });

  it('accepts an explicit language without -L and preserves the explicit output override', async () => {
    const subject = command({
      language: 'de',
      'default-language': false,
      'output-dir': './elsewhere',
    });
    const result = await subject.instance.run();
    expect(result.result!.scope).to.include({
      language: 'de',
      defaultLanguage: false,
      outputDir: path.resolve('elsewhere'),
    });
    expect(subject.prepareSources.firstCall.args[1].language).to.equal('de');
    expect(subject.writeSource.firstCall.args[0]).to.equal('./elsewhere');
  });

  it('prepares exactly once before writing and retains the single-item identity, receipt and counts', async () => {
    const subject = command();
    const result = await subject.instance.run();
    expect(result.status).to.equal('success');
    expect(process.exitCode).to.equal(0);
    expect(subject.getOrgContext.firstCall.args).to.deep.equal(['source', '67.0']);
    expect(subject.prepareSources.calledOnce).to.equal(true);
    expect(subject.prepareSources.firstCall.args).to.deep.equal([
      subject.connection,
      {
        workspaceId: 'resolved-space',
        language: 'en_US',
        selection: {
          mode: 'api-name',
          groups: [
            {
              contentType: 'sfdc_cms__email',
              all: false,
              apiNames: ['Welcome'],
              contentKeysOrIds: [],
            },
          ],
        },
      },
    ]);
    expect(subject.acquire.firstCall.args).to.deep.equal(['variant']);
    expect(subject.prepareSources.calledBefore(subject.acquire)).to.equal(true);
    expect(subject.acquire.calledBefore(subject.writeSource)).to.equal(true);
    expect(subject.writeSource.firstCall.args).to.deep.equal([
      './project',
      source.directory,
      source.projection,
      false,
    ]);
    expect(result.result!.items).to.deep.equal([
      {
        identity: { contentType: 'sfdc_cms__email', apiName: 'Welcome', language: 'en_US' },
        operation: 'retrieve',
        outcome: 'retrieved',
        paths: receipt,
        evidence: source.evidence,
        diagnostics: [],
      },
    ]);
    expect(result.result!.summary).to.deep.equal({
      selected: 1,
      retrieved: 1,
      unchanged: 0,
      blocked: 0,
      unattempted: 0,
    });
    expect(result.result!.selection).to.deep.equal({
      contentTypes: ['sfdc_cms__email'],
      apiNames: ['Welcome'],
    });
    expect(result.result!.resolution!.inventory.pagesRequested).to.equal(6);
    expect(subject.connection.request.notCalled).to.equal(true);
  });

  it('records effective numeric API for latest mode', async () => {
    const subject = command({ 'api-version': 'latest' });
    Object.assign(subject.connection, { version: '68.0' });
    const result = await subject.instance.run();
    expect(result.metadata.apiVersion).to.equal('68.0');
  });

  it('uses exact explicit language, Template selection, overwrite and unchanged receipts', async () => {
    const subject = command({
      'workspace-id': undefined,
      'workspace-name': 'Marketing',
      language: 'fr',
      'default-language': false,
      overwrite: true,
      'content-type': ['sfdc_cms__emailTemplate'],
    });
    subject.resolution.variants = [row('template', 'Welcome', 'sfdc_cms__emailTemplate')];
    subject.resolution.variants[0].Language = 'fr';
    subject.writeSource.resolves({ ...receipt, created: [], unchanged: receipt.created });
    Object.assign(subject.instance, { jsonEnabled: sinon.stub().returns(false) });
    const first = await subject.instance.run();
    const second = await subject.instance.run();
    expect(first.result).to.deep.equal(second.result);
    expect(first.result!.items[0].identity).to.deep.equal({
      contentType: 'sfdc_cms__emailTemplate',
      apiName: 'Welcome',
      language: 'fr',
    });
    expect(first.result!.summary.unchanged).to.equal(1);
    expect(subject.prepareSources.firstCall.args[1].language).to.equal('fr');
    expect(subject.writeSource.firstCall.args[3]).to.equal(true);
    expect(subject.resolveSourceWorkspace.firstCall.args[1]).to.deep.equal({
      workspaceId: undefined,
      workspaceName: 'Marketing',
    });
    expect(subject.log.args.flat().join('\n')).to.include(receipt.definitionPath);
  });

  for (const extra of [
    { 'workspace-id': undefined },
    { 'workspace-name': 'other' },
    { 'workspace-id': ' ' },
    { language: 'fr' },
    { language: '', 'default-language': false },
    { 'target-org': { getUsername: () => '' } },
    { 'output-dir': '' },
    { 'output-dir': '   ' },
    { 'api-name': [' '] },
    { 'content-type': ['sfdc_cms__video'] },
    { 'content-type': ['Email'] },
    { 'content-type': ['sfdc_cms__email', 'sfdc_cms__emailTemplate'] },
    { metadata: ['sfdc_cms__email:Welcome'] },
    { all: true },
    { 'content-key-or-id': ['id'] },
    { 'api-name': undefined },
  ]) {
    it(`blocks invalid selectors before auth: ${JSON.stringify(extra)}`, async () => {
      const subject = command(extra);
      const result = await subject.instance.run();
      expect(result.status).to.equal('blocked');
      expect(process.exitCode).to.equal(1);
      expect(subject.getOrgContext.notCalled).to.equal(true);
      expect(subject.writeSource.notCalled).to.equal(true);
    });
  }

  for (const contentType of [
    'sfdc_cms__image',
    'sfdc_cms__document',
    'sfdc_cms__audio',
    'sfdc_cms__brand',
  ] as const) {
    it(`admits a standalone ${contentType} selector through preparation and local writing`, async () => {
      const subject = command({
        'content-type': [contentType],
        'api-name': ['Hero'],
      });
      subject.resolution.variants = [row('image', 'Hero', contentType)];
      subject.resolution.inventory.contentTypes = [contentType];
      const result = await subject.instance.run();
      expect(result.status).to.equal('success');
      expect(process.exitCode).to.equal(0);
      expect(subject.getOrgContext.calledOnce).to.equal(true);
      expect(subject.prepareSources.firstCall.args[1].selection.groups).to.deep.equal([
        { contentType, all: false, apiNames: ['Hero'], contentKeysOrIds: [] },
      ]);
      expect(subject.acquire.calledOnceWithExactly('image')).to.equal(true);
      expect(subject.writeSource.calledOnce).to.equal(true);
      expect(result.result!.items[0].identity).to.deep.equal({
        contentType,
        apiName: 'Hero',
        language: 'en_US',
      });
    });
  }

  it('normalizes duplicate names without cross products or repeated writes', async () => {
    const subject = command({
      'content-type': ['sfdc_cms__email', 'sfdc_cms__email'],
      'api-name': ['Welcome', 'Welcome'],
    });
    await subject.instance.run();
    expect(subject.prepareSources.firstCall.args[1].selection.groups).to.have.length(1);
    expect(subject.prepareSources.firstCall.args[1].selection.groups[0].apiNames).to.deep.equal([
      'Welcome',
    ]);
    expect(subject.writeSource.calledOnce).to.equal(true);
  });

  it('preserves metadata all/name overlap and every unresolved explicit selector', async () => {
    const subject = command({
      'content-type': undefined,
      'api-name': undefined,
      metadata: ['sfdc_cms__email', 'sfdc_cms__email:Welcome', 'sfdc_cms__email:Missing'],
    });
    subject.resolution.unresolved = [
      {
        contentType: 'sfdc_cms__email',
        kind: 'api-name',
        selector: 'Missing',
        reason: 'missing',
        parentIds: [],
      },
      {
        contentType: 'sfdc_cms__email',
        kind: 'api-name',
        selector: 'Ambiguous',
        reason: 'ambiguous',
        parentIds: ['a', 'b'],
      },
    ];
    const result = await subject.instance.run();
    expect(subject.prepareSources.firstCall.args[1].selection.groups[0]).to.include({ all: true });
    expect(result.status).to.equal('partial');
    expect(process.exitCode).to.equal(2);
    expect(result.result!.summary).to.deep.equal({
      selected: 3,
      retrieved: 1,
      unchanged: 0,
      blocked: 2,
      unattempted: 0,
    });
    expect(result.result!.items.slice(0, 2).map((item) => item.identity.selector)).to.deep.equal([
      'Missing',
      'Ambiguous',
    ]);
    expect(result.result!.resolution!.unresolved).to.deep.equal(subject.resolution.unresolved);
    expect(subject.acquire.calledOnce).to.equal(true);
  });

  it('reports missing native selectors honestly without fabricating API names', async () => {
    const subject = command({ 'api-name': undefined, 'content-key-or-id': ['opaque-key'] });
    subject.resolution.variants = [];
    subject.resolution.unresolved = [
      {
        contentType: 'sfdc_cms__email',
        kind: 'content-key-or-id',
        selector: 'opaque-key',
        reason: 'missing',
        parentIds: [],
      },
    ];
    const result = await subject.instance.run();
    expect(result.result!.items[0].identity).to.deep.equal({
      contentType: 'sfdc_cms__email',
      apiName: null,
      language: 'en_US',
      selector: 'opaque-key',
      selectorKind: 'content-key-or-id',
    });
    expect(result.status).to.equal('blocked');
    expect(process.exitCode).to.equal(1);
    expect(subject.acquire.notCalled).to.equal(true);
  });

  it('routes mixed Email/Image results independently and stops after fatal Image reads', async () => {
    for (const fatal of [false, true]) {
      const subject = command({
        'api-name': undefined,
        'content-type': undefined,
        metadata: ['sfdc_cms__email:Welcome', 'sfdc_cms__image:Hero', 'sfdc_cms__document:Later'],
      });
      subject.resolution.variants = [
        row(),
        row('image', 'Hero', 'sfdc_cms__image'),
        row('later', 'Later', 'sfdc_cms__document'),
      ];
      subject.acquire
        .onSecondCall()
        .rejects(Object.assign(new Error('Image unavailable'), { statusCode: fatal ? 401 : 404 }));
      const result = await subject.instance.run();
      expect(result.status).to.equal('partial');
      expect(result.result!.summary).to.include({
        retrieved: fatal ? 1 : 2,
        blocked: 1,
        unattempted: fatal ? 1 : 0,
      });
      expect(result.result!.items[1].identity.contentType).to.equal('sfdc_cms__image');
      expect(result.result!.items[1].diagnostics).to.deep.equal(['RETRIEVE_SOURCE_BLOCKED']);
      expect(subject.writeSource.callCount).to.equal(fatal ? 1 : 2);
    }
  });

  it('blocks Image portable collisions before acquisition while allowing a same-name Email', async () => {
    const subject = command({
      'api-name': undefined,
      'content-type': ['sfdc_cms__image', 'sfdc_cms__email'],
      all: true,
    });
    subject.resolution.variants = [
      row('a', 'Hero', 'sfdc_cms__image'),
      row('b', 'Hero', 'sfdc_cms__image'),
      row('email', 'Hero'),
    ];
    const result = await subject.instance.run();
    expect(result.status).to.equal('partial');
    expect(result.result!.summary).to.include({ retrieved: 1, blocked: 2 });
    expect(subject.acquire.args).to.deep.equal([['email']]);
    expect(subject.writeSource.calledOnce).to.equal(true);
  });

  it('accepts complete empty all-of-type selection with exit zero and scoped proof', async () => {
    const subject = command({
      'api-name': undefined,
      all: true,
      'content-type': ['sfdc_cms__email', 'sfdc_cms__emailTemplate'],
    });
    subject.resolution.variants = [];
    subject.resolution.inventory.recordCount = 0;
    subject.resolution.inventory.contentTypes = ['sfdc_cms__email', 'sfdc_cms__emailTemplate'];
    const result = await subject.instance.run();
    expect(result.status).to.equal('success');
    expect(process.exitCode).to.equal(0);
    expect(result.result!.summary).to.deep.equal({
      selected: 0,
      retrieved: 0,
      unchanged: 0,
      blocked: 0,
      unattempted: 0,
    });
    expect(result.result!.selection.contentTypes).to.deep.equal(
      subject.resolution.inventory.contentTypes,
    );
    expect(subject.writeSource.notCalled).to.equal(true);
  });

  for (const overwrite of [false, true]) {
    for (const unrelated of [false, true]) {
      it(`blocks every distinct parent sharing portable identity before acquisition (overwrite: ${overwrite}, unrelated: ${unrelated})`, async () => {
        const subject = command({ 'api-name': undefined, all: true, overwrite });
        const colliders = [row('first', 'Welcome'), row('second', 'Welcome')];
        // Each parent has exactly one variant; even identical acquired projections
        // cannot make two distinct native parents one portable item.
        subject.resolution.variants = [
          colliders[0],
          ...(unrelated ? [row('other', 'Other')] : []),
          colliders[1],
        ];
        subject.resolution.inventory.recordCount = subject.resolution.variants.length;
        const result = await subject.instance.run();
        expect(result.status).to.equal(unrelated ? 'partial' : 'blocked');
        expect(process.exitCode).to.equal(unrelated ? 2 : 1);
        expect(result.result!.summary).to.deep.equal({
          selected: unrelated ? 3 : 2,
          retrieved: unrelated ? 1 : 0,
          unchanged: 0,
          blocked: 2,
          unattempted: 0,
        });
        expect(result.result!.unattempted).to.deep.equal([]);
        expect(result.result!.items.filter((item) => item.outcome === 'blocked')).to.deep.equal(
          colliders.map((variant) => ({
            identity: {
              contentType: 'sfdc_cms__email',
              apiName: 'Welcome',
              language: 'en_US',
              variantId: variant.Id,
            },
            operation: 'retrieve',
            outcome: 'blocked',
            paths: null,
            evidence: { variantId: variant.Id, contentId: variant.ManagedContentId },
            diagnostics: ['RETRIEVE_PORTABLE_IDENTITY_COLLISION'],
          })),
        );
        expect(subject.acquire.args).to.deep.equal(unrelated ? [['other']] : []);
        expect(subject.writeSource.callCount).to.equal(unrelated ? 1 : 0);
        if (unrelated) expect(subject.writeSource.firstCall.args[3]).to.equal(overwrite);
      });
    }
  }

  it('blocks colliding native parent selectors without blocking same-name distinct types or languages', async () => {
    const subject = command({
      'api-name': undefined,
      'content-key-or-id': [
        'parent-first',
        'parent-second',
        'parent-template',
        'parent-translated',
      ],
    });
    const translated = row('translated', 'Welcome');
    translated.Language = 'fr';
    subject.resolution.variants = [
      row('first'),
      row('second'),
      row('template', 'Welcome', 'sfdc_cms__emailTemplate'),
      translated,
    ];
    const result = await subject.instance.run();
    expect(result.result!.summary).to.deep.equal({
      selected: 4,
      retrieved: 2,
      unchanged: 0,
      blocked: 2,
      unattempted: 0,
    });
    expect(subject.acquire.args).to.deep.equal([['template'], ['translated']]);
  });

  it('materializes a resolved native selector using the real API identity and paths', async () => {
    const subject = command({ 'api-name': undefined, 'content-key-or-id': ['opaque-key'] });
    const result = await subject.instance.run();
    expect(result.status).to.equal('success');
    expect(result.result!.items[0].identity).to.deep.equal({
      contentType: 'sfdc_cms__email',
      apiName: 'Welcome',
      language: 'en_US',
      variantId: 'variant',
    });
    expect(result.result!.items[0].paths).to.deep.equal(receipt);
    expect(
      subject.prepareSources.firstCall.args[1].selection.groups[0].contentKeysOrIds,
    ).to.deep.equal(['opaque-key']);
  });

  it('blocks incomplete pagination proof before any acquisition or local write', async () => {
    const subject = command({ 'api-name': undefined, all: true });
    subject.prepareSources.rejects(
      new TypeError('Native inventory requires explicit empty termination within page cap'),
    );
    const result = await subject.instance.run();
    expect(result.status).to.equal('blocked');
    expect(result.diagnostics.errors[0].code).to.equal('RETRIEVE_RESOLUTION_BLOCKED');
    expect(subject.acquire.notCalled).to.equal(true);
    expect(subject.writeSource.notCalled).to.equal(true);
    expect(result.result!.unattempted).to.deep.equal([
      { contentType: 'sfdc_cms__email', apiName: null, language: 'en_US', selectorKind: 'all' },
    ]);
  });

  it('reports overwrite conflicts as blocked exit one when no item completes', async () => {
    const subject = command();
    subject.writeSource.rejects(new Error('Selected files differ; overwrite required'));
    const result = await subject.instance.run();
    expect(result.status).to.equal('blocked');
    expect(process.exitCode).to.equal(1);
    expect(result.result!.summary).to.deep.equal({
      selected: 1,
      retrieved: 0,
      unchanged: 0,
      blocked: 1,
      unattempted: 0,
    });
    expect(result.result!.items[0].paths).to.equal(null);
    expect(result.result!.items[0].evidence).to.deep.equal(source.evidence);
  });

  for (const stage of ['auth', 'workspace', 'resolution'] as const) {
    it(`blocks ${stage} failure before materialization and retains explicit identities`, async () => {
      const subject = command();
      ({
        auth: subject.getOrgContext,
        workspace: subject.resolveSourceWorkspace,
        resolution: subject.prepareSources,
      })[stage].rejects(new Error('Bearer SECRET unsafe server body'));
      const result = await subject.instance.run();
      expect(result.status).to.equal('blocked');
      expect(process.exitCode).to.equal(1);
      expect(result.result!.summary.unattempted).to.equal(1);
      expect(result.result!.summary.blocked).to.equal(0);
      expect(subject.acquire.notCalled).to.equal(true);
      expect(subject.writeSource.notCalled).to.equal(true);
      expect(JSON.stringify(result)).not.to.include('SECRET');
    });
  }

  for (const stage of ['source', 'write'] as const) {
    it(`continues independent items after ${stage} failure and accounts actual receipts`, async () => {
      const subject = command({ 'api-name': ['Welcome', 'Other', 'Third'] });
      subject.resolution.variants = [row(), row('second', 'Other'), row('third', 'Third')];
      (stage === 'source' ? subject.acquire : subject.writeSource)
        .onFirstCall()
        .rejects(new Error('Bearer SECRET'));
      subject.writeSource
        .onCall(stage === 'source' ? 0 : 1)
        .resolves({ ...receipt, created: [], unchanged: receipt.created });
      const result = await subject.instance.run();
      expect(result.status).to.equal('partial');
      expect(process.exitCode).to.equal(2);
      expect(result.result!.summary).to.deep.equal({
        selected: 3,
        retrieved: 1,
        unchanged: 1,
        blocked: 1,
        unattempted: 0,
      });
      expect(subject.acquire.callCount).to.equal(3);
      expect(result.result!.items[0].diagnostics).to.deep.equal([
        stage === 'source' ? 'RETRIEVE_SOURCE_BLOCKED' : 'RETRIEVE_WRITE_BLOCKED',
      ]);
      expect(result.result!.items[0].paths).to.equal(null);
      expect(JSON.stringify(result)).not.to.include('SECRET');
    });
  }

  for (const completed of [false, true]) {
    it(`stops on fatal auth/scope read errors retaining unattempted native identities (prior success: ${completed})`, async () => {
      const subject = command({ 'api-name': ['Welcome', 'Other', 'Third'] });
      subject.resolution.variants = [row(), row('second', 'Other'), row('third', 'Third')];
      subject.acquire
        .onCall(completed ? 1 : 0)
        .rejects(new CmsRequestError('variant.get', 'Bearer SECRET', 403));
      const result = await subject.instance.run();
      expect(result.status).to.equal(completed ? 'partial' : 'blocked');
      expect(process.exitCode).to.equal(completed ? 2 : 1);
      expect(subject.acquire.callCount).to.equal(completed ? 2 : 1);
      expect(result.result!.summary.unattempted).to.equal(completed ? 1 : 2);
      expect(result.result!.unattempted.at(-1)).to.deep.equal({
        contentType: 'sfdc_cms__email',
        apiName: 'Third',
        language: 'en_US',
        variantId: 'third',
      });
      expect(result.diagnostics.errors[0].code).to.equal('RETRIEVE_SCOPE_BLOCKED');
    });
  }
});
