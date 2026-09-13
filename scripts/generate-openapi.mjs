import path from 'node:path';
import process from 'node:process';
import { checkSelectedOpenApi, writeSelectedOpenApi } from '../lib/openapi/generate.js';

const sourceArgument = process.argv.slice(2).find((argument) => argument !== '--check');
const sourcePath = path.resolve(
  sourceArgument ?? path.join('resources', 'openapi', 'connect-rest-api-cms-v67.yaml'),
);
const outputDirectory = path.resolve('src', 'generated');

try {
  if (process.argv.includes('--check')) {
    await checkSelectedOpenApi(sourcePath, outputDirectory);
    process.stdout.write('selected OpenAPI generation is deterministic and current\n');
  } else {
    await writeSelectedOpenApi(sourcePath, outputDirectory);
    process.stdout.write('generated selected Stage 1 OpenAPI read descriptors\n');
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
