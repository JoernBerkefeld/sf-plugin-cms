import { lstat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect } from 'chai';
import {
  createRunOwnedDirectory,
  createRunOwnedTemp,
  removeRunOwnedPath,
} from '../../src/filesystem/runOwnedTemp.js';
import { intakeOpenApi, OpenApiIntakeError } from '../../src/openapi/intake.js';

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
  const fixtureRun = await createRunOwnedTemp('sf-plugin-cms-openapi');
  const directory = await createRunOwnedDirectory(fixtureRun, 'fixture');
  const fixturePath = path.join(directory, 'fixture.yaml');
  try {
    await writeFile(fixturePath, contents, 'utf8');
    await run(fixturePath);
  } finally {
    await removeRunOwnedPath(fixtureRun, directory);
    await lstat(directory).then(
      () => expect.fail('fixture child should be removed'),
      (error: NodeJS.ErrnoException) => expect(error.code).to.equal('ENOENT'),
    );
    const rootMetadata = await lstat(fixtureRun.root);
    expect(rootMetadata.isDirectory()).to.equal(true);
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

  it('validates the canonical v67 document with exactly 48 operations', async () => {
    const canonicalPath = path.resolve('resources', 'openapi', 'connect-rest-api-cms-v67.yaml');
    const result = await intakeOpenApi(canonicalPath);
    expect(result.byteSize).to.equal(243_608);
    expect(result.sha256).to.equal(
      '87c9a24773d96ae10f3d735b245e9600b2c92ce794223351d7810113b59ef550',
    );
    expect(result.operationCount).to.equal(48);
    expect(new Set(result.operations.map(({ operationId }) => operationId)).size).to.equal(48);
    expect(new Set(result.operations.map(({ method, path }) => `${method} ${path}`)).size).to.equal(
      48,
    );
  });
});
