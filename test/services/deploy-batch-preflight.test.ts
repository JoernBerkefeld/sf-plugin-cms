import { expect } from 'chai';
import DeployContent from '../../src/commands/cms/deploy/content.js';
import { selectDeploySources } from '../../src/services/deploy-source-selection.js';
import type { Connection } from '@salesforce/core';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { preflightDeployBatch } from '../../src/services/deploy-batch-preflight.js';

const workspaceId = '0Zu000000000001AAA';
type Row = Record<string, unknown>;
async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'cms-batch-preflight-'));
  const files: string[] = [];
  const definitions = ['Alpha', 'Beta'].map((apiName) => ({
    contract: 'sf-cms-source-definition',
    contractVersion: '1.0.0',
    identity: {
      family: 'cms',
      type: 'Email',
      apiName,
      context: { workspaceApiName: 'Source' },
    },
    contentType: 'sfdc_cms__email',
    language: 'en_US',
    title: apiName,
    folderPath: [],
    contentBody: { 'sfdc_cms:title': apiName, messagePurpose: 'Transactional', subjectLine: 'Hi' },
    companions: { rawHtml: `${apiName}.cms-email.html` },
  }));
  const save = async (index: number) => writeFile(files[index], JSON.stringify(definitions[index]));
  for (const [index, definition] of definitions.entries()) {
    files.push(path.join(directory, `${definition.identity.apiName}.cms-email.json`));
    await save(index);
    await writeFile(path.join(directory, definition.companions.rawHtml), '<p>Desired</p>');
  }
  const workspace = {
    id: workspaceId,
    apiName: 'Destination',
    defaultLanguage: 'en_US',
    rootFolderId: 'root',
    spaceType: { apiName: 'Marketing' },
  };
  const detail: Row = {
    managedContentId: '20Y000000000001AAA',
    managedContentVariantId: '9Ps000000000001AAA',
    contentKey: 'MCBETA',
    apiName: 'Beta',
    language: 'en_US',
    title: 'Beta',
    contentType: { fullyQualifiedName: 'sfdc_cms__email' },
    contentSpace: { id: workspaceId },
    folder: null,
    isPublished: false,
    status: { status: 'Draft' },
    contentBody: { ...definitions[1].contentBody, rawHtml: '&lt;p&gt;Original&lt;/p&gt;' },
    managedContentVersionId: 'version-before',
  };
  const parent: Row = {
    managedContentId: detail.managedContentId,
    contentSpace: { id: workspaceId },
    contentType: detail.contentType,
    folder: null,
    managedContentVersionId: 'version-before',
  };
  let existing = false;
  let onRead: (() => Promise<void>) | undefined;
  const calls: string[] = [];
  const connection = {
    getApiVersion: () => '67.0',
    request(input: { method: string; url: string }) {
      expect(input.method).to.equal('GET');
      calls.push(input.url);
      const response = (async () => {
        if (onRead) await onRead();
        const url = new URL(input.url, 'https://example.invalid');
        if (url.pathname.endsWith(`/spaces/${workspaceId}`)) return workspace;
        if (url.pathname.endsWith('/query')) {
          const soql = url.searchParams.get('q')!;
          const rows = existing
            ? [
                {
                  Id: detail.managedContentVariantId,
                  ManagedContentId: detail.managedContentId,
                  ContentTypeFullyQualifiedName: 'sfdc_cms__email',
                  Language: 'en_US',
                  IsPublished: false,
                  ManagedContentVariantStatus: 'Draft',
                  IsPrimary: true,
                  Name: 'Beta',
                  UrlName: detail.urlName ?? null,
                  ManagedContentKey: 'MCBETA',
                  ManagedContent: { AuthoredManagedContentSpaceId: workspaceId, ApiName: 'Beta' },
                },
              ]
            : [];
          let records: Row[] = soql.includes('Id >') ? [] : rows;
          if (soql.includes('COUNT(Id)'))
            records = rows.map((row) => ({
              ManagedContentId: row.ManagedContentId,
              siblingCount: 1,
            }));
          return { records, done: true, totalSize: records.length };
        }
        if (url.pathname.endsWith(`/variants/${String(detail.managedContentVariantId)}`))
          return detail;
        if (url.pathname.endsWith(`/${String(detail.managedContentId)}`)) return parent;
        throw new Error('Unexpected request');
      })().then((value) => structuredClone(value));
      return Object.assign(response, { stream: () => new PassThrough() });
    },
  } as unknown as Pick<Connection, 'request' | 'getApiVersion'>;
  const input = { sources: { 'source-dir': [directory] }, workspaceId, language: 'en_US' };
  return {
    input,
    files,
    definitions,
    calls,
    detail,
    parent,
    save,
    existing: () => {
      existing = true;
    },
    onRead: (callback: () => Promise<void>) => {
      onRead = callback;
    },
    run: () => preflightDeployBatch(connection, input),
    connection,
  };
}
async function failure(promise: Promise<unknown>, pattern: RegExp) {
  try {
    await promise;
  } catch (error) {
    expect((error as Error).message).to.match(pattern);
    return;
  }
  throw new Error('Expected rejection');
}

