import type { Connection } from '@salesforce/core';
import { isDeepStrictEqual } from 'node:util';
import type { JsonRequestOptions } from '../transport/json-request.js';
import { expectedEmailFragmentDefinition } from '../contracts/email-fragment-source.js';
import { prerequisites } from './deploy-email-fragment-create-preflight.js';
import { resolveEmailFragmentDeployDestination } from './deploy-email-fragment-destination.js';
import type { UpdateVariantInput } from './lifecycle-foundation.js';
import { getContent, getVariant } from './read.js';
import { validateDataGraphPrerequisites } from './web-fragment.js';

type FragmentConnection = Pick<Connection, 'request' | 'getApiVersion' | 'getAuthInfoFields'>;

/** Detached observations, never reusable mutation authority. */
export type EmailFragmentUpdatePreparation = Awaited<ReturnType<typeof prepareEmailFragmentUpdate>>;

/**
 * Bind full authored content to an existing single-default unpublished Draft and its prerequisites.
 * @param {FragmentConnection} connection - Explicit destination transport and identity.
 * @param {object} input - Exact standalone source and destination workspace.
 * @param {string} input.definitionFile - Standalone Fragment definition.
 * @param {string} input.workspaceId - Exact destination workspace.
 * @param {JsonRequestOptions} options - Bounded read and cancellation options.
 * @returns {Promise<object>} Detached baseline, complete payload and UPDATE/unchanged proposal.
 */
export async function prepareEmailFragmentUpdate(
  connection: FragmentConnection,
  input: { definitionFile: string; workspaceId: string },
  options: JsonRequestOptions = {},
) {
  const selected = structuredClone(input);
  const requestOptions = { ...options };
  const orgId = connection.getAuthInfoFields().orgId;
  const apiVersion = connection.getApiVersion();
  if (
    typeof orgId !== 'string' ||
    !/^00D[A-Za-z0-9]{12}(?:[A-Z0-5]{3})?$/u.test(orgId) ||
    !/^\d+\.\d+$/u.test(apiVersion)
  )
    throw new TypeError('Fragment UPDATE requires exact destination org and selected API version');
  const destination = await resolveEmailFragmentDeployDestination(
    connection,
    selected,
    requestOptions,
  );
  const existing = destination.existing;
  if (!existing) throw new TypeError('Fragment target is missing; explicit CREATE required');
  const expected = expectedEmailFragmentDefinition(
    destination.source.definition,
    'update',
    destination.workspace.apiName,
    existing.projection.definition,
  );
  if (
    destination.inventory.records.some(
      (row) =>
        !row.ManagedContent.ApiName ||
        (row.ManagedContentId !== existing.evidence.contentId &&
          (row.Name === expected.title ||
            row.Name === destination.source.definition.title ||
            row.UrlName === destination.source.definition.urlName)),
    )
  )
    throw new TypeError('Fragment destination title/URL collision or unknown parent identity');
  if (
    destination.source.definition.folderPath.length > 0 ||
    existing.projection.definition.folderPath.length > 0
  )
    throw new TypeError(
      'Fragment nonroot folder destination resolution is not yet qualified; UPDATE blocked',
    );
  const dataGraphs = structuredClone(prerequisites(destination.source.contentBody));
  const graphConnection = { version: apiVersion, request: connection.request.bind(connection) };
  await validateDataGraphPrerequisites(graphConnection, dataGraphs);
  const baseline = {
    parent: await getContent(connection, existing.evidence.contentId, {}, requestOptions),
    variant: await getVariant(connection, existing.evidence.variantId, requestOptions),
  };
  const repeatedGraphs = structuredClone(prerequisites(destination.source.contentBody));
  await validateDataGraphPrerequisites(graphConnection, repeatedGraphs);
  if (
    !isDeepStrictEqual(dataGraphs, repeatedGraphs) ||
    !isDeepStrictEqual(
      await getContent(connection, existing.evidence.contentId, {}, requestOptions),
      baseline.parent,
    ) ||
    !isDeepStrictEqual(
      await getVariant(connection, existing.evidence.variantId, requestOptions),
      baseline.variant,
    ) ||
    !isDeepStrictEqual(
      await resolveEmailFragmentDeployDestination(connection, selected, requestOptions),
      destination,
    ) ||
    connection.getAuthInfoFields().orgId !== orgId ||
    connection.getApiVersion() !== apiVersion ||
    requestOptions.signal?.aborted
  )
    throw new TypeError(
      'Fragment UPDATE source, destination or prerequisite changed during preparation',
    );
  const definition = destination.source.definition;
  const payload: UpdateVariantInput = {
    apiName: definition.identity.apiName,
    title: expected.title,
    urlName: definition.urlName,
    contentBody: structuredClone(destination.source.contentBody),
  };
  return {
    qualification: 'unqualified' as const,
    proposed: isDeepStrictEqual(existing.projection.definition, expected)
      ? ('unchanged' as const)
      : ('update' as const),
    orgId,
    apiVersion,
    destination: { ...destination, existing },
    baseline,
    dataGraphs,
    payload,
    expected,
    envelope: {
      sourceTitle: definition.title,
      effectiveTitle: expected.title,
      derived: definition.title !== expected.title,
    },
  };
}
