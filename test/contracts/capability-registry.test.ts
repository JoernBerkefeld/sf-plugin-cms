import { expect } from 'chai';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertCapabilityDeclaration,
  CMS_CAPABILITY_DECLARATIONS,
  METADATA_CAPABILITY_FIXTURE_SHA256,
  assertCapabilityRegistryFixture,
  assertDependencyDescriptor,
  assertPortableIdentity,
  assertPortablePayload,
  hashCapabilityRegistryFixture,
  serializeCapabilityRegistryFixture,
  type CapabilityDeclaration,
  type CapabilityRegistryFixture,
  type DependencyDescriptor,
  type PortableIdentity,
  type ServerIdentity,
} from '../../src/contracts/capability-registry.js';

const fixturePath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'metadata-capability-v1.json',
);

async function loadFixture(): Promise<{ bytes: Buffer; value: CapabilityRegistryFixture }> {
  const bytes = await readFile(fixturePath);
  return { bytes, value: JSON.parse(bytes.toString('utf8')) as CapabilityRegistryFixture };
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function sampleIdentity(): PortableIdentity {
  return {
    family: 'cms',
    type: 'Email',
    apiName: 'welcome_email',
    context: { workspaceApiName: 'marketing', language: 'en_US' },
  };
}

describe('sf-metadata-capability-v1 foundation', () => {
  it('validates the canonical evidence-qualified profile fixture', async () => {
    const { value } = await loadFixture();
    expect(() => assertCapabilityRegistryFixture(value)).not.to.throw();
    expect(
      value.declarations.map(
        (entry) => `${entry.identity.provider}:${entry.identity.type}:${entry.identity.profile}`,
      ),
    ).to.deep.equal([
      'sf-plugin-cms:Brand:dependency-free',
      'sf-plugin-cms:Consent Banner:dependency-free',
      'sf-plugin-cms:Email:dependency-free',
      'sf-plugin-cms:Email Fragment:dependency-free',
      'sf-plugin-cms:Email Template:dependency-free',
      'sf-plugin-cms:Form Handler:strict-empty-root',
      'sf-plugin-cms:Landing Page:strict-paired-template',
      'sf-plugin-cms:Landing Page Template:strict-image-data-graph',
      'sf-plugin-cms:Preference Page:strict-channel-subchannel-optional-brand',
      'sf-plugin-cms:Web Fragment:strict-data-graph',
      'sf-plugin-mcnext:Campaign:relationship-free-scalar-resolver',
      'sf-plugin-mcnext:Data Space:scope-identity-resolver',
    ]);
    expect(value.declarations.flatMap((entry) => entry.operations)).not.to.include('deploy');
    expect(value.declarations.map((entry) => entry.identity.type)).not.to.include.members([
      'Flow',
      'Data Graph',
      'MarketSegment',
      'MarketSegmentDefinition',
    ]);
  });

  it('derives exactly the CMS-owned declarations from the locked fixture', async () => {
    const { value } = await loadFixture();
    expect(CMS_CAPABILITY_DECLARATIONS).to.deep.equal(
      value.declarations.filter((entry) => entry.identity.provider === 'sf-plugin-cms'),
    );
    expect(CMS_CAPABILITY_DECLARATIONS.map((entry) => entry.identity.type)).not.to.include.members([
      'Campaign',
      'Data Space',
      'Flow',
      'Data Graph',
      'MarketSegment',
      'MarketSegmentDefinition',
    ]);
  });

  it('rejects unknown keys and missing completion, bounds, or extractor fields', async () => {
    const { value } = await loadFixture();
    const base = value.declarations[0];
    expect(() => assertCapabilityDeclaration({ ...base, unexpected: true })).to.throw('fields');
    const missingFields = [
      (() => {
        const entry = clone(base) as unknown as Record<string, unknown>;
        delete (entry.retrieval as Record<string, unknown>).completionProof;
        return entry;
      })(),
      (() => {
        const entry = clone(base) as unknown as Record<string, unknown>;
        delete (entry.preflight as Record<string, unknown>).hardBounds;
        return entry;
      })(),
      (() => {
        const entry = clone(base) as unknown as Record<string, unknown>;
        delete entry.dependencyExtractorVersion;
        return entry;
      })(),
    ];
    for (const malformed of missingFields) {
      expect(() => assertCapabilityDeclaration(malformed)).to.throw();
    }
  });

  it('rejects invalid retrieval strategies and dependency resolutions', async () => {
    const { value } = await loadFixture();
    expect(() =>
      assertCapabilityDeclaration({
        ...value.declarations[0],
        retrieval: { ...value.declarations[0].retrieval, strategy: 'scan' },
      }),
    ).to.throw('strategy');
    expect(() =>
      assertDependencyDescriptor({
        kind: 'cms.template',
        source: sampleIdentity(),
        target: { ...sampleIdentity(), type: 'Email Template' },
        required: true,
        resolution: 'server',
      }),
    ).to.throw('resolution');
  });

  it('rejects portable server locator keys and Salesforce-shaped ID values', () => {
    for (const malformed of [
      { ...sampleIdentity(), serverId: '20Y000000000001AAA' },
      { ...sampleIdentity(), context: { workspaceId: 'portable-looking' } },
      { ...sampleIdentity(), context: { nested: { value: '20Y000000000001AAA' } } },
      { ...sampleIdentity(), context: { sourceOrgId: 'portable-looking' } },
    ]) {
      expect(() => assertPortableIdentity(malformed)).to.throw('portable');
    }
  });

  it('accepts server identity only at the explicit evidence path', () => {
    const descriptor: DependencyDescriptor = {
      kind: 'cms.template',
      source: sampleIdentity(),
      target: { ...sampleIdentity(), type: 'Email Template', apiName: 'welcome_template' },
      required: true,
      resolution: 'either',
      originPath: '$.content.template',
      evidence: { serverIdentity: { kind: 'salesforce-id', value: '20Y000000000001AAA' } },
    };
    expect(() => assertDependencyDescriptor(descriptor)).not.to.throw();
    expect(() =>
      assertPortablePayload({
        definition: { serverIdentity: descriptor.evidence!.serverIdentity },
      }),
    ).to.throw('locator');
  });

  it('allows only explicitly listed structural block ID paths', () => {
    const payload = { blocks: [{ id: '20Y000000000001AAA', body: 'portable' }] };
    expect(() => assertPortablePayload(payload)).to.throw('Salesforce ID');
    expect(() =>
      assertPortablePayload(payload, { allowedStructuralIdPaths: ['$.blocks[0].id'] }),
    ).not.to.throw();
  });

  it('locks deterministic serialization and raw fixture bytes', async () => {
    const { bytes, value } = await loadFixture();
    expect(bytes.includes(Buffer.from('\r'))).to.equal(false);
    expect(bytes.at(-1)).to.equal(10);
    const serialized = serializeCapabilityRegistryFixture(value);
    expect(serializeCapabilityRegistryFixture(JSON.parse(serialized))).to.equal(serialized);
    expect(hashCapabilityRegistryFixture(value)).to.equal(
      createHash('sha256').update(serialized, 'utf8').digest('hex'),
    );
    expect(createHash('sha256').update(bytes).digest('hex')).to.equal(
      METADATA_CAPABILITY_FIXTURE_SHA256,
    );
  });

  it('keeps the sibling canonical fixture byte-identical when available', async () => {
    const { bytes } = await loadFixture();
    const sibling = path.resolve(
      '..',
      'sf-plugin-mcnext',
      'test',
      'capabilities',
      'fixtures',
      'metadata-capability-v1.json',
    );
    try {
      expect(bytes.equals(await readFile(sibling))).to.equal(true);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  });

  it('exports the locked compile-time contract shapes', () => {
    const identity: PortableIdentity = sampleIdentity();
    const server: ServerIdentity = { kind: 'developer-name', value: 'Marketing' };
    const declaration: CapabilityDeclaration = {
      identity: { provider: 'provider', family: 'family', type: 'type', profile: 'profile' },
      providerContract: { name: 'provider', minVersion: '1.0.0', maxVersion: '1.999.999' },
      nativeScope: { kind: 'org', root: 'root' },
      retrieval: {
        strategy: 'targeted',
        completionProof: 'exact match',
        hardBounds: { maxCalls: 1, maxItems: 1, maxPages: 1 },
      },
      preflight: {
        strategy: 'targeted',
        completionProof: 'exact match',
        hardBounds: { maxCalls: 1, maxItems: 1, maxPages: 1 },
      },
      operations: ['resolve'],
      dependencyExtractorVersion: 'none@1',
    };
    expect({ identity, server, declaration }).to.have.keys('identity', 'server', 'declaration');
  });
});
