/** The destination workspace of the fake org. */
export const workspace = {
  apiName: 'Default_Content_Workspace',
  id: '0Zu000000000001AAA',
  isEnhancedSpace: true,
  name: 'Workspace',
  defaultLanguage: 'en_US',
  rootFolderId: '9Pu000000000001AAA',
  spaceType: { apiName: 'marketing' },
};

/**
 * A Salesforce error as jsforce throws it.
 * @param {number} statusCode HTTP status.
 * @param {string} errorCode Salesforce error code.
 * @param {string} [message] Message.
 * @returns {Error} Error.
 */
export const salesforceError = (statusCode, errorCode, message = errorCode) =>
  Object.assign(new Error(message), { statusCode, data: [{ errorCode, message }] });

/**
 * An in-memory org: one workspace with folders, variants, folder create, content create and
 * update, publish/unpublish, delete, the Data 360 data space list and data graph read, and
 * Campaign and RecordType SOQL by ID and by lookup fields.
 * @param {{ variants?: object[]; folders?: object; dataSpaces?: string[]; graphs?: object; campaigns?: object[]; recordTypes?: object[] }} state
 *   Stored variants, child folders by parent ID, data space names, data graph -> data space,
 *   Campaign rows `{ Id, Name }`, RecordType rows `{ Id, SobjectType, DeveloperName }`.
 * @returns {{ answer: Function; variants: Map; folders: object }} Answer function and stores.
 */
export function fakeOrg(state = {}) {
  const variants = new Map();
  const folders = structuredClone(state.folders ?? {});
  const dataSpaces = state.dataSpaces ?? ['default'];
  const graphs = state.graphs ?? { Marketing: 'default' };
  const records = { Campaign: state.campaigns ?? [], RecordType: state.recordTypes ?? [] };
  let counter = 0;
  const store = (native) => {
    variants.set(native.managedContentVariantId, structuredClone(native));
    return structuredClone(native);
  };
  for (const native of state.variants ?? []) store(native);
  const answer = (input) => {
    const url = decodeURIComponent(input.url.replaceAll('+', ' '));
    const body = input.body === undefined ? undefined : JSON.parse(input.body);
    if (url.startsWith('/connect/cms/spaces?'))
      return { spaces: url.includes('page=0') ? [workspace] : [] };
    if (url.startsWith('/ssot/data-spaces?')) {
      const offset = Number(/offset=(\d+)/u.exec(url)[1]);
      // One data space per page, to cover paging.
      return {
        dataSpaces: dataSpaces.slice(offset, offset + 1).map((name) => ({ name })),
        totalSize: dataSpaces.length,
      };
    }
    const graph = /^\/ssot\/data-graphs\/(\w+)$/u.exec(url)?.[1];
    if (graph) {
      if (graphs[graph]) return { name: graph, dataspaceName: graphs[graph], status: 'ready' };
      throw salesforceError(400, 'INTERNAL_ERROR', `Data Graph not found with name ${graph}`);
    }
    const sobject = /FROM (Campaign|RecordType) /u.exec(url)?.[1];
    if (url.startsWith('/query?') && sobject) {
      const ids = /Id IN \(([^)]*)\)/u.exec(url)?.[1];
      const where = [...url.matchAll(/(\w+) = '([^']*)'/gu)];
      return {
        records: records[sobject]
          .filter((row) =>
            ids
              ? ids.includes(`'${row.Id}'`)
              : where.every(([, field, value]) => row[field] === value),
          )
          .slice(0, ids ? undefined : 2),
      };
    }
    if (url.startsWith('/query?')) {
      const type = /ContentTypeFullyQualifiedName = '(\w+)'/u.exec(url)?.[1];
      const names = /ApiName IN \(([^)]*)\)/u.exec(url)?.[1] ?? '';
      const keys = /ManagedContentKey IN \(([^)]*)\)/u.exec(url)?.[1];
      return {
        records: [...variants.values()]
          .filter((v) =>
            keys
              ? keys.includes(`'${v.contentKey}'`)
              : v.contentType.fullyQualifiedName === type && names.includes(`'${v.apiName}'`),
          )
          .map((v) => ({
            Id: v.managedContentVariantId,
            ManagedContentId: v.managedContentId,
            Language: 'en_US',
            IsPrimary: true,
            Name: v.title,
            ManagedContentKey: v.contentKey,
            ContentTypeFullyQualifiedName: v.contentType.fullyQualifiedName,
            ManagedContent: { ApiName: v.apiName, AuthoredManagedContentSpaceId: workspace.id },
          })),
      };
    }
    const items = /^\/connect\/cms\/folders\/(\w+)\/folder-items\?.*page=(\d+)/u.exec(url);
    if (items)
      return {
        folderItems:
          items[2] === '0'
            ? (folders[items[1]] ?? []).map((f) => ({
                isFolder: true,
                managedContentOrFolderId: f.id,
                title: f.name,
                folderSummary: { folderType: 'Standard' },
              }))
            : [],
      };
    if (url === '/connect/cms/folders' && input.method === 'POST') {
      counter += 1;
      const id = `9Pu0000000NEW${counter}AAA`;
      folders[body.parentFolderId] = [
        ...(folders[body.parentFolderId] ?? []),
        { id, name: body.name },
      ];
      return { id, name: body.name, parentFolderId: body.parentFolderId, folderType: 'Standard' };
    }
    const folder = /^\/connect\/cms\/folders\/(\w+)\?/u.exec(url)?.[1];
    if (folder) {
      const chain = [];
      for (let current = folder; current !== workspace.rootFolderId;) {
        const parent = Object.keys(folders).find((p) => folders[p].some((f) => f.id === current));
        chain.unshift({ name: folders[parent].find((f) => f.id === current).name, id: current });
        current = parent;
      }
      return {
        name: chain.at(-1).name,
        folderType: 'Standard',
        folderHierarchy: [
          { folderType: 'System', name: 'Root' },
          ...chain.slice(0, -1).map((f) => ({ folderType: 'Standard', name: f.name })),
        ],
      };
    }
    if (url === '/connect/cms/contents' && input.method === 'POST') {
      counter += 1;
      return store({
        apiName: body.apiName,
        title: body.title,
        urlName: body.urlName,
        contentBody: body.contentBody,
        contentKey: `MC${'Z'.repeat(25)}${String.fromCodePoint(65 + counter)}`,
        contentType: { fullyQualifiedName: body.contentType },
        folder: { id: body.contentSpaceOrFolderId },
        language: 'en_US',
        managedContentId: `20Y00000000000${counter}AAA`,
        managedContentVariantId: `9Ps00000000000${counter}AAA`,
        isPublished: false,
      });
    }
    const action = /^\/connect\/cms\/contents\/(publish|unpublish)$/u.exec(url)?.[1];
    if (action) {
      for (const id of body.variantIds) variants.get(id).isPublished = action === 'publish';
      return { deploymentId: '0jk000000000001AAA', description: '#DEPLOYED' };
    }
    const variant = /^\/connect\/cms\/contents\/variants\/(\w+)$/u.exec(url)?.[1];
    if (variant && variants.has(variant)) {
      if (input.method === 'DELETE') {
        variants.delete(variant);
        return;
      }
      if (input.method === 'PUT')
        return store({ ...variants.get(variant), ...body, contentBody: body.contentBody });
      return structuredClone(variants.get(variant));
    }
    throw salesforceError(404, 'NOT_FOUND');
  };
  return { answer, variants, folders };
}
