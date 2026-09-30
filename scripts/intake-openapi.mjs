import { resolve } from 'node:path';
import process from 'node:process';
import { intakeOpenApi, OpenApiIntakeError } from '../lib/openapi/intake.js';

const EXPECTED_CANONICAL = {
  byteSize: 243608,
  operationCount: 48,
  sha256: '87c9a24773d96ae10f3d735b245e9600b2c92ce794223351d7810113b59ef550',
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
