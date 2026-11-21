import { CmsError } from '../errors/registry.js';
import { emailTemplateHandler } from './handlers/email-template.js';
import { emailHandler } from './handlers/email.js';
import type { ContentTypeHandler } from './types.js';

/** Every supported type, in deploy order (dependencies first). One line per new type. */
export const HANDLERS: readonly ContentTypeHandler[] = [emailTemplateHandler, emailHandler];

/**
 * CLI name of a Salesforce content type: `sfdc_cms__` dropped, camelCase to kebab-case
 * (`sfdc_cms__emailTemplate` -> `email-template`); other namespaces stay as they are. Also names
 * referenced types that have no handler yet.
 * @param {string} contentType - Fully qualified content type name.
 * @returns {string} CLI type name.
 */
export function cliTypeName(contentType: string): string {
  if (!contentType.startsWith('sfdc_cms__')) return contentType;
  return contentType.slice('sfdc_cms__'.length).replaceAll(/[A-Z]/gu, (c) => `-${c.toLowerCase()}`);
}

/**
 * The handler of a CLI type name.
 * @param {string} type - CLI type name, such as `email`.
 * @returns {ContentTypeHandler} Handler.
 */
export function handlerOf(type: string): ContentTypeHandler {
  const handler = HANDLERS.find((candidate) => candidate.type === type);
  if (!handler)
    throw new CmsError(
      'UNKNOWN_TYPE',
      `Unknown type ${type}; supported: ${HANDLERS.map((h) => h.type).join(', ')}`,
    );
  return handler;
}
