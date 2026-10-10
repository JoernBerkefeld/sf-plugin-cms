import { readFileSync, writeFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isMainThread } from 'node:worker_threads';

const contractCase = process.env.SF_PLUGIN_CMS_CONTRACT_CASE;

if (contractCase !== undefined && isMainThread) {
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
  if (contractCase === 'image-upload-preview' || contractCase === 'image-upload-local') {
    const { default: Command } = await import(
      pathToFileURL(path.join(pluginRoot, 'lib/commands/cms/upload/images.js'))
    );
    Command.prototype.getOrgContext = async function () {
      if (contractCase === 'image-upload-local') throw new Error('Unexpected org access');
      const events = [{ phase: 'org' }];
      const evidenceFile = path.resolve('image-upload-preview-transport.json');
      await writeFile(evidenceFile, JSON.stringify(events));
      return {
        orgId: '00DControlledSource',
        connection: {
          request: async ({ method, url }) => {
            events.push({ method, url });
            await writeFile(evidenceFile, JSON.stringify(events));
            if (method !== 'GET') throw new Error('Unexpected image mutation');
            if (url === '/connect/cms/spaces/space')
              return { id: 'space', rootFolderId: 'root', isEnhancedSpace: true };
            if (url.startsWith('/connect/cms/items/search')) return { items: [], count: 0 };
            throw new Error('Unexpected image read');
          },
        },
      };
    };
  } else if (
    contractCase === 'email-update-preview' ||
    contractCase === 'email-template-update-preview' ||
    contractCase === 'email-template-update-apply' ||
    contractCase === 'email-publish-preview' ||
    contractCase === 'email-publish-apply' ||
    contractCase === 'email-unpublish-preview' ||
    contractCase === 'email-unpublish-apply' ||
    contractCase === 'email-delete-preview' ||
    contractCase === 'email-delete-apply' ||
    contractCase === 'email-template-delete-preview' ||
    contractCase === 'email-template-delete-apply'
  ) {
    // Exercise packed Email lifecycle commands with one controlled read-only transport.
    const isExport = process.argv.includes('export');
    let command = 'update/content';
    if (isExport) command = 'export/workspace';
    if (contractCase === 'email-publish-preview' || contractCase === 'email-publish-apply')
      command = 'publish/content';
    if (contractCase === 'email-unpublish-preview' || contractCase === 'email-unpublish-apply')
      command = 'unpublish/content';
    if (
      contractCase === 'email-delete-preview' ||
      contractCase === 'email-delete-apply' ||
      contractCase === 'email-template-delete-preview' ||
      contractCase === 'email-template-delete-apply'
    )
      command = 'delete/content';
    const pluginBaseUrl = pathToFileURL(`${pluginRoot}${path.sep}`);
    const [{ default: Command }, installedJsonRequest] = await Promise.all([
      import(new URL(`lib/commands/cms/${command}.js`, pluginBaseUrl)),
      import(new URL('lib/transport/json-request.js', pluginBaseUrl)),
    ]);
    const isTemplateUpdate = contractCase.startsWith('email-template-update-');
    if (isTemplateUpdate) {
      const { exportWorkspace } = await import(
        new URL('lib/services/export-workspace.js', pluginBaseUrl)
      );
      const sourceDirectory = path.resolve(`${contractCase}-source`);
      const editableDirectory = path.resolve(`${contractCase}-editable`);
      await exportWorkspace(
        {
          request: ({ url }) => {
            if (url === '/connect/cms/spaces/space') return { id: 'space', name: 'Controlled' };
            if (url.startsWith('/connect/cms/items/search'))
              return {
                items: [
                  {
                    id: 'template-en',
                    managedContentSpaceId: 'space',
                    type: 'ManagedContentVariantSearchResultRepresentation',
                  },
                ],
                total: 1,
              };
            if (url.endsWith('/template-en')) return emailTemplateVariant();
            throw new Error(`Unexpected template source request: ${url}`);
          },
        },
        'space',
        sourceDirectory,
        {
          selection: {
            contentType: 'sfdc_cms__emailTemplate',
            apiNames: ['pilot_template'],
          },
          editableDirectory,
        },
      );
      await writeFile(
        path.join(editableDirectory, 'items', 'template-en.html'),
        '<p>Installed Template edit</p>',
      );
    }
    Command.prototype.getOrgContext = async function () {
      const events = [{ phase: 'org' }];
      const evidenceFile = path.resolve(`${contractCase}-transport.json`);
      await writeFile(evidenceFile, JSON.stringify(events));
      const isUnpublish = contractCase.startsWith('email-unpublish-');
      const isTemplateDelete = contractCase.startsWith('email-template-delete-');
      const isTemplate = isTemplateUpdate || isTemplateDelete;
      const isDelete = contractCase.startsWith('email-delete-') || isTemplateDelete;
      const variants = isTemplate
        ? { 'template-en': emailTemplateVariant() }
        : {
            'variant-de': {
              ...emailVariant('variant-de', 'de_DE', isUnpublish),
              apiName: 'other_email',
              managedContentId: 'parent-other',
            },
            'variant-en': emailVariant('variant-en', 'en_US', isUnpublish),
          };
      if (isTemplateDelete) {
        const { createHash } = await import('node:crypto');
        const { exportWorkspace } = await import(
          new URL('lib/services/export-workspace.js', pathToFileURL(`${pluginRoot}${path.sep}`))
        );
        const sourceDirectory = path.resolve(`${contractCase}-source`);
        await exportWorkspace(
          {
            request: ({ url }) => {
              if (url === '/connect/cms/spaces/space') return { id: 'space', name: 'Controlled' };
              if (url.startsWith('/connect/cms/items/search'))
                return {
                  items: [
                    {
                      id: 'template-en',
                      managedContentSpaceId: 'space',
                      type: 'ManagedContentVariantSearchResultRepresentation',
                    },
                  ],
                  total: 1,
                };
              if (url.endsWith('/template-en')) return emailTemplateVariant();
              throw new Error(`Unexpected template source request: ${url}`);
            },
          },
          'space',
          sourceDirectory,
          {
            selection: {
              contentType: 'sfdc_cms__emailTemplate',
              apiNames: ['pilot_template'],
            },
          },
        );
        const payload = {
          apiName: 'pilot_template',
          contentBody: {
            ...emailTemplateVariant().contentBody,
            rawHtml: '<p>Original</p>',
          },
          contentSpaceId: 'space',
          contentType: 'sfdc_cms__emailTemplate',
          title: 'Pilot template',
        };
        const requestIdentity = `create-parent\0template-key\0en_US\0${JSON.stringify(payload)}`;
        if (isTemplateDelete)
          await writeFile(
            path.resolve('email-template-delete-journal.json'),
            JSON.stringify({
              state: 'completed',
              destinationOrgId: '00DControlledSource',
              destinationWorkspaceId: 'space',
              sourceDirectory,
              sourceManifestSha256: createHash('sha256')
                .update(await readFile(path.join(sourceDirectory, 'manifest.json')))
                .digest('hex'),
              operations: [
                {
                  state: 'succeeded',
                  operationKind: 'create-parent',
                  destinationOrgId: '00DControlledSource',
                  destinationWorkspaceId: 'space',
                  contentKey: 'template-key',
                  language: 'en_US',
                  requestIdentity,
                  requestSha256: createHash('sha256').update(requestIdentity).digest('hex'),
                  result: { contentId: 'parent-template', primaryVariantId: 'template-en' },
                },
              ],
              createdParents: [
                {
                  contentId: 'parent-template',
                  primaryVariantId: 'template-en',
                  childVariantIds: [],
                },
              ],
            }),
          );
      } else if (isDelete) {
        const { createHash } = await import('node:crypto');
        const requestIdentity = 'controlled-delete-create-request';
        await writeFile(
          path.resolve('email-delete-ownership.json'),
          JSON.stringify({
            contract: 'sf-cms-email-delete-ownership',
            contractVersion: '1.0.0',
            state: 'completed',
            identity: {
              orgId: '00DControlledSource',
              workspaceId: 'space',
              family: 'sfdc_cms__email',
              apiName: 'pilot_email',
              language: 'en_US',
              contentId: 'parent-email',
              variantId: 'variant-en',
            },
            requestIdentity,
            requestSha256: createHash('sha256')
              .update(JSON.stringify(requestIdentity))
              .digest('hex'),
            baselineHash: createHash('sha256')
              .update(
                JSON.stringify(
                  canonical({
                    apiName: 'pilot_email',
                    contentBody: emailVariant('variant-en', 'en_US').contentBody,
                    title: 'Pilot email',
                    urlName: 'pilot-email',
                  }),
                ),
              )
              .digest('hex'),
          }),
        );
      }
      const isTemplateUpdateApply = contractCase === 'email-template-update-apply';
      const isPublishApply = contractCase === 'email-publish-apply';
      const isUnpublishApply = contractCase === 'email-unpublish-apply';
      const isDeleteApply =
        contractCase === 'email-delete-apply' || contractCase === 'email-template-delete-apply';
      let parentPresent = true;
      if (isTemplateUpdateApply || isPublishApply || isUnpublishApply || isDeleteApply) {
        const require = createRequire(path.join(pluginRoot, 'package.json'));
        const { Connection } = require('@jsforce/jsforce-node');
        const intercept = function (request, requestOptions) {
          const event = {
            url: request.url,
            method: String(
              request.method ??
                request.options?.method ??
                (request.body === undefined ? 'GET' : 'PUT'),
            ).toUpperCase(),
            ...(request.body === undefined ? {} : { body: request.body }),
            ...(isTemplateUpdateApply ? { requestOptions } : {}),
          };
          events.push(event);
          let reportFile = 'email-publish-apply-report/content-publish-run.json';
          if (isTemplateUpdateApply)
            reportFile = 'email-template-update-apply-report/content-update-run.json';
          if (isUnpublishApply)
            reportFile = 'email-unpublish-apply-report/content-unpublish-run.json';
          if (isDeleteApply)
            reportFile = isTemplateDelete
              ? 'email-template-delete-apply-report/content-delete-run.json'
              : 'email-delete-apply-report/content-delete-run.json';
          const pending = JSON.parse(readFileSync(path.resolve(reportFile)));
          if (pending.state !== 'pending') throw new Error('Lifecycle intent was not pending');
          if (isDeleteApply) {
            delete variants[isTemplateDelete ? 'template-en' : 'variant-en'];
            parentPresent = false;
            return Object.assign(Promise.resolve({}), { stream: () => new PassThrough() });
          }
          if (isTemplateUpdateApply) {
            const payload =
              typeof request.body === 'string' ? JSON.parse(request.body) : request.body;
            variants['template-en'] = {
              ...variants['template-en'],
              contentBody: payload.contentBody,
            };
            return Object.assign(Promise.resolve({}), { stream: () => new PassThrough() });
          }
          variants['variant-en'] = {
            ...variants['variant-en'],
            isPublished: !isUnpublishApply,
            status: { status: isUnpublishApply ? 'Draft' : 'Published' },
          };
          return Object.assign(
            Promise.resolve({
              deploymentId: 'deployment-controlled',
              ...(isUnpublishApply
                ? { unpublishDate: '2026-10-02T00:00:00.000Z' }
                : { publishDate: '2026-10-01T20:00:00.000Z' }),
            }),
            { stream: () => new PassThrough() },
          );
        };
        Connection.prototype.request = intercept;
        for (const module of Object.values(require.cache)) {
          if (
            module?.filename?.endsWith(`${path.sep}connection.js`) &&
            module.filename.includes(`${path.sep}@jsforce${path.sep}jsforce-node${path.sep}`)
          ) {
            for (const candidate of [
              module.exports,
              module.exports?.Connection,
              module.exports?.default,
            ]) {
              if (typeof candidate === 'function') candidate.prototype.request = intercept;
            }
          }
        }
      }
      return {
        orgId: '00DControlledSource',
        connection: {
          accessToken: 'controlled-token',
          instanceUrl: 'https://controlled.example',
          version: '67.0',
          request: ({ url, method, body }) => {
            const event = { url, method, ...(body === undefined ? {} : { body }) };
            events.push(event);
            writeFileSync(evidenceFile, JSON.stringify(events));
            if (method !== 'GET') throw new Error(`Unexpected mutation request: ${method} ${url}`);
            if (url === '/connect/cms/spaces/space') {
              return { id: 'space', name: 'Controlled', defaultLanguage: 'en_US' };
            }
            if (url.startsWith('/connect/cms/items/search?')) {
              let ids = ['variant-de', 'variant-en'];
              if (isExport) ids = ['variant-en'];
              if (isTemplate || isDelete) ids = Object.keys(variants);
              return {
                count: ids.length,
                items: ids.map((id) => ({
                  id,
                  managedContentSpaceId: 'space',
                  contentType: {
                    developerName: isTemplate ? 'sfdc_cms__emailTemplate' : 'sfdc_cms__email',
                  },
                  type: 'ManagedContentVariantSearchResultRepresentation',
                })),
                total: ids.length,
              };
            }
            const id = url.split('/').at(-1);
            if (url.includes('/connect/cms/contents/variants/')) {
              if (variants[id] !== undefined) return variants[id];
              if (isDeleteApply) {
                throw new installedJsonRequest.CmsRequestError(
                  'variant.get',
                  'variant not found',
                  404,
                  {
                    errorCode: 'VARIANT_NOT_FOUND',
                    errorEntryCount: 1,
                    responseMessage: 'Variant not found',
                  },
                );
              }
              return Object.assign(
                Promise.reject(
                  Object.assign(new Error('variant not found'), {
                    response: {
                      data: [{ errorCode: 'VARIANT_NOT_FOUND', message: 'Variant not found' }],
                      status: 404,
                    },
                  }),
                ),
                { stream: () => new PassThrough() },
              );
            }
            if (
              url ===
              (isTemplate
                ? '/connect/cms/contents/parent-template'
                : '/connect/cms/contents/parent-email')
            ) {
              if (!parentPresent && isDeleteApply) {
                throw new installedJsonRequest.CmsRequestError(
                  'content.get',
                  'parent not found',
                  404,
                  {
                    errorCode: 'NOT_FOUND',
                    errorEntryCount: 1,
                    responseMessage: 'Parent not found',
                  },
                );
              }
              return {
                managedContentId: isTemplate ? 'parent-template' : 'parent-email',
                contentType: {
                  fullyQualifiedName: isTemplate ? 'sfdc_cms__emailTemplate' : 'sfdc_cms__email',
                },
                contentSpace: { id: 'space' },
              };
            }
            throw new Error(`Unexpected controlled request: ${method} ${url}`);
          },
        },
      };
    };
  } else if (contractCase.startsWith('brand-source-')) {
    // Only authentication/transport are controlled; installed commands and proof services stay real.
    const command = process.argv.includes('export') ? 'export' : 'import';
    const { default: Command } = await import(
      new URL(`lib/commands/cms/${command}/workspace.js`, pathToFileURL(`${pluginRoot}${path.sep}`))
    );
    const raw = JSON.parse(await readFile('brand-source-fixture.json', 'utf8'));
    const sourceOrgId = '00Daj00000bRQabEAG';
    const targetOrgId = '00Dfj00000bRQabEAG';
    const sourceWorkspace = raw.contentSpace.id;
    const targetWorkspace = '0Zufj000006rx4wCAA';
    const rootFolderId = '9Pufj000006rx4wCAA';
    const events = [];
    const evidenceFile = path.resolve(`${contractCase}-transport.json`);
    const persist = () => writeFile(evidenceFile, JSON.stringify(events));
    let sourceQueries = 0;
    let payload;
    // Tamper after the final refresh checkpoint has actually been persisted, not earlier.
    if (contractCase === 'brand-source-journal-drift') {
      const { promises } = await import('node:fs');
      const { syncBuiltinESMExports } = await import('node:module');
      const originalRename = promises.rename;
      promises.rename = async function (temporary, filename) {
        await originalRename(temporary, filename);
        if (String(filename).endsWith('workspace-import-run.json') && sourceQueries === 12) {
          const journal = JSON.parse(await readFile(filename, 'utf8'));
          journal.sourceDestination.rootFolderId = 'tampered-root';
          await writeFile(filename, JSON.stringify(journal));
        }
      };
      syncBuiltinESMExports();
    }
    Command.prototype.getOrgContext = async function (alias, apiVersion) {
      if (contractCase === 'brand-source-local') throw new Error('Unexpected org access');
      if (!['brand-source-alias', 'brand-target-alias'].includes(alias))
        throw new Error(`Unexpected Brand org alias: ${alias}`);
      const source = alias === 'brand-source-alias';
      const orgId = source && contractCase !== 'brand-source-wrong-org' ? sourceOrgId : targetOrgId;
      events.push({ phase: 'org', alias, orgId, apiVersion });
      await persist();
      return {
        orgId,
        connection: {
          getApiVersion: () => '67.0',
          getAuthInfoFields: () => ({ orgId }),
          request: async ({ method, url, body }, options) => {
            const event = {
              alias,
              method,
              url,
              options,
              ...(body === undefined ? {} : { body: JSON.parse(body) }),
            };
            events.push(event);
            await persist();
            if (source) {
              if (method !== 'GET') throw new Error('Source mutation forbidden');
              if (url === `/connect/cms/spaces/${sourceWorkspace}`)
                return {
                  id: sourceWorkspace,
                  name: 'Content Workspace for Marketing Cloud',
                  apiName: 'Default_Content_Workspace',
                };
              if (url.startsWith('/services/data/v67.0/query?q=')) {
                sourceQueries += 1;
                const query = decodeURIComponent(url.split('?q=')[1]);
                event.query = query;
                await persist();
                if (
                  !query.includes(
                    `ManagedContentId = '${raw.managedContentId}' AND ManagedContent.AuthoredManagedContentSpaceId = '${sourceWorkspace}'`,
                  )
                )
                  throw new Error('Unbound canonical Brand query');
                if (/(?:Language|IsPublished|ManagedContentVariantStatus) =/u.test(query))
                  throw new Error('Filtered Brand sibling query');
                if (contractCase === 'brand-source-file-drift' && sourceQueries === 12)
                  await writeFile(
                    'brand-source-definitions/cms/Default_Content_Workspace/brand/Phase_5_Discovery_Brand.cms-brand.json',
                    '{}',
                  );
                if (query.includes('COUNT(Id)'))
                  return {
                    totalSize: 1,
                    done: true,
                    records: [
                      {
                        attributes: { type: 'AggregateResult' },
                        ManagedContentId: raw.managedContentId,
                        siblingCount: 1,
                      },
                    ],
                  };
                if (query.includes(' AND Id > ')) {
                  if (!query.includes(` AND Id > '${raw.managedContentVariantId}' ORDER BY Id`))
                    throw new Error('Wrong canonical cursor');
                  return { totalSize: 0, done: true, records: [] };
                }
                const row = {
                  attributes: {
                    type: 'ManagedContentVariant',
                    url: `/services/data/v67.0/sobjects/ManagedContentVariant/${raw.managedContentVariantId}`,
                  },
                  Id: raw.managedContentVariantId,
                  ManagedContentId: raw.managedContentId,
                  Language: raw.language,
                  IsPublished: false,
                  ManagedContentVariantStatus: 'Draft',
                  IsPrimary: true,
                  Name: raw.title,
                  UrlName: raw.urlName,
                  ManagedContentKey: raw.contentKey,
                  ManagedContent: {
                    attributes: {
                      type: 'ManagedContent',
                      url: `/services/data/v67.0/sobjects/ManagedContent/${raw.managedContentId}`,
                    },
                    AuthoredManagedContentSpaceId: sourceWorkspace,
                    ApiName: raw.apiName,
                  },
                };
                return contractCase === 'brand-source-sibling-drift' && sourceQueries > 6
                  ? {
                      totalSize: 2,
                      done: true,
                      records: [row, { ...row, Id: '9Psaj00000IF7YICA1', Language: 'fr' }],
                    }
                  : { totalSize: 1, done: true, records: [row] };
              }
              if (url.startsWith('/connect/cms/items/search?'))
                return {
                  total: 1,
                  items: [
                    {
                      type: 'ManagedContentVariantSearchResultRepresentation',
                      id: raw.managedContentVariantId,
                      managedContentSpaceId: sourceWorkspace,
                    },
                  ],
                };
              if (url === `/connect/cms/contents/${raw.managedContentId}`)
                return { ...raw, contentVersion: 1, variantVersion: '1.1' };
              if (url === `/connect/cms/contents/variants/${raw.managedContentVariantId}`)
                return contractCase === 'brand-source-body-drift' && sourceQueries > 6
                  ? { ...raw, contentBody: { ...raw.contentBody, baseFontFamily: 'Drift' } }
                  : raw;
            } else {
              if (url === `/connect/cms/spaces/${targetWorkspace}`)
                return {
                  id: targetWorkspace,
                  name: 'Destination',
                  rootFolderId,
                  defaultLanguage: 'en_US',
                  spaceType: { apiName: 'Marketing' },
                };
              if (url.startsWith('/connect/cms/items/search?'))
                return { count: 0, total: 0, items: [] };
              if (method === 'POST' && url === '/connect/cms/contents') {
                payload = JSON.parse(body);
                const reportDirectory = `${contractCase}-report`;
                event.initialReport = JSON.parse(
                  await readFile(path.join(reportDirectory, 'workspace-import-run.json'), 'utf8'),
                );
                await persist();
                return {
                  contentKey: 'fresh-brand-key',
                  managedContentId: 'fresh-brand-parent',
                  managedContentVariantId: 'fresh-brand-variant',
                };
              }
              if (
                method === 'GET' &&
                [
                  '/connect/cms/contents/fresh-brand-key',
                  '/connect/cms/contents/variants/fresh-brand-variant',
                ].includes(url) &&
                payload
              ) {
                // Readbacks use an independent fixture, never echo the submitted body.
                event.readback = {
                  ...raw,
                  apiName: 'Fresh_Brand',
                  title: 'Fresh Brand',
                  urlName: 'fresh-brand',
                  contentBody: { ...raw.contentBody, 'sfdc_cms:title': 'Fresh Brand' },
                  contentKey: 'fresh-brand-key',
                  managedContentId: 'fresh-brand-parent',
                  managedContentVariantId: 'fresh-brand-variant',
                  contentSpace: { id: targetWorkspace },
                  folder: { id: rootFolderId },
                };
                await persist();
                return event.readback;
              }
            }
            throw new Error(`Unexpected Brand acceptance request: ${alias} ${method} ${url}`);
          },
        },
      };
    };
  } else if (contractCase.startsWith('source-a-')) {
    // Only org acquisition is replaced; packed flags, source services and journals stay real.
    const command = process.argv.includes('export') ? 'export' : 'import';
    const { default: Command } = await import(
      new URL(`lib/commands/cms/${command}/workspace.js`, pathToFileURL(`${pluginRoot}${path.sep}`))
    );
    Command.prototype.getOrgContext = async function () {
      if (contractCase === 'source-a-local') throw new Error('Unexpected org access');
      const raw = JSON.parse(await readFile('source-a-fixture.json', 'utf8'));
      const events = [{ phase: 'org' }];
      const evidenceFile = path.resolve(`${contractCase}-transport.json`);
      await writeFile(evidenceFile, JSON.stringify(events));
      let workspaceReads = 0;
      let payload;
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
              workspaceReads += 1;
              if (
                command === 'import' &&
                workspaceReads === 2 &&
                contractCase === 'source-a-json-drift'
              ) {
                const report = JSON.parse(
                  await readFile('source-a-json-drift-report/workspace-import-run.json', 'utf8'),
                );
                const definitionDirectory = 'source-a-email-definitions';
                const definitionFile = path.join(
                  definitionDirectory,
                  report.sourceDefinitions.edits.entries[0].definitionPath,
                );
                const candidate = JSON.parse(await readFile(definitionFile, 'utf8'));
                candidate.contentBody.textContent = 'Safe acquisition drift';
                await writeFile(definitionFile, JSON.stringify(candidate));
              }
              if (
                command === 'import' &&
                workspaceReads === 2 &&
                contractCase === 'source-a-drift'
              ) {
                const html = 'source-a-email-definitions';
                const report = JSON.parse(
                  await readFile('source-a-drift-report/workspace-import-run.json', 'utf8'),
                );
                await writeFile(
                  path.join(
                    html,
                    report.sourceDefinitions.edits.entries[0].definitionPath.replace(
                      /\.json$/u,
                      '.html',
                    ),
                  ),
                  '<p>Drift</p>',
                );
              }
              return {
                id: 'space',
                name: 'Controlled',
                defaultLanguage: 'en_US',
                rootFolderId: 'distinct-root',
              };
            }
            if (command === 'export') {
              if (url.startsWith('/connect/cms/items/search?'))
                return {
                  count: 1,
                  items: [
                    {
                      id: 'email',
                      managedContentSpaceId: 'space',
                      type: 'ManagedContentVariantSearchResultRepresentation',
                    },
                  ],
                };
              if (url.endsWith('/variants/email')) return raw;
              if (url.endsWith('/contents/parent'))
                return raw.contentType.fullyQualifiedName === 'sfdc_cms__brand'
                  ? raw
                  : {
                      managedContentId: 'parent',
                      contentType: raw.contentType,
                      contentSpace: raw.contentSpace,
                      folder: null,
                    };
            } else {
              if (url.startsWith('/connect/cms/items/search?'))
                return {
                  count: 1,
                  items: [
                    {
                      id: 'destination-existing',
                      managedContentSpaceId: 'space',
                      type: 'ManagedContentVariantSearchResultRepresentation',
                    },
                  ],
                };
              if (url.endsWith('/variants/destination-existing'))
                return {
                  managedContentVariantId: 'destination-existing',
                  managedContentId: 'destination-existing-parent',
                  apiName: 'unrelated_destination_image',
                  title:
                    contractCase === 'source-a-title-collision'
                      ? 'Edited Welcome'
                      : 'Unrelated destination image',
                  urlName:
                    contractCase === 'source-a-url-collision'
                      ? 'fresh'
                      : 'unrelated-destination-image',
                  contentSpace: { id: 'space' },
                  contentType: { fullyQualifiedName: 'sfdc_cms__image' },
                };
              if (method === 'POST' && url === '/connect/cms/contents') {
                payload = JSON.parse(body);
                event.initialReport = JSON.parse(
                  await readFile('source-a-report/workspace-import-run.json', 'utf8'),
                );
                await writeFile(evidenceFile, JSON.stringify(events));
                return {
                  contentKey: 'created',
                  managedContentId: 'created-parent',
                  managedContentVariantId: 'created-variant',
                };
              }
              if (method === 'GET' && url.endsWith('/contents/created') && payload !== undefined) {
                event.readback = {
                  ...payload,
                  contentKey: 'created',
                  managedContentId: 'created-parent',
                  contentSpace: { id: 'space' },
                  folder: { id: 'distinct-root' },
                  language: 'en_US',
                  isPublished: false,
                  status: { status: 'Draft' },
                  contentBody: {
                    ...payload.contentBody,
                    rawHtml: payload.contentBody.rawHtml
                      .replaceAll('&', '&amp;')
                      .replaceAll('<', '&lt;')
                      .replaceAll('>', '&gt;'),
                  },
                };
                await writeFile(evidenceFile, JSON.stringify(events));
                return event.readback;
              }
            }
            throw new Error(`Unexpected source acceptance request: ${method} ${url}`);
          },
        },
      };
    };
  } else if (contractCase.startsWith('definition-')) {
    const { default: Command } = await import(
      new URL('lib/commands/cms/export/workspace.js', pathToFileURL(`${pluginRoot}${path.sep}`))
    );
    Command.prototype.getOrgContext = async function () {
      if (contractCase === 'definition-local') throw new Error('Unexpected org access');
      const raw = {
        managedContentVariantId: 'email',
        managedContentId: 'parent',
        contentKey: 'key',
        apiName: 'Welcome',
        contentType: { fullyQualifiedName: 'sfdc_cms__email' },
        contentSpace: { id: 'space' },
        language: 'en_US',
        folder: null,
        title: 'Welcome',
        contentBody: {
          'sfdc_cms:title': 'Welcome',
          subjectLine: 'Hello',
          messagePurpose: 'Transactional',
          rawHtml: '&lt;p&gt;Hello&lt;/p&gt;',
          'lightning:expressions': [],
          'sfdc_cms:variants': [],
        },
      };
      return {
        orgId: '00DControlledSource',
        connection: {
          request: async ({ url, method }) => {
            if (method !== 'GET') throw new Error('Unexpected mutation');
            if (url === '/connect/cms/spaces/space') return { id: 'space', name: 'Controlled' };
            if (url.startsWith('/connect/cms/items/search?'))
              return {
                count: 1,
                items: [
                  {
                    id: 'email',
                    managedContentSpaceId: 'space',
                    type: 'ManagedContentVariantSearchResultRepresentation',
                  },
                ],
              };
            if (url.endsWith('/variants/email')) return raw;
            if (url.endsWith('/contents/parent'))
              return {
                managedContentId: 'parent',
                contentType: raw.contentType,
                contentSpace: raw.contentSpace,
                folder: null,
              };
            throw new Error(`Unexpected source read: ${url}`);
          },
        },
      };
    };
  } else if (contractCase.startsWith('editable-')) {
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

function canonical(value) {
  if (Array.isArray(value)) return value.map((item) => canonical(item));
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.keys(value)
      .toSorted()
      .map((key) => [key, canonical(value[key])]),
  );
}

