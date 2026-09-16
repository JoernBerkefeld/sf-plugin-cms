import { createHash } from 'node:crypto';
import { decodeNativeHtml } from './import-identities.js';
import { variantIdentity } from './variant-identity.js';

export type EditableRawItem = {
  readonly variantId: string;
  readonly raw: Readonly<Record<string, unknown>>;
};

export type EditableRawHtmlEntry = {
  readonly variantId: string;
  readonly metadataSha256: string;
  readonly originalHtmlSha256: string;
};

export type EditableRawHtmlDescriptor = {
  readonly contract: 'sf-cms-editable-raw-html';
  readonly contractVersion: '1.0.0';
  readonly sourceManifestSha256: string;
  readonly entries: readonly EditableRawHtmlEntry[];
};

export type EditableRawHtmlProjection = {
  readonly descriptor: EditableRawHtmlDescriptor;
  readonly descriptorBytes: Buffer;
  readonly items: readonly {
    readonly variantId: string;
    readonly metadataPath: string;
    readonly htmlPath: string;
    readonly metadataBytes: Buffer;
    readonly htmlBytes: Buffer;
  }[];
};

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function jsonBytes(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function sha256(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function literalHtml(value: string): string {
  // Literal HTML may itself contain entities: never decode those a second time.
  if (value.includes('<')) return value;
  if (
    value.includes('&') &&
    (!value.includes('&lt;') || value.replaceAll(/&(?:lt|gt|quot|amp|#39);/gu, '').includes('&'))
  ) {
    throw new TypeError(
      'Unsupported or ambiguous rawHtml encoding; expected literal HTML or one GET entity layer',
    );
  }
  return decodeNativeHtml(value);
}

/**
 * Project the native raw-HTML subset of verified original variant JSON without changing it.
 * This is not an integrity loader or a native-copy readiness check.
 * @param {readonly EditableRawItem[]} rawItems - Manifest IDs paired with original parsed JSON, never normalized import items.
 * @param {string} sourceManifestSha256 - SHA-256 of the verified original manifest bytes.
 * @returns {EditableRawHtmlProjection} Deterministic companion descriptor and fixed-path UTF-8 file bytes.
 */
export function projectEditableRawHtml(
  rawItems: readonly EditableRawItem[],
  sourceManifestSha256: string,
): EditableRawHtmlProjection {
  if (!/^[a-f0-9]{64}$/u.test(sourceManifestSha256)) {
    throw new TypeError('Expected original manifest SHA-256');
  }
  const seen = new Set<string>();
  const items: EditableRawHtmlProjection['items'][number][] = [];
  for (const { variantId, raw } of rawItems) {
    if (
      !/^[A-Za-z0-9_-]+$/u.test(variantId) ||
      /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/iu.test(variantId)
    ) {
      throw new TypeError('Unsafe editable variant ID');
    }
    if (seen.has(variantId)) throw new TypeError('Duplicate editable variant ID');
    seen.add(variantId);
    variantIdentity(raw, variantId);
    const contentType = record(raw.contentType)
      ? raw.contentType.fullyQualifiedName
      : raw.contentType;
    const body = raw.contentBody;
    if (
      !['sfdc_cms__email', 'sfdc_cms__emailTemplate'].includes(contentType as string) ||
      !record(body) ||
      typeof body.rawHtml !== 'string' ||
      'sfdc_cms:block' in body
    )
      continue;
    const metadataBody = { ...body };
    delete metadataBody.rawHtml;
    items.push({
      variantId,
      metadataPath: `items/${variantId}.json`,
      htmlPath: `items/${variantId}.html`,
      metadataBytes: jsonBytes({ ...raw, contentBody: metadataBody }),
      htmlBytes: Buffer.from(literalHtml(body.rawHtml), 'utf8'),
    });
  }
  if (items.length === 0) throw new TypeError('No editable native raw-HTML variants');
  items.sort((left, right) => {
    if (left.variantId < right.variantId) return -1;
    return left.variantId > right.variantId ? 1 : 0;
  });
  const descriptor: EditableRawHtmlDescriptor = {
    contract: 'sf-cms-editable-raw-html',
    contractVersion: '1.0.0',
    sourceManifestSha256,
    entries: items.map(({ variantId, metadataBytes, htmlBytes }) => ({
      variantId,
      metadataSha256: sha256(metadataBytes),
      originalHtmlSha256: sha256(htmlBytes),
    })),
  };
  return { descriptor, descriptorBytes: jsonBytes(descriptor), items };
}
