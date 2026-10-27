import { expect } from 'chai';
import sinon from 'sinon';
import { readFile, writeFile } from 'node:fs/promises';
import { executeEmailFragmentUpdate } from '../../src/services/deploy-email-fragment-update.js';
import type { WorkspaceImportRunReport } from '../../src/services/import-workspace.js';
import {
  fixture,
  failure,
  contentId,
  variantId,
  workspaceId,
  type RecordValue,
} from './deploy-email-fragment-update-preflight.test.js';

const writes = (current: Awaited<ReturnType<typeof fixture>>) =>
  current.calls.filter((call) => call.method !== 'GET');
async function execution() {
  const current = await fixture();
  let report: WorkspaceImportRunReport | undefined;
  const controller = new AbortController();
  return {
    ...current,
    controller,
    get report() {
      return report!;
    },
    run: (persist = true, persistence?: Parameters<typeof executeEmailFragmentUpdate>[3]) =>
      executeEmailFragmentUpdate(
        current.connection,
        {
          definitionFile: current.file,
          workspaceId,
          ...(persist ? { reportFile: current.reportFile } : {}),
        },
        { signal: controller.signal },
        persistence,
        (value) => {
          report = value;
        },
      ),
  };
}
describe('internal Fragment UPDATE executor and unchanged', () => {
  afterEach(() => sinon.restore());
  it('updates full body once without retries, proves same IDs independently and repeats unchanged without journal writes', async () => {
    const current = await execution();
    const sourceBytes = await readFile(current.file, 'utf8');
    const result = await current.run();
    expect(await readFile(current.file, 'utf8')).to.equal(sourceBytes);
    expect(current.definition.title).to.equal('Envelope');
    expect(current.detail.title).to.equal('Edited body title');
    expect(result.outcome).to.equal('updated');
    expect(result.qualification).to.equal('unqualified');
    expect(result.evidence).to.deep.equal({ contentId, variantId });
    expect(writes(current)).to.have.length(1);
    expect(JSON.parse(writes(current)[0].body!).contentBody).to.deep.equal(
      current.definition.contentBody,
    );
    expect(current.report.operations[0]).to.include({
      operationKind: 'update-variant',
      state: 'succeeded',
    });
    expect(current.report.operations[0].target).to.deep.equal({ contentId, variantId });
    expect(current.report.operations[0].baselineSha256).to.match(/^[a-f0-9]{64}$/u);
    expect(current.report.createdParents).to.deep.equal([]);
    const journal = await readFile(current.reportFile, 'utf8');
    expect(JSON.parse(journal)).to.deep.equal(current.report);
    const mutationIndex = current.calls.findIndex((call) => call.method === 'PUT');
    expect(
      current.calls
        .slice(mutationIndex + 1)
        .some((call) => call.url.includes(`/contents/${contentId}`)),
    ).to.equal(true);
    expect(
      current.calls
        .slice(mutationIndex + 1)
        .some((call) => call.url.includes(`/variants/${variantId}`)),
    ).to.equal(true);
    await writeFile(current.reportFile, 'untouched non-JSON journal');
    const repeat = await current.run();
    expect(repeat.outcome).to.equal('unchanged');
    expect(repeat.report).to.equal(undefined);
    expect(await readFile(current.reportFile, 'utf8')).to.equal('untouched non-JSON journal');
    expect(writes(current)).to.have.length(1);
  });
  it('updates envelope title/URL and structural IDs without replacing destination native IDs', async () => {
    const current = await execution();
    current.definition.title = 'Edited envelope';
    current.definition.urlName = 'edited-envelope';
    (current.definition.contentBody['sfdc_cms:block'] as RecordValue).id =
      '10000000-0000-4000-8000-000000000099';
    current.definition.contentBody['sfdc_cms:title'] = 'Edited envelope';
    await current.save();
    const result = await current.run(false);
    expect(result.evidence).to.deep.equal({ contentId, variantId });
    expect(current.detail.contentBody).to.deep.equal(current.definition.contentBody);
    expect(current.detail.title).to.equal('Edited envelope');
    expect(current.detail.urlName).to.equal('edited-envelope');
  });
  it('returns zero-write unchanged even with an existing non-JSON journal', async () => {
    const current = await execution();
    current.detail.contentBody = structuredClone(current.definition.contentBody);
    await writeFile(current.reportFile, 'untouched');
    const result = await current.run();
    expect(result.outcome).to.equal('unchanged');
    expect(writes(current)).to.have.length(0);
    expect(await readFile(current.reportFile, 'utf8')).to.equal('untouched');
  });
  it('rejects unsupported boundary edits before intent and preserves exact boundary unchanged with a non-JSON journal', async () => {
    const current = await execution();
    current.definition.contentBody['sfdc_cms:title'] = 'Envelope ';
    await current.save();
    await writeFile(current.reportFile, 'untouched');
    await failure(current.run(), /Unsupported derived envelope/u);
    expect(current.report).to.equal(undefined);
    expect(await readFile(current.reportFile, 'utf8')).to.equal('untouched');
    expect(writes(current)).to.have.length(0);
    current.detail.contentBody = structuredClone(current.definition.contentBody);
    const unchanged = await current.run();
    expect(unchanged.outcome).to.equal('unchanged');
    expect(await readFile(current.reportFile, 'utf8')).to.equal('untouched');
    expect(writes(current)).to.have.length(0);
  });
  it('revalidates exact raw baseline, source, providers and connection after pending intent', async () => {
    for (const change of [
      'source',
      'provider',
      'root',
      'org',
      'api',
      'siblings',
      'baseline',
      'published',
      'cancel',
    ]) {
      const current = await execution();
      await failure(
        current.run(true, {
          rewrite: async (file, report) => {
            await writeFile(file, JSON.stringify(report));
            if (report.operations[0].state !== 'pending') return;
            if (change === 'source') {
              current.definition.title = 'Concurrent edit';
              await current.save();
            }
            if (change === 'provider') current.graph.status = 'Building';
            if (change === 'root') current.workspace.rootFolderId = '9Pu000000000002AAA';
            if (change === 'org') current.org('00D000000000002AAA');
            if (change === 'api') current.api('66.0');
            if (change === 'siblings')
              current.rows.push({
                ...current.rows[0],
                Id: '9Ps000000000002AAA',
                Language: 'de',
                IsPrimary: false,
              });
            if (change === 'baseline') {
              current.detail.lastModifiedDate = '2026-10-27T00:00:00Z';
              current.parent.lastModifiedDate = current.detail.lastModifiedDate;
            }
            if (change === 'published') current.rows[0].IsPublished = true;
            if (change === 'cancel') current.controller.abort();
          },
        }),
        /prerequisite|changed|drifted|Unexpected|exactly one default|unpublished|abort|cancel/u,
      );
      expect(writes(current)).to.have.length(0);
      expect(current.report.state).to.equal('failed');
    }
  });
  it('blocks changed durable intent, persistence failure and pre-existing journals before mutation', async () => {
    for (const change of ['intent', 'disk', 'existing']) {
      const current = await execution();
      if (change === 'existing') await writeFile(current.reportFile, 'preserved');
      await failure(
        current.run(true, {
          rewrite: async (file) => {
            if (change === 'disk') throw new Error('disk unavailable');
            await writeFile(file, '{}');
          },
        }),
        /durable intent|disk unavailable|exist/u,
      );
      expect(writes(current)).to.have.length(0);
    }
  });
  it('never accepts mutation echo as proof and retains precise uncertain target on readback drift', async () => {
    for (const change of [
      'body',
      'envelope',
      'stale-envelope',
      'id',
      'parent',
      'siblings',
      'published',
      'root',
      'locale',
      'source',
      'provider',
      'key',
      'response',
    ]) {
      const current = await execution();
      current.onRequest(async (method) => {
        if (method !== 'PUT') return;
        if (change === 'body')
          (current.detail.contentBody as RecordValue)['sfdc_cms:title'] = 'server changed';
        if (change === 'envelope' || change === 'stale-envelope') {
          const title = change === 'envelope' ? 'Unexpected C' : current.definition.title;
          current.detail.title = title;
          current.parent.title = title;
          current.rows[0].Name = title;
        }
        if (change === 'id') current.detail.managedContentVariantId = '9Ps000000000002AAA';
        if (change === 'parent') current.parent.managedContentId = '20Y000000000002AAA';
        if (change === 'siblings')
          current.rows.push({
            ...current.rows[0],
            Id: '9Ps000000000002AAA',
            Language: 'de',
            IsPrimary: false,
          });
        if (change === 'published') current.rows[0].IsPublished = true;
        if (change === 'root') current.workspace.rootFolderId = '9Pu000000000002AAA';
        if (change === 'locale') current.workspace.defaultLanguage = 'de';
        if (change === 'source') {
          current.definition.title = 'Concurrent';
          await current.save();
        }
        if (change === 'provider') current.graph.status = 'Building';
        if (change === 'key') {
          current.detail.contentKey = 'OTHER';
          current.parent.contentKey = 'OTHER';
          current.rows[0].ManagedContentKey = 'OTHER';
        }
        if (change === 'response') current.response.managedContentVariantId = 'bad';
      });
      await failure(
        current.run(),
        /readback|identity|Unsupported|unpublished|disagreement|default language|prerequisite|exactly one default/u,
      );
      expect(writes(current)).to.have.length(1);
      expect(current.report.state).to.equal('ownership-uncertain');
      expect(current.report.operations[0].state).to.equal('pending');
      expect(current.report.operations[0].target).to.deep.equal({ contentId, variantId });
      expect(current.report.operations[0].result?.contentId).to.equal(contentId);
    }
  });
  it('rejects journal tampering during final prerequisite reads before dispatch', async () => {
    const current = await execution();
    let graphs = 0;
    current.onRequest(async (_method, url) => {
      if (url.includes('/ssot/') && ++graphs === 4) await writeFile(current.reportFile, '{}');
    });
    await failure(current.run(), /durable intent changed at mutation boundary/u);
    expect(writes(current)).to.have.length(0);
    expect(current.report.state).to.equal('failed');
  });
  it('retains pending intent on uncertain transport without retry or replay', async () => {
    const current = await execution();
    current.failMutation(new Error('connection reset'));
    await failure(current.run(), /connection reset/u);
    expect(writes(current)).to.have.length(1);
    expect(current.report.operations[0].result).to.equal(undefined);
    expect(current.report.operations[0].target).to.deep.equal({ contentId, variantId });
    expect(current.report.state).to.equal('ownership-uncertain');
    (current.detail.contentBody as RecordValue)['sfdc_cms:title'] = 'still different';
    await failure(current.run(), /exist/u);
    expect(writes(current)).to.have.length(1);
  });
  it('journals returned native IDs before malformed response validation and never replays', async () => {
    const current = await execution();
    delete current.response.contentBody;
    await failure(current.run(), /response shape/u);
    expect(current.report.operations[0].result).to.deep.equal({ contentId, variantId });
    expect(current.report.state).to.equal('ownership-uncertain');
    expect(writes(current)).to.have.length(1);
  });
  it('retains uncertain state for result or completion persistence failure after one UPDATE', async () => {
    for (const failAt of [2, 3]) {
      const current = await execution();
      let count = 0;
      await failure(
        current.run(true, {
          rewrite: async (file, report) => {
            if (++count >= failAt) throw new Error('disk unavailable');
            await writeFile(file, JSON.stringify(report));
          },
        }),
        /may have succeeded|disk unavailable/u,
      );
      expect(writes(current)).to.have.length(1);
      expect(current.report.state).to.equal('ownership-uncertain');
      expect(current.report.operations[0].state).to.equal('pending');
      expect(current.report.operations[0].result).to.deep.equal({ contentId, variantId });
    }
  });
});
