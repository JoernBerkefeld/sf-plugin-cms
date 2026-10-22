import { Connection as JsforceConnection } from '@jsforce/jsforce-node';
import { expect } from 'chai';
import path from 'node:path';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { PassThrough } from 'node:stream';
import sinon from 'sinon';
import { createRunOwnedTemp, createRunOwnedDirectory } from '../../src/filesystem/runOwnedTemp.js';
import {
  applyDraftEmailPublishWithReport,
  previewDraftEmailPublish,
} from '../../src/services/email-publish.js';
import {
  applyPublishedEmailUnpublishWithReport,
  previewPublishedEmailUnpublish,
} from '../../src/services/email-unpublish.js';
import { rewriteAtomic } from '../../src/services/import-workspace.js';

function response(value: unknown) {
  return Object.assign(Promise.resolve(structuredClone(value)), {
    stream: () => new PassThrough(),
  });
}

async function setup(operation: 'publish' | 'unpublish', copy = true) {
  const run = await createRunOwnedTemp('cms-legacy-local-');
  const root = await createRunOwnedDirectory(run, 'fixture');
  const directory = path.join(root, 'cms', 'Marketing', 'email');
  const file = path.join(directory, 'pilot.cms-email.json');
  const html = path.join(directory, 'pilot.cms-email.html');
  if (copy) {
    await mkdir(directory, { recursive: true });
    await writeFile(
      file,
      JSON.stringify({
        contract: 'sf-cms-source-definition',
        contractVersion: '1.0.0',
        identity: {
          family: 'cms',
          type: 'Email',
          apiName: 'pilot',
          context: { workspaceApiName: 'Marketing' },
        },
        contentType: 'sfdc_cms__email',
        language: 'en_US',
        folderPath: [],
        contentBody: {
          'sfdc_cms:title': 'Authored',
          messagePurpose: 'Transactional',
          subjectLine: 'Authored',
          textContent: 'Authored',
        },
        companions: { rawHtml: 'pilot.cms-email.html' },
      }),
    );
    await writeFile(html, '<p>Authored unchanged</p>');
  }
  const variant = {
    managedContentVariantId: 'variant',
    managedContentId: 'parent',
    apiName: 'pilot',
    language: 'en_US',
    title: 'Remote',
    urlName: 'remote',
    contentType: { fullyQualifiedName: 'sfdc_cms__email' },
    contentSpace: { id: 'space' },
    isPublished: operation === 'unpublish',
    status: { status: operation === 'unpublish' ? 'Published' : 'Draft' },
    contentBody: { rawHtml: 'Remote' },
  };
  const workspace = { id: 'space', apiName: 'Marketing', defaultLanguage: 'en_US' };
  const connection = {
    accessToken: 'token',
    instanceUrl: 'https://example.invalid',
    version: '67.0',
    request: sinon.stub().callsFake(({ url }: { url: string }) => {
      if (url === '/connect/cms/spaces/space') return response(workspace);
      if (url.startsWith('/connect/cms/items/search'))
        return response({
          total: 1,
          items: [
            {
              id: 'variant',
              managedContentSpaceId: 'space',
              type: 'ManagedContentVariantSearchResultRepresentation',
            },
          ],
        });
      if (url.endsWith('/variants/variant')) return response(variant);
      if (url.endsWith('/contents/parent'))
        return response({
          managedContentId: 'parent',
          contentType: variant.contentType,
          contentSpace: variant.contentSpace,
        });
      throw new Error(`Unexpected ${url}`);
    }),
  };
  const input = {
    projectRoot: root,
    selector: { workspaceId: 'space', apiName: 'pilot', language: 'en_US' },
  };
  const apply =
    operation === 'publish'
      ? applyDraftEmailPublishWithReport
      : applyPublishedEmailUnpublishWithReport;
  const preview =
    operation === 'publish' ? previewDraftEmailPublish : previewPublishedEmailUnpublish;
  return {
    root,
    file,
    html,
    workspace,
    variant,
    connection,
    input,
    apply,
    preview,
    report: path.join(root, 'report'),
  };
}