function emailTemplateVariant() {
  return {
    managedContentVariantId: 'template-en',
    managedContentId: 'parent-template',
    contentKey: 'template-key',
    apiName: 'pilot_template',
    language: 'en_US',
    title: 'Pilot template',
    contentType: { fullyQualifiedName: 'sfdc_cms__emailTemplate', name: 'Email Template' },
    contentSpace: { id: 'space' },
    isPublished: false,
    status: { status: 'Draft' },
    externalId: null,
    externalSource: null,
    contentBody: {
      'sfdc_cms:title': 'Pilot template',
      subjectLine: 'Pilot subject',
      messagePurpose: 'Transactional',
      rawHtml: '&lt;p&gt;Original&lt;/p&gt;',
      'lightning:dataProviders': [],
      'lightning:expressions': [],
      'sfdc_cms:attachments': [],
      'sfdc_cms:variants': [],
    },
  };
}

function emailVariant(id, language, published = false) {
  return {
    managedContentVariantId: id,
    managedContentId: 'parent-email',
    contentKey: 'email-key',
    apiName: 'pilot_email',
    language,
    title: 'Pilot email',
    urlName: 'pilot-email',
    contentType: { fullyQualifiedName: 'sfdc_cms__email', name: 'Email' },
    contentSpace: { id: 'space' },
    isPublished: published,
    status: { status: published ? 'Published' : 'Draft' },
    externalId: null,
    externalSource: null,
    contentBody: {
      'sfdc_cms:title': 'Pilot email',
      'sfdc_cms:urlName': 'pilot-email',
      subjectLine: 'Pilot subject',
      messagePurpose: 'Transactional',
      rawHtml: '&lt;p&gt;Original&lt;/p&gt;',
      'lightning:dataProviders': [],
      'lightning:expressions': [],
      'sfdc_cms:attachments': [],
      'sfdc_cms:variants': [],
    },
  };
}

function exportSuccess(envelope) {
  envelope.status = 'success';
  envelope.diagnostics.warnings = [];
  envelope.result.summary = { failedCount: 0, partialCount: 0, succeededCount: 1 };
  envelope.result.workspaces[0].status = 'success';
  envelope.result.workspaces[0].diagnostics = { errors: [], warnings: [] };
  return envelope;
}
