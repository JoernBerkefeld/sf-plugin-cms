import { resolve } from 'node:path';
import process from 'node:process';
import { intakeOpenApi, OpenApiIntakeError } from '../lib/openapi/intake.js';

const EXPECTED_CANONICAL = {
  byteSize: 243152,
  operationCount: 48,
  sha256: 'c3f8b5c29821a884a1c06485925485a218c7be68808bf98491074d6625773434',
};

const sourceArgument = process.argv[2];
if (!sourceArgument) {
  console.error('usage: node scripts/intake-openapi.mjs <yaml-path> [--canonical]');
  process.exitCode = 2;
} else {
  try {
    const sourcePath = resolve(sourceArgument);
    const result = await intakeOpenApi(sourcePath);
    if (process.argv.includes('--canonical')) {
      for (const key of Object.keys(EXPECTED_CANONICAL)) {
        if (result[key] !== EXPECTED_CANONICAL[key]) {
          throw new OpenApiIntakeError(
            `canonical ${key} mismatch: expected ${EXPECTED_CANONICAL[key]}, received ${result[key]}`,
          );
        }
      }
    }
    process.stdout.write(
      `${JSON.stringify(
        {
          byteSize: result.byteSize,
          operationCount: result.operationCount,
          refCount: result.refCount,
          sha256: result.sha256,
          status: 'valid',
        },
        null,
        2,
      )}\n`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
