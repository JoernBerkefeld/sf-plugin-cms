import { Parser } from '@oclif/core';
import { TestContext } from '@salesforce/core/testSetup';
import { expect } from 'chai';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createRunOwnedDirectory, createRunOwnedTemp } from '../../src/filesystem/runOwnedTemp.js';
import PublishContent from '../../src/commands/cms/publish/content.js';

describe('cms publish content command', () => {
  const context = new TestContext();
  beforeEach(() => {
    process.exitCode = undefined;
  });
  afterEach(() => {
    context.restore();
    process.exitCode = undefined;
  });

  it('parses repeated short/long metadata flags without a fixed contract default', async () => {
    const { 'target-org': targetOrg, ...flags } = PublishContent.flags;
    expect(targetOrg.required).to.equal(true);
    const parsed = await Parser.parse(
      ['--workspace-id', 'space', '-m', 'email:A', '--metadata', 'image:B', '--language', 'en_US'],
      { flags },
    );
    expect(parsed.flags.metadata).to.deep.equal(['email:A', 'image:B']);
    expect(parsed.flags['contract-version']).to.equal(undefined);
    expect(PublishContent.aliases).to.deep.equal(['content:publish']);
    try {
      await Parser.parse(['--workspace-id', 'space', '-m', 'email:A', '--api-name', 'A'], {
        flags,
      });
      expect.fail('Expected exclusive selector rejection');
    } catch (error) {
      expect((error as Error).message).to.include('--metadata');
    }
  });

  for (const { useDefaultLanguage, rootFlag, legacy } of [
    { useDefaultLanguage: false },
    { useDefaultLanguage: true },
    ...(['cwd', '-d', '--output-dir'] as const).flatMap((rootFlag) =>
      [false, true].map((legacy) => ({ useDefaultLanguage: false, rootFlag, legacy })),
    ),
  ] as Array<{ useDefaultLanguage: boolean; rootFlag?: string; legacy?: boolean }>) {
    it(`returns ready Email and forwards parsed root=${rootFlag ?? 'default'} legacy=${String(legacy)} default-language=${String(useDefaultLanguage)}`, async () => {
      let localDefinition: string | undefined;
      let parsedFlags = {};
      if (rootFlag !== undefined) {
        const run = await createRunOwnedTemp('cms-publish-root-');
        const cwd = await createRunOwnedDirectory(run, 'cwd');
        const selected = await createRunOwnedDirectory(run, 'selected');
        context.SANDBOX.stub(process, 'cwd').returns(cwd);
        const { 'target-org': targetOrg, ...flags } = PublishContent.flags;
        expect(targetOrg.required).to.equal(true);
        const parsed = await Parser.parse(
          [
            '--workspace-id',
            'space',
            ...(legacy ? ['--api-name', 'A'] : ['-m', 'email:A']),
            '--language',
            'en_US',
            ...(rootFlag === 'cwd' ? [] : [rootFlag, '../selected']),
          ],
          { flags },
        );
        expect(parsed.flags['output-dir']).to.equal(rootFlag === 'cwd' ? undefined : '../selected');
        parsedFlags = parsed.flags;
        localDefinition = path.join(
          rootFlag === 'cwd' ? cwd : selected,
          'cms',
          'Marketing',
          'email',
          'A.cms-email.json',
        );
      }
      const variant = {
        managedContentVariantId: 'variant-a',
        managedContentId: 'parent-a',
        apiName: 'A',
        language: 'en_US',
        title: 'A',
        urlName: 'a',
        contentType: { fullyQualifiedName: 'sfdc_cms__email' },
        contentSpace: { id: 'space' },
        isPublished: false,
        status: { status: 'Draft' },
        contentBody: { rawHtml: 'A' },
      };
      const request = context.SANDBOX.stub().callsFake(({ url }: { url: string }) => {
        if (url === '/connect/cms/spaces/space')
          return Promise.resolve({ id: 'space', apiName: 'Marketing', defaultLanguage: 'en_US' });
        if (url.startsWith('/connect/cms/items/search'))
          return Promise.resolve({
            total: 1,
            items: [
              {
                id: 'variant-a',
                managedContentSpaceId: 'space',
                type: 'ManagedContentVariantSearchResultRepresentation',
              },
            ],
          });
        if (url.includes('/connect/cms/contents/variants/')) return Promise.resolve(variant);
        if (url === '/connect/cms/contents/parent-a')
          return Promise.resolve({
            managedContentId: 'parent-a',
            contentType: { fullyQualifiedName: 'sfdc_cms__email' },
            contentSpace: { id: 'space' },
          });
        throw new Error(`Unexpected request ${url}`);
      });
      const command = Object.create(PublishContent.prototype) as PublishContent;
      Object.assign(command, {
        parse: context.SANDBOX.stub().resolves({
          flags: {
            'target-org': { getUsername: () => 'org' },
            'api-version': '67.0',
            'workspace-id': 'space',
            ...(legacy ? { 'api-name': 'A' } : { metadata: ['email:A'] }),
            ...(useDefaultLanguage ? { 'default-language': true } : { language: 'en_US' }),
            ...parsedFlags,
          },
        }),
        getOrgContext: context.SANDBOX.stub().resolves({
          connection: { request, version: '67.0', instanceUrl: 'https://example.invalid' },
          orgId: 'org',
        }),
        jsonEnabled: () => true,
      });
      const result = await command.run();
      expect(result.status).to.equal('success');
      expect(result.contractVersion).to.equal(legacy ? '1.0.0' : '2.0.0');
      if (!result.result) throw new Error('Expected result');
      if ('selection' in result.result) {
        expect(result.result.items[0].target?.language).to.equal('en_US');
        expect(result.result.items[0].outcome).to.equal('ready');
      } else {
        expect(result.result.target.language).to.equal('en_US');
        expect(result.result.outcome).to.equal('ready');
      }
      expect(process.exitCode).to.equal(0);
      if (localDefinition !== undefined) {
        await mkdir(path.dirname(localDefinition), { recursive: true });
        await writeFile(localDefinition, '{');
        const blocked = await command.run();
        expect(blocked.status).to.equal('blocked');
        expect(blocked.result?.outcome).to.equal('blocked');
        expect(process.exitCode).to.equal(1);
        expect(await readFile(localDefinition, 'utf8')).to.equal('{');
        expect(
          request.getCalls().every(({ args }) => !args[0].method || args[0].method === 'GET'),
        ).to.equal(true);
      }
    });
  }

  for (const [name, selection, version, code] of [
    ['missing selection', {}, undefined, 'LIFECYCLE_SELECTOR_REQUIRED'],
    [
      'exclusive selection',
      { metadata: ['email:A'], 'api-name': 'A' },
      undefined,
      'LIFECYCLE_SELECTOR_REQUIRED',
    ],
    ['type-only selection', { metadata: ['email'] }, undefined, 'LIFECYCLE_SELECTOR_REQUIRED'],
    ['empty selection', { metadata: [] }, undefined, 'LIFECYCLE_SELECTOR_REQUIRED'],
    ['legacy wildcard', { 'api-name': 'Welcome*' }, undefined, 'LIFECYCLE_SELECTOR_REQUIRED'],
    [
      'wildcard selection',
      { metadata: ['emailFragment:Prefix*'] },
      undefined,
      'LIFECYCLE_SELECTOR_REQUIRED',
    ],
    ['legacy version mismatch', { 'api-name': 'A' }, 2, 'UNSUPPORTED_CONTRACT_VERSION'],
    [
      'metadata version mismatch',
      { metadata: ['email:A', 'email:B'] },
      1,
      'UNSUPPORTED_CONTRACT_VERSION',
    ],
    [
      'metadata missing language',
      { metadata: ['email:A'], language: undefined },
      undefined,
      'LANGUAGE_SELECTOR_REQUIRED',
    ],
    [
      'metadata missing report',
      { metadata: ['email:A'], apply: true },
      undefined,
      'REPORT_DIRECTORY_REQUIRED',
    ],
    [
      'metadata missing acknowledgement',
      { metadata: ['email:A'], apply: true, 'report-dir': 'report' },
      undefined,
      'NO_SEND_ACKNOWLEDGEMENT_REQUIRED',
    ],
  ] as const) {
    it(`blocks ${name} before org access`, async () => {
      const command = Object.create(PublishContent.prototype) as PublishContent;
      const getOrgContext = context.SANDBOX.stub();
      Object.assign(command, {
        parse: context.SANDBOX.stub().resolves({
          flags: {
            'target-org': { getUsername: () => 'org' },
            'api-version': '67.0',
            'workspace-id': 'space',
            language: 'en_US',
            'contract-version': version,
            ...selection,
          },
        }),
        getOrgContext,
        jsonEnabled: () => true,
      });
      const result = await command.run();
      expect(result.status).to.equal('blocked');
      expect(result.diagnostics.errors[0].code).to.equal(code);
      expect(getOrgContext.notCalled).to.equal(true);
      if (result.result && 'selection' in result.result) {
        expect(result.contractVersion).to.equal('2.0.0');
        expect(result.result.items[0].outcome).to.equal('blocked');
        expect(
          result.result.items.slice(1).every((item) => item.outcome === 'unattempted'),
        ).to.equal(true);
      }
    });
  }

  for (const version of [undefined, 2]) {
    it(`routes ordered metadata to v2 with version ${String(version)} and blocks failed native preflight`, async () => {
      const command = Object.create(PublishContent.prototype) as PublishContent;
      const request = context.SANDBOX.stub().rejects(
        new Error('Native workspace preflight failed'),
      );
      Object.assign(command, {
        parse: context.SANDBOX.stub().resolves({
          flags: {
            'target-org': { getUsername: () => 'org' },
            'api-version': '67.0',
            'workspace-id': 'space',
            'default-language': true,
            'contract-version': version,
            metadata: ['image:A', 'sfdc_cms__audio:B'],
          },
        }),
        getOrgContext: context.SANDBOX.stub().resolves({ connection: { request }, orgId: 'org' }),
        jsonEnabled: () => true,
      });
      const result = await command.run();
      expect(result.contractVersion).to.equal('2.0.0');
      expect(result.status).to.equal('blocked');
      if (!result.result || !('selection' in result.result)) throw new Error('Expected batch');
      expect(result.result.operation).to.equal('publish');
      expect(result.result.items.map((item) => item.selector.apiName)).to.deep.equal(['A', 'B']);
      expect(result.result.items.map((item) => item.outcome)).to.deep.equal([
        'blocked',
        'unattempted',
      ]);
      expect(request.callCount).to.equal(2);
      expect(result.result.items[0].blockers[0].message).to.include(
        'Native workspace preflight failed',
      );
      expect(process.exitCode).to.equal(1);
    });
  }

  it('blocks apply without the no-send acknowledgement before org access', async () => {
    const command = Object.create(PublishContent.prototype) as PublishContent;
    const getOrgContext = context.SANDBOX.stub();
    Object.assign(command, {
      parse: context.SANDBOX.stub().resolves({
        flags: {
          'target-org': { getUsername: () => 'org' },
          'api-version': '67.0',
          'contract-version': 1,
          'workspace-id': 'space',
          'api-name': 'Email',
          language: 'en_US',
          'default-language': false,
          apply: true,
          'report-dir': 'report',
          'acknowledge-no-send': false,
        },
      }),
      getOrgContext,
      jsonEnabled: context.SANDBOX.stub().returns(true),
    });
    const result = await command.run();
    expect(result.status).to.equal('blocked');
    expect(result.diagnostics.errors[0].code).to.equal('NO_SEND_ACKNOWLEDGEMENT_REQUIRED');
    expect(getOrgContext.notCalled).to.equal(true);
  });

  it('blocks apply without a report directory before org access', async () => {
    const command = Object.create(PublishContent.prototype) as PublishContent;
    const getOrgContext = context.SANDBOX.stub();
    Object.assign(command, {
      parse: context.SANDBOX.stub().resolves({
        flags: {
          'target-org': { getUsername: () => 'org' },
          'api-version': '67.0',
          'contract-version': 1,
          'workspace-id': 'space',
          'api-name': 'Email',
          language: 'en_US',
          'default-language': false,
          apply: true,
          'acknowledge-no-send': true,
        },
      }),
      getOrgContext,
      jsonEnabled: context.SANDBOX.stub().returns(true),
    });
    const result = await command.run();
    expect(result.status).to.equal('blocked');
    expect(result.diagnostics.errors[0].code).to.equal('REPORT_DIRECTORY_REQUIRED');
    expect(getOrgContext.notCalled).to.equal(true);
  });
});
