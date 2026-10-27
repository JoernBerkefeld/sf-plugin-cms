import type { Connection } from '@salesforce/core';
import { isDeepStrictEqual } from 'node:util';
import type { JsonValue } from '../contracts/capability-registry.js';
import { expectedEmailFragmentDefinition } from '../contracts/email-fragment-source.js';
import type { JsonRequestOptions } from '../transport/json-request.js';
import { resolveEmailFragmentDeployDestination } from './deploy-email-fragment-destination.js';
import { createPayload } from './import-workspace.js';
import type { CreateContentInput } from './write.js';
import {
  validateDataGraphPrerequisites,
  type WebFragmentDataGraphPrerequisite,
} from './web-fragment.js';

type CreateConnection = Pick<Connection, 'request' | 'getApiVersion' | 'getAuthInfoFields'>;
export type EmailFragmentCreatePreparation = {
  qualification: 'unqualified';
  proposed: 'create' | 'unchanged';
  orgId: string;
  apiVersion: string;
  destination: Awaited<ReturnType<typeof resolveEmailFragmentDeployDestination>>;
  dataGraphs: WebFragmentDataGraphPrerequisite[];
  payload: CreateContentInput;
};

function record(value: JsonValue | undefined): value is Record<string, JsonValue> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function prerequisites(body: Record<string, JsonValue>): WebFragmentDataGraphPrerequisite[] {
  const providers = body['lightning:dataProviders'] ?? [];
  if (!Array.isArray(providers)) throw new TypeError('Fragment data providers must be an array');
  const seen = new Set<string>();
  const graphs = providers.map((value) => {
    if (
      !record(value) ||
      value.definition !== 'sfdc_cms__dataGraphDataProvider' ||
      typeof value.sfdcExpressionKey !== 'string' ||
      !value.sfdcExpressionKey ||
      !record(value.attributes) ||
      typeof value.attributes.dataGraphApiName !== 'string' ||
      !/^[A-Za-z][A-Za-z\d_]*$/u.test(value.attributes.dataGraphApiName) ||
      typeof value.attributes.dataspace !== 'string' ||
      !/^[A-Za-z][A-Za-z\d_]*$/u.test(value.attributes.dataspace)
    )
      throw new TypeError(
        'Fragment provider prerequisite cannot be resolved from its authored identity',
      );
    if (seen.has(value.sfdcExpressionKey))
      throw new TypeError('Fragment provider expression identity is ambiguous');
    seen.add(value.sfdcExpressionKey);
    return {
      sourceDeveloperName: value.attributes.dataGraphApiName,
      sourceDataSpace: value.attributes.dataspace,
      targetDeveloperName: value.attributes.dataGraphApiName,
      targetDataSpace: value.attributes.dataspace,
      resolution: 'preserved' as const,
      validationStatus: 'pending' as const,
    };
  });
  const brand = body['lightning:brandSource'];
  if (brand !== undefined && !isDeepStrictEqual(brand, { defaultBrandOption: 'sfdcBrand' }))
    throw new TypeError(
      'Fragment Brand reference requires destination identity resolution before CREATE',
    );
  assertNoUnresolvedReferences(body);
  const expressions = JSON.stringify(body).matchAll(/\{!\s*(\$[A-Za-z][A-Za-z\d_]*)/gu);
  for (const [, binding] of expressions) {
    if ((binding === '$brand' && brand !== undefined) || seen.has(binding)) continue;
    throw new TypeError(`Fragment expression prerequisite is missing or unresolved: ${binding}`);
  }
  return graphs;
}

function assertNoUnresolvedReferences(value: JsonValue): void {
  if (Array.isArray(value)) {
    for (const child of value) assertNoUnresolvedReferences(child);
  } else if (record(value)) {
    if (
      'ref' in value ||
      'contentKey' in value ||
      value.type === 'file' ||
      (typeof value.type === 'string' && value.type.endsWith('Reference'))
    )
      throw new TypeError(
        'Fragment content reference requires destination identity resolution before CREATE',
      );
    for (const child of Object.values(value)) assertNoUnresolvedReferences(child);
  }
}

/**
 * Prepare detached CREATE observations without mutation authority or public deployment integration.
 * Nonroot folders require a later destination folder-resolution checkpoint; they are never flattened.
 * @param {CreateConnection} connection - Explicit destination org transport and identity.
 * @param {object} input - Standalone definition and exact destination workspace ID.
 * @param {string} input.definitionFile - Exact standalone source path.
 * @param {string} input.workspaceId - Exact destination workspace ID.
 * @param {JsonRequestOptions} options - Destination read timeout and cancellation options.
 * @returns {Promise<EmailFragmentCreatePreparation>} Detached full payload and revalidated evidence.
 */
export async function prepareEmailFragmentCreate(
  connection: CreateConnection,
  input: { definitionFile: string; workspaceId: string },
  options: JsonRequestOptions = {},
): Promise<EmailFragmentCreatePreparation> {
  const selected = structuredClone(input);
  const requestOptions = { ...options };
  const orgId = connection.getAuthInfoFields().orgId;
  const apiVersion = connection.getApiVersion();
  if (
    typeof orgId !== 'string' ||
    !/^00D[A-Za-z0-9]{12}(?:[A-Z0-5]{3})?$/u.test(orgId) ||
    !/^\d+\.\d+$/u.test(apiVersion)
  )
    throw new TypeError('Fragment CREATE requires exact destination org and selected API version');
  const destination = await resolveEmailFragmentDeployDestination(
    connection,
    selected,
    requestOptions,
  );
  const expected = expectedEmailFragmentDefinition(
    destination.source.definition,
    destination.existing ? 'update' : 'create',
    destination.workspace.apiName,
    destination.existing?.projection.definition,
  );
  if (
    destination.existing &&
    destination.inventory.records.some(
      (row) =>
        !row.ManagedContent.ApiName ||
        (row.ManagedContentId !== destination.existing!.evidence.contentId &&
          (row.Name === expected.title ||
            row.Name === destination.source.definition.title ||
            row.UrlName === destination.source.definition.urlName)),
    )
  )
    throw new TypeError('Fragment destination title/URL collision or unknown parent identity');
  if (
    destination.existing &&
    !isDeepStrictEqual(destination.existing.projection.definition, expected)
  )
    throw new TypeError('Fragment destination differs; UPDATE required (not implemented)');
  if (destination.source.definition.folderPath.length > 0)
    throw new TypeError(
      'Fragment nonroot folder destination resolution is not yet qualified; CREATE blocked',
    );
  const dataGraphs = structuredClone(prerequisites(destination.source.contentBody));
  const graphConnection = { version: apiVersion, request: connection.request.bind(connection) };
  await validateDataGraphPrerequisites(graphConnection, dataGraphs);
  const repeatedGraphs = structuredClone(prerequisites(destination.source.contentBody));
  await validateDataGraphPrerequisites(graphConnection, repeatedGraphs);
  if (
    !isDeepStrictEqual(dataGraphs, repeatedGraphs) ||
    connection.getAuthInfoFields().orgId !== orgId ||
    connection.getApiVersion() !== apiVersion ||
    !isDeepStrictEqual(
      await resolveEmailFragmentDeployDestination(connection, selected, requestOptions),
      destination,
    )
  )
    throw new TypeError(
      'Fragment CREATE source, destination or prerequisite changed during preparation',
    );
  const definition = destination.source.definition;
  const payload = createPayload(
    {
      primary: {
        apiName: definition.identity.apiName,
        contentType: definition.contentType,
        title: expected.title,
        urlName: definition.urlName,
        contentBody: structuredClone(destination.source.contentBody),
      },
    },
    destination.workspace.rootFolderId,
  );
  return {
    qualification: 'unqualified',
    proposed: destination.existing ? 'unchanged' : 'create',
    orgId,
    apiVersion,
    destination,
    dataGraphs,
    payload,
  };
}