describe('internal whole-selection deploy preflight', () => {
  for (const scenario of [
    'nondefault-language',
    'selected-title',
    'selected-url',
    'existing-title',
    'existing-url',
    'native-title',
    'native-url',
    'update-proof',
  ] as const)
    it(`default command dry-run blocks ${scenario} using real read-only operation preflight`, async () => {
      const f = await fixture();
      if (scenario === 'nondefault-language') {
        f.input.language = 'de';
        for (const [index, definition] of f.definitions.entries()) {
          definition.language = 'de';
          await f.save(index);
        }
      }
      if (scenario === 'selected-title') {
        f.definitions[1].title = 'Alpha';
        f.definitions[1].contentBody['sfdc_cms:title'] = 'Alpha';
        await f.save(1);
      }
      if (scenario === 'selected-url') {
        for (const [index, definition] of f.definitions.entries()) {
          Object.assign(definition, { urlName: 'shared-url' });
          Object.assign(definition.contentBody, { 'sfdc_cms:urlName': 'shared-url' });
          await f.save(index);
        }
      }
      if (
        scenario === 'existing-title' ||
        scenario === 'existing-url' ||
        scenario === 'update-proof'
      ) {
        f.existing();
        if (scenario === 'existing-title') {
          f.definitions[0].title = 'Beta';
          f.definitions[0].contentBody['sfdc_cms:title'] = 'Beta';
          await f.save(0);
        }
        if (scenario === 'existing-url') {
          Object.assign(f.definitions[0], { urlName: 'beta-url' });
          Object.assign(f.definitions[0].contentBody, { 'sfdc_cms:urlName': 'beta-url' });
          f.detail.urlName = 'beta-url';
          await f.save(0);
        }
        if (scenario === 'update-proof') f.parent.managedContentVersionId = 'different';
      }
      if (scenario === 'native-title') {
        f.definitions[0].contentBody['sfdc_cms:title'] = 'Mismatch';
        await f.save(0);
      }
      if (scenario === 'native-url') {
        Object.assign(f.definitions[0], { urlName: 'outer-url' });
        Object.assign(f.definitions[0].contentBody, { 'sfdc_cms:urlName': 'inner-url' });
        await f.save(0);
      }
      const instance = Object.create(DeployContent.prototype) as DeployContent;
      Object.assign(instance, {
        parse: async () => ({
          flags: {
            'target-org': { getUsername: () => 'destination' },
            'api-version': '67.0',
            'workspace-id': workspaceId,
            language: f.input.language,
            'default-language': false,
            'source-dir': f.input.sources['source-dir'],
            apply: false,
          },
        }),
        getOrgContext: async () => ({ connection: f.connection, orgId: '00D000000000001AAA' }),
        resolveDestinationWorkspace: async () => ({
          id: workspaceId,
          workspace: { defaultLanguage: 'en_US' },
        }),
        selectSources: selectDeploySources,
        preflightBatch: preflightDeployBatch,
        jsonEnabled: () => true,
      });
      try {
        const envelope = await instance.run();
        expect(envelope.status).to.equal('blocked');
        expect(process.exitCode).to.equal(1);
        expect(envelope.result!.summary.completed).to.equal(0);
        expect(envelope.result!.reportFile).to.equal(null);
        expect(envelope.result!.mutationEnabled).to.equal(false);
        expect(envelope.result!.items.some((item) => item.outcome === 'blocked')).to.equal(true);
      } finally {
        process.exitCode = undefined;
      }
    });
  it('preflights multiple CREATE operations without mutation authority or writes', async () => {
    const f = await fixture();
    const result = await f.run();
    expect(result).to.include({ eligible: true, qualification: 'unqualified' });
    expect(result.items.map((item) => item.proposed)).to.deep.equal(['create', 'create']);
    expect(result.items.every((item) => item.create?.qualification === 'unqualified')).to.equal(
      true,
    );
  });
  it('acquires full UPDATE proof for a later item, not only its proposal', async () => {
    const f = await fixture();
    f.existing();
    const result = await f.run();
    expect(result.eligible).to.equal(true);
    expect(result.items[1].update?.target.variantId).to.equal('9Ps000000000001AAA');
    expect(result.items[1].proposed).to.equal('update');
  });
  it('rejects a later missing companion before destination reads', async () => {
    const f = await fixture();
    f.definitions[1].companions.rawHtml = 'missing.html';
    await f.save(1);
    await failure(f.run(), /ENOENT|companion/u);
    expect(f.calls).to.have.length(0);
  });
  it('blocks all eligibility for later unsupported CREATE fields', async () => {
    const f = await fixture();
    Object.assign(f.definitions[1].contentBody, { unsupported: 'keep' });
    await f.save(1);
    await failure(f.run(), /Unsupported native body field/u);
    expect(f.calls).to.have.length(0);
  });
  it('runs CREATE-specific eligibility for every later proposal', async () => {
    const f = await fixture();
    Object.assign(f.definitions[1], { urlName: 'NOT-PORTABLE' });
    await f.save(1);
    const result = await f.run();
    expect(result.eligible).to.equal(false);
    expect(result.items[0].create).not.to.equal(undefined);
    expect(result.items[1].proposed).to.equal('create');
    expect(result.items[1].blockedReasons.join(',')).to.include('lowercase');
  });
  it('redacts operation acquisition errors and never promotes eligibility', async () => {
    const f = await fixture();
    f.onRead(async () => {
      throw new Error('Authorization: Bearer secret-token');
    });
    const result = await f.run();
    expect(result.eligible).to.equal(false);
    expect(JSON.stringify(result)).not.to.include('secret-token');
  });
  it('blocks collisions between selected new titles before any write', async () => {
    const f = await fixture();
    f.definitions[1].title = 'Alpha';
    f.definitions[1].contentBody['sfdc_cms:title'] = 'Alpha';
    await f.save(1);
    const result = await f.run();
    expect(result.eligible).to.equal(false);
    expect(result.items[1].blockedReasons.join(',')).to.include('title/URL collision');
  });
  it('blocks later UPDATE parent proof failure even when preparation proposes update', async () => {
    const f = await fixture();
    f.existing();
    f.parent.managedContentVersionId = 'different';
    const result = await f.run();
    expect(result.eligible).to.equal(false);
    expect(result.items[1].blockedReasons.join(',')).to.match(
      /version disagreement|snapshot drifted/u,
    );
  });
  it('admits unchanged through the same read-only UPDATE proof', async () => {
    const f = await fixture();
    f.existing();
    f.detail.contentBody = {
      ...f.definitions[1].contentBody,
      rawHtml: '&lt;p&gt;Desired&lt;/p&gt;',
    };
    const result = await f.run();
    expect(result.eligible).to.equal(true);
    expect(result.items[1].proposed).to.equal('unchanged');
  });
  it('rejects changed expected selection before any additional destination read', async () => {
    const f = await fixture();
    const first = await f.run();
    await writeFile(
      path.join(path.dirname(f.files[0]), f.definitions[0].companions.rawHtml),
      'Changed',
    );
    const count = f.calls.length;
    await failure(
      preflightDeployBatch(f.connection, { ...f.input, expectedSelection: first.selection }),
      /since planning/u,
    );
    expect(f.calls).to.have.length(count);
  });
  it('detects whole-directory additions during destination reads', async () => {
    const f = await fixture();
    f.onRead(async () => {
      const added = structuredClone(f.definitions[0]);
      added.identity.apiName = 'Gamma';
      added.companions.rawHtml = 'Gamma.cms-email.html';
      await writeFile(
        path.join(path.dirname(f.files[0]), added.companions.rawHtml),
        '<p>Added</p>',
      );
      await writeFile(
        path.join(path.dirname(f.files[0]), 'Gamma.cms-email.json'),
        JSON.stringify(added),
      );
    });
    const result = await f.run();
    expect(result.eligible).to.equal(false);
    expect(result.blockedReasons.join(',')).to.include('selection drifted');
  });
});
