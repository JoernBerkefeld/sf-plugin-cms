import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect } from 'chai';
import { intakeOpenApi, OpenApiIntakeError, resolveInternalRef } from '../../src/openapi/intake.js';

const baseDocument = `openapi: 3.0.3
info:
  title: CMS Connect REST API
  version: v67.0
paths:
  /connect/cms/example:
    get:
      operationId: getExample
      responses:
        '200':
          description: ok
components:
  schemas:
    Example:
      type: object
`;

async function withFixture(contents: string, run: (path: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(path.join(tmpdir(), 'sf-plugin-cms-openapi-'));
  const fixturePath = path.join(directory, 'fixture.yaml');
  try {
    await writeFile(fixturePath, contents, 'utf8');
    await run(fixturePath);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function expectFailure(contents: string, message: RegExp): Promise<void> {
  await withFixture(contents, async (path) => {
    try {
      await intakeOpenApi(path);
      expect.fail('expected intake to fail');
    } catch (error) {
      expect(error).to.be.instanceOf(OpenApiIntakeError);
      expect((error as Error).message).to.match(message);
    }
  });
}

describe('OpenAPI semantic intake', () => {
  it('rejects duplicate YAML keys with a source location', async () => {
    await expectFailure(
      `${baseDocument}\ninfo:\n  title: duplicate\n`,
      /fixture\.yaml:\d+:\d+.*DUPLICATE_KEY/u,
    );
  });

  it('resolves valid refs and RFC 6901 pointer escapes', () => {
    const root = { components: { schemas: { 'a/b': { value: 1 }, 'a~b': { value: 2 } } } };
    expect(resolveInternalRef(root, '#/components/schemas/a~1b')).to.deep.equal({ value: 1 });
    expect(resolveInternalRef(root, '#/components/schemas/a~0b')).to.deep.equal({ value: 2 });
  });

  it('rejects malformed, escaped, unresolved, and non-local refs', async () => {
    for (const [reference, message] of [
      ['#/components/schemas/Bad~2Key', /malformed JSON Pointer escape/u],
      ['#/components/%73chemas/Example', /escaped ref is forbidden/u],
      ['#/components/schemas/Missing', /unresolved internal ref/u],
      ['https://example.invalid/schema.yaml#/Example', /only canonical internal refs/u],
      ['file:///tmp/schema.yaml#/Example', /only canonical internal refs/u],
      ['../schema.yaml#/Example', /only canonical internal refs/u],
    ] as const) {
      const fixture = `${baseDocument}\n  schemas2:\n    Ref:\n      $ref: '${reference}'\n`;
      await expectFailure(fixture, message);
    }
  });

  it('validates cyclic internal refs without recursing forever', async () => {
    const fixture = `${baseDocument}\n    A:\n      $ref: '#/components/schemas/B'\n    B:\n      $ref: '#/components/schemas/A'\n`;
    await withFixture(fixture, async (path) => {
      const result = await intakeOpenApi(path);
      expect(result.refCount).to.equal(2);
      expect(result.operationCount).to.equal(1);
    });
  });

  it('rejects missing and duplicate operation identifiers', async () => {
    await expectFailure(
      baseDocument.replace('      operationId: getExample\n', ''),
      /missing operationId/u,
    );
    await expectFailure(
      baseDocument.replace(
        '  /connect/cms/example:\n',
        '  /connect/cms/second:\n    get:\n      operationId: getExample\n  /connect/cms/example:\n',
      ),
      /duplicate operationId/u,
    );
    await expectFailure(
      baseDocument.replace(
        "      responses:\n        '200':\n          description: ok\n",
        "      responses:\n        '200':\n          description: ok\n    Get:\n      operationId: getExampleAgain\n",
      ),
      /duplicate operation identity/u,
    );
  });

  it('validates the canonical v67 document with exactly 48 operations', async () => {
    const canonicalPath = path.resolve('resources', 'openapi', 'connect-rest-api-cms-v67.yaml');
    const result = await intakeOpenApi(canonicalPath);
    expect(result.byteSize).to.equal(243_152);
    expect(result.sha256).to.equal(
      'c3f8b5c29821a884a1c06485925485a218c7be68808bf98491074d6625773434',
    );
    expect(result.operationCount).to.equal(48);
    expect(new Set(result.operations.map(({ operationId }) => operationId)).size).to.equal(48);
    expect(new Set(result.operations.map(({ method, path }) => `${method} ${path}`)).size).to.equal(
      48,
    );
  });
});
