import { expect } from 'chai';
import { readFile } from 'node:fs/promises';
import { PassThrough } from 'node:stream';
import sinon from 'sinon';
import { prepareEditableSourceSelection } from '../../src/services/retrieve-item-source.js';
import type { LifecycleContentType } from '../../src/contracts/content-lifecycle-batch.js';

type RecordValue = Record<string, unknown>;
type Phase = {
  workspace: { id: string; apiName: string };
  rows: Array<RecordValue & { Id: string; ManagedContentId: string }>;
  parent: RecordValue;
  variant: RecordValue & { apiName: string; isPublished: boolean };
  headers: Array<{
    url: string;
    status: number;
    contentType: string;
    contentLength: string;
    location: string | null;
  }>;
  base64: string | null;
};
const recorded = JSON.parse(
  await readFile(new URL('../fixtures/lifecycle-retrieval.json', import.meta.url), 'utf8'),
) as { cells: Array<{ side: string; family: string; phases: Record<string, Phase> }> };

// Selected native observations, not a fabricated lifecycle adapter or full-org inventory.
// Both transports fail closed on unexpected requests; no live connection is available.
describe('recorded public lifecycle retrieval equivalence', () => {
  afterEach(() => sinon.restore());
  for (const cell of recorded.cells)
    for (const operation of ['publish', 'unpublish'])
      it(`${cell.side} ${cell.family} preserves every public output across ${operation}`, async () => {
        let phase = cell.phases[`${operation}-baseline`];
        let download = 0;
        const fetcher = sinon.stub(globalThis, 'fetch').callsFake(async (input) => {
          const observed = phase.headers[download++];
          expect(observed, 'unexpected binary request').not.to.equal(undefined);
          expect(String(input)).to.equal(observed.url);
          const headers: Record<string, string> = {
            'content-type': observed.contentType,
            'content-length': observed.contentLength,
          };
          if (observed.location) headers.location = observed.location;
          return new Response(
            observed.status === 200 ? Buffer.from(phase.base64!, 'base64') : null,
            { status: observed.status, headers },
          );
        });
        const request = sinon.stub().callsFake((input: { url: string; method: string }) => {
          expect(input.method).to.equal('GET');
          const url = new URL(input.url, 'https://replay.my.salesforce.com');
          let result: unknown;
          switch (url.pathname) {
            case `/connect/cms/spaces/${phase.workspace.id}`: {
              result = phase.workspace;
              break;
            }
            case '/services/data/v67.0/query': {
              const q = url.searchParams.get('q')!;
              expect(q).to.include(`'${phase.workspace.id}'`);
              const after = /Id > '([^']+)'/u.exec(q)?.[1];
              const rows = phase.rows.filter((row) => !after || row.Id > after);
              const records = q.includes('COUNT(Id)')
                ? [{ ManagedContentId: phase.rows[0].ManagedContentId, siblingCount: rows.length }]
                : rows;
              result = { totalSize: records.length, done: true, records };

              break;
            }
            case `/connect/cms/contents/variants/${phase.rows[0].Id}`: {
              result = phase.variant;
              break;
            }
            case `/connect/cms/contents/${phase.rows[0].ManagedContentId}`: {
              result = phase.parent;
              break;
            }
            default: {
              throw new Error(`Unexpected offline request: ${url.pathname}`);
            }
          }
          return Object.assign(Promise.resolve(structuredClone(result)), {
            stream: () => new PassThrough(),
          });
        });
        const connection = {
          request,
          getApiVersion: () => '67.0',
          instanceUrl: 'https://replay.my.salesforce.com',
          accessToken: 'synthetic-offline-token',
        };
        const acquire = async () => {
          download = 0;
          const prepared = await prepareEditableSourceSelection(connection, {
            workspaceId: phase.workspace.id,
            language: 'en_US',
            selection: {
              mode: 'api-name',
              groups: [
                {
                  contentType: `sfdc_cms__${cell.family}` as LifecycleContentType,
                  all: false,
                  apiNames: [phase.variant.apiName],
                  contentKeysOrIds: [],
                },
              ],
            },
          });
          const output = await prepared.acquire(phase.rows[0].Id);
          expect(download).to.equal(phase.headers.length);
          if (phase.base64)
            expect(output.projection.companions[0].bytes).to.deep.equal(
              Buffer.from(phase.base64, 'base64'),
            );
          return output;
        };
        const before = await acquire();
        const beforePublished = phase.variant.isPublished;
        phase = cell.phases[`${operation}-readback-0`];
        expect(phase.variant.isPublished).to.equal(!beforePublished);
        expect(phase.rows[0].IsPrimary).to.equal(true);
        const after = await acquire();
        expect(after).to.deep.equal(before);
        expect(after.projection.definitionBytes).to.deep.equal(before.projection.definitionBytes);
        expect(after.projection.companions).to.deep.equal(before.projection.companions);
        expect(fetcher.callCount).to.equal(cell.family === 'email' ? 0 : 4);
      });
});
