import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const contractCase = process.env.SF_PLUGIN_CMS_CONTRACT_CASE;

if (contractCase !== undefined) {
  const testRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const pluginRoot = process.env.SF_PLUGIN_CMS_INSTALLED_ROOT;
  const pluginVersion = process.env.SF_PLUGIN_CMS_INSTALLED_VERSION;
  if (pluginRoot === undefined) throw new Error('Installed plugin root is unavailable');
  if (pluginVersion === undefined) throw new Error('Installed plugin version is unavailable');
  const cases = {
    'export-success': {
      command: 'lib/commands/cms/export/workspace.js',
      fixture: 'contracts/fixtures/partial-export.json',
      transform: exportSuccess,
      validator: 'lib/contracts/workspace-export.js',
      validatorName: 'assertWorkspaceExportSetResult',
    },
    partial: {
      command: 'lib/commands/cms/export/workspace.js',
      fixture: 'contracts/fixtures/partial-export.json',
      validator: 'lib/contracts/workspace-export.js',
      validatorName: 'assertWorkspaceExportSetResult',
    },
    failed: {
      command: 'lib/commands/cms/import/workspace.js',
      fixture: 'contracts/fixtures/failed-import.json',
      validator: 'lib/contracts/workspace-import.js',
      validatorName: 'assertWorkspaceImportResult',
    },
  };
  if (contractCase.startsWith('editable-')) {
    // Replace only org acquisition: installed parsing, export/import services and transport run normally.
    const command = process.argv.includes('export') ? 'export' : 'import';
    const { default: Command } = await import(
      new URL(`lib/commands/cms/${command}/workspace.js`, pathToFileURL(`${pluginRoot}${path.sep}`))
    );
    Command.prototype.getOrgContext = async function () {
      const events = [{ phase: 'org' }];
      const evidenceFile = path.resolve(`${contractCase}-transport.json`);
      await writeFile(evidenceFile, JSON.stringify(events));
      if (contractCase === 'editable-local')
        throw new Error('Unexpected org access in local preflight');
      const created = new Map();
      return {
        orgId: '00DControlledSource',
        connection: {
          request: async ({ url, method, body }) => {
            const event = {
              url,
              method,
              ...(body === undefined ? {} : { body: JSON.parse(body) }),
            };
            events.push(event);
            await writeFile(evidenceFile, JSON.stringify(events));
            if (url === '/connect/cms/spaces/space') {
              return {
                id: 'space',
                name: 'Controlled',
                defaultLanguage: 'en',
                rootFolderId: 'root',
              };
            }
            if (command === 'export') {
              if (url.startsWith('/connect/cms/items/search?')) {
                return {
                  items: ['email', 'template'].map((id) => ({
                    id,
                    managedContentSpaceId: 'space',
                    type: 'ManagedContentVariantSearchResultRepresentation',
                  })),
                  total: 2,
                };
              }
              const id = url.split('/').at(-1);
              if (method === 'GET' && ['email', 'template'].includes(id)) {
                return {
                  id,
                  managedContentId: `parent-${id}`,
                  contentKey: `source-${id}`,
                  apiName: `source_${id}`,
                  urlName: `source-${id}`,
                  contentSpace: { id: 'space' },
                  language: 'en',
                  title: `${id} title`,
                  contentType: id === 'email' ? 'sfdc_cms__email' : 'sfdc_cms__emailTemplate',
                  externalId: null,
                  externalSource: null,
                  contentBody: {
                    'sfdc_cms:title': `${id} body title`,
                    subjectLine: 'Keep subject',
                    messagePurpose: 'promotional',
                    rawHtml: '&lt;p&gt;Original Café&lt;/p&gt;',
                    textContent: 'Keep text',
                  },
                };
              }
            } else {
              if (method === 'POST' && url === '/connect/cms/contents') {
                const payload = JSON.parse(body);
                event.initialReport = JSON.parse(
                  await readFile('editable-report/workspace-import-run.json', 'utf8'),
                );
                await writeFile(evidenceFile, JSON.stringify(events));
                const key = `created-${created.size + 1}`;
                created.set(key, payload);
                return {
                  contentKey: key,
                  managedContentId: `${key}-id`,
                  managedContentVariantId: `${key}-variant`,
                };
              }
              const key = url.split('/').at(-1);
              if (method === 'GET' && created.has(key)) {
                const payload = created.get(key);
                const response = {
                  ...payload,
                  contentKey: key,
                  managedContentId: `${key}-id`,
                  contentSpace: { id: 'space' },
                  language: 'en',
                  isPublished: false,
                  status: { status: 'Draft' },
                  contentBody: {
                    ...payload.contentBody,
                    rawHtml: payload.contentBody.rawHtml
                      .replaceAll('&', '&amp;')
                      .replaceAll('<', '&lt;')
                      .replaceAll('>', '&gt;')
                      .replaceAll('"', '&quot;')
                      .replaceAll("'", '&#39;'),
                  },
                };
                event.readback = response;
                await writeFile(evidenceFile, JSON.stringify(events));
                return response;
              }
            }
            throw new Error(`Unexpected controlled request: ${method} ${url}`);
          },
        },
      };
    };
  } else if (contractCase === 'single-complete' || contractCase === 'single-partial') {
    const { default: Command } = await import(
      new URL('lib/commands/cms/export/workspace.js', pathToFileURL(`${pluginRoot}${path.sep}`))
    );
    Command.prototype.getOrgContext = async function () {
      return {
        orgId: '00DControlledSource',
        connection: {
          request: async ({ url }) => {
            if (url === '/connect/cms/spaces/space') return { id: 'space', name: 'Controlled' };
            if (url.startsWith('/connect/cms/items/search?')) {
              return { items: [], total: contractCase === 'single-partial' ? 1 : 0 };
            }
            throw new Error(`Unexpected controlled request: ${url}`);
          },
        },
      };
    };
  } else {
    const selected = cases[contractCase];
    if (selected === undefined)
      throw new Error(`Unknown contract subprocess case: ${contractCase}`);

    const [{ default: Command }, validators, fixtureBytes] = await Promise.all([
      import(new URL(selected.command, pathToFileURL(`${pluginRoot}${path.sep}`))),
      import(new URL(selected.validator, pathToFileURL(`${pluginRoot}${path.sep}`))),
      readFile(path.resolve(testRoot, selected.fixture), 'utf8'),
    ]);
    const fixture = JSON.parse(fixtureBytes);
    Command.prototype.run = async function () {
      const envelope =
        selected.transform === undefined
          ? structuredClone(fixture)
          : selected.transform(structuredClone(fixture));
      envelope.metadata.plugin.version = pluginVersion;
      envelope.provenance.pluginVersion = pluginVersion;
      if (contractCase === 'export-success') {
        const manifestPath = path.resolve(envelope.result.workspaces[0].artifact.manifestPath);
        const manifestDirectory = path.dirname(manifestPath);
        await mkdir(manifestDirectory, { recursive: true });
        await writeFile(
          manifestPath,
          `${JSON.stringify({ provenance: { pluginVersion } }, null, 2)}\n`,
          'utf8',
        );
      }
      return this.finishEnvelope(envelope, validators[selected.validatorName]);
    };
  }
}

function exportSuccess(envelope) {
  envelope.status = 'success';
  envelope.diagnostics.warnings = [];
  envelope.result.summary = { failedCount: 0, partialCount: 0, succeededCount: 1 };
  envelope.result.workspaces[0].status = 'success';
  envelope.result.workspaces[0].diagnostics = { errors: [], warnings: [] };
  return envelope;
}