describe('Legacy Email local source production integration', () => {
  afterEach(() => sinon.restore());
  for (const operation of ['publish', 'unpublish'] as const) {
    for (const fault of ['none', 'missing', 'drift', 'persist-once', 'persist-always'] as const) {
      it(`${operation}: retains remote completion and exact local truth for ${fault}`, async () => {
        const test = await setup(operation, fault !== 'missing');
        const before = fault === 'missing' ? undefined : await readFile(test.file);
        let drifted = false;
        const mutation = sinon.stub(JsforceConnection.prototype, 'request').callsFake(() => {
          test.variant.isPublished = operation === 'publish';
          test.variant.status = { status: operation === 'publish' ? 'Published' : 'Draft' };
          return response({ deploymentId: 'deployment' });
        });
        let localWrites = 0;
        const pending = test.apply(test.connection, test.input, test.report, {
          rewriteReport: async (file, value) => {
            if (file.endsWith('-local.json')) {
              localWrites++;
              if (fault === 'persist-always' || (fault === 'persist-once' && localWrites === 1))
                throw new Error('local disk unavailable');
            }
            await rewriteAtomic(file, value);
            if (fault === 'drift' && (value as { state?: string }).state === 'completed') {
              await writeFile(test.html, 'Late authored edit');
              drifted = true;
            }
          },
        });
        // The captured root must not follow caller input changes after the first await.
        test.input.projectRoot = path.join(test.root, 'wrong-root');
        const result = await pending;
        expect(mutation.callCount).to.equal(1);
        expect(result.evidence.deploymentId).to.equal('deployment');
        expect(JSON.parse(await readFile(result.reportFile, 'utf8')).state).to.equal('completed');
        expect(result.localSource?.outcome).to.equal(
          ['drift', 'persist-once', 'persist-always'].includes(fault) ? 'blocked' : 'noop',
        );
        if (fault === 'persist-always') expect(result).not.to.have.property('localReportFile');
        else {
          const local = JSON.parse(await readFile(result.localReportFile!, 'utf8'));
          expect(local).to.include({
            operation,
            reportFile: result.reportFile,
            remoteOutcome: 'completed',
          });
          expect(local.localSource).to.deep.equal(result.localSource);
          expect(local.target).to.include({
            workspaceId: 'space',
            apiName: 'pilot',
            contentId: 'parent',
            variantId: 'variant',
            language: 'en_US',
          });
        }
        if (fault === 'missing') expect(await readdir(test.root)).to.deep.equal(['report']);
        else {
          expect(await readFile(test.file)).to.deep.equal(before);
          expect(await readFile(test.html, 'utf8')).to.equal(
            drifted ? 'Late authored edit' : '<p>Authored unchanged</p>',
          );
        }
      });
    }
    for (const fault of ['malformed', 'workspace', 'workspace-id', 'unsupported'] as const) {
      for (const mode of ['preview', 'apply'] as const) {
        it(`${operation}: ${mode} blocks ${fault} before report allocation or mutation`, async () => {
          const test = await setup(operation);
          switch (fault) {
            case 'workspace': {
              test.workspace.apiName = '';
              break;
            }
            case 'workspace-id': {
              test.workspace.id = 'other';
              break;
            }
            case 'malformed': {
              await writeFile(test.file, '{}');
              break;
            }
            default: {
              const definition = JSON.parse(await readFile(test.file, 'utf8'));
              definition.language = 'de_DE';
              await writeFile(test.file, JSON.stringify(definition));
              test.variant.language = 'de_DE';
              test.input.selector.language = 'de_DE';
            }
          }
          const mutation = sinon.stub(JsforceConnection.prototype, 'request');
          if (mode === 'preview') {
            const preview = await test.preview(test.connection, test.input);
            expect(preview.status).to.equal('blocked');
          } else {
            let error: unknown;
            try {
              await test.apply(test.connection, test.input, test.report);
            } catch (error_) {
              error = error_;
            }
            expect(error).to.be.instanceOf(Error);
            expect((error as Error).name).to.match(/PreflightBlocked/);
          }
          expect(mutation.called).to.equal(false);
          expect(await readdir(test.root)).to.deep.equal(['cms']);
        });
      }
    }
  }
});
