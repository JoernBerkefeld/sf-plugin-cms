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
  it('keeps starred JSDoc and the effective Unicorn formatting exception after autofix', async () => {
    const { ESLint } = await import('eslint');
    const eslint = new ESLint({ fix: true });
    const filePath = 'src/contracts/capability-registry.ts';
    const config = await eslint.calculateConfigForFile(filePath);
    expect(config.rules['unicorn/no-asterisk-prefix-in-documentation-comments'][0]).to.equal(0);
    const source = [
      '/**',
      ' * Return the supplied value.',
      ' * @param {string} value - The value to return.',
      ' * @returns {string} The supplied value.',
      ' */',
      'export function retainStars(value: string): string {',
      '  return value;',
      '}',
      '',
    ].join('\n');
    const [result] = await eslint.lintText(source, { filePath });
    expect(result.errorCount).to.equal(0);
    expect(result.warningCount).to.equal(0);
    expect(result.output ?? source).to.equal(source);
  });

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

  it('widens only the CMS-owned provider ceiling from the locked historical fixture', async () => {
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
          providerContract: { ...entry.providerContract, maxVersion: '0.12.999' },
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

  it('accepts the CMS 0.10–0.12 release lines without changing contract or sibling provider versions', async () => {
    const { value } = await loadFixture();
    expect(value.contract).to.equal('sf-metadata-capability-v1');
    expect(value.version).to.equal('1.0.0');
    for (const declaration of CMS_CAPABILITY_DECLARATIONS) {
      expect(declaration.providerContract).to.deep.equal({
        name: 'sf-plugin-cms',
        minVersion: '0.10.0',
        maxVersion: '0.12.999',
      });
    }
    const siblingDeclarations = value.declarations.filter(
      (entry) => entry.identity.provider === 'sf-plugin-mcnext',
    );
    expect(siblingDeclarations).to.have.length(2);
    for (const declaration of siblingDeclarations) {
      expect(declaration.providerContract).to.deep.equal({
        name: 'sf-plugin-mcnext',
        minVersion: '0.8.0',
        maxVersion: '0.8.999',
      });
    }
  });

  it('documents qualified batch retrieval without inflating baseline live evidence', async () => {
    const readme = await readFile(new URL('../../README.md', import.meta.url), 'utf8');
    expect(readme).to.include('CMS `0.10.0`–`0.12.999` range');
    expect(readme).to.include('**qualified batch retrieval**');
    expect(readme).to.include('building on the `v0.11.0` release baseline');
    expect(readme).to.include('not released-package qualification');
    expect(readme).to.include('"plugin": { "name": "sf-plugin-cms", "version": "0.12.0" }');
    expect(readme).to.include('"pluginVersion": "0.12.0"');
    expect(readme).not.to.include('Publication of `0.11.0` is not yet asserted.');
    expect(readme).to.include('mixed completion exits `2` with `partial`');
    expect(readme).to.include('RETRIEVE_SOURCE_BLOCKED');
    expect(readme).to.include('This checkpoint makes **no deployment support claim**.');
    expect(readme).to.include('**no live image upload has been performed**');
    expect(readme).to.include(
      '**Immutable Brand SOURCE is live-qualified for one root/default-language Draft CREATE.**',
    );
    expect(readme).not.to.include('local, unreleased source mode');
    expect(readme).not.to.include('v0.9.0');
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
