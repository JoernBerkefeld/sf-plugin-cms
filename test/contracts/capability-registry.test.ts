import { expect } from 'chai';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CMS_CAPABILITY_DECLARATIONS,
  assertCapabilityRegistryFixture,
  assertDependencyDescriptor,
  assertPortableIdentity,
  assertPortablePayload,
  type CapabilityRegistryFixture,
  type DependencyDescriptor,
  type PortableIdentity,
} from '../../src/contracts/capability-registry.js';
import { getPluginVersion } from '../../src/runtime-version.js';

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

  it('uses the installed version for CMS-owned declarations and preserves all other fixture fields', async () => {
    const { value } = await loadFixture();
    const historicalCms = value.declarations.filter(
      (entry) => entry.identity.provider === 'sf-plugin-cms',
    );
    for (const declaration of historicalCms) {
      expect(declaration.providerContract).to.deep.equal({
        name: 'sf-plugin-cms',
        minVersion: '0.10.0',
        maxVersion: '0.10.999',
      });
    }
    expect(CMS_CAPABILITY_DECLARATIONS).to.deep.equal(
      value.declarations
        .filter((entry) => entry.identity.provider === 'sf-plugin-cms')
        .map((entry) => ({
          ...entry,
          providerContract: { ...entry.providerContract, maxVersion: getPluginVersion() },
        })),
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

  it('documents current public retrieval without inflating qualification evidence', async () => {
    const readme = await readFile(new URL('../../README.md', import.meta.url), 'utf8');
    expect(readme).to.include('not released-package qualification');
    expect(readme).to.include(
      '"plugin": { "name": "sf-plugin-cms", "version": "<installed-plugin-version>" }',
    );
    expect(readme).to.include('"pluginVersion": "<installed-plugin-version>"');
    expect(readme).to.include('mixed completion exits `2` with `partial`');
    expect(readme).to.include('RETRIEVE_SOURCE_BLOCKED');
    expect(readme).to.include('**no live image upload has been performed**');
    expect(readme).to.include('internalRegistry');
    expect(readme).not.to.include('## Upgrading to');
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

  it('locks distinct producer and compatible sibling fixture identities when available', async () => {
    const { bytes, value } = await loadFixture();
    expect(createHash('sha256').update(bytes).digest('hex')).to.equal(
      '557e9007ddaeea4c58807d9fc246fc62be646148591123d4398d5d00fa7f6f1b',
    );
    const sibling = path.resolve(
      '..',
      'sf-plugin-mcnext',
      'test',
      'capabilities',
      'fixtures',
      'metadata-capability-v1.json',
    );
    try {
      const siblingBytes = await readFile(sibling);
      expect(createHash('sha256').update(siblingBytes).digest('hex')).to.equal(
        '96360dde4c93dc04eb16a50e34b8b61c6950016dcd0451321ef781f9a565c6ff',
      );
      // The consumer widens only its native provider range; the producer stays frozen.
      const compatibleProducer = clone(value);
      const nativeDeclarations = compatibleProducer.declarations.filter(
        (entry) => entry.identity.provider === 'sf-plugin-mcnext',
      );
      expect(nativeDeclarations).to.have.length(2);
      for (const declaration of nativeDeclarations) {
        expect(declaration.providerContract).to.deep.equal({
          name: 'sf-plugin-mcnext',
          minVersion: '0.8.0',
          maxVersion: '0.8.999',
        });
        declaration.providerContract.maxVersion = '0.9.999';
      }
      expect(JSON.parse(siblingBytes.toString('utf8'))).to.deep.equal(compatibleProducer);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  });
});
